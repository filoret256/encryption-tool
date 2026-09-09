// A minimal RFC 6455 server — enough for this agent and deliberately no more.
//
// Reaching for a library would be the reflex, except that everything needed
// here is one handshake and one frame codec over a loopback socket: no TLS, no
// permessage-deflate, no client role, no subprotocols. Written out, the whole
// wire path is auditable in one file and the build pulls nothing for it.
package main

import (
	"bufio"
	"crypto/sha1"
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
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// RFC 6455 section 1.3. It exists so that a cache or proxy cannot replay a
// handshake it happens to have seen before.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Well above the 4 MB file the editor will ever read, well below "a peer can
// exhaust this process".
const maxMessageBytes = 32 << 20

const writeTimeout = 30 * time.Second

type wsConn struct {
	conn   net.Conn
	br     *bufio.Reader
	wmu    sync.Mutex
	closed bool
}

// wsUpgrade completes the handshake and takes the socket away from net/http.
// The caller owns the connection from here on and must Close it.
func wsUpgrade(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
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
	// long-lived idle-most-of-the-time channel now, so clear both.
	_ = conn.SetDeadline(time.Time{})

	sum := sha1.Sum([]byte(key + wsGUID))
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
	return &wsConn{conn: conn, br: brw.Reader}, nil
}

// readMessage returns one complete application message, transparently
// reassembling fragments and answering pings along the way. A close frame from
// the peer surfaces as io.EOF.
func (c *wsConn) readMessage() (byte, []byte, error) {
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
		case opPing:
			if err := c.write(opPong, payload); err != nil {
				return 0, nil, err
			}
			continue
		case opPong:
			continue
		case opClose:
			// Echo the status code back, as the RFC asks, then report the end of
			// the stream. Any error here is moot: we are closing regardless.
			echo := payload
			if len(echo) > 2 {
				echo = echo[:2]
			}
			_ = c.write(opClose, echo)
			return opClose, nil, io.EOF
		case opContinuation:
			if !started {
				return 0, nil, errors.New("continuation frame with nothing to continue")
			}
		case opText, opBinary:
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
		msg = append(msg, payload...)
		if fin {
			return msgOp, msg, nil
		}
	}
}

func (c *wsConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
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

// sendText writes one unfragmented text message. Safe to call from several
// goroutines: replies and watcher pushes race by design.
func (c *wsConn) sendText(payload []byte) error {
	return c.write(opText, payload)
}

func (c *wsConn) write(opcode byte, payload []byte) error {
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

	// One Write: a header and its payload must not be interleaved with another
	// goroutine's frame, and the mutex alone does not stop a partial write from
	// being split across the wire in a way that costs an extra round trip.
	buf := make([]byte, 0, hn+n)
	buf = append(buf, head[:hn]...)
	buf = append(buf, payload...)

	if err := c.conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	_, err := c.conn.Write(buf)
	return err
}

func (c *wsConn) close() {
	c.wmu.Lock()
	already := c.closed
	c.closed = true
	c.wmu.Unlock()
	if already {
		return
	}
	// 1000 = normal closure. Best effort; the peer may already be gone.
	_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
	var frame [4]byte
	frame[0] = 0x80 | opClose
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
