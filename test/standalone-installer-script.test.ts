import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The curl installer against a fake release: curl serves the release's files and records each URL
 * it was asked for, and the release binary records how it ran. The real binary's install is
 * standalone-binary.test.ts.
 */

const script = join(import.meta.dir, "../scripts/install-standalone.sh");
const asset = `kimchi-bridge-${process.platform}-${process.arch}`;
const latest = "https://github.com/getkimchi/kimchi-bridge/releases/latest/download";

const dirs: string[] = [];
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

function machine(options: { clients?: string[]; checksum?: string; exit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kimchi-bridge-curl-"));
  dirs.push(root);
  const release = join(root, "release"),
    path = join(root, "path"),
    prefix = join(root, "install"),
    ranFile = join(root, "ran"),
    urlsFile = join(root, "urls");
  for (const dir of [release, path]) mkdirSync(dir, { recursive: true });
  const binary = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ranFile)}\nexit ${options.exit ?? 0}\n`;
  writeFileSync(join(release, asset), binary);
  const sum = options.checksum ?? createHash("sha256").update(binary).digest("hex");
  writeFileSync(
    join(release, "checksums.txt"),
    `${"1".repeat(64)}  kimchi-bridge-other-platform\n${sum}  ${asset}\n`,
  );
  // curl: skips its options, records the URL, and serves the release file the URL names.
  writeFileSync(
    join(path, "curl"),
    [
      "#!/bin/sh",
      "out= url=",
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      "    -o) out=$2; shift 2 ;;",
      "    --proto|--retry) shift 2 ;;",
      "    -*) shift ;;",
      "    *) url=$1; shift ;;",
      "  esac",
      "done",
      `printf '%s\\n' "$url" >> ${JSON.stringify(urlsFile)}`,
      `cp ${JSON.stringify(release)}/"\${url##*/}" "$out"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  for (const client of options.clients ?? ["claude", "codex"])
    writeFileSync(join(path, client), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env: Record<string, string> = {
    HOME: join(root, "home"),
    PATH: [path, "/usr/bin", "/bin"].join(":"),
    KIMCHI_BRIDGE_PREFIX: prefix,
    KIMCHI_BRIDGE_BIN_DIR: join(root, "bin"),
  };
  const lines = (file: string) =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  return { prefix, env, ran: () => lines(ranFile), urls: () => lines(urlsFile) };
}

function install(env: Record<string, string>, args: string[] = []) {
  const result = spawnSync("sh", [script, ...args], { env, encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

test("installs the latest release's verified binary for the clients on PATH", () => {
  const { prefix, env, ran, urls } = machine();
  const result = install(env);
  expect(result.status).toBe(0);
  expect(urls()).toEqual([`${latest}/${asset}`, `${latest}/checksums.txt`]);
  expect(ran()).toEqual(["install both"]);
  // The download ran from the install directory and is gone.
  expect(readdirSync(prefix)).toEqual([]);
  expect(result.output).toContain(`Add ${env.KIMCHI_BRIDGE_BIN_DIR} to your PATH`);
});

test("a pinned release, a named client, and the one client installed", () => {
  let { env, ran, urls } = machine();
  expect(install({ ...env, KIMCHI_BRIDGE_VERSION: "v1.2.3-rc.4" }, ["codex"]).status).toBe(0);
  expect(urls()).toEqual([
    `https://github.com/getkimchi/kimchi-bridge/releases/download/v1.2.3-rc.4/${asset}`,
    "https://github.com/getkimchi/kimchi-bridge/releases/download/v1.2.3-rc.4/checksums.txt",
  ]);
  expect(ran()).toEqual(["install codex"]);
  ({ env, ran } = machine({ clients: ["claude"] }));
  expect(install(env).status).toBe(0);
  expect(ran()).toEqual(["install claude"]);
});

test("a checksum mismatch runs and installs nothing", () => {
  const { prefix, env, ran } = machine({ checksum: "0".repeat(64) });
  const result = install(env);
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${asset} does not match the release's checksum`);
  expect(ran()).toEqual([]);
  expect(readdirSync(prefix)).toEqual([]);
});

test("a failed install fails the installer and leaves no download behind", () => {
  const { prefix, env, ran } = machine({ exit: 1 });
  const result = install(env);
  expect(result.status).toBe(1);
  expect(result.output).toContain("kimchi-bridge install failed");
  expect(ran()).toEqual(["install both"]);
  expect(readdirSync(prefix)).toEqual([]);
});

test("refuses before downloading without a client, a valid choice or a valid tag", () => {
  const { env, urls } = machine({ clients: [] });
  expect(install(env).output).toContain("Install Claude Code or Codex first");
  expect(install(env, ["cursor"]).output).toContain("Choose claude, codex or both.");
  const tag = install({ ...env, KIMCHI_BRIDGE_VERSION: "v1/../../evil" }, ["claude"]);
  expect(tag.status).toBe(1);
  expect(tag.output).toContain("Invalid release tag");
  expect(urls()).toEqual([]);
});
