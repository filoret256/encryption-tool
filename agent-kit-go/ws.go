// A minimal RFC 6455 server — enough for the local agents and deliberately no more.
//
// Reaching for a library would be the reflex, except that everything needed
// here is one handshake and one frame codec over a loopback socket: no TLS, no
// permessage-deflate, no client role, no subprotocols. Written out, the whole
// wire path is auditable in one file and the build pulls nothing for it.
package agentkit

import (
	"bufio"
	"crypto/sha1" // #nosec G505 -- RFC 6455 defines Sec-WebSocket-Accept as SHA-1; it is a handshake echo, not a security primitive
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA
)

// RFC 6455 section 1.3. It exists so that a cache or proxy cannot replay a
// handshake it happens to have seen before.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Well above the 4 MB file the editor will ever read, well below "a peer can
// exhaust this process". It is checked in both directions: on the way in an
// oversized frame is refused, and on the way out it is not written at all.
const maxMessageBytes = 32 << 20

// ErrMessageTooLarge is what sending more than maxMessageBytes reports.
//
// The receive side always enforced the limit; the send side did not, so an
// agent that assembled one very large reply — a batch of Kafka values, a git
// log nobody expected — put it on the wire and left the page to parse it. The
// limit the socket enforces is the same one, so a caller that hits it has a bug
// of its own to fix, not a peer to blame.
var ErrMessageTooLarge = errors.New("message exceeds the size limit")

const writeTimeout = 30 * time.Second

// How a silent peer is told from an idle one. A page that has nothing to ask sends nothing, so
// silence alone proves nothing: the agent pings, a browser answers with a pong on its own, and
// the read deadline moves with every frame that arrives. A peer that misses a few pings in a
// row — the machine slept, the network went, the tab was killed — is gone, and its goroutine
// and its slot are freed. Variables, so that a test need not wait a minute.
var (
	pingEvery = 20 * time.Second
	readIdle  = 60 * time.Second
)

type Conn struct {
	conn net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex
	// readIdle is how long a read may wait for the next frame; zero means for ever, which is
	// what a connection without a keepalive (an in-memory pipe in a test) wants.
	readIdle time.Duration
	// done ends the keepalive loop; nil when there is none.
	done   chan struct{}
	closed bool
}

// Upgrade completes the handshake and takes the socket away from net/http.
// The caller owns the connection from here on and must Close it.
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if r.Method != http.MethodGet {
		return nil, errors.New("upgrade requires GET")
	}
	if !headerHasToken(r.Header.Get("Connection"), "upgrade") {
		return nil, errors.New("missing Connection: upgrade")
	}
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return nil, errors.New("missing Upgrade: websocket")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errors.New("unsupported websocket version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("connection cannot be hijacked")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	// net/http may have armed a read deadline for the request; the socket is a
	// long-lived idle-most-of-the-time channel now, so clear both. The read side gets a
	// deadline of its own again in readFrame, one that every frame moves.
	_ = conn.SetDeadline(time.Time{})

	sum := sha1.Sum([]byte(key + wsGUID)) // #nosec G401 -- see the import: the protocol fixes the hash
	accept := base64.StdEncoding.EncodeToString(sum[:])
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n" +
		"Date: " + time.Now().UTC().Format(http.TimeFormat) + "\r\n\r\n"
	if _, err := conn.Write([]byte(resp)); err != nil {
		conn.Close()
		return nil, err
	}
	// brw.Reader may already hold bytes read past the request head, so it has
	// to be carried over rather than replaced with a fresh reader.
	c := &Conn{conn: conn, br: brw.Reader, readIdle: readIdle, done: make(chan struct{})}
	go c.keepalive(pingEvery)
	return c, nil
}

// keepalive pings until the connection closes. A failed ping ends the loop and nothing
// else: the read deadline is what closes a peer that has stopped answering.
func (c *Conn) keepalive(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-t.C:
			if err := c.write(OpPing, nil); err != nil {
				return
			}
		}
	}
}

// armRead moves the read deadline to now + readIdle, when the connection has one.
func (c *Conn) armRead() {
	if c.readIdle > 0 {
		_ = c.conn.SetReadDeadline(time.Now().Add(c.readIdle))
	}
}

// ReadMessage returns one complete application message, transparently
// reassembling fragments and answering pings along the way. A close frame from
// the peer surfaces as io.EOF.
func (c *Conn) ReadMessage() (byte, []byte, error) {
	var (
		msg     []byte
		msgOp   byte
		started bool
	)
	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}

		switch opcode {
		case OpPing:
			if err := c.write(OpPong, payload); err != nil {
				return 0, nil, err
			}
			continue
		case OpPong:
			continue
		case OpClose:
			// Echo the status code back, as the RFC asks, then report the end of
			// the stream. Any error here is moot: we are closing regardless.
			echo := payload
			if len(echo) > 2 {
				echo = echo[:2]
			}
			_ = c.write(OpClose, echo)
			return OpClose, nil, io.EOF
		case OpContinuation:
			if !started {
				return 0, nil, errors.New("continuation frame with nothing to continue")
			}
		case OpText, OpBinary:
			if started {
				return 0, nil, errors.New("new data frame before the previous one finished")
			}
			started = true
			msgOp = opcode
		default:
			return 0, nil, fmt.Errorf("unknown opcode 0x%x", opcode)
		}

		if len(msg)+len(payload) > maxMessageBytes {
			return 0, nil, errors.New("message exceeds the size limit")
		}
		// A payload is a buffer of its own already, so a message that arrives in
		// one frame — nearly all of them — is not copied a second time. Only a
		// fragmented one is assembled.
		if msg == nil {
			msg = payload
		} else {
			msg = append(msg, payload...)
		}
		if fin {
			return msgOp, msg, nil
		}
	}
}

func (c *Conn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	c.armRead()
	var h [2]byte
	if _, err = io.ReadFull(c.br, h[:]); err != nil {
		return
	}
	fin = h[0]&0x80 != 0
	// No extension was negotiated, so a reserved bit means the peer is speaking
	// a protocol this server never agreed to.
	if h[0]&0x70 != 0 {
		err = errors.New("reserved bits set")
		return
	}
	opcode = h[0] & 0x0F
	masked := h[1]&0x80 != 0
	n := uint64(h[1] & 0x7F)

	switch n {
	case 126:
		var b [2]byte
		if _, err = io.ReadFull(c.br, b[:]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err = io.ReadFull(c.br, b[:]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(b[:])
	}

	if opcode >= 0x8 && (!fin || n > 125) {
		err = errors.New("malformed control frame")
		return
	}
	if n > maxMessageBytes {
		err = errors.New("frame exceeds the size limit")
		return
	}
	// RFC 6455 section 5.1: a client MUST mask. Accepting an unmasked frame
	// would mean accepting traffic no browser produces.
	if !masked {
		err = errors.New("client frame is not masked")
		return
	}

	// A large frame has its own allowance: the wait for its first byte is over.
	c.armRead()
	var mask [4]byte
	if _, err = io.ReadFull(c.br, mask[:]); err != nil {
		return
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return
	}
	for i := range payload {
		payload[i] ^= mask[i&3]
	}
	return
}

// SendText writes one unfragmented text message. Safe to call from several
// goroutines: replies and watcher pushes race by design.
func (c *Conn) SendText(payload []byte) error {
	return c.write(OpText, payload)
}

func (c *Conn) write(opcode byte, payload []byte) error {
	if len(payload) > maxMessageBytes {
		return ErrMessageTooLarge
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed {
		return net.ErrClosed
	}

	n := len(payload)
	var head [10]byte
	head[0] = 0x80 | opcode
	hn := 2
	switch {
	case n <= 125:
		head[1] = byte(n)
	case n <= 0xFFFF:
		head[1] = 126
		binary.BigEndian.PutUint16(head[2:4], uint16(n))
		hn = 4
	default:
		head[1] = 127
		binary.BigEndian.PutUint64(head[2:10], uint64(n))
		hn = 10
	}

	if err := c.conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	// One gathered write: a header and its payload go out in a single call, so
	// they are not split across the wire in a way that costs an extra round
	// trip — without first being copied into a buffer of their own, which for a
	// 4 MB file meant a second 4 MB alive for the length of the write.
	bufs := net.Buffers{head[:hn], payload}
	_, err := bufs.WriteTo(c.conn)
	return err
}

func (c *Conn) Close() {
	c.wmu.Lock()
	already := c.closed
	c.closed = true
	c.wmu.Unlock()
	if already {
		return
	}
	if c.done != nil {
		close(c.done)
	}
	// 1000 = normal closure. Best effort; the peer may already be gone.
	_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
	var frame [4]byte
	frame[0] = 0x80 | OpClose
	frame[1] = 2
	binary.BigEndian.PutUint16(frame[2:4], 1000)
	_, _ = c.conn.Write(frame[:])
	_ = c.conn.Close()
}

// headerHasToken reports whether a comma-separated header value contains the
// given token, case-insensitively — "keep-alive, Upgrade" must match.
func headerHasToken(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// NewConn wraps a connection that needs no handshake — an in-memory pipe in a
// test that drives an agent's dispatch directly.
func NewConn(c net.Conn) *Conn { return &Conn{conn: c, br: bufio.NewReader(c)} }
