import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import { importJournalSlice } from "../../src/ledger/import.js";
import {
  acknowledgeBatch,
  observeEvents,
  pendingBatch,
  type Fact,
} from "../../src/ledger/outbox.js";
import {
  backendFor,
  closeBackends,
  ledgerTxDurations,
  readRecords,
  readWorkSummary,
  recoverDirty,
  resetLedgerTxDurations,
  rebuildWork,
} from "../../src/ledger/records.js";
import {
  openStore,
  resetTxDurations,
  TX_DURATION_EDGES,
  txDurations,
  useTxClock,
} from "../../src/ledger/store.js";
import { createTxChunkSizer } from "../../src/ledger/tx-budget.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * Bounded transactions against the real SQLite backend: the store measures every write
 * transaction into a histogram, and the import batches, rebuild slices and ACK batches size
 * themselves from those measurements (AIMD). The proofs here: sizes shrink under slow
 * transactions and grow back; atomic units (a cursor with its rows, an acknowledgement with its
 * receipt state) are never split; and the adaptive run's end state is identical to the
 * fixed-size run — same records, hashes, bodies and projections.
 */

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-budget-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  useTxClock(null);
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const WORK = "00000000-0000-4000-8000-000000000001";

function record(requestId: string): WorkRecord {
  return {
    version: 1,
    type: "request",
    workId: WORK,
    sessionId: "session",
    requestId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

/** A controllable transaction clock: each start/end pair measures `step` milliseconds. */
function slowClock(step: number): void {
  let now = 0;
  useTxClock(() => (now += step));
}

it("the AIMD sizer halves above the ceiling, steps down above the target, and grows back", () => {
  const sizer = createTxChunkSizer(100);
  expect(sizer.size()).toBe(100);
  sizer.observe(300);
  expect(sizer.size()).toBe(50);
  sizer.observe(300);
  expect(sizer.size()).toBe(25);
  sizer.observe(60);
  expect(sizer.size()).toBe(24);
  // A run of good transactions grows the size back, proportionally.
  for (let good = 0; sizer.size() < 100 && good < 5_000; good++) sizer.observe(10);
  expect(sizer.size()).toBe(100);
  // Unmeasurable observations change nothing.
  sizer.observe(Number.NaN);
  expect(sizer.size()).toBe(100);
});

it("the sizer clamps at its hard min and max", () => {
  const sizer = createTxChunkSizer(100, 4, 100);
  for (let round = 0; round < 12; round++) sizer.observe(1000);
  expect(sizer.size()).toBe(4);
  for (let round = 0; round < 400; round++) sizer.observe(1);
  expect(sizer.size()).toBe(100);
});

it("the store histogram counts, buckets and resets", () => {
  const dir = agentDir();
  const store = openStore(dir);
  try {
    slowClock(30);
    store.tx(() => store.db.run("INSERT INTO meta (key, value) VALUES ('histogram-a', '1')"));
    const one = txDurations(store);
    expect(one.count).toBe(1);
    expect(one.lastMs).toBe(30);
    expect(one.maxMs).toBe(30);
    expect(one.totalMs).toBe(30);
    const bucket = TX_DURATION_EDGES.findIndex((edge) => 30 <= edge);
    expect(one.buckets[bucket]).toBe(1);
    expect(one.buckets.reduce((sum, count) => sum + count, 0)).toBe(1);
    store.tx(() => store.db.run("INSERT INTO meta (key, value) VALUES ('histogram-b', '1')"));
    const two = txDurations(store);
    expect(two.count).toBe(2);
    expect(two.buckets[bucket]).toBe(2);
    resetTxDurations(store);
    expect(txDurations(store).count).toBe(0);
    expect(txDurations(store).buckets.every((count) => count === 0)).toBe(true);
  } finally {
    store.close();
  }
});

/** Appends `count` request records to the agent directory's one legacy journal. */
function appendJournal(dir: string, first: number, count: number): void {
  mkdirSync(join(dir, "work-attribution"), { recursive: true });
  const path = join(dir, "work-attribution", "legacy.jsonl");
  const chunk = Array.from({ length: count }, (_, index) =>
    JSON.stringify(record(`req-${first + index}`)),
  ).join("\n");
  writeFileSync(path, `${chunk}\n`, { flag: "a" });
}

const LEGACY = "legacy.jsonl";

/** One import slice with its transaction count and the committed cursor offset. */
function importSlice(dir: string): { txs: number; offset: number } {
  resetLedgerTxDurations(dir);
  importJournalSlice(dir);
  const cursor = backendFor(dir).getJournalCursor(join(dir, "work-attribution", LEGACY));
  return { txs: ledgerTxDurations(dir)?.count ?? 0, offset: cursor ? cursor.offset : -1 };
}

it("import batches shrink under slow transactions, grow back, and reach the identical end state", () => {
  const fixed = agentDir();
  const adaptive = agentDir();
  const lines = 200;
  const appendBoth = (first: number) => {
    appendJournal(fixed, first, lines);
    appendJournal(adaptive, first, lines);
  };

  // The slow phase: the same appends go to both directories; the fixed one commits every window
  // whole under the real clock (today's behavior), the adaptive one under a slow clock. Slow
  // windows halve the batch size, so later windows commit in several transactions each — every
  // one ending on a line boundary (a cursor never covers half a row).
  slowClock(300);
  let sliced = 0;
  for (let pass = 0; pass < 20; pass++) {
    appendBoth(pass * lines);
    importSlice(fixed);
    const slice = importSlice(adaptive);
    const journal = readFileSync(join(adaptive, "work-attribution", LEGACY));
    if (slice.offset > 0) expect(journal[slice.offset - 1]).toBe(0x0a);
    if (slice.txs > 1) sliced++;
  }
  expect(sliced).toBeGreaterThan(0);
  expect(readRecords(fixed)).toHaveLength(20 * lines);
  expect(readRecords(adaptive)).toHaveLength(20 * lines);

  // Grow back: with a fast clock, later windows again commit in one transaction.
  useTxClock(null);
  let single = 0;
  let pass = 20;
  for (; pass < 140 && single < 2; pass++) {
    appendBoth(pass * lines);
    importSlice(fixed);
    single = importSlice(adaptive).txs === 1 ? single + 1 : 0;
  }
  expect(single).toBeGreaterThanOrEqual(2);

  // End state identical: same records, hashes, bodies, cursor and projection as the fixed run.
  expect(readRecords(adaptive)).toHaveLength(pass * lines);
  expect(readRecords(fixed)).toHaveLength(pass * lines);
  const storedOf = (dir: string) =>
    backendFor(dir)
      .readRecords({})
      .map((row) => [row.recordHash, row.body]);
  expect(storedOf(adaptive)).toEqual(storedOf(fixed));
  const cursorOf = (dir: string) =>
    backendFor(dir).getJournalCursor(join(dir, "work-attribution", LEGACY));
  expect(cursorOf(adaptive)?.offset).toBe(cursorOf(fixed)?.offset);
  expect(cursorOf(adaptive)?.boundaryHash).toBe(cursorOf(fixed)?.boundaryHash);
  expect(readWorkSummary(adaptive, WORK)).toEqual(readWorkSummary(fixed, WORK));
});

it("rebuild slices stay budgeted and produce the identical projection", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  for (let index = 0; index < 60; index++)
    backend.tx(() => {
      backend.insertRecord({
        recordHash: `rebuild-${index}`,
        type: "request",
        workId: WORK,
        sessionId: "session",
        body: JSON.stringify(record(`req-${index}`)),
        sourcePath: "/journal",
        sourceGeneration: 0,
        sourceOffset: index,
        importedAt: index,
      });
      backend.upsertMarker(`rebuild-${index}`, WORK, "request");
    });

  // The reference projection: a single-slice rebuild (today's whole-work transaction).
  rebuildWork(dir, WORK);
  const reference = readWorkSummary(dir, WORK);

  // Slow transactions shrink the rebuild slice size across rebuilds; a sliced rebuild then
  // commits in several transactions and still publishes the identical projection.
  slowClock(300);
  for (let round = 0; round < 16; round++) rebuildWork(dir, WORK);
  resetLedgerTxDurations(dir);
  rebuildWork(dir, WORK);
  expect(ledgerTxDurations(dir)?.count ?? 0).toBeGreaterThan(3);
  expect(readWorkSummary(dir, WORK)).toEqual(reference);

  // recoverDirty drives the same sliced rebuild path.
  backend.markDirty(WORK);
  useTxClock(null);
  recoverDirty(dir);
  expect(readWorkSummary(dir, WORK)).toEqual(reference);
});

/** Distinct-entity claim facts, the shape the translation path observes. */
function facts(count: number, first: number): Fact[] {
  return Array.from({ length: count }, (_, index) => ({
    entityId: `10000000-0000-4000-8000-${String(first + index).padStart(12, "0")}`,
    source: "kimchi",
    sourceVersion: "1",
    deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    observeTime: "2026-10-24T07:59:00Z",
    workId: WORK,
    sessionId: "session",
    usage: {
      channel: "native",
      requestId: `entity-${first + index}`,
      schema: "v1",
      counterScope: "request",
      observedRoute: "unknown",
      billingBasis: "unknown",
      correlation: "request-id",
      provider: "openai",
      reportedModel: "m",
      actualModel: "m",
      serviceTier: "default",
      region: "us",
      attemptsComplete: false,
      raw: {},
    },
  }));
}

/** Delivers and acknowledges every pending event, recording each frozen batch's size. */
function drain(dir: string): number[] {
  const backend = backendFor(dir);
  const sizes: number[] = [];
  for (;;) {
    const batch = pendingBatch(dir, "account", () => {});
    if (!batch) break;
    sizes.push(batch.eventIds.length);
    const receipts = batch.eventIds.map((id) => {
      const stored = backend.getOutboxEvent("account", id);
      const event = JSON.parse(Buffer.from(stored ? stored.body : "{}").toString()) as {
        id: string;
        revision: string;
      };
      return { id: event.id, revision: event.revision, status: "accepted" as const };
    });
    resetLedgerTxDurations(dir);
    expect(acknowledgeBatch(dir, "account", batch, { batchId: batch.id, receipts }, () => {})).toBe(
      true,
    );
    // The atomic unit is unsplit: one acknowledgement with its receipt state is one transaction...
    expect(ledgerTxDurations(dir)?.count ?? 0).toBe(1);
    // ...and it settled the whole batch at once, never part of it.
    for (const id of batch.eventIds)
      expect(backend.getOutboxEvent("account", id)?.ackedAt).not.toBeNull();
  }
  return sizes;
}

it("ack batches shrink under slow transactions and every event is acknowledged identically", () => {
  const fixed = agentDir();
  const adaptive = agentDir();
  const count = 300;
  observeEvents(fixed, "account", facts(count, 0), [], () => {});
  observeEvents(adaptive, "account", facts(count, 0), [], () => {});

  const fixedSizes = drain(fixed);
  slowClock(300);
  const adaptiveSizes = drain(adaptive);
  expect(fixedSizes).toEqual([100, 100, 100]);
  // The slow run's batches shrank below the fixed size.
  expect(adaptiveSizes.length).toBeGreaterThan(fixedSizes.length);
  expect(Math.min(...adaptiveSizes)).toBeLessThan(100);

  // End state identical: every event acknowledged once, with its stored body and hash intact.
  const stored = (dir: string) =>
    backendFor(dir)
      .outboxStatus()
      .map((status) => ({
        accountKey: status.accountKey,
        pending: status.pending,
        sendable: status.sendable,
        acknowledged: status.acknowledged,
      }));
  expect(stored(adaptive)).toEqual(stored(fixed));
  expect(stored(fixed)).toEqual([
    { accountKey: "account", pending: 0, sendable: 0, acknowledged: count },
  ]);
});
