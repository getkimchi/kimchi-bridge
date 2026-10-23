package delivery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

type Config struct {
	APIURL         string            `json:"apiUrl"`
	OrganizationID string            `json:"organizationId"`
	AccessToken    string            `json:"accessToken,omitempty"`
	APIKey         string            `json:"apiKey,omitempty"`
	OTLPURL        string            `json:"otlpUrl,omitempty"`
	OTLPHeaders    map[string]string `json:"otlpHeaders,omitempty"`
	ActorID        string            `json:"actorId,omitempty"`
	CredentialHash string            `json:"credentialHash,omitempty"`
	Enabled        bool              `json:"enabled"`
}

func (c Config) Validate() error {
	if err := secureEndpoint(c.APIURL); err != nil {
		return err
	}
	if c.OTLPURL != "" {
		if err := secureEndpoint(c.OTLPURL); err != nil {
			return errors.New("OTLP endpoint requires HTTPS without URL credentials")
		}
	}
	if len(c.OTLPHeaders) > 16 {
		return errors.New("too many OTLP headers")
	}
	for k, v := range c.OTLPHeaders {
		if k == "" || len(k) > 64 || len(v) > 2048 || strings.ContainsAny(k+v, "\r\n\x00") {
			return errors.New("invalid OTLP header")
		}
		if strings.EqualFold(k, "Host") || strings.EqualFold(k, "Content-Length") || strings.EqualFold(k, "Transfer-Encoding") {
			return errors.New("reserved OTLP header")
		}
	}
	if !ValidID(c.OrganizationID) {
		return errors.New("invalid organization")
	}
	if c.AccessToken == "" && c.APIKey == "" {
		return errors.New("reporting login required")
	}
	if c.AccessToken != "" && c.APIKey != "" {
		return errors.New("provide one reporting credential")
	}
	return nil
}

func secureEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid reporting API URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return errors.New("reporting requires HTTPS")
	}
	return nil
}

func ValidID(id string) bool {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return false
	}
	b, err := hex.DecodeString(strings.ReplaceAll(id, "-", ""))
	if err != nil {
		return false
	}
	for _, v := range b {
		if v != 0 {
			return true
		}
	}
	return false
}

func (c Config) credentialHash() string {
	h := sha256.Sum256([]byte(c.AccessToken + "\x00" + c.APIKey))
	return hex.EncodeToString(h[:])
}
func (c Config) Ready() error {
	if err := c.Validate(); err != nil {
		return err
	}
	if !ValidID(c.ActorID) || c.CredentialHash != c.credentialHash() {
		return errors.New("run configure to verify this reporting user")
	}
	return nil
}
func authorize(req *http.Request, c Config) {
	if c.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.AccessToken)
	} else {
		req.Header.Set("X-API-Key", c.APIKey)
	}
}
func reportingClient() *http.Client {
	return &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// Reuse Cast's profile endpoint; credentials never select an old queue by guess.
func Authenticate(ctx context.Context, c Config) (Config, error) {
	if err := c.Validate(); err != nil {
		return c, err
	}
	c.APIURL = strings.TrimRight(c.APIURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.APIURL+"/v1/me", nil)
	if err != nil {
		return c, err
	}
	authorize(req, c)
	resp, err := reportingClient().Do(req)
	if err != nil {
		return c, errors.New("reporting identity endpoint unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return c, fmt.Errorf("reporting identity returned HTTP %d", resp.StatusCode)
	}
	var profile struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&profile); err != nil || !ValidID(profile.ID) || profile.Username == "" {
		return c, errors.New("reporting requires a verified Cast user")
	}
	c.ActorID = strings.ToLower(profile.ID)
	c.CredentialHash = c.credentialHash()
	return c, nil
}

// Flush reports progress after a complete durable receipt or a safe size split.
// Other failures retain the identical batch for retry.
func Flush(ctx context.Context, s *ledger.Store, c Config) (bool, error) {
	if !c.Enabled {
		return false, nil
	}
	if err := c.Ready(); err != nil {
		return false, err
	}
	b, err := s.PendingBatch(ctx)
	if err != nil || b == nil {
		return false, err
	}
	payload, err := json.Marshal(map[string]any{"batch": b})
	if err != nil {
		return false, err
	}
	u := strings.TrimRight(c.APIURL, "/") + "/ai-optimizer/v1beta/organizations/" + url.PathEscape(c.OrganizationID) + "/adapter-events:batchIngest"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	authorize(req, c)
	response, err := reportingClient().Do(req)
	if err != nil {
		s.Diagnostic("upload_network_failed")
		return false, errors.New("reporting endpoint unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusRequestEntityTooLarge {
		s.Diagnostic("upload_payload_split")
		if err = s.SplitBatch(*b); err != nil {
			return false, err
		}
		return true, nil
	}
	if response.StatusCode != http.StatusOK {
		// Do not put server bodies, request URLs or credentials in diagnostics.
		code := fmt.Sprintf("upload_http_%d", response.StatusCode)
		s.Diagnostic(code)
		return false, fmt.Errorf("reporting returned HTTP %d; batch retained", response.StatusCode)
	}
	var ack protocol.Acknowledgement
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err = decoder.Decode(&ack); err != nil {
		return false, errors.New("invalid reporting acknowledgement")
	}
	if err = s.Acknowledge(*b, ack); err != nil {
		return false, err
	}
	return true, nil
}
