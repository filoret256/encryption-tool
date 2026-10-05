package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// A message whose value is the cap the agent sends: 256 KiB, which base64 turns
// into about 341 KiB on the wire.
func bigMessage(fill byte) kafkaMessage {
	v := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{fill}, maxValueBytes))
	return kafkaMessage{Value: &v}
}

// wireBytes is what a batch actually carries in base64, which is what the page
// has to hold and parse.
func wireBytes(messages []map[string]any) int {
	n := 0
	for _, m := range messages {
		if v, ok := m["value"].(string); ok {
			n += len(v)
		}
		if k, ok := m["key"].(string); ok {
			n += len(k)
		}
	}
	return n
}

// The count cap says nothing about size: 500 values of 256 KiB were one frame of
// about 160 MB, parsed by the page's main thread in a single JSON.parse.
func TestStretchDropsTheOldestUntilOneMoreFits(t *testing.T) {
	var s stretch
	for i := 0; i < 20; i++ {
		s.add(bigMessage(byte('a' + i%26)))
	}
	if s.bytes > maxFrameBytes {
		t.Fatalf("the window holds %d bytes, over the %d limit", s.bytes, maxFrameBytes)
	}
	if len(s.messages) >= 20 {
		t.Fatalf("the window kept all %d messages", len(s.messages))
	}
	if s.skipped != 20-len(s.messages) {
		t.Errorf("%d kept and %d skipped out of 20", len(s.messages), s.skipped)
	}
	// The newest is always the one kept: a topic that outruns the page is shown
	// by what was written last.
	last := s.messages[len(s.messages)-1].Value
	if want := bigMessage(byte('a' + 19%26)).Value; last == nil || *last != *want {
		t.Errorf("the last message in the window is not the newest one")
	}

	messages, skipped := s.take()
	if len(messages)+skipped != 20 {
		t.Errorf("take gave %d messages and %d skipped out of 20", len(messages), skipped)
	}
	if s.messages != nil || s.bytes != 0 || s.skipped != 0 {
		t.Errorf("take left the window holding %d messages and %d bytes", len(s.messages), s.bytes)
	}
	if more, extra := s.take(); more != nil || extra != 0 {
		t.Errorf("an emptied window still handed over %d messages", len(more))
	}
}

// The count bound is still the one that applies when the values are small.
func TestStretchStillCountsSmallMessages(t *testing.T) {
	var s stretch
	for i := 0; i < tailMaxPerWindow+3; i++ {
		s.add(kafkaMessage{})
	}
	if len(s.messages) != tailMaxPerWindow {
		t.Errorf("the window holds %d small messages, want %d", len(s.messages), tailMaxPerWindow)
	}
	if s.skipped != 3 {
		t.Errorf("%d small messages were dropped, want 3", s.skipped)
	}
}

// And on the wire: a tail of large values leaves in frames that are inside the
// byte bound, with everything that did not fit accounted for as skipped.
func TestATailOfLargeValuesSendsBoundedFrames(t *testing.T) {
	r := newRig(t)
	id := r.next
	r.next++
	r.s.dispatch(r.conn, request(id, "messages.tail", map[string]any{"cluster": "dev", "topic": "logs"}))
	time.Sleep(600 * time.Millisecond)

	const produced = 40
	value := bytes.Repeat([]byte("V"), maxValueBytes)
	var recs []*kgo.Record
	for i := 0; i < produced; i++ {
		head := []byte(fmt.Sprintf("big-%04d-", i))
		recs = append(recs, &kgo.Record{Topic: "logs", Value: append(head, value[len(head):]...)})
	}
	r.produce(recs...)

	delivered, skipped, frames := 0, 0, 0
	deadline := time.After(15 * time.Second)
	for delivered+skipped < produced {
		select {
		case m := <-r.fr:
			if id2, _ := m["id"].(float64); int64(id2) != id {
				continue
			}
			c, ok := m["chunk"].(map[string]any)
			if !ok {
				continue
			}
			frames++
			msgs := c["messages"].([]any)
			flat := make([]map[string]any, 0, len(msgs))
			for _, msg := range msgs {
				flat = append(flat, msg.(map[string]any))
			}
			if n := wireBytes(flat); n > maxFrameBytes {
				t.Fatalf("frame %d carries %d bytes of base64, over the %d limit", frames, n, maxFrameBytes)
			}
			delivered += len(msgs)
			skipped += int(c["skipped"].(float64))
		case <-deadline:
			t.Fatalf("saw %d delivered and %d skipped of %d", delivered, skipped, produced)
		}
	}
	if delivered+skipped != produced {
		t.Errorf("%d delivered + %d skipped is not %d", delivered, skipped, produced)
	}
	// The count cap alone would have carried all forty in one stretch, so the
	// frame is only this small because the byte bound acted.
	if frames == 1 && skipped == 0 {
		t.Errorf("%d values of 256 KiB left in one frame and nothing was dropped", produced)
	}
	r.s.dispatch(r.conn, request(r.next, "cancel", map[string]any{"target": id}))
	r.next++
}

// A consume is bounded the same way: nothing is dropped, the frames just come
// smaller.
func TestAConsumeOfLargeValuesSendsBoundedFrames(t *testing.T) {
	r := newRig(t)
	const produced = 40
	var recs []*kgo.Record
	for i := 0; i < produced; i++ {
		recs = append(recs, &kgo.Record{Topic: "logs", Value: bytes.Repeat([]byte{'V'}, maxValueBytes)})
	}
	r.produce(recs...)

	chunks, reply := r.call("messages.consume", map[string]any{"topic": "logs", "from": "start", "limit": produced})
	if reply["ok"] != true {
		t.Fatalf("messages.consume: %v", reply)
	}
	got := 0
	for i, c := range chunks {
		flat := make([]map[string]any, 0, len(c["messages"].([]any)))
		for _, msg := range c["messages"].([]any) {
			flat = append(flat, msg.(map[string]any))
		}
		if n := wireBytes(flat); n > maxFrameBytes {
			t.Fatalf("frame %d carries %d bytes of base64, over the %d limit", i, n, maxFrameBytes)
		}
		got += len(flat)
	}
	if got != produced {
		t.Errorf("%d messages streamed, want %d", got, produced)
	}
	if len(chunks) < 2 {
		t.Errorf("%d messages of 256 KiB left in %d frame(s) — the byte bound did not split them", produced, len(chunks))
	}
}

// The frame estimate must not understate a message it is bounding, or the bound
// would let a frame past it. It is compared against what the message really
// weighs once marshalled.
func TestFrameBytesDoesNotUnderstateAMessage(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("k"), maxKeyBytes))
	hdr := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("h"), maxHeaderBytes))
	m := bigMessage('v')
	m.Key = &key
	m.Headers = []messageHeader{{Key: "one", Value: &hdr}, {Key: "two"}}
	if got, want := frameBytes(m), len(key)+len(*m.Value)+len(hdr); got < want {
		t.Errorf("frameBytes says %d for a message of %d base64 characters", got, want)
	}
}

// The window a `from: end` read fills before it can sort is bounded by bytes as
// well as by the scan ceiling: 100,000 records of 256 KiB is tens of gigabytes.
func TestTheNewestWindowIsBoundedByBytes(t *testing.T) {
	var w window
	// 200 values at the cap: about 68 MB of base64 for a 32 MiB budget.
	for i := 0; i < 200; i++ {
		m := bigMessage(byte('a' + i%26))
		m.Offset = int64(i)
		w.add(m)
	}
	if w.bytes > maxWindowBytes {
		t.Fatalf("the window holds %d bytes, over the %d limit", w.bytes, maxWindowBytes)
	}
	if len(w.messages) >= 200 {
		t.Fatalf("the window kept all %d messages", len(w.messages))
	}
	if w.skipped != 200-len(w.messages) {
		t.Errorf("%d kept and %d skipped out of 200", len(w.messages), w.skipped)
	}
	// The oldest went: a viewer asking a topic's tail for messages wants the
	// newest of what it matched.
	oldest := int64(200 - len(w.messages))
	for _, m := range w.messages {
		if m.Offset < oldest {
			t.Fatalf("offset %d is in the window, and only %d and later should be", m.Offset, oldest)
		}
	}
}

// Partitions are fetched side by side, so the newest messages of a topic can
// arrive first and the older ones of another partition after them. The window
// drops by time, not by arrival: what it keeps is the newest of the topic.
func TestTheNewestWindowDropsByTimeNotByArrival(t *testing.T) {
	var w window
	// Partition 1 arrives first, and it holds the newest messages.
	for i := 0; i < 40; i++ {
		m := bigMessage('n')
		m.Partition, m.Offset, m.Timestamp = 1, int64(i), int64(10_000+i)
		w.add(m)
	}
	// Partition 0 arrives after it with older ones, and overflows the budget.
	for i := 0; i < 160; i++ {
		m := bigMessage('o')
		m.Partition, m.Offset, m.Timestamp = 0, int64(i), int64(i)
		w.add(m)
	}
	if w.skipped == 0 {
		t.Fatal("the window dropped nothing; the test needs it full")
	}
	newest := 0
	for _, m := range w.messages {
		if m.Partition == 1 {
			newest++
		}
	}
	if newest != 40 {
		t.Errorf("%d of the 40 newest messages are in the window: the window dropped by arrival", newest)
	}
}

// When the window still holds the limit, the newest `limit` are all there: the
// answer is not short, and it says it stopped at the limit, not at the window.
func TestAConsumeFromTheEndThatFillsItsLimitDoesNotBlameTheWindow(t *testing.T) {
	r := newRig(t)
	const produced = 200
	var recs []*kgo.Record
	for i := 0; i < produced; i++ {
		recs = append(recs, &kgo.Record{Topic: "logs", Value: bytes.Repeat([]byte{'V'}, maxValueBytes)})
	}
	for i := 0; i < produced; i += 25 {
		r.produce(recs[i:min(i+25, produced)]...)
	}
	// A filter, so the read scans the whole topic and the window overflows.
	_, reply := r.call("messages.consume", map[string]any{"topic": "logs", "from": "end", "limit": 10, "filter": "VVV"})
	if reply["ok"] != true {
		t.Fatalf("messages.consume: %v", reply)
	}
	data := reply["data"].(map[string]any)
	if data["stopped"] != "limit" {
		t.Errorf("stopped = %v, want limit", data["stopped"])
	}
	if data["skipped"].(float64) != 0 {
		t.Errorf("skipped = %v, want 0: nothing the reader asked for was dropped", data["skipped"])
	}
	if data["matched"].(float64) != 10 {
		t.Errorf("matched = %v, want 10", data["matched"])
	}
}

// And end to end: `from: end` on a topic of large values comes back short, says
// why, and says how many it dropped.
func TestAConsumeFromTheEndOfLargeValuesStaysInsideItsWindow(t *testing.T) {
	r := newRig(t)
	const produced = 200
	var recs []*kgo.Record
	for i := 0; i < produced; i++ {
		recs = append(recs, &kgo.Record{Topic: "logs", Value: bytes.Repeat([]byte{'V'}, maxValueBytes)})
	}
	// In batches: 200 values of 256 KiB is one 50 MB request, which the broker
	// refuses before the read under test even begins.
	for i := 0; i < produced; i += 25 {
		r.produce(recs[i:min(i+25, produced)]...)
	}

	// A filter, so the window is the scan ceiling rather than the limit: this is
	// the read the finding is about.
	chunks, reply := r.call("messages.consume", map[string]any{"topic": "logs", "from": "end", "limit": 1000, "filter": "VVV"})
	if reply["ok"] != true {
		t.Fatalf("messages.consume: %v", reply)
	}
	data := reply["data"].(map[string]any)
	matched := int(data["matched"].(float64))
	skipped := int(data["skipped"].(float64))
	if data["stopped"] != "window" {
		t.Errorf("stopped = %v, want window", data["stopped"])
	}
	if skipped == 0 || matched+skipped != produced {
		t.Errorf("%d delivered + %d skipped is not %d", matched, skipped, produced)
	}
	got := 0
	for i, c := range chunks {
		flat := make([]map[string]any, 0, len(c["messages"].([]any)))
		for _, msg := range c["messages"].([]any) {
			flat = append(flat, msg.(map[string]any))
		}
		if n := wireBytes(flat); n > maxFrameBytes {
			t.Fatalf("frame %d carries %d bytes of base64, over the %d limit", i, n, maxFrameBytes)
		}
		got += len(flat)
	}
	if got != matched {
		t.Errorf("%d messages streamed, %d reported", got, matched)
	}
	if matched >= produced {
		t.Errorf("the window kept everything: %d of %d", matched, produced)
	}
}

// A forward read has no window — it streams — so it drops nothing and holds
// nothing.
func TestAForwardConsumeReportsNoWindow(t *testing.T) {
	r := newRig(t)
	r.produce(&kgo.Record{Topic: "logs", Value: []byte("one")})
	_, reply := r.call("messages.consume", map[string]any{"topic": "logs", "from": "start"})
	data := reply["data"].(map[string]any)
	if data["skipped"].(float64) != 0 {
		t.Errorf("a forward read skipped %v messages", data["skipped"])
	}
	if data["stopped"] == "window" {
		t.Errorf("a forward read reports a window it does not have: %v", data["stopped"])
	}
}
