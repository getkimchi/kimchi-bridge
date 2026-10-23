package probe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// RunInstaller uses real native management commands, an owned HOME and the same
// OS gate as capture probes. It makes no model requests or reporting login.
func RunInstaller(root, archive string) error {
	if runtime.GOOS != "darwin" {
		return errors.New("installer native probe requires macOS OS gate")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	allowed := filepath.Join(home, ".local/state/kimchi-adapters/probes") + string(os.PathSeparator)
	if !filepath.IsAbs(root) || !strings.HasPrefix(filepath.Clean(root), allowed) {
		return errors.New("new owned probe root required")
	}
	if _, err = os.Lstat(root); !os.IsNotExist(err) {
		return errors.New("probe root already exists")
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	helper, err := os.Executable()
	if err != nil {
		return err
	}
	helper, err = filepath.EvalSymlinks(helper)
	if err != nil {
		return err
	}
	var binaries []string
	for _, name := range []string{"claude", "codex"} {
		p, err := filepath.EvalSymlinks(filepath.Join(home, ".local/bin", name))
		if err != nil {
			return err
		}
		binaries = append(binaries, p)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	profile := filepath.Join(root, "isolation.sb")
	if err = writePrivate(profile, []byte(sandboxProfile(home, root, helper, binaries, port))); err != nil {
		return err
	}
	if err = writePrivate(filepath.Join(root, "guard-canary"), []byte("private fixture")); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	_, stderr, err := command(ctx, profile, root, cleanEnv(root, root, helper, "http://"+listener.Addr().String()), helper, "guard", listener.Addr().String(), filepath.Join(root, "guard-canary"))
	cancel()
	if err != nil {
		return fmt.Errorf("installer OS gate: %w %s", err, stderr)
	}
	packageDir := filepath.Join(root, "package")
	if err = os.Mkdir(packageDir, 0700); err != nil {
		return err
	}
	// The input is a locally built release fixture, never arbitrary downloaded data.
	if out, err := exec.Command("tar", "-xzf", archive, "-C", packageDir).CombinedOutput(); err != nil {
		return fmt.Errorf("extract own package: %w %s", err, out)
	}
	bin := filepath.Join(root, "native-bin")
	if err = os.Mkdir(bin, 0700); err != nil {
		return err
	}
	for i, name := range []string{"claude", "codex"} {
		if err = os.Symlink(binaries[i], filepath.Join(bin, name)); err != nil {
			return err
		}
	}
	for _, selection := range []string{"claude", "codex", "both"} {
		state := filepath.Join(root, selection)
		user := filepath.Join(state, "home")
		for _, p := range []string{user + "/tmp", user + "/.claude", user + "/.codex"} {
			if err = os.MkdirAll(p, 0700); err != nil {
				return err
			}
		}
		settings := `{"env":{"ANTHROPIC_BASE_URL":"https://corporate.example.invalid","OTEL_EXPORTER_OTLP_ENDPOINT":"https://metrics.example.invalid"},"permissions":{"allow":["Read"]}}`
		if err = writePrivate(filepath.Join(user, ".claude/settings.json"), []byte(settings)); err != nil {
			return err
		}
		config := "model = \"model-sentinel\"\n[otel]\nexporter = { otlp-http = { endpoint = \"https://metrics.example.invalid/v1/logs\", protocol = \"json\" } }\n"
		if err = writePrivate(filepath.Join(user, ".codex/config.toml"), []byte(config)); err != nil {
			return err
		}
		env := cleanEnv(user, state, helper, "http://"+listener.Addr().String())
		for i, v := range env {
			if strings.HasPrefix(v, "PATH=") {
				env[i] = "PATH=" + bin + ":/usr/bin:/bin:/usr/sbin:/sbin"
			}
		}
		env = append(env, "KIMCHI_ADAPTERS_PREFIX="+state+"/install", "KIMCHI_ADAPTERS_BIN_DIR="+state+"/bin", "KIMCHI_ADAPTERS_HOME="+state+"/ledger")
		for _, action := range []string{"install", "status", "update", "uninstall"} {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			out, stderr, err := command(ctx, profile, state, env, "/bin/bash", filepath.Join(packageDir, "install.sh"), action, selection)
			cancel()
			_ = Save(filepath.Join(state, "results"), map[string]any{"action": action, "success": err == nil, "stdout": string(out), "stderr": string(stderr)})
			if err != nil {
				return fmt.Errorf("%s %s: %w: %s %s", selection, action, err, out, stderr)
			}
			data, err := os.ReadFile(filepath.Join(user, ".claude/settings.json"))
			if err != nil {
				return err
			}
			var before, after map[string]any
			_ = json.Unmarshal([]byte(settings), &before)
			if err = json.Unmarshal(data, &after); err != nil {
				return err
			}
			for _, key := range []string{"env", "permissions"} {
				a, _ := json.Marshal(before[key])
				b, _ := json.Marshal(after[key])
				if string(a) != string(b) {
					return fmt.Errorf("installer changed Claude %s", key)
				}
			}
			data, err = os.ReadFile(filepath.Join(user, ".codex/config.toml"))
			if err != nil {
				return err
			}
			if !strings.Contains(string(data), `model = "model-sentinel"`) || !strings.Contains(string(data), `https://metrics.example.invalid/v1/logs`) {
				return errors.New("installer changed Codex inference or enterprise exporter")
			}
		}
	}
	return writePrivate(filepath.Join(root, "result.json"), []byte(`{"passed":true,"clients":["claude","codex","both"],"actions":["install","status","same-version-update","uninstall"],"osGuard":true,"inferencePreserved":true,"enterpriseTelemetryPreserved":true}`))
}
