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
  capture,
  closeBackends,
  ledgerTxDurations,
  readRecords,
  readWorkHead,
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
import {
  createTxChunkSizer,
  MAX_SIZER_KEYS,
  rememberSizer,
  type TxChunkSizer,
} from "../../src/ledger/tx-budget.js";
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

it("the per-agent sizer registry is bounded and refreshes recency", () => {
  const map = new Map<string, TxChunkSizer>();
  const sizer = rememberSizer(map, "first", () => createTxChunkSizer(10));
  expect(sizer.size()).toBe(10);
  for (let index = 0; index < MAX_SIZER_KEYS + 50; index++)
    rememberSizer(map, `other-${index}`, () => createTxChunkSizer(10));
  expect(map.size).toBe(MAX_SIZER_KEYS);
  expect(map.has("first")).toBe(false);
  // A recently used key survives later inserts past the bound.
  const kept = rememberSizer(map, map.keys().next().value as string, () => createTxChunkSizer(10));
  for (let index = 0; index < 20; index++)
    rememberSizer(map, `fresh-${index}`, () => createTxChunkSizer(10));
  expect([...map.values()]).toContain(kept);
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

  // The slow phase: the same appends go to both directories; the fixed control runs under the
  // real clock and commits every window whole (today's behavior, one transaction per window),
  // while the adaptive one runs under a slow clock. Slow windows halve the batch size, so later
  // windows commit in several transactions each — every one ending on a line boundary (a cursor
  // never covers half a row).
  // Both backends open before any measurement, so the counted windows hold only import work.
  expect(readRecords(fixed)).toHaveLength(0);
  expect(readRecords(adaptive)).toHaveLength(0);
  let sliced = 0;
  for (let pass = 0; pass < 20; pass++) {
    appendBoth(pass * lines);
    useTxClock(null);
    expect(importSlice(fixed).txs).toBe(1);
    slowClock(300);
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

/** A request response record for the same request as `record()`, so a later one supersedes it. */
function response(requestId: string, responseId: string): WorkRecord {
  return {
    version: 1,
    type: "request_response",
    workId: WORK,
    sessionId: "session",
    requestId,
    responseId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

it("a capture landing mid-rebuild cannot be erased from the projection", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  // Shrink the rebuild slices first, exactly as measured slow transactions would.
  slowClock(300);
  for (let round = 0; round < 16; round++) rebuildWork(dir, WORK);
  useTxClock(null);
  // A work with a superseded response and enough filler to span several slices.
  capture(dir, record("req-keep"), "summary-native");
  capture(dir, response("req-keep", "old"), "summary-native");
  for (let index = 0; index < 60; index++)
    capture(dir, record(`req-filler-${index}`), "summary-native");
  rebuildWork(dir, WORK);
  const requestOf = (view: ReturnType<typeof readWorkSummary>) =>
    view?.requests.find((row) => row.requestId === "req-keep");
  expect(requestOf(readWorkSummary(dir, WORK))).toEqual(
    expect.objectContaining({ requestId: "req-keep", responseId: "old" }),
  );
  // The interleaving: while the rebuild pages its slices, another writer (a session capturing in
  // another process) commits a newer response for the same request.
  const page = backend.readWorkRecordPage;
  let reads = 0;
  backend.readWorkRecordPage = (...args: Parameters<typeof page>) => {
    if (++reads === 2) capture(dir, response("req-keep", "new"), "summary-native");
    return page(...args);
  };
  try {
    rebuildWork(dir, WORK);
  } finally {
    backend.readWorkRecordPage = page;
  }
  // The projection keeps the newer response, exactly as a whole-authority rebuild would.
  expect(requestOf(readWorkSummary(dir, WORK))).toEqual(
    expect.objectContaining({ requestId: "req-keep", responseId: "new" }),
  );
  expect(backend.dirtyWorks()).toEqual([]);
});

it("a cold-start import splits its first slow window without prior observations", () => {
  const dir = agentDir();
  appendJournal(dir, 0, 2500);
  // Open the backend first, so the measured window below counts only the import's batches.
  expect(readRecords(dir)).toHaveLength(0);
  slowClock(300);
  resetLedgerTxDurations(dir);
  importJournalSlice(dir);
  // The very first window commits in several bounded batches, not one legacy-sized transaction.
  expect(ledgerTxDurations(dir)?.count ?? 0).toBeGreaterThan(1);
  expect(readRecords(dir)).toHaveLength(2500);
});

it("a cold-start rebuild splits its first slow pass without prior observations", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  for (let index = 0; index < 2500; index++)
    backend.tx(() => {
      backend.insertRecord({
        recordHash: `cold-${index}`,
        type: "request",
        workId: WORK,
        sessionId: "session",
        body: JSON.stringify(record(`req-${index}`)),
        sourcePath: "/journal",
        sourceGeneration: 0,
        sourceOffset: index,
        importedAt: index,
      });
    });
  slowClock(300);
  resetLedgerTxDurations(dir);
  rebuildWork(dir, WORK);
  expect(ledgerTxDurations(dir)?.count ?? 0).toBeGreaterThan(1);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
});

it("capture, lazy head reads and import rebuild a missing projection in bounded slices", () => {
  const seed = (dir: string, count: number) => {
    const backend = backendFor(dir);
    for (let index = 0; index < count; index++)
      backend.tx(() => {
        backend.insertRecord({
          recordHash: `route-${index}`,
          type: "request",
          workId: WORK,
          sessionId: "session",
          body: JSON.stringify(record(`req-${index}`)),
          sourcePath: "/journal",
          sourceGeneration: 0,
          sourceOffset: index,
          importedAt: index,
        });
      });
  };

  // Capture on a work with records but no head.
  const captured = agentDir();
  seed(captured, 2500);
  slowClock(300);
  resetLedgerTxDurations(captured);
  capture(captured, record("req-new"), "summary-native");
  expect(ledgerTxDurations(captured)?.count ?? 0).toBeGreaterThan(1);
  expect(readRecords(captured)).toHaveLength(2501);
  expect(readWorkSummary(captured, WORK)?.sessions).toEqual(["session"]);

  // A lazy head read on the same shape.
  const lazy = agentDir();
  seed(lazy, 2500);
  resetLedgerTxDurations(lazy);
  expect(readWorkHead(lazy, WORK)).toBeDefined();
  expect(ledgerTxDurations(lazy)?.count ?? 0).toBeGreaterThan(1);

  // Import whose batch work has no head.
  const imported = agentDir();
  seed(imported, 2500);
  appendJournal(imported, 0, 50);
  resetLedgerTxDurations(imported);
  importJournalSlice(imported);
  expect(ledgerTxDurations(imported)?.count ?? 0).toBeGreaterThan(1);
  expect(readRecords(imported)).toHaveLength(2550);
  expect(readWorkSummary(imported, WORK)?.sessions).toEqual(["session"]);
  useTxClock(null);
});

it("a fast-path rebuild reads the authority once, not twice", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  for (let index = 0; index < 60; index++)
    backend.tx(() => {
      backend.insertRecord({
        recordHash: `dup-${index}`,
        type: "request",
        workId: WORK,
        sessionId: "session",
        body: JSON.stringify(record(`req-${index}`)),
        sourcePath: "/journal",
        sourceGeneration: 0,
        sourceOffset: index,
        importedAt: index,
      });
    });
  let pages = 0;
  const page = backend.readWorkRecordPage;
  backend.readWorkRecordPage = (...args: Parameters<typeof page>) => {
    pages++;
    return page(...args);
  };
  try {
    rebuildWork(dir, WORK);
  } finally {
    backend.readWorkRecordPage = page;
  }
  // A work that fits one slice rebuilds in the single transaction without paging the authority.
  expect(pages).toBe(0);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
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

/** Delivers and acknowledges every pending event, recording each frozen batch's size. The
 * optional aroundAck hook wraps each acknowledgement (the slow-ack regression toggles the clock
 * only inside it). */
function drain(
  dir: string,
  aroundAck: (acknowledge: () => void) => void = (acknowledge) => acknowledge(),
): number[] {
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
    let acknowledged = false;
    aroundAck(() => {
      expect(
        acknowledgeBatch(dir, "account", batch, { batchId: batch.id, receipts }, () => {}),
      ).toBe(true);
      acknowledged = true;
    });
    expect(acknowledged).toBe(true);
    // The atomic unit is unsplit: one acknowledgement with its receipt state is one transaction...
    expect(ledgerTxDurations(dir)?.count ?? 0).toBe(1);
    // ...and it settled the whole batch at once, never part of it.
    for (const id of batch.eventIds)
      expect(backend.getOutboxEvent("account", id)?.ackedAt).not.toBeNull();
  }
  return sizes;
}

it("ack batches shrink under slow acknowledgements and every event is acknowledged identically", () => {
  const fixed = agentDir();
  const adaptive = agentDir();
  const count = 300;
  const allFacts = facts(count, 0);
  observeEvents(fixed, "account", allFacts, [], () => {});
  observeEvents(adaptive, "account", allFacts, [], () => {});

  // The fixed control drains under the real clock: batches stay at the fixed size of 100.
  useTxClock(null);
  const fixedSizes = drain(fixed);
  expect(fixedSizes).toEqual([100, 100, 100]);

  // Only the acknowledgement transaction is slow here: freezing stays fast, so a shrinking
  // batch size can only come from the ACK's own measured duration feeding the sizer.
  let acknowledgeSlowly = false;
  let now = 0;
  useTxClock(() => (now += acknowledgeSlowly ? 300 : 1));
  const adaptiveSizes = drain(adaptive, (acknowledge) => {
    acknowledgeSlowly = true;
    try {
      acknowledge();
    } finally {
      acknowledgeSlowly = false;
    }
  });
  expect(adaptiveSizes.length).toBeGreaterThan(fixedSizes.length);
  expect(Math.min(...adaptiveSizes)).toBeLessThan(100);

  // End state identical: every event acknowledged once, with its immutable id, hash and body
  // verbatim — only the batch boundaries differed.
  const eventsOf = (dir: string) =>
    backendFor(dir)
      .outboxClaims(
        "account",
        allFacts.map((fact) => fact.entityId),
      )
      .map((event) => ({
        id: event.id,
        hash: event.hash,
        body: Buffer.from(event.body).toString("hex"),
        acked: event.ackedAt !== null,
        blocked: event.blocked,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  expect(eventsOf(adaptive)).toEqual(eventsOf(fixed));
  expect(eventsOf(fixed).length).toBe(count);
  expect(eventsOf(fixed).every((event) => event.acked && !event.blocked)).toBe(true);
  useTxClock(null);
});
