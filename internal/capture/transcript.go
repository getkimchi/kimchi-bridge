package capture

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/getkimchi/kimchi-adapters/protocol"
)

type transcript struct {
	Path  string `json:"path"`
	Scope scope  `json:"scope"`
	Route string `json:"route"`
	Basis string `json:"basis"`
}

func (r *Recorder) version(session, version string) error {
	if version == "" || len(version) > 64 || strings.ContainsAny(version, "\r\n\x00") {
		return errors.New("invalid source version")
	}
	_, err := r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value`, "source-version:"+r.Source+":"+session, version)
	return err
}
func (r *Recorder) transcriptVersion(session, path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	line, err := bufio.NewReader(io.LimitReader(f, 4<<20+1)).ReadBytes('\n')
	if err != nil || len(line) > 4<<20 {
		return
	}
	var meta Object
	if json.Unmarshal(line, &meta) == nil && str(meta, "type") == "session_meta" {
		if version := str(obj(meta["payload"]), "cli_version"); version != "" {
			_ = r.version(session, version)
		}
	}
}

func (r *Recorder) registerTranscript(s scope, path, route, basis string) error {
	if !filepath.IsAbs(path) || !strings.HasSuffix(path, ".jsonl") {
		return errors.New("invalid transcript path")
	}
	if route == "" {
		route = "unknown"
	}
	if basis == "" {
		basis = "unknown"
	}
	body, err := json.Marshal(transcript{path, s, route, basis})
	if err != nil {
		return err
	}
	_, err = r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, "transcript:"+r.Source+":"+path, string(body))
	return err
}

// Recover reads only native transcripts registered by hooks. It never uploads
// transcript text; only allowlisted identities, usage counters and dimensions.
func (r *Recorder) Recover() error {
	rows, err := r.Store.DB.Query(`SELECT value FROM meta WHERE key LIKE ?`, "transcript:"+r.Source+":%")
	if err != nil {
		return err
	}
	var items []transcript
	for rows.Next() {
		var b string
		if err = rows.Scan(&b); err != nil {
			rows.Close()
			return err
		}
		var t transcript
		if err = json.Unmarshal([]byte(b), &t); err != nil {
			rows.Close()
			return err
		}
		items = append(items, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var failures error
	for _, t := range items {
		if err = r.recoverFile(t); err != nil {
			r.Store.Diagnostic("transcript_recovery_failed")
			failures = errors.Join(failures, err)
		}
	}
	return failures
}
func (r *Recorder) recoverFile(t transcript) error {
	f, err := os.Open(t.Path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("not a transcript file")
	}
	var offset int64
	_ = r.Store.DB.QueryRow(`SELECT offset FROM cursors WHERE path=?`, t.Path).Scan(&offset)
	if info.Size() < offset {
		r.Store.Diagnostic("transcript_truncated")
		return errors.New("transcript was truncated")
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	reader := bufio.NewReaderSize(f, 64<<10)
	// Restore context at the cursor. A process can die between recording a request
	// and advancing its cursor; the stable observation identity makes replay safe.
	var contextBody string
	if r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "cursor-context:"+t.Path).Scan(&contextBody) == nil {
		_ = json.Unmarshal([]byte(contextBody), &t)
	}
	for consumed := int64(0); consumed < 32<<20; {
		line, e := reader.ReadBytes('\n')
		if len(line) > 4<<20 {
			return errors.New("transcript record exceeds bound")
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		consumed += int64(len(line))
		var record Object
		decoder := json.NewDecoder(strings.NewReader(string(line)))
		decoder.UseNumber()
		if err = decoder.Decode(&record); err != nil {
			return err
		}
		if err = r.consume(&t, record, offset); err != nil {
			return err
		}
		offset += int64(len(line))
		body, _ := json.Marshal(t)
		tx, e := r.Store.DB.Begin()
		if e != nil {
			return e
		}
		_, e = tx.Exec(`INSERT INTO cursors(path,offset) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset`, t.Path, offset)
		if e == nil {
			_, e = tx.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, "cursor-context:"+t.Path, string(body))
		}
		if e != nil {
			tx.Rollback()
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
	}
	return nil
}
func (r *Recorder) consume(t *transcript, v Object, offset int64) error {
	s := t.Scope
	if r.Source == "codex" && str(v, "type") == "session_meta" {
		if version := str(obj(v["payload"]), "cli_version"); version != "" {
			return r.version(s.Session, version)
		}
		return nil
	}
	// Native transcripts contain metadata without timestamps (e.g. atis-latch).
	// Require timestamps on accounting records, not unrelated native metadata.
	if r.Source == "claude-code" && str(v, "type") != "user" && str(v, "type") != "assistant" {
		return nil
	}
	if r.Source == "codex" && str(v, "type") != "turn_context" && !(str(v, "type") == "event_msg" && str(obj(v["payload"]), "type") == "token_count") {
		return nil
	}
	observed, _ := time.Parse(time.RFC3339Nano, str(v, "timestamp"))
	if observed.IsZero() {
		return errors.New("transcript timestamp missing")
	}
	if r.Source == "codex" {
		p := obj(v["payload"])
		if str(v, "type") == "turn_context" {
			t.Scope.Turn = str(p, "turn_id")
			_, err := r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, "model:"+t.Path, str(p, "model"))
			return err
		}
		if str(v, "type") != "event_msg" || str(p, "type") != "token_count" {
			return nil
		}
		info := obj(p["info"])
		raw := obj(info["last_token_usage"])
		total := obj(info["total_token_usage"])
		if raw == nil || total == nil {
			return nil
		}
		// Native logs currently omit a stable response ID. Only the transcript owns
		// charges; OTel/mod counters are supplementary, never a second contribution.
		key := "token-count:" + protocol.Hash(total)
		u := protocol.Usage{Channel: "transcript", Schema: "openai-responses-v1", CounterScope: "request", ObservedRoute: t.Route, BillingBasis: t.Basis, Correlation: "native_transcript_turn", Provider: "openai", Raw: openAIUsage(raw), AttemptsComplete: false}
		var model string
		_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "model:"+t.Path).Scan(&model)
		u.ReportedModel = model
		e := r.event(s, key, r.workExact(s))
		e.ObservedAt = observed
		e.Usage = &u
		if s.Turn == "" {
			u.Correlation = "session_only"
			r.Store.Diagnostic("usage_turn_missing")
		}
		return r.Store.Observe(e)
	}
	if str(v, "type") == "user" {
		if prompt := str(v, "promptId"); prompt != "" {
			var turn string
			_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "prompt-turn:"+s.Session+":"+prompt).Scan(&turn)
			t.Scope.Turn = turn
		}
		return nil
	}
	if str(v, "type") != "assistant" {
		return nil
	}
	m := obj(v["message"])
	raw := obj(m["usage"])
	response := str(m, "id")
	if raw == nil || response == "" {
		return nil
	}
	// An assistant message can appear in several streaming records. Its provider
	// message ID, rather than the JSONL line/fragment UUID, owns the accounting.
	u := protocol.Usage{Channel: "transcript", ResponseID: response, RequestID: str(v, "requestId"), Schema: "anthropic-messages-v1", CounterScope: "request", ObservedRoute: t.Route, BillingBasis: t.Basis, Correlation: "session_only", Provider: "anthropic", ReportedModel: str(m, "model"), ActualModel: str(m, "model"), ServiceTier: str(raw, "service_tier"), Region: str(raw, "inference_geo"), Raw: claudeUsage(raw), StopReason: str(m, "stop_reason"), AttemptsComplete: false}
	if iterations, ok := raw["iterations"].([]any); ok && len(iterations) > 0 {
		for i, item := range iterations {
			it := obj(item)
			id := str(it, "id")
			if id == "" {
				id = protocol.StableID(response, protocol.Hash(i))
			}
			u.Iterations = append(u.Iterations, protocol.Iteration{ID: id, Model: str(it, "model"), Schema: u.Schema, Raw: claudeUsage(obj(it["usage"])), StopReason: str(it, "stop_reason"), BillingStatus: str(it, "billing_status")})
		}
	}
	// Transcript turn association is captured while streaming. A late reader
	// cannot assign all old messages to the session's current turn.
	work := ""
	if s.Agent != "" {
		work = r.work(s)
		if work != "" {
			u.Correlation = "inherited_agent_work"
		}
	}
	var turn string
	_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "response-turn:"+s.Session+":"+response).Scan(&turn)
	if turn != "" {
		s.Turn = turn
	}
	if s.Turn != "" {
		work = r.workExact(s)
		u.Correlation = "native_transcript_prompt"
	}
	proxyAlias(&u)
	e := r.event(s, requestEntity(response, u.RequestID), work)
	e.ObservedAt = observed
	e.Usage = &u
	if err := r.Store.Observe(e); err != nil {
		return err
	}
	if content, ok := m["content"].([]any); ok {
		for _, part := range content {
			block := obj(part)
			if str(block, "type") == "tool_use" {
				if err := r.attachToolRequest(s, str(block, "id"), e.EntityID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (r *Recorder) attachToolRequest(s scope, call, request string) error {
	if call == "" {
		return nil
	}
	key := "tool-request:" + r.Source + ":" + s.Session + ":" + call
	var previous string
	if err := r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&previous); err == nil && previous != request {
		request = ""
		r.Store.Diagnostic("tool_request_identity_conflict")
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, request); err != nil {
		return err
	}
	entity := r.event(s, "tool:"+call, "").EntityID
	var body []byte
	err := r.Store.DB.QueryRow(`SELECT body FROM events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1`, entity).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var event protocol.Event
	if err = json.Unmarshal(body, &event); err != nil {
		return err
	}
	if event.Tool == nil {
		return nil
	}
	event.Tool.RequestEntityID = request
	return r.Store.Observe(event)
}

func claudeUsage(v Object) protocol.RawUsage {
	u := protocol.RawUsage{Input: integer(v["input_tokens"]), Output: integer(v["output_tokens"]), CacheRead: integer(v["cache_read_input_tokens"]), CacheWrite: integer(v["cache_creation_input_tokens"])}
	writes := obj(v["cache_creation"])
	for key, ttl := range map[string]int32{"ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 3600} {
		if n := integer(writes[key]); n != nil {
			u.CacheWrites = append(u.CacheWrites, protocol.CacheWrite{TTLSeconds: ttl, Tokens: *n})
		}
	}
	sort.Slice(u.CacheWrites, func(i, j int) bool { return u.CacheWrites[i].TTLSeconds < u.CacheWrites[j].TTLSeconds })
	return u
}
func openAIUsage(v Object) protocol.RawUsage {
	u := protocol.RawUsage{Input: integer(v["input_tokens"]), Output: integer(v["output_tokens"]), CacheRead: integer(v["cached_input_tokens"]), CacheWrite: integer(v["cache_write_input_tokens"]), Reasoning: integer(v["reasoning_output_tokens"])}
	details := obj(v["cache_write_tokens_details"])
	for key, ttl := range map[string]int32{"ttl_30m_tokens": 1800, "ttl_12h_tokens": 43200} {
		if n := integer(details[key]); n != nil {
			u.CacheWrites = append(u.CacheWrites, protocol.CacheWrite{TTLSeconds: ttl, Tokens: *n})
		}
	}
	sort.Slice(u.CacheWrites, func(i, j int) bool { return u.CacheWrites[i].TTLSeconds < u.CacheWrites[j].TTLSeconds })
	return u
}
