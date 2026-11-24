import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { buildWorkerBundle } from "../../scripts/package.ts";
import { backendFor, closeBackends } from "../../src/ledger/records.js";
import { PROTOCOL_VERSION, type WorkerMessage } from "../../src/worker/protocol.js";

/**
 * The real-binary acceptance (reconcile-out-of-process plan, chunk B3): the
 * built worker bundle must complete a hello and one pass under a released
 * kimchi binary, `BUN_BE_BUN=1 kimchi --no-env-file lib/worker.mjs` — the
 * exact launcher and embedded runtime Kimchi uses, which plain bun only
 * approximates. CI downloads the latest public release asset and points
 * KIMCHI_WORKER_SMOKE_BIN at it; locally, any kimchi on PATH runs. The test
 * skips only where neither is available.
 */

const ROOT = join(import.meta.dir, "../..");

/** The kimchi binary to drive, or undefined when none is available. */
function kimchiBinary(): string | undefined {
  if (process.env.KIMCHI_WORKER_SMOKE_BIN) return process.env.KIMCHI_WORKER_SMOKE_BIN;
  return Bun.which("kimchi") ?? undefined;
}

const KIMCHI = kimchiBinary();
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  closeBackends();
});

test.skipIf(!KIMCHI)(
  "the worker bundle completes hello and one pass under a released kimchi binary",
  async () => {
    // The bundle embeds the checkout commit; the parent must send it back.
    const build = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
    const stage = mkdtempSync(join(tmpdir(), "kimchi-worker-kimchi-"));
    dirs.push(stage);
    const bundle = join(stage, "worker.mjs");
    await buildWorkerBundle(build, bundle);
    const dir = mkdtempSync(join(tmpdir(), "kimchi-worker-kimchi-agent-"));
    dirs.push(dir);
    const workId = "22222222-2222-4222-8222-222222222222";
    backendFor(dir).insertRecord({
      recordHash: "a".repeat(64),
      type: "request",
      workId,
      sessionId: "session",
      body: JSON.stringify({
        version: 1,
        type: "request",
        workId,
        sessionId: "session",
        requestId: "11111111-1111-4111-8111-111111111111",
        cwd: "/the/records/own/cwd",
        startedAt: "2026-10-24T08:00:00.000Z",
        scope: {
          account: {
            apiUrl: "http://127.0.0.1:1",
            organizationId: "30000000-0000-4000-8000-000000000003",
            userId: "40000000-0000-4000-8000-000000000004",
          },
          repository: "/repo/.git",
        },
      }),
      sourcePath: join(dir, "work-attribution", "session.jsonl"),
      sourceGeneration: 0,
      sourceOffset: 0,
      importedAt: Date.now(),
    });
    closeBackends();
    const proc = Bun.spawn({
      cmd: [KIMCHI as string, "--no-env-file", bundle],
      cwd: ROOT,
      env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir, BUN_BE_BUN: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const messages: WorkerMessage[] = [];
    let stderr = "";
    /** Waits for the child's next protocol message. */
    const next = async (): Promise<WorkerMessage> => {
      for (;;) {
        const queued = messages.shift();
        if (queued) return queued;
        await Bun.sleep(10);
      }
    };
    const read = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === "") continue;
          messages.push(JSON.parse(line) as WorkerMessage);
        }
      }
    })();
    const readErr = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr)
        stderr += decoder.decode(chunk as Uint8Array, { stream: true });
    })();
    try {
      proc.stdin.write(
        `${JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, build, agentDir: dir })}\n`,
      );
      proc.stdin.write(
        `${JSON.stringify({ type: "pass", id: 1, channels: { files: true }, deadlineMs: 30000, epoch: 1 })}\n`,
      );
      proc.stdin.flush();
      let sawProgress = false;
      let sawMetric = false;
      let ready: WorkerMessage | undefined;
      for (;;) {
        const message = await next();
        if (ready === undefined) ready = message;
        if (message.type === "progress") sawProgress = true;
        if (message.type === "metric") sawMetric = true;
        if (message.type === "done") {
          expect(message.result.outcome).toBe("ok");
          expect(message.result.channels.files?.outcome).toBe("ok");
          break;
        }
      }
      expect(sawProgress).toBe(true);
      expect(sawMetric).toBe(true);
      expect(ready?.type).toBe("ready");
      proc.stdin.end();
      await read;
      await readErr;
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(stderr).toBe("");
    } finally {
      proc.kill();
    }
  },
  60000,
);
