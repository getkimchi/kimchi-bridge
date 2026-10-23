package delivery

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

func TestOTLPPartialRetryHasSeparateReceiptAndNoCastCredentials(t *testing.T) {
	s, err := ledger.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e := protocol.Event{ID: protocol.NewID(), EntityID: protocol.NewID(), Revision: 1, Source: "codex", SourceVersion: "test", DeviceID: protocol.NewID(), ObservedAt: time.Now().UTC(), Coverage: &protocol.Coverage{Code: "test", Count: 1}}
	if err = s.Put(e); err != nil {
		t.Fatal(err)
	}
	var first string
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "" || r.Header.Get("Authorization") != "Bearer customer-only" {
			t.Error("export credentials crossed destinations")
		}
		body, _ := io.ReadAll(r.Body)
		if first != "" && first != string(body) {
			t.Error("retry changed normalized export")
		}
		first = string(body)
		var envelope map[string]any
		if json.Unmarshal(body, &envelope) != nil || envelope["resourceLogs"] == nil {
			t.Error("invalid OTLP JSON")
		}
		calls++
		if calls == 1 {
			io.WriteString(w, `{"partialSuccess":{"rejectedLogRecords":"1"}}`)
		} else {
			io.WriteString(w, `{}`)
		}
	}))
	defer server.Close()
	c := Config{APIURL: server.URL, OrganizationID: protocol.NewID(), APIKey: "cast-only-secret", OTLPURL: server.URL + "/v1/logs", OTLPHeaders: map[string]string{"Authorization": "Bearer customer-only"}}
	if _, err = FlushOTLP(t.Context(), s, c); err == nil {
		t.Fatal("partial export acknowledged")
	}
	if ok, err := FlushOTLP(t.Context(), s, c); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, err := FlushOTLP(t.Context(), s, c); err != nil || ok {
		t.Fatal("export repeated after receipt", ok, err)
	}
	status, _ := s.Status()
	if status["pending"] != int64(1) {
		t.Fatal("OTLP acknowledged Cast queue", status)
	}
}
