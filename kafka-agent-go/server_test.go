package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	agentkit "enc-tool/agent-kit"
)

// frames decodes the server's text frames off the client end of the pipe.
func frames(c net.Conn) <-chan map[string]any {
	out := make(chan map[string]any, 1024)
	go func() {
		defer close(out)
		br := bufio.NewReader(c)
		for {
			var h [2]byte
			if _, err := io.ReadFull(br, h[:]); err != nil {
				return
			}
			n := int(h[1] & 0x7f)
			switch n {
			case 126:
				var b [2]byte
				if _, err := io.ReadFull(br, b[:]); err != nil {
					return
				}
				n = int(binary.BigEndian.Uint16(b[:]))
			case 127:
				var b [8]byte
				if _, err := io.ReadFull(br, b[:]); err != nil {
					return
				}
				n = int(binary.BigEndian.Uint64(b[:]))
			}
			payload := make([]byte, n)
			if _, err := io.ReadFull(br, payload); err != nil {
				return
			}
			var m map[string]any
			if h[0]&0x0f == agentkit.OpText && json.Unmarshal(payload, &m) == nil {
				out <- m
			}
		}
	}()
	return out
}

func replyFor(t *testing.T, fr <-chan map[string]any, id int64) map[string]any {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m, ok := <-fr:
			if !ok {
				t.Fatalf("connection closed before request %d was answered", id)
			}
			if got, _ := m["id"].(float64); int64(got) == id {
				if _, isChunk := m["chunk"]; !isChunk {
					return m
				}
			}
		case <-deadline:
			t.Fatalf("no answer to request %d within 3s", id)
		}
	}
}

func testConn(t *testing.T) (*server, *connection, <-chan map[string]any) {
	t.Helper()
	client, side := net.Pipe()
	s := &server{}
	s.setClusters([]*cluster{{Name: "dev", ReadOnly: true, Protocol: "PLAINTEXT"}})
	conn := &connection{ws: agentkit.NewConn(side), inflight: map[int64]context.CancelFunc{}}
	t.Cleanup(func() {
		conn.mu.Lock()
		for _, cancel := range conn.inflight {
			cancel()
		}
		conn.mu.Unlock()
		client.Close()
		side.Close()
	})
	return s, conn, frames(client)
}

func request(id int64, op string, params map[string]any) *req {
	m := map[string]any{"id": id, "op": op}
	for k, v := range params {
		m[k] = v
	}
	raw, _ := json.Marshal(m)
	return &req{id: id, op: op, raw: raw}
}

func hold(t *testing.T, name string) {
	t.Helper()
	ops[name] = readOp(func(c *opCtx, _ *req) (any, error) {
		<-c.ctx.Done()
		return nil, errors.New("held")
	})
	t.Cleanup(func() { delete(ops, name) })
}

func TestInfoNamesTheAgentAndItsClustersOnly(t *testing.T) {
	s, conn, fr := testConn(t)
	s.dispatch(conn, request(1, "agent.info", nil))
	got := replyFor(t, fr, 1)
	data, _ := got["data"].(map[string]any)
	if data["agent"] != "kafka-agent" {
		t.Fatalf("agent.info: %v", got)
	}
	clusters, _ := data["clusters"].([]any)
	if len(clusters) != 1 || fmt.Sprint(clusters[0]) != "map[name:dev readOnly:true]" {
		t.Fatalf("clusters: %v — a cluster is a name and a flag, nothing more", clusters)
	}
}

func TestUnknownOpIsRefusedByName(t *testing.T) {
	s, conn, fr := testConn(t)
	s.dispatch(conn, request(1, "fs.read", nil))
	if got := replyFor(t, fr, 1); got["code"] != "ENOOP" {
		t.Fatalf("an op this agent does not have: %v, want ENOOP", got)
	}
}

func TestBadParametersAreRefused(t *testing.T) {
	s, conn, fr := testConn(t)
	s.dispatch(conn, request(1, "cancel", map[string]any{"target": "seven"}))
	if got := replyFor(t, fr, 1); got["code"] != "EPARAM" {
		t.Fatalf("a string where a number belongs: %v, want EPARAM", got)
	}
}

func TestCancelStopsARunningOp(t *testing.T) {
	hold(t, "test.hold")
	s, conn, fr := testConn(t)
	s.dispatch(conn, request(1, "test.hold", nil))
	s.dispatch(conn, request(2, "cancel", map[string]any{"target": 1}))
	// Either reply may come first, and replyFor drops what it skips.
	got := map[int64]map[string]any{}
	for len(got) < 2 {
		select {
		case m := <-fr:
			id, _ := m["id"].(float64)
			got[int64(id)] = m
		case <-time.After(3 * time.Second):
			t.Fatalf("replies so far: %v", got)
		}
	}
	if fmt.Sprint(got[2]["data"]) != "map[cancelled:true]" {
		t.Fatalf("cancel: %v", got[2])
	}
	if got[1]["code"] != "ECANCELED" {
		t.Fatalf("the cancelled op: %v, want ECANCELED", got[1])
	}
}

func TestRequestsInFlightAreBounded(t *testing.T) {
	hold(t, "test.hold")
	s, conn, fr := testConn(t)
	for i := int64(1); i <= maxInflightOps; i++ {
		s.dispatch(conn, request(i, "test.hold", nil))
	}
	s.dispatch(conn, request(9000, "test.hold", nil))
	if got := replyFor(t, fr, 9000); got["code"] != "EBUSY" {
		t.Fatalf("request over the limit: %v, want EBUSY", got)
	}
	// cancel is how a client gets out of a full house, so it is never refused.
	s.dispatch(conn, request(9001, "cancel", map[string]any{"target": 1}))
	if got := replyFor(t, fr, 9001); got["ok"] != true {
		t.Fatalf("cancel was refused while the connection was full: %v", got)
	}
}
