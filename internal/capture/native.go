package capture

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

type Object map[string]any

func obj(v any) Object {
	m, _ := v.(map[string]any)
	if m == nil {
		m, _ = v.(Object)
	}
	return m
}
func str(m Object, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}
func integer(v any) *int64 {
	switch n := v.(type) {
	case json.Number:
		i, e := n.Int64()
		if e == nil {
			return &i
		}
	case float64:
		i := int64(n)
		if float64(i) == n {
			return &i
		}
	}
	return nil
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

type Native struct {
	Stage        string `json:"stage"`
	Event        Object `json:"event"`
	Result       Object `json:"result"`
	SessionID    string `json:"sessionId"`
	CWD          string `json:"cwd"`
	Version      string `json:"version"`
	Route        string `json:"route"`
	BillingBasis string `json:"billingBasis"`
}
type Recorder struct {
	Store          *ledger.Store
	Source, Device string
}
type scope struct {
	Session, Turn, Agent, CWD, Repo string
	Repository                      *protocol.Repository
}

func git(cwd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	for _, entry := range os.Environ() {
		key := strings.SplitN(entry, "=", 2)[0]
		if key != "GIT_DIR" && key != "GIT_WORK_TREE" && key != "GIT_COMMON_DIR" && key != "GIT_INDEX_FILE" {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GIT_LITERAL_PATHSPECS=1")
	out := &boundedOutput{limit: 8 << 20}
	cmd.Stdout = out
	e := cmd.Run()
	return strings.TrimSuffix(strings.TrimSuffix(out.String(), "\n"), "\r"), e
}
func repository(cwd string) (string, string, *protocol.Repository) {
	root, e := git(cwd, "rev-parse", "--show-toplevel")
	if e != nil {
		return cwd, "local:" + digest([]byte(cwd)), nil
	}
	common, err := git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return root, "local:" + digest([]byte(root)), nil
	}
	local := protocol.StableID("git-common-dir", common)
	remote, _ := git(root, "remote", "get-url", "origin")
	host, name := "", ""
	if p := strings.Index(remote, ":"); strings.HasPrefix(remote, "git@") && p > 0 {
		host = remote[4:p]
		name = remote[p+1:]
	} else {
		for _, prefix := range []string{"https://", "ssh://git@"} {
			if strings.HasPrefix(remote, prefix) {
				x := strings.SplitN(strings.TrimPrefix(remote, prefix), "/", 2)
				if len(x) == 2 {
					host, name = x[0], x[1]
				}
			}
		}
	}
	name = strings.TrimSuffix(name, ".git")
	if host == "" || name == "" || strings.ContainsAny(host+name, "\r\n@?#") {
		return root, local, nil
	}
	provider := "gitlab"
	if host == "github.com" || strings.Contains(host, "ghe.") || strings.Contains(host, "github") {
		provider = "github"
	}
	// A provider ID discovered by SCM replaces this provisional name identity later.
	repo := &protocol.Repository{Provider: provider, Host: strings.ToLower(host), ID: "name:" + digest([]byte(strings.ToLower(name))), Name: name}
	return root, local, repo
}
func (r *Recorder) event(s scope, entity, work string) protocol.Event {
	version := "unknown"
	_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "source-version:"+r.Source+":"+s.Session).Scan(&version)
	return protocol.Event{EntityID: protocol.StableID(r.Source, s.Session, entity), Source: r.Source, SourceVersion: version, DeviceID: r.Device, ObservedAt: time.Now().UTC(), Repository: s.Repository, WorkID: work, SessionID: s.Session, TurnID: s.Turn, AgentID: s.Agent}
}

func (r *Recorder) Record(n Native) error {
	if r.Source != "claude-code" && r.Source != "codex" {
		return errors.New("unsupported source")
	}
	if n.Route == "" {
		n.Route = route(r.Source)
	}
	if n.BillingBasis == "" {
		n.BillingBasis = "unknown"
	}
	e := n.Event
	if e == nil {
		return errors.New("missing native event")
	}
	stage := n.Stage
	if stage == "" {
		stage = str(e, "hook_event_name")
	}
	s := scope{Session: n.SessionID, Turn: str(e, "turn_id", "turnId"), Agent: str(e, "agent_id", "agentId"), CWD: n.CWD}
	if s.Session == "" {
		s.Session = str(e, "session_id")
	}
	if s.CWD == "" {
		s.CWD = str(e, "cwd")
	}
	if s.Session == "" || !filepath.IsAbs(s.CWD) {
		return errors.New("missing native session or working directory")
	}
	s.CWD, s.Repo, s.Repository = repository(s.CWD)
	if n.Version != "" {
		if err := r.version(s.Session, n.Version); err != nil {
			return err
		}
	}
	if path := str(e, "transcript_path"); path != "" && r.Source == "codex" {
		r.transcriptVersion(s.Session, path)
	}
	// Keep native turn IDs where provided. Missing turn IDs are resolved only from
	// this session's persisted default, never from a machine-global active work.
	if s.Turn == "" {
		_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, r.Source+":"+s.Session+":turn").Scan(&s.Turn)
	}
	if stage == "classic.UserPromptSubmit" {
		if id := str(e, "prompt_id"); id != "" {
			if _, err := r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, "pending-prompt:"+s.Session, id); err != nil {
				return err
			}
		}
	}
	if stage == "turn.start" || stage == "UserPromptSubmit" {
		if s.Turn == "" {
			return errors.New("prompt has no turn identity")
		}
		if err := r.bind(s, str(e, "text", "prompt")); err != nil {
			return err
		}
	}
	if s.Turn != "" {
		prompt := str(e, "prompt_id")
		if prompt == "" && stage == "turn.start" {
			_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "pending-prompt:"+s.Session).Scan(&prompt)
		}
		if prompt != "" {
			if _, err := r.Store.DB.Exec(`INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)`, "prompt-turn:"+s.Session+":"+prompt, s.Turn); err != nil {
				return err
			}
		}
	}
	work := r.work(s)
	if stage == "SessionStart" && r.Source == "codex" {
		coverage := r.event(s, "coverage:native-request-surface", work)
		coverage.Coverage = &protocol.Coverage{Code: "native_auxiliary_usage_coverage_unknown", Count: 1}
		if err := r.Store.Observe(coverage); err != nil {
			return err
		}
		r.Store.Diagnostic("native_auxiliary_usage_coverage_unknown")
	}
	if stage == "telemetry.log" {
		return r.telemetry(s, e, n.Route, n.BillingBasis)
	}
	if stage == "step.after" {
		usage := obj(n.Result["usage"])
		index := integer(e["index"])
		if usage != nil && index != nil && s.Turn != "" {
			// The mod exposes exact step/turn/agent identity but no response ID.
			// Keep its counters as supplementary evidence, never a second charge.
			raw := claudeUsage(usage)
			step := r.event(s, "step:"+s.Turn+":"+s.Agent+":"+protocol.Hash(*index), work)
			step.Coverage = &protocol.Coverage{Code: "mod_step_request_identity_missing", Count: 1, ObservedUsage: &raw, Model: str(usage, "model")}
			return r.Store.Observe(step)
		}
		return nil
	}
	if stage == "tool.before" || stage == "PreToolUse" {
		if err := r.before(s, e, work); err != nil {
			return err
		}
	}
	if stage == "tool.after" || stage == "PostToolUse" || stage == "PostToolUseFailure" {
		isError, _ := n.Result["isError"].(bool)
		if err := r.after(s, e, n.Result, work, stage == "PostToolUseFailure" || isError || str(n.Result, "deny") != ""); err != nil {
			return err
		}
	}
	if stage == "SubagentStart" || stage == "classic.SubagentStart" {
		agent := str(e, "agent_id")
		parent := s
		parent.Agent = ""
		work = r.work(parent)
		if agent != "" && work != "" {
			_, err := r.Store.DB.Exec(`INSERT OR IGNORE INTO bindings(source,session_id,turn_id,agent_id,work_id,repository) VALUES(?,?,?,?,?,?)`, r.Source, s.Session, s.Turn, agent, work, s.Repo)
			if err != nil {
				return err
			}
			if _, err = r.Store.DB.Exec(`INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)`, "agent-work:"+r.Source+":"+s.Session+":"+agent, work); err != nil {
				return err
			}
		}
	}
	if path := str(e, "transcript_path"); path != "" {
		main := s
		main.Agent = ""
		if err := r.registerTranscript(main, path, n.Route, n.BillingBasis); err != nil {
			return err
		}
	}
	if path := str(e, "agent_transcript_path"); path != "" && s.Agent != "" {
		agent := s
		agent.Turn = ""
		if err := r.registerTranscript(agent, path, n.Route, n.BillingBasis); err != nil {
			return err
		}
	}
	// ExitPlanMode is observed after the tool has succeeded and a file exists.
	if stage == "tool.after" && strings.EqualFold(str(e, "tool", "tool_name"), "ExitPlanMode") {
		p := str(obj(n.Result["result"]), "filePath", "planFilePath")
		if p == "" {
			p = str(n.Result, "filePath", "planFilePath")
		}
		if p != "" {
			return r.RegisterPlan(s.CWD, p, work, s)
		}
	}
	return nil
}

func (r *Recorder) work(s scope) string {
	var w string
	err := r.Store.DB.QueryRow(`SELECT work_id FROM bindings WHERE source=? AND session_id=? AND turn_id=? AND agent_id=?`, r.Source, s.Session, s.Turn, s.Agent).Scan(&w)
	if err != nil && s.Agent == "" {
		_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, r.Source+":"+s.Session+":work").Scan(&w)
	}
	if err != nil && s.Agent != "" {
		_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "agent-work:"+r.Source+":"+s.Session+":"+s.Agent).Scan(&w)
	}
	return w
}
func (r *Recorder) bind(s scope, prompt string) error {
	if w := r.workExact(s); w != "" {
		return nil
	}
	text := strings.TrimSpace(prompt)
	explicit := s.Agent == "" && (strings.HasPrefix(strings.ToLower(text), "new work:") || strings.HasPrefix(text, "/work new"))
	title := ""
	if explicit && strings.HasPrefix(strings.ToLower(text), "new work:") {
		line, _, _ := strings.Cut(text[len("new work:"):], "\n")
		title = metadataTitle(line)
	}
	owners := map[string]bool{}
	paths := referencedPaths(prompt, s.CWD)
	if explicit {
		paths = nil
	}
	for _, path := range paths {
		b, e := os.ReadFile(path)
		if e != nil || len(b) > 4<<20 {
			continue
		}
		rows, e := r.Store.DB.Query(`SELECT DISTINCT work_id FROM plans WHERE repository=? AND path=? AND hash=?`, s.Repo, planKey(s.CWD, path), digest(b))
		if e != nil {
			return e
		}
		for rows.Next() {
			var w string
			if e = rows.Scan(&w); e != nil {
				rows.Close()
				return e
			}
			owners[w] = true
		}
		rows.Close()
	}
	work, reason, quality := "", "new_prompt", "observed"
	if explicit {
		reason = "explicit_new_work"
		quality = "confirmed"
	} else if len(owners) == 1 {
		for w := range owners {
			work = w
		}
		reason = "verified_plan_revision"
		quality = "confirmed"
	} else if len(owners) > 1 {
		reason = "ambiguous_plan_reference"
		r.Store.Diagnostic("ambiguous_plan_reference")
	} else {
		work = r.work(s)
		reason = "session_continuation"
		quality = "inferred"
	}
	if work == "" {
		work = protocol.NewID()
	}
	if _, err := r.Store.DB.Exec(`INSERT OR IGNORE INTO work(id,repository,created_at) VALUES(?,?,?)`, work, s.Repo, time.Now().Unix()); err != nil {
		return err
	}
	if _, err := r.Store.DB.Exec(`INSERT OR IGNORE INTO bindings(source,session_id,turn_id,agent_id,work_id,repository) VALUES(?,?,?,?,?,?)`, r.Source, s.Session, s.Turn, s.Agent, work, s.Repo); err != nil {
		return err
	}
	defaults := map[string]string{}
	if s.Agent == "" {
		defaults = map[string]string{"turn": s.Turn, "work": work}
	}
	for k, v := range defaults {
		if _, err := r.Store.DB.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, r.Source+":"+s.Session+":"+k, v); err != nil {
			return err
		}
	}
	ev := r.event(s, "binding:"+s.Turn, work)
	ev.Work = &protocol.Work{Reason: reason, Quality: quality, Title: title, IssueKeys: issueKeys(title, "work")}
	return r.Store.Observe(ev)
}
func (r *Recorder) workExact(s scope) string {
	var w string
	_ = r.Store.DB.QueryRow(`SELECT work_id FROM bindings WHERE source=? AND session_id=? AND turn_id=? AND agent_id=?`, r.Source, s.Session, s.Turn, s.Agent).Scan(&w)
	return w
}

var pathTokens = regexp.MustCompile("@?(?:`[^`]+`|\"[^\"]+\"|'[^']+')|\\S+")

func referencedPaths(prompt, cwd string) []string {
	var paths []string
	for _, v := range pathTokens.FindAllString(prompt, 128) {
		v = strings.Trim(strings.TrimPrefix(strings.Trim(v, "(),:;"), "@"), "`\"'")
		if !strings.Contains(v, "/") && !strings.HasSuffix(v, ".md") {
			continue
		}
		if !filepath.IsAbs(v) {
			v = filepath.Join(cwd, v)
		}
		if p, e := filepath.EvalSymlinks(v); e == nil {
			paths = append(paths, p)
		}
	}
	return paths
}

func planKey(root, path string) string {
	if canonical, err := filepath.EvalSymlinks(root); err == nil {
		root = canonical
	}
	if rel, err := filepath.Rel(root, path); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return filepath.ToSlash(rel)
	}
	return path
}
func (r *Recorder) RegisterPlan(cwd, path, work string, s scope) error {
	if work == "" {
		return errors.New("plan has no work binding")
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	path, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return errors.New("plan is unavailable or too large")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	hash := digest(b)
	path = planKey(cwd, path)
	planID := protocol.StableID(s.Repo, path, work)
	rev := protocol.StableID(planID, hash)
	_, err = r.Store.DB.Exec(`INSERT OR IGNORE INTO plans(repository,path,hash,work_id,plan_id,revision_id) VALUES(?,?,?,?,?,?)`, s.Repo, path, hash, work, planID, rev)
	if err != nil {
		return err
	}
	e := r.event(s, "plan:"+rev, work)
	e.Work = &protocol.Work{PlanID: planID, PlanRevision: rev, Reason: "saved_plan", Quality: "confirmed"}
	return r.Store.Observe(e)
}
