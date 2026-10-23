package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/getkimchi/kimchi-adapters/protocol"
	_ "modernc.org/sqlite"
)

var ErrConflict = errors.New("event identity conflicts with persisted content")

type Store struct {
	DB  *sql.DB
	Dir string
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "ledger.sqlite")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	f.Close()
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: "_pragma=busy_timeout(2000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_txlock=immediate"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db, Dir: dir}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,kind TEXT NOT NULL,body BLOB NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL,acked_at INTEGER,blocked TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS pending_events ON events(acked_at,created_at);
CREATE INDEX IF NOT EXISTS entity_events ON events(entity_id);
CREATE TABLE IF NOT EXISTS export_receipts(target TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(target,event_id));
CREATE TABLE IF NOT EXISTS ledger_totals(id INTEGER PRIMARY KEY CHECK(id=1),total_bytes INTEGER NOT NULL,pending_bytes INTEGER NOT NULL);
INSERT OR IGNORE INTO ledger_totals SELECT 1,(SELECT COALESCE(SUM(length(body)),0) FROM events),(SELECT COALESCE(SUM(length(body)),0) FROM events WHERE acked_at IS NULL) WHERE NOT EXISTS(SELECT 1 FROM ledger_totals WHERE id=1);
CREATE TRIGGER IF NOT EXISTS event_size_insert AFTER INSERT ON events BEGIN UPDATE ledger_totals SET total_bytes=total_bytes+length(new.body),pending_bytes=pending_bytes+CASE WHEN new.acked_at IS NULL THEN length(new.body) ELSE 0 END WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS event_size_ack AFTER UPDATE OF acked_at ON events WHEN old.acked_at IS NULL AND new.acked_at IS NOT NULL BEGIN UPDATE ledger_totals SET pending_bytes=pending_bytes-length(new.body) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS event_size_delete AFTER DELETE ON events BEGIN UPDATE ledger_totals SET total_bytes=total_bytes-length(old.body),pending_bytes=pending_bytes-CASE WHEN old.acked_at IS NULL THEN length(old.body) ELSE 0 END WHERE id=1; DELETE FROM export_receipts WHERE event_id=old.id; END;
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,body BLOB NOT NULL,event_ids BLOB NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS batch_order(batch_id TEXT PRIMARY KEY,order_key TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS batch_order_delete AFTER DELETE ON batches BEGIN DELETE FROM batch_order WHERE batch_id=old.id; END;
CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,repository TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bindings(source TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '',work_id TEXT NOT NULL,repository TEXT NOT NULL,PRIMARY KEY(source,session_id,turn_id,agent_id));
CREATE TABLE IF NOT EXISTS plans(repository TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,work_id TEXT NOT NULL,plan_id TEXT NOT NULL,revision_id TEXT NOT NULL,PRIMARY KEY(repository,path,hash,work_id));
CREATE TABLE IF NOT EXISTS tool_state(source TEXT NOT NULL,session_id TEXT NOT NULL,call_id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(source,session_id,call_id));
CREATE TABLE IF NOT EXISTS file_identity(repository TEXT NOT NULL,path TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(repository,path));
CREATE TABLE IF NOT EXISTS file_revisions(repository TEXT NOT NULL,file_id TEXT NOT NULL,hash TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(repository,file_id,hash));
CREATE TABLE IF NOT EXISTS file_changes(id TEXT PRIMARY KEY,repository TEXT NOT NULL,path TEXT NOT NULL,before_hash TEXT,after_hash TEXT,work_id TEXT,quality TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commits(repository TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(repository,id));
CREATE TABLE IF NOT EXISTS cursors(path TEXT PRIMARY KEY,offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS diagnostics(code TEXT PRIMARY KEY,count INTEGER NOT NULL,updated_at INTEGER NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }

func (s *Store) DeviceID() (string, error) {
	id := protocol.NewID()
	if _, err := s.DB.Exec(`INSERT OR IGNORE INTO meta(key,value) VALUES('device',?)`, id); err != nil {
		return "", err
	}
	err := s.DB.QueryRow(`SELECT value FROM meta WHERE key='device'`).Scan(&id)
	return id, err
}

func (s *Store) Put(e protocol.Event) error {
	if err := e.Validate(); err != nil {
		return err
	}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	hash := protocol.Hash(e)
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var old string
	err = tx.QueryRow(`SELECT hash FROM events WHERE id=?`, e.ID).Scan(&old)
	if err == nil {
		if old != hash {
			return ErrConflict
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var size int64
	if err = tx.QueryRow(`SELECT total_bytes FROM ledger_totals WHERE id=1`).Scan(&size); err != nil {
		return err
	}
	if size+int64(len(b)) > 1<<30 {
		return errors.New("local accounting capacity exceeded; export records before cleanup")
	}
	_, err = tx.Exec(`INSERT INTO events(id,entity_id,kind,body,hash,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, e.ID, e.EntityID, e.Kind(), b, hash, time.Now().Unix())
	if err != nil {
		return err
	}
	if err = tx.QueryRow(`SELECT hash FROM events WHERE id=?`, e.ID).Scan(&old); err != nil {
		return err
	}
	if old != hash {
		return ErrConflict
	}
	return tx.Commit()
}

// PendingBatch is persisted before delivery. A lost acknowledgement replays the
// identical bytes and batch identity, including across collector restarts.
func (s *Store) PendingBatch(ctx context.Context) (*protocol.Batch, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var data []byte
	err = tx.QueryRow(`SELECT b.body FROM batches b LEFT JOIN batch_order o ON o.batch_id=b.id ORDER BY COALESCE(o.order_key,''),b.created_at,b.rowid LIMIT 1`).Scan(&data)
	if err == nil {
		var b protocol.Batch
		if err = json.Unmarshal(data, &b); err != nil {
			return nil, err
		}
		return &b, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	rows, err := tx.Query(`SELECT body FROM events WHERE acked_at IS NULL AND blocked='' ORDER BY created_at,rowid LIMIT 100`)
	if err != nil {
		return nil, err
	}
	b := protocol.Batch{Version: protocol.Version, ID: protocol.NewID()}
	ids := []string{}
	size := 0
	limit := 1 << 20
	var smaller int
	if tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='upload-batch-bytes'`).Scan(&smaller) == nil && smaller >= 16<<10 && smaller < limit {
		limit = smaller
	}
	for rows.Next() {
		var body []byte
		if err = rows.Scan(&body); err != nil {
			rows.Close()
			return nil, err
		}
		if size+len(body) > limit && len(b.Events) > 0 {
			break
		}
		var e protocol.Event
		if err = json.Unmarshal(body, &e); err != nil {
			rows.Close()
			return nil, err
		}
		b.Events = append(b.Events, e)
		ids = append(ids, e.ID)
		size += len(body)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(b.Events) == 0 {
		return nil, nil
	}
	data, _ = json.Marshal(b)
	encodedIDs, _ := json.Marshal(ids)
	if _, err = tx.Exec(`INSERT INTO batches(id,body,event_ids,created_at) VALUES(?,?,?,?)`, b.ID, data, encodedIDs, time.Now().Unix()); err != nil {
		return nil, err
	}
	return &b, tx.Commit()
}

func (s *Store) Acknowledge(b protocol.Batch, ack protocol.Acknowledgement) error {
	if ack.BatchID != b.ID || len(ack.Receipts) != len(b.Events) {
		return errors.New("incomplete batch acknowledgement")
	}
	want := map[string]int64{}
	for _, e := range b.Events {
		want[e.ID] = e.Revision
	}
	for _, r := range ack.Receipts {
		rev, ok := want[r.ID]
		if !ok || rev != r.Revision || (r.Status != "accepted" && r.Status != "unchanged") {
			return errors.New("invalid event acknowledgement")
		}
		delete(want, r.ID)
	}
	if len(want) != 0 {
		return errors.New("missing event acknowledgement")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, e := range b.Events {
		if _, err = tx.Exec(`UPDATE events SET acked_at=? WHERE id=? AND hash=?`, time.Now().Unix(), e.ID, protocol.Hash(e)); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`DELETE FROM batches WHERE id=?`, b.ID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Diagnostic(code string) {
	_, _ = s.DB.Exec(`INSERT INTO diagnostics(code,count,updated_at) VALUES(?,1,?) ON CONFLICT(code) DO UPDATE SET count=count+1,updated_at=excluded.updated_at`, code, time.Now().Unix())
}

func (s *Store) Status() (map[string]any, error) {
	var pending, total, blocked int64
	if err := s.DB.QueryRow(`SELECT count(*),count(*) FILTER(WHERE acked_at IS NULL),count(*) FILTER(WHERE blocked!='') FROM events`).Scan(&total, &pending, &blocked); err != nil {
		return nil, err
	}
	var bytes, pendingBytes int64
	if err := s.DB.QueryRow(`SELECT total_bytes,pending_bytes FROM ledger_totals WHERE id=1`).Scan(&bytes, &pendingBytes); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(`SELECT code,count FROM diagnostics ORDER BY code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	diagnostics := map[string]int64{}
	for rows.Next() {
		var code string
		var count int64
		if err = rows.Scan(&code, &count); err != nil {
			return nil, err
		}
		diagnostics[code] = count
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"events": total, "pending": pending, "blocked": blocked, "normalizedBytes": bytes, "pendingBytes": pendingBytes, "diagnostics": diagnostics}, nil
}

func (s *Store) Events(ctx context.Context) ([]protocol.Event, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT body FROM events ORDER BY created_at,rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []protocol.Event
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		var e protocol.Event
		if err = json.Unmarshal(b, &e); err != nil {
			return nil, fmt.Errorf("stored event: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
