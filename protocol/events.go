// Package protocol defines the content-free client/server accounting contract.
package protocol

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const Version = 1

type Repository struct {
	Provider string `json:"provider"`
	Host     string `json:"host"`
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
}

// Event deliberately has no prompt, path, diff, tool-argument or credential field.
// Native identities are optional: their absence must never be hidden by a guess.
type Event struct {
	ID            string       `json:"id"`
	EntityID      string       `json:"entityId"`
	Revision      int64        `json:"revision,string"`
	BaseRevision  int64        `json:"baseRevision,omitempty,string"`
	BaseHash      string       `json:"baseHash,omitempty"`
	Source        string       `json:"source"`
	SourceVersion string       `json:"sourceVersion"`
	DeviceID      string       `json:"deviceId"`
	ObservedAt    time.Time    `json:"observeTime"`
	Repository    *Repository  `json:"repository,omitempty"`
	WorkID        string       `json:"workId,omitempty"`
	SessionID     string       `json:"sessionId,omitempty"`
	TurnID        string       `json:"turnId,omitempty"`
	AgentID       string       `json:"agentId,omitempty"`
	Work          *Work        `json:"work,omitempty"`
	Usage         *Usage       `json:"usage,omitempty"`
	Tool          *Tool        `json:"tool,omitempty"`
	File          *File        `json:"file,omitempty"`
	Commit        *Commit      `json:"commit,omitempty"`
	PullRequest   *PullRequest `json:"pullRequest,omitempty"`
	Link          *Link        `json:"link,omitempty"`
	Coverage      *Coverage    `json:"coverage,omitempty"`
}

type Work struct {
	Title        string     `json:"title,omitempty"`
	PlanID       string     `json:"planId,omitempty"`
	PlanRevision string     `json:"planRevision,omitempty"`
	Reason       string     `json:"reason"`
	Quality      string     `json:"quality"`
	IssueKeys    []IssueKey `json:"issueKeys,omitempty"`
}

type IssueKey struct {
	Key      string `json:"key"`
	Source   string `json:"source"`
	Revision int64  `json:"revision,omitempty,string"`
}

type RawUsage struct {
	Input       *int64       `json:"inputTokens,omitempty,string"`
	Output      *int64       `json:"outputTokens,omitempty,string"`
	CacheRead   *int64       `json:"cacheReadTokens,omitempty,string"`
	CacheWrite  *int64       `json:"cacheWriteTokens,omitempty,string"`
	CacheWrites []CacheWrite `json:"cacheWrites,omitempty"`
	Reasoning   *int64       `json:"reasoningTokens,omitempty,string"`
}

type CacheWrite struct {
	TTLSeconds int32 `json:"ttlSeconds"`
	Tokens     int64 `json:"tokens,string"`
}

type Iteration struct {
	ID            string   `json:"id"`
	Model         string   `json:"model,omitempty"`
	Schema        string   `json:"schema"`
	Raw           RawUsage `json:"raw"`
	StopReason    string   `json:"stopReason,omitempty"`
	BillingStatus string   `json:"billingStatus,omitempty"`
}

type Credit struct {
	Amount string `json:"amount"`
	Unit   string `json:"unit"`
	Basis  string `json:"basis"`
}

type Usage struct {
	Channel          string         `json:"channel"`
	RequestID        string         `json:"requestId,omitempty"`
	ResponseID       string         `json:"responseId,omitempty"`
	Schema           string         `json:"schema"`
	CounterScope     string         `json:"counterScope"`
	ObservedRoute    string         `json:"observedRoute"`
	ReportedModel    string         `json:"reportedModel,omitempty"`
	ActualModel      string         `json:"actualModel,omitempty"`
	Provider         string         `json:"provider,omitempty"`
	ServiceTier      string         `json:"serviceTier,omitempty"`
	Region           string         `json:"region,omitempty"`
	BillingBasis     string         `json:"billingBasis"`
	Correlation      string         `json:"correlation"`
	Raw              RawUsage       `json:"raw"`
	Iterations       []Iteration    `json:"iterations,omitempty"`
	FinalIterationID string         `json:"finalIterationId,omitempty"`
	AttemptsComplete bool           `json:"attemptsComplete"`
	StopReason       string         `json:"stopReason,omitempty"`
	BillingStatus    string         `json:"billingStatus,omitempty"`
	DurationMS       *int64         `json:"durationMs,omitempty,string"`
	Credits          []Credit       `json:"credits,omitempty"`
	Aliases          []RequestAlias `json:"aliases,omitempty"`
}

// Aliases are observed response/request identities. A client cannot assert an
// owned proxy bill: the server resolves and verifies a supported alias itself.
type RequestAlias struct {
	Namespace string `json:"namespace"`
	ID        string `json:"id"`
	Source    string `json:"source"`
}

type Tool struct {
	CallID          string `json:"callId"`
	Name            string `json:"name,omitempty"`
	RequestEntityID string `json:"requestEntityId,omitempty"`
	Category        string `json:"category"`
	Outcome         string `json:"outcome"`
	DurationMS      int64  `json:"durationMs,omitempty,string"`
}

type File struct {
	FileID         string `json:"fileId"`
	ToolCallID     string `json:"toolCallId,omitempty"`
	BeforeRevision string `json:"beforeRevision,omitempty"`
	AfterRevision  string `json:"afterRevision,omitempty"`
	Operation      string `json:"operation"`
	Quality        string `json:"quality"`
}

type Commit struct {
	ID      string   `json:"id"`
	Parents []string `json:"parents,omitempty"`
	Quality string   `json:"quality"`
}

type PullRequest struct {
	ID            string     `json:"id"`
	Number        int32      `json:"number"`
	URL           string     `json:"uri"`
	State         string     `json:"state"`
	CreatedAt     *time.Time `json:"createTime,omitempty"`
	ClosedAt      *time.Time `json:"closeTime,omitempty"`
	MergedAt      *time.Time `json:"mergeTime,omitempty"`
	MergeCommitID string     `json:"mergeCommitId,omitempty"`
	Title         string     `json:"title,omitempty"`
	IssueKeys     []IssueKey `json:"issueKeys,omitempty"`
}

type Link struct {
	FromKind string `json:"fromKind"`
	FromID   string `json:"fromId"`
	ToKind   string `json:"toKind"`
	ToID     string `json:"toId"`
	Quality  string `json:"quality"`
	Reason   string `json:"reason"`
}

type Coverage struct {
	Code          string     `json:"code"`
	Count         int64      `json:"count,string"`
	WindowStart   *time.Time `json:"windowStartTime,omitempty"`
	WindowEnd     *time.Time `json:"windowEndTime,omitempty"`
	ObservedUsage *RawUsage  `json:"observedUsage,omitempty"`
	Model         string     `json:"model,omitempty"`
}

type Batch struct {
	Version int     `json:"version"`
	ID      string  `json:"id"`
	Events  []Event `json:"events"`
}

type Receipt struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Revision int64  `json:"revision,string"`
}

type Acknowledgement struct {
	BatchID    string    `json:"batchId"`
	ReceivedAt time.Time `json:"receiveTime"`
	Generation int64     `json:"generation,string"`
	Receipts   []Receipt `json:"receipts"`
}

func (e Event) Kind() string {
	switch {
	case e.Work != nil:
		return "work"
	case e.Usage != nil:
		return "usage"
	case e.Tool != nil:
		return "tool"
	case e.File != nil:
		return "file"
	case e.Commit != nil:
		return "commit"
	case e.PullRequest != nil:
		return "pull_request"
	case e.Link != nil:
		return "link"
	case e.Coverage != nil:
		return "coverage"
	default:
		return ""
	}
}

func (e Event) Validate() error {
	if e.ID == "" || e.EntityID == "" || e.DeviceID == "" || e.Revision < 1 || e.ObservedAt.IsZero() ||
		(e.Source != "claude-code" && e.Source != "codex" && e.Source != "collector") {
		return errors.New("missing event identity")
	}
	count := 0
	for _, present := range []bool{e.Work != nil, e.Usage != nil, e.Tool != nil, e.File != nil, e.Commit != nil, e.PullRequest != nil, e.Link != nil, e.Coverage != nil} {
		if present {
			count++
		}
	}
	if count != 1 {
		return errors.New("exactly one typed event is required")
	}
	if e.BaseRevision != e.Revision-1 || (e.Revision > 1 && e.BaseHash == "") {
		return errors.New("invalid revision chain")
	}
	for _, id := range []string{e.ID, e.EntityID, e.DeviceID, e.WorkID, e.SessionID, e.TurnID, e.AgentID} {
		if len(id) > 128 || strings.ContainsAny(id, "\r\n\x00") {
			return errors.New("invalid identity")
		}
	}
	b, err := json.Marshal(e)
	if err != nil || len(b) > 65536 {
		return errors.New("event exceeds bound")
	}
	return e.validateDetails()
}

func (b Batch) Validate() error {
	if b.Version != Version || b.ID == "" || len(b.ID) > 128 || len(b.Events) == 0 || len(b.Events) > 500 {
		return errors.New("invalid batch")
	}
	seen := map[string]bool{}
	for _, e := range b.Events {
		if err := e.Validate(); err != nil {
			return fmt.Errorf("event %s: %w", e.ID, err)
		}
		if seen[e.ID] {
			return errors.New("duplicate event in batch")
		}
		seen[e.ID] = true
	}
	return nil
}

func Hash(value any) string {
	b, _ := json.Marshal(value)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func StableID(parts ...string) string {
	b, _ := json.Marshal(parts)
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}
