package capture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

func newRecorder(t *testing.T, source string) (*Recorder, string) {
	t.Helper()
	s, err := ledger.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	id, err := s.DeviceID()
	if err != nil {
		t.Fatal(err)
	}
	return &Recorder{s, source, id}, t.TempDir()
}
func prompt(t *testing.T, r *Recorder, root, session, turn, text string) {
	t.Helper()
	if err := r.Record(Native{Stage: "UserPromptSubmit", Event: Object{"session_id": session, "turn_id": turn, "cwd": root, "prompt": text}}); err != nil {
		t.Fatal(err)
	}
}
func TestVerifiedPlanHandoffAndAmbiguity(t *testing.T) {
	r, root := newRecorder(t, "claude-code")
	prompt(t, r, root, "c", "1", "plan work")
	_, repo, ref := repository(root)
	s := scope{Session: "c", Turn: "1", CWD: root, Repo: repo, Repository: ref}
	work := r.workExact(s)
	plan := filepath.Join(root, "plan.md")
	if err := os.WriteFile(plan, []byte("implement auth\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterPlan(root, plan, work, s); err != nil {
		t.Fatal(err)
	}
	r.Source = "codex"
	prompt(t, r, root, "x", "2", "implement @plan.md")
	s.Session = "x"
	s.Turn = "2"
	if got := r.workExact(s); got != work {
		t.Fatal("cross-harness binding lost", got, work)
	}
	if err := os.WriteFile(plan, []byte("unregistered modification\n"), 0600); err != nil {
		t.Fatal(err)
	}
	prompt(t, r, root, "y", "3", "implement plan.md")
	s.Session = "y"
	s.Turn = "3"
	if r.workExact(s) == work {
		t.Fatal("unverified revision inherited work")
	}
	if err := os.WriteFile(plan, []byte("implement auth\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterPlan(root, plan, protocol.NewID(), s); err != nil {
		t.Fatal(err)
	}
	prompt(t, r, root, "z", "4", "implement plan.md")
	s.Session = "z"
	s.Turn = "4"
	if r.workExact(s) == work {
		t.Fatal("ambiguous plan silently chose an owner")
	}
}

func TestExplicitNewWorkTitleAndJiraKeyExcludeTheRemainingPrompt(t *testing.T) {
	r, root := newRecorder(t, "codex")
	prompt(t, r, root, "session", "first", "original task")
	_, repo, _ := repository(root)
	old := r.work(scope{Session: "session", Turn: "first", Repo: repo})
	prompt(t, r, root, "session", "second", "New work: WID-42 Refresh authentication\nprivate task instructions must stay local")
	if r.work(scope{Session: "session", Turn: "second", Repo: repo}) == old {
		t.Fatal("explicit boundary kept prior work")
	}
	events, err := r.Store.Events(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Work != nil && e.Work.Reason == "explicit_new_work" {
			found = true
			if e.Work.Title != "WID-42 Refresh authentication" || len(e.Work.IssueKeys) != 1 || e.Work.IssueKeys[0].Key != "WID-42" {
				t.Fatal(e.Work)
			}
		}
		body, _ := json.Marshal(e)
		if strings.Contains(string(body), "private task") {
			t.Fatal("prompt leaked")
		}
	}
	if !found {
		t.Fatal("explicit work event missing")
	}
}

func TestSubagentInheritsLaunchWorkAndStepCountersDoNotDoubleCharge(t *testing.T) {
	r, root := newRecorder(t, "claude-code")
	prompt(t, r, root, "session", "parent-turn", "first work")
	_, repo, _ := repository(root)
	first := r.work(scope{Session: "session", Turn: "parent-turn", Repo: repo})
	if err := r.Record(Native{Stage: "classic.SubagentStart", Event: Object{"session_id": "session", "cwd": root, "agent_id": "child"}}); err != nil {
		t.Fatal(err)
	}
	prompt(t, r, root, "session", "second-parent-turn", "/work new other work")
	n := Native{Stage: "step.after", SessionID: "session", CWD: root, Event: Object{"turnId": "child-turn", "agentId": "child", "index": json.Number("0")}, Result: Object{"usage": Object{"model": "native-model", "input_tokens": json.Number("10"), "output_tokens": json.Number("2")}}}
	if err := r.Record(n); err != nil {
		t.Fatal(err)
	}
	if err := r.Record(n); err != nil {
		t.Fatal(err)
	}
	events, err := r.Store.Events(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	steps := 0
	for _, e := range events {
		if e.Coverage != nil && e.Coverage.ObservedUsage != nil {
			steps++
			if e.WorkID != first || e.AgentID != "child" || e.TurnID != "child-turn" || e.Coverage.Model != "native-model" {
				t.Fatal(e)
			}
		}
		if e.Usage != nil {
			t.Fatal("supplementary mod counters became a second charge")
		}
	}
	if steps != 1 {
		t.Fatal(steps)
	}
}

func TestSubagentTranscriptRetainsLaunchWorkAfterParentSwitch(t *testing.T) {
	r, root := newRecorder(t, "claude-code")
	prompt(t, r, root, "s", "first", "work")
	_, repo, _ := repository(root)
	work := r.work(scope{Session: "s", Turn: "first", Repo: repo})
	if err := r.Record(Native{Stage: "classic.SubagentStart", Event: Object{"session_id": "s", "cwd": root, "agent_id": "child"}}); err != nil {
		t.Fatal(err)
	}
	prompt(t, r, root, "s", "second", "/work new elsewhere")
	path := filepath.Join(root, "child.jsonl")
	line := Object{"type": "assistant", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "requestId": "child-request", "message": Object{"id": "child-response", "model": "native-model", "usage": Object{"input_tokens": 1, "output_tokens": 2}}}
	body, _ := json.Marshal(line)
	if err := os.WriteFile(path, append(body, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.Record(Native{Stage: "classic.SubagentStop", Event: Object{"session_id": "s", "cwd": root, "agent_id": "child", "agent_transcript_path": path}}); err != nil {
		t.Fatal(err)
	}
	if err := r.Recover(); err != nil {
		t.Fatal(err)
	}
	events, err := r.Store.Events(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Usage != nil {
			found = true
			if e.WorkID != work || e.AgentID != "child" || e.TurnID != "" || e.Usage.Correlation != "inherited_agent_work" {
				t.Fatal(e)
			}
		}
	}
	if !found {
		t.Fatal("subagent usage missing")
	}
}

func TestTranscriptAttachesExactToolRequestAndPreservesCompletion(t *testing.T) {
	r, root := newRecorder(t, "claude-code")
	prompt(t, r, root, "s", "turn", "read")
	path := filepath.Join(root, "file")
	if err := os.WriteFile(path, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	e := Object{"session_id": "s", "cwd": root, "tool_name": "Read", "tool_use_id": "call", "tool_input": Object{"file_path": path}}
	for _, stage := range []string{"PreToolUse", "PostToolUse"} {
		if err := r.Record(Native{Stage: stage, Event: e}); err != nil {
			t.Fatal(err)
		}
	}
	_, repo, _ := repository(root)
	s := scope{Session: "s", Turn: "turn", CWD: root, Repo: repo}
	entity := r.event(s, "tool:call", "").EntityID
	var oldBody []byte
	r.Store.DB.QueryRow(`SELECT body FROM events WHERE entity_id=?`, entity).Scan(&oldBody)
	var old protocol.Event
	json.Unmarshal(oldBody, &old)
	tr := transcript{Scope: s, Route: "unknown", Basis: "unknown"}
	usage := Object{"type": "assistant", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "requestId": "request", "message": Object{"id": "response", "model": "native-model", "content": []any{Object{"type": "tool_use", "id": "call"}}, "usage": Object{"input_tokens": json.Number("1"), "output_tokens": json.Number("2")}}}
	for i := 0; i < 2; i++ {
		if err := r.consume(&tr, usage, 0); err != nil {
			t.Fatal(err)
		}
	}
	var body []byte
	r.Store.DB.QueryRow(`SELECT body FROM events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1`, entity).Scan(&body)
	var revised protocol.Event
	json.Unmarshal(body, &revised)
	if revised.Revision != 2 || revised.Tool.Name != "Read" || revised.Tool.DurationMS != old.Tool.DurationMS || revised.Tool.RequestEntityID != r.event(s, requestEntity("response", "request"), "").EntityID {
		t.Fatal(string(body))
	}
}
func TestPreimageDurableAndPostReplay(t *testing.T) {
	r, root := newRecorder(t, "codex")
	prompt(t, r, root, "s", "t", "edit")
	p := filepath.Join(root, "a.go")
	os.WriteFile(p, []byte("before\n"), 0600)
	e := Object{"session_id": "s", "turn_id": "t", "cwd": root, "tool_use_id": "call", "tool_name": "Edit", "tool_input": Object{"file_path": p}}
	if err := r.Record(Native{Stage: "PreToolUse", Event: e}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(r.Store.Dir, "blobs", digest([]byte("before\n")))); err != nil {
		t.Fatal("preimage not durable before mutation", err)
	}
	os.WriteFile(p, []byte("after\n"), 0600)
	if err := r.Record(Native{Stage: "PostToolUse", Event: e}); err != nil {
		t.Fatal(err)
	}
	var count int
	r.Store.DB.QueryRow(`SELECT count(*) FROM events`).Scan(&count)
	if err := r.Record(Native{Stage: "PostToolUse", Event: e}); err != nil {
		t.Fatal(err)
	}
	var replay int
	r.Store.DB.QueryRow(`SELECT count(*) FROM events`).Scan(&replay)
	if replay != count {
		t.Fatal("post replay created new records")
	}
	var body []byte
	r.Store.DB.QueryRow(`SELECT body FROM events WHERE kind='file'`).Scan(&body)
	if string(body) == "" || containsAny(string(body), []string{p, "before\n", "after\n", digest([]byte("before\n"))}) {
		t.Fatal("uploaded file evidence leaked local data", string(body))
	}
}
func containsAny(s string, items []string) bool {
	for _, v := range items {
		if strings.Contains(s, v) {
			return true
		}
	}
	return false
}
func TestUsageRecoveryDeduplicatesStreamsAndPreservesMissing(t *testing.T) {
	r, root := newRecorder(t, "codex")
	prompt(t, r, root, "s", "turn", "work")
	_, repo, ref := repository(root)
	tr := transcript{Scope: scope{Session: "s", Repo: repo, Repository: ref, CWD: root}, Path: filepath.Join(root, "rollout.jsonl"), Route: "custom-gateway", Basis: "unknown"}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	context := Object{"timestamp": now, "type": "turn_context", "payload": Object{"turn_id": "turn", "model": "observed-model"}}
	record := Object{"timestamp": now, "type": "event_msg", "payload": Object{"type": "token_count", "info": Object{"last_token_usage": Object{"input_tokens": json.Number("100"), "cached_input_tokens": json.Number("10"), "output_tokens": json.Number("3")}, "total_token_usage": Object{"input_tokens": json.Number("100"), "output_tokens": json.Number("3")}}}}
	if err := r.consume(&tr, context, 0); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := r.consume(&tr, record, int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	r.Store.DB.QueryRow(`SELECT count(*) FROM events WHERE kind='usage'`).Scan(&n)
	if n != 1 {
		t.Fatal("duplicate counter charged", n)
	}
	var b []byte
	r.Store.DB.QueryRow(`SELECT body FROM events WHERE kind='usage'`).Scan(&b)
	var event protocol.Event
	json.Unmarshal(b, &event)
	if event.Usage.Raw.CacheWrite != nil || event.WorkID == "" || event.Usage.ObservedRoute != "custom-gateway" || event.Usage.ReportedModel != "observed-model" {
		t.Fatal(string(b))
	}
}

func TestRecoveryIgnoresUntimestampedMetadataButRejectsUntimestampedUsage(t *testing.T) {
	r, _ := newRecorder(t, "claude-code")
	tr := transcript{}
	if err := r.consume(&tr, Object{"type": "atis-latch"}, 0); err != nil {
		t.Fatal(err)
	}
	if err := r.consume(&tr, Object{"type": "assistant", "message": Object{"id": "message", "usage": Object{}}}, 0); err == nil {
		t.Fatal("untimestamped accounting silently accepted")
	}
}

func TestConcurrentHumanEditCannotBecomeConfirmedAndSymlinkCannotEscape(t *testing.T) {
	r, root := newRecorder(t, "codex")
	prompt(t, r, root, "s", "t", "edit")
	path := filepath.Join(root, "source.txt")
	os.WriteFile(path, []byte("before\n"), 0600)
	event := Object{"session_id": "s", "turn_id": "t", "cwd": root, "tool_use_id": "edit", "tool_name": "Edit", "tool_input": Object{"file_path": path, "old_string": "before", "new_string": "agent"}}
	if err := r.Record(Native{Stage: "PreToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("agent\nhuman\n"), 0600)
	if err := r.Record(Native{Stage: "PostToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	var body []byte
	r.Store.DB.QueryRow(`SELECT body FROM events WHERE kind='file'`).Scan(&body)
	var e protocol.Event
	json.Unmarshal(body, &e)
	if e.File == nil || e.File.Quality != "observed" {
		t.Fatal("concurrent change attributed to agent", string(body))
	}
	outside := t.TempDir()
	secret := []byte("private canary")
	os.WriteFile(filepath.Join(outside, "secret"), secret, 0600)
	os.Symlink(outside, filepath.Join(root, "link"))
	if state := r.snapshot(root, filepath.Join(root, "link", "secret")); state.Complete {
		t.Fatal("snapshot followed symlink outside repository")
	}
	if _, err := os.Stat(filepath.Join(r.Store.Dir, "blobs", digest(secret))); !os.IsNotExist(err) {
		t.Fatal("secret persisted", err)
	}
}
