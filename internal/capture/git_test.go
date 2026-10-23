package capture

import (
	"encoding/json"
	"github.com/getkimchi/kimchi-adapters/protocol"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func gitOK(t *testing.T, root string, args ...string) string {
	t.Helper()
	out, err := git(root, args...)
	if err != nil {
		t.Fatal(args, err)
	}
	return out
}

func TestQuotedPlanHandoffAcrossWorktrees(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	r, root := newRecorder(t, "claude-code")
	gitOK(t, root, "init", "--initial-branch=main")
	gitOK(t, root, "config", "user.email", "fixture@example.invalid")
	gitOK(t, root, "config", "user.name", "Fixture")
	gitOK(t, root, "config", "core.hooksPath", "/dev/null")
	plan := filepath.Join(root, "plan with spaces.md")
	if err := os.WriteFile(plan, []byte("verified plan"), 0600); err != nil {
		t.Fatal(err)
	}
	gitOK(t, root, "add", ".")
	gitOK(t, root, "commit", "-m", "plan")
	other := filepath.Join(t.TempDir(), "worktree")
	gitOK(t, root, "worktree", "add", "-b", "other", other)
	prompt(t, r, root, "claude", "planning", "plan")
	_, repo, _ := repository(root)
	s := scope{Session: "claude", Turn: "planning", CWD: root, Repo: repo}
	work := r.work(s)
	if err := r.RegisterPlan(root, plan, work, s); err != nil {
		t.Fatal(err)
	}
	r.Source = "codex"
	prompt(t, r, other, "codex", "implementation", "implement @\"plan with spaces.md\"")
	_, otherRepo, _ := repository(other)
	if otherRepo != repo || r.work(scope{Session: "codex", Turn: "implementation", Repo: otherRepo}) != work {
		t.Fatal("worktree handoff lost verified plan identity")
	}
}
func TestGitMatchExcludesPreexistingIdenticalCommitAndHumanChange(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	r, root := newRecorder(t, "codex")
	gitOK(t, root, "init", "--initial-branch=main")
	gitOK(t, root, "config", "user.email", "fixture@example.invalid")
	gitOK(t, root, "config", "user.name", "Fixture")
	gitOK(t, root, "config", "core.hooksPath", "/dev/null")
	path := filepath.Join(root, "file.txt")
	commit := func(content, message string) string {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		gitOK(t, root, "add", "file.txt")
		gitOK(t, root, "commit", "-m", message)
		return gitOK(t, root, "rev-parse", "HEAD")
	}
	old := commit("after\n", "old identical revision")
	commit("before\n", "baseline")
	prompt(t, r, root, "s", "t", "work")
	patch := "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch"
	event := Object{"session_id": "s", "turn_id": "t", "cwd": root, "tool_use_id": "patch", "tool_name": "exec_command", "tool_input": Object{"cmd": "apply_patch '" + patch + "'"}}
	if err := r.Record(Native{Stage: "PreToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("after\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.Record(Native{Stage: "PostToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	gitOK(t, root, "add", "file.txt")
	gitOK(t, root, "commit", "-m", "new revision")
	newCommit := gitOK(t, root, "rev-parse", "HEAD")
	if err := r.ReconcileGit(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := r.Store.DB.QueryRow(`SELECT count(*) FROM events WHERE kind='commit'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("old or duplicate commits linked", count)
	}
	var body []byte
	r.Store.DB.QueryRow(`SELECT body FROM events WHERE kind='commit'`).Scan(&body)
	var got protocol.Event
	json.Unmarshal(body, &got)
	if got.Commit.ID != newCommit || got.Commit.ID == old {
		t.Fatal("preexisting commit received work", string(body))
	}
	var quality string
	r.Store.DB.QueryRow(`SELECT quality FROM file_changes LIMIT 1`).Scan(&quality)
	if quality != "tool_observed" {
		t.Fatal("native patch was not verified", quality)
	}
	// A human change that differs from the native edit's result cannot enter Git matching.
	event["tool_use_id"] = "concurrent"
	event["tool_name"] = "Edit"
	event["tool_input"] = Object{"file_path": path, "old_string": "after", "new_string": "agent"}
	if err := r.Record(Native{Stage: "PreToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("human\n"), 0600)
	if err := r.Record(Native{Stage: "PostToolUse", Event: event}); err != nil {
		t.Fatal(err)
	}
	r.Store.DB.QueryRow(`SELECT count(*) FROM meta WHERE key LIKE 'git-change:%'`).Scan(&count)
	if count != 1 {
		t.Fatal("ambiguous human change entered automatic matching", count)
	}
}

func TestPullRequestForkTargetAndCredentialHost(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "synthetic-secret")
	t.Setenv("GH_HOST", "")
	t.Setenv("GITLAB_HOST", "")
	source := &protocol.Repository{Provider: "github", Host: "github.com", Name: "fork/repo"}
	raw := Object{"id": json.Number("42"), "number": json.Number("7"), "html_url": "https://github.com/target/repo/pull/7", "state": "open", "title": "WID-12: change", "base": Object{"repo": Object{"id": json.Number("99"), "full_name": "target/repo"}}}
	repo, pr, err := pullRequest(source, raw)
	if err != nil {
		t.Fatal(err)
	}
	if repo.ID != "99" || repo.Name != "target/repo" || pr.IssueKeys[0].Key != "WID-12" {
		t.Fatal(repo, pr)
	}
	source.Host = "untrusted.example"
	for _, entry := range scmEnvironment(source) {
		if entry == "GH_TOKEN=synthetic-secret" {
			t.Fatal("credential crossed host boundary")
		}
	}
	if _, _, err = pullRequest(source, raw); err == nil {
		t.Fatal("foreign PR host accepted")
	}
}

func TestSCMDiscoveryRecordsLifecycleAndTargetRepository(t *testing.T) {
	r, root := newRecorder(t, "codex")
	bin := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SCM_FIXTURE_ROOT", root)
	script := `#!/bin/sh
case "$*" in
 *repos/fork/repo/commits/*) /bin/cat "$SCM_FIXTURE_ROOT/pulls.json" ;;
 *repos/fork/repo) /bin/cat "$SCM_FIXTURE_ROOT/repo.json" ;;
 *) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "repo.json"), []byte(`{"id":55,"full_name":"fork/repo","html_url":"https://github.com/fork/repo"}`), 0600)
	write := func(merged bool) {
		t.Helper()
		v := Object{"id": 42, "number": 7, "html_url": "https://github.com/target/repo/pull/7", "state": "open", "title": "WID-12: feature", "base": Object{"repo": Object{"id": 99, "full_name": "target/repo"}}}
		if merged {
			v["state"] = "closed"
			v["merged_at"] = time.Now().UTC().Format(time.RFC3339Nano)
		}
		body, _ := json.Marshal([]Object{v})
		if err := os.WriteFile(filepath.Join(root, "pulls.json"), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	c := trackedCommit{Scope: scope{Session: "s", CWD: root, Repository: &protocol.Repository{Provider: "github", Host: "github.com", ID: "name:provisional", Name: "fork/repo"}}, Source: "codex", SHA: strings.Repeat("a", 40)}
	write(false)
	if err := r.discoverPRs(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	write(true)
	if err := r.discoverPRs(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	var body []byte
	if err := r.Store.DB.QueryRow(`SELECT body FROM events WHERE kind='pull_request' ORDER BY rowid DESC LIMIT 1`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	var event protocol.Event
	json.Unmarshal(body, &event)
	if event.Revision != 2 || event.PullRequest.State != "merged" || event.Repository.ID != "99" || event.Repository.Name != "target/repo" {
		t.Fatal(string(body))
	}
	var count int
	r.Store.DB.QueryRow(`SELECT count(*) FROM events WHERE kind='link'`).Scan(&count)
	if count != 1 {
		t.Fatal("duplicate commit membership", count)
	}
}
