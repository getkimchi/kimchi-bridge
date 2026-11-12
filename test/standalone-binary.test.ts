import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assetsJson from "../.generated/install-assets.json";
import { compile, compileCommand } from "../scripts/compile.ts";
import { stub } from "../src/packaging.ts";

/**
 * The compiled binary end to end: `kimchi-bridge install` hands its embedded package to the
 * package's own install.sh, which copies it into the releases and registers it, and the hook stub
 * Kimchi's release and this package share dispatches to the binary once Kimchi is gone.
 */

const repoRoot = join(import.meta.dir, "..");
const assets = assetsJson as { files: Record<string, string> };
const VERSION_A = "v0.0.0-rc.0";
const VERSION_B = "v0.0.0-rc.1";
const market = (client: "claude" | "codex") => assets.files[`markets/${client}`]!.trim();

const builds = mkdtempSync(join(tmpdir(), "kimchi-bridge-binaries-"));
const binA = join(builds, "kb-a"),
  binB = join(builds, "kb-b");

// The release workflow's compile, for this host.
beforeAll(() => {
  compile(VERSION_A, binA);
  compile(VERSION_B, binB);
}, 120_000);
afterAll(() => rmSync(builds, { recursive: true, force: true }));

const dirs: string[] = [];
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A machine: fake clients recording their calls, isolated prefix, state and HOME.
function machine() {
  const root = mkdtempSync(join(tmpdir(), "kimchi-bridge-standalone-"));
  dirs.push(root);
  const binDir = join(root, "bin"),
    prefix = join(root, "install"),
    state = join(root, "state"),
    home = join(root, "home"),
    fake = join(root, "fake-bin"),
    callsFile = join(root, "calls");
  for (const dir of [binDir, prefix, state, home, fake]) mkdirSync(dir, { recursive: true });
  for (const cli of ["claude", "codex"])
    writeFileSync(
      join(fake, cli),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}\n`,
      { mode: 0o700 },
    );
  const env = {
    PATH: [fake, "/usr/bin", "/bin"].join(":"),
    HOME: home,
    KIMCHI_BRIDGE_PREFIX: prefix,
    KIMCHI_BRIDGE_BIN_DIR: binDir,
    KIMCHI_BRIDGE_HOME: state,
  };
  // Registrations, without install.sh's `plugin --help` preflight.
  const calls = () =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf8")
          .split("\n")
          .filter((call) => call && call !== "plugin --help")
      : [];
  return { root, binDir, prefix, state, home, env, calls };
}

function run(command: string[], env: Record<string, string>) {
  const proc = Bun.spawnSync(command, {
    cwd: "/",
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const same = (a: string, b: string) => readFileSync(a).equals(readFileSync(b));

test("a compiled binary installs, re-installs and upgrades a machine without Kimchi", () => {
  const { binDir, prefix, state, home, env, calls } = machine();
  const bin = join(prefix, "bin", "kimchi-bridge");
  const releaseA = join(prefix, "releases", VERSION_A);

  let result = run([binA, "install", "both"], env);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`Installed both ${VERSION_A}.`);
  expect(same(bin, binA)).toBe(true);
  expect(readlinkSync(join(binDir, "kimchi-bridge"))).toBe(bin);
  // Kimchi's package layout, a marker instead of the bundle.
  expect(readFileSync(join(releaseA, "VERSION"), "utf8")).toBe(VERSION_A + "\n");
  expect(existsSync(join(releaseA, "standalone"))).toBe(true);
  expect(existsSync(join(releaseA, "lib"))).toBe(false);
  for (const path of ["bin", "plugins/kimchi-work/claude/bin", "plugins/kimchi-work/codex/bin"]) {
    expect(readFileSync(join(releaseA, path, "kimchi-bridge"), "utf8")).toBe(stub);
    expect(statSync(join(releaseA, path, "kimchi-bridge")).mode & 0o100).toBe(0o100);
  }
  expect(statSync(join(releaseA, "plugins/kimchi-work/claude/hooks/hooks.json")).mode & 0o111).toBe(
    0,
  );
  // Each client's command forms, against the copied release.
  expect(calls()).toEqual([
    `plugin marketplace add ${releaseA} --scope user`,
    `plugin install kimchi-work@${market("claude")} --scope user`,
    `plugin marketplace add ${releaseA} --json`,
    `plugin add kimchi-work@${market("codex")} --json`,
  ]);
  // The binary's activation ran: settings saved, Codex's shell environment marked.
  expect(existsSync(join(state, "config.json"))).toBe(true);
  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
    "[shell_environment_policy.set]",
  );
  expect(existsSync(join(prefix, "runtime"))).toBe(false);
  expect(existsSync(join(prefix, "install.lock"))).toBe(false);
  expect(readdirSync(prefix).filter((name) => name.startsWith(".package."))).toEqual([]);
  // The installed hook stub runs the binary.
  const version = run(
    [join(releaseA, "plugins/kimchi-work/claude/bin/kimchi-bridge"), "version"],
    env,
  );
  expect(version.stdout).toBe(VERSION_A + "\n");

  // Again: no registration, no binary churn.
  const inode = statSync(bin).ino;
  result = run([binA, "install", "both"], env);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("claude plugin already registered");
  expect(result.stdout).toContain("codex plugin already registered");
  expect(statSync(bin).ino).toBe(inode);
  expect(calls().length).toBe(4);

  // An upgrade swaps the binary and the code receipt; the wiring did not change.
  result = run([binB, "install", "both"], env);
  expect(result.code).toBe(0);
  expect(same(bin, binB)).toBe(true);
  expect(existsSync(join(prefix, "releases", VERSION_B, "standalone"))).toBe(true);
  expect(readFileSync(join(prefix, "installed/code"), "utf8")).toBe(VERSION_B + "\n");
  expect(readFileSync(join(prefix, "installed/claude"), "utf8")).toBe(market("claude") + "\n");
  expect(calls().length).toBe(4);
}, 120_000);

test("with Kimchi installed, its runtime and command stay and the binary waits behind them", () => {
  const { root, binDir, prefix, env, calls } = machine();
  // Kimchi's install of the same wiring: runtime link, current.mjs and its command.
  const runtime = join(root, "kimchi");
  writeFileSync(runtime, "#!/bin/sh\necho kimchi-runtime\n", { mode: 0o700 });
  symlinkSync(runtime, join(prefix, "runtime"));
  const harness = join(prefix, "releases/v0.0.0-rc.9");
  mkdirSync(join(harness, "bin"), { recursive: true });
  writeFileSync(join(harness, "bin/kimchi-bridge"), stub, { mode: 0o700 });
  symlinkSync(join(harness, "bin/kimchi-bridge"), join(binDir, "kimchi-bridge"));
  mkdirSync(join(prefix, "installed"), { recursive: true });
  for (const client of ["claude", "codex"] as const)
    writeFileSync(join(prefix, "installed", client), market(client) + "\n");

  const result = run([binA, "install", "both"], env);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Kimchi is installed: it runs and updates the plugins.");
  expect(calls()).toEqual([]);
  expect(existsSync(join(prefix, "releases", VERSION_A))).toBe(false);
  expect(readlinkSync(join(prefix, "runtime"))).toBe(runtime);
  expect(readlinkSync(join(binDir, "kimchi-bridge"))).toBe(join(harness, "bin/kimchi-bridge"));
  // Kimchi's runtime wins while installed; once it is gone the same command reaches the binary.
  expect(run([join(binDir, "kimchi-bridge"), "version"], env).stdout).toBe("kimchi-runtime\n");
  rmSync(runtime);
  expect(run([join(binDir, "kimchi-bridge"), "version"], env).stdout).toBe(VERSION_A + "\n");
}, 60_000);

test("a binary without a release version installs nothing", () => {
  const { prefix, env } = machine();
  const dev = join(builds, "kb-dev");
  const proc = Bun.spawnSync(compileCommand(undefined, dev), {
    cwd: repoRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  const result = run([dev, "install", "both"], env);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("no release version");
  expect(result.stderr).toContain("--define BUILD_VERSION");
  expect(readdirSync(prefix)).toEqual([]);
}, 60_000);

test("Kimchi's bundle leaves installing to Kimchi", () => {
  const { prefix, env } = machine();
  // Kimchi's runtime runs the bundle, a script with the release version defined.
  const result = run(
    [
      process.execPath,
      "--define",
      `BUILD_VERSION=${JSON.stringify(VERSION_A)}`,
      join(repoRoot, "src/cli.ts"),
      "install",
      "both",
    ],
    env,
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("run the Kimchi installer");
  expect(readdirSync(prefix)).toEqual([]);
}, 30_000);
