package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"io"
	"net"
	"testing"
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

// readerConn feeds data to a wsConn over an in-memory pipe. The client end is
// returned as well: net.Pipe is unbuffered, so anything the server writes back
// (a pong, a close echo) blocks until someone reads it from the other side.
func readerConn(t *testing.T, data []byte) (*wsConn, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	go func() { _, _ = client.Write(data) }()
	t.Cleanup(func() { client.Close(); server.Close() })
	return &wsConn{conn: server, br: bufio.NewReader(server)}, client
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
		c, _ := readerConn(t, clientFrame(true, opText, payload))
		op, got, err := c.readMessage()
		if err != nil {
			t.Fatalf("payload of %d bytes: %v", n, err)
		}
		if op != opText {
			t.Fatalf("payload of %d bytes: opcode = %d", n, op)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("payload of %d bytes: round trip mismatch (%d bytes back)", n, len(got))
		}
	}
}

func TestReadMessageFragmented(t *testing.T) {
	var wire bytes.Buffer
	wire.Write(clientFrame(false, opText, []byte("hello ")))
	// A ping in the middle of a fragmented message is legal and must not be
	// mistaken for a continuation.
	wire.Write(clientFrame(true, opPing, []byte("hi")))
	wire.Write(clientFrame(false, opContinuation, []byte("brave ")))
	wire.Write(clientFrame(true, opContinuation, []byte("world")))

	c, client := readerConn(t, wire.Bytes())
	// Drain the pong the ping provokes, so the write does not block on the pipe.
	drain(client)

	_, got, err := c.readMessage()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello brave world" {
		t.Fatalf("reassembled %q", got)
	}
}

func TestReadMessageRejectsUnmasked(t *testing.T) {
	// Same frame, mask bit cleared: a server must refuse it.
	frame := clientFrame(true, opText, []byte("hi"))
	frame[1] &^= 0x80
	c, _ := readerConn(t, frame)
	if _, _, err := c.readMessage(); err == nil {
		t.Fatal("unmasked client frame was accepted")
	}
}

func TestReadMessageRejectsOversizedControlFrame(t *testing.T) {
	c, _ := readerConn(t, clientFrame(true, opPing, bytes.Repeat([]byte("x"), 126)))
	if _, _, err := c.readMessage(); err == nil {
		t.Fatal("a 126-byte control frame was accepted")
	}
}

func TestReadMessageCloseIsEOF(t *testing.T) {
	c, client := readerConn(t, clientFrame(true, opClose, []byte{0x03, 0xe8}))
	drain(client)
	if _, _, err := c.readMessage(); err != io.EOF {
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
		conn := &wsConn{conn: server}
		go func(n int) { _ = conn.sendText(bytes.Repeat([]byte("x"), n)) }(c.n)

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
