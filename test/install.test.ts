import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const installer = new URL("../install.sh", import.meta.url).pathname;
const dirs: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "kimchi-ts-install-"));
  dirs.push(root);
  return root;
}
function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o700 });
}
function run(script: string, args: string[], env: Record<string, string>) {
  const result = spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}
function environment(root: string, bin: string): Record<string, string> {
  // tar may execute gzip itself; keep its actual directory in the isolated PATH.
  const gzip = Bun.which("gzip");
  return {
    HOME: root,
    PATH: [bin, ...(gzip ? [dirname(gzip)] : []), "/usr/bin", "/bin"].join(delimiter),
    KIMCHI_ADAPTERS_PREFIX: join(root, "install"),
    KIMCHI_ADAPTERS_BIN_DIR: join(root, "bin"),
  };
}
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A package as Kimchi's release carries it, and a fake Kimchi binary to run it.
function fixture(version: string, market: string) {
  const root = temp(),
    pkg = join(root, "package"),
    fake = join(root, "fake-bin");
  for (const path of [join(pkg, "bin"), join(pkg, "lib"), fake])
    mkdirSync(path, { recursive: true });
  const script = readFileSync(installer, "utf8");
  executable(join(pkg, "install.sh"), script);
  executable(join(pkg, "bootstrap.sh"), script);
  executable(join(pkg, "bin/kimchi-adapters"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(pkg, "lib/kimchi-adapters.mjs"), "");
  writeFileSync(join(pkg, "VERSION"), version + "\n");
  writeFileSync(join(pkg, "MARKETPLACE"), market + "\n");
  executable(join(root, "kimchi"), "#!/bin/sh\nexit 0\n");
  for (const cli of ["claude", "codex"])
    executable(
      join(fake, cli),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$1/$2/$3" in
  plugin/uninstall/kimchi-work@kimchi-work-v0-1-0|plugin/remove/kimchi-work@kimchi-work-v0-1-0)
    if [ ! -e "$FAKE_FAILED" ]; then : > "$FAKE_FAILED";echo 'temporary native removal failure' >&2;exit 1;fi
    ;;
esac
exit 0
`,
    );
  const env: Record<string, string> = {
    ...environment(root, fake),
    KIMCHI_BIN: join(root, "kimchi"),
    FAKE_CALLS: join(root, "calls"),
    FAKE_FAILED: join(root, "failed"),
  };
  const prefix = env.KIMCHI_ADAPTERS_PREFIX!;
  mkdirSync(join(prefix, "installed"), { recursive: true });
  const calls = () =>
    existsSync(env.FAKE_CALLS!) ? readFileSync(env.FAKE_CALLS!, "utf8").split("\n") : [];
  return { root, pkg, env, prefix, calls };
}

describe("a new wiring registers once and retries removing the old registration", () => {
  for (const cli of ["claude", "codex"] as const)
    test(cli, () => {
      const { pkg, env, prefix, calls } = fixture("v0.2.0", "kimchi-work-0123456789ab");
      // Earlier releases named their receipt and marketplace after the version.
      const receipt = join(prefix, "installed", cli);
      writeFileSync(receipt, "v0.1.0\n");
      const first = run(join(pkg, "install.sh"), ["update", cli], env);
      expect(first.status).not.toBe(0);
      expect(first.output).toContain("temporary native removal failure");
      expect(readFileSync(receipt + ".cleanup", "utf8")).toBe("kimchi-work-v0-1-0\n");
      // The new registration already runs the new code while the old one waits for removal.
      expect(readlinkSync(join(prefix, "current.mjs"))).toBe(
        join(prefix, "releases/v0.2.0/lib/kimchi-adapters.mjs"),
      );
      expect(existsSync(join(prefix, "installed/code"))).toBe(false);
      const second = run(join(pkg, "install.sh"), ["update", cli], env);
      expect(second.status).toBe(0);
      expect(second.output).toContain("Installed " + cli + " v0.2.0");
      expect(existsSync(receipt + ".cleanup")).toBe(false);
      expect(readFileSync(receipt, "utf8")).toBe("kimchi-work-0123456789ab\n");
      expect(readFileSync(join(prefix, "installed/code"), "utf8")).toBe("v0.2.0\n");
      expect(readlinkSync(join(prefix, "runtime"))).toBe(env.KIMCHI_BIN);
      const install =
        cli === "claude"
          ? "plugin install kimchi-work@kimchi-work-0123456789ab"
          : "plugin add kimchi-work@kimchi-work-0123456789ab";
      const remove =
        cli === "claude"
          ? "plugin uninstall kimchi-work@kimchi-work-v0-1-0"
          : "plugin remove kimchi-work@kimchi-work-v0-1-0";
      expect(calls().filter((c) => c.startsWith(install + " ")).length).toBe(1);
      expect(calls().filter((c) => c.startsWith(remove + " ")).length).toBe(2);
      expect(existsSync(join(prefix, "install.lock"))).toBe(false);
    });
});

test("a release that changes only code relinks it without the clients' plugin managers", () => {
  const { pkg, env, prefix, calls } = fixture("v0.3.0", "kimchi-work-0123456789ab");
  for (const cli of ["claude", "codex"])
    writeFileSync(join(prefix, "installed", cli), "kimchi-work-0123456789ab\n");
  writeFileSync(join(prefix, "installed/code"), "v0.2.0\n");
  const result = run(join(pkg, "install.sh"), ["update", "both"], env);
  expect(result.status).toBe(0);
  expect(result.output).toContain("claude plugin already registered");
  expect(result.output).toContain("codex plugin already registered");
  expect(calls()).toEqual([]);
  expect(readlinkSync(join(prefix, "current.mjs"))).toBe(
    join(prefix, "releases/v0.3.0/lib/kimchi-adapters.mjs"),
  );
  expect(readFileSync(join(prefix, "installed/code"), "utf8")).toBe("v0.3.0\n");
});

test("the installer needs Kimchi and leaves updates to Kimchi's release", () => {
  const { root, pkg, env, prefix, calls } = fixture("v0.2.0", "kimchi-work-0123456789ab");
  const missing = run(join(pkg, "install.sh"), ["install", "claude"], {
    ...env,
    KIMCHI_BIN: join(root, "absent"),
  });
  expect(missing.status).not.toBe(0);
  expect(missing.output).toContain("install Kimchi first");
  expect(calls()).toEqual([]);
  const result = run(join(pkg, "install.sh"), ["install", "claude"], env);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Reports with your Kimchi sign-in");
  expect(readFileSync(join(prefix, "installed/claude"), "utf8")).toBe("kimchi-work-0123456789ab\n");
  // The kept bootstrap can uninstall, but only Kimchi's release installs or updates.
  const update = run(join(prefix, "install.sh"), ["update", "claude"], env);
  expect(update.status).not.toBe(0);
  expect(update.output).toContain("run the Kimchi installer");
  const uninstall = run(join(prefix, "install.sh"), ["uninstall", "claude"], env);
  expect(uninstall.status).toBe(0);
  expect(calls()).toContain("plugin uninstall kimchi-work@kimchi-work-0123456789ab --scope user");
  expect(existsSync(join(prefix, "installed/claude"))).toBe(false);
});
