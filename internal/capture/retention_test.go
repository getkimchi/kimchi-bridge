package capture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

func TestRawExpirySweepsPreviousAccountsAndKeepsPendingEvidence(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	old := now.Add(-8 * 24 * time.Hour)
	for _, account := range []string{"local", protocol.NewID(), protocol.NewID()} {
		s, err := ledger.Open(filepath.Join(root, "accounts", account))
		if err != nil {
			t.Fatal(err)
		}
		blob := filepath.Join(s.Dir, "blobs", "private-blob")
		if err = os.Mkdir(filepath.Dir(blob), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(blob, []byte("private expired evidence"), 0600); err != nil {
			t.Fatal(err)
		}
		if err = os.Chtimes(blob, old, old); err != nil {
			t.Fatal(err)
		}
		state, _ := json.Marshal(toolState{Started: old})
		if _, err = s.DB.Exec(`INSERT INTO tool_state(source,session_id,call_id,body)VALUES('codex','session','call',?)`, state); err != nil {
			t.Fatal(err)
		}
		e := protocol.Event{ID: protocol.NewID(), EntityID: protocol.NewID(), DeviceID: protocol.NewID(), Source: "codex", SourceVersion: "test", Revision: 1, ObservedAt: old, Coverage: &protocol.Coverage{Code: "test", Count: 1}}
		if err = s.Put(e); err != nil {
			t.Fatal(err)
		}
		if err = s.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := PruneAccounts(root, now); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "accounts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range entries {
		dir := filepath.Join(root, "accounts", account.Name())
		if _, err := os.Stat(filepath.Join(dir, "blobs", "private-blob")); !os.IsNotExist(err) {
			t.Fatal("old account blob retained", err)
		}
		s, err := ledger.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		var count int
		if err = s.DB.QueryRow(`SELECT count(*) FROM tool_state`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatal("old account tool detail retained")
		}
		status, err := s.Status()
		if err != nil || status["pending"] != int64(1) {
			t.Fatal("pending ownership/queue changed", status, err)
		}
		s.Close()
	}
}
