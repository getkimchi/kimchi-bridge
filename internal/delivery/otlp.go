package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

// Export normalized logs only. Cast credentials and native telemetry bodies
// never enter the customer's exporter. Delivery is independently at least once.
func FlushOTLP(ctx context.Context, s *ledger.Store, c Config) (bool, error) {
	if c.OTLPURL == "" {
		return false, nil
	}
	if err := c.Validate(); err != nil {
		return false, err
	}
	target := protocol.Hash([]any{c.OTLPURL, c.OTLPHeaders})
	rows, err := s.DB.QueryContext(ctx, `SELECT id,body FROM events e WHERE NOT EXISTS(SELECT 1 FROM export_receipts r WHERE r.target=? AND r.event_id=e.id) ORDER BY e.created_at,e.rowid LIMIT 100`, target)
	if err != nil {
		return false, err
	}
	var ids []string
	var records []any
	for rows.Next() {
		var id string
		var body []byte
		if err = rows.Scan(&id, &body); err != nil {
			rows.Close()
			return false, err
		}
		var e protocol.Event
		if err = json.Unmarshal(body, &e); err != nil {
			rows.Close()
			return false, err
		}
		ids = append(ids, id)
		records = append(records, map[string]any{"timeUnixNano": strconv.FormatInt(e.ObservedAt.UnixNano(), 10), "body": map[string]string{"stringValue": string(body)}, "attributes": []any{
			map[string]any{"key": "event.id", "value": map[string]string{"stringValue": id}},
			map[string]any{"key": "event.entity_id", "value": map[string]string{"stringValue": e.EntityID}},
			map[string]any{"key": "event.revision", "value": map[string]string{"intValue": strconv.FormatInt(e.Revision, 10)}},
		}})
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(ids) == 0 {
		return false, err
	}
	payload, err := json.Marshal(map[string]any{"resourceLogs": []any{map[string]any{"resource": map[string]any{"attributes": []any{map[string]any{"key": "service.name", "value": map[string]string{"stringValue": "kimchi-adapters"}}}}, "scopeLogs": []any{map[string]any{"scope": map[string]string{"name": "getkimchi.work", "version": "1"}, "logRecords": records}}}}})
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.OTLPURL, bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	for k, v := range c.OTLPHeaders {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := reportingClient().Do(req)
	if err != nil {
		return false, errors.New("OTLP endpoint unavailable; records retained")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("OTLP returned HTTP %d; records retained", resp.StatusCode)
	}
	var result struct {
		PartialSuccess struct {
			Rejected json.Number `json:"rejectedLogRecords"`
		} `json:"partialSuccess"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 64<<10))
	decoder.UseNumber()
	if err = decoder.Decode(&result); err != nil && err != io.EOF {
		return false, errors.New("invalid OTLP response")
	}
	if n := string(result.PartialSuccess.Rejected); n != "" && n != "0" {
		return false, errors.New("OTLP partially rejected records; batch retained")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	for _, id := range ids {
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO export_receipts(target,event_id) VALUES(?,?)`, target, id); err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}
