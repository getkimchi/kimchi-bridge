import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";
import { closeBackends, readRecords, readWorkSummary } from "../../src/ledger/records.js";
import type { WorkHead } from "../../src/ledger/row-log.js";

/**
 * The native summary races Kimchi drove through its ledger driver, ported against the same
 * driver commands: a cancelled writer rolls back its published head before a competing real
 * process commits; a pending capture commits before the shutdown flush; a killed owner never
 * republishes its uncommitted head; a reader that keeps answering survives past its
 * cumulative stall budget because each answer resets the watchdog; and three gated writers
 * serialize on the real SQLite write lock while a separate reader sees only coherent
 * committed authority, markers and projection. Only the direct ledger operations and the
 * moved flushWorkSummaries tail matter here, so Kimchi's session-side wrappers stay behind.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

interface Writer {
  child: ReturnType<typeof spawn>;
  next: () => Promise<string>;
  done: Promise<number | null>;
  stop: () => Promise<void>;
}

/**
 * Reads one phase string per line of JSON written by the driver on stdout. Parsed lines are
 * queued by readline, so a phase is never lost when it arrives before next() or when one stdout
 * chunk carries several phase lines; when the stream ends, a pending next() rejects instead of
 * hanging until the test timeout.
 */
interface PhaseReader {
  next: () => Promise<string>;
  stop: () => void;
}

function startPhaseReader(input: NodeJS.ReadableStream, label = "Writer"): PhaseReader {
  const lines = createInterface({ input });
  const messages = lines[Symbol.asyncIterator]();
  return {
    next: async () => {
      const line = await messages.next();
      if (line.done) throw new Error(`${label} ended before its next phase`);
      return (JSON.parse(line.value) as { phase: string }).phase;
    },
    stop: () => lines.close(),
  };
}

function startWriter(dir: string, record: WorkRecord): Writer {
  const child = spawn("bun", [DRIVER, "summary-writer", dir, JSON.stringify({ record })], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const phases = startPhaseReader(child.stdout!);
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return {
    child,
    next: phases.next,
    done,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await done.catch(() => {});
      phases.stop();
    },
  };
}

it("delivers both phases when one stdout chunk coalesces two phase lines", async () => {
  const stdout = new PassThrough();
  const phases = startPhaseReader(stdout);
  stdout.write(`${JSON.stringify({ phase: "ready" })}\n${JSON.stringify({ phase: "pending" })}\n`);
  expect(await phases.next()).toBe("ready");
  expect(await phases.next()).toBe("pending");
  phases.stop();
  stdout.end();
}, 2_000);

it("delivers every phase when one chunk coalesces three phase lines", async () => {
  const stdout = new PassThrough();
  const phases = startPhaseReader(stdout);
  stdout.write(
    `${JSON.stringify({ phase: "ready" })}\n${JSON.stringify({ phase: "pending" })}\n${JSON.stringify({ phase: "rolled-back" })}\n`,
  );
  expect(await phases.next()).toBe("ready");
  expect(await phases.next()).toBe("pending");
  expect(await phases.next()).toBe("rolled-back");
  phases.stop();
  stdout.end();
}, 2_000);

it("rejects a pending phase read when the child stdout ends first", async () => {
  const stdout = new PassThrough();
  const phases = startPhaseReader(stdout);
  stdout.end();
  await expect(phases.next()).rejects.toThrow("Writer ended before its next phase");
  phases.stop();
}, 2_000);

function driver(...args: string[]): unknown {
  return JSON.parse(
    Bun.spawnSync(["bun", DRIVER, ...args], { cwd: ROOT, timeout: 60_000 })
      .stdout.toString()
      .trim()
      .split("\n")
      .at(-1) ?? "{}",
  );
}

// --- The remaining native races: Kimchi's summary.test.ts capture/flush scenarios -------------

interface NativeSummaryState {
  authority: { record_hash: string; body: string }[];
  markers: { record_hash: string }[];
  head: string | null;
  rows: { log: string; key: string; pos: number; body: string }[];
}

interface SummaryRow {
  requestId?: string;
  responseId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** Kimchi's coherentState: markers mirror authority, every body hashes to its key, the head's
 * log metadata matches the rows, and the requests log mirrors the authority's requests. */
function coherentState(state: NativeSummaryState): {
  requests: SummaryRow[];
  sessions: SummaryRow[];
} {
  expect(state.markers.map((row) => row.record_hash).sort()).toEqual(
    state.authority.map((row) => row.record_hash).sort(),
  );
  for (const row of state.authority)
    expect(row.record_hash).toBe(createHash("sha256").update(row.body).digest("hex"));
  if (state.head === null) {
    expect(state.authority).toEqual([]);
    expect(state.rows).toEqual([]);
    return { requests: [], sessions: [] };
  }
  const head = JSON.parse(state.head) as WorkHead;
  for (const [log, metadata] of Object.entries(head.logs)) {
    const rows = state.rows.filter((row) => row.log === log);
    expect(metadata).toMatchObject({
      rows: rows.length,
      bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row.body) + 1, 0),
    });
    expect(rows.map((row) => row.pos)).toEqual(rows.map((_, index) => index + 1));
  }
  const requests: SummaryRow[] = state.rows
    .filter((row) => row.log === "requests")
    .map((row) => JSON.parse(row.body) as SummaryRow);
  const sessions: SummaryRow[] = state.rows
    .filter((row) => row.log === "sessions")
    .map((row) => JSON.parse(row.body) as SummaryRow);
  const requestIds = state.authority
    .map((row): SummaryRow => JSON.parse(row.body))
    .filter((row) => row.type === "request")
    .map((row) => row.requestId);
  expect(requests.map((row) => row.requestId).sort()).toEqual([...new Set(requestIds)].sort());
  return { requests, sessions };
}

function nativeRecord(
  workId: string,
  sessionId = "native",
  requestId: string = randomUUID(),
): WorkRecord {
  return {
    version: 1,
    type: "request",
    workId,
    sessionId,
    requestId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

interface NativeMessage {
  phase: string;
  state?: NativeSummaryState;
}

/** Kimchi's startNativeProcess: a real driver subprocess, one JSON message per stdout line, a
 * stall watchdog that each answered message resets, and a done promise that rejects on any
 * non-zero exit. */
function startNativeProcess(
  command: "summary-writer" | "summary-reader",
  dir: string,
  argument: string,
  watchdogMs = 10_000,
) {
  const child = spawn("bun", [DRIVER, command, dir, argument], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const label = command === "summary-writer" ? "Native writer" : "Native reader";
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${errors}`)),
    );
  });
  let timeout = setTimeout(() => child.kill("SIGKILL"), watchdogMs);
  const resetWatchdog = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => child.kill("SIGKILL"), watchdogMs);
  };
  void done.finally(() => clearTimeout(timeout)).catch(() => {});
  return {
    child,
    done,
    async next(): Promise<NativeMessage> {
      const line = await messages.next();
      if (line.done) throw new Error(`${label} ended before its barrier: ${errors}`);
      // Progressing multi-barrier tests may take longer than one stall budget.
      resetWatchdog();
      return JSON.parse(line.value) as NativeMessage;
    },
    async stop() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await done.catch(() => {});
      lines.close();
    },
  };
}

/** Kimchi's startNative: the summary-writer with its record, count and flush gate. */
function startNative(record: WorkRecord, dir: string, count = 1, beforeFlush = false) {
  const writer = startNativeProcess(
    "summary-writer",
    dir,
    JSON.stringify({ record, count, beforeFlush }),
  );
  return { ...writer, next: async () => (await writer.next()).phase };
}

const dirs: string[] = [];
afterEach(() => {
  closeBackends();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("rolls back a cancelled native publisher before a competing writer commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-summary-writer-"));
  dirs.push(dir);
  const workId = randomUUID();
  const base: WorkRecord = {
    version: 1,
    type: "request",
    workId,
    sessionId: "seed",
    requestId: "shared-request",
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
  driver("capture", dir, JSON.stringify(base));
  const before = driver("summary-state", dir, workId);
  const cancelled = startWriter(dir, {
    ...base,
    type: "request_response",
    sessionId: "cancelled",
    responseId: "stale",
  });
  let winner: Writer | undefined;
  try {
    expect(await cancelled.next()).toBe("ready");
    expect(await cancelled.next()).toBe("pending");
    winner = startWriter(dir, {
      ...base,
      type: "request_response",
      sessionId: "winner",
      responseId: "newer",
    });
    expect(await winner.next()).toBe("ready");
    // The cancelled writer's head is published only inside its open transaction: invisible.
    expect(driver("summary-state", dir, workId)).toEqual(before);
    cancelled.child.stdin?.write("r");
    expect(await cancelled.next()).toBe("rolled-back");
    expect(await winner.next()).toBe("pending");
    expect(driver("summary-state", dir, workId)).toEqual(before);
    winner.child.stdin?.write("c");
    expect(await winner.next()).toBe("committed");
    await winner.done;
    const committed = driver("summary-state", dir, workId);
    const view = readWorkSummary(dir, workId);
    expect(view?.requests).toEqual([
      expect.objectContaining({ requestId: base.requestId, responseId: "newer" }),
    ]);
    expect([...(view?.sessions ?? [])].sort()).toEqual(["seed", "winner"]);
    expect(readRecords(dir, { workId })).toHaveLength(2);
    // Closing the still-live cancelled owner cannot republish its old head after the winner.
    expect(cancelled.child.exitCode).toBeNull();
    cancelled.child.stdin?.write("c");
    await cancelled.done;
    expect(driver("summary-state", dir, workId)).toEqual(committed);
  } finally {
    await cancelled.stop();
    await winner?.stop();
  }
}, 30_000);

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-summary-native-"));
  dirs.push(dir);
  return dir;
}

it("commits a pending native capture before shutdown flush completes", async () => {
  const dir = tempDir();
  const workId = randomUUID();
  const record = nativeRecord(workId);
  const writer = startNative(record, dir);
  try {
    expect(await writer.next()).toBe("ready");
    expect(await writer.next()).toBe("pending");
    // A separate WAL reader sees neither the uncommitted header nor its authority/marker.
    const pending = driver("summary-state", dir, workId) as NativeSummaryState;
    expect(pending).toEqual({ authority: [], markers: [], head: null, rows: [] });
    expect(writer.child.exitCode).toBeNull();
    writer.child.stdin?.write("c");
    expect(await writer.next()).toBe("committed");
    expect(await writer.next()).toBe("flushed");
    await writer.done;
    const reopened = driver("summary-state", dir, workId) as NativeSummaryState;
    expect(coherentState(reopened).requests).toEqual([
      expect.objectContaining({ requestId: record.requestId, scope: null }),
    ]);
    expect(fs.existsSync(join(dir, "work", workId, "work.json"))).toBe(false);
    expect(fs.existsSync(join(dir, "work-attribution"))).toBe(false);
  } finally {
    await writer.stop();
  }
}, 15_000);

it("recovers a killed native owner without publishing its uncommitted head", async () => {
  const dir = tempDir();
  const workId = randomUUID();
  const base = nativeRecord(workId, "seed", "shared-request");
  driver("capture", dir, JSON.stringify(base));
  const before = driver("summary-state", dir, workId) as NativeSummaryState;
  const owner = startNative({ ...base, type: "request_response", responseId: "killed" }, dir);
  try {
    expect(await owner.next()).toBe("ready");
    expect(await owner.next()).toBe("pending");
    expect(driver("summary-state", dir, workId)).toEqual(before);
    owner.child.kill("SIGKILL");
    await expect(owner.done).rejects.toThrow("Native writer exited");
    expect(driver("summary-state", dir, workId)).toEqual(before);
    driver(
      "capture",
      dir,
      JSON.stringify({ ...base, type: "request_response", responseId: "recovered" }),
    );
    const reopened = driver("summary-state", dir, workId) as NativeSummaryState;
    expect(coherentState(reopened).requests).toEqual([
      expect.objectContaining({ requestId: base.requestId, responseId: "recovered" }),
    ]);
    expect(reopened.authority).toHaveLength(2);
    expect(fs.existsSync(join(dir, "work-attribution"))).toBe(false);
  } finally {
    await owner.stop();
  }
}, 15_000);

it("keeps a responding reader beyond its cumulative watchdog deadline", async () => {
  const dir = tempDir();
  const workId = randomUUID();
  expect(driver("records", dir, workId)).toEqual([]);
  // Each real pause stays below the 400 ms stall budget, but their sum exceeds it: only the
  // per-answer watchdog reset keeps the reader alive. (Kimchi advanced fake timers for this;
  // Bun has none, so the same arithmetic runs in real time at a proportionate scale.)
  const reader = startNativeProcess("summary-reader", dir, workId, 400);
  try {
    expect((await reader.next()).phase).toBe("ready");
    for (let index = 0; index < 12; index++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      reader.child.stdin?.write("read\n");
      expect((await reader.next()).phase).toBe("snapshot");
    }
    expect(reader.child.exitCode).toBeNull();
  } finally {
    await reader.stop();
  }
}, 15_000);

it("serializes three native writers while a reader sees coherent authority, markers and projection", async () => {
  const dir = tempDir();
  const workId = randomUUID();
  expect(driver("records", dir, workId)).toEqual([]);
  const reader = startNativeProcess("summary-reader", dir, workId);
  const writers: ReturnType<typeof startNative>[] = [];
  const observed: number[] = [];
  try {
    expect((await reader.next()).phase).toBe("ready");
    writers.push(
      ...Array.from({ length: 3 }, (_, index) =>
        startNative(nativeRecord(workId, `session-${index}`), dir, 8),
      ),
    );
    await Promise.all(writers.map(async (writer) => expect(await writer.next()).toBe("ready")));
    await Promise.all(
      writers.map(async (writer) => {
        for (let index = 0; index < 8; index++) {
          expect(await writer.next()).toBe("pending");
          reader.child.stdin?.write("read\n");
          const message = await reader.next();
          expect(message.phase).toBe("snapshot");
          if (!message.state) throw new Error("Native reader omitted its snapshot");
          observed.push(coherentState(message.state).requests.length);
          writer.child.stdin?.write("c");
          expect(await writer.next()).toBe("committed");
        }
        expect(await writer.next()).toBe("flushed");
        await writer.done;
      }),
    );
    const final = driver("summary-state", dir, workId) as NativeSummaryState;
    const view = coherentState(final);
    expect([...observed, view.requests.length].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index),
    );
    expect(view.requests.map((row) => row.requestId).sort()).toEqual(
      Array.from({ length: 3 }, (_, session) =>
        Array.from({ length: 8 }, (_, request) => `session-${session}-${request}`),
      )
        .flat()
        .sort(),
    );
    expect(view.sessions.map((row) => row.sessionId).sort()).toEqual([
      "session-0",
      "session-1",
      "session-2",
    ]);
    expect(final.authority).toHaveLength(24);
    expect(fs.existsSync(join(dir, "work", workId, "work.json"))).toBe(false);
    expect(fs.existsSync(join(dir, "work-attribution"))).toBe(false);
  } finally {
    await Promise.all(writers.map((writer) => writer.stop()));
    await reader.stop();
  }
}, 15_000);
