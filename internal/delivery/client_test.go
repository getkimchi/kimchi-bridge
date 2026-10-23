package delivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

func TestLostResponseRetriesIdenticalBatch(t *testing.T) {
	s, err := ledger.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e := protocol.Event{ID: protocol.NewID(), EntityID: protocol.NewID(), Revision: 1, DeviceID: protocol.NewID(), Source: "codex", SourceVersion: "test", ObservedAt: time.Now().UTC(), Coverage: &protocol.Coverage{Code: "fixture", Count: 1}}
	if err = s.Put(e); err != nil {
		t.Fatal(err)
	}
	var first string
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Batch protocol.Batch `json:"batch"`
		}
		if err = json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if r.Header.Get("X-API-Key") != "test-reporting-key" {
			t.Error("missing reporting identity")
		}
		hash := protocol.Hash(body.Batch)
		if first != "" && first != hash {
			t.Error("retry altered batch")
		}
		first = hash
		calls++
		if calls == 1 {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(protocol.Acknowledgement{BatchID: body.Batch.ID, Receipts: []protocol.Receipt{{ID: e.ID, Revision: 1, Status: "unchanged"}}})
	}))
	defer server.Close()
	c := Config{APIURL: server.URL, OrganizationID: protocol.NewID(), ActorID: protocol.NewID(), APIKey: "test-reporting-key", Enabled: true}
	c.CredentialHash = c.credentialHash()
	if _, err = Flush(context.Background(), s, c); err == nil {
		t.Fatal("failed response acknowledged")
	}
	if ok, err := Flush(context.Background(), s, c); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if calls != 2 {
		t.Fatal(calls)
	}
}

func TestConfigureVerifiesUserAndCredentialRotation(t *testing.T) {
	actor := protocol.NewID()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/me" || r.Header.Get("X-API-Key") != "key" {
			t.Error("unexpected identity lookup")
		}
		json.NewEncoder(w).Encode(map[string]string{"id": actor, "username": "auth0|fixture", "email": "ignored@example.invalid", "readmeIoJwt": "never-persist"})
	}))
	defer server.Close()
	c, err := Authenticate(t.Context(), Config{APIURL: server.URL + "/", OrganizationID: protocol.NewID(), APIKey: "key"})
	if err != nil || c.ActorID != actor || c.Ready() != nil {
		t.Fatal(c.ActorID, err)
	}
	c.APIKey = "a-different-user-key"
	if c.Ready() == nil {
		t.Fatal("unverified replacement credential can reuse prior user's queue")
	}
}

func TestSizeSplitsPreserveRevisionsAcrossNestedSplitsAndLostACK(t *testing.T) {
	for _, acceptLarge := range []bool{false, true} {
		t.Run(map[bool]string{false: "size-refusal", true: "original-was-accepted"}[acceptLarge], func(t *testing.T) {
			s, err := ledger.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			e := protocol.Event{EntityID: protocol.NewID(), Source: "codex", SourceVersion: "test", DeviceID: protocol.NewID(), ObservedAt: time.Now().UTC()}
			for i := int64(1); i <= 8; i++ {
				e.Coverage = &protocol.Coverage{Code: "counter", Count: i}
				if err = s.Observe(e); err != nil {
					t.Fatal(err)
				}
			}
			seen := map[string]string{}
			last := int64(0)
			lost := false
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Batch protocol.Batch `json:"batch"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				b := body.Batch
				calls++
				ack := protocol.Acknowledgement{BatchID: b.ID}
				if len(b.Events) <= 2 || acceptLarge {
					for _, e := range b.Events {
						status := "unchanged"
						if old, ok := seen[e.ID]; ok {
							if old != protocol.Hash(e) {
								t.Error("split altered event")
							}
						} else {
							if e.BaseRevision != last {
								t.Errorf("out-of-order revisions: base %d, stored %d", e.BaseRevision, last)
								w.WriteHeader(409)
								return
							}
							seen[e.ID] = protocol.Hash(e)
							last = e.Revision
							status = "accepted"
						}
						ack.Receipts = append(ack.Receipts, protocol.Receipt{ID: e.ID, Revision: e.Revision, Status: status})
					}
				}
				if len(b.Events) > 2 {
					w.WriteHeader(413)
					return
				}
				if !lost {
					lost = true
					w.WriteHeader(503)
					return
				}
				json.NewEncoder(w).Encode(ack)
			}))
			defer server.Close()
			c := Config{APIURL: server.URL, OrganizationID: protocol.NewID(), ActorID: protocol.NewID(), APIKey: "key", Enabled: true}
			c.CredentialHash = c.credentialHash()
			finished := false
			for i := 0; i < 64; i++ {
				progress, err := Flush(t.Context(), s, c)
				if err != nil {
					continue
				}
				if !progress {
					finished = true
					break
				}
			}
			if !finished || len(seen) != 8 || last != 8 || calls < 4 {
				t.Fatal(finished, len(seen), last, calls)
			}
			status, _ := s.Status()
			if status["pending"] != int64(0) {
				t.Fatal(status)
			}
		})
	}
}

func TestRejectUntrustedTransport(t *testing.T) {
	for _, u := range []string{"http://example.com", "https://secret@example.com", "https://example.com?token=secret"} {
		if (Config{APIURL: u, OrganizationID: "org", APIKey: "key"}).Validate() == nil {
			t.Fatal(u)
		}
	}
}
