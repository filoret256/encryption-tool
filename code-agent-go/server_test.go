package main

import (
	"bufio"
	"context"
	agentkit "enc-tool/agent-kit"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The workspace is read by every operation and replaced by code-agent.setRoot, from
// different goroutines. What a reader must never see is a mixture: the jail of
// one folder with the repository flag or the reported root of another.
//
// The race detector is the usual tool for this and needs cgo, which not every
// machine that builds the code-agent has. This checks the property instead of the
// mechanism — every snapshot, taken at any moment, agrees with itself — which
// holds by construction when the three are one value and would not if they were
// separate fields written one after another.
func TestWorkspaceSnapshotsNeverTear(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed; setRoot asks it whether a folder is a repository")
	}
	repo, plain := t.TempDir(), t.TempDir()
	if out, err := exec.Command("git", "-C", repo, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	jr, err := openJail(repo)
	if err != nil {
		t.Fatal(err)
	}
	jp, err := openJail(plain)
	if err != nil {
		t.Fatal(err)
	}

	s := &server{rerootBases: []string{jr.root, jp.root}}
	s.ws.Store(&workspace{jail: jr, isRepo: true, info: &codeAgentInfo{Root: jr.root, Repo: strPtr(".")}})
	first := s.ws.Load().info

	var torn atomic.Int64
	stop := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				w := s.ws.Load()
				if w.jail.root != w.info.Root || w.isRepo != (w.info.Repo != nil) {
					torn.Add(1)
				}
			}
		}()
	}

	// Two goroutines rerooting at once: they must serialise, not interleave.
	var writers sync.WaitGroup
	for g := 0; g < 2; g++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for i := 0; i < 20; i++ {
				dir := plain
				if i%2 == 1 {
					dir = repo
				}
				if _, err := s.setRoot(context.Background(), dir); err != nil {
					t.Errorf("setRoot(%s): %v", dir, err)
					return
				}
			}
		}()
	}
	writers.Wait()
	close(stop)
	readers.Wait()

	if n := torn.Load(); n != 0 {
		t.Fatalf("%d snapshots disagreed with themselves (jail root vs info.Root, or isRepo vs info.Repo)", n)
	}

	// What an operation already running holds must not change under it.
	if first.Root != jr.root || first.Repo == nil {
		t.Fatalf("the first published info was edited in place: Root=%q Repo=%v", first.Root, first.Repo)
	}
}

// ── requests in flight ────────────────────────────────────────────────────

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

// replyFor waits for the frame answering one request, skipping the others.
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
				return m
			}
		case <-deadline:
			t.Fatalf("no answer to request %d within 3s", id)
		}
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 300; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// testConn is a server with one connection over an in-memory pipe, and a reader
// for what the server says back.
func testConn(t *testing.T, isRepo bool) (*server, *connection, <-chan map[string]any) {
	t.Helper()
	client, side := net.Pipe()
	s := &server{}
	j := &jail{root: t.TempDir()}
	s.ws.Store(&workspace{jail: j, isRepo: isRepo, info: &codeAgentInfo{Root: j.root}})
	conn := &connection{
		ws:       agentkit.NewConn(side),
		slots:    make(chan struct{}, maxConcurrentProcs),
		inflight: map[int64]context.CancelFunc{},
	}
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

func cancelReq(id, target int64) *req {
	return &req{id: id, op: "cancel", params: map[string]json.RawMessage{"target": json.RawMessage(strconv.FormatInt(target, 10))}}
}

func hold(t *testing.T, name string) {
	t.Helper()
	ops[name] = func(c *opCtx, _ *req) (any, error) {
		<-c.ctx.Done()
		return nil, errors.New("held")
	}
	t.Cleanup(func() { delete(ops, name) })
}

func TestRequestsInFlightAreBounded(t *testing.T) {
	hold(t, "test.hold")
	s, conn, fr := testConn(t, false)

	for i := int64(1); i <= maxInflightOps; i++ {
		s.dispatch(conn, &req{id: i, op: "test.hold"})
	}
	s.dispatch(conn, &req{id: 9000, op: "test.hold"})
	got := replyFor(t, fr, 9000)
	if got["code"] != "EBUSY" {
		t.Fatalf("request %d over the limit: %v, want EBUSY", maxInflightOps+1, got)
	}

	// Cancel is how a client gets out of a full house, so it is never refused.
	s.dispatch(conn, cancelReq(9001, 1))
	if got := replyFor(t, fr, 9001); got["ok"] != true {
		t.Fatalf("cancel was refused while the connection was full: %v", got)
	}
	// And once something has finished, the room is real.
	eventually(t, "the cancelled request to leave", func() bool {
		conn.mu.Lock()
		defer conn.mu.Unlock()
		return len(conn.inflight) < maxInflightOps
	})
	s.dispatch(conn, &req{id: 9002, op: "test.hold"})
	s.dispatch(conn, cancelReq(9003, 9002))
	if got := replyFor(t, fr, 9002); got["code"] == "EBUSY" {
		t.Fatalf("a request was refused although one had finished: %v", got)
	}
}

func TestCancelEndsTheWaitForAProcessSlot(t *testing.T) {
	hold(t, "git.test-hold")
	s, conn, fr := testConn(t, true)

	for i := int64(1); i <= maxConcurrentProcs; i++ {
		s.dispatch(conn, &req{id: i, op: "git.test-hold"})
	}
	eventually(t, "every slot to be taken", func() bool { return len(conn.slots) == maxConcurrentProcs })

	// The fifth has to wait. Cancelling it must end the wait: it used to stay in
	// the queue, take a slot the moment one freed, and only then notice.
	s.dispatch(conn, &req{id: 100, op: "git.test-hold"})
	s.dispatch(conn, cancelReq(101, 100))
	got := replyFor(t, fr, 100)
	if got["code"] != "ECANCELED" {
		t.Fatalf("a cancelled request waiting for a slot: %v, want ECANCELED", got)
	}
	if len(conn.slots) != maxConcurrentProcs {
		t.Fatalf("the cancelled request left the slots at %d, want them still all held by the running four", len(conn.slots))
	}
}
