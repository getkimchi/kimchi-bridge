package probe

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var tuiDone = regexp.MustCompile(`(?m)^[\s•⏺]*[Dd]one\.?\s*(?:│.*)?$`)
var driverID = regexp.MustCompile(`Started (tui-[A-Za-z0-9_-]+)`)

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

// Driver owns only the TMUX surface. Its child gets the same explicit synthetic
// environment and OS policy as the headless probe, regardless of TMUX's environment.
func driverCommand(ctx context.Context, profile, state, work, home string, env []string, exe, harness string, args []string) ([]byte, []byte, error) {
	driver, err := exec.LookPath("kimchi-driver")
	if err != nil {
		return nil, nil, err
	}
	wrapper := filepath.Join(state, "native-tui")
	words := []string{"/usr/bin/env", "-i"}
	for _, entry := range env {
		if !strings.HasPrefix(entry, "TERM=") && !strings.HasPrefix(entry, "CI=") {
			words = append(words, shellQuote(entry))
		}
	}
	words = append(words, "TERM=xterm-256color", "/usr/bin/sandbox-exec", "-f", shellQuote(profile), shellQuote(exe), `"$@"`)
	if err = writePrivate(wrapper, []byte("#!/bin/sh\nexec "+strings.Join(words, " ")+"\n")); err != nil {
		return nil, nil, err
	}
	if err = os.Chmod(wrapper, 0700); err != nil {
		return nil, nil, err
	}
	prompt := "Change probe.txt from before to after with the native edit tool. Reply done."
	var native []string
	if harness == "claude" {
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "--print", "--verbose":
				continue
			case "--output-format":
				i++
				continue
			}
			if args[i] != prompt {
				native = append(native, args[i])
			}
		}
		// These settings belong only to the disposable test account.
		if err = writePrivate(filepath.Join(home, ".claude", ".claude.json"), []byte(`{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.309","theme":"dark","customApiKeyResponses":{"approved":["obe-not-a-credential"],"rejected":[]}}`)); err != nil {
			return nil, nil, err
		}
	} else {
		native = []string{"--no-alt-screen", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox"}
	}
	driverEnv := []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "TERM=xterm-256color", "KIMCHI_DRIVER_HOME=" + filepath.Join(state, "driver")}
	run := func(callCtx context.Context, args ...string) ([]byte, error) {
		c := exec.CommandContext(callCtx, driver, args...)
		c.Env = driverEnv
		c.Dir = work
		out, err := c.CombinedOutput()
		if err != nil {
			return out, fmt.Errorf("Driver %s: %w: %s", args[1], err, out)
		}
		return out, nil
	}
	start := []string{"tui", "start", "--harness", harness, "--bin", wrapper, "--cwd", work, "--home", home, "--width", "160", "--height", "48", "--"}
	out, err := run(ctx, append(start, native...)...)
	if err != nil {
		return nil, out, err
	}
	match := driverID.FindSubmatch(out)
	if len(match) != 2 {
		return nil, out, errors.New("Driver did not return an owned TUI ID")
	}
	id := string(match[1])
	_ = writePrivate(filepath.Join(state, "driver-session.txt"), []byte(id+"\n"))
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = run(cleanup, "tui", "stop", id)
	}()
	var screen []byte
	sent := false
	for ctx.Err() == nil {
		screen, err = run(ctx, "tui", "screen", id, "--history", "0")
		if err != nil {
			return screen, nil, err
		}
		_ = writePrivate(filepath.Join(state, "tui-screen.txt"), screen)
		text := string(screen)
		if !sent {
			switch {
			case strings.Contains(text, "Choose the text style"), strings.Contains(text, "Choose the theme"), strings.Contains(text, "Select the text style"):
				_, err = run(ctx, "tui", "keys", id, "Enter")
			case strings.Contains(text, "❯ No, exit") && strings.Contains(text, "Yes, I trust this folder"):
				_, err = run(ctx, "tui", "keys", id, "Down", "Enter")
			case strings.Contains(text, "Trust this folder?"), strings.Contains(text, "❯ Yes, I trust this folder"), strings.Contains(text, "Trust this workspace"):
				_, err = run(ctx, "tui", "keys", id, "Enter")
			case (harness == "claude" && strings.Contains(text, "don't ask on")) || (harness == "codex" && strings.Contains(text, "gpt-5.4 default")):
				_, err = run(ctx, "tui", "wait", id, "--stable", "1", "--timeout", "10")
				if err == nil {
					_, err = run(ctx, "tui", "type", id, prompt, "--no-enter")
				}
				if err == nil {
					select {
					case <-ctx.Done():
						return screen, nil, ctx.Err()
					case <-time.After(250 * time.Millisecond):
					}
					_, err = run(ctx, "tui", "keys", id, "Enter")
				}
				sent = err == nil
			}
			if err != nil {
				return screen, nil, err
			}
		} else if tuiDone.Match(screen) {
			return screen, nil, nil
		}
		select {
		case <-ctx.Done():
		case <-time.After(250 * time.Millisecond):
		}
	}
	return screen, nil, fmt.Errorf("Driver TUI did not complete: %w", ctx.Err())
}
