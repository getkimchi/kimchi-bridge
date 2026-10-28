import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

/**
 * install.sh is the one artifact every install path funnels through (kimchi's
 * `bridge setup`, the bridge CLI, and the bootstrap), and it runs under
 * `set -euo pipefail` — so a single unguarded failure or a bash-only misuse
 * exits with whatever the failing command happened to print, often nothing.
 * These tests keep its failure modes loud and its argument contract intact.
 *
 * install.sh resolves its package relative to its own path ($0), so each
 * sandbox stages a full package copy — VERSION, lib, bin, markets,
 * bootstrap.sh — exactly like the shipped release layout.
 */

const repoRoot = join(import.meta.dir, "..");
const installShSource = join(repoRoot, "install.sh");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  root: string;
  /** Executable shims to place on PATH, keyed by command name. */
  shims: Record<string, string>;
  run: (clientArg: string, extraArg?: string) => RunResult;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "kimchi-bridge-install-"));
  const pkg = join(root, "pkg");
  mkdirSync(pkg, { recursive: true });
  copyFileSync(installShSource, join(pkg, "install.sh"));
  writeFileSync(join(pkg, "VERSION"), "v0.0.0\n");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "lib/kimchi-bridge.mjs"), "export {}\n");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "bin/kimchi-bridge"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(pkg, "bin/kimchi-bridge"), 0o755);
  mkdirSync(join(pkg, "markets"), { recursive: true });
  writeFileSync(join(pkg, "markets/claude"), "kimchi-bridge-0-0-0\n");
  writeFileSync(join(pkg, "markets/codex"), "kimchi-bridge-0-0-0\n");
  writeFileSync(join(pkg, "bootstrap.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(pkg, "bootstrap.sh"), 0o755);

  mkdirSync(join(root, "prefix"), { recursive: true });
  mkdirSync(join(root, "bin-dir"), { recursive: true });
  const pathDir = join(root, "fake-path");
  mkdirSync(pathDir, { recursive: true });

  return {
    root,
    shims: {},
    run(clientArg: string, extraArg?: string): RunResult {
      for (const [name, body] of Object.entries(this.shims)) {
        const shim = join(pathDir, name);
        writeFileSync(shim, body);
        chmodSync(shim, 0o755);
      }
      const args =
        extraArg === undefined ? ["install", clientArg] : ["install", clientArg, extraArg];
      const proc = Bun.spawnSync(["bash", join(pkg, "install.sh"), ...args], {
        cwd: repoRoot,
        env: {
          PATH: [pathDir, "/usr/bin", "/bin"].join(":"),
          HOME: root,
          KIMCHI_BRIDGE_PREFIX: join(root, "prefix"),
          KIMCHI_BRIDGE_BIN_DIR: join(root, "bin-dir"),
          KIMCHI_BIN: "/bin/echo",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: proc.exitCode ?? -1,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    },
  };
}

describe("install.sh", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it("parses as bash", () => {
    const proc = Bun.spawnSync(["bash", "-n", installShSource]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stderr.toString()).toBe("");
  });

  it("reports an unsupported client CLI instead of dying on a bash error", () => {
    // Regression: the preflight failure path used `local` at top level,
    // which under `set -e` killed the script with "local: can only be used
    // in a function" before the intended message printed.
    sandbox.shims.claude =
      '#!/bin/sh\necho \'unknown command "plugin" for "claude"\' >&2\nexit 1\n';
    // codex only needs to exist; the run fails during claude's preflight.
    sandbox.shims.codex = "#!/bin/sh\nexit 0\n";

    const result = sandbox.run("both");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("claude does not support native plugins");
    expect(result.stderr).toContain("preflight failed");
    expect(result.stderr).not.toContain("local:");
  });

  it("names the missing client when it is not on PATH", () => {
    // The caller contract: one client argument (claude|codex|both). With a
    // sanitized PATH neither client exists, so the script must fail with
    // the actionable message — proving it parsed the arguments and reached
    // the client loop rather than tripping an earlier check.
    const result = sandbox.run("both");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Install official claude first.");
  });

  it("keeps the version-override slot diagnostic when it is not a version", () => {
    // Guard the documented contract: a third argument is a version
    // override, so a stray client name there must produce the explicit
    // version-mismatch failure, not silent misbehavior. Both clients must
    // exist so the run reaches the version check.
    sandbox.shims.claude = "#!/bin/sh\nexit 0\n";
    sandbox.shims.codex = "#!/bin/sh\nexit 0\n";

    const result = sandbox.run("claude", "codex");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Requested version differs from this package.");
  });
});
