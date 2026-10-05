package agentkit

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// The handshake constant is the one value in this package that no amount of
// local reasoning can verify: a wrong GUID produces a perfectly well-formed
// response that every client rejects. The RFC 6455 section 1.3 vector is
// therefore pinned here rather than trusted to a careful reading.
func TestHandshakeAcceptVector(t *testing.T) {
	const key = "dGhlIHNhbXBsZSBub25jZQ=="
	const want = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="

	sum := sha1.Sum([]byte(key + wsGUID))
	got := base64.StdEncoding.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("Sec-WebSocket-Accept for the RFC sample key = %q, want %q (wsGUID is wrong)", got, want)
	}
}

func TestHeaderHasToken(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"Upgrade", true},
		{"upgrade", true},
		{"keep-alive, Upgrade", true},
		{"Upgrade, keep-alive", true},
		{" upgrade ", true},
		{"keep-alive", false},
		{"", false},
		{"upgrader", false},
	}
	for _, c := range cases {
		if got := headerHasToken(c.value, "upgrade"); got != c.want {
			t.Errorf("headerHasToken(%q) = %v, want %v", c.value, got, c.want)
		}
	}
}

// ── frame codec ───────────────────────────────────────────────────────────

// The limit was enforced on the way in and not on the way out, so an agent that
// assembled one very large reply put it on the wire and left the page to parse
// it. Nothing is written now, and the caller is told.
func TestSendRefusesWhatTheLimitRefuses(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	conn := &Conn{conn: server}

	// Drained, because net.Pipe is synchronous: nothing is written until it is read.
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 1<<16)
		for {
			if _, err := client.Read(buf); err != nil {
				return
			}
		}
	}()

	atLimit := make([]byte, maxMessageBytes)
	if err := conn.SendText(atLimit); err != nil {
		t.Fatalf("a message exactly at the limit was refused: %v", err)
	}
	if err := conn.SendText(append(atLimit, 'x')); err != ErrMessageTooLarge {
		t.Fatalf("a message over the limit reported %v, want %v", err, ErrMessageTooLarge)
	}
	client.Close()
	<-done
}

// clientFrame builds a masked frame the way a browser would, so the codec is
// exercised against the shape it will actually meet.
func clientFrame(fin bool, opcode byte, payload []byte) []byte {
	var buf bytes.Buffer
	first := opcode
	if fin {
		first |= 0x80
	}
	buf.WriteByte(first)

	n := len(payload)
	switch {
	case n <= 125:
		buf.WriteByte(byte(n) | 0x80)
	case n <= 0xFFFF:
		buf.WriteByte(126 | 0x80)
		buf.WriteByte(byte(n >> 8))
		buf.WriteByte(byte(n))
	default:
		buf.WriteByte(127 | 0x80)
		for shift := 56; shift >= 0; shift -= 8 {
			buf.WriteByte(byte(n >> shift))
		}
	}

	mask := []byte{0x37, 0xfa, 0x21, 0x3d}
	buf.Write(mask)
	for i, b := range payload {
		buf.WriteByte(b ^ mask[i&3])
	}
	return buf.Bytes()
}

// readerConn feeds data to a Conn over an in-memory pipe. The client end is
// returned as well: net.Pipe is unbuffered, so anything the server writes back
// (a pong, a close echo) blocks until someone reads it from the other side.
func readerConn(t *testing.T, data []byte) (*Conn, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	go func() { _, _ = client.Write(data) }()
	t.Cleanup(func() { client.Close(); server.Close() })
	return &Conn{conn: server, br: bufio.NewReader(server)}, client
}

// drain reads and discards whatever the server writes, so a reply never
// deadlocks the test.
func drain(c net.Conn) {
	go func() {
		buf := make([]byte, 256)
		for {
			if _, err := c.Read(buf); err != nil {
				return
			}
		}
	}()
}

func TestReadMessageLengths(t *testing.T) {
	// 125/126 and 65535/65536 are the boundaries between the three length
	// encodings — the classic place for an off-by-one to hide.
	for _, n := range []int{0, 1, 125, 126, 127, 65535, 65536, 70000} {
		payload := bytes.Repeat([]byte("x"), n)
		c, _ := readerConn(t, clientFrame(true, OpText, payload))
		op, got, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("payload of %d bytes: %v", n, err)
		}
		if op != OpText {
			t.Fatalf("payload of %d bytes: opcode = %d", n, op)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("payload of %d bytes: round trip mismatch (%d bytes back)", n, len(got))
		}
	}
}

func TestReadMessageFragmented(t *testing.T) {
	var wire bytes.Buffer
	wire.Write(clientFrame(false, OpText, []byte("hello ")))
	// A ping in the middle of a fragmented message is legal and must not be
	// mistaken for a continuation.
	wire.Write(clientFrame(true, OpPing, []byte("hi")))
	wire.Write(clientFrame(false, OpContinuation, []byte("brave ")))
	wire.Write(clientFrame(true, OpContinuation, []byte("world")))

	c, client := readerConn(t, wire.Bytes())
	// Drain the pong the ping provokes, so the write does not block on the pipe.
	drain(client)

	_, got, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello brave world" {
		t.Fatalf("reassembled %q", got)
	}
}

func TestReadMessageRejectsUnmasked(t *testing.T) {
	// Same frame, mask bit cleared: a server must refuse it.
	frame := clientFrame(true, OpText, []byte("hi"))
	frame[1] &^= 0x80
	c, _ := readerConn(t, frame)
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("unmasked client frame was accepted")
	}
}

func TestReadMessageRejectsOversizedControlFrame(t *testing.T) {
	c, _ := readerConn(t, clientFrame(true, OpPing, bytes.Repeat([]byte("x"), 126)))
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("a 126-byte control frame was accepted")
	}
}

func TestReadMessageCloseIsEOF(t *testing.T) {
	c, client := readerConn(t, clientFrame(true, OpClose, []byte{0x03, 0xe8}))
	drain(client)
	if _, _, err := c.ReadMessage(); err != io.EOF {
		t.Fatalf("close frame reported %v, want io.EOF", err)
	}
}

// TestWriteFrameHeader checks the server-to-client direction: unmasked, and
// with the length encoding the payload size calls for.
func TestWriteFrameHeader(t *testing.T) {
	cases := []struct {
		n        int
		wantHead []byte
	}{
		{5, []byte{0x81, 5}},
		{125, []byte{0x81, 125}},
		{126, []byte{0x81, 126, 0x00, 0x7e}},
		{65535, []byte{0x81, 126, 0xff, 0xff}},
		{65536, []byte{0x81, 127, 0, 0, 0, 0, 0, 0x01, 0x00, 0x00}},
	}
	for _, c := range cases {
		client, server := net.Pipe()
		conn := &Conn{conn: server}
		go func(n int) { _ = conn.SendText(bytes.Repeat([]byte("x"), n)) }(c.n)

		head := make([]byte, len(c.wantHead))
		if _, err := io.ReadFull(client, head); err != nil {
			t.Fatalf("payload of %d bytes: %v", c.n, err)
		}
		if !bytes.Equal(head, c.wantHead) {
			t.Fatalf("payload of %d bytes: header %v, want %v", c.n, head, c.wantHead)
		}
		client.Close()
	}
}

// ── silent peers ──────────────────────────────────────────────────────────

// The deadline that Upgrade clears used to be the only one: a peer that stopped answering held
// its goroutine, and the agent's one client slot, for ever. With a read deadline of its own
// the read gives up after the idle time and the caller closes the connection.
func TestSilentPeerTimesOut(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	c := &Conn{conn: server, br: bufio.NewReader(server), readIdle: 80 * time.Millisecond}

	started := time.Now()
	_, _, err := c.ReadMessage()
	var ne net.Error
	if !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("a silent peer ended the read with %v, want a timeout", err)
	}
	if took := time.Since(started); took > 2*time.Second {
		t.Fatalf("the read gave up after %v, want about 80ms", took)
	}
}

// A peer that is only idle answers the agent's pings, and every frame moves the deadline: it
// stays connected for many times the idle time, and a message sent at the end still arrives.
func TestAnsweredPingsKeepAPeerConnected(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	c := &Conn{conn: server, br: bufio.NewReader(server), readIdle: 200 * time.Millisecond, done: make(chan struct{})}
	defer c.Close()
	go c.keepalive(30 * time.Millisecond)

	// What a browser does without being asked: a pong for every ping, then — after a
	// time well past the idle limit — an actual message.
	go func() {
		buf := make([]byte, 64)
		deadline := time.Now().Add(700 * time.Millisecond)
		for time.Now().Before(deadline) {
			_ = client.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
			if n, err := client.Read(buf); err == nil && n >= 2 && buf[0] == 0x80|OpPing {
				_, _ = client.Write(clientFrame(true, OpPong, nil))
			}
		}
		_, _ = client.Write(clientFrame(true, OpText, []byte("hello")))
		// net.Pipe is synchronous: a ping still on its way would block the close below.
		_ = client.SetReadDeadline(time.Time{})
		drain(client)
	}()

	op, msg, err := c.ReadMessage()
	if err != nil || op != OpText || string(msg) != "hello" {
		t.Fatalf("ReadMessage = %d %q %v, want the text message after a long idle", op, msg, err)
	}
}

// A peer that answers nothing is pinged and then dropped: the agent's read ends by itself.
func TestUnansweredPingsEndTheRead(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	c := &Conn{conn: server, br: bufio.NewReader(server), readIdle: 150 * time.Millisecond, done: make(chan struct{})}
	defer c.Close()
	go c.keepalive(30 * time.Millisecond)
	drain(client) // reads the pings, answers none

	started := time.Now()
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("a peer that never answered kept the connection open")
	}
	if took := time.Since(started); took > 2*time.Second {
		t.Fatalf("the read gave up after %v, want about 150ms", took)
	}
}
