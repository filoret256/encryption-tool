package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// reloadRig is a server reading its clusters from a yaml file on disk, with one
// connection to it.
type reloadRig struct {
	*rig
	file string
}

func (r *reloadRig) write(t *testing.T, yaml string) {
	t.Helper()
	if err := os.WriteFile(r.file, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
}

func newReloadRig(t *testing.T, yaml string) *reloadRig {
	t.Helper()
	file := filepath.Join(t.TempDir(), "kafka-agent.yaml")
	if err := os.WriteFile(file, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	s, conn, fr := testConn(t)
	load := func() ([]*cluster, error) {
		list, _, err := loadClusters(clusterFlags{config: file})
		return list, err
	}
	list, err := load()
	if err != nil {
		t.Fatal(err)
	}
	s.setClusters(list)
	s.reload = load
	s.conns = map[*connection]bool{conn: true}
	t.Cleanup(conn.closeClients)
	return &reloadRig{rig: &rig{t: t, s: s, conn: conn, fr: fr, next: 1}, file: file}
}

func clusterYAML(entries ...string) string {
	return "clusters:\n" + strings.Join(entries, "")
}

func entry(name, addr string) string {
	return fmt.Sprintf("  - name: %s\n    bootstrap: %s\n", name, addr)
}

func TestReloadAddsRemovesAndChangesAndKeepsWhatDidNotChange(t *testing.T) {
	one := startBroker(t)
	two := startBroker(t)
	three := startBroker(t)
	r := newReloadRig(t, clusterYAML(entry("alpha", one), entry("beta", two)))

	// Use both, so each has a client to keep or to drop.
	for _, name := range []string{"alpha", "beta"} {
		if st := r.data("clusters.status", map[string]any{"cluster": name}); st["state"] != "connected" {
			t.Fatalf("%s: %v", name, st)
		}
	}
	if len(r.conn.clients) != 2 {
		t.Fatalf("%d clients before the reload", len(r.conn.clients))
	}
	alpha := r.conn.clients["alpha"]

	// alpha stays as it is (edited elsewhere in the file: its line moves), beta goes,
	// gamma arrives, and delta is beta's old name pointed somewhere else.
	r.write(t, "# a comment that moves every line below it\n"+clusterYAML(entry("alpha", one), entry("gamma", three)))
	res := r.data("config.reload", nil)

	list := func(v any) string {
		var out []string
		for _, x := range v.([]any) {
			out = append(out, x.(string))
		}
		return strings.Join(out, ",")
	}
	if list(res["added"]) != "gamma" || list(res["removed"]) != "beta" || list(res["changed"]) != "" {
		t.Fatalf("reload: %v", res)
	}
	if r.conn.clients["alpha"] != alpha {
		t.Error("a cluster that did not change lost its connection")
	}
	if _, kept := r.conn.clients["beta"]; kept {
		t.Error("a removed cluster kept its connection")
	}
	if names := clusterNames(r.data("agent.info", nil)); names != "alpha,gamma" {
		t.Errorf("agent.info after the reload: %s", names)
	}
	if st := r.data("clusters.status", map[string]any{"cluster": "gamma"}); st["state"] != "connected" {
		t.Errorf("the new cluster: %v", st)
	}
	r.fails("clusters.status", map[string]any{"cluster": "beta"}, "ENOCLUSTER", "beta")

	// Now alpha moves: it is changed, and its old connection goes.
	r.write(t, clusterYAML(entry("alpha", two), entry("gamma", three)))
	res = r.data("config.reload", nil)
	if list(res["changed"]) != "alpha" || list(res["added"]) != "" || list(res["removed"]) != "" {
		t.Fatalf("reload of a changed cluster: %v", res)
	}
	if _, kept := r.conn.clients["alpha"]; kept {
		t.Error("a changed cluster went on with the connection made from its old settings")
	}
	if st := r.data("clusters.status", map[string]any{"cluster": "alpha"}); st["state"] != "connected" || st["clusterId"] != "test-cluster" {
		t.Errorf("alpha after it moved: %v", st)
	}
}

func clusterNames(info map[string]any) string {
	var out []string
	for _, c := range info["clusters"].([]any) {
		out = append(out, c.(map[string]any)["name"].(string))
	}
	return strings.Join(out, ",")
}

func TestABrokenFileLeavesTheAgentAsItWas(t *testing.T) {
	one := startBroker(t)
	r := newReloadRig(t, clusterYAML(entry("alpha", one)))

	for name, yaml := range map[string]string{
		"a typo":       "clusters:\n  - name: alpha\n    bootstrap: " + one + "\n    securty: {}\n",
		"no bootstrap": "clusters:\n  - name: alpha\n",
		"not yaml":     "clusters: [",
	} {
		r.write(t, yaml)
		r.fails("config.reload", nil, "ECONFIG", "not changed")
		if names := clusterNames(r.data("agent.info", nil)); names != "alpha" {
			t.Errorf("%s: the configuration changed anyway: %s", name, names)
		}
	}
	// And the error says where the trouble is, the way it does at startup.
	r.write(t, "clusters:\n  - name: alpha\n    bootstrap: "+one+"\n    securty: {}\n")
	_, m := r.call("config.reload", nil)
	if !strings.Contains(fmt.Sprint(m["error"]), "securty") {
		t.Errorf("the message does not name the misspelt key: %v", m["error"])
	}
}

func TestEveryConnectionIsToldWhatChanged(t *testing.T) {
	one := startBroker(t)
	two := startBroker(t)
	r := newReloadRig(t, clusterYAML(entry("alpha", one)))

	// A second page, connected to the same agent.
	other, otherFrames := extraConn(t, r.s)
	_ = other

	r.write(t, clusterYAML(entry("alpha", one), entry("beta", two)))
	// Sent by hand: r.call reads past frames that are not its own reply, and the
	// push is one of them.
	r.s.dispatch(r.conn, request(r.next, "config.reload", nil))
	r.next++

	for who, fr := range map[string]<-chan map[string]any{"the page that asked": r.fr, "another page": otherFrames} {
		deadline := time.After(3 * time.Second)
		for done := false; !done; {
			select {
			case m := <-fr:
				if m["event"] != "clusters.changed" {
					continue
				}
				data := m["data"].(map[string]any)
				if got := len(data["clusters"].([]any)); got != 2 {
					t.Errorf("%s was told of %d clusters, want 2", who, got)
				}
				done = true
			case <-deadline:
				t.Fatalf("%s never heard of the change", who)
			}
		}
	}
}

// extraConn adds another connection to a server, as a second open page would be.
func extraConn(t *testing.T, s *server) (*connection, <-chan map[string]any) {
	t.Helper()
	_, conn, fr := testConn(t)
	s.mu.Lock()
	s.conns[conn] = true
	s.mu.Unlock()
	return conn, fr
}

func TestNothingToReloadFrom(t *testing.T) {
	s, conn, fr := testConn(t)
	s.dispatch(conn, request(1, "config.reload", nil))
	if got := replyFor(t, fr, 1); got["code"] != "ECONFIG" {
		t.Fatalf("an agent with nothing to re-read: %v", got)
	}
}
