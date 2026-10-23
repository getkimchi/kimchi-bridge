package capture

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/getkimchi/kimchi-adapters/protocol"
)

type fileState struct {
	Hash     string `json:"hash"`
	Exists   bool   `json:"exists"`
	Complete bool   `json:"complete"`
}
type toolState struct {
	Files     map[string]fileState `json:"files"`
	Expected  map[string]string    `json:"expected,omitempty"`
	Work      string               `json:"work"`
	Turn      string               `json:"turn"`
	Agent     string               `json:"agent"`
	Started   time.Time            `json:"started"`
	Category  string               `json:"category"`
	Native    bool                 `json:"native"`
	RefTips   []string             `json:"refTips,omitempty"`
	RefsKnown bool                 `json:"refsKnown"`
}

func toolInput(e Object) Object {
	if m := obj(e["tool_input"]); m != nil {
		return m
	}
	return e
}
func toolCategory(name string) string {
	switch strings.ToLower(name) {
	case "read", "read_file":
		return "read"
	case "edit", "write", "multiedit", "apply_patch":
		return "edit"
	case "bash", "exec_command", "shell_command", "shell", "write_stdin":
		return "shell"
	case "exitplanmode":
		return "plan"
	default:
		return "other"
	}
}

func filePaths(root string, e Object) ([]string, bool) {
	input := toolInput(e)
	var paths []string
	for _, k := range []string{"file_path", "path", "filePath"} {
		if path := str(input, k); path != "" {
			paths = append(paths, path)
		}
	}
	if patch := patchInput(e); patch != "" {
		for _, line := range strings.Split(patch, "\n") {
			for _, prefix := range []string{"*** Update File: ", "*** Add File: ", "*** Delete File: ", "*** Move to: "} {
				if strings.HasPrefix(line, prefix) {
					paths = append(paths, strings.TrimPrefix(line, prefix))
				}
			}
		}
	}
	native := len(paths) > 0
	if !native {
		out, err := git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
		if err == nil {
			paths = strings.Split(out, "\x00")
		}
	}
	found := map[string]bool{}
	out := []string{}
	for _, p := range paths {
		if p == "" {
			continue
		}
		if !filepath.IsAbs(p) {
			p = filepath.Join(root, p)
		}
		p = filepath.Clean(p)
		rel, err := filepath.Rel(root, p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || strings.Contains(rel, ".git"+string(os.PathSeparator)) {
			continue
		}
		if !found[p] {
			out = append(out, p)
			found[p] = true
		}
		if len(out) >= 1000 {
			break
		}
	}
	return out, native
}

// Symlinks are excluded: a tool may name a path whose target contains secrets
// outside the repository. A failed/partial snapshot cannot establish authorship.
func (r *Recorder) snapshot(root, path string) fileState {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return fileState{}
	}
	fs, err := os.OpenRoot(root)
	if err != nil {
		return fileState{}
	}
	defer fs.Close()
	info, err := fs.Lstat(rel)
	if os.IsNotExist(err) {
		return fileState{Complete: true}
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return fileState{}
	}
	f, err := fs.Open(rel)
	if err != nil {
		return fileState{}
	}
	b, err := io.ReadAll(io.LimitReader(f, 4<<20+1))
	f.Close()
	after, statErr := fs.Stat(rel)
	if err != nil || statErr != nil || len(b) > 4<<20 || !os.SameFile(info, after) || !info.ModTime().Equal(after.ModTime()) || info.Size() != after.Size() {
		return fileState{}
	}
	hash := digest(b)
	dir := filepath.Join(r.Store.Dir, "blobs")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return fileState{}
	}
	path = filepath.Join(dir, hash)
	if _, err = os.Stat(path); os.IsNotExist(err) {
		entries, _ := os.ReadDir(dir)
		var size int64
		for _, entry := range entries {
			if i, e := entry.Info(); e == nil {
				size += i.Size()
			}
		}
		if size+int64(len(b)) > 256<<20 {
			r.Store.Diagnostic("local_evidence_capacity")
			return fileState{}
		}
		f, err = os.CreateTemp(dir, ".pending-")
		if err != nil {
			return fileState{}
		}
		tmp := f.Name()
		defer os.Remove(tmp)
		if _, err = f.Write(b); err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(tmp, path)
		}
		if err == nil {
			d, e := os.Open(dir)
			if e == nil {
				err = d.Sync()
				d.Close()
			} else {
				err = e
			}
		}
		if err != nil {
			return fileState{}
		}
	}
	return fileState{Hash: hash, Exists: true, Complete: true}
}
func (r *Recorder) before(s scope, e Object, work string) error {
	call := str(e, "tool_use_id", "call_id", "toolCallId")
	if call == "" {
		r.Store.Diagnostic("tool_identity_missing")
		return nil
	}
	paths, native := filePaths(s.CWD, e)
	category := toolCategory(str(e, "tool_name", "tool"))
	state := toolState{Files: map[string]fileState{}, Expected: map[string]string{}, Work: work, Turn: s.Turn, Agent: s.Agent, Started: time.Now().UTC(), Category: category, Native: native}
	if category != "read" {
		state.RefTips, state.RefsKnown = refTips(s.CWD)
	}
	deadline := time.Now().Add(800 * time.Millisecond)
	var bytes int64
	for _, p := range paths {
		if time.Now().After(deadline) || bytes >= 8<<20 {
			r.Store.Diagnostic("file_snapshot_budget_exceeded")
			break
		}
		if within(r.Store.Dir, p) {
			continue
		}
		state.Files[p] = r.snapshot(s.CWD, p)
		if info, e := os.Lstat(p); e == nil {
			bytes += info.Size()
		}
		if hash, ok := r.expected(state.Files[p], e, s.CWD, p); ok {
			state.Expected[p] = hash
		}
	}
	body, err := json.Marshal(state)
	if err != nil {
		return err
	}
	// FULL synchronous SQLite commit happens before this method returns to the tool.
	_, err = r.Store.DB.Exec(`INSERT OR IGNORE INTO tool_state(source,session_id,call_id,body) VALUES(?,?,?,?)`, r.Source, s.Session, call, body)
	return err
}
func (r *Recorder) after(s scope, e, result Object, work string, failed bool) error {
	call := str(e, "tool_use_id", "call_id", "toolCallId")
	if call == "" {
		r.Store.Diagnostic("tool_identity_missing")
		return nil
	}
	var body []byte
	err := r.Store.DB.QueryRow(`SELECT body FROM tool_state WHERE source=? AND session_id=? AND call_id=?`, r.Source, s.Session, call).Scan(&body)
	if err != nil {
		r.Store.Diagnostic("tool_preimage_missing")
		return nil
	}
	var state toolState
	if err = json.Unmarshal(body, &state); err != nil {
		return err
	}
	s.Turn, s.Agent, work = state.Turn, state.Agent, state.Work
	outcome := "completed"
	if failed {
		outcome = "failed"
	}
	// Retried post hooks must preserve the first completion time and observation.
	var done string
	if r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, r.Source+":"+s.Session+":"+call+":done").Scan(&done) == nil {
		return nil
	}
	ev := r.event(s, "tool:"+call, work)
	request := ""
	_ = r.Store.DB.QueryRow(`SELECT value FROM meta WHERE key=?`, "tool-request:"+r.Source+":"+s.Session+":"+call).Scan(&request)
	ev.Tool = &protocol.Tool{CallID: call, Name: str(e, "tool", "tool_name"), RequestEntityID: request, Category: state.Category, Outcome: outcome, DurationMS: time.Since(state.Started).Milliseconds()}
	if err = r.Store.Observe(ev); err != nil {
		return err
	}
	paths, _ := filePaths(s.CWD, e)
	for _, p := range paths {
		if _, ok := state.Files[p]; !ok {
			state.Files[p] = fileState{}
		}
	}
	for p, before := range state.Files {
		if within(r.Store.Dir, p) {
			continue
		}
		if !before.Complete {
			r.Store.Diagnostic("file_snapshot_incomplete")
			continue
		}
		after := r.snapshot(s.CWD, p)
		if !before.Complete || !after.Complete {
			r.Store.Diagnostic("file_snapshot_incomplete")
			continue
		}
		if before == after && state.Category != "read" {
			continue
		}
		id := protocol.NewID()
		if _, err = r.Store.DB.Exec(`INSERT OR IGNORE INTO file_identity(repository,path,id) VALUES(?,?,?)`, s.Repo, p, id); err != nil {
			return err
		}
		if err = r.Store.DB.QueryRow(`SELECT id FROM file_identity WHERE repository=? AND path=?`, s.Repo, p).Scan(&id); err != nil {
			return err
		}
		revisions := []string{"", ""}
		for i, fs := range []fileState{before, after} {
			if fs.Exists {
				rev := protocol.NewID()
				if _, err = r.Store.DB.Exec(`INSERT OR IGNORE INTO file_revisions(repository,file_id,hash,id) VALUES(?,?,?,?)`, s.Repo, id, fs.Hash, rev); err != nil {
					return err
				}
				if err = r.Store.DB.QueryRow(`SELECT id FROM file_revisions WHERE repository=? AND file_id=? AND hash=?`, s.Repo, id, fs.Hash).Scan(&revisions[i]); err != nil {
					return err
				}
			}
		}
		operation := "modified"
		if !before.Exists {
			operation = "created"
		} else if !after.Exists {
			operation = "deleted"
		} else if state.Category == "read" {
			operation = "read"
		}
		quality := "observed"
		if hash, ok := state.Expected[p]; state.Native && !failed && ok && hash == after.Hash {
			quality = "tool_observed"
		}
		change := protocol.StableID(r.Source, s.Session, call, id)
		fe := r.event(s, "file:"+change, work)
		fe.File = &protocol.File{FileID: id, ToolCallID: call, BeforeRevision: revisions[0], AfterRevision: revisions[1], Operation: operation, Quality: quality}
		if err = r.Store.Observe(fe); err != nil {
			return err
		}
		if _, err = r.Store.DB.Exec(`INSERT OR IGNORE INTO file_changes(id,repository,path,before_hash,after_hash,work_id,quality,created_at) VALUES(?,?,?,?,?,?,?,?)`, change, s.Repo, p, before.Hash, after.Hash, work, quality, time.Now().Unix()); err != nil {
			return err
		}
		if state.Category != "read" && before.Hash != after.Hash && state.RefsKnown && quality == "tool_observed" {
			g := gitChange{Scope: s, Source: r.Source, Work: work, Path: p, Before: before.Hash, After: after.Hash, Refs: state.RefTips, CreatedAt: time.Now().UTC()}
			if err = r.saveMeta("git-change:"+change, g); err != nil {
				return err
			}
		}
		rel, _ := filepath.Rel(s.CWD, p)
		if state.Category != "read" && quality == "tool_observed" && after.Exists && strings.HasSuffix(p, ".md") && (strings.HasPrefix(rel, "plans/") || strings.HasPrefix(rel, ".plans/")) {
			if err = r.RegisterPlan(s.CWD, p, work, s); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	_, err = r.Store.DB.Exec(`INSERT OR IGNORE INTO meta(key,value) VALUES(?,'1')`, r.Source+":"+s.Session+":"+call+":done")
	return err
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

// Confirm only the native edit's expected result. A concurrent human change
// between hooks must not become an agent-authored transition.
func (r *Recorder) expected(before fileState, e Object, root, path string) (string, bool) {
	if !before.Complete {
		return "", false
	}
	if patchInput(e) != "" {
		return r.patchExpected(before, e, root, path)
	}
	input := toolInput(e)
	switch strings.ToLower(str(e, "tool", "tool_name")) {
	case "read", "read_file":
		return before.Hash, before.Exists
	case "write":
		content, ok := input["content"].(string)
		if !ok || len(content) > 4<<20 {
			return "", false
		}
		return digest([]byte(content)), true
	case "edit":
		old, ok := input["old_string"].(string)
		if !ok || old == "" || !before.Exists {
			return "", false
		}
		replacement, ok := input["new_string"].(string)
		if !ok {
			return "", false
		}
		blob, err := os.ReadFile(filepath.Join(r.Store.Dir, "blobs", before.Hash))
		if err != nil {
			return "", false
		}
		text := string(blob)
		all, _ := input["replace_all"].(bool)
		if !all && strings.Count(text, old) != 1 {
			return "", false
		}
		if all {
			text = strings.ReplaceAll(text, old, replacement)
		} else {
			text = strings.Replace(text, old, replacement, 1)
		}
		return digest([]byte(text)), true
	}
	return "", false
}

func (r *Recorder) PruneEvidence(now time.Time) error {
	cutoff := now.Add(-7 * 24 * time.Hour)
	if _, err := r.Store.DB.Exec(`DELETE FROM tool_state WHERE unixepoch(json_extract(body,'$.started')) < ?`, cutoff.Unix()); err != nil {
		return err
	}
	if _, err := r.Store.DB.Exec(`DELETE FROM file_changes WHERE created_at < ?`, cutoff.Unix()); err != nil {
		return err
	}
	dir := filepath.Join(r.Store.Dir, "blobs")
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		info, e := entry.Info()
		if e != nil {
			return e
		}
		if info.ModTime().Before(now.Add(-7 * 24 * time.Hour)) {
			if e = os.Remove(filepath.Join(dir, entry.Name())); e != nil {
				return e
			}
		}
	}
	return nil
}
