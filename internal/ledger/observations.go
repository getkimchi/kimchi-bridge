package ledger

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/getkimchi/kimchi-adapters/protocol"
)

// Observe replaces one logical observation by a revision, never by a second charge.
// The caller supplies a stable entity identity from the native source.
func (s *Store) Observe(e protocol.Event) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var body []byte
	err = tx.QueryRow(`SELECT body FROM events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1`, e.EntityID).Scan(&body)
	e.Revision = 1
	e.BaseRevision = 0
	e.BaseHash = ""
	if err == nil {
		var old protocol.Event
		if err = json.Unmarshal(body, &old); err != nil {
			return err
		}
		a, b := old, e
		a.ID = ""
		b.ID = ""
		a.Revision = 0
		b.Revision = 0
		a.BaseRevision = 0
		b.BaseRevision = 0
		a.BaseHash = ""
		b.BaseHash = ""
		a.ObservedAt = time.Time{}
		b.ObservedAt = time.Time{}
		if protocol.Hash(a) == protocol.Hash(b) {
			return tx.Commit()
		}
		e.Revision = old.Revision + 1
		e.BaseRevision = old.Revision
		e.BaseHash = protocol.Hash(old)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	e.ID = protocol.StableID(e.EntityID, protocol.Hash(e))
	if err = e.Validate(); err != nil {
		return err
	}
	body, err = json.Marshal(e)
	if err != nil {
		return err
	}
	var size int64
	if err = tx.QueryRow(`SELECT total_bytes FROM ledger_totals WHERE id=1`).Scan(&size); err != nil {
		return err
	}
	if size+int64(len(body)) > 1<<30 {
		return errors.New("local accounting capacity exceeded; export records before cleanup")
	}
	_, err = tx.Exec(`INSERT INTO events(id,entity_id,kind,body,hash,created_at) VALUES(?,?,?,?,?,?)`, e.ID, e.EntityID, e.Kind(), body, protocol.Hash(e), time.Now().Unix())
	if err != nil {
		return err
	}
	return tx.Commit()
}
