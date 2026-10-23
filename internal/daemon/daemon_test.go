package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/settings"
)

func TestWorkerReleasesLockAndUsesActivatedReplacement(t *testing.T) {
	root := t.TempDir()
	t.Setenv("KIMCHI_ADAPTERS_HOME", root)
	c := settings.Config{RuntimeRevision: "old"}
	if err := settings.Save(c); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 6*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, c) }()
	for {
		if _, err := os.Stat(filepath.Join(c.StateDir(), "worker.lock")); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	marker := filepath.Join(root, "replacement-ran")
	next := filepath.Join(root, "next-worker")
	if err := os.WriteFile(next, []byte(fmt.Sprintf("#!/bin/sh\nprintf worker > %q\n", marker)), 0700); err != nil {
		t.Fatal(err)
	}
	c.RuntimeExecutable = next
	c.RuntimeRevision = "new"
	if err := settings.Save(c); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("activated worker was not started")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
