package ledger

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/getkimchi/kimchi-adapters/protocol"
)

func fixture() protocol.Event {
	id := protocol.NewID()
	return protocol.Event{ID: id, EntityID: id, Revision: 1, Source: "codex", SourceVersion: "test", DeviceID: protocol.NewID(), ObservedAt: time.Now().UTC(), Coverage: &protocol.Coverage{Code: "test", Count: 1}}
}

func TestDeltasAreBoundedAndOnlyChangedEntitiesReturn(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var first protocol.Event
	for i := 0; i < 235; i++ {
		e := fixture()
		if i == 0 {
			first = e
		}
		if err = s.Observe(e); err != nil {
			t.Fatal(err)
		}
	}
	var counts []int
	for {
		b, err := s.PendingBatch(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if b == nil {
			break
		}
		raw, _ := json.Marshal(b)
		if len(raw) > 1<<20+4096 || len(b.Events) > 100 {
			t.Fatal("unbounded batch", len(raw), len(b.Events))
		}
		replay, _ := s.PendingBatch(t.Context())
		if protocol.Hash(b) != protocol.Hash(replay) {
			t.Fatal("lost ACK changed delta")
		}
		counts = append(counts, len(b.Events))
		ack := protocol.Acknowledgement{BatchID: b.ID}
		for _, e := range b.Events {
			ack.Receipts = append(ack.Receipts, protocol.Receipt{ID: e.ID, Revision: e.Revision, Status: "accepted"})
		}
		if err = s.Acknowledge(*b, ack); err != nil {
			t.Fatal(err)
		}
		if err = s.Acknowledge(*b, ack); err != nil {
			t.Fatal(err)
		}
	}
	if protocol.Hash(counts) != protocol.Hash([]int{100, 100, 35}) {
		t.Fatal(counts)
	}
	if err = s.Observe(first); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.PendingBatch(t.Context()); b != nil {
		t.Fatal("unchanged entity uploaded again")
	}
	first.Coverage = &protocol.Coverage{Code: "test", Count: 2}
	if err = s.Observe(first); err != nil {
		t.Fatal(err)
	}
	b, _ := s.PendingBatch(t.Context())
	if b == nil || len(b.Events) != 1 || b.Events[0].Revision != 2 || b.Events[0].BaseRevision != 1 {
		t.Fatal(b)
	}
	var pending, total, actual int64
	if err = s.DB.QueryRow(`SELECT pending_bytes,total_bytes FROM ledger_totals WHERE id=1`).Scan(&pending, &total); err != nil {
		t.Fatal(err)
	}
	if err = s.DB.QueryRow(`SELECT SUM(length(body)) FROM events`).Scan(&actual); err != nil || actual != total {
		t.Fatal(total, actual, err)
	}
	raw, _ := json.Marshal(b.Events[0])
	if pending != int64(len(raw)) {
		t.Fatal(pending, len(raw))
	}
}

func TestOutboxSurvivesLostAcknowledgement(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := fixture()
	if err = s.Put(e); err != nil {
		t.Fatal(err)
	}
	b, err := s.PendingBatch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	replay, err := s.PendingBatch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if protocol.Hash(b) != protocol.Hash(replay) {
		t.Fatal("lost ACK changed delivery")
	}
	if err = s.Acknowledge(*replay, protocol.Acknowledgement{BatchID: b.ID}); err == nil {
		t.Fatal("partial ACK discarded records")
	}
	ack := protocol.Acknowledgement{BatchID: b.ID, Receipts: []protocol.Receipt{{ID: e.ID, Revision: 1, Status: "accepted"}}}
	if err = s.Acknowledge(*b, ack); err != nil {
		t.Fatal(err)
	}
	pending, err := s.PendingBatch(context.Background())
	if err != nil || pending != nil {
		t.Fatal(pending, err)
	}
	if err = s.Put(e); err != nil {
		t.Fatal(err)
	}
	e.Coverage.Count = 2
	if err = s.Put(e); err != ErrConflict {
		t.Fatal("changed content was silently accepted", err)
	}
}
