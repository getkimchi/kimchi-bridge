package probe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

type Arm struct {
	Name     string `json:"name"`
	Exit     string `json:"exit"`
	Requests int    `json:"requests"`
	Events   int    `json:"events"`
	OTLP     int    `json:"otlp_batches"`
	Edited   bool   `json:"edited"`
	Preimage bool   `json:"durable_preimage"`
}
type Comparison struct {
	Harness       string `json:"harness"`
	CountsEqual   bool   `json:"request_counts_equal"`
	PayloadsEqual bool   `json:"normalized_payloads_equal"`
	OutputEqual   bool   `json:"final_output_equal"`
	Note          string `json:"note"`
}
type Report struct {
	Root        string       `json:"root"`
	Passed      bool         `json:"passed"`
	Arms        []Arm        `json:"arms"`
	Comparisons []Comparison `json:"comparisons"`
	Gaps        []string     `json:"gaps"`
}

func writePrivate(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0600)
}
func copyTree(from, to string) error {
	return filepath.WalkDir(from, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.Type()&os.ModeSymlink != 0 {
			return errors.New("fixture symlinks forbidden")
		}
		rel, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(to, rel)
		if e.IsDir() {
			return os.MkdirAll(dest, 0700)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return writePrivate(dest, b)
	})
}
func cleanEnv(home, state, helper, endpoint string) []string {
	return []string{"HOME=" + home, "USER=probe", "LOGNAME=probe", "PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "SHELL=/bin/sh", "LANG=en_US.UTF-8", "TERM=dumb", "NO_COLOR=1", "CI=1", "TMPDIR=" + home + "/tmp", "XDG_CONFIG_HOME=" + home + "/.config", "XDG_CACHE_HOME=" + home + "/.cache", "XDG_DATA_HOME=" + home + "/.local/share", "CLAUDE_CONFIG_DIR=" + home + "/.claude", "CODEX_HOME=" + home + "/.codex", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "ANTHROPIC_API_KEY=synthetic-probe-not-a-credential", "ANTHROPIC_BASE_URL=" + endpoint, "PROBE_API_KEY=synthetic-probe-not-a-credential", "PROBE_HELPER=" + helper, "PROBE_STATE=" + state, "PROBE_FILE=" + state + "/work/probe.txt", "DISABLE_AUTOUPDATER=1", "DISABLE_TELEMETRY=1", "DISABLE_ERROR_REPORTING=1", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"}
}
func sandboxProfile(home, root, helper string, binaries []string, port string) string {
	// Block all user data except this scratch tree and exact official executables.
	s := fmt.Sprintf(`(version 1)(allow default)
(deny network-outbound)(allow network-outbound (remote ip "localhost:%s"))
(deny file-read* file-write* (subpath %q))
(allow file-read-metadata (subpath %q))
(allow file-read* file-write* (subpath %q))
(allow file-read* (literal %q))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))
`, port, home, home, root, helper)
	for _, b := range binaries {
		s += fmt.Sprintf("(allow file-read* (literal %q))\n", b)
	}
	s += fmt.Sprintf("(deny file-read-data (literal %q))\n", filepath.Join(root, "guard-canary"))
	return s
}
func command(ctx context.Context, profile, dir string, env []string, exe string, args ...string) ([]byte, []byte, error) {
	c := exec.CommandContext(ctx, "/usr/bin/sandbox-exec", append([]string{"-f", profile, exe}, args...)...)
	c.Dir = dir
	c.Env = env
	c.Stdin = nil
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Cancel = func() error { return syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
	c.WaitDelay = 3 * time.Second
	var out, errout boundedBuffer
	c.Stdout = &out
	c.Stderr = &errout
	err := c.Run()
	return out.b, errout.b, err
}

type boundedBuffer struct{ b []byte }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if len(b.b) < MaxRecord {
		remain := MaxRecord - len(b.b)
		if len(p) > remain {
			p = p[:remain]
		}
		b.b = append(b.b, p...)
	}
	return n, nil
}

// CheckGuard runs inside the same OS policy as native processes. A timeout is
// NOT accepted as evidence of blocked network access: require an OS denial.
func CheckGuard(endpoint, canary string) error {
	conn, err := net.DialTimeout("tcp", endpoint, 2*time.Second)
	if err != nil {
		return fmt.Errorf("loopback: %w", err)
	}
	conn.Close()
	conn, err = net.DialTimeout("tcp", "203.0.113.1:443", time.Second)
	if conn != nil {
		conn.Close()
	}
	if !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.EACCES) {
		return fmt.Errorf("external network not proven denied: %v", err)
	}
	_, err = os.ReadFile(canary)
	if !errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("private file not denied: %v", err)
	}
	return nil
}

func Run(root, fixtures, harness string) (Report, error) {
	return RunProduct(root, fixtures, harness, "")
}

func RunProduct(root, fixtures, harness, product string) (Report, error) {
	return runProduct(root, fixtures, harness, product, false, true)
}

func RunProductDriver(root, fixtures, harness, product string) (Report, error) {
	return runProduct(root, fixtures, harness, product, true, true)
}

func RunProductWithTelemetry(root, fixtures, harness, product string, driver, telemetry bool) (Report, error) {
	return runProduct(root, fixtures, harness, product, driver, telemetry)
}

func runProduct(root, fixtures, harness, product string, driver, telemetry bool) (Report, error) {
	report := Report{Root: root, Passed: true}
	if runtime.GOOS != "darwin" {
		return report, errors.New("M1a runner currently requires macOS sandbox-exec; Linux untested")
	}
	if !filepath.IsAbs(root) || !filepath.IsAbs(fixtures) {
		return report, errors.New("absolute root and fixtures required")
	}
	if harness != "both" && harness != "claude" && harness != "codex" {
		return report, errors.New("invalid harness")
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return report, err
	}
	allowed := filepath.Join(userHome, ".local/state/kimchi-adapters/probes") + string(os.PathSeparator)
	if !strings.HasPrefix(filepath.Clean(root), allowed) {
		return report, errors.New("root must be a new owned ~/.local/state/kimchi-adapters/probes child")
	}
	if _, err = os.Lstat(root); !os.IsNotExist(err) {
		return report, errors.New("scratch root must not exist")
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return report, err
	}
	helper, err := os.Executable()
	if err != nil {
		return report, err
	}
	helper, err = filepath.EvalSymlinks(helper)
	if err != nil {
		return report, err
	}
	binaries := map[string]string{}
	for _, name := range []string{"claude", "codex"} {
		b, err := filepath.EvalSymlinks(filepath.Join(userHome, ".local/bin", name))
		if err != nil {
			return report, err
		}
		binaries[name] = b
	}
	p := &provider{root: root, counts: map[string]int{}, requests: map[string][]map[string]any{}}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return report, err
	}
	server := &http.Server{Handler: p, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second}
	go server.Serve(listener)
	defer server.Close()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	endpoint := "http://" + net.JoinHostPort(host, port)
	profile := filepath.Join(root, "isolation.sb")
	if err = writePrivate(profile, []byte(sandboxProfile(userHome, root, helper, []string{binaries["claude"], binaries["codex"]}, port))); err != nil {
		return report, err
	}
	if err = writePrivate(filepath.Join(root, "guard-canary"), []byte("synthetic private canary")); err != nil {
		return report, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	out, stderr, err := command(ctx, profile, root, cleanEnv(root, root, helper, endpoint), helper, "guard", listener.Addr().String(), filepath.Join(root, "guard-canary"))
	cancel()
	_ = Save(filepath.Join(root, "setup"), map[string]any{"check": "OS isolation", "stdout": string(out), "stderr": string(stderr), "success": err == nil})
	if err != nil {
		return report, fmt.Errorf("OS isolation gate failed (%v): %s", err, stderr)
	}
	if err = writePrivate(filepath.Join(root, "retention.json"), []byte(fmt.Sprintf(`{"expires_at":%q,"raw_data":"synthetic only","record_limit_per_directory":256,"max_record_bytes":4194304}`, time.Now().Add(7*24*time.Hour).UTC().Format(time.RFC3339)))); err != nil {
		return report, err
	}
	for _, name := range []string{"claude", "codex"} {
		if harness != "both" && harness != name {
			continue
		}
		for _, mode := range []string{"baseline", "capture"} {
			arm := name + "-" + mode
			state := filepath.Join(root, arm)
			home := filepath.Join(state, "home")
			work := filepath.Join(state, "work")
			for _, d := range []string{home + "/tmp", home + "/.claude", home + "/.codex", work} {
				if err = os.MkdirAll(d, 0700); err != nil {
					return report, err
				}
			}
			if err = writePrivate(filepath.Join(work, "probe.txt"), []byte("before\n")); err != nil {
				return report, err
			}
			env := cleanEnv(home, state, helper, endpoint+"/"+arm)
			if product != "" {
				ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
				_, stderr, e := command(ctx, profile, work, env, "/usr/bin/git", "init", "--initial-branch=main")
				cancel()
				if e != nil {
					return report, fmt.Errorf("synthetic repository setup failed: %s", stderr)
				}
			}
			pluginName := "capture-probe"
			if product != "" {
				pluginName = "kimchi-work"
				env = append(env, "KIMCHI_ADAPTERS_HOME="+filepath.Join(state, "ledger"))
			}
			args := []string{}
			if name == "claude" {
				args = []string{"--print", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-6", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--tools", "Read,Edit", "--allowedTools", "Read,Edit", "--permission-mode", "dontAsk", "--system-prompt", "Edit the synthetic fixture as requested. No other tasks.", "--prompt-suggestions=false", "Change probe.txt from before to after with the native edit tool. Reply done."}
				if mode == "capture" {
					plugin := filepath.Join(state, "plugin")
					if err = copyTree(filepath.Join(fixtures, name), plugin); err != nil {
						return report, err
					}
					if product != "" {
						if err = copyProductBinary(product, plugin); err != nil {
							return report, err
						}
					}
					args = append([]string{"--plugin-dir", plugin}, args...)
					// These override only the disposable process, never the user's exporter.
					if telemetry {
						env = append(env, "CLAUDE_CODE_ENABLE_TELEMETRY=1", "OTEL_LOGS_EXPORTER=otlp", "OTEL_METRICS_EXPORTER=otlp", "OTEL_EXPORTER_OTLP_PROTOCOL=http/json", "OTEL_EXPORTER_OTLP_ENDPOINT="+endpoint+"/"+arm+"/otlp", "OTEL_LOGS_EXPORT_INTERVAL=100", "OTEL_METRIC_EXPORT_INTERVAL=100")
					}
					ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
					out, stderr, err = command(ctx, profile, work, env, binaries[name], "plugin", "validate", plugin)
					cancel()
					_ = Save(filepath.Join(state, "setup"), map[string]any{"command": "claude plugin validate", "stdout": string(out), "stderr": string(stderr), "success": err == nil})
					if err != nil {
						return report, fmt.Errorf("Claude fixture validation failed: %s %s", out, stderr)
					}
				}
			} else {
				config := fmt.Sprintf("model = \"gpt-5.4\"\nmodel_provider = \"probe\"\nmodel_reasoning_effort = \"none\"\nweb_search = \"disabled\"\nproject_root_markers = []\n[model_providers.probe]\nname = \"Synthetic loopback fixture\"\nbase_url = %q\nwire_api = \"responses\"\nenv_key = \"PROBE_API_KEY\"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n[otel]\nmetrics_exporter = \"none\"\n", endpoint+"/"+arm+"/v1")
				if mode == "capture" && telemetry {
					if product != "" {
						config += fmt.Sprintf("trace_exporter = { otlp-http = { endpoint = %q, protocol = \"json\" } }\n", endpoint+"/"+arm+"/otlp/v1/traces")
					} else {
						config += "trace_exporter = \"none\"\n"
					}
					config += fmt.Sprintf("exporter = { otlp-http = { endpoint = %q, protocol = \"json\" } }\nlog_user_prompt = false\n", endpoint+"/"+arm+"/otlp/v1/logs")
				} else {
					config += "exporter = \"none\"\ntrace_exporter = \"none\"\n"
				}
				if err = writePrivate(filepath.Join(home, ".codex/config.toml"), []byte(config)); err != nil {
					return report, err
				}
				if mode == "capture" {
					market := filepath.Join(state, "marketplace")
					if err = copyTree(filepath.Join(fixtures, name), filepath.Join(market, "plugin")); err != nil {
						return report, err
					}
					if product != "" {
						if err = copyProductBinary(product, filepath.Join(market, "plugin")); err != nil {
							return report, err
						}
					}
					if err = writePrivate(filepath.Join(market, ".agents/plugins/marketplace.json"), []byte(fmt.Sprintf(`{"name":"probe","plugins":[{"name":%q,"source":{"source":"local","path":"./plugin"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]}`, pluginName))); err != nil {
						return report, err
					}
					for _, setup := range [][]string{{"plugin", "marketplace", "add", market, "--json"}, {"plugin", "add", pluginName + "@probe", "--json"}} {
						ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
						out, stderr, err = command(ctx, profile, work, env, binaries[name], setup...)
						cancel()
						_ = Save(filepath.Join(state, "setup"), map[string]any{"command": setup, "stdout": string(out), "stderr": string(stderr), "success": err == nil})
						if err != nil {
							return report, fmt.Errorf("Codex isolated plugin registration failed: %s %s", out, stderr)
						}
					}
				}
				args = []string{"exec", "--skip-git-repo-check", "--json", "--color", "never", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", "Change probe.txt from before to after with the native edit tool. Reply done."}
			}
			_ = Save(filepath.Join(state, "setup"), map[string]any{"command": append([]string{binaries[name]}, args...), "env_keys": envKeys(env), "billing_basis": "synthetic fixture; no invoice"})
			ctx, cancel = context.WithTimeout(context.Background(), 90*time.Second)
			if driver {
				out, stderr, err = driverCommand(ctx, profile, state, work, home, env, binaries[name], name, args)
			} else {
				out, stderr, err = command(ctx, profile, work, env, binaries[name], args...)
			}
			cancel()
			if e := writePrivate(filepath.Join(state, "stdout.jsonl"), out); e != nil {
				return report, e
			}
			if e := writePrivate(filepath.Join(state, "stderr.txt"), stderr); e != nil {
				return report, e
			}
			a := Arm{Name: arm}
			if err != nil {
				a.Exit = err.Error()
				report.Passed = false
			}
			after, _ := os.ReadFile(filepath.Join(work, "probe.txt"))
			a.Edited = string(after) == "after\n"
			events, e := readRecords(filepath.Join(state, "events"))
			if e != nil {
				return report, e
			}
			a.Events = len(events)
			a.Preimage = verifiedEditState(events)
			if product != "" && mode == "capture" {
				productCommand := filepath.Join(state, "plugin", "bin", "kimchi-adapters")
				if name == "codex" {
					productCommand = filepath.Join(state, "marketplace", "plugin", "bin", "kimchi-adapters")
				}
				ctx, cancel = context.WithTimeout(context.Background(), 15*time.Second)
				_, diagnostic, e := command(ctx, profile, work, env, productCommand, "recover")
				cancel()
				if e != nil {
					return report, fmt.Errorf("product recovery failed: %s", diagnostic)
				}
				ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
				_, _, e = command(ctx, profile, work, env, productCommand, "disable")
				cancel()
				if e != nil {
					return report, e
				}
				a.Events, a.Preimage, e = productEvidence(filepath.Join(state, "ledger", "accounts", "local"))
				if e != nil {
					return report, e
				}
			}
			otlp, e := readRecords(filepath.Join(state, "otlp"))
			if e != nil {
				return report, e
			}
			a.OTLP = len(otlp)
			p.mu.Lock()
			a.Requests = p.counts[arm]
			p.mu.Unlock()
			if !a.Edited || a.Requests == 0 || (mode == "capture" && (a.Events == 0 || !a.Preimage || (telemetry && a.OTLP == 0) || (!telemetry && a.OTLP != 0))) {
				report.Passed = false
			}
			report.Arms = append(report.Arms, a)
		}
		p.mu.Lock()
		base := p.requests[name+"-baseline"]
		cap := p.requests[name+"-capture"]
		p.mu.Unlock()
		b, _ := os.ReadFile(filepath.Join(root, name+"-baseline", "stdout.jsonl"))
		c, _ := os.ReadFile(filepath.Join(root, name+"-capture", "stdout.jsonl"))
		comp := Comparison{Harness: name, CountsEqual: len(base) == len(cap), PayloadsEqual: reflect.DeepEqual(normalize(base, root, name+"-baseline"), normalize(cap, root, name+"-capture")), OutputEqual: reflect.DeepEqual(finalTexts(b), finalTexts(c)), Note: "Normalized scratch roots, generated identities and native chunk IDs only; raw streams retained. Final reply equality is separate from native lifecycle/activation diagnostics."}
		if driver {
			comp.OutputEqual = tuiDone.Match(b) && tuiDone.Match(c)
			comp.Note = "Driver controls the official TUI in TMUX under the same OS isolation. Both screens must contain a standalone assistant done reply; raw terminal screens remain local."
		}
		baselineErrors, _ := os.ReadFile(filepath.Join(root, name+"-baseline", "stderr.txt"))
		captureErrors, _ := os.ReadFile(filepath.Join(root, name+"-capture", "stderr.txt"))
		if !reflect.DeepEqual(normalize([]map[string]any{{"stderr": string(baselineErrors)}}, root, name+"-baseline"), normalize([]map[string]any{{"stderr": string(captureErrors)}}, root, name+"-capture")) {
			report.Gaps = append(report.Gaps, name+"_native_diagnostics_changed")
		}
		if !comp.CountsEqual || !comp.PayloadsEqual || !comp.OutputEqual {
			report.Passed = false
		}
		report.Comparisons = append(report.Comparisons, comp)
	}
	p.mu.Lock()
	report.Gaps = append(report.Gaps, p.failures...)
	p.mu.Unlock()
	if len(report.Gaps) != 0 {
		report.Passed = false
	}
	b, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return report, err
	}
	if err = writePrivate(filepath.Join(root, "report.json"), b); err != nil {
		return report, err
	}
	return report, nil
}
func envKeys(env []string) []string {
	keys := []string{}
	for _, s := range env {
		keys = append(keys, strings.SplitN(s, "=", 2)[0])
	}
	return keys
}

// This assertion is specific to the synthetic edit, not a generic file detector.
func verifiedEditState(records []map[string]any) bool {
	before, after := map[string]time.Time{}, map[string]time.Time{}
	for _, r := range records {
		ev, _ := r["event"].(map[string]any)
		detail, _ := ev["event"].(map[string]any)
		if detail == nil {
			detail = ev
		}
		input, _ := detail["tool_input"].(map[string]any)
		cmd, _ := input["command"].(string)
		if detail["tool"] != "Edit" && !(detail["tool_name"] == "Bash" && strings.HasPrefix(cmd, "apply_patch '*** Begin Patch\n")) {
			continue
		}
		id, _ := detail["tool_use_id"].(string)
		stamp, _ := r["time"].(string)
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if id == "" || err != nil {
			continue
		}
		snap, _ := r["snapshot"].(map[string]any)
		if (ev["stage"] == "tool.before" || ev["hook_event_name"] == "PreToolUse") && snap["content"] == "before\n" {
			before[id] = at
		}
		if (ev["stage"] == "tool.after" || ev["hook_event_name"] == "PostToolUse") && snap["content"] == "after\n" {
			after[id] = at
		}
	}
	for id, start := range before {
		if end, ok := after[id]; ok && start.Before(end) {
			return true
		}
	}
	return false
}

var nativeChunkID = regexp.MustCompile(`^Chunk ID: [0-9a-f]+\n`)

func normalize(requests []map[string]any, root, arm string) any {
	b, _ := json.Marshal(requests)
	s := strings.ReplaceAll(string(b), filepath.Join(root, arm), "<ARM>")
	var v []map[string]any
	_ = json.Unmarshal([]byte(s), &v)
	// Interactive clients can issue an independent title request concurrently.
	// Match request bodies by purpose/history length; preserve every body field.
	sort.SliceStable(v, func(i, j int) bool {
		a, _ := v[i]["tools"].([]any)
		b, _ := v[j]["tools"].([]any)
		if len(a) != len(b) {
			return len(a) < len(b)
		}
		x, _ := v[i]["messages"].([]any)
		y, _ := v[j]["messages"].([]any)
		return len(x) < len(y)
	})
	ids := map[string]string{}
	for _, r := range v {
		if m, ok := r["metadata"].(map[string]any); ok {
			delete(m, "user_id")
		}
		delete(r, "prompt_cache_key")
		if m, ok := r["client_metadata"].(map[string]any); ok {
			normalizeMetadata(m)
			if encoded, ok := m["x-codex-turn-metadata"].(string); ok {
				var inner map[string]any
				if json.Unmarshal([]byte(encoded), &inner) == nil {
					normalizeMetadata(inner)
					m["x-codex-turn-metadata"] = inner
				}
			}
		}
		if input, ok := r["input"].([]any); ok {
			for _, raw := range input {
				if item, ok := raw.(map[string]any); ok {
					if item["type"] == "function_call_output" {
						if output, ok := item["output"].(string); ok {
							item["output"] = nativeChunkID.ReplaceAllString(output, "Chunk ID: <generated>\n")
						}
					}
					if id, ok := item["id"].(string); ok {
						if ids[id] == "" {
							ids[id] = fmt.Sprintf("item-%d", len(ids))
						}
						item["id"] = ids[id]
					}
				}
			}
		}
	}
	return v
}
func normalizeMetadata(m map[string]any) {
	for _, key := range []string{"root_turn_id", "session_id", "thread_id", "turn_id", "installation_id", "x-codex-installation-id", "window_id", "x-codex-window-id", "context_window_id", "turn_started_at_unix_ms"} {
		if _, ok := m[key]; ok {
			m[key] = "<generated>"
		}
	}
}
func finalTexts(b []byte) []string {
	texts := []string{}
	for _, line := range strings.Split(string(b), "\n") {
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			continue
		}
		if v["type"] == "result" {
			if s, ok := v["result"].(string); ok {
				texts = append(texts, s)
			}
		}
		if v["type"] == "item.completed" {
			it, _ := v["item"].(map[string]any)
			if it["type"] == "agent_message" {
				if s, ok := it["text"].(string); ok {
					texts = append(texts, s)
				}
			}
		}
	}
	return texts
}

var _ io.Writer = (*boundedBuffer)(nil)
