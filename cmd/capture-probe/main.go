// capture-probe is an isolated experiment, not an installed accounting adapter.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"github.com/getkimchi/kimchi-adapters/internal/probe"
	"io"
	"os"
)

func main() {
	if len(os.Args) == 4 && os.Args[1] == "guard" {
		if err := probe.CheckGuard(os.Args[2], os.Args[3]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "record" {
		// Hook failures must never deny a tool, print context, or change its result.
		payload := []byte{}
		if len(os.Args) > 2 {
			payload = []byte(os.Args[2])
		} else {
			payload, _ = io.ReadAll(io.LimitReader(os.Stdin, probe.MaxRecord+1))
		}
		if err := probe.Record(os.Getenv("PROBE_STATE"), os.Getenv("PROBE_FILE"), payload); err != nil {
			probe.Gap(os.Getenv("PROBE_STATE"), "recorder_failed")
		}
		return
	}
	root := flag.String("root", "", "new, absolute scratch directory outside the repository (required)")
	fixtures := flag.String("fixtures", "", "absolute repository probes directory (required)")
	harness := flag.String("harness", "both", "claude, codex or both")
	product := flag.String("product", "", "absolute product helper binary; use product plugin fixtures")
	paired := flag.Bool("paired", true, "run baseline and capture")
	driver := flag.Bool("driver", false, "use isolated Driver/TMUX interactive sessions")
	telemetry := flag.Bool("native-telemetry", true, "enable disposable native exporters; false tests quiet defaults")
	installPackage := flag.String("installer-package", "", "locally built release archive; run native installer checks instead of inference")
	flag.Parse()
	if *installPackage != "" {
		if err := probe.RunInstaller(*root, *installPackage); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("Installer checks passed.")
		return
	}
	if !*paired {
		fmt.Fprintln(os.Stderr, "only paired runs are supported")
		os.Exit(2)
	}
	result, err := probe.RunProductWithTelemetry(*root, *fixtures, *harness, *product, *driver, *telemetry)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
	if !result.Passed {
		os.Exit(1)
	}
}
