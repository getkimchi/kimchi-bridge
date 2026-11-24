/**
 * The Windows worker smoke (reconcile-out-of-process plan, chunk B3). CI's
 * Windows runner cannot use `bun test`: bunfig's preload imports the
 * bridge-native activity code, which refuses to load outside macOS and Linux.
 * `bun run` skips the preload, so this script proves the same two things the
 * bundle test does everywhere else: the built worker imports on Windows,
 * refuses a mismatched parent and exits non-zero; its own build is accepted
 * and stdin EOF exits it cleanly. Exit code 0 means both held.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkerBundle } from "./package.ts";
import { PROTOCOL_VERSION } from "../src/worker/protocol.js";

const ROOT = join(import.meta.dir, "..");
const BUILD = "worker-windows-smoke-build";

interface Child {
  send(message: unknown): void;
  end(): void;
  exited(): Promise<number>;
  lines(): string[];
  stderrText(): string;
}

function spawnBundle(bundle: string, agentDir: string): Child {
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
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk as Uint8Array);
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

async function firstLine(child: Child, timeoutMs = 15000): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (child.lines().length > 0) return child.lines()[0];
    if (Date.now() - started > timeoutMs) throw new Error("the worker bundle never spoke");
    await Bun.sleep(20);
  }
}

function fail(message: string): never {
  console.error(`worker-windows smoke failed: ${message}`);
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "kimchi-worker-windows-"));
try {
  const bundle = join(stage, "worker.mjs");
  await buildWorkerBundle(BUILD, bundle);

  // A parent built from a different commit must be refused, with nothing but
  // the refusal emitted, and no secret-shaped field in it.
  const refused = spawnBundle(bundle, stage);
  refused.send({ type: "hello", v: PROTOCOL_VERSION, build: "a-different-build", agentDir: stage });
  const refusal = JSON.parse(await firstLine(refused));
  if (refusal.type !== "error" || !String(refusal.message).includes("build mismatch"))
    fail(`expected a build-mismatch refusal, got ${JSON.stringify(refusal)}`);
  refused.end();
  if ((await refused.exited()) === 0) fail("the refused worker exited zero");
  if (refused.lines().length !== 1) fail("the refusal emitted more than one line");
  const emitted = JSON.stringify(refused.lines()).toLowerCase();
  if (emitted.includes("token") || emitted.includes("bearer "))
    fail("the refusal mentions a token");

  // Its own build is accepted, and stdin EOF exits it cleanly.
  const accepted = spawnBundle(bundle, stage);
  accepted.send({ type: "hello", v: PROTOCOL_VERSION, build: BUILD, agentDir: stage });
  const ready = JSON.parse(await firstLine(accepted));
  if (ready.type !== "ready" || ready.v !== PROTOCOL_VERSION || ready.build !== BUILD)
    fail(`expected a ready handshake, got ${JSON.stringify(ready)}`);
  accepted.end();
  const code = await accepted.exited();
  if (code !== 0) fail(`the accepted worker exited ${code}: ${accepted.stderrText()}`);

  console.log("worker-windows smoke: refused a mismatched build, accepted its own, exited on EOF");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
