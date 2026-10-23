package protocol

import (
	"errors"
	"net/url"
	"slices"
	"strings"
	"unicode"
)

func bounded(s string, max int) bool {
	if len(s) > max {
		return false
	}
	for _, c := range s {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}
func opaque(s string) bool { return bounded(s, 128) && !strings.ContainsAny(s, "/\\@?#|") }
func quality(s string) bool {
	return slices.Contains([]string{"observed", "inferred", "confirmed", "tool_observed", "ambiguous", "unknown"}, s)
}
func rawValid(u RawUsage) bool {
	for _, v := range []*int64{u.Input, u.Output, u.CacheRead, u.CacheWrite, u.Reasoning} {
		if v != nil && (*v < 0 || *v > 1_000_000_000_000) {
			return false
		}
	}
	if len(u.CacheWrites) > 16 {
		return false
	}
	ttls := map[int32]bool{}
	var writes int64
	for _, w := range u.CacheWrites {
		if w.TTLSeconds < 1 || w.TTLSeconds > 86400 || w.Tokens < 0 || w.Tokens > 1_000_000_000_000 || ttls[w.TTLSeconds] {
			return false
		}
		ttls[w.TTLSeconds] = true
		writes += w.Tokens
	}
	return (u.CacheWrite == nil || writes <= *u.CacheWrite) && (u.Reasoning == nil || u.Output == nil || *u.Reasoning <= *u.Output)
}
func issueValid(keys []IssueKey) bool {
	if len(keys) > 20 {
		return false
	}
	for _, v := range keys {
		parts := strings.Split(v.Key, "-")
		if len(parts) != 2 || len(parts[0]) < 1 || len(parts[0]) > 32 || len(parts[1]) < 1 || len(parts[1]) > 20 || !slices.Contains([]string{"work", "branch", "title", "commit", "explicit"}, v.Source) || v.Revision < 0 {
			return false
		}
		for i, c := range parts[0] {
			if !(c >= 'A' && c <= 'Z') && !(i > 0 && c >= '0' && c <= '9') {
				return false
			}
		}
		for _, c := range parts[1] {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}

func (e Event) validateDetails() error {
	invalid := errors.New("invalid typed event evidence")
	if !bounded(e.SourceVersion, 64) || e.SourceVersion == "" {
		return invalid
	}
	if e.Repository != nil {
		r := e.Repository
		if !slices.Contains([]string{"github", "gitlab"}, r.Provider) || !bounded(r.Host, 253) || strings.ContainsAny(r.Host, "/\\@?#| :") || r.Host == "" || !opaque(r.ID) || r.ID == "" || !bounded(r.Name, 256) || strings.ContainsAny(r.Name, "@?#|\\") {
			return invalid
		}
	}
	switch {
	case e.Work != nil:
		w := e.Work
		if !bounded(w.Title, 512) || !opaque(w.PlanID) || !opaque(w.PlanRevision) || !bounded(w.Reason, 64) || !quality(w.Quality) || !issueValid(w.IssueKeys) {
			return invalid
		}
	case e.Usage != nil:
		u := e.Usage
		if !rawValid(u.Raw) || !slices.Contains([]string{"request", "cumulative"}, u.CounterScope) || !slices.Contains([]string{"api", "subscription", "credits", "gateway", "unknown"}, u.BillingBasis) || !bounded(u.ObservedRoute, 253) || strings.ContainsAny(u.ObservedRoute, "@?#\r\n") || !bounded(u.ReportedModel, 128) || !bounded(u.ActualModel, 128) || !bounded(u.Provider, 64) || !bounded(u.ServiceTier, 64) || !bounded(u.Region, 64) || !opaque(u.RequestID) || !opaque(u.ResponseID) || !bounded(u.Channel, 64) || !bounded(u.Correlation, 64) || !bounded(u.Schema, 64) || !bounded(u.StopReason, 64) || !bounded(u.BillingStatus, 64) || len(u.Iterations) > 16 || len(u.Aliases) > 8 || len(u.Credits) > 16 {
			return invalid
		}
		if u.DurationMS != nil && (*u.DurationMS < 0 || *u.DurationMS > 86_400_000) {
			return invalid
		}
		for _, it := range u.Iterations {
			if !opaque(it.ID) || !rawValid(it.Raw) || !bounded(it.Model, 128) || !bounded(it.Schema, 64) || !bounded(it.BillingStatus, 64) || !bounded(it.StopReason, 64) {
				return invalid
			}
		}
		for _, a := range u.Aliases {
			if !slices.Contains([]string{"castai-request-id", "provider-request-id", "provider-response-id"}, a.Namespace) || !opaque(a.ID) || a.ID == "" || !slices.Contains([]string{"mod", "transcript", "telemetry"}, a.Source) {
				return invalid
			}
		}
		for _, c := range u.Credits {
			if c.Amount == "" || !bounded(c.Amount, 64) || !bounded(c.Unit, 32) || !bounded(c.Basis, 64) {
				return invalid
			}
			points := 0
			for _, v := range c.Amount {
				if v == '.' {
					points++
				} else if v < '0' || v > '9' {
					return invalid
				}
			}
			if points > 1 {
				return invalid
			}
		}
	case e.Tool != nil:
		t := e.Tool
		if !bounded(t.Name, 128) || !opaque(t.RequestEntityID) {
			return invalid
		}
		if !opaque(t.CallID) || t.CallID == "" || !slices.Contains([]string{"read", "edit", "shell", "plan", "other"}, t.Category) || !slices.Contains([]string{"completed", "failed", "interrupted"}, t.Outcome) || t.DurationMS < 0 || t.DurationMS > 86_400_000 {
			return invalid
		}
	case e.File != nil:
		f := e.File
		if !opaque(f.FileID) || f.FileID == "" || !opaque(f.BeforeRevision) || !opaque(f.AfterRevision) || !opaque(f.ToolCallID) || !quality(f.Quality) || !slices.Contains([]string{"created", "modified", "deleted", "renamed", "read"}, f.Operation) {
			return invalid
		}
	case e.Commit != nil:
		c := e.Commit
		if !gitID(c.ID) || len(c.Parents) > 16 || !quality(c.Quality) {
			return invalid
		}
		for _, parent := range c.Parents {
			if !gitID(parent) {
				return invalid
			}
		}
	case e.PullRequest != nil:
		p := e.PullRequest
		u, err := url.Parse(p.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || e.Repository == nil || !strings.EqualFold(u.Hostname(), e.Repository.Host) || !opaque(p.ID) || p.ID == "" || p.Number <= 0 || !slices.Contains([]string{"open", "closed", "merged"}, p.State) || !bounded(p.Title, 512) || !issueValid(p.IssueKeys) {
			return invalid
		}
		if p.MergeCommitID != "" && !gitID(p.MergeCommitID) {
			return invalid
		}
	case e.Link != nil:
		l := e.Link
		if !slices.Contains([]string{"work", "commit", "pull_request", "usage", "file"}, l.FromKind) || !slices.Contains([]string{"work", "commit", "pull_request", "usage", "file"}, l.ToKind) || !opaque(l.FromID) || l.FromID == "" || !opaque(l.ToID) || l.ToID == "" || !quality(l.Quality) || !bounded(l.Reason, 64) {
			return invalid
		}
	case e.Coverage != nil:
		c := e.Coverage
		if c.Code == "" || !opaque(c.Code) || c.Count < 1 || !bounded(c.Model, 128) || (c.ObservedUsage != nil && !rawValid(*c.ObservedUsage)) {
			return invalid
		}
		if c.WindowStart != nil && c.WindowEnd != nil && c.WindowEnd.Before(*c.WindowStart) {
			return invalid
		}
	}
	return nil
}
func gitID(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'f') && !(c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
