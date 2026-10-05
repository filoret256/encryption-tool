// Reading messages: messages.consume and messages.get.
//
// A consume never joins a consumer group. It asks for partitions directly
// (kgo.ConsumePartitions), so looking at a topic commits no offsets, appears
// in no group list, and cannot make a rebalance happen in somebody's
// application. It reads up to where each partition ended when the request
// started, and then stops: this is a viewer, not a tail.
package main

import (
	"bytes"
	"container/heap"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/twmb/franz-go/pkg/kgo"
)

const (
	// The most messages one request returns, and the default when it does not say.
	maxLimit     = 1000
	defaultLimit = 100

	// The most messages one request reads, matching or not. A filter over a huge
	// topic is a scan; this is where the scan gives up and says so.
	maxScan = 100_000

	// A value longer than this goes to the page cut off, with the flag set, and
	// messages.get has the rest. A header longer than maxHeaderBytes is cut
	// without a way back: it is metadata, not data.
	maxValueBytes  = 256 << 10
	maxKeyBytes    = 64 << 10
	maxHeaderBytes = 4 << 10

	// messages.get returns a whole value, up to this. Past it the page gets the
	// same prefix with the truncated flag and the real size.
	maxGetBytes = 8 << 20

	// How long a consume waits for the cluster to say anything before it decides
	// nothing more is coming. Also what ends a partition whose last offset is a
	// transaction marker, which is never delivered as a record.
	idleTimeout = 4 * time.Second

	// The most consumes one connection may have running.
	maxConsumes = 4

	// The most messages one frame carries when they are small.
	batchSize = 50

	// The most bytes one frame may carry, near enough.
	//
	// batchSize and tailMaxPerWindow bound a frame by how many messages it
	// holds, and a value is allowed to be maxValueBytes — which base64, the wire
	// form, turns into about 341 KiB. Fifty of those is about 17 MB of JSON and
	// five hundred is about 160 MB, and the page parses the whole frame in its
	// main thread in one JSON.parse. This is the bound that actually holds, and
	// the page keeps its own buffers inside it (src/web/kafka/messages.ts).
	maxFrameBytes = 4 << 20

	// The most the one direction that has to hold a window may hold.
	//
	// `from: "end"` cannot send anything until it knows which messages are the
	// newest, so it reads a stretch of the topic into memory first — up to
	// maxScan records, and with 256 KiB values that is tens of gigabytes. The
	// window is therefore bounded by bytes as well as by count, and the oldest
	// matches are dropped as it fills: the newest are what a viewer asks a tail
	// for, and the page's own buffer stops at the same size (MAX_LIVE_BYTES in
	// src/web/kafka/buffer.ts), so holding more here would only be thrown away
	// there.
	maxWindowBytes = 32 << 20
)

// frameBytes is a message's size in a frame, near enough to bound one by: the
// base64 of the key and the value is already in hand, and the fields around them
// have a constant order of magnitude. Marshalling every message to measure it
// exactly would cost more than the bound saves.
func frameBytes(m kafkaMessage) int {
	n := 192
	if m.Key != nil {
		n += len(*m.Key)
	}
	if m.Value != nil {
		n += len(*m.Value)
	}
	for _, h := range m.Headers {
		n += len(h.Key) + 24
		if h.Value != nil {
			n += len(*h.Value)
		}
	}
	return n
}

// window keeps the newest messages a `from: end` consume has matched, inside a
// byte budget.
//
// It holds the wire form rather than the record: a kgo.Record's value points
// into the fetch buffer it arrived in, so keeping records keeps every buffer
// they came from alive, and the value in one is not bounded by maxValueBytes
// until it is cut. Converting on the way in is also what "truncate at read
// time, not at send time" means.
type window struct {
	// A heap whose root is the oldest message held, in the order the answer is
	// sorted in (newestFirst): what the budget drops is always what the answer
	// would have put last.
	messages []kafkaMessage
	bytes    int
	skipped  int
}

// newestFirst is the order a `from: end` answer is sent in: by time, newest
// first; then by partition; then by offset, newest first.
func newestFirst(a, b kafkaMessage) bool {
	if a.Timestamp != b.Timestamp {
		return a.Timestamp > b.Timestamp
	}
	if a.Partition != b.Partition {
		return a.Partition < b.Partition
	}
	return a.Offset > b.Offset
}

// The heap interface over the messages: Less puts the oldest at the root.
func (w *window) Len() int           { return len(w.messages) }
func (w *window) Less(i, j int) bool { return newestFirst(w.messages[j], w.messages[i]) }
func (w *window) Swap(i, j int)      { w.messages[i], w.messages[j] = w.messages[j], w.messages[i] }
func (w *window) Push(x any)         { w.messages = append(w.messages, x.(kafkaMessage)) }
func (w *window) Pop() any {
	last := w.messages[len(w.messages)-1]
	w.messages[len(w.messages)-1] = kafkaMessage{} // let the value go
	w.messages = w.messages[:len(w.messages)-1]
	return last
}

func (w *window) add(m kafkaMessage) {
	heap.Push(w, m)
	w.bytes += frameBytes(m)
	// The oldest go first — by time, not by when they arrived. Partitions are
	// fetched side by side, so one partition can arrive whole before another
	// starts, and dropping by arrival could drop the newest messages of the
	// topic. The count is bounded by maxScan on its own.
	for len(w.messages) > 1 && w.bytes > maxWindowBytes {
		old := heap.Pop(w).(kafkaMessage)
		w.bytes -= frameBytes(old)
		w.skipped++
	}
}

// consumeSlot takes one of the connection's consume slots, or refuses.
func (c *connection) consumeSlot() (release func(), ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.consuming >= maxConsumes {
		return nil, false
	}
	c.consuming++
	return func() {
		c.mu.Lock()
		c.consuming--
		c.mu.Unlock()
	}, true
}

// reader makes the client a consume reads with: this cluster's settings, and
// the partitions to start from. It is the caller's to close.
func (t *target) reader(begin map[string]map[int32]kgo.Offset) (*kgo.Client, error) {
	opts, err := clientOpts(t.cl)
	if err != nil {
		return nil, &opError{Code: "ECONFIG", Message: err.Error()}
	}
	opts = append(opts,
		kgo.ConsumePartitions(begin),
		kgo.FetchMaxWait(500*time.Millisecond),
		kgo.FetchMaxBytes(16<<20),
		kgo.FetchMaxPartitionBytes(4<<20),
	)
	kc, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, &opError{Code: "ECONFIG", Message: err.Error()}
	}
	return kc, nil
}

// filter reports whether a record is one the page asked for.
type filter func(r *kgo.Record) bool

func makeFilter(p consumeParams) (filter, error) {
	if p.Filter == "" {
		return func(*kgo.Record) bool { return true }, nil
	}
	if len(p.Filter) > 500 {
		return nil, &opError{Code: "EPARAM", Message: "The filter is longer than 500 characters"}
	}
	if p.Regex {
		pattern := p.Filter
		if !p.CaseSensitive {
			pattern = "(?i)" + pattern
		}
		// Go's regexp is RE2: linear in the input, so a pattern somebody pasted
		// cannot make a scan take forever.
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, &opError{Code: "EPARAM", Message: "Bad regular expression: " + err.Error()}
		}
		return func(r *kgo.Record) bool { return re.Match(r.Key) || re.Match(r.Value) }, nil
	}
	if p.CaseSensitive {
		needle := []byte(p.Filter)
		return func(r *kgo.Record) bool { return contains(r.Key, needle) || contains(r.Value, needle) }, nil
	}
	needle := []rune(strings.ToLower(p.Filter))
	return func(r *kgo.Record) bool { return containsFold(r.Key, needle) || containsFold(r.Value, needle) }, nil
}

func contains(haystack, needle []byte) bool {
	return bytes.Contains(haystack, needle)
}

// containsFold reports whether needle, already lower-cased, occurs in b once b is
// lower-cased — which is what lower-casing a copy of b and searching that copy
// answers, without the copy. A scan may look at 100 000 records, and a copy of
// the key and of the value of each one is hundreds of megabytes of short-lived
// strings for a topic of large values.
//
// The same mapping, rune by rune (unicode.ToLower, which strings.ToLower is built
// on), so the answer cannot differ; an occurrence can only start at a rune boundary.
func containsFold(b []byte, needle []rune) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if unicode.ToLower(r) == needle[0] && matchFoldAt(b[i+size:], needle[1:]) {
			return true
		}
		i += size
	}
	return false
}

// matchFoldAt reports whether rest, lower-cased, begins with want.
func matchFoldAt(rest []byte, want []rune) bool {
	for _, w := range want {
		if len(rest) == 0 {
			return false
		}
		r, size := utf8.DecodeRune(rest)
		if unicode.ToLower(r) != w {
			return false
		}
		rest = rest[size:]
	}
	return true
}

func b64(b []byte) *string {
	s := base64.StdEncoding.EncodeToString(b)
	return &s
}

// toMessage is the wire form of a record. cap is how much of the value goes.
func toMessage(r *kgo.Record, valueCap int) kafkaMessage {
	m := kafkaMessage{
		Partition: r.Partition, Offset: r.Offset, Timestamp: r.Timestamp.UnixMilli(),
		Headers: []messageHeader{}, KeySize: len(r.Key), ValueSize: len(r.Value),
	}
	if r.Key != nil {
		k := r.Key
		if len(k) > maxKeyBytes {
			k = k[:maxKeyBytes]
			m.Truncated = true
		}
		m.Key = b64(k)
	}
	if r.Value != nil {
		v := r.Value
		if len(v) > valueCap {
			v = v[:valueCap]
			m.Truncated = true
		}
		m.Value = b64(v)
	}
	for _, h := range r.Headers {
		mh := messageHeader{Key: h.Key}
		if h.Value != nil {
			v := h.Value
			if len(v) > maxHeaderBytes {
				v = v[:maxHeaderBytes]
			}
			mh.Value = b64(v)
		}
		m.Headers = append(m.Headers, mh)
	}
	return m
}

// plan says, per partition, where to begin and where the snapshot ends.
type plan struct {
	begin map[int32]int64
	stop  map[int32]int64
}

func (t *target) plan(p consumeParams, limit int, filtered bool) (*plan, error) {
	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, ok := details[p.Topic]
	if !ok || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	start, end, err := t.bounds(p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}

	parts := p.Partitions
	if len(parts) == 0 {
		for _, part := range d.Partitions.Sorted() {
			parts = append(parts, part.Partition)
		}
	}
	var after map[int32]int64
	switch p.From {
	case "offset":
		if len(parts) != 1 {
			return nil, &opError{Code: "EPARAM", Message: "Starting from an offset needs exactly one partition"}
		}
		if p.Offset == nil || *p.Offset < 0 {
			return nil, &opError{Code: "EPARAM", Message: "Starting from an offset needs a non-negative offset"}
		}
	case "time":
		if p.Timestamp == nil {
			return nil, &opError{Code: "EPARAM", Message: "Starting from a time needs a timestamp"}
		}
		listed, err := t.adm.ListOffsetsAfterMilli(t.ctx, *p.Timestamp, p.Topic)
		if err != nil && len(listed) == 0 {
			return nil, t.fail(err)
		}
		after = map[int32]int64{}
		for _, part := range parts {
			if o, ok := listed.Lookup(p.Topic, part); ok && o.Err == nil && o.Offset >= 0 {
				after[part] = o.Offset
			}
		}
	case "start", "end":
	default:
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("from is start, end, offset or time — not %q", p.From)}
	}

	for _, part := range parts {
		if _, ok := d.Partitions[part]; !ok {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Topic %s has no partition %d", p.Topic, part)}
		}
	}

	pl := &plan{begin: map[int32]int64{}, stop: map[int32]int64{}}
	// "end" reads a window off the tail: as many as were asked for, or, when a
	// filter will throw most of them away, as many as a scan may look at.
	window := int64(limit)
	if filtered {
		window = max(window, int64(maxScan/len(parts)))
	}
	for _, part := range parts {
		s, sok := start.Lookup(p.Topic, part)
		e, eok := end.Lookup(p.Topic, part)
		if !sok || !eok || s.Err != nil || e.Err != nil {
			continue
		}
		begin := s.Offset
		switch p.From {
		case "offset":
			begin = max(s.Offset, *p.Offset)
		case "time":
			if o, ok := after[part]; ok {
				begin = max(s.Offset, o)
			} else {
				begin = e.Offset
			}
		case "end":
			begin = max(s.Offset, e.Offset-window)
		}
		if begin < e.Offset {
			pl.begin[part], pl.stop[part] = begin, e.Offset
		}
	}
	return pl, nil
}

func messagesConsume(c *opCtx, p consumeParams) (any, error) {
	limit := p.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)
	match, err := makeFilter(p)
	if err != nil {
		return nil, err
	}
	release, ok := c.conn.consumeSlot()
	if !ok {
		return nil, &opError{Code: "EBUSY", Message: fmt.Sprintf("Already reading %d topics on this connection — stop one first", maxConsumes)}
	}
	defer release()

	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	pl, err := t.plan(p, limit, p.Filter != "")
	if err != nil {
		return nil, err
	}
	res := &consumeResult{Stopped: "end"}
	if len(pl.begin) == 0 {
		return res, nil
	}

	begin := map[string]map[int32]kgo.Offset{p.Topic: {}}
	for part, off := range pl.begin {
		begin[p.Topic][part] = kgo.NewOffset().At(off)
	}
	kc, err := t.reader(begin)
	if err != nil {
		return nil, err
	}
	defer kc.Close()

	newest := p.From == "end"
	// newest-first cannot send anything until the window is read, so the window
	// is what holds memory here; a forward read streams instead.
	var windowed window
	var batch []kafkaMessage
	batchBytes := 0
	sent := 0
	flush := func() {
		if len(batch) > 0 {
			c.chunk(messageBatch{Messages: batch})
			batch, batchBytes = nil, 0
		}
	}
	// A frame goes out when the next message would make it full by count or by
	// size, whichever comes first. Nothing is dropped here: a consume has an end
	// to reach and the frames simply come smaller.
	add := func(m kafkaMessage) {
		n := frameBytes(m)
		if len(batch) > 0 && (len(batch) >= batchSize || batchBytes+n > maxFrameBytes) {
			flush()
		}
		batch = append(batch, m)
		batchBytes += n
		sent++
	}

	remaining := map[int32]int64{}
	for part, stop := range pl.stop {
		remaining[part] = stop
	}

read:
	for len(remaining) > 0 {
		poll, cancel := context.WithTimeout(c.ctx, idleTimeout)
		fetches := kc.PollFetches(poll)
		cancel()
		if err := c.ctx.Err(); err != nil {
			return nil, err
		}
		if fetches.IsClientClosed() {
			break
		}
		for _, fe := range fetches.Errors() {
			if errors.Is(fe.Err, context.DeadlineExceeded) {
				res.Stopped = "idle"
				break read
			}
			return nil, t.fail(fe.Err)
		}

		var stopReason string
		fetches.EachRecord(func(r *kgo.Record) {
			if stopReason != "" {
				return
			}
			stop, live := remaining[r.Partition]
			if !live {
				return
			}
			if r.Offset >= stop {
				delete(remaining, r.Partition)
				return
			}
			res.Scanned++
			if match(r) {
				if newest {
					windowed.add(toMessage(r, maxValueBytes))
				} else {
					add(toMessage(r, maxValueBytes))
					if sent >= limit {
						stopReason = "limit"
						return
					}
				}
			}
			if r.Offset >= stop-1 {
				delete(remaining, r.Partition)
			}
			if res.Scanned >= maxScan {
				stopReason = "scan-limit"
			}
		})
		if stopReason != "" {
			res.Stopped = stopReason
			break
		}
	}

	if newest {
		kept := windowed.messages
		sort.Slice(kept, func(i, j int) bool { return newestFirst(kept[i], kept[j]) })
		// The window drops the oldest, so when it still holds the limit, the newest
		// `limit` matches are all in it: what it dropped, the limit would have cut
		// anyway, and there is nothing to own up to.
		short := len(kept) < limit
		if len(kept) > limit {
			kept = kept[:limit]
			if res.Stopped == "end" {
				res.Stopped = "limit"
			}
		}
		for _, m := range kept {
			add(m)
		}
		// The window dropped matches to stay inside its budget and the answer is
		// short for it: saying so is the difference between "that is all there
		// is" and "that is all this viewer holds".
		if windowed.skipped > 0 && short {
			res.Skipped = windowed.skipped
			if res.Stopped == "end" || res.Stopped == "limit" {
				res.Stopped = "window"
			}
		}
	}
	flush()
	res.Matched = sent
	return res, nil
}

func messagesGet(c *opCtx, p getMessageParams) (any, error) {
	release, ok := c.conn.consumeSlot()
	if !ok {
		return nil, &opError{Code: "EBUSY", Message: fmt.Sprintf("Already reading %d topics on this connection — stop one first", maxConsumes)}
	}
	defer release()

	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	start, end, err := t.bounds(p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	s, sok := start.Lookup(p.Topic, p.Partition)
	e, eok := end.Lookup(p.Topic, p.Partition)
	if !sok || !eok || s.Err != nil || e.Err != nil {
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("No partition %d in topic %s", p.Partition, p.Topic)}
	}
	if p.Offset < s.Offset || p.Offset >= e.Offset {
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("Offset %d is outside what partition %d holds (%d–%d)", p.Offset, p.Partition, s.Offset, e.Offset-1)}
	}

	kc, err := t.reader(map[string]map[int32]kgo.Offset{p.Topic: {p.Partition: kgo.NewOffset().At(p.Offset)}})
	if err != nil {
		return nil, err
	}
	defer kc.Close()

	for {
		poll, cancel := context.WithTimeout(c.ctx, idleTimeout)
		fetches := kc.PollFetches(poll)
		cancel()
		if err := c.ctx.Err(); err != nil {
			return nil, err
		}
		for _, fe := range fetches.Errors() {
			if errors.Is(fe.Err, context.DeadlineExceeded) {
				return nil, &opError{Code: "EKAFKA", Message: "The cluster did not deliver that message"}
			}
			return nil, t.fail(fe.Err)
		}
		var got *kgo.Record
		fetches.EachRecord(func(r *kgo.Record) {
			if got == nil && r.Partition == p.Partition && r.Offset >= p.Offset {
				got = r
			}
		})
		if got != nil {
			if got.Offset != p.Offset {
				// A compacted-away offset: what comes next is not what was asked for.
				return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("Offset %d is no longer there (compacted) — the next is %d", p.Offset, got.Offset)}
			}
			return toMessage(got, maxGetBytes), nil
		}
		if fetches.IsClientClosed() {
			return nil, &opError{Code: "EKAFKA", Message: "The connection to the cluster closed"}
		}
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// ── messages.tail ─────────────────────────────────────────────────────────

const (
	// A tail sends what has arrived at most this often, however fast it arrives:
	// a page repaints a list, and two hundred milliseconds is what a person reads
	// as "as it happens".
	tailWindow = 200 * time.Millisecond
	// The most one stretch carries. A topic that outruns the page is shown by its
	// newest messages, and the batch says how many were dropped — it is never
	// slowed down to fit, and never silently thinned.
	tailMaxPerWindow = 500
)

// stretch is the window a tail is filling: the messages that go out in the next
// frame, and how many were dropped to keep it inside its bounds.
//
// Both bounds matter. The count alone said nothing about size, because a value
// may be 256 KiB and base64 makes it 341 KiB: five hundred of those was a single
// frame of about 160 MB for the page to parse in its main thread.
type stretch struct {
	messages []kafkaMessage
	bytes    int
	skipped  int
}

// add puts a message in the window, dropping the oldest until it fits.
//
// One message is never dropped for being large: the per-value and per-key caps
// keep a single message an order of magnitude below the frame bound.
func (s *stretch) add(m kafkaMessage) {
	n := frameBytes(m)
	for len(s.messages) > 0 && (len(s.messages) >= tailMaxPerWindow || s.bytes+n > maxFrameBytes) {
		s.bytes -= frameBytes(s.messages[0])
		s.messages = s.messages[1:]
		s.skipped++
	}
	s.messages = append(s.messages, m)
	s.bytes += n
}

// take hands over the window and empties it.
func (s *stretch) take() (messages []kafkaMessage, skipped int) {
	if len(s.messages) == 0 && s.skipped == 0 {
		return nil, 0
	}
	messages, skipped = s.messages, s.skipped
	s.messages, s.bytes, s.skipped = nil, 0, 0
	return messages, skipped
}

// messagesTail follows a topic from where it ends now, until it is cancelled.
//
// Like a consume it joins no consumer group and commits nothing. Unlike one it
// has no end to reach, so it is bounded three other ways: it holds a consume
// slot for as long as it runs, it sends at most tailMaxPerWindow messages and
// maxFrameBytes bytes per tailWindow, and the connection cancelling it — the
// page closing, the user leaving the tab — is the normal way for it to stop.
func messagesTail(c *opCtx, p tailParams) (any, error) {
	match, err := makeFilter(consumeParams{Filter: p.Filter, Regex: p.Regex, CaseSensitive: p.CaseSensitive})
	if err != nil {
		return nil, err
	}
	release, ok := c.conn.consumeSlot()
	if !ok {
		return nil, &opError{Code: "EBUSY", Message: fmt.Sprintf("Already reading %d topics on this connection — stop one first", maxConsumes)}
	}
	defer release()

	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, found := details[p.Topic]
	if !found || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	parts := p.Partitions
	if len(parts) == 0 {
		for _, part := range d.Partitions.Sorted() {
			parts = append(parts, part.Partition)
		}
	}
	begin := map[string]map[int32]kgo.Offset{p.Topic: {}}
	for _, part := range parts {
		if _, ok := d.Partitions[part]; !ok {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Topic %s has no partition %d", p.Topic, part)}
		}
		begin[p.Topic][part] = kgo.NewOffset().AtEnd()
	}

	kc, err := t.reader(begin)
	if err != nil {
		return nil, err
	}
	defer kc.Close()
	// The setup above was bounded like any admin request; the tail itself is not.
	t.done()

	res := &tailResult{}
	var window stretch
	flush := func() {
		messages, skipped := window.take()
		if messages == nil && skipped == 0 {
			return
		}
		c.chunk(messageBatch{Messages: messages, Skipped: skipped})
		res.Received += len(messages)
	}

	last := time.Now()
	for {
		poll, cancel := context.WithTimeout(c.ctx, tailWindow)
		fetches := kc.PollFetches(poll)
		cancel()
		if err := c.ctx.Err(); err != nil {
			flush() // what arrived in the last moments is not lost to the stop
			return nil, err
		}
		if fetches.IsClientClosed() {
			flush()
			return res, nil
		}
		for _, fe := range fetches.Errors() {
			if errors.Is(fe.Err, context.DeadlineExceeded) {
				continue // nothing in this window: the ordinary case on a quiet topic
			}
			flush()
			return nil, t.fail(fe.Err)
		}
		fetches.EachRecord(func(r *kgo.Record) {
			if !match(r) {
				return
			}
			window.add(toMessage(r, maxValueBytes))
		})
		if time.Since(last) >= tailWindow {
			flush()
			last = time.Now()
		}
	}
}
