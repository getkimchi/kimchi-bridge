package capture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/getkimchi/kimchi-adapters/protocol"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Use the same host-bound CLI authentication as Kimchi's provider discovery.
// Explicitly rejected credentials never fall through to a different account.
func scmEnvironment(repo *protocol.Repository) []string {
	blocked := map[string]bool{}
	for _, k := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GH_REPO", "GH_HOST", "GLAB_REPO", "GITLAB_HOST", "GL_HOST", "GITLAB_URI", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "NO_PROMPT"} {
		blocked[k] = true
	}
	var env []string
	for _, entry := range os.Environ() {
		if !blocked[strings.SplitN(entry, "=", 2)[0]] {
			env = append(env, entry)
		}
	}
	if repo.Provider == "github" {
		if repo.Host == "github.com" {
			for _, k := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
				if value := os.Getenv(k); value != "" {
					env = append(env, "GH_TOKEN="+value)
					break
				}
			}
		}
		if repo.Host == os.Getenv("GH_HOST") && repo.Host != "github.com" {
			for _, k := range []string{"GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"} {
				if value := os.Getenv(k); value != "" {
					env = append(env, "GH_ENTERPRISE_TOKEN="+value)
					break
				}
			}
		}
	} else {
		host := os.Getenv("GITLAB_HOST")
		if host == "" {
			host = "gitlab.com"
		}
		if repo.Host == host {
			for _, k := range []string{"GITLAB_TOKEN", "GLAB_TOKEN", "GITLAB_ACCESS_TOKEN"} {
				if value := os.Getenv(k); value != "" {
					env = append(env, "GITLAB_TOKEN="+value)
					break
				}
			}
		}
	}
	return append(env, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_TELEMETRY=false", "GLAB_NO_PROMPT=true", "GLAB_SEND_TELEMETRY=false", "GLAB_ENABLE_CI_AUTOLOGIN=false", "GLAB_CHECK_UPDATE=false", "GLAB_SHOW_WHATS_NEW=false")
}

type boundedOutput struct {
	bytes.Buffer
	limit int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("command output exceeds capture bound")
	}
	return b.Buffer.Write(p)
}

func scmAPI(ctx context.Context, root string, repo *protocol.Repository, path string, dest any) error {
	if repo.Provider == "github" && repo.Host != "github.com" && repo.Host != os.Getenv("GH_HOST") {
		return errors.New("SCM host requires explicit configuration")
	}
	if repo.Provider == "gitlab" && repo.Host != "gitlab.com" && repo.Host != os.Getenv("GITLAB_HOST") {
		return errors.New("SCM host requires explicit configuration")
	}
	cli := "gh"
	if repo.Provider == "gitlab" {
		cli = "glab"
	}
	call, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(call, cli, "api", "--hostname", repo.Host, "--method", "GET", path)
	cmd.Dir = root
	cmd.Env = scmEnvironment(repo)
	out := &boundedOutput{limit: 4 << 20}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return errors.New("host-bound SCM lookup unavailable")
	}
	decoder := json.NewDecoder(bytes.NewReader(out.Bytes()))
	decoder.UseNumber()
	if err := decoder.Decode(dest); err != nil {
		return errors.New("invalid SCM response")
	}
	return nil
}
func providerID(v any) string {
	n, ok := v.(json.Number)
	if !ok {
		return ""
	}
	i, err := strconv.ParseInt(string(n), 10, 64)
	if err != nil || i <= 0 {
		return ""
	}
	return string(n)
}

var issueKey = regexp.MustCompile(`\b[A-Z][A-Z0-9]{0,31}-[0-9]{1,20}\b`)

func issueKeys(text, source string) []protocol.IssueKey {
	seen := map[string]bool{}
	var keys []protocol.IssueKey
	for _, key := range issueKey.FindAllString(text, 20) {
		if !seen[key] {
			seen[key] = true
			keys = append(keys, protocol.IssueKey{Key: key, Source: source})
		}
	}
	return keys
}
func timestamp(v any) *time.Time {
	value, ok := v.(string)
	if !ok {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil
	}
	return &t
}

func (r *Recorder) discoverPRs(ctx context.Context, c trackedCommit) error {
	repo := c.Scope.Repository
	if repo == nil {
		return errors.New("SCM repository is unknown")
	}
	path := "repos/" + repo.Name
	if repo.Provider == "gitlab" {
		path = "projects/" + url.PathEscape(repo.Name)
	}
	var identity Object
	if err := scmAPI(ctx, c.Scope.CWD, repo, path, &identity); err != nil {
		return err
	}
	id := providerID(identity["id"])
	if id == "" {
		return errors.New("SCM repository identity is missing")
	}
	name, urlText := str(identity, "full_name"), str(identity, "html_url")
	if repo.Provider == "gitlab" {
		name, urlText = str(identity, "path_with_namespace"), str(identity, "web_url")
	}
	u, err := url.Parse(urlText)
	if err != nil || u.Scheme != "https" || u.Host != repo.Host || u.Path != "/"+name || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("SCM repository identity did not match its host")
	}
	endpoint := path + "/commits/" + c.SHA + "/pulls"
	if repo.Provider == "gitlab" {
		endpoint = "projects/" + id + "/repository/commits/" + c.SHA + "/merge_requests"
	}
	recorder := *r
	recorder.Source = c.Source
	for page := 1; page <= 5; page++ {
		var prs []Object
		if err = scmAPI(ctx, c.Scope.CWD, repo, endpoint+"?per_page=100&page="+strconv.Itoa(page), &prs); err != nil {
			return err
		}
		for _, raw := range prs {
			target, p, err := pullRequest(repo, raw)
			if err != nil {
				return err
			}
			s := c.Scope
			s.Repository = target
			event := recorder.event(s, "pull-request:"+target.ID+":"+p.ID, "")
			event.PullRequest = p
			if err = r.Store.Observe(event); err != nil {
				return err
			}
			link := recorder.event(s, "commit-pr:"+c.SHA+":"+target.ID+":"+p.ID, "")
			link.Link = &protocol.Link{FromKind: "commit", FromID: c.SHA, ToKind: "pull_request", ToID: p.ID, Quality: "observed", Reason: "provider_commit_membership"}
			if err = r.Store.Observe(link); err != nil {
				return err
			}
		}
		if len(prs) < 100 {
			return nil
		}
	}
	return errors.New("SCM pagination exceeds capture bound")
}

// Provider IDs and the PR's target repository own the link, including fork PRs.
func pullRequest(source *protocol.Repository, v Object) (*protocol.Repository, *protocol.PullRequest, error) {
	invalid := errors.New("invalid provider pull request")
	repo := &protocol.Repository{Provider: source.Provider, Host: source.Host}
	p := &protocol.PullRequest{ID: providerID(v["id"]), Title: str(v, "title"), CreatedAt: timestamp(v["created_at"]), ClosedAt: timestamp(v["closed_at"]), MergedAt: timestamp(v["merged_at"]), MergeCommitID: str(v, "merge_commit_sha")}
	var number *int64
	if source.Provider == "github" {
		number = integer(v["number"])
		base := obj(obj(v["base"])["repo"])
		repo.ID, repo.Name = providerID(base["id"]), str(base, "full_name")
		p.URL = str(v, "html_url")
		p.State = str(v, "state")
		if p.MergedAt != nil {
			p.State = "merged"
		}
	}
	if source.Provider == "gitlab" {
		number = integer(v["iid"])
		repo.ID = providerID(v["target_project_id"])
		p.URL = str(v, "web_url")
		p.State = str(v, "state")
		if p.State == "opened" || p.State == "locked" {
			p.State = "open"
		}
	}
	u, err := url.Parse(p.URL)
	if err != nil || u.Scheme != "https" || u.Host != source.Host || u.User != nil || u.RawQuery != "" || u.Fragment != "" || number == nil || *number <= 0 || *number > 2147483647 || p.ID == "" || repo.ID == "" {
		return nil, nil, invalid
	}
	p.Number = int32(*number)
	suffix := "/pull/" + strconv.Itoa(int(p.Number))
	if source.Provider == "gitlab" {
		suffix = "/-/merge_requests/" + strconv.Itoa(int(p.Number))
	}
	if !strings.HasSuffix(u.Path, suffix) {
		return nil, nil, invalid
	}
	path := strings.TrimPrefix(strings.TrimSuffix(u.Path, suffix), "/")
	if source.Provider == "gitlab" {
		repo.Name = path
	}
	if repo.Name != path || len(strings.Split(path, "/")) < 2 {
		return nil, nil, invalid
	}
	if !slices.Contains([]string{"open", "closed", "merged"}, p.State) || (p.State == "merged" && p.MergedAt == nil) {
		return nil, nil, invalid
	}
	p.Title = metadataTitle(p.Title)
	p.IssueKeys = issueKeys(p.Title, "title")
	branch := str(obj(v["head"]), "ref")
	if source.Provider == "gitlab" {
		branch = str(v, "source_branch")
	}
	for _, key := range issueKeys(branch, "branch") {
		if len(p.IssueKeys) >= 20 {
			break
		}
		if !slices.ContainsFunc(p.IssueKeys, func(old protocol.IssueKey) bool { return old.Key == key.Key }) {
			p.IssueKeys = append(p.IssueKeys, key)
		}
	}
	return repo, p, nil
}

func metadataTitle(title string) string {
	title = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, title)), " ")
	if len(title) > 512 {
		title = title[:512]
		for !utf8.ValidString(title) {
			title = title[:len(title)-1]
		}
	}
	return title
}
