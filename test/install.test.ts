import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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

describe("updates retry durable previous-version cleanup", () => {
  for (const cli of ["claude", "codex"] as const)
    test(cli, () => {
      const root = temp(),
        prefix = join(root, "install"),
        bin = join(root, "bin"),
        fake = join(root, "fake-bin"),
        pkg = join(root, "package");
      for (const path of [
        join(prefix, "installed"),
        join(prefix, "releases/v0.1.0/bin"),
        bin,
        fake,
        join(pkg, "bin"),
      ])
        mkdirSync(path, { recursive: true, mode: 0o700 });
      for (const path of [
        join(prefix, "releases/v0.1.0/bin/kimchi-adapters"),
        join(pkg, "bin/kimchi-adapters"),
      ])
        executable(path, "#!/bin/sh\nexit 0\n");
      symlinkSync(
        join(prefix, "releases/v0.1.0/bin/kimchi-adapters"),
        join(bin, "kimchi-adapters"),
      );
      writeFileSync(join(pkg, "VERSION"), "v0.2.0\n");
      const script = readFileSync(installer, "utf8");
      executable(join(pkg, "install.sh"), script);
      executable(join(pkg, "bootstrap.sh"), script);
      const receipt = join(prefix, "installed", cli);
      writeFileSync(receipt, "v0.1.0\n");
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
      const env = {
        ...environment(root, fake),
        FAKE_CALLS: join(root, "calls"),
        FAKE_FAILED: join(root, "failed"),
      };
      const first = run(join(pkg, "install.sh"), ["update", cli], env);
      expect(first.status).not.toBe(0);
      expect(first.output).toContain("temporary native removal failure");
      expect(readFileSync(receipt + ".cleanup", "utf8")).toBe("v0.1.0\n");
      const second = run(join(pkg, "install.sh"), ["update", cli], env);
      expect(second.status).toBe(0);
      expect(second.output).toContain("Installed " + cli + " v0.2.0");
      expect(existsSync(receipt + ".cleanup")).toBe(false);
      expect(readFileSync(receipt, "utf8")).toBe("v0.2.0\n");
      const helper = statSync(join(prefix, "releases/v0.2.0/bin/kimchi-adapters"));
      const linked = statSync(join(prefix, "releases/v0.2.0/plugins", cli, "bin/kimchi-adapters"));
      expect(linked.dev).toBe(helper.dev);
      expect(linked.ino).toBe(helper.ino);
      const calls = readFileSync(join(root, "calls"), "utf8").split("\n");
      const install =
        cli === "claude"
          ? "plugin install kimchi-work@kimchi-work-v0-2-0"
          : "plugin add kimchi-work@kimchi-work-v0-2-0";
      const remove =
        cli === "claude"
          ? "plugin uninstall kimchi-work@kimchi-work-v0-1-0"
          : "plugin remove kimchi-work@kimchi-work-v0-1-0";
      expect(calls.filter((c) => c.startsWith(install + " ")).length).toBe(1);
      expect(calls.filter((c) => c.startsWith(remove + " ")).length).toBe(2);
      expect(existsSync(join(prefix, "install.lock"))).toBe(false);
    });
});

test("installer activates the helper and reports with Kimchi's sign-in", () => {
  const root = temp(),
    bin = join(root, "fake-bin"),
    pkg = join(root, "package"),
    env = environment(root, bin);
  for (const path of [bin, join(pkg, "bin")]) mkdirSync(path, { recursive: true });
  for (const name of ["install.sh", "bootstrap.sh"])
    writeFileSync(join(pkg, name), readFileSync(installer));
  writeFileSync(join(pkg, "VERSION"), "v0.2.0\n");
  executable(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  const calls = join(root, "helper-calls");
  executable(join(pkg, "bin/kimchi-adapters"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
  const result = run(join(pkg, "install.sh"), ["install", "claude"], env);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Reports with your Kimchi sign-in");
  expect(readFileSync(calls, "utf8")).toBe("activate\n");
  expect(readFileSync(join(root, "install/installed/claude"), "utf8")).toBe("v0.2.0\n");
  // The kept bootstrap can uninstall, but only Kimchi's release installs or updates.
  const update = run(join(root, "install/install.sh"), ["update", "claude"], env);
  expect(update.status).not.toBe(0);
  expect(update.output).toContain("run the Kimchi installer");
});
