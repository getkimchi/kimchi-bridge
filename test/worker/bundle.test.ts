import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { buildWorkerBundle } from "../../scripts/package.ts";
import { PROTOCOL_VERSION } from "../../src/worker/protocol.js";

/**
 * The worker bundle smoke test (reconcile-out-of-process plan, chunk B3): the
 * release tarball ships lib/worker.mjs next to kimchi-bridge.mjs, and Kimchi
 * starts it as `BUN_BE_BUN=1 kimchi share/kimchi/bridge/worker.mjs`. CI has no
 * kimchi binary, so this runs the bundle under bun — the same runtime. It is
 * the only worker test the Windows runner executes: it proves the bundle
 * imports, speaks the protocol and refuses a mismatched parent, everywhere.
 */

const ROOT = join(import.meta.dir, "../..");
const BUILD = "worker-bundle-smoke-build";
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface BundleChild {
  send(message: unknown): void;
  end(): void;
  exited(): Promise<number>;
  lines(): string[];
  stderrText(): string;
}

function spawnBundle(bundle: string, agentDir: string): BundleChild {
  const proc = Bun.spawn({
    cmd: [process.execPath, bundle],
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: agentDir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  let stderr = "";
  const read = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") lines.push(line);
      }
    }
  })();
  const readErr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr)
      stderr += decoder.decode(chunk as Uint8Array, { stream: true });
  })();
  return {
    send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    },
    end() {
      proc.stdin.end();
    },
    async exited() {
      await read;
      await readErr;
      await proc.exited;
      return proc.exitCode ?? 0;
    },
    lines: () => lines,
    stderrText: () => stderr,
  };
}

/** Resolves once the child has produced its first protocol line. */
async function firstLine(child: BundleChild, timeoutMs = 15000): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (child.lines().length > 0) return child.lines()[0];
    if (Date.now() - started > timeoutMs) throw new Error("the worker bundle never spoke");
    await Bun.sleep(20);
  }
}

test("the worker bundle refuses a parent with a different build and exits non-zero", async () => {
  const stage = mkdtempSync(join(tmpdir(), "kimchi-worker-bundle-"));
  dirs.push(stage);
  const bundle = join(stage, "worker.mjs");
  await buildWorkerBundle(BUILD, bundle);
  const child = spawnBundle(bundle, stage);
  child.send({ type: "hello", v: PROTOCOL_VERSION, build: "a-different-build", agentDir: stage });
  const first = await firstLine(child);
  const message = JSON.parse(first);
  expect(message.type).toBe("error");
  if (message.type === "error") expect(message.message).toMatch(/build mismatch/);
  child.end();
  expect(await child.exited()).not.toBe(0);
  // Nothing but the refusal was emitted; a build id is public, a token never is.
  expect(child.lines().length).toBe(1);
  expect(JSON.stringify(child.lines())).not.toMatch(/"?token"?|Bearer /i);
}, 60000);

test("the worker bundle accepts its own build and exits on stdin EOF", async () => {
  const stage = mkdtempSync(join(tmpdir(), "kimchi-worker-bundle-"));
  dirs.push(stage);
  const bundle = join(stage, "worker.mjs");
  await buildWorkerBundle(BUILD, bundle);
  const child = spawnBundle(bundle, stage);
  child.send({ type: "hello", v: PROTOCOL_VERSION, build: BUILD, agentDir: stage });
  const first = await firstLine(child);
  const message = JSON.parse(first);
  expect(message.type).toBe("ready");
  if (message.type === "ready") {
    expect(message.v).toBe(PROTOCOL_VERSION);
    expect(message.build).toBe(BUILD);
  }
  const started = Date.now();
  child.end();
  expect(await child.exited()).toBe(0);
  expect(Date.now() - started).toBeLessThan(2000);
}, 60000);
