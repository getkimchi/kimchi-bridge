package probe

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTUIReplyWithDiffPanelAndPrompt(t *testing.T) {
	for _, s := range []string{"⏺ done\n", "• done\n", "⏺ done       │probe.txt\n"} {
		if !tuiDone.MatchString(s) {
			t.Fatalf("missing reply: %q", s)
		}
	}
	if tuiDone.MatchString("❯ Change the file. Reply done.\n") {
		t.Fatal("prompt is not an assistant reply")
	}
}
func TestClaudeFixtureAuxiliaryRequestCannotConsumeEdit(t *testing.T) {
	w := httptest.NewRecorder()
	claudeResponse(w, map[string]any{}, 1)
	if strings.Contains(w.Body.String(), `"name":"Read"`) {
		t.Fatal("title requests must not execute tools")
	}
	body := map[string]any{"tools": []any{map[string]any{"name": "Read"}}, "messages": []any{}}
	w = httptest.NewRecorder()
	claudeResponse(w, body, 2)
	if !strings.Contains(w.Body.String(), `"name":"Read"`) {
		t.Fatal("first main request must read, irrespective of title request order")
	}
	body["messages"] = []any{map[string]any{"content": []any{map[string]any{"type": "tool_use", "name": "Read"}}}}
	w = httptest.NewRecorder()
	claudeResponse(w, body, 3)
	if !strings.Contains(w.Body.String(), `"name":"Edit"`) {
		t.Fatal("next main request must edit")
	}
}
