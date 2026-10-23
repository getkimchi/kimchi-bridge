package ledger

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/getkimchi/kimchi-adapters/protocol"
)

// A size refusal can be retried under new batch IDs without changing any event
// ID or revision. Even a lost ACK from the original batch cannot double-charge.
func (s *Store) SplitBatch(b protocol.Batch) error {
	if len(b.Events) < 2 {
		return errors.New("one record exceeds the reporting payload limit; record retained")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var old []byte
	if err = tx.QueryRow(`SELECT body FROM batches WHERE id=?`, b.ID).Scan(&old); err != nil {
		return err
	}
	var stored protocol.Batch
	if err = json.Unmarshal(old, &stored); err != nil {
		return err
	}
	if protocol.Hash(stored) != protocol.Hash(b) {
		return ErrConflict
	}
	var order string
	if err = tx.QueryRow(`SELECT COALESCE((SELECT order_key FROM batch_order WHERE batch_id=batches.id),'') FROM batches WHERE id=?`, b.ID).Scan(&order); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM batches WHERE id=?`, b.ID); err != nil {
		return err
	}
	mid := len(b.Events) / 2
	for i, events := range [][]protocol.Event{b.Events[:mid], b.Events[mid:]} {
		part := protocol.Batch{Version: b.Version, ID: protocol.NewID(), Events: events}
		body, err := json.Marshal(part)
		if err != nil {
			return err
		}
		ids := make([]string, 0, len(events))
		for _, e := range events {
			ids = append(ids, e.ID)
		}
		encoded, err := json.Marshal(ids)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(`INSERT INTO batches(id,body,event_ids,created_at) VALUES(?,?,?,?)`, part.ID, body, encoded, time.Now().Unix()); err != nil {
			return err
		}
		// Prefix order keeps recursive splits before their untouched siblings.
		if _, err = tx.Exec(`INSERT INTO batch_order(batch_id,order_key) VALUES(?,?)`, part.ID, order+strconv.Itoa(i)); err != nil {
			return err
		}
	}
	limit := max(16<<10, len(old)/2)
	_, err = tx.Exec(`INSERT INTO meta(key,value) VALUES('upload-batch-bytes',?) ON CONFLICT(key) DO UPDATE SET value=MIN(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))`, limit)
	if err != nil {
		return err
	}
	return tx.Commit()
}
