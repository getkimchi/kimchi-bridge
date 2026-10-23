package probe

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDurablePreimage(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "probe.txt")
	if err := os.WriteFile(file, []byte("before\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Record(root, file, []byte(`{"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_use_id":"call-1"}`)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("after\n"), 0600); err != nil {
		t.Fatal(err)
	}
	events, err := readRecords(filepath.Join(root, "events"))
	if err != nil || len(events) != 1 {
		t.Fatalf("%v %v", events, err)
	}
	if events[0]["snapshot"].(map[string]any)["content"] != "before\n" {
		t.Fatal("preimage lost")
	}
	entries, _ := os.ReadDir(filepath.Join(root, "events"))
	info, _ := entries[0].Info()
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode: %v", info.Mode())
	}
}
func TestAbsentPreimageAndMalformed(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "missing")
	if err := Record(root, file, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	records, _ := readRecords(filepath.Join(root, "events"))
	if records[0]["snapshot"].(map[string]any)["exists"] != false {
		t.Fatal("missing file reported present")
	}
	for _, payload := range []string{"not JSON", strings.Repeat("x", MaxRecord+1)} {
		if Record(root, file, []byte(payload)) == nil {
			t.Fatal("accepted malformed event")
		}
	}
	if Record("", file, []byte(`{}`)) == nil {
		t.Fatal("accepted missing state")
	}
}
func TestCollectorFailureAndGap(t *testing.T) {
	root := t.TempDir()
	blocked := filepath.Join(root, "blocked")
	os.WriteFile(blocked, []byte("x"), 0600)
	if Record(blocked, filepath.Join(root, "absent"), []byte(`{}`)) == nil {
		t.Fatal("expected storage error")
	}
	Gap(root, "recorder_failed")
	gaps, _ := readRecords(filepath.Join(root, "gaps"))
	if len(gaps) != 1 || gaps[0]["code"] != "recorder_failed" {
		t.Fatal(gaps)
	}
}
func TestProviderRawUsageAndLimits(t *testing.T) {
	root := t.TempDir()
	p := &provider{root: root, counts: map[string]int{}, requests: map[string][]map[string]any{}}
	for _, h := range []string{"claude", "codex"} {
		path := "/" + h + "-baseline/v1/messages"
		if h == "codex" {
			path = "/" + h + "-baseline/v1/responses"
		}
		req := httptest.NewRequest("POST", path, strings.NewReader(`{"model":"fixture"}`))
		req.Header.Set("Authorization", "never-persist-this")
		w := httptest.NewRecorder()
		p.ServeHTTP(w, req)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "usage") {
			t.Fatal(w.Code, w.Body.String())
		}
		records, _ := readRecords(filepath.Join(root, h+"-baseline", "wire"))
		b, _ := json.Marshal(records)
		if strings.Contains(string(b), "never-persist-this") {
			t.Fatal("auth leaked")
		}
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("POST", "/codex-capture/otlp/v1/logs", strings.NewReader(`{"resourceLogs":[]}`)))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("POST", "/unowned/v1/responses", strings.NewReader(`{}`)))
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
}
func TestEnvironmentDoesNotInheritSecrets(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "real-secret-canary")
	t.Setenv("AWS_ACCESS_KEY_ID", "real-secret-canary")
	got := strings.Join(cleanEnv("/scratch/home", "/scratch/state", "/helper", "http://127.0.0.1:9"), "\n")
	if strings.Contains(got, "real-secret-canary") || strings.Contains(got, "AWS_") {
		t.Fatal("inherited secret")
	}
}
func TestNormalizationKeepsModelContext(t *testing.T) {
	a := []map[string]any{{"metadata": map[string]any{"user_id": "a"}, "messages": []any{"hello"}}}
	b := []map[string]any{{"metadata": map[string]any{"user_id": "b"}, "messages": []any{"injected"}}}
	if reflect.DeepEqual(normalize(a, "/root", "a"), normalize(b, "/root", "b")) {
		t.Fatal("context injection hidden")
	}
}
func TestNormalizationOnlyGeneratedFields(t *testing.T) {
	makeRequest := func(id, model string) []map[string]any {
		return []map[string]any{{
			"client_metadata": map[string]any{"turn_id": id, "model": model},
			"input":           []any{map[string]any{"id": id, "content": "same context"}},
		}}
	}
	if !reflect.DeepEqual(normalize(makeRequest("a", "same"), "/root", "a"), normalize(makeRequest("b", "same"), "/root", "b")) {
		t.Fatal("generated identities not normalized")
	}
	if reflect.DeepEqual(normalize(makeRequest("a", "one"), "/root", "a"), normalize(makeRequest("b", "two"), "/root", "b")) {
		t.Fatal("model change hidden")
	}
}
func TestEditStateRequiresMatchingToolAndOrder(t *testing.T) {
	record := func(tool, stage, id, content, stamp string) map[string]any {
		return map[string]any{
			"event":    map[string]any{"stage": stage, "event": map[string]any{"tool": tool, "tool_use_id": id}},
			"snapshot": map[string]any{"content": content}, "time": stamp,
		}
	}
	pre := record("Edit", "tool.before", "edit-1", "before\n", "2026-10-23T09:00:00Z")
	post := record("Edit", "tool.after", "edit-1", "after\n", "2026-10-23T09:00:01Z")
	if !verifiedEditState([]map[string]any{post, pre}) {
		t.Fatal("valid pre/post pair rejected")
	}
	read := record("Read", "tool.before", "edit-1", "before\n", "2026-10-23T09:00:00Z")
	wrong := record("Edit", "tool.after", "edit-2", "after\n", "2026-10-23T09:00:01Z")
	early := record("Edit", "tool.after", "edit-1", "after\n", "2026-10-23T08:59:59Z")
	for _, bad := range [][]map[string]any{{pre}, {read, post}, {pre, wrong}, {pre, early}} {
		if verifiedEditState(bad) {
			t.Fatal("invalid pre/post pair accepted")
		}
	}
}
func TestNativeChunkNormalization(t *testing.T) {
	a := "Chunk ID: abc123\nOutput:\nkeep Chunk ID: abc123\n"
	if got := nativeChunkID.ReplaceAllString(a, "Chunk ID: <generated>\n"); got != "Chunk ID: <generated>\nOutput:\nkeep Chunk ID: abc123\n" {
		t.Fatal(got)
	}
}
func TestFinalOutputParsing(t *testing.T) {
	got := finalTexts([]byte("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n"))
	if !reflect.DeepEqual(got, []string{"done"}) {
		t.Fatal(got)
	}
}
