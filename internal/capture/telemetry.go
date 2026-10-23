package capture

import (
	"encoding/json"
	"github.com/getkimchi/kimchi-adapters/protocol"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

func route(source string) string {
	if source != "claude-code" {
		return "unknown"
	}
	for _, key := range []string{"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"} {
		if os.Getenv(key) == "1" {
			return "cloud-provider"
		}
	}
	endpoint := os.Getenv("ANTHROPIC_BASE_URL")
	if endpoint == "" {
		return "provider-api"
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return "unknown"
	}
	host := strings.ToLower(u.Hostname())
	if host == "api.anthropic.com" {
		return "provider-api"
	}
	if host == "cast.ai" || strings.HasSuffix(host, ".cast.ai") || host == "kimchi.dev" || strings.HasSuffix(host, ".kimchi.dev") {
		return "castai"
	}
	if host != "" {
		return "customer-gateway"
	}
	return "unknown"
}

func requestEntity(response, request string) string {
	if request != "" {
		return "request:" + request
	}
	return "response:" + response
}

// Native request IDs join the supplementary stream to transcript recovery.
// An absent ID cannot be replaced by a time/model/token similarity match.
func (r *Recorder) telemetry(s scope, e Object, observedRoute, basis string) error {
	a := obj(e["attributes"])
	if str(e, "event") != "api_request" && str(a, "event.name") != "api_request" {
		return nil
	}
	request := str(a, "request_id")
	if request == "" {
		r.Store.Diagnostic("telemetry_request_identity_missing")
		return nil
	}
	s.Turn = ""
	if prompt := str(a, "prompt.id"); prompt != "" {
		_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "prompt-turn:"+s.Session+":"+prompt).Scan(&s.Turn)
	}
	work := r.work(s)
	correlation := "session_only"
	if s.Turn != "" {
		work = r.workExact(s)
		correlation = "native_prompt_id"
	}
	event := r.event(s, requestEntity("", request), work)
	var body []byte
	if r.Store.DB.QueryRow(`SELECT body FROM events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1`, event.EntityID).Scan(&body) == nil {
		var old protocol.Event
		if json.Unmarshal(body, &old) == nil && old.Usage != nil && old.Usage.Channel == "transcript" {
			return nil
		}
	}
	at, err := time.Parse(time.RFC3339Nano, str(a, "event.timestamp"))
	if err != nil {
		return err
	}
	event.ObservedAt = at
	raw := protocol.RawUsage{Input: integer(a["input_tokens"]), Output: integer(a["output_tokens"]), CacheRead: integer(a["cache_read_tokens"]), CacheWrite: integer(a["cache_creation_tokens"])}
	for key, ttl := range map[string]int32{"cache_creation_5m_tokens": 300, "cache_creation_1h_tokens": 3600} {
		if n := integer(a[key]); n != nil {
			raw.CacheWrites = append(raw.CacheWrites, protocol.CacheWrite{TTLSeconds: ttl, Tokens: *n})
		}
	}
	sort.Slice(raw.CacheWrites, func(i, j int) bool { return raw.CacheWrites[i].TTLSeconds < raw.CacheWrites[j].TTLSeconds })
	u := &protocol.Usage{Channel: "telemetry", RequestID: request, Schema: "anthropic-messages-v1", CounterScope: "request", ObservedRoute: observedRoute, BillingBasis: basis, ReportedModel: str(a, "model"), Provider: "anthropic", Correlation: correlation, Raw: raw, DurationMS: integer(a["duration_ms"])}
	proxyAlias(u)
	event.Usage = u
	return r.Store.Observe(event)
}
func proxyAlias(u *protocol.Usage) {
	if u.ObservedRoute == "castai" && len(u.RequestID) == 36 {
		u.Aliases = []protocol.RequestAlias{{Namespace: "castai-request-id", ID: u.RequestID, Source: u.Channel}}
	}
}
