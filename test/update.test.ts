import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { compareVersions, validVersion } from "../src/install.ts";
import { assetName, checksumOf, update, type UpdateOptions } from "../src/update.ts";

/**
 * `kimchi-bridge update` against a fake GitHub: the REST API names the latest release and the
 * release downloads serve a binary that records how it ran. The real binary's install is
 * standalone-binary.test.ts.
 */

const asset = assetName();
const published = new Set(["v0.3.0", "v0.1.0-rc.7"]);
let root: string, prefix: string, ranFile: string;
let server: ReturnType<typeof Bun.serve>;
let latest: { status: number; tag?: string };
let release: { binary: string; sums?: string; exit?: number };
const requests: string[] = [];

function binary(exit = 0): string {
  return `#!/bin/sh\nprintf '%s %s\\n' "$*" "$KIMCHI_BRIDGE_PREFIX" >> ${JSON.stringify(ranFile)}\nexit ${exit}\n`;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kimchi-bridge-update-"));
  prefix = join(root, "install");
  ranFile = join(root, "ran");
  latest = { status: 200, tag: "v0.3.0" };
  release = { binary: binary() };
  requests.length = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path === "/api/releases/latest")
        return latest.status === 200
          ? Response.json({ tag_name: latest.tag, name: "release notes" })
          : new Response("rate limited", { status: latest.status });
      const [, , tag, file] = path.split("/");
      if (!published.has(tag ?? "")) return new Response("Not Found", { status: 404 });
      if (file === asset) return new Response(release.binary);
      if (file === "checksums.txt")
        return new Response(
          release.sums ??
            `${"1".repeat(64)}  kimchi-bridge-other\n${sha256(release.binary)}  ${asset}\n`,
        );
      return new Response(`no ${tag}/${file}`, { status: 404 });
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function installed(...clients: string[]) {
  mkdirSync(join(prefix, "installed"), { recursive: true });
  for (const client of clients)
    writeFileSync(join(prefix, "installed", client), "kimchi-bridge-0123456789ab\n");
}

async function run(options: Partial<UpdateOptions> = {}) {
  const out: string[] = [];
  let error: Error | undefined;
  try {
    await update({
      prefix,
      current: "v0.2.0",
      binary: "/compiled/kimchi-bridge",
      output: (text) => out.push(text),
      api: `${server.url.origin}/api`,
      downloads: `${server.url.origin}/download`,
      ...options,
    });
  } catch (caught) {
    error = caught as Error;
  }
  const ran = existsSync(ranFile) ? readFileSync(ranFile, "utf8").split("\n").filter(Boolean) : [];
  const leftovers = existsSync(prefix)
    ? readdirSync(prefix).filter((name) => name.startsWith(".update."))
    : [];
  return { output: out.join(""), error: error?.message, ran, leftovers };
}

test("updates to the latest release through the new binary's install", async () => {
  installed("claude", "codex");
  const result = await run();
  expect(result.error).toBeUndefined();
  expect(result.output).toBe("Updating kimchi-bridge v0.2.0 to v0.3.0.\n");
  expect(requests).toEqual([
    "/api/releases/latest",
    `/download/v0.3.0/${asset}`,
    "/download/v0.3.0/checksums.txt",
  ]);
  expect(result.ran).toEqual([`install both ${prefix}`]);
  expect(result.leftovers).toEqual([]);
});

test("re-installs only the clients the plugins were added to", async () => {
  installed("codex");
  expect((await run()).ran).toEqual([`install codex ${prefix}`]);
});

test("a pinned release skips the API", async () => {
  installed("claude");
  const result = await run({ requested: "v0.1.0-rc.7" });
  expect(result.error).toBeUndefined();
  expect(requests).toEqual([
    `/download/v0.1.0-rc.7/${asset}`,
    "/download/v0.1.0-rc.7/checksums.txt",
  ]);
  expect(result.ran).toEqual([`install claude ${prefix}`]);
});

test("the current or a newer build changes nothing", async () => {
  installed("claude");
  let result = await run({ current: "v0.3.0" });
  expect(result.output).toBe("kimchi-bridge v0.3.0 is up to date.\n");
  result = await run({ current: "v0.4.0-rc.1" });
  expect(result.output).toBe(
    "kimchi-bridge v0.4.0-rc.1 is newer than the latest release, v0.3.0.\n",
  );
  expect(requests).toEqual(["/api/releases/latest", "/api/releases/latest"]);
  expect(result.ran).toEqual([]);
});

test("a checksum mismatch or a missing checksum updates nothing", async () => {
  installed("claude", "codex");
  release.sums = `${"0".repeat(64)}  ${asset}\n`;
  let result = await run();
  expect(result.error).toBe(
    `${asset} does not match the v0.3.0 release's checksum; nothing was updated`,
  );
  release.sums = `${"1".repeat(64)}  kimchi-bridge-other\n`;
  result = await run();
  expect(result.error).toBe(`the v0.3.0 release lists no checksum for ${asset}`);
  expect(result.ran).toEqual([]);
  expect(result.leftovers).toEqual([]);
  expect(existsSync(join(prefix, "bin"))).toBe(false);
});

test("an unreachable API, a bad tag or a failed download updates nothing", async () => {
  installed("claude");
  latest = { status: 403 };
  expect((await run()).error).toBe("could not find the latest release: HTTP 403");
  latest = { status: 200, tag: "latest; rm -rf /" };
  expect((await run()).error).toBe(
    "could not find the latest release: GitHub named no valid release tag",
  );
  const missing = await run({ requested: "v9.9.9" });
  expect(missing.error).toBe(
    `could not download ${server.url.origin}/download/v9.9.9/${asset}: HTTP 404`,
  );
  expect((await run({ requested: "../evil" })).error).toBe(
    "invalid release tag ../evil: expected vX.Y.Z or vX.Y.Z-rc.N",
  );
  const result = await run();
  expect(result.ran).toEqual([]);
  expect(result.leftovers).toEqual([]);
});

test("a failed install names the command that finishes it", async () => {
  installed("claude", "codex");
  release.binary = binary(1);
  const result = await run();
  expect(result.error).toBe("the update to v0.3.0 did not finish: run kimchi-bridge install both");
  expect(result.ran).toEqual([`install both ${prefix}`]);
  expect(result.leftovers).toEqual([]);
});

test("without installed plugins only the binary is replaced", async () => {
  const result = await run();
  expect(result.error).toBeUndefined();
  expect(result.output).toContain("The plugins are not installed");
  expect(result.ran).toEqual([]);
  expect(readFileSync(join(prefix, "bin/kimchi-bridge"), "utf8")).toBe(release.binary);
});

test("Kimchi's bundle leaves updates to Kimchi", async () => {
  const result = await run({ binary: undefined });
  expect(result.output).toBe("Kimchi updates kimchi-bridge when it updates itself.\n");
  expect(requests).toEqual([]);
  // The CLI's script build is not a compiled binary either.
  const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "update"], {
    env: { ...process.env, KIMCHI_BRIDGE_PREFIX: prefix, KIMCHI_BRIDGE_HOME: join(root, "state") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(cli.exitCode).toBe(0);
  expect(cli.stdout.toString()).toBe("Kimchi updates kimchi-bridge when it updates itself.\n");
});

test("release versions, checksums and assets parse as install.sh and sha256sum write them", () => {
  for (const version of ["v0.1.0", "v1.22.333-rc.4", "v01.2.3"])
    expect(validVersion(version)).toBe(true);
  for (const version of [
    "0.1.0",
    "v0.1",
    "v0.1.0.1",
    "v0.1.0-rc.",
    "v0.1.0-beta.1",
    "v0..1",
    "vx.y.z",
  ])
    expect(validVersion(version)).toBe(false);
  const ordered = ["v0.1.0-rc.2", "v0.1.0-rc.10", "v0.1.0", "v0.2.0-rc.1", "v0.10.0"];
  for (let i = 1; i < ordered.length; i++) {
    expect(compareVersions(ordered[i - 1]!, ordered[i]!)).toBe(-1);
    expect(compareVersions(ordered[i]!, ordered[i - 1]!)).toBe(1);
  }
  expect(compareVersions("v0.1.0", "v0.1.0")).toBe(0);
  const sums = `${"a".repeat(64)}  kimchi-bridge-linux-x64\n${"B".repeat(64)} *kimchi-bridge-darwin-arm64\n`;
  expect(checksumOf(sums, "kimchi-bridge-linux-x64")).toBe("a".repeat(64));
  expect(checksumOf(sums, "kimchi-bridge-darwin-arm64")).toBe("b".repeat(64));
  expect(checksumOf(sums, "kimchi-bridge-linux-arm64")).toBeUndefined();
  expect(assetName("darwin", "arm64")).toBe("kimchi-bridge-darwin-arm64");
  expect(assetName("linux", "x64")).toBe("kimchi-bridge-linux-x64");
  expect(() => assetName("win32", "x64")).toThrow("no build for win32-x64");
});
