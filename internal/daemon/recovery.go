package daemon

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/getkimchi/kimchi-adapters/internal/capture"
	"github.com/getkimchi/kimchi-adapters/internal/ledger"
)

// Sessions keep their first account after login changes. Recover their local
// transcripts without giving those ledgers the current account's credentials.
func recoverInactiveAccounts(ctx context.Context, stateRoot, activeDir string) error {
	root := filepath.Join(stateRoot, "accounts")
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	var failures error
	for _, entry := range entries {
		if ctx.Err() != nil {
			return errors.Join(failures, ctx.Err())
		}
		dir := filepath.Join(root, entry.Name())
		if !entry.IsDir() || dir == activeDir {
			continue
		}
		if info, err := os.Lstat(filepath.Join(dir, "ledger.sqlite")); err != nil || !info.Mode().IsRegular() {
			continue
		}
		s, err := ledger.Open(dir)
		if err != nil {
			failures = errors.Join(failures, err)
			continue
		}
		device, err := s.DeviceID()
		if err == nil {
			for _, source := range []string{"claude-code", "codex"} {
				r := capture.Recorder{Store: s, Source: source, Device: device}
				err = errors.Join(err, r.Recover())
			}
			r := capture.Recorder{Store: s, Source: "collector", Device: device}
			if gitErr := r.ReconcileGit(ctx); gitErr != nil {
				s.Diagnostic("git_reconciliation_incomplete")
				err = errors.Join(err, gitErr)
			}
		}
		if err != nil {
			s.Diagnostic("recovery_failed")
		}
		failures = errors.Join(failures, err, s.Close())
	}
	return failures
}
