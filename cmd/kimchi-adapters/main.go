package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/getkimchi/kimchi-adapters/internal/capture"
	"github.com/getkimchi/kimchi-adapters/internal/daemon"
	"github.com/getkimchi/kimchi-adapters/internal/delivery"
	"github.com/getkimchi/kimchi-adapters/internal/ledger"
	"github.com/getkimchi/kimchi-adapters/internal/settings"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

var version = "dev"

func main() {
	hook := len(os.Args) > 1 && os.Args[1] == "hook"
	if err := run(); err != nil {
		if hook {
			return
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	args := os.Args[1:]
	if len(args) == 0 {
		return errors.New("usage: kimchi-adapters status | configure | enable | disable | flush | export jsonl|csv | version")
	}
	if args[0] == "version" {
		fmt.Println(version)
		return nil
	}
	if args[0] == "update" || args[0] == "uninstall" {
		if len(args) < 2 || (args[1] != "claude" && args[1] != "codex" && args[1] != "both") {
			return errors.New("choose claude, codex or both")
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		prefix := os.Getenv("KIMCHI_ADAPTERS_PREFIX")
		if prefix == "" {
			prefix = filepath.Join(home, ".local", "share", "kimchi-adapters")
		}
		cmd := exec.Command("bash", append([]string{filepath.Join(prefix, "install.sh")}, args...)...)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	if args[0] == "configure" {
		b, err := io.ReadAll(io.LimitReader(os.Stdin, 32<<10+1))
		if err != nil {
			return err
		}
		c, err := settings.Decode(b)
		if err != nil {
			return err
		}
		c.Config, err = delivery.Authenticate(context.Background(), c.Config)
		if err != nil {
			return err
		}
		c.Enabled = true
		previous, err := settings.Load()
		if err != nil {
			return err
		}
		c.RuntimeExecutable = previous.RuntimeExecutable
		c.RuntimeRevision = previous.RuntimeRevision
		c.Disabled = previous.Disabled
		if err = settings.Save(c); err != nil {
			return err
		}
		fmt.Println("Reporting configured. Inference settings are unchanged.")
		return daemon.Start(c)
	}
	c, err := settings.Load()
	if err != nil {
		return err
	}
	if args[0] == "activate" {
		c.RuntimeExecutable, err = os.Executable()
		if err != nil {
			return err
		}
		c.RuntimeExecutable, err = filepath.EvalSymlinks(c.RuntimeExecutable)
		if err != nil {
			return err
		}
		c.RuntimeRevision = protocol.NewID()
		if err = settings.Save(c); err != nil {
			return err
		}
		return daemon.Start(c)
	}
	if args[0] == "enable" || args[0] == "disable" {
		c.Disabled = args[0] == "disable"
		if err = settings.Save(c); err != nil {
			return err
		}
		fmt.Printf("Capture %s. Local records retained.\n", args[0]+"d")
		if !c.Disabled {
			return daemon.Start(c)
		}
		return nil
	}
	if args[0] == "worker" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
		defer cancel()
		return daemon.Run(ctx, c)
	}
	if args[0] == "hook" && c.Disabled {
		return nil
	}
	s, err := ledger.Open(c.StateDir())
	if err != nil {
		return err
	}
	defer s.Close()
	switch args[0] {
	case "hook":
		if len(args) != 2 {
			return errors.New("missing hook source")
		}
		b, e := io.ReadAll(io.LimitReader(os.Stdin, 4<<20+1))
		if e != nil || len(b) > 4<<20 {
			s.Diagnostic("hook_input_too_large")
			return nil
		}
		var n capture.Native
		decoder := json.NewDecoder(bytes.NewReader(b))
		decoder.UseNumber()
		if args[1] == "codex" {
			var event capture.Object
			if e = decoder.Decode(&event); e == nil {
				n.Event = event
			}
		} else {
			e = decoder.Decode(&n)
		}
		if e != nil {
			s.Diagnostic("hook_invalid_json")
			return nil
		}
		session := n.SessionID
		if session == "" {
			session, _ = n.Event["session_id"].(string)
		}
		dir, e := settings.SessionStateDir(c, args[1], session)
		if e != nil {
			s.Diagnostic("session_account_binding_failed")
			return nil
		}
		if dir != s.Dir {
			if e = s.Close(); e != nil {
				return e
			}
			s, e = ledger.Open(dir)
			if e != nil {
				return e
			}
			defer s.Close()
		}
		id, e := s.DeviceID()
		if e != nil {
			return e
		}
		r := capture.Recorder{Store: s, Source: args[1], Device: id}
		if e = r.Record(n); e != nil {
			s.Diagnostic("hook_capture_failed")
		}
		// No network or background reconciliation runs on the synchronous tool path.
		if e = daemon.Start(c); e != nil {
			s.Diagnostic("worker_start_failed")
		}
		return nil
	case "status":
		status, e := s.Status()
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"version": version, "disabled": c.Disabled, "reportingConfigured": c.Enabled, "organizationId": c.OrganizationID, "ledger": c.StateDir(), "accounting": status})
	case "recover", "flush":
		for _, source := range []string{"claude-code", "codex"} {
			id, e := s.DeviceID()
			if e != nil {
				return e
			}
			r := capture.Recorder{Store: s, Source: source, Device: id}
			if e = r.Recover(); e != nil {
				return e
			}
		}
		if args[0] == "recover" {
			return nil
		}
		if !c.Enabled {
			return errors.New("reporting login required; local records retained")
		}
		for {
			sent, e := delivery.Flush(context.Background(), s, c.Config)
			if e != nil {
				return e
			}
			if !sent {
				for {
					exported, e := delivery.FlushOTLP(context.Background(), s, c.Config)
					if e != nil {
						return e
					}
					if !exported {
						break
					}
				}
				fmt.Println("All pending records acknowledged.")
				return nil
			}
		}
	case "export":
		if len(args) != 2 || (args[1] != "jsonl" && args[1] != "csv") {
			return errors.New("export requires jsonl or csv")
		}
		events, e := s.Events(context.Background())
		if e != nil {
			return e
		}
		if args[1] == "jsonl" {
			enc := json.NewEncoder(os.Stdout)
			for _, event := range events {
				if e = enc.Encode(event); e != nil {
					return e
				}
			}
			return nil
		}
		w := csv.NewWriter(os.Stdout)
		defer w.Flush()
		if e = w.Write([]string{"event_id", "kind", "source", "work_id", "session_id", "turn_id", "observed_at", "usage_json"}); e != nil {
			return e
		}
		for _, event := range events {
			usage := ""
			if event.Usage != nil {
				b, _ := json.Marshal(event.Usage)
				usage = string(b)
			}
			row := []string{event.ID, event.Kind(), event.Source, event.WorkID, event.SessionID, event.TurnID, event.ObservedAt.Format("2006-01-02T15:04:05.999999999Z07:00"), usage}
			for i, v := range row {
				row[i] = csvText(v)
			}
			if e = w.Write(row); e != nil {
				return e
			}
		}
		w.Flush()
		return w.Error()
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func csvText(v string) string {
	if len(v) > 0 && (v[0] == '=' || v[0] == '+' || v[0] == '-' || v[0] == '@' || v[0] == '\t' || v[0] == '\r') {
		return "'" + v
	}
	return v
}
