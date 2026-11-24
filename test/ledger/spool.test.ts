import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "bun:test";
import { importSpool } from "../../src/ledger/import.js";
import {
  backendFor,
  capture,
  closeBackends,
  readRecords,
  readWorkSummary,
  spoolFilePath,
} from "../../src/ledger/records.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * The capture spool against the real SQLite backend and real other processes: with a writer held
 * across the process boundary, capture returns inside its short busy window with the exact record
 * line fsynced in the session's spool; the spool import lands it exactly once (against a
 * re-capture too) and deletes the file only after its cursor reached EOF with the rows
 * committed. A spool that cannot be written falls back to today's blocking wait — a record is
 * never dropped. One case adds WAL-checkpoint load, the risk the plan calls out.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-spool-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const WORK = "00000000-0000-4000-8000-000000000001";

function record(requestId: string, sessionId = "session"): WorkRecord {
  return {
    version: 1,
    type: "request",
    workId: WORK,
    sessionId,
    requestId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

/** A ledger-driver child holding the writer lock: resolves once the IMMEDIATE transaction is
 * open; `done` settles when the holder exits and releases the lock. */
async function holdWriter(dir: string, ms: number): Promise<{ done: Promise<number | null> }> {
  const child = spawn("bun", [DRIVER, "hold-writer", dir, String(ms)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || (JSON.parse(first.value) as { held?: boolean }).held !== true)
    throw new Error("holder did not report a held writer");
  return { done: new Promise<number | null>((resolve) => child.once("exit", resolve)) };
}

it("capture under a 6 s writer in another process returns within 260 ms and spools the exact line", async () => {
  const dir = agentDir();
  const rec = record("req-1");
  // Open the backend before contention, as the session process long since did.
  expect(readRecords(dir)).toHaveLength(0);
  const holder = await holdWriter(dir, 6000);
  try {
    const start = Date.now();
    capture(dir, rec, "summary-native");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(260);
    // The exact record line is fsynced in the session's spool, and nothing reached the ledger.
    const spool = spoolFilePath(dir, "session");
    expect(existsSync(spool)).toBe(true);
    expect(readFileSync(spool, "utf8")).toBe(`${JSON.stringify(rec)}\n`);
    expect(readRecords(dir)).toHaveLength(0);
  } finally {
    await holder.done;
  }

  // The next pass imports it exactly once; a second import and a re-capture of the same line
  // change nothing.
  expect(importSpool(dir).imported).toBe(1);
  expect(importSpool(dir).imported).toBe(0);
  expect(readRecords(dir)).toHaveLength(1);
  capture(dir, rec, "summary-native");
  expect(readRecords(dir)).toHaveLength(1);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
  // The spool file is gone: its cursor reached EOF after the rows committed.
  expect(existsSync(spoolFilePath(dir, "session"))).toBe(false);
}, 20_000);

it("a spool that cannot be written falls back to the blocking wait and still lands the record", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  // The spool path is unusable (a directory where the file would go), so the spool write fails.
  const spool = spoolFilePath(dir, "session");
  mkdirSync(spool, { recursive: true });
  const holder = await holdWriter(dir, 1200);
  try {
    const start = Date.now();
    capture(dir, record("req-2"), "summary-native");
    const elapsed = Date.now() - start;
    // Blocked as today — past the holder's remaining window, inside the original busy timeout.
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(5000);
  } finally {
    await holder.done;
  }
  expect(readRecords(dir)).toHaveLength(1);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
}, 20_000);

/** A child that keeps the writer busy with short transactions and WAL checkpoints, the load the
 * plan's risk section calls out: checkpoints in the worker must not stall or drop capture. */
async function checkpointLoad(dir: string, ms: number): Promise<{ done: Promise<number | null> }> {
  const child = spawn(
    "bun",
    [
      "-e",
      `const { openStore } = await import(${JSON.stringify(`${ROOT}src/ledger/store.js`)});
const store = openStore(${JSON.stringify(dir)});
const deadline = Date.now() + ${ms};
let n = 0;
while (Date.now() < deadline) {
  store.tx(() => store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('load', ?)", [String(++n)]));
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
store.close();
console.log(JSON.stringify({ rounds: n }));`,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || !(JSON.parse(first.value) as { rounds?: number }).rounds)
    throw new Error("checkpoint load child did not report");
  return { done: new Promise<number | null>((resolve) => child.once("exit", resolve)) };
}

it("capture stays quick and lossless under WAL checkpoint load from another process", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  const holder = await checkpointLoad(dir, 2000);
  const total = 20;
  try {
    for (let index = 0; index < total; index++) {
      const start = Date.now();
      capture(dir, record(`req-load-${index}`), "summary-native");
      expect(Date.now() - start).toBeLessThan(260);
    }
  } finally {
    await holder.done;
  }
  // Every record is either committed or spooled; none is dropped.
  const direct = readRecords(dir).length;
  const spooled = existsSync(spoolFilePath(dir, "session"))
    ? readFileSync(spoolFilePath(dir, "session"), "utf8")
        .split("\n")
        .filter((line) => line.trim()).length
    : 0;
  expect(direct + spooled).toBe(total);
  importSpool(dir);
  expect(readRecords(dir)).toHaveLength(total);
  expect(existsSync(spoolFilePath(dir, "session"))).toBe(false);
}, 20_000);
