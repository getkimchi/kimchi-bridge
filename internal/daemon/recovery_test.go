package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/capture"
	"github.com/getkimchi/kimchi-adapters/internal/delivery"
	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/internal/settings"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

func TestWorkerRecoversPinnedAccountsButUploadsOnlySelectedAccount(t *testing.T) {
	t.Setenv("KIMCHI_ADAPTERS_HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	git("init", "--initial-branch=main")
	git("config", "user.email", "fixture@example.invalid")
	git("config", "user.name", "Fixture")
	git("config", "core.hooksPath", "/dev/null")
	git("config", "commit.gpgsign", "false")
	file := filepath.Join(repo, "file.txt")
	if err := os.WriteFile(file, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "baseline")
	actors := map[string]string{"A": protocol.NewID(), "B": protocol.NewID()}
	var sent atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/v1/me" {
			_ = json.NewEncoder(w).Encode(map[string]string{"id": actors[req.Header.Get("X-API-Key")], "username": "auth0|fixture"})
			return
		}
		var body struct {
			Batch protocol.Batch `json:"batch"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		ack := protocol.Acknowledgement{BatchID: body.Batch.ID}
		for _, event := range body.Batch.Events {
			if event.SessionID != "B" || req.Header.Get("X-API-Key") != "B" {
				t.Error("another account's records were uploaded", event.SessionID)
			}
			ack.Receipts = append(ack.Receipts, protocol.Receipt{ID: event.ID, Revision: event.Revision, Status: "accepted"})
		}
		sent.Add(1)
		_ = json.NewEncoder(w).Encode(ack)
	}))
	defer server.Close()
	selected := settings.Config{}
	var previous []*ledger.Store
	var paths []string
	for _, account := range []string{"local", "A", "B"} {
		c := settings.Config{}
		if account != "local" {
			var err error
			c.Config, err = delivery.Authenticate(t.Context(), delivery.Config{APIURL: server.URL, OrganizationID: protocol.StableID("org"), APIKey: account, Enabled: true})
			if err != nil {
				t.Fatal(err)
			}
		}
		dir, err := settings.SessionStateDir(c, "codex", account)
		if err != nil {
			t.Fatal(err)
		}
		s, err := ledger.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		path := filepath.Join(t.TempDir(), "rollout.jsonl")
		if err = os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
		device, _ := s.DeviceID()
		r := capture.Recorder{Store: s, Source: "codex", Device: device}
		if err = r.Record(capture.Native{Stage: "UserPromptSubmit", Version: "test", Event: capture.Object{"session_id": account, "turn_id": "turn", "cwd": repo, "prompt": "New work: fixture", "transcript_path": path}}); err != nil {
			t.Fatal(err)
		}
		if account != "B" {
			previous = append(previous, s)
			paths = append(paths, path)
		}
		selected = c
	}
	if err := settings.Save(selected); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	done := make(chan error, 1)
	go func() { done <- Run(ctx, selected) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	for sent.Load() == 0 {
		select {
		case <-ctx.Done():
			t.Fatal("selected account did not upload")
		case <-time.After(10 * time.Millisecond):
		}
	}
	line := `{"timestamp":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":3},"total_token_usage":{"input_tokens":100,"output_tokens":3}}}}` + "\n"
	for _, path := range paths {
		if err := os.WriteFile(path, []byte(line), 0600); err != nil {
			t.Fatal(err)
		}
	}
	old := previous[1]
	device, _ := old.DeviceID()
	r := capture.Recorder{Store: old, Source: "codex", Device: device}
	event := capture.Object{"session_id": "A", "turn_id": "turn", "cwd": repo, "tool_use_id": "edit-after-switch", "tool_name": "Edit", "tool_input": capture.Object{"file_path": file, "old_string": "before", "new_string": "after"}}
	if err := r.Record(capture.Native{Stage: "PreToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("after"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.Record(capture.Native{Stage: "PostToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-m", "pinned account edit")
	if _, err := old.DB.Exec(`DELETE FROM meta WHERE key='git-last-pass'`); err != nil {
		t.Fatal(err)
	}
	for _, s := range previous {
		for {
			var count, acknowledged int
			if err := s.DB.QueryRow(`SELECT count(*),count(acked_at) FROM events WHERE json_type(body,'$.usage')='object'`).Scan(&count, &acknowledged); err != nil {
				t.Fatal(err)
			}
			if count == 1 {
				if acknowledged != 0 {
					t.Fatal("inactive usage was acknowledged")
				}
				break
			}
			select {
			case <-ctx.Done():
				t.Fatal("pinned usage did not reach its original durable queue")
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	for {
		var count int
		if err := old.DB.QueryRow(`SELECT count(*) FROM events WHERE kind='commit' AND acked_at IS NULL`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 1 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("pinned commit did not reach its original durable queue")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
