import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { backendFor, closeBackends } from "../../src/ledger/records.js";
import {
  PROTOCOL_VERSION,
  type DoneMessage,
  type HostRequestKind,
  type WorkerMessage,
} from "../../src/worker/protocol.js";

/**
 * The worker's lifecycle (reconcile-out-of-process plan, chunk B3), against a
 * REAL child process: `bun src/worker/main.ts` — the same runtime the release
 * bundle runs under (Kimchi starts it as `BUN_BE_BUN=1 kimchi worker.mjs`, and
 * CI has no kimchi binary). The parent side is a fake: it answers host
 * requests with fake credentials, policy and consent and never needs the
 * network (endpoints point at a closed local port).
 */

const ROOT = join(import.meta.dir, "../..");
const WORKER = join(ROOT, "src/worker/main.ts");
/** The dev build falls back to the checkout's commit; the bundle embeds its own. */
const BUILD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
const FAKE_TOKEN = "kchi_lifecycle_fake_token_0123456789";
const NO_NETWORK_API = "http://127.0.0.1:1";
const ORG = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";

const children: WorkerHandle[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (children.length) children.pop()?.kill();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  closeBackends();
});

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-worker-life-"));
  dirs.push(dir);
  return dir;
}

/** The fake parent's standard answers; a test may override or withhold one. */
const REPLIES: Record<HostRequestKind, unknown> = {
  credentials: { token: FAKE_TOKEN, apiUrl: NO_NETWORK_API },
  endpoints: {
    llmEndpoint: "http://127.0.0.1:1",
    openAiBaseUrl: "http://127.0.0.1:1/openai/v1",
    anthropicBaseUrl: "http://127.0.0.1:1/anthropic",
    experimentalOpenAiBaseUrl: "http://127.0.0.1:1/experimental",
    platformApiUrl: NO_NETWORK_API,
  },
  policy: { resources: { "extensions.cost-per-pr": true } },
  consent: { consent: false },
};

interface WorkerHandle {
  send(message: unknown): void;
  next(): Promise<WorkerMessage>;
  end(): void;
  exited(): Promise<number>;
  kill(): void;
  stderrText(): string;
  lines(): string[];
}

function spawnWorker(dir: string): WorkerHandle {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER],
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const messages: WorkerMessage[] = [];
  const lines: string[] = [];
  let stderr = "";
  let waiter: (() => void) | undefined;
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
        lines.push(line);
        const message = JSON.parse(line) as WorkerMessage;
        messages.push(message);
        const listener = waiter;
        waiter = undefined;
        listener?.();
      }
    }
  })();
  const readErr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr)
      stderr += decoder.decode(chunk as Uint8Array, { stream: true });
  })();
  const handle: WorkerHandle = {
    send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    },
    async next() {
      for (;;) {
        const queued = messages.shift();
        if (queued) return queued;
        await new Promise<void>((resolve) => {
          waiter = () => resolve();
        });
      }
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
    kill() {
      proc.kill();
    },
    stderrText: () => stderr,
    lines: () => lines,
  };
  children.push(handle);
  return handle;
}

/** Sends hello and waits for ready. */
async function handshake(worker: WorkerHandle, dir: string, overrides: object = {}): Promise<void> {
  worker.send({ type: "hello", v: PROTOCOL_VERSION, build: BUILD, agentDir: dir, ...overrides });
  const first = await worker.next();
  expect(first.type).toBe("ready");
  if (first.type === "ready") {
    expect(first.v).toBe(PROTOCOL_VERSION);
    expect(first.build).toBe(BUILD);
  }
}

/** Answers every host request with the fake replies, until the pass is done. */
async function answerRequestsUntilDone(worker: WorkerHandle, id: number): Promise<DoneMessage> {
  for (;;) {
    const message = await worker.next();
    if (message.type === "request") {
      const reply = REPLIES[message.kind];
      if (reply !== undefined) worker.send({ type: "reply", rid: message.rid, result: reply });
      continue;
    }
    const done = asDone(message, id);
    if (done) return done;
  }
}

async function drain(worker: WorkerHandle, id: number): Promise<DoneMessage> {
  for (;;) {
    const message = await worker.next();
    const done = asDone(message, id);
    if (done) return done;
  }
}

function asDone(message: WorkerMessage, id: number): DoneMessage | undefined {
  if (message.type !== "done") return undefined;
  expect(message.id).toBe(id);
  return message;
}

/** A deterministic digest of every ledger table, so "nothing was written" is provable. */
function ledgerDigest(dir: string): string {
  const path = join(dir, "work-attribution", "ledger.sqlite");
  if (!existsSync(path)) return "absent";
  const db = new Database(path, { readonly: true });
  try {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const parts = tables.map(
      ({ name }) => `${name}:${JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())}`,
    );
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  } finally {
    db.close();
  }
}

/** One stored record, so the ledger exists with content before the pass. */
function seedRecord(dir: string): void {
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
        account: { apiUrl: NO_NETWORK_API, organizationId: ORG, userId: USER },
        repository: "/repo/.git",
      },
    }),
    sourcePath: join(dir, "work-attribution", "session.jsonl"),
    sourceGeneration: 0,
    sourceOffset: 0,
    importedAt: Date.now(),
  });
  closeBackends();
}

test("hello is answered with ready, and idle stdin EOF exits within 2 s", async () => {
  const dir = agentDir();
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  const started = Date.now();
  worker.end();
  const code = await worker.exited();
  expect(code).toBe(0);
  expect(Date.now() - started).toBeLessThan(2000);
}, 15000);

test("one pass against a temp ledger: progress, metric, done; EOF exits cleanly", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const digest = ledgerDigest(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({
    type: "pass",
    id: 1,
    channels: { files: true, reporting: true },
    reportingCwd: "/project",
    deadlineMs: 30000,
    epoch: 3,
  });
  const seen: string[] = [];
  let done: DoneMessage | undefined;
  for (;;) {
    const message = await worker.next();
    seen.push(message.type);
    if (message.type === "request") {
      worker.send({ type: "reply", rid: message.rid, result: REPLIES[message.kind] });
      continue;
    }
    if (message.type === "progress") expect(message.note).toBe("pass-started");
    if (message.type === "metric" && message.metric.kind === "reconciliation")
      seen.push("reconciliation");
    if (message.type === "done") {
      done = message;
      break;
    }
  }
  expect(seen).toContain("progress");
  expect(seen).toContain("reconciliation");
  expect(done?.result.outcome).toBe("ok");
  expect(done?.result.channels.files?.outcome).toBe("ok");
  expect(done?.result.channels.reporting?.outcome).toBe("ok");
  expect(done?.result.txDurations).toBeUndefined();
  // A read-only files-and-reporting pass must not have rewritten the ledger.
  expect(ledgerDigest(dir)).toBe(digest);
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 20000);

test("version, build and agent directory mismatches are refused before ready", async () => {
  const dir = agentDir();
  for (const overrides of [
    { v: PROTOCOL_VERSION + 1 },
    { build: "not-the-workers-build" },
    { agentDir: "/somewhere/else" },
  ]) {
    const worker = spawnWorker(dir);
    worker.send({ type: "hello", v: PROTOCOL_VERSION, build: BUILD, agentDir: dir, ...overrides });
    const first = await worker.next();
    expect(first.type).toBe("error");
    if (first.type === "error") expect(first.message).toMatch(/mismatch/);
    worker.end();
    expect(await worker.exited()).not.toBe(0);
  }
}, 15000);

test("a reporting pass without reportingCwd, and a non-hello first message, are refused", async () => {
  const dir = agentDir();
  const noCwd = spawnWorker(dir);
  await handshake(noCwd, dir);
  noCwd.send({ type: "pass", id: 1, channels: { reporting: true }, deadlineMs: 5000, epoch: 0 });
  const refusal = await noCwd.next();
  expect(refusal.type).toBe("error");
  noCwd.end();
  expect(await noCwd.exited()).not.toBe(0);

  const notHello = spawnWorker(dir);
  notHello.send({ type: "cancel", id: 1 });
  const error = await notHello.next();
  expect(error.type).toBe("error");
  notHello.end();
  expect(await notHello.exited()).not.toBe(0);
}, 15000);

test("an invalid protocol line is rejected with an error and a non-zero exit", async () => {
  const dir = agentDir();
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({ type: "nonsense" });
  const first = await worker.next();
  expect(first.type).toBe("error");
  if (first.type === "error") expect(first.message).toMatch(/invalid protocol line/);
  expect(await worker.exited()).not.toBe(0);
}, 15000);

test("a host request the parent never answers fails the channel within its timeout and writes nothing", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const digest = ledgerDigest(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({
    type: "pass",
    id: 2,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 1,
  });
  const started = Date.now();
  let sawRequest = false;
  let done: DoneMessage | undefined;
  for (;;) {
    const message = await worker.next();
    if (message.type === "request") {
      sawRequest = true;
      // The parent never replies: the worker must time out, not guess.
    }
    if (message.type === "done") {
      done = message;
      break;
    }
  }
  expect(sawRequest).toBe(true);
  // The request timeout is 10 s (REQUEST_TIMEOUT_MS); never longer than 12.
  expect(Date.now() - started).toBeGreaterThanOrEqual(9500);
  expect(Date.now() - started).toBeLessThan(12000);
  expect(done?.result.outcome).toBe("failed");
  expect(done?.result.channels.reporting?.outcome).toBe("failed");
  if (done?.result.channels.reporting?.error)
    expect(done.result.channels.reporting.error).not.toContain(FAKE_TOKEN);
  expect(ledgerDigest(dir)).toBe(digest);
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 30000);

test("a cancel mid-pass returns a canceled done promptly and writes nothing", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const digest = ledgerDigest(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({
    type: "pass",
    id: 3,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 1,
  });
  // Answer consent so the pass reaches a credentials request, then stall on it:
  // the worker is blocked in the pipe RPC when the cancel arrives.
  let stalled = false;
  const canceling = (async () => {
    for (;;) {
      const message = await worker.next();
      if (message.type === "request" && message.kind === "consent") {
        worker.send({ type: "reply", rid: message.rid, result: { consent: true } });
        continue;
      }
      if (message.type === "request" && message.kind === "credentials") {
        stalled = true;
        return;
      }
    }
  })();
  await canceling;
  expect(stalled).toBe(true);
  const canceled = Date.now();
  worker.send({ type: "cancel", id: 3 });
  const done = await drain(worker, 3);
  expect(done.result.outcome).toBe("canceled");
  expect(done.result.channels.reporting?.outcome).toBe("canceled");
  // The cancel fast-wakes the blocked request; the done must not wait out the
  // request timeout, let alone the pass deadline.
  expect(Date.now() - canceled).toBeLessThan(2000);
  expect(ledgerDigest(dir)).toBe(digest);
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 20000);

test("stdin EOF while a pass is running still exits the worker within 2 s", async () => {
  const dir = agentDir();
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({
    type: "pass",
    id: 4,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 1,
  });
  // Let the pass start and block on its first host request, then cut the pipe.
  const first = await worker.next();
  expect(first.type === "progress" || first.type === "metric").toBe(true);
  const started = Date.now();
  worker.end();
  const code = await worker.exited();
  expect(code).toBe(0);
  expect(Date.now() - started).toBeLessThan(2000);
}, 15000);

test("the parent's credential token never appears in any message the worker emits", async () => {
  const dir = agentDir();
  const workId = "33333333-3333-4333-8333-333333333333";
  backendFor(dir).insertOutboxBatch({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accountKey: JSON.stringify([NO_NETWORK_API, ORG, USER]),
    body: new Uint8Array(),
    eventIds: [],
    createdAt: Date.now(),
    orderKey: "",
  });
  backendFor(dir).insertRecord({
    recordHash: "b".repeat(64),
    type: "request",
    workId,
    sessionId: "session",
    body: JSON.stringify({ version: 1, type: "request", workId, sessionId: "session" }),
    sourcePath: join(dir, "work-attribution", "session.jsonl"),
    sourceGeneration: 0,
    sourceOffset: 0,
    importedAt: Date.now(),
  });
  closeBackends();
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({
    type: "pass",
    id: 5,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 30000,
    epoch: 2,
  });
  // Consent true, so delivery resolves credentials and re-checks them mid-pass;
  // the fake token is answered, and every fetch dies on the closed local port.
  await answerRequestsUntilConsent(worker, true);
  const done = await answerRequestsUntilDone(worker, 5);
  expect(done.result.channels.reporting).toBeDefined();
  worker.end();
  expect(await worker.exited()).toBe(0);
  for (const line of worker.lines()) expect(line.includes(FAKE_TOKEN)).toBe(false);
  expect(worker.stderrText().includes(FAKE_TOKEN)).toBe(false);
}, 20000);

/** Answers consent with the chosen value; returns once the worker asked. */
async function answerRequestsUntilConsent(worker: WorkerHandle, consent: boolean): Promise<void> {
  for (;;) {
    const message = await worker.next();
    if (message.type !== "request") continue;
    if (message.kind === "consent") {
      worker.send({ type: "reply", rid: message.rid, result: { consent } });
      return;
    }
    throw new Error(`expected a consent request, got ${message.kind}`);
  }
}
