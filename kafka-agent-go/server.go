// The loopback server: agent-kit's front door, then the op table.
//
// Security posture:
//
//	1-3. loopback only, a token on every connection, Origin and Host checked —
//	     agentkit.Guard, the same code the code-agent runs;
//	4.   the page names a cluster, never an address: every connection setting
//	     comes from the operator's config, so this process cannot be turned into
//	     a proxy to a host nobody configured.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sr"

	agentkit "enc-tool/agent-kit"
)

// How many requests one connection may have started and not finished.
//
// Each runs on a goroutine of its own so a slow one — a consume waiting on a
// broker — never holds up the rest. The number is where "a burst" becomes
// "something is wrong"; past it a request is refused with EBUSY rather than
// queued. The same bound as the code-agent's, for the same reason.
const maxInflightOps = 128

type connection struct {
	ws *agentkit.Conn

	mu       sync.Mutex
	inflight map[int64]context.CancelFunc
	// One client per cluster this page has used, made on first use and closed
	// with the connection. See connect.go.
	clients map[string]*kgo.Client
	// One Schema Registry client per cluster that has a registry (K-41). Nothing to
	// close: a registry client wraps an *http.Client, not a connection of its own.
	registries map[string]*sr.Client
	// The schemas read so far, parsed and ready to decode with (K-42), and the ones the
	// registry was asked about. Keyed by schema id.
	schemas *schemaCache
	// How many messages.consume / messages.get are running: see maxConsumes.
	consuming int
}

func (c *connection) send(frame any) {
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_ = c.ws.SendText(b)
}

type opCtx struct {
	ctx  context.Context
	conn *connection
	id   int64
	srv  *server
	// The op changes something: use() looks at the cluster's read-only setting once
	// more, because a reload may have changed it since dispatch checked.
	write bool
}

func (c *opCtx) chunk(v any) { c.conn.send(chunkFrame{ID: c.id, Chunk: v}) }

type opFunc func(*opCtx, *req) (any, error)

// access says what an op may do to a cluster. Every op in the table carries one:
// the table's entries are opEntry values, and the only ways to make one are
// readOp and writeOp, so an op nobody classified does not compile. The zero value
// is "unmarked", which dispatch treats as no such op — a hand-built entry that
// skipped the constructors would otherwise pass as a read.
type access int8

const (
	accessUnmarked access = iota
	accessRead
	accessWrite
)

type opEntry struct {
	fn     opFunc
	access access
	// What a write op puts in the write log (audit.go); nil for a read.
	about auditFunc
}

// readOp marks an op that changes nothing on any cluster.
func readOp(fn opFunc) opEntry { return opEntry{fn: fn, access: accessRead} }

// writeOp marks an op that changes something on a cluster: a message produced, a
// topic created or deleted, offsets moved. It is refused on a read-only cluster
// before anything is sent to a broker, and it must take a "cluster" parameter,
// which is how the refusal knows which cluster's setting to read. about says what
// its line in the write log holds, so no write goes unrecorded by being forgotten.
func writeOp(fn opFunc, about auditFunc) opEntry { return opEntry{fn, accessWrite, about} }

// ── op table ──────────────────────────────────────────────────────────────

// Each entry says, by readOp or writeOp, whether the op changes anything on a
// cluster: see access. A writeOp is refused on a read-only cluster by dispatch
// itself, so no handler has to remember to ask.
var ops map[string]opEntry

// Built in init: entries close over helpers declared elsewhere, and Go rejects
// the initialization cycle a literal would make.
func init() {
	ops = map[string]opEntry{
		"agent.info": readOp(typed[noParams](func(c *opCtx, _ noParams) (any, error) {
			return c.srv.info(), nil
		})),

		// Stops a running op of this connection's — a consume the page has
		// navigated away from. Another connection's requests are not reachable:
		// the lookup is in this connection's own table.
		"cancel": readOp(typed[cancelParams](func(c *opCtx, p cancelParams) (any, error) {
			c.conn.mu.Lock()
			cancel, found := c.conn.inflight[p.Target]
			c.conn.mu.Unlock()
			if found {
				cancel()
			}
			return map[string]bool{"cancelled": found}, nil
		})),

		// Reads the configuration again: see reload.go.
		"config.reload": readOp(typed[noParams](configReload)),

		// The configured clusters, by name, with what the page may know about
		// each: whether it is read-only and how it is secured. Never where it is.
		"clusters.list": readOp(typed[noParams](func(c *opCtx, _ noParams) (any, error) {
			return c.srv.clusterList(), nil
		})),

		// Connects and reports the cluster's state — see (*server).status.
		"clusters.status": readOp(typed[clusterParams](func(c *opCtx, p clusterParams) (any, error) {
			cl, err := c.srv.cluster(p.Cluster)
			if err != nil {
				return nil, err
			}
			return c.srv.status(c.ctx, c.conn, cl)
		})),

		"brokers.list":   readOp(typed[clusterParams](brokersList)),
		"brokers.config": readOp(typed[brokerParams](brokersConfig)),

		// Who may do what to which resource: see ops_acls.go.
		"acls.list": readOp(typed[clusterParams](aclsList)),

		// The cluster's Schema Registry, when it has one: see sr.go. Its own URL, login
		// and stores, so it is asked about on its own.
		"schemas.status": readOp(typed[clusterParams](schemasStatus)),

		// A value that carries a schema, read with it: see srdecode.go.
		"messages.decode": readOp(typed[decodeValueParams](decodeValue)),

		// What the registry holds: see srschema.go.
		"schemas.subjects": readOp(typed[clusterParams](schemasSubjects)),
		"schemas.versions": readOp(typed[subjectParams](schemasVersions)),
		"schemas.version":  readOp(typed[schemaVersionParams](schemasVersion)),

		// Whether the registry would take a schema: a read, so it is allowed on a
		// read-only cluster — see srschema_write.go.
		"schemas.check": readOp(typed[checkSchemaParams](schemasCheck)),

		"topics.list":     readOp(typed[clusterParams](topicsList)),
		"topics.describe": readOp(typed[topicParams](topicsDescribe)),
		"topics.config":   readOp(typed[topicParams](topicsConfig)),

		// Streams messageBatch chunks, then answers with what it read.
		"messages.consume": readOp(typed[consumeParams](messagesConsume)),
		"messages.tail":    readOp(typed[tailParams](messagesTail)),
		"messages.get":     readOp(typed[getMessageParams](messagesGet)),

		// The ops that change a cluster: see ops_write.go.
		"messages.produce": writeOp(typed[produceParams](messagesProduce), about(auditProduce)),
		"topics.delete":    writeOp(typed[deleteTopicParams](topicsDelete), about(auditDeleteTopic)),
		"topics.create":    writeOp(typed[createTopicParams](topicsCreate), about(auditCreateTopic)),
		"groups.reset":     writeOp(typed[resetOffsetsParams](groupsReset), about(auditResetOffsets)),

		// The ops that change a topic that is already there, and a group that is
		// finished with: see ops_alter.go and ops_manage.go.
		"topics.alterConfigs":  writeOp(typed[alterConfigParams](topicsAlterConfigs), about(auditAlterConfigs)),
		"topics.addPartitions": writeOp(typed[addPartitionsParams](topicsAddPartitions), about(auditAddPartitions)),
		"topics.deleteRecords": writeOp(typed[deleteRecordsParams](topicsDeleteRecords), about(auditDeleteRecords)),
		"groups.delete":        writeOp(typed[deleteGroupParams](groupsDelete), about(auditDeleteGroup)),

		// The registry is a service beside the cluster, but the operator's switch is the
		// cluster's: see srschema_write.go.
		"schemas.register":         writeOp(typed[registerSchemaParams](schemasRegister), about(auditRegisterSchema)),
		"schemas.setCompatibility": writeOp(typed[setCompatibilityParams](schemasSetCompatibility), about(auditSetCompatibility)),

		"groups.list":     readOp(typed[clusterParams](groupsList)),
		"groups.describe": readOp(typed[groupParams](groupsDescribe)),
	}
}

// ── server ────────────────────────────────────────────────────────────────

type server struct {
	agentkit.Guard

	// The clusters as configured, and what agent.info says about them.
	// Replaced whole, never edited in place.
	mu       sync.Mutex
	config   map[string]*cluster
	clusters []clusterInfo
	// Every open connection, so a reload can tell each what changed and drop the
	// clients made from settings that are gone.
	conns map[*connection]bool

	// Reads the configuration again for config.reload; nil when there is nothing to re-read.
	reload reloader

	// Where the write log goes (audit.go); nil writes nothing. One line at a time.
	auditMu sync.Mutex
	audit   io.Writer
}

func (s *server) setClusters(list []*cluster) {
	config := map[string]*cluster{}
	infos := make([]clusterInfo, 0, len(list))
	for _, c := range list {
		config[c.Name] = c
		infos = append(infos, clusterInfo{Name: c.Name, ReadOnly: c.ReadOnly})
	}
	s.mu.Lock()
	s.config, s.clusters = config, infos
	s.mu.Unlock()
}

// cluster finds the cluster a request names. The name is the only thing the
// page gets to say about where to connect.
func (s *server) cluster(name string) (*cluster, error) {
	s.mu.Lock()
	cl := s.config[name]
	s.mu.Unlock()
	if cl == nil {
		return nil, &opError{Code: "ENOCLUSTER", Message: "Unknown cluster: " + name}
	}
	return cl, nil
}

func (s *server) clusterList() []clusterEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]clusterEntry, 0, len(s.clusters))
	for _, info := range s.clusters { // config order, which map order is not
		c := s.config[info.Name]
		out = append(out, clusterEntry{Name: c.Name, ReadOnly: c.ReadOnly, Protocol: c.Protocol, Mechanism: c.Mechanism})
	}
	return out
}

func (s *server) info() *kafkaAgentInfo {
	s.mu.Lock()
	clusters := append([]clusterInfo{}, s.clusters...)
	s.mu.Unlock()
	return &kafkaAgentInfo{Agent: "kafka-agent", Version: version, Platform: nodePlatform(), Clusters: clusters}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.Serve(w, r, s.serveConn)
}

// serveConn runs one client's session. The Guard has checked it, holds its
// slot, and closes the socket when this returns.
func (s *server) serveConn(ws *agentkit.Conn, _ string) {
	conn := &connection{ws: ws, inflight: map[int64]context.CancelFunc{}}
	s.mu.Lock()
	if s.conns == nil {
		s.conns = map[*connection]bool{}
	}
	s.conns[conn] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
		conn.closeClients()
		// Nothing will read the results now; stop every consume at once.
		conn.mu.Lock()
		for _, cancel := range conn.inflight {
			cancel()
		}
		conn.inflight = map[int64]context.CancelFunc{}
		conn.mu.Unlock()
	}()

	for {
		opcode, payload, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if opcode != agentkit.OpText {
			continue
		}
		var head struct {
			ID int64  `json:"id"`
			Op string `json:"op"`
		}
		if err := json.Unmarshal(payload, &head); err != nil {
			continue // not a request; nothing to answer it with
		}
		s.dispatch(conn, &req{id: head.ID, op: head.Op, raw: payload})
	}
}

func (s *server) dispatch(conn *connection, r *req) {
	entry, ok := ops[r.op]
	if !ok || entry.access == accessUnmarked {
		conn.send(resErr{ID: r.id, Error: "Unknown op: " + r.op, Code: "ENOOP"})
		return
	}
	// Before a goroutine is started, before a client is made, before a byte is sent
	// to a broker: a write to a read-only cluster costs nothing but this answer.
	if entry.access == accessWrite {
		if e := s.mayWrite(r); e != nil {
			s.record(r, entry, nil, e, true)
			conn.send(resErr{ID: r.id, Error: e.Message, Code: e.Code})
			return
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	conn.mu.Lock()
	// cancel is exempt: it is how a client gets out of a full house.
	if r.op != "cancel" && len(conn.inflight) >= maxInflightOps {
		conn.mu.Unlock()
		cancel()
		conn.send(resErr{ID: r.id, Error: "Too many requests in flight", Code: "EBUSY"})
		return
	}
	conn.inflight[r.id] = cancel
	conn.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			conn.mu.Lock()
			delete(conn.inflight, r.id)
			conn.mu.Unlock()
		}()
		data, err := entry.fn(&opCtx{ctx: ctx, conn: conn, id: r.id, srv: s, write: entry.access == accessWrite}, r)
		// Recorded before the page is told, so the line exists by the time anyone acts on the answer.
		if entry.access == accessWrite {
			s.record(r, entry, data, err, false)
		}
		if err != nil {
			conn.send(resErr{ID: r.id, Error: err.Error(), Code: errCodeOf(ctx, err)})
			return
		}
		conn.send(resOK{ID: r.id, OK: true, Data: data})
	}()
}

// mayWrite decides whether a write op may run: the cluster it names must not be
// read-only. The cluster comes from the request's own "cluster" parameter, the one
// every op that reaches a cluster takes; a write op without one names no cluster
// and is refused like any other unknown cluster.
func (s *server) mayWrite(r *req) *opError {
	var p clusterParams
	if err := r.decode(&p); err != nil {
		var coded *opError
		if errors.As(err, &coded) {
			return coded
		}
		return &opError{Code: "EPARAM", Message: err.Error()}
	}
	cl, err := s.cluster(p.Cluster)
	if err != nil {
		var coded *opError
		if errors.As(err, &coded) {
			return coded
		}
		return &opError{Code: "ENOCLUSTER", Message: err.Error()}
	}
	return writable(cl)
}

// writable is the one place that says whether the agent may change a cluster.
// Nil when it may; otherwise READ_ONLY, with what to change if that is wrong.
func writable(cl *cluster) *opError {
	if !cl.ReadOnly {
		return nil
	}
	if cl.readOnlySet {
		return &opError{Code: "READ_ONLY", Message: fmt.Sprintf(
			"Cluster %q is marked readOnly: true in the agent's configuration, so the agent will not change anything on it (--allow-write does not override that). Set readOnly: false for it and reload the config.", cl.Name)}
	}
	return &opError{Code: "READ_ONLY", Message: fmt.Sprintf(
		"Cluster %q is read-only: the agent changes nothing unless it is told it may. Set readOnly: false for it in kafka-agent.yaml, or start the agent with --allow-write, then reload the config.", cl.Name)}
}

// errCodeOf picks the wire code: the op's own when it gave one, ECANCELED when
// the page stopped it, EKAFKA for anything the client library said.
func errCodeOf(ctx context.Context, err error) string {
	var coded *opError
	if errors.As(err, &coded) {
		return coded.Code
	}
	if ctx.Err() != nil {
		return "ECANCELED"
	}
	return "EKAFKA"
}
