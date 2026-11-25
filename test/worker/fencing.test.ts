import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "bun:test";
import { closeBackends, readRecords } from "../../src/ledger/records.js";
import { acquireWriterEpoch, openStore, readWriterEpoch } from "../../src/ledger/store.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-fence-worker-"));
  dirs.push(dir);
  return dir;
}

function bunEval(script: string): Record<string, unknown> {
  const run = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, timeout: 60_000 });
  if (run.exitCode !== 0)
    throw new Error(`bun -e child failed (${run.exitCode}): ${run.stderr.toString()}`);
  const line = run.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((value) => value.startsWith("{"))
    .at(-1);
  if (!line) throw new Error("bun -e child produced no JSON line");
  return JSON.parse(line) as Record<string, unknown>;
}

function seedJournal(dir: string): void {
  mkdirSync(join(dir, "work-attribution"), { recursive: true });
  writeFileSync(
    join(dir, "work-attribution", "legacy.jsonl"),
    `${JSON.stringify({
      version: 1,
      type: "request",
      workId: "00000000-0000-4000-8000-000000000001",
      sessionId: "session",
      requestId: "req-1",
      scope: null,
      recordedAt: "2026-10-01T00:00:00.000Z",
    })}\n`,
  );
}

// --- The worker across a lease handover: two real processes, SIGSTOP ------------------------

/** The worker entry, driven as the real child the bridge release ships. */
const WORKER_ENTRY = join(ROOT, "src/worker/main.ts");

/** A real worker process with the fake parent's pipe, plus heartbeats while it lives. */
interface WorkerChild {
  send(message: unknown): void;
  next(): Promise<{ type: string; [key: string]: unknown }>;
  stop(): void;
  exitCode(): Promise<number>;
  /** Freezes the whole process, reader thread included. */
  pause(): void;
  resume(): void;
  /** Sends the lease heartbeat every 500 ms; pause() stops it, like a parent that lost its lease. */
  startHeartbeats(): void;
}

function spawnWorkerChild(dir: string): WorkerChild {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER_ENTRY],
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const lines: string[] = [];
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
  let heartbeats: ReturnType<typeof setInterval> | undefined;
  const child: WorkerChild = {
    send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    },
    async next() {
      for (;;) {
        const line = lines.shift();
        if (line) return JSON.parse(line) as { type: string; [key: string]: unknown };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    stop() {
      if (heartbeats !== undefined) clearInterval(heartbeats);
      if (proc.exitCode === null) proc.kill();
    },
    async exitCode() {
      await read;
      await proc.exited;
      return proc.exitCode ?? 0;
    },
    pause() {
      if (heartbeats !== undefined) clearInterval(heartbeats);
      heartbeats = undefined;
      process.kill(proc.pid as number, "SIGSTOP");
    },
    resume() {
      process.kill(proc.pid as number, "SIGCONT");
    },
    startHeartbeats() {
      if (heartbeats !== undefined) return;
      heartbeats = setInterval(() => {
        if (proc.exitCode !== null) return;
        proc.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
        proc.stdin.flush();
      }, 500);
    },
  };
  void proc.exited.then(() => {
    if (heartbeats !== undefined) clearInterval(heartbeats);
  });
  return child;
}

/** Reads one done message for the given pass id, answering host requests with fake replies. */
async function answerUntilDone(
  worker: WorkerChild,
  id: number,
): Promise<{ outcome: string; channels: Record<string, { outcome: string; error?: string }> }> {
  const replies: Record<string, unknown> = {
    credentials: { token: "[REDACTED-GENERIC_SECRET]", apiUrl: "http://127.0.0.1:1" },
    gitToken: {},
    endpoints: {
      llmEndpoint: "http://127.0.0.1:1",
      openAiBaseUrl: "http://127.0.0.1:1/openai/v1",
      anthropicBaseUrl: "http://127.0.0.1:1/anthropic",
      experimentalOpenAiBaseUrl: "http://127.0.0.1:1/experimental",
      platformApiUrl: "http://127.0.0.1:1",
    },
    policy: { resources: { "extensions.cost-per-pr": true } },
    consent: { consent: false },
  };
  for (;;) {
    const message = await worker.next();
    if (message.type === "request")
      worker.send({ type: "reply", rid: message.rid, result: replies[String(message.kind)] });
    if (message.type === "done" && message.id === id) return message.result as never;
  }
}

it("a worker paused across an epoch handover cannot commit after resuming", async () => {
  const dir = agentDir();
  seedJournal(dir);
  // The first parent acquires the lease and its epoch, then grants a pass to its worker.
  const first = openStore(dir);
  let epoch: number;
  try {
    epoch = acquireWriterEpoch(first);
  } finally {
    first.close();
  }
  const worker = spawnWorkerChild(dir);
  try {
    worker.send({
      type: "hello",
      v: 1,
      build: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim(),
      agentDir: dir,
    });
    const ready = await worker.next();
    expect(ready.type).toBe("ready");
    // The parent heartbeats while the worker holds the granted pass, so only the epoch can
    // fence the resumed worker.
    worker.startHeartbeats();
    worker.send({ type: "pass", id: 7, channels: { files: true }, deadlineMs: 30000, epoch });
    // Paused mid-flight: the whole process freezes, so the lease's cancellation cannot
    // reach it either — the exact window the epoch exists for.
    worker.pause();
    // The lease goes stale and a REAL second process takes it over, bumping the epoch.
    const takeover = bunEval(
      `const { openStore, acquireWriterEpoch } = await import(${JSON.stringify(
        join(ROOT, "src/ledger/store.ts"),
      )});
const store = openStore(${JSON.stringify(dir)});
const epoch = acquireWriterEpoch(store);
store.close();
console.log(JSON.stringify({ epoch }));`,
    );
    expect(takeover.epoch).toBe(epoch + 1);
    worker.resume();
    const done = await answerUntilDone(worker, 7);
    expect(done.channels.files?.outcome).toBe("failed");
    expect(done.channels.files?.error).toContain("fenced out");
    // The journal import wrote nothing, and the ledger carries the new holder's epoch.
    expect(readRecords(dir)).toHaveLength(0);
    const after = openStore(dir);
    try {
      expect(readWriterEpoch(after.db)).toBe(epoch + 1);
    } finally {
      after.close();
    }
    worker.send({ type: "cancel", id: 7 });
  } finally {
    worker.stop();
    await worker.exitCode();
  }
}, 30_000);

it("a worker whose parent heartbeat went silent cannot commit after resuming", async () => {
  const dir = agentDir();
  seedJournal(dir);
  const parent = openStore(dir);
  let epoch: number;
  try {
    epoch = acquireWriterEpoch(parent);
  } finally {
    parent.close();
  }
  const worker = spawnWorkerChild(dir);
  try {
    worker.send({
      type: "hello",
      v: 1,
      build: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim(),
      agentDir: dir,
    });
    const ready = await worker.next();
    expect(ready.type).toBe("ready");
    worker.startHeartbeats();
    worker.send({ type: "pass", id: 8, channels: { files: true }, deadlineMs: 60000, epoch });
    // The parent loses the lease and stops heartbeating while the worker is paused; the epoch
    // never moves (an old release took the lease over), so only the heartbeat can fence.
    worker.pause();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    worker.resume();
    const done = await answerUntilDone(worker, 8);
    expect(done.channels.files?.outcome).toBe("failed");
    expect(done.channels.files?.error).toContain("heartbeat was last seen");
    expect(readRecords(dir)).toHaveLength(0);
    const after = openStore(dir);
    try {
      expect(readWriterEpoch(after.db)).toBe(epoch);
    } finally {
      after.close();
    }
    worker.send({ type: "cancel", id: 8 });
  } finally {
    worker.stop();
    await worker.exitCode();
  }
}, 30_000);
