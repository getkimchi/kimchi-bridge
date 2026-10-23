package probe

import (
	"encoding/json"
	"fmt"
	"github.com/getkimchi/kimchi-adapters/protocol"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
)

type provider struct {
	root     string
	mu       sync.Mutex
	counts   map[string]int
	requests map[string][]map[string]any
	failures []string
}

func (p *provider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 2 {
		http.NotFound(w, r)
		return
	}
	arm := parts[0]
	if arm != "claude-baseline" && arm != "claude-capture" && arm != "codex-baseline" && arm != "codex-capture" {
		http.NotFound(w, r)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxRecord+1))
	if err != nil || len(data) > MaxRecord {
		http.Error(w, "bounded probe body", 413)
		return
	}
	var body map[string]any
	if err = json.Unmarshal(data, &body); err != nil {
		http.Error(w, "JSON required", 400)
		return
	}
	kind := "wire"
	if strings.Contains(r.URL.Path, "/otlp/") {
		kind = "otlp"
	}
	headers := map[string]string{}
	// Only synthetic routing/correlation headers, never authentication headers.
	for _, key := range []string{"content-type", "x-client-request-id", "x-request-id", "session_id", "conversation_id", "x-codex-turn-metadata", "traceparent"} {
		if v := r.Header.Get(key); v != "" {
			headers[key] = v
		}
	}
	if err = Save(filepath.Join(p.root, arm, kind), map[string]any{"path": r.URL.Path, "headers": headers, "body": body}); err != nil {
		p.failures = append(p.failures, "sink_persistence_failed")
		http.Error(w, "probe persistence failed", 500)
		return
	}
	if kind == "otlp" {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{}")
		return
	}
	// Real gateways return these correlation headers; validate what the official
	// clients actually preserve instead of treating omitted fixture headers as a gap.
	responseID := protocol.NewID()
	w.Header().Set("x-request-id", responseID)
	w.Header().Set("request-id", responseID)
	if err = Save(filepath.Join(p.root, arm, "response-ids"), map[string]any{"request_id": responseID, "path": r.URL.Path}); err != nil {
		p.failures = append(p.failures, "response_identity_persistence_failed")
	}
	if strings.HasSuffix(r.URL.Path, "/count_tokens") {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"input_tokens":11}`)
		return
	}
	if !strings.HasSuffix(r.URL.Path, "/messages") && !strings.HasSuffix(r.URL.Path, "/responses") {
		http.Error(w, "unexpected probe route", 404)
		return
	}
	p.counts[arm]++
	n := p.counts[arm]
	p.requests[arm] = append(p.requests[arm], body)
	if n > 6 {
		p.failures = append(p.failures, "unexpected_request_count")
		http.Error(w, "probe request bound", 429)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("x-request-id", fmt.Sprintf("fixture-request-%d", n))
	if strings.HasPrefix(arm, "claude") {
		claudeResponse(w, body, n)
	} else {
		codexResponse(w, body, n)
	}
}

func event(w http.ResponseWriter, name string, v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}
func claudeResponse(w http.ResponseWriter, body map[string]any, n int) {
	usage := map[string]any{"input_tokens": 11, "output_tokens": 0, "cache_creation_input_tokens": 7, "cache_read_input_tokens": 13, "cache_creation": map[string]any{"ephemeral_5m_input_tokens": 3, "ephemeral_1h_input_tokens": 4}}
	id := fmt.Sprintf("msg_fixture_%d", n)
	event(w, "message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": id, "type": "message", "role": "assistant", "model": body["model"], "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": usage}})
	var block, delta map[string]any
	stop := "tool_use"
	step := 1
	tools, _ := body["tools"].([]any)
	if len(tools) == 0 {
		step = 3
	}
	if messages, ok := body["messages"].([]any); ok {
		for _, message := range messages {
			m, _ := message.(map[string]any)
			blocks, _ := m["content"].([]any)
			for _, block := range blocks {
				b, _ := block.(map[string]any)
				if b["type"] == "tool_use" {
					if b["name"] == "Read" && step < 2 {
						step = 2
					}
					if b["name"] == "Edit" {
						step = 3
					}
				}
			}
		}
	}
	if step <= 2 {
		tool := "Read"
		input := map[string]any{"file_path": "probe.txt"}
		if step == 2 {
			tool = "Edit"
			input["old_string"] = "before"
			input["new_string"] = "after"
		}
		block = map[string]any{"type": "tool_use", "id": fmt.Sprintf("call_fixture_%d", step), "name": tool, "input": map[string]any{}}
		b, _ := json.Marshal(input)
		delta = map[string]any{"type": "input_json_delta", "partial_json": string(b)}
	} else {
		stop = "end_turn"
		block = map[string]any{"type": "text", "text": ""}
		delta = map[string]any{"type": "text_delta", "text": "done"}
	}
	event(w, "content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": block})
	event(w, "content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": delta})
	event(w, "content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	event(w, "message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil}, "usage": map[string]any{"output_tokens": 5}})
	event(w, "message_stop", map[string]any{"type": "message_stop"})
}
func codexResponse(w http.ResponseWriter, body map[string]any, n int) {
	id := fmt.Sprintf("resp_fixture_%d", n)
	event(w, "response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": id, "status": "in_progress", "output": []any{}}})
	var item map[string]any
	if n == 1 {
		// Use the execution tool actually advertised by the isolated fallback model.
		// Codex intercepts apply_patch invoked through its native execution path.
		args, _ := json.Marshal(map[string]any{"cmd": "apply_patch '*** Begin Patch\n*** Update File: probe.txt\n@@\n-before\n+after\n*** End Patch'", "login": false})
		item = map[string]any{"id": "item_fixture_1", "type": "function_call", "call_id": "call_fixture_1", "name": "exec_command", "arguments": string(args)}
	} else {
		item = map[string]any{"id": "item_fixture_done", "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "done", "annotations": []any{}}}}
	}
	event(w, "response.output_item.added", map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item})
	event(w, "response.output_item.done", map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item})
	usage := map[string]any{"input_tokens": 31, "output_tokens": 5, "total_tokens": 36, "input_tokens_details": map[string]any{"cached_tokens": 13}, "output_tokens_details": map[string]any{"reasoning_tokens": 2}}
	event(w, "response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"id": id, "status": "completed", "model": body["model"], "output": []any{item}, "usage": usage}})
}
