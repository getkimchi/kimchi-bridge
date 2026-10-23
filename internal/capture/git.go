package capture

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/getkimchi/kimchi-adapters/protocol"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

var gitHash = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

type gitChange struct {
	Scope                             scope
	Source, Work, Path, Before, After string
	Refs                              []string
	CreatedAt                         time.Time
}
type trackedCommit struct {
	Scope       scope
	Source, SHA string
	CheckedAt   time.Time
	CreatedAt   time.Time
}

func (r *Recorder) saveMeta(key string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, string(b))
	return err
}
func refTips(root string) ([]string, bool) {
	out, err := git(root, "for-each-ref", "--format=%(objectname)", "--count=513")
	if err != nil {
		return nil, false
	}
	refs := strings.Fields(out)
	if len(refs) > 512 {
		return nil, false
	}
	if head, e := git(root, "rev-parse", "--verify", "HEAD"); e == nil {
		refs = append(refs, head)
	}
	slices.Sort(refs)
	return slices.Compact(refs), true
}

// Git discovery follows the existing Kimchi rule: exclude every ref visible
// before the edit, then require the exact parent -> child file transition.
// It remains inferred attribution; matching bytes do not prove process ownership.
func (r *Recorder) ReconcileGit(ctx context.Context) error {
	var last int64
	_ = r.Store.DB.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='git-last-pass'`).Scan(&last)
	if time.Now().Unix()-last < 60 {
		return nil
	}
	if _, err := r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES('git-last-pass',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, time.Now().Unix()); err != nil {
		return err
	}
	var after string
	_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key='git-pass-after'`).Scan(&after)
	rows, err := r.Store.DB.Query(`SELECT key,value FROM meta WHERE (key LIKE 'git-change:%' OR key LIKE 'tracked-commit:%') AND key>? ORDER BY key LIMIT 32`, after)
	if err != nil {
		return err
	}
	type row struct{ key, body string }
	var items []row
	for rows.Next() {
		var v row
		if err = rows.Scan(&v.key, &v.body); err != nil {
			rows.Close()
			return err
		}
		items = append(items, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(8 * time.Second)
	var failures error
	for _, v := range items {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().After(deadline) {
			r.Store.Diagnostic("git_reconciliation_budget_exceeded")
			break
		}
		if _, err = r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES('git-pass-after',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, v.key); err != nil {
			return err
		}
		if strings.HasPrefix(v.key, "tracked-commit:") {
			var c trackedCommit
			if err = json.Unmarshal([]byte(v.body), &c); err != nil {
				return err
			}
			if time.Since(c.CreatedAt) > 90*24*time.Hour {
				_, err = r.Store.DB.Exec(`DELETE FROM meta WHERE key=?`, v.key)
				if err != nil {
					return err
				}
				continue
			}
			if time.Since(c.CheckedAt) < 5*time.Minute {
				continue
			}
			c.CheckedAt = time.Now().UTC()
			if err = r.saveMeta(v.key, c); err != nil {
				return err
			}
			if err = r.discoverPRs(ctx, c); err != nil {
				r.Store.Diagnostic("scm_lookup_incomplete")
				failures = errors.Join(failures, err)
			}
			continue
		}
		if len(items) == 0 {
			_, err = r.Store.DB.Exec(`DELETE FROM meta WHERE key='git-pass-after'`)
			if err != nil {
				return err
			}
		}
		var change gitChange
		if err = json.Unmarshal([]byte(v.body), &change); err != nil {
			return err
		}
		if time.Since(change.CreatedAt) > 7*24*time.Hour {
			r.Store.Diagnostic("git_evidence_expired")
			_, err = r.Store.DB.Exec(`DELETE FROM meta WHERE key=?`, v.key)
			if err != nil {
				return err
			}
			continue
		}
		if err = r.matchCommits(change, deadline); err != nil {
			r.Store.Diagnostic("git_match_incomplete")
			failures = errors.Join(failures, err)
		}
	}
	return failures
}
func (r *Recorder) fileObject(hash, format string) (string, error) {
	if hash == "" {
		return "", nil
	}
	b, err := os.ReadFile(filepath.Join(r.Store.Dir, "blobs", hash))
	if err != nil {
		return "", err
	}
	header := []byte(fmt.Sprintf("blob %d\x00", len(b)))
	header = append(header, b...)
	if format == "sha1" {
		h := sha1.Sum(header)
		return hex.EncodeToString(h[:]), nil
	}
	if format == "sha256" {
		h := sha256.Sum256(header)
		return hex.EncodeToString(h[:]), nil
	}
	return "", errors.New("unsupported git object format")
}
func treeObject(root, commit, path string) (string, error) {
	out, err := git(root, "ls-tree", "-z", commit, "--", path)
	if err != nil {
		return "", err
	}
	if out == "" {
		return "", nil
	}
	fields := strings.Fields(strings.SplitN(out, "\t", 2)[0])
	if len(fields) != 3 || fields[1] != "blob" || !gitHash.MatchString(fields[2]) {
		return "", errors.New("not an ordinary file blob")
	}
	return fields[2], nil
}
func (r *Recorder) matchCommits(c gitChange, deadline time.Time) error {
	root := c.Scope.CWD
	format, err := git(root, "rev-parse", "--show-object-format")
	if err != nil {
		return err
	}
	before, err := r.fileObject(c.Before, format)
	if err != nil {
		return err
	}
	after, err := r.fileObject(c.After, format)
	if err != nil {
		return err
	}
	path, err := filepath.Rel(root, c.Path)
	if err != nil || !within(root, c.Path) {
		return errors.New("file is outside its captured repository")
	}
	args := []string{"rev-list", "--all", "--max-count=129", "--not"}
	args = append(args, c.Refs...)
	out, err := git(root, args...)
	if err != nil {
		return err
	}
	commits := strings.Fields(out)
	if len(commits) > 128 {
		r.Store.Diagnostic("git_history_bound")
		commits = commits[:128]
	}
	recorder := *r
	recorder.Source = c.Source
	for _, sha := range commits {
		if time.Now().After(deadline) {
			return errors.New("git matching budget exceeded")
		}
		if !gitHash.MatchString(sha) {
			return errors.New("invalid commit identity")
		}
		object, err := treeObject(root, sha, path)
		if err != nil {
			return err
		}
		if object != after {
			continue
		}
		parents, err := git(root, "show", "--format=%P", "--no-patch", sha)
		if err != nil {
			return err
		}
		parentIDs := strings.Fields(parents)
		matched := len(parentIDs) == 0 && before == ""
		for _, parent := range parentIDs {
			object, err = treeObject(root, parent, path)
			if err != nil {
				return err
			}
			matched = matched || object == before
		}
		if !matched {
			continue
		}
		event := recorder.event(c.Scope, "commit:"+sha, c.Work)
		event.Commit = &protocol.Commit{ID: sha, Parents: parentIDs, Quality: "inferred"}
		if err = r.Store.Observe(event); err != nil {
			return err
		}
		if c.Work != "" {
			link := recorder.event(c.Scope, "work-commit:"+c.Work+":"+sha, c.Work)
			link.Link = &protocol.Link{FromKind: "work", FromID: c.Work, ToKind: "commit", ToID: sha, Quality: "inferred", Reason: "file_revision"}
			if err = r.Store.Observe(link); err != nil {
				return err
			}
		}
		tracked := trackedCommit{Scope: c.Scope, Source: c.Source, SHA: sha, CreatedAt: time.Now().UTC()}
		key := "tracked-commit:" + protocol.StableID(c.Scope.Repo, sha)
		var existing string
		if r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&existing) != nil {
			if err = r.saveMeta(key, tracked); err != nil {
				return err
			}
		}
	}
	return nil
}
