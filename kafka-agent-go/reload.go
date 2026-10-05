// config.reload: read the configuration again while the agent runs.
//
// Adding a cluster, changing where one lives or what it logs in with should not
// mean stopping the agent and pasting a new URL into the page. The file is read
// the way it was at startup — the same flags, the same checks — and only if all
// of it is sound does it replace what is running. A file with a typo in it
// leaves the agent exactly as it was, and says where the typo is.
package main

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"

	agentkit "enc-tool/agent-kit"
)

// reloader re-reads the configuration; main.go supplies it.
type reloader func() ([]*cluster, error)

// sameSettings reports whether two definitions of a cluster would connect the
// same way. Where they were written down (source, line numbers) and what the
// loader had to say about them are not settings: an edit elsewhere in the file
// moves every line number, and must not restart a connection that did not change.
func sameSettings(a, b *cluster) bool {
	x, y := *a, *b
	x.source, y.source = "", ""
	x.Warnings, y.Warnings = nil, nil
	return reflect.DeepEqual(x, y)
}

// diffClusters names what changed between two configurations.
func diffClusters(before map[string]*cluster, after []*cluster) (added, removed, changed []string) {
	seen := map[string]bool{}
	for _, c := range after {
		seen[c.Name] = true
		old, had := before[c.Name]
		switch {
		case !had:
			added = append(added, c.Name)
		case !sameSettings(old, c):
			changed = append(changed, c.Name)
		}
	}
	for name := range before {
		if !seen[name] {
			removed = append(removed, name)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	sort.Strings(changed)
	return
}

var reloadMu sync.Mutex

// reloadConfig replaces the running configuration, or leaves it alone.
func (s *server) reloadConfig() (*reloadResult, error) {
	if s.reload == nil {
		return nil, &opError{Code: "ECONFIG", Message: "This agent was started without a configuration it can read again"}
	}
	// One reload at a time, start to finish: two of them interleaving would publish
	// one file's clusters and drop the connections of the other's.
	reloadMu.Lock()
	defer reloadMu.Unlock()

	next, err := s.reload()
	if err != nil {
		agentkit.Lifecycle("config not reloaded — " + err.Error())
		return nil, &opError{Code: "ECONFIG", Message: "The configuration was not changed: " + err.Error()}
	}

	s.mu.Lock()
	before := s.config
	s.mu.Unlock()
	added, removed, changed := diffClusters(before, next)
	s.setClusters(next)

	// A client made from the old settings would go on talking to the old place with
	// the old login, so it goes; the next request makes a new one. Clusters that did
	// not change keep theirs.
	stale := append(append([]string{}, removed...), changed...)
	s.mu.Lock()
	conns := make([]*connection, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		for _, name := range stale {
			c.dropClient(name)
		}
		c.send(pushFrame{Event: "clusters.changed", Data: clustersChanged{Clusters: s.clusterList()}})
	}

	res := &reloadResult{Clusters: s.clusterList(), Added: nonNilStrings(added), Removed: nonNilStrings(removed), Changed: nonNilStrings(changed), Warnings: warningsOf(next)}
	agentkit.Lifecycle(fmt.Sprintf("config reloaded — %d added, %d removed, %d changed%s",
		len(added), len(removed), len(changed), namesNote(added, removed, changed)))
	return res, nil
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func namesNote(added, removed, changed []string) string {
	var parts []string
	for _, g := range []struct {
		mark string
		list []string
	}{{"+", added}, {"-", removed}, {"~", changed}} {
		for _, n := range g.list {
			parts = append(parts, g.mark+n)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, " ") + ")"
}

func configReload(c *opCtx, _ noParams) (any, error) { return c.srv.reloadConfig() }
