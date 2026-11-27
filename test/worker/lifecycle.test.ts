import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  backendFor,
  capture,
  closeBackends,
  readRecords,
  spoolFilePath,
} from "../../src/ledger/records.js";
import { acquireWriterEpoch, openStore } from "../../src/ledger/store.js";
import {
  PROTOCOL_VERSION,
  type DoneMessage,
  type HostRequestKind,
  type WorkerMessage,
} from "../../src/worker/protocol.js";

/**
 * The worker's lifecycle (reconcile-out-of-process plan, chunk B3), against a
 * REAL child process: `bun src/worker/main.ts` — the same runtime the release
 * bundle runs under (Kimchi starts it as `BUN_BE_BUN=1 kimchi
 * share/kimchi/bridge/lib/worker.mjs`, and CI has no kimchi binary). The
 * parent side is a fake: it answers host
 * requests with fake credentials, policy and consent and never needs the
 * network (endpoints point at a closed local port).
 */

const ROOT = join(import.meta.dir, "../..");
const WORKER = join(ROOT, "src/worker/main.ts");
const LEDGER_DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");
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
  gitToken: {},
  endpoints: {
    llmEndpoint: "http://127.0.0.1:1",
    openAiBaseUrl: "http://127.0.0.1:1/openai/v1",
    anthropicBaseUrl: "http://127.0.0.1:1/anthropic",
    experimentalOpenAiBaseUrl: "http://127.0.0.1:1/experimental",
    platformApiUrl: NO_NETWORK_API,
  },
  policy: { resources: { "extensions.cost-per-pr": true } },
  consent: { consent: false },
  // No host-governed PR-reporting choice: the queue keeps its legacy state.json semantics.
  reportingConsent: {},
};

interface WorkerHandle {
  send(message: unknown): void;
  /** Writes raw bytes to the worker's stdin, framing tests included. */
  sendRaw(text: string): void;
  next(): Promise<WorkerMessage>;
  end(): void;
  exited(): Promise<number>;
  kill(): void;
  stderrText(): string;
  lines(): string[];
}

function spawnWorker(dir: string, extraEnv: Record<string, string> = {}): WorkerHandle {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER],
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir, ...extraEnv },
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
  // The fake parent heartbeats its lease like the real one (K2): every 500 ms while the
  // worker lives, so the write fence stays open for the passes this suite drives.
  const heartbeats = setInterval(() => {
    if (proc.exitCode !== null) return;
    proc.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    proc.stdin.flush();
  }, 500);
  const handle: WorkerHandle = {
    send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    },
    sendRaw(text) {
      proc.stdin.write(text);
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
      clearInterval(heartbeats);
      proc.kill();
    },
    stderrText: () => stderr,
    lines: () => lines,
  };
  void proc.exited.then(() => clearInterval(heartbeats));
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
    if (message.type !== "done") continue;
    // Other passes may finish first; only the requested id is awaited.
    if (message.id !== id) continue;
    return message;
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

test("a pass for a different agent directory fails without creating that directory", async () => {
  const trusted = agentDir();
  const other = agentDir();
  const worker = spawnWorker(trusted);
  await handshake(worker, trusted);
  worker.send({
    type: "pass",
    id: 99,
    channels: { files: true, pullRequests: true, costs: true, reporting: true },
    reportingCwd: "/project",
    deadlineMs: 5_000,
    epoch: 0,
    agentDir: other,
  });
  const done = await answerRequestsUntilDone(worker, 99);
  expect(done.result?.outcome).toBe("failed");
  expect(done.result?.channels.files?.outcome).toBe("failed");
  expect(done.result?.channels.pullRequests?.outcome).toBe("failed");
  expect(done.result?.channels.reporting?.outcome).toBe("failed");
  expect(done.result?.channels.files?.error).toContain("agent_directory_mismatch");
  expect(existsSync(join(other, "work-attribution"))).toBe(false);
  worker.end();
  await worker.exited();
});

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
    epoch: 0,
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
  // The pass's measured write transactions ride along (B4): even a read-mostly pass's
  // histogram is present, with nothing slow in it.
  expect(done?.result.txDurations?.count).toBeGreaterThanOrEqual(0);
  expect(done?.result.txDurations?.over250Ms).toBe(0);
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
    if (first.type === "error") expect(first.message.includes("mismatch")).toBe(true);
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
  if (first.type === "error") expect(first.message.includes("invalid protocol line")).toBe(true);
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
    epoch: 0,
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
    epoch: 0,
  });
  // Answer consent so the pass reaches a credentials request, then stall on it:
  // the worker is blocked in the pipe RPC when the cancel arrives.
  let stalled = false;
  const canceling = (async () => {
    for (;;) {
      const message = await worker.next();
      if (message.type === "request" && message.kind === "reportingConsent") {
        worker.send({ type: "reply", rid: message.rid, result: {} });
        continue;
      }
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
    epoch: 0,
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
    epoch: 0,
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
    if (message.kind === "reportingConsent") {
      worker.send({ type: "reply", rid: message.rid, result: {} });
      continue;
    }
    if (message.kind === "consent") {
      worker.send({ type: "reply", rid: message.rid, result: { consent } });
      return;
    }
    throw new Error(`expected a consent request, got ${message.kind}`);
  }
}

test("a cancel for a pass queued behind a blocked one drops it before it starts", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const digest = ledgerDigest(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  // Pass 1 blocks inside its credentials RPC (never answered) ...
  worker.send({
    type: "pass",
    id: 10,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 3000,
    epoch: 0,
  });
  let blocked = false;
  for (;;) {
    const message = await worker.next();
    if (message.type === "request" && message.kind === "reportingConsent") {
      worker.send({ type: "reply", rid: message.rid, result: {} });
      continue;
    }
    if (message.type === "request" && message.kind === "consent") {
      worker.send({ type: "reply", rid: message.rid, result: { consent: true } });
      continue;
    }
    if (message.type === "request" && message.kind === "credentials") {
      blocked = true;
      break;
    }
  }
  expect(blocked).toBe(true);
  // ... pass 2 arrives while pass 1 is still blocked, and is canceled before
  // pass 1 ever finishes: it must never start.
  worker.send({
    type: "pass",
    id: 11,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 0,
  });
  const canceled = Date.now();
  worker.send({ type: "cancel", id: 11 });
  // The cancel is honored as soon as the worker's main thread is free —
  // bounded by pass 1's own deadline, not the 10 s request timeout. Pass 1
  // reports its own done first; the pump then answers pass 2 as canceled.
  const dones = new Map<number, DoneMessage>();
  while (!dones.has(10) || !dones.has(11)) {
    const message = await worker.next();
    if (message.type === "done") dones.set(message.id, message);
  }
  const done = dones.get(11) as DoneMessage;
  expect(done.result.outcome).toBe("canceled");
  expect(done.result.channels.reporting?.outcome).toBe("canceled");
  expect(Date.now() - canceled).toBeLessThan(5000);
  // Nothing about pass 2 ran: no progress, no request, no ledger write.
  const notes = worker
    .lines()
    .filter((line) => line.includes('"progress"') && line.includes('"id":11'));
  expect(notes.length).toBe(0);
  expect(ledgerDigest(dir)).toBe(digest);
  // Pass 1 still finishes on its own terms: its deadline ended it.
  const done1 = dones.get(10) as DoneMessage;
  expect(done1.result.outcome).toBe("failed");
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 20000);

test("a pass queued behind a blocked one is reported expired when its budget ran out in the queue", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  // Pass 1 blocks inside its credentials RPC (never answered).
  worker.send({
    type: "pass",
    id: 12,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 0,
  });
  let blocked = false;
  for (;;) {
    const message = await worker.next();
    if (message.type === "request" && message.kind === "reportingConsent") {
      worker.send({ type: "reply", rid: message.rid, result: {} });
      continue;
    }
    if (message.type === "request" && message.kind === "consent") {
      worker.send({ type: "reply", rid: message.rid, result: { consent: true } });
      continue;
    }
    if (message.type === "request" && message.kind === "credentials") {
      blocked = true;
      break;
    }
  }
  expect(blocked).toBe(true);
  // Pass 2 has a 400 ms budget, measured from this moment (its receipt).
  worker.send({
    type: "pass",
    id: 13,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 400,
    epoch: 0,
  });
  await Bun.sleep(1200);
  // Unblock pass 1: it fails fast on the closed local port, and pass 2 must
  // be dequeued only to be reported expired — never started.
  worker.send({
    type: "cancel",
    id: 12,
  });
  const done1 = await drain(worker, 12);
  expect(done1.result.outcome).toBe("canceled");
  const done2 = await drain(worker, 13);
  expect(done2.result.outcome).toBe("failed");
  expect(done2.result.channels.reporting?.outcome).toBe("failed");
  if (done2.result.channels.reporting?.error)
    expect(done2.result.channels.reporting.error).toContain("deadline");
  const notes = worker
    .lines()
    .filter((line) => line.includes('"progress"') && line.includes('"id":13'));
  expect(notes.length).toBe(0);
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 20000);

test("no token, short, long, or whitespace-only, reaches any worker output or the diagnostics log", async () => {
  const dir = agentDir();
  seedRecord(dir);
  // Opt-in diagnostics on: a channel failure is logged to work-attribution.log,
  // so the log is part of the token-free surface.
  const worker = spawnWorker(dir, { NODE_DEBUG: "kimchi:work-attribution" });
  await handshake(worker, dir);
  const tokens = ["Q", "abcd", "abcdefgh", "kchi_lifecycle_fake_token_0123456789", " \t "];
  // One pass per token: each credentials answer carries it, so the registry
  // holds one secret of every tested shape once they are done. The last one
  // is whitespace-only: a nonempty credential the reply accepts, so it must
  // be registered and scrubbed like any other.
  for (let index = 0; index < tokens.length; index++) {
    worker.send({
      type: "pass",
      id: 20 + index,
      channels: { reporting: true },
      reportingCwd: "/project",
      deadlineMs: 30000,
      epoch: 0,
    });
    for (;;) {
      const message = await worker.next();
      if (message.type === "request") {
        const reply =
          message.kind === "credentials"
            ? { token: tokens[index], apiUrl: NO_NETWORK_API }
            : message.kind === "consent"
              ? { consent: true }
              : REPLIES[message.kind];
        worker.send({ type: "reply", rid: message.rid, result: reply });
        continue;
      }
      if (message.type === "done") break;
    }
  }
  // A pass whose consent reply is invalid fails the reporting channel, which
  // the diagnostics log records — with every token already registered.
  worker.send({
    type: "pass",
    id: 30,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 30000,
    epoch: 0,
  });
  for (;;) {
    const message = await worker.next();
    if (message.type === "request") {
      worker.send({
        type: "reply",
        rid: message.rid,
        result: message.kind === "consent" ? { consent: "not a boolean" } : REPLIES[message.kind],
      });
      continue;
    }
    if (message.type === "done") break;
  }
  worker.end();
  expect(await worker.exited()).toBe(0);
  for (const token of tokens) {
    for (const line of worker.lines()) expect(line.includes(token)).toBe(false);
    expect(worker.stderrText().includes(token)).toBe(false);
  }
  const log = join(dir, "logs", "work-attribution.log");
  expect(existsSync(log)).toBe(true);
  const text = readFileSync(log, "utf8");
  expect(text.includes("Could not report PR costs")).toBe(true);
  for (const token of tokens) expect(text.includes(token)).toBe(false);
}, 40000);

test("a mismatching build cannot forge stderr lines with control characters", async () => {
  const dir = agentDir();
  const worker = spawnWorker(dir);
  worker.send({
    type: "hello",
    v: PROTOCOL_VERSION,
    build: "oops\nFORGED-stderr-line",
    agentDir: dir,
  });
  const first = await worker.next();
  expect(first.type).toBe("error");
  const code = await worker.exited();
  expect(code).not.toBe(0);
  // The refusal stays on one stderr line and never echoes the supplied build.
  const lines = worker
    .stderrText()
    .split("\n")
    .filter((line) => line.trim() !== "");
  expect(lines.length).toBe(1);
  expect(lines[0].includes("FORGED")).toBe(false);
  expect(lines[0].includes("oops")).toBe(false);
}, 15000);

test("a parent that closes the worker's stdout read end gets a clean exit within 2 s", async () => {
  const dir = agentDir();
  // node:child_process, not Bun.spawn: the test must close the child's stdout
  // read end while leaving stdin open, which Bun's stream wrapper cannot do.
  const child = spawn(process.execPath, [WORKER], {
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const write = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  try {
    // Handshake while the pipe is whole, then cut the parent's read end.
    const first = await new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      child.stdout.once("error", reject);
      write({ type: "hello", v: PROTOCOL_VERSION, build: BUILD, agentDir: dir });
    });
    expect(JSON.parse(first.trim()).type).toBe("ready");
    child.stdout.destroy();
    const started = Date.now();
    write({
      type: "pass",
      id: 40,
      channels: { reporting: true },
      reportingCwd: "/project",
      deadlineMs: 60000,
      epoch: 0,
    });
    // The worker's first write after the cut fails: it must treat that as
    // parent death and leave on its own, not block or wait out a timeout.
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", (code: number | null) => resolve(code));
      child.once("error", reject);
      setTimeout(() => reject(new Error("the worker never exited")), 5000);
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    child.kill();
  }
}, 15000);

test("a late reply after a request's timeout never satisfies a later request", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  // Pass 1: consent is granted, then the credentials request is never
  // answered; the 10 s request timeout ends the pass.
  worker.send({
    type: "pass",
    id: 50,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 0,
  });
  let stalled: number | undefined;
  for (;;) {
    const message = await worker.next();
    if (message.type !== "request") continue;
    if (message.kind === "reportingConsent") {
      worker.send({ type: "reply", rid: message.rid, result: {} });
      continue;
    }
    if (message.kind === "consent") {
      worker.send({ type: "reply", rid: message.rid, result: { consent: true } });
      continue;
    }
    stalled = message.rid;
    break;
  }
  expect(stalled).toBeDefined();
  const done1 = await drain(worker, 50);
  expect(done1.result.outcome).toBe("failed");
  // The expired host request held the main thread for 10 s. Even though the helper kept
  // receiving, that hold's conservative refusal ends only after later punctual anchors.
  // Let two parent cadences and their anchors pass so recovery holds without weak timing margins.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  // Pass 2 asks again with consent granted, so its credentials request
  // really happens; only after seeing the new request does the parent
  // deliver the stale reply belonging to pass 1's timed-out request — with
  // a token pass 2 must never see as its answer.
  worker.send({
    type: "pass",
    id: 51,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 0,
  });
  let done2: DoneMessage | undefined;
  let staleSent = false;
  for (;;) {
    const message = await worker.next();
    if (message.type === "done") {
      done2 = message;
      break;
    }
    if (message.type !== "request") continue;
    if (message.kind === "reportingConsent") {
      worker.send({ type: "reply", rid: message.rid, result: {} });
      continue;
    }
    if (message.kind === "consent") {
      worker.send({ type: "reply", rid: message.rid, result: { consent: true } });
      continue;
    }
    if (message.kind === "credentials") {
      // The later request has a rid of its own; the stale one is for the
      // request that already timed out.
      expect(message.rid).not.toBe(stalled);
      worker.send({
        type: "reply",
        rid: stalled as number,
        result: {
          token: "stale_token_never_an_answer_012345",
          apiUrl: NO_NETWORK_API,
        },
      });
      staleSent = true;
    }
    worker.send({ type: "reply", rid: message.rid, result: REPLIES[message.kind] });
  }
  // The stale reply was really delivered after the timeout, yet the fresh
  // answer is the one that satisfied the request.
  expect(staleSent).toBe(true);
  expect(done2.result.outcome).toBe("ok");
  for (const line of worker.lines())
    expect(line.includes("stale_token_never_an_answer_012345")).toBe(false);
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 40000);

test("a delayed reply publication never fails the next host request", async () => {
  const dir = agentDir();
  seedRecord(dir);
  // The fake parent grants the pass's fencing epoch like a real lease holder:
  // it bumps meta.writer_epoch first (B4), so the worker's writes pass the
  // fence while the delayed publications are probed. A granted epoch the
  // ledger never received would fence every write instead.
  const leaseStore = openStore(dir);
  let epoch: number;
  try {
    epoch = acquireWriterEpoch(leaseStore);
  } finally {
    leaseStore.close();
  }
  // The reader thread's test-only delay holds every checked reply between
  // its state/rid checks and its publication — the preemption window the
  // reviewer probed. A reply for a request that has since timed out must
  // then be declined, never published into the next request's slot as a
  // poisoned READY that fails that request as invalid-reply.
  const worker = spawnWorker(dir, { KIMCHI_WORKER_TEST_REPLY_DELAY_MS: "300" });
  await handshake(worker, dir);
  // Pass 1's 100 ms deadline expires while the reader thread still holds its
  // consent reply, so the pass ends on its own deadline, not its own answer.
  worker.send({
    type: "pass",
    id: 80,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 100,
    epoch,
  });
  // Pass 2 is queued while pass 1 is still in flight: its consent request
  // must already be waiting when the reader thread wakes to publish pass 1's
  // held reply, so the stale publication meets a slot owned by a live
  // request — the exact ordering a preemption between the checks and the
  // publication produces. (Sending it after pass 1's done would not do: the
  // pass line itself waits behind the sleeping reader on stdin.)
  worker.send({
    type: "pass",
    id: 81,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch,
  });
  let answeredForPass1 = false;
  let done80: DoneMessage | undefined;
  let done81: DoneMessage | undefined;
  for (;;) {
    const message = await worker.next();
    if (message.type === "request") {
      if (done80 === undefined) answeredForPass1 = true; // pass 1's held reply exists
      worker.send({ type: "reply", rid: message.rid, result: REPLIES[message.kind] });
      continue;
    }
    if (message.type !== "done") continue;
    if (message.id === 80) done80 = message;
    if (message.id === 81) {
      done81 = message;
      break;
    }
  }
  if (done80 === undefined || done81 === undefined) throw new Error("a pass never finished");
  // Pass 1's held reply was really answered before its deadline ended it.
  expect(answeredForPass1).toBe(true);
  expect(done80.result.outcome).toBe("failed");
  expect(done80.result.channels.reporting?.error).toContain("deadline");
  // Pass 2 completed on its own answers, each delivered after the held
  // publication of pass 1's reply was declined.
  expect(done81.result.outcome).toBe("ok");
  expect(done81.result.channels.reporting?.outcome).toBe("ok");
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 20000);

test("several messages in one chunk and a line split across chunks both parse", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const worker = spawnWorker(dir);
  // The whole handshake and the pass message arrive as one write; the second
  // pass message is split mid-JSON across two writes.
  const hello = JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, build: BUILD, agentDir: dir });
  const pass = JSON.stringify({
    type: "pass",
    id: 60,
    channels: { files: true },
    deadlineMs: 30000,
    epoch: 0,
  });
  worker.sendRaw(`${hello}\n${pass}\n`);
  const first = await worker.next();
  expect(first.type).toBe("ready");
  const split = JSON.stringify({
    type: "pass",
    id: 61,
    channels: { files: true },
    deadlineMs: 30000,
    epoch: 0,
  });
  worker.sendRaw(split.slice(0, Math.floor(split.length / 2)));
  await Bun.sleep(150);
  worker.sendRaw(`${split.slice(Math.floor(split.length / 2))}\n`);
  const done60 = await drain(worker, 60);
  expect(done60.result.outcome).toBe("ok");
  const done61 = await drain(worker, 61);
  expect(done61.result.outcome).toBe("ok");
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 15000);

test("a reply larger than the pipe buffer fails the request instead of truncating", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({
    type: "pass",
    id: 70,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 60000,
    epoch: 0,
  });
  // A consent answer padded past the 64 KiB shared reply slot: the worker
  // must fail the request with the typed oversized error, never use a cut of
  // the line. The consent failure propagates out of the reporting channel's
  // state gate, so the rejection is observable on the wire.
  const huge = "x".repeat(70_000);
  let done: DoneMessage | undefined;
  for (;;) {
    const message = await worker.next();
    if (message.type === "request") {
      const result =
        message.kind === "consent"
          ? { consent: true, pad: huge }
          : message.kind === "credentials"
            ? { token: FAKE_TOKEN, apiUrl: NO_NETWORK_API }
            : REPLIES[message.kind];
      worker.send({ type: "reply", rid: message.rid, result });
      continue;
    }
    if (message.type === "done") {
      done = message;
      break;
    }
  }
  expect(done.result.outcome).toBe("failed");
  expect(done.result.channels.reporting?.outcome).toBe("failed");
  if (done.result.channels.reporting?.error) {
    expect(done.result.channels.reporting.error).toContain("exceeded");
    expect(done.result.channels.reporting.error).toContain("pipe buffer");
  }
  // The oversized payload never leaked into the failure report either.
  for (const line of worker.lines()) expect(line.includes("xxxxx")).toBe(false);
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 20000);

test("an idle worker exits after its idle lifetime, and a pass rearms it", async () => {
  const dir = agentDir();
  const worker = spawnWorker(dir, { KIMCHI_WORKER_IDLE_EXIT_MS: "1000" });
  await handshake(worker, dir);
  const handed = Date.now();
  // One quick files-only pass: the idle window must restart from its end,
  // not from the handshake.
  worker.send({
    type: "pass",
    id: 80,
    channels: { files: true },
    deadlineMs: 30000,
    epoch: 0,
  });
  const done = await answerRequestsUntilDone(worker, 80);
  expect(done.result.outcome).toBe("ok");
  const passedAt = Date.now();
  // Half the idle window after the pass: still alive.
  await Bun.sleep(500);
  // The worker exits on its own once the rearmed window closes.
  const code = await worker.exited();
  expect(code).toBe(0);
  expect(Date.now() - passedAt).toBeGreaterThanOrEqual(900);
  expect(Date.now() - handed).toBeLessThan(15000);
}, 20000);

test("the saved git host token is answered over the pipe and never reported", async () => {
  const dir = agentDir();
  // A real git repository whose remote names no known provider: PR discovery
  // asks the parent for that host's saved token before any lookup. The remote
  // points at a closed local port, so the lookup itself needs no network.
  const repo = mkdtempSync(join(tmpdir(), "kimchi-worker-life-git-"));
  dirs.push(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://127.0.0.1:9/owner/repo.git",
  ]);
  const workId = "44444444-4444-4444-8444-444444444444";
  backendFor(dir).insertRecord({
    recordHash: "c".repeat(64),
    type: "commit",
    workId,
    sessionId: "session",
    body: JSON.stringify({
      version: 1,
      type: "commit",
      workId,
      sessionId: "session",
      sha: "1234567890abcdef1234567890abcdef12345678",
      repository: repo,
      worktree: repo,
      cwd: repo,
    }),
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
    id: 16,
    channels: { pullRequests: true },
    deadlineMs: 30000,
    epoch: 0,
  });
  const SAVED = "ghp_lifecycle_saved_git_token_0123456";
  const hosts: string[] = [];
  let done: DoneMessage | undefined;
  for (;;) {
    const message = await worker.next();
    if (message.type === "request") {
      if (message.kind === "gitToken") {
        hosts.push(message.host ?? "");
        worker.send({ type: "reply", rid: message.rid, result: { token: SAVED } });
        continue;
      }
      worker.send({ type: "reply", rid: message.rid, result: REPLIES[message.kind] });
      continue;
    }
    if (message.type === "done") {
      done = message;
      break;
    }
  }
  // The token request carried the remote's host, and the reply's token is a
  // live secret from the moment it is answered.
  expect(hosts.length).toBeGreaterThan(0);
  for (const host of hosts) expect(host.includes("127.0.0.1")).toBe(true);
  expect(done?.result.channels.pullRequests).toBeDefined();
  worker.end();
  expect(await worker.exited()).toBe(0);
  // The saved token never reaches any output, even though the lookup fails.
  for (const line of worker.lines()) expect(line.includes(SAVED)).toBe(false);
  expect(worker.stderrText().includes(SAVED)).toBe(false);
}, 40000);

test("the worker carries the pass's continuation progress into the next pass", async () => {
  const dir = agentDir();
  // A session journal with one valid request record: the first pass imports
  // it, finds no receipts to repair and nothing to write, and settles the
  // journals (the quiet fast path's progress).
  mkdirSync(join(dir, "work-attribution"), { recursive: true });
  const journal = join(dir, "work-attribution", "session.jsonl");
  writeFileSync(
    journal,
    `${JSON.stringify({
      version: 1,
      type: "request",
      workId: "55555555-5555-4555-8555-555555555555",
      sessionId: "session",
      requestId: "66666666-6666-4666-8666-666666666666",
    })}\n`,
  );
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({ type: "pass", id: 17, channels: { files: true }, deadlineMs: 30000, epoch: 0 });
  const done1 = await drain(worker, 17);
  expect(done1.result.outcome).toBe("ok");
  expect(done1.result.channels.files?.outcome).toBe("ok");
  // Real damage lands after the cursor: an unparsable line, not an
  // in-progress append. A pass that rebuilds its history from scratch must
  // refuse to treat the journal as complete; the quiet fast path — which only
  // the progress carried from pass 1 can take — absorbs it.
  appendFileSync(journal, "this line is not json\n");
  worker.send({ type: "pass", id: 18, channels: { files: true }, deadlineMs: 30000, epoch: 0 });
  const done2 = await drain(worker, 18);
  expect(done2.result.outcome).toBe("ok");
  expect(done2.result.channels.files?.outcome).toBe("ok");
  worker.end();
  expect(await worker.exited()).toBe(0);
  // The counterfactual, on the same on-disk state: a fresh worker with no
  // carried progress does the full rebuild, and the strict history read
  // reports the damage. Pass 2's ok above proves the progress was carried —
  // the supervisor's ContinuationProgress, kept on the worker between passes.
  const fresh = spawnWorker(dir);
  await handshake(fresh, dir);
  fresh.send({ type: "pass", id: 19, channels: { files: true }, deadlineMs: 30000, epoch: 0 });
  const done3 = await drain(fresh, 19);
  expect(done3.result.outcome).toBe("failed");
  expect(done3.result.channels.files?.outcome).toBe("failed");
  if (done3.result.channels.files?.error)
    expect(done3.result.channels.files.error).toContain("invalid records");
  fresh.end();
  expect(await fresh.exited()).toBe(0);
}, 20000);

test("a pass that fails before any channel reports the channels as failed, not ok", async () => {
  const dir = agentDir();
  // A regular file where the work-attribution directory belongs: the pass
  // fails at startup, before any channel runs.
  writeFileSync(join(dir, "work-attribution"), "not a directory");
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({ type: "pass", id: 15, channels: { files: true }, deadlineMs: 30000, epoch: 0 });
  const done = await answerRequestsUntilDone(worker, 15);
  expect(done.result.outcome).toBe("failed");
  expect(done.result.channels.files?.outcome).toBe("failed");
  if (done.result.channels.files?.error)
    expect(done.result.channels.files.error.length).toBeGreaterThan(0);
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 15000);

test("the pass deadline wakes a host request the parent stalls on", async () => {
  const dir = agentDir();
  seedRecord(dir);
  const worker = spawnWorker(dir);
  await handshake(worker, dir);
  worker.send({
    type: "pass",
    id: 14,
    channels: { reporting: true },
    reportingCwd: "/project",
    deadlineMs: 500,
    epoch: 0,
  });
  const started = Date.now();
  let done: DoneMessage | undefined;
  for (;;) {
    const message = await worker.next();
    if (message.type === "request") {
      // The parent never replies: the deadline, not the 10 s request
      // timeout, must end the wait and fail the channel.
      continue;
    }
    if (message.type === "done") {
      done = message;
      break;
    }
  }
  // 500 ms deadline plus slack; far below the 10 s request timeout.
  expect(Date.now() - started).toBeLessThan(5000);
  expect(done?.result.outcome).toBe("failed");
  expect(done?.result.channels.reporting?.outcome).toBe("failed");
  if (done?.result.channels.reporting?.error)
    expect(done.result.channels.reporting.error).toContain("deadline");
  worker.end();
  expect(await worker.exited()).toBe(0);
}, 20000);

test("capture under a 6 s writer spools, and the next worker pass imports it exactly once", async () => {
  const dir = agentDir();
  const workId = "22222222-2222-4222-8222-222222222222";
  const rec = {
    version: 1,
    type: "request",
    workId,
    sessionId: "session",
    requestId: "33333333-3333-4333-8333-333333333333",
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
  // The session process (this test) opened its backend before the contention began.
  expect(readRecords(dir)).toHaveLength(0);
  // A 6 s writer held in another process: capture must park the record in the spool and
  // return, never block the session out past the busy window.
  const holder = spawn(process.execPath, [LEDGER_DRIVER, "hold-writer", dir, "6000"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const held = await (async () => {
      const lines = createInterface({ input: holder.stdout! });
      const messages = lines[Symbol.asyncIterator]();
      const first = await messages.next();
      return !first.done && (JSON.parse(first.value) as { held?: boolean }).held === true;
    })();
    expect(held).toBe(true);
    const start = Date.now();
    capture(dir, rec as never, "summary-native");
    expect(Date.now() - start).toBeLessThan(260);
    expect(existsSync(spoolFilePath(dir, "session"))).toBe(true);
    expect(readRecords(dir)).toHaveLength(0);
  } finally {
    await new Promise((resolve) => holder.once("exit", resolve));
  }

  // The next pass through the real worker imports the spooled record exactly once, and the
  // spool retires; a second pass and a re-capture of the same line change nothing.
  const worker = spawnWorker(dir);
  try {
    await handshake(worker, dir);
    worker.send({ type: "pass", id: 41, channels: { files: true }, deadlineMs: 30000, epoch: 0 });
    const done = await answerRequestsUntilDone(worker, 41);
    expect(done.result.outcome).toBe("ok");
    expect(done.result.channels.files?.outcome).toBe("ok");
    expect(readRecords(dir)).toHaveLength(1);
    expect(existsSync(spoolFilePath(dir, "session"))).toBe(false);
    worker.send({ type: "pass", id: 42, channels: { files: true }, deadlineMs: 30000, epoch: 0 });
    expect((await answerRequestsUntilDone(worker, 42)).result.outcome).toBe("ok");
    capture(dir, rec as never, "summary-native");
    expect(readRecords(dir)).toHaveLength(1);
  } finally {
    worker.kill();
    await worker.exited();
  }
}, 30000);

test("a pass must name the inherited agent directory across a link move", async () => {
  const root = mkdtempSync(join(tmpdir(), "kimchi-worker-pin-"));
  dirs.push(root);
  const original = join(root, "original-agent");
  const replacement = join(root, "replacement-agent");
  const link = join(root, "agent-link");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  mkdirSync(replacement, { recursive: true, mode: 0o700 });
  symlinkSync(original, link);
  // A directory pinned before the link moves is a different tree from the inherited link's
  // current target. It must be rejected before writing, while a pass naming the current target
  // is valid and runs on that target, never on the pre-move directory.
  const pinned = realpathSync(link);
  unlinkSync(link);
  symlinkSync(replacement, link);
  const worker = spawnWorker(link);
  try {
    await handshake(worker, link);
    worker.send({
      type: "pass",
      id: 70,
      channels: { files: true },
      deadlineMs: 30000,
      epoch: 0,
      agentDir: pinned,
    });
    const invalid = await answerRequestsUntilDone(worker, 70);
    expect(invalid.result.outcome).toBe("failed");
    expect(invalid.result.channels.files?.error).toContain("agent_directory_mismatch");
    expect(existsSync(join(pinned, "work-attribution"))).toBe(false);
    expect(existsSync(join(pinned, "pr-cost-reporting"))).toBe(false);
    expect(existsSync(join(replacement, "work-attribution"))).toBe(false);
    expect(existsSync(join(replacement, "pr-cost-reporting"))).toBe(false);
    const currentPinned = realpathSync(link);
    worker.send({
      type: "pass",
      id: 71,
      channels: { files: true },
      deadlineMs: 30000,
      epoch: 0,
      agentDir: currentPinned,
    });
    const valid = await answerRequestsUntilDone(worker, 71);
    expect(valid.result.outcome).toBe("ok");
    expect(valid.result.channels.files?.outcome).toBe("ok");
    worker.end();
    expect(await worker.exited()).toBe(0);
    expect(existsSync(join(currentPinned, "work-attribution"))).toBe(true);
    expect(existsSync(join(currentPinned, "pr-cost-reporting"))).toBe(true);
    expect(existsSync(join(pinned, "work-attribution"))).toBe(false);
    expect(existsSync(join(pinned, "pr-cost-reporting"))).toBe(false);
  } finally {
    worker.kill();
    await worker.exited();
  }
}, 20000);
