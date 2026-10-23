package capture

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
)

// Raw evidence expires independently of the selected reporting account. This
// sweep never recovers transcripts, changes ownership or delivers old queues.
func PruneAccounts(stateRoot string, now time.Time) error {
	root := filepath.Join(stateRoot, "accounts")
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var failures error
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if info, err := os.Lstat(filepath.Join(dir, "ledger.sqlite")); err != nil || !info.Mode().IsRegular() {
			continue
		}
		s, err := ledger.Open(dir)
		if err != nil {
			failures = errors.Join(failures, err)
			continue
		}
		r := Recorder{Store: s}
		failures = errors.Join(failures, r.PruneEvidence(now), s.Close())
	}
	return failures
}
