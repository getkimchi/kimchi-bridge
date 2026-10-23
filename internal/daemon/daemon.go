package daemon

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"

	"github.com/getkimchi/kimchi-adapters/internal/capture"
	"github.com/getkimchi/kimchi-adapters/internal/delivery"
	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/internal/settings"
)

func lock(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "worker.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func Start(c settings.Config) error {
	if c.Disabled {
		return nil
	}
	f, err := lock(c.StateDir())
	if err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil
		}
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	executable := c.RuntimeExecutable
	if executable == "" {
		executable, err = os.Executable()
		if err != nil {
			return err
		}
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	cmd := exec.Command(executable, "worker")
	cmd.Stdin = null
	cmd.Stdout = null
	cmd.Stderr = null
	// A daemon survives the harness's process group and session shutdown.
	cmd.SysProcAttr = &unix.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
func Run(ctx context.Context, c settings.Config) error {
	var replacement *settings.Config
	defer func() {
		if replacement != nil {
			_ = Start(*replacement)
		}
	}()
	guard, err := lock(c.StateDir())
	if errors.Is(err, unix.EWOULDBLOCK) {
		return nil
	}
	if err != nil {
		return err
	}
	defer guard.Close()
	s, err := ledger.Open(c.StateDir())
	if err != nil {
		return err
	}
	defer s.Close()
	device, err := s.DeviceID()
	if err != nil {
		return err
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	retryAt := time.Time{}
	backoff := time.Second
	var otlpRetryAt time.Time
	otlpBackoff := time.Second
	for {
		latest, loadErr := settings.Load()
		if loadErr != nil {
			s.Diagnostic("settings_unreadable")
		} else if latest.Disabled || latest.StateDir() != c.StateDir() {
			return nil
		} else if latest.RuntimeRevision != c.RuntimeRevision {
			replacement = &latest
			return nil
		} else {
			c = latest
		}
		for _, source := range []string{"claude-code", "codex"} {
			r := capture.Recorder{Store: s, Source: source, Device: device}
			if err = r.Recover(); err != nil {
				s.Diagnostic("recovery_failed")
			}
			if err = r.PruneEvidence(time.Now()); err != nil {
				s.Diagnostic("retention_failed")
			}
		}
		gitRecorder := capture.Recorder{Store: s, Source: "collector", Device: device}
		if err = gitRecorder.ReconcileGit(ctx); err != nil {
			s.Diagnostic("git_reconciliation_incomplete")
		}
		if !time.Now().Before(retryAt) {
			for i := 0; i < 10; i++ {
				sent, e := delivery.Flush(ctx, s, c.Config)
				if e != nil {
					s.Diagnostic("delivery_pending")
					retryAt = time.Now().Add(backoff)
					backoff = min(backoff*2, time.Minute)
					break
				}
				if !sent {
					break
				}
				backoff = time.Second
				retryAt = time.Time{}
			}
		}
		if !time.Now().Before(otlpRetryAt) {
			if _, err = delivery.FlushOTLP(ctx, s, c.Config); err != nil {
				s.Diagnostic("otlp_delivery_pending")
				otlpRetryAt = time.Now().Add(otlpBackoff)
				otlpBackoff = min(otlpBackoff*2, time.Minute)
			} else {
				otlpRetryAt = time.Time{}
				otlpBackoff = time.Second
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
