package capture

import (
	"encoding/json"
	"github.com/getkimchi/kimchi-adapters/protocol"
	"testing"
	"time"
)

func TestNativeTelemetryAndTranscriptReviseOneRequest(t *testing.T) {
	r, root := newRecorder(t, "claude-code")
	prompt(t, r, root, "s", "turn", "work")
	_, repo, ref := repository(root)
	s := scope{Session: "s", Turn: "turn", CWD: root, Repo: repo, Repository: ref}
	r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?)`, "prompt-turn:s:prompt", "turn")
	request := protocol.NewID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	event := Object{"event": "api_request", "attributes": Object{"request_id": request, "event.timestamp": now, "prompt.id": "prompt", "model": "model", "input_tokens": json.Number("11"), "output_tokens": json.Number("5"), "cache_read_tokens": json.Number("13"), "cache_creation_tokens": json.Number("7"), "cache_creation_5m_tokens": json.Number("3"), "cache_creation_1h_tokens": json.Number("4")}}
	if err := r.telemetry(s, event, "castai", "unknown"); err != nil {
		t.Fatal(err)
	}
	transcript := transcript{Scope: s, Route: "castai", Basis: "unknown"}
	native := Object{"type": "assistant", "timestamp": now, "requestId": request, "message": Object{"id": "message", "model": "model", "usage": Object{"input_tokens": json.Number("11"), "output_tokens": json.Number("5"), "cache_read_input_tokens": json.Number("13"), "cache_creation_input_tokens": json.Number("7"), "cache_creation": Object{"ephemeral_5m_input_tokens": json.Number("3"), "ephemeral_1h_input_tokens": json.Number("4")}}}}
	if err := r.consume(&transcript, native, 0); err != nil {
		t.Fatal(err)
	}
	if err := r.telemetry(s, event, "castai", "unknown"); err != nil {
		t.Fatal(err)
	}
	var entities, revisions int
	if err := r.Store.DB.QueryRow(`SELECT COUNT(DISTINCT entity_id),COUNT(*) FROM events WHERE kind='usage'`).Scan(&entities, &revisions); err != nil {
		t.Fatal(err)
	}
	if entities != 1 || revisions != 2 {
		t.Fatal("overlapping channels created duplicate or regressed accounting", entities, revisions)
	}
	var body []byte
	r.Store.DB.QueryRow(`SELECT body FROM events WHERE kind='usage' ORDER BY rowid DESC LIMIT 1`).Scan(&body)
	var got protocol.Event
	json.Unmarshal(body, &got)
	if got.Usage.Channel != "transcript" || len(got.Usage.Aliases) != 1 || got.WorkID == "" || len(got.Usage.Raw.CacheWrites) != 2 {
		t.Fatal(string(body))
	}
}

func TestRouteDoesNotMatchUnrelatedHostname(t *testing.T) {
	for endpoint, want := range map[string]string{"https://llm.cast.ai": "castai", "https://evilcast.ai": "customer-gateway", "https://api.anthropic.com": "provider-api", "https://router.example": "customer-gateway"} {
		t.Setenv("ANTHROPIC_BASE_URL", endpoint)
		if got := route("claude-code"); got != want {
			t.Fatal(endpoint, got, want)
		}
	}
}
