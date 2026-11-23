/**
 * Bun-spawned driver for PR-cost ledger real-DB assertions. Node/vitest cannot
 * load bun:sqlite, so each command runs one scenario inside a Bun subprocess and
 * prints JSON result lines to stdout, exactly like memory-seed.ts.
 *
 *   bun tests/e2e/tui/support/ledger-driver.ts <command> <agentDir> [arg]
 *
 * Commands:
 *   probe          open the store; report user_version, tables, dir/file modes
 *   foreign-check  plant a foreign user_version, then prove openStore refuses it
 *   hold-writer    BEGIN IMMEDIATE, print {"held":true}, sleep <arg>ms, COMMIT
 *   read-only      open the store in a second process; count meta rows
 *   schema-check   open, drop the additive indexes, reopen; print the additive apply's effect
 *   write-probe    try BEGIN IMMEDIATE; report acquisition or lock error + elapsed
 *   self-heal      hold the writer lock while a store and the cached backend open; prove the
 *                  deferred additive apply heals on the live connection after release
 *   capture        capture one record JSON (<arg>) via the v2 records seam
 *   head           print the saved projection head for work <arg>
 *   rows           print the saved projection view for work <arg>
 *   listfiles      print every file path under <agentDir> (zero-write evidence)
 *
 * Kimchi-only commands (native-usage*, producer, legacy-freeze, read-work-records,
 * read-history*, pr-checks, note, remove-note) stay in Kimchi's
 * tests/e2e/tui/support/ledger-driver.ts: they exercise code that has not moved to the
 * bridge (pull-request-status, queue.js, worker.js, work-attribution hydration such as
 * readWorkRecordsAsync and flushWorkSummaries). The removed scenarios whose core operations
 * are moved ledger code run in the bridge's own suites instead: the capture-stage rollback
 * (capture-atomic.test.ts), the async stored reader (stored-read-regressions.test.ts), and the
 * gated competing writer below (summary-writer.test.ts). summary-writer keeps the gated
 * putHead dance but drops the flushWorkSummaries tail, which is Kimchi-only hydration.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { importJournals } from "../../src/ledger/import.js";
import {
  backendFor,
  capture,
  closeBackends,
  fingerprint,
  OUTBOX_DELIVERY_STATUS_SQL,
  outboxClaimsSql,
  readRecords,
  readRecordsSinceSql,
  readTransitionRepositories,
  readWorkHead,
  readWorkSummary,
  workRecordsImportedPresent,
} from "../../src/ledger/records.js";
import { ledgerDbPath, openStore } from "../../src/ledger/store.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

const [, , command, agentDir, arg] = process.argv;

function out(value: unknown): void {
  console.log(JSON.stringify(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(agent: string): Promise<void> {
  const store = openStore(agent);
  const version =
    store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const tables = store.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  const path = ledgerDbPath(agent);
  out({
    version,
    tables,
    dirMode: statSync(dirname(path)).mode & 0o777,
    fileMode: statSync(path).mode & 0o777,
  });
  store.close();
}

async function foreignCheck(agent: string): Promise<void> {
  const path = ledgerDbPath(agent);
  mkdirSync(dirname(path), { recursive: true });
  const plant = new Database(path, { create: true });
  plant.exec("PRAGMA user_version=777");
  plant.close();
  let refused: { opened: boolean; code?: string; name?: string };
  try {
    openStore(agent).close();
    refused = { opened: true };
  } catch (error) {
    const e = error as Error & { code?: string };
    refused = { opened: false, code: e.code, name: e.name };
  }
  const check = new Database(path);
  const version =
    check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const tables = check
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'")
    .get()?.count;
  check.close();
  out({ ...refused, version, tables });
}

async function holdWriter(agent: string, ms: number | "release"): Promise<void> {
  const store = openStore(agent);
  let committed = false;
  try {
    store.db.exec("BEGIN IMMEDIATE");
    store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('hold', '1')");
    out({ held: true });
    if (ms === "release") {
      const input = createInterface({ input: process.stdin });
      let released = false;
      try {
        for await (const line of input) {
          if (line !== "release") continue;
          released = true;
          break;
        }
        if (!released) throw new Error("Holder input closed before release");
      } finally {
        input.close();
      }
    } else await sleep(ms);
    store.db.exec("COMMIT");
    committed = true;
    out({ held: false });
  } finally {
    if (!committed) store.db.exec("ROLLBACK");
    store.close();
  }
}

async function readOnly(agent: string): Promise<void> {
  const store = openStore(agent);
  const count =
    store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM meta").get()?.count ?? -1;
  out({ count });
  store.close();
}

async function planSince(agent: string, seed?: string): Promise<void> {
  const store = openStore(agent);
  // The planner's choice only diverges at scale: without statistics, table sizes past ~20k rows
  // make the unhinted windowed read lose to a full scan; a fresh ledger cannot show it.
  if (seed === "seed") {
    const count =
      store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_records").get()
        ?.count ?? 0;
    if (count < 20_000) {
      const insert = store.db.query(
        "INSERT INTO work_records (record_hash, type, work_id, session_id, body, source_path, source_generation, source_offset, imported_at) VALUES (?, 'request', 'plan-since-seed', 'plan-since', ?, 'seed', 0, NULL, ?)",
      );
      store.tx(() => {
        for (let index = 0; index < 25_000; index++)
          insert.run(`plan-since-${index}`, "{}", 1_700_000_000_000 + index);
      });
    }
  }
  const present = workRecordsImportedPresent(store.db);
  const sql = readRecordsSinceSql(present).replace("?", "1730000000000");
  const plan = store.db
    .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => row.detail);
  store.close();
  out({ plan, hinted: present });
}

async function schemaCheck(agent: string): Promise<void> {
  const listFrom = (db: { query: <T, P>(sql: string) => { all: () => T[] } }): string[] =>
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'outbox_%' OR name = 'work_records_imported')",
      )
      .all()
      .map((row) => row.name)
      .sort();
  // One handle for the drop: opening again would re-apply the additive schema before we could measure it.
  const first = openStore(agent);
  const before = listFrom(first.db);
  first.db.exec(
    "DROP INDEX IF EXISTS outbox_pending_cover; DROP INDEX IF EXISTS outbox_batches_by_account; DROP INDEX IF EXISTS work_records_imported",
  );
  const afterDrop = listFrom(first.db);
  first.close();
  const second = openStore(agent);
  const afterReopen = listFrom(second.db);
  second.close();
  out({ before, afterDrop, afterReopen });
}

async function writeProbe(agent: string): Promise<void> {
  const started = Date.now();
  const store = openStore(agent);
  try {
    store.db.exec("BEGIN IMMEDIATE");
    store.db.exec("COMMIT");
    out({ acquired: true, elapsedMs: Date.now() - started });
  } catch (error) {
    out({
      acquired: false,
      elapsedMs: Date.now() - started,
      message: String((error as Error).message ?? error),
    });
  } finally {
    store.close();
  }
}

async function selfHeal(agent: string): Promise<void> {
  // A busy-deferred additive apply must heal on the live connection, not wait for a reopen. Warm the
  // projection meta first (a first-ever backend construction would write it under the lock), drop the
  // additive indexes, hold the writer lock while a witness store and the cached backend open (both
  // defer), release, then run one windowed read through the cached backend.
  const seed = openStore(agent);
  backendFor(agent);
  closeBackends();
  seed.db.exec(
    "DROP INDEX IF EXISTS outbox_pending_cover; DROP INDEX IF EXISTS outbox_batches_by_account; DROP INDEX IF EXISTS work_records_imported",
  );
  seed.db.exec("BEGIN IMMEDIATE");
  seed.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('hold', '1')");
  const witness = openStore(agent);
  const backend = backendFor(agent);
  const sameBackend = backendFor(agent) === backend;
  const deferredDuringLock = witness.additiveDeferred;
  const presentDuringLock = workRecordsImportedPresent(witness.db);
  seed.db.exec("COMMIT");
  seed.close();
  const rows = readRecords(agent, { modifiedSince: 0 });
  const presentAfterRead = workRecordsImportedPresent(witness.db);
  witness.close();
  closeBackends();
  out({
    deferredDuringLock,
    presentDuringLock,
    sameBackend,
    readRows: rows.length,
    presentAfterRead,
  });
}

async function captureRecord(agent: string, recordJson: string): Promise<void> {
  capture(agent, JSON.parse(recordJson) as WorkRecord, "ledger-driver");
  out({ captured: true, records: fingerprint(agent) });
}

async function printHead(agent: string, workId: string): Promise<void> {
  out(readWorkHead(agent, workId) ?? null);
}

async function printRows(agent: string, workId: string): Promise<void> {
  out(readWorkSummary(agent, workId) ?? null);
}

async function listFiles(agent: string): Promise<void> {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(relative(agent, full));
    }
  };
  try {
    walk(agent);
  } catch {}
  out(found.sort());
}

async function printRecords(agent: string, workId?: string): Promise<void> {
  out(readRecords(agent, workId ? { workId } : {}));
}

async function importJournalsCommand(agent: string): Promise<void> {
  out(await importJournals(agent));
}

async function outboxScenario(agent: string, mode: string): Promise<void> {
  const { observeEvents, pendingBatch, acknowledgeBatch, readOutboxStatus } = await import(
    "../../src/ledger/outbox.js"
  );
  const { backendFor, closeBackends, recordHashOf, useBackendFactory } = await import(
    "../../src/ledger/records.js"
  );
  const { createMemoryRecords } = await import("../../src/ledger/memory-records.js");
  const { encodeBatch } = await import("../../src/ledger/protocol.js");
  const { createHash } = await import("node:crypto");
  if (mode === "memory") useBackendFactory(() => createMemoryRecords());
  const backend = backendFor(agent);
  const required = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error("Missing outbox test row");
    return value;
  };
  const fence = () => {};
  const fact = {
    entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source: "codex",
    sourceVersion: "test",
    deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    observeTime: "2026-10-24T00:00:00.123456789Z",
    coverage: { code: "observed", count: "1" },
  };
  const record: WorkRecord = {
    version: 1,
    type: "request_response",
    workId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    sessionId: "original-session",
    recordedAt: fact.observeTime,
  };
  capture(agent, record, "outbox-test");
  const hash = recordHashOf(record);
  observeEvents(agent, "account-a", [fact], [hash], fence);
  const first = required(backend.latestOutboxEvent("account-a", fact.entityId));
  observeEvents(agent, "account-a", [{ ...fact, observeTime: "2026-10-24T01:00:00Z" }], [], fence);
  const noOp = backend.latestOutboxEvent("account-a", fact.entityId)?.id === first.id;
  observeEvents(
    agent,
    "account-a",
    [{ ...fact, coverage: { code: "observed", count: "2" } }],
    [],
    fence,
  );
  const second = required(backend.latestOutboxEvent("account-a", fact.entityId));
  observeEvents(agent, "account-b", [fact], [], fence);
  const other = required(backend.latestOutboxEvent("account-b", fact.entityId));
  const parse = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString("utf8"));
  const one = parse(first.body);
  const two = parse(second.body);
  const frozen = required(pendingBatch(agent, "account-a", fence));
  const detachedEvent = required(backend.getOutboxEvent("account-a", first.id));
  detachedEvent.body[0] = 0;
  const detachedBatch = required(backend.getOutboxBatch("account-a"));
  detachedBatch.body[0] = 0;
  detachedBatch.eventIds[0] = "changed";
  const byteIsolation =
    sameBytes(required(backend.getOutboxEvent("account-a", first.id)).body, first.body) &&
    sameBytes(required(backend.getOutboxBatch("account-a")).body, frozen.body) &&
    required(backend.getOutboxBatch("account-a")).eventIds[0] === frozen.eventIds[0];
  backend.insertOutboxBatch({ ...frozen, id: "order-a", accountKey: "ordering", orderKey: "a" });
  backend.insertOutboxBatch({ ...frozen, id: "order-Z", accountKey: "ordering", orderKey: "Z" });
  const binaryBatchOrder = backend.getOutboxBatch("ordering")?.id === "order-Z";
  backend.insertOutboxEvent({
    ...other,
    id: "status-blocked",
    accountKey: "status-blocked",
    blocked: "fixture",
  });
  backend.insertOutboxEvent({
    ...other,
    id: "status-acked",
    accountKey: "status-acked",
    ackedAt: 1234,
  });
  const statuses = readOutboxStatus(agent);
  const statusA = statuses.find((status) => status.accountKey === "account-a");
  const statusOnlyBatch = statuses.find((status) => status.accountKey === "ordering");
  const readOnlyStatus =
    statusA?.pending === 2 &&
    statusA.sendable === 2 &&
    statusA.blocked === 0 &&
    statusA.acknowledged === 0 &&
    statusA.lastAcknowledgedAt === null &&
    statusA.batches === 1 &&
    statusA.firstBatchId === frozen.id &&
    statusOnlyBatch?.pending === 0 &&
    statusOnlyBatch.batches === 2 &&
    statusOnlyBatch.firstBatchId === "order-Z" &&
    statuses.find((status) => status.accountKey === "status-blocked")?.blocked === 1 &&
    statuses.find((status) => status.accountKey === "status-acked")?.lastAcknowledgedAt === 1234 &&
    !backend.getOutboxBatch("account-b") &&
    JSON.stringify(readOutboxStatus(agent)) === JSON.stringify(statuses);
  const retryAt = Date.now() + 60_000;
  backend.putNote(
    "pr-cost-delivery",
    "account-a",
    JSON.stringify({ batchId: frozen.id, attempts: 1, retryAt, error: "HTTP 503" }),
  );
  const savedRetry = readOutboxStatus(agent).find(
    (status) => status.accountKey === "account-a",
  )?.retry;
  const retryStatus = savedRetry?.retryAt === retryAt && savedRetry.error === "HTTP 503";
  backend.putNote("agent", "legacy-snapshot-resume", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const resumedStatus = !readOutboxStatus(agent).find((status) => status.accountKey === "account-a")
    ?.retry;
  backend.deleteNote("agent", "legacy-snapshot-resume");
  backend.putNote(
    "pr-cost-delivery",
    "account-a",
    JSON.stringify({ batchId: frozen.id, attempts: -1, retryAt }),
  );
  let invalidRetryRetained = false;
  try {
    readOutboxStatus(agent);
  } catch {
    invalidRetryRetained = backend.getNote("pr-cost-delivery", "account-a") !== undefined;
  }
  backend.deleteNote("pr-cost-delivery", "account-a");
  const ack = (batch: typeof frozen) => ({
    batchId: batch.id,
    receipts: parse(batch.body).batch.events.map((event: { id: string; revision: string }) => ({
      id: event.id,
      revision: event.revision,
      status: "accepted",
    })),
  });
  const same = (left: Uint8Array, right: Uint8Array) =>
    Buffer.from(left).equals(Buffer.from(right));
  const rejects = (operation: () => unknown) => {
    try {
      operation();
      return false;
    } catch {
      return true;
    }
  };
  const corrupted = parse(frozen.body).batch;
  corrupted.events[0].coverage.count = "99";
  const getBatch = backend.getOutboxBatch.bind(backend);
  backend.getOutboxBatch = (account) =>
    account === "account-a"
      ? { ...frozen, body: Buffer.from(`{"batch":${encodeBatch(corrupted)}}`) }
      : getBatch(account);
  const corruptedEventRejected = rejects(() => pendingBatch(agent, "account-a", fence));
  const badBatchIdentity = { ...parse(frozen.body).batch, id: "invalid-batch" };
  backend.getOutboxBatch = (account) =>
    account === "account-a"
      ? {
          ...frozen,
          id: badBatchIdentity.id,
          body: Buffer.from(`{"batch":${encodeBatch(badBatchIdentity)}}`),
        }
      : getBatch(account);
  const corruptionRejected =
    corruptedEventRejected && rejects(() => pendingBatch(agent, "account-a", fence));
  backend.getOutboxBatch = getBatch;
  // A newer build's body carries a field this build does not know; its hash matches the stored bytes.
  const forwardId = "88888888-8888-4888-8888-888888888888";
  const forwardBase = {
    ...parse(second.body),
    id: forwardId,
    revision: "1",
    baseRevision: "0",
    baseEventId: "",
  };
  const forwardBodyText = `${JSON.stringify(forwardBase).slice(0, -1)},"futureField":{"from":"newer-build"}}`;
  const forwardBody = Buffer.from(forwardBodyText);
  backend.insertOutboxEvent({
    id: forwardId,
    accountKey: "account-forward",
    entityId: fact.entityId,
    kind: "coverage",
    body: forwardBody,
    hash: createHash("sha256").update(forwardBody).digest("hex"),
    createdAt: Date.now(),
    ackedAt: null,
    blocked: "",
  });
  const attempt = <T>(operation: () => T): T | undefined => {
    try {
      return operation();
    } catch {
      return undefined;
    }
  };
  const forwardBatch = attempt(() => pendingBatch(agent, "account-forward", fence));
  const forwardCompat =
    forwardBatch !== undefined &&
    attempt(() =>
      acknowledgeBatch(agent, "account-forward", forwardBatch, ack(forwardBatch), fence),
    ) === true;
  const forwardBytesPreserved =
    forwardBatch !== undefined &&
    Buffer.from(forwardBatch.body)
      .toString("utf8")
      .includes('"futureField":{"from":"newer-build"}');
  const tamperedBody = Buffer.from(forwardBodyText);
  tamperedBody[tamperedBody.length >> 1] ^= 1;
  backend.insertOutboxEvent({
    id: "77777777-7777-4777-8777-777777777777",
    accountKey: "account-tampered",
    entityId: fact.entityId,
    kind: "coverage",
    body: tamperedBody,
    hash: createHash("sha256").update(forwardBody).digest("hex"),
    createdAt: Date.now(),
    ackedAt: null,
    blocked: "",
  });
  const hashMismatchRejected = rejects(() => pendingBatch(agent, "account-tampered", fence));
  const usage = {
    channel: "native",
    counterScope: "request",
    observedRoute: "unknown",
    schema: "unknown",
    billingBasis: "unknown",
    correlation: "exact",
    raw: {},
    attemptsComplete: true,
  };
  const badFacts = [
    { ...fact, coverage: { ...fact.coverage, windowStartTime: "0000-01-01T00:00:00Z" } },
    { ...fact, entityId: "not-a-uuid" },
    { ...fact, deviceId: "not-a-uuid" },
    { ...fact, observeTime: "1969-12-31T23:59:59Z" },
    { ...fact, observeTime: new Date(Date.now() + 3_600_000).toISOString() },
    {
      ...fact,
      coverage: undefined,
      usage: { ...usage, iterations: [{ id: "", schema: "unknown", raw: {} }] },
    },
    {
      ...fact,
      coverage: undefined,
      usage: {
        ...usage,
        iterations: [
          { id: "one", schema: "unknown", raw: {} },
          { id: "one", schema: "unknown", raw: {} },
        ],
      },
    },
    { ...fact, coverage: undefined, usage: { ...usage, finalIterationId: "missing" } },
    {
      ...fact,
      coverage: undefined,
      usage: {
        ...usage,
        iterations: [{ id: "one", schema: "unknown", raw: {} }],
        finalIterationId: "missing",
      },
    },
    {
      ...fact,
      coverage: undefined,
      usage: {
        ...usage,
        raw: {
          cacheWrites: [
            { ttlSeconds: 300, tokens: "600000000000" },
            { ttlSeconds: 3600, tokens: "600000000000" },
          ],
        },
      },
    },
    {
      ...fact,
      coverage: undefined,
      usage: {
        ...usage,
        schema: "openai-responses-v1",
        raw: { inputTokens: "10", cacheReadTokens: "10", cacheWriteTokens: "1" },
      },
    },
    {
      ...fact,
      coverage: undefined,
      usage: {
        ...usage,
        iterations: [
          {
            id: "one",
            schema: "openai-chat-completions-v1",
            raw: { inputTokens: "10", cacheReadTokens: "10", cacheWriteTokens: "1" },
          },
        ],
      },
    },
  ];
  const admissionRejected =
    badFacts.every((event) =>
      rejects(() => observeEvents(agent, "admission", [event], [], fence)),
    ) && backend.pendingOutboxEvents("admission", 100).length === 0;
  observeEvents(
    agent,
    "supplemental",
    [
      {
        ...fact,
        coverage: undefined,
        usage: {
          ...usage,
          counterScope: "cumulative",
          iterations: [
            { id: "same", schema: "unknown", raw: {} },
            { id: "same", schema: "unknown", raw: {} },
          ],
        },
      },
    ],
    [],
    fence,
  );
  const cumulativePreserved = backend.pendingOutboxEvents("supplemental", 100).length === 1;
  const claim = {
    ...fact,
    source: "kimchi",
    observeTime: "2026-10-23T10:00:00Z",
    coverage: undefined,
    repository: { provider: "github", host: "github.com", id: "repo-one" },
    usage: { ...usage, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
    allocation: { kind: "unlinked", method: "native" },
  };
  observeEvents(agent, "claims", [claim], [], fence);
  observeEvents(
    agent,
    "claims",
    [
      {
        ...claim,
        observeTime: "2026-10-23T12:00:00Z",
        allocation: undefined,
        usage: { ...claim.usage, actualModel: "first-model" },
      },
    ],
    [],
    fence,
  );
  observeEvents(
    agent,
    "claims",
    [
      {
        ...claim,
        observeTime: "2026-10-23T13:00:00Z",
        allocation: undefined,
        startedAt: "2026-10-23T11:00:00+01:00",
        usage: { ...claim.usage, actualModel: "first-model" },
      },
    ],
    [],
    fence,
  );
  const receipt = {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    revision: 1,
    recordedAt: "2026-10-23T12:00:00Z",
    source: "work-command",
  };
  const allocated = {
    ...claim,
    observeTime: "2026-10-23T14:00:00Z",
    correction: receipt,
    allocation: { kind: "pull-request", pullRequestIds: ["pr-one"], method: "user-correction" },
    claimState: "active",
  };
  observeEvents(agent, "claims", [allocated], [], fence);
  const metadata = {
    ...claim,
    observeTime: "2026-10-23T15:00:00Z",
    allocation: undefined,
    usage: { ...claim.usage, actualModel: "later-model" },
  };
  observeEvents(agent, "claims", [metadata], [], fence);
  observeEvents(
    agent,
    "claims",
    [{ ...metadata, observeTime: "2026-10-23T16:00:00Z", startedAt: claim.observeTime }],
    [],
    fence,
  );
  const afterOmission = required(backend.latestOutboxEvent("claims", claim.entityId));
  const claimInheritance =
    parse(afterOmission.body).startedAt === claim.observeTime &&
    !Object.hasOwn(parse(afterOmission.body), "correction") &&
    !Object.hasOwn(parse(afterOmission.body), "allocation");
  const corrected = {
    ...allocated,
    observeTime: "2026-10-23T17:00:00Z",
    startedAt: claim.observeTime,
    correction: { ...receipt, revision: 2 },
    allocation: { ...allocated.allocation, pullRequestIds: ["pr-two"] },
  };
  observeEvents(agent, "claims", [corrected], [], fence);
  const badClaims = [
    { ...corrected, source: "claude-code" },
    {
      ...corrected,
      usage: { ...corrected.usage, requestId: "11111111-1111-4111-8111-111111111111" },
    },
    { ...corrected, deviceId: "11111111-1111-4111-8111-111111111111" },
    { ...corrected, repository: { ...corrected.repository, id: "other-repo" } },
    { ...corrected, startedAt: "2026-10-23T15:00:00Z" },
    {
      ...corrected,
      allocation: { ...corrected.allocation, pullRequestIds: ["pr-three"] },
      correction: undefined,
    },
    { ...corrected, claimState: "retracted" },
    { ...corrected, correction: receipt },
    { ...corrected, correction: { ...receipt, revision: 3, recordedAt: "2026-10-23T11:59:59Z" } },
    {
      ...corrected,
      correction: { ...receipt, id: "11111111-1111-4111-8111-111111111111", revision: 3 },
    },
    {
      ...corrected,
      correction: {
        ...receipt,
        revision: 3,
        recordedAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    },
  ];
  const claimUpdateRejected = badClaims.every((candidate) =>
    rejects(() => observeEvents(agent, "claims", [candidate], [], fence)),
  );
  const nextReceipt = {
    ...corrected,
    correction: {
      ...receipt,
      id: "11111111-1111-4111-8111-111111111111",
      recordedAt: "2026-10-23T12:00:00.000000001Z",
    },
    repository: { ...claim.repository, name: "renamed" },
  };
  observeEvents(agent, "claims", [nextReceipt], [], fence);
  const correctionProgression =
    parse(required(backend.latestOutboxEvent("claims", claim.entityId)).body).correction.id ===
    nextReceipt.correction.id;
  const target = { provider: "github", host: "github.com", id: "parent-repo", name: "parent/repo" };
  const targetClaim = {
    ...allocated,
    allocation: { ...allocated.allocation, targetRepository: target },
  };
  observeEvents(agent, "target-claims", [targetClaim], [], fence);
  const renamedTarget = {
    ...targetClaim,
    allocation: {
      ...targetClaim.allocation,
      targetRepository: { ...target, name: "renamed/repo" },
    },
  };
  observeEvents(agent, "target-claims", [renamedTarget], [], fence);
  observeEvents(
    agent,
    "target-claims",
    [
      {
        ...renamedTarget,
        allocation: undefined,
        usage: { ...claim.usage, responseId: "target-metadata" },
      },
    ],
    [],
    fence,
  );
  const targetChangeRejected = rejects(() =>
    observeEvents(
      agent,
      "target-claims",
      [
        {
          ...renamedTarget,
          allocation: {
            ...renamedTarget.allocation,
            targetRepository: { ...target, id: "other-parent" },
          },
        },
      ],
      [],
      fence,
    ),
  );
  const targetDefaultRejected = rejects(() =>
    observeEvents(
      agent,
      "target-claims",
      [{ ...renamedTarget, allocation: allocated.allocation }],
      [],
      fence,
    ),
  );
  const newerTarget = {
    ...renamedTarget,
    correction: { ...receipt, revision: 2 },
    allocation: {
      ...renamedTarget.allocation,
      targetRepository: { ...target, id: "other-parent" },
    },
  };
  observeEvents(agent, "target-claims", [newerTarget], [], fence);
  const claimTargetIdentity =
    targetChangeRejected &&
    targetDefaultRejected &&
    parse(required(backend.latestOutboxEvent("target-claims", claim.entityId)).body).allocation
      .targetRepository.id === "other-parent";
  observeEvents(agent, "default-target", [allocated], [], fence);
  observeEvents(
    agent,
    "default-target",
    [
      {
        ...allocated,
        allocation: {
          ...allocated.allocation,
          targetRepository: { ...claim.repository, name: "renamed/fork" },
        },
      },
    ],
    [],
    fence,
  );
  observeEvents(agent, "default-target", [allocated], [], fence);
  observeEvents(agent, "native-claim", [{ ...claim, allocation: undefined }], [], fence);
  const noNativeUpgrade = rejects(() => observeEvents(agent, "native-claim", [claim], [], fence));
  const validAck = ack(frozen);
  const badAcks = [
    { ...validAck, batchId: "other-batch" },
    { ...validAck, receipts: validAck.receipts.slice(1) },
    { ...validAck, receipts: [validAck.receipts[0], validAck.receipts[0]] },
    {
      ...validAck,
      receipts: validAck.receipts.map((receipt: object) => ({ ...receipt, revision: "999" })),
    },
    {
      ...validAck,
      receipts: validAck.receipts.map((receipt: object) => ({ ...receipt, status: "stale" })),
    },
  ];
  const invalidAckRetained =
    badAcks.every((response) =>
      rejects(() => acknowledgeBatch(agent, "account-a", frozen, response, fence)),
    ) &&
    rejects(() => acknowledgeBatch(agent, "account-b", frozen, validAck, fence)) &&
    same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body);
  const changed = { ...record, recordedAt: "2026-10-24T02:00:00Z" };
  capture(agent, changed, "outbox-test");
  const changedHash = recordHashOf(changed);
  const clear = backend.clearTranslation.bind(backend);
  backend.clearTranslation = (id) => {
    clear(id);
    throw new Error("after marker removal");
  };
  const failedObservation = rejects(() =>
    observeEvents(
      agent,
      "account-a",
      [{ ...fact, coverage: { code: "observed", count: "3" } }],
      [changedHash],
      fence,
    ),
  );
  backend.clearTranslation = clear;
  const observationRollback =
    failedObservation &&
    backend.latestOutboxEvent("account-a", fact.entityId)?.id === second.id &&
    backend
      .pendingTranslations(0, backend.recordWatermark(), 100)
      .some((row) => row.recordHash === changedHash);
  observeEvents(
    agent,
    "account-a",
    [{ ...fact, coverage: { code: "observed", count: "3" } }],
    [changedHash],
    fence,
  );
  const third = required(backend.latestOutboxEvent("account-a", fact.entityId));
  const frozenReplay =
    same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body) &&
    parse(frozen.body).batch.events.length === 2;
  const markAck = backend.ackOutboxEvent.bind(backend);
  backend.ackOutboxEvent = (...args) => {
    markAck(...args);
    throw new Error("after event ACK");
  };
  const failedAck = rejects(() => acknowledgeBatch(agent, "account-a", frozen, validAck, fence));
  backend.ackOutboxEvent = markAck;
  const ackRollback =
    failedAck &&
    backend.pendingOutboxEvents("account-a", 100).length === 3 &&
    same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body);
  const paused = () => {
    throw new Error("lease or account changed");
  };
  const leasePause =
    rejects(() => acknowledgeBatch(agent, "account-a", frozen, validAck, paused)) &&
    rejects(() =>
      observeEvents(
        agent,
        "account-a",
        [{ ...fact, coverage: { code: "observed", count: "4" } }],
        [],
        paused,
      ),
    ) &&
    same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body);
  acknowledgeBatch(agent, "account-a", frozen, validAck, fence);
  const insert = backend.insertOutboxBatch.bind(backend);
  backend.insertOutboxBatch = (batch) => {
    insert(batch);
    throw new Error("after batch insert");
  };
  const failedBatch = rejects(() => pendingBatch(agent, "account-a", fence));
  backend.insertOutboxBatch = insert;
  const batchRollback =
    failedBatch &&
    !backend.getOutboxBatch("account-a") &&
    backend.pendingOutboxEvents("account-a", 100).length === 1;
  const next = required(pendingBatch(agent, "account-a", fence));
  const oldAckRetainedNewBatch =
    acknowledgeBatch(agent, "account-a", frozen, validAck, fence) === false &&
    same(required(pendingBatch(agent, "account-a", fence)).body, next.body);
  capture(
    agent,
    { ...record, requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    "outbox-unresolved",
  );
  capture(agent, { ...record, requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "outbox-later");
  const watermark = backend.recordWatermark();
  const page = backend.pendingTranslations(0, watermark, 1);
  const later = page[0] ? backend.pendingTranslations(page[0].position, watermark, 1) : [];
  const markerPaging =
    page.length === 1 &&
    later.length === 1 &&
    page[0].recordHash !== later[0].recordHash &&
    backend.pendingTranslations(0, watermark, 100).length === 2;
  const kindImmutable = rejects(() =>
    observeEvents(
      agent,
      "account-a",
      [{ ...fact, coverage: undefined, work: { reason: "explicit", quality: "confirmed" } }],
      [],
      fence,
    ),
  );
  // A conflict receipt settles its batch but sets the event aside: it is never sent again, and the entity's next
  // revision builds on the last event the server stored.
  observeEvents(agent, "conflicts", [fact], [], fence);
  const storedBatch = required(pendingBatch(agent, "conflicts", fence));
  acknowledgeBatch(agent, "conflicts", storedBatch, ack(storedBatch), fence);
  const kept = required(backend.latestOutboxEvent("conflicts", fact.entityId));
  const refused = { ...fact, coverage: { code: "observed", count: "2" } };
  observeEvents(agent, "conflicts", [refused], [], fence);
  const conflicting = required(pendingBatch(agent, "conflicts", fence));
  const conflictAck = {
    ...ack(conflicting),
    receipts: ack(conflicting).receipts.map((receipt: object) => ({
      ...receipt,
      status: "conflict",
    })),
  };
  const conflictSettled = acknowledgeBatch(agent, "conflicts", conflicting, conflictAck, fence);
  observeEvents(agent, "conflicts", [refused], [], fence);
  const conflictSetAside =
    conflictSettled &&
    !backend.getOutboxBatch("conflicts") &&
    !pendingBatch(agent, "conflicts", fence) &&
    readOutboxStatus(agent).find((status) => status.accountKey === "conflicts")?.blocked === 1;
  observeEvents(
    agent,
    "conflicts",
    [{ ...fact, coverage: { code: "observed", count: "3" } }],
    [],
    fence,
  );
  const rebased = parse(required(pendingBatch(agent, "conflicts", fence)).body).batch.events[0];
  const conflictRebased = rebased.revision === "2" && rebased.baseEventId === kept.id;
  let reopened = false;
  if (mode === "sqlite") {
    closeBackends();
    reopened = same(required(pendingBatch(agent, "account-a", fence)).body, next.body);
  }
  out({
    revisions: [one.revision, two.revision, parse(third.body).revision],
    cas: two.baseRevision === "1" && two.baseEventId === first.id,
    noOp,
    byteIsolation,
    binaryBatchOrder,
    readOnlyStatus,
    retryStatus,
    resumedStatus,
    invalidRetryRetained,
    corruptionRejected,
    forwardCompat,
    forwardBytesPreserved,
    hashMismatchRejected,
    admissionRejected,
    cumulativePreserved,
    markerPaging,
    kindImmutable,
    claimInheritance,
    claimUpdateRejected,
    correctionProgression,
    claimTargetIdentity,
    noNativeUpgrade,
    accountIsolation:
      other.id !== first.id &&
      parse(other.body).revision === "1" &&
      backendFor(agent).pendingOutboxEvents("account-b", 100).length === 1,
    frozenReplay,
    invalidAckRetained,
    observationRollback,
    batchRollback,
    ackRollback,
    leasePause,
    oldAckRetainedNewBatch,
    conflictSetAside,
    conflictRebased,
    acknowledgedHistoryRetained:
      Boolean(backendFor(agent).getOutboxEvent("account-a", first.id)?.ackedAt) &&
      Boolean(backendFor(agent).getOutboxEvent("account-a", second.id)?.ackedAt) &&
      same(required(backendFor(agent).getOutboxEvent("account-a", first.id)).body, first.body) &&
      backendFor(agent).pendingOutboxEvents("account-a", 100).length === 1,
    reopened,
  });
  closeBackends();
}

/** Delivery-status read parity: the optimized read must agree with the full status read's
 * delivery-relevant projection across every account shape (pending, acknowledged, blocked,
 * mixed, batched, batch-only), on first open and after a cold reopen. SQLite mode also
 * asserts the probe queries stay bounded by the covering indexes. */
async function deliveryStatusScenario(agent: string, mode: string): Promise<void> {
  const { outboxDeliveryStatus, readOutboxStatus } = await import("../../src/ledger/outbox.js");
  const { backendFor, closeBackends, useBackendFactory } = await import(
    "../../src/ledger/records.js"
  );
  const { createMemoryRecords } = await import("../../src/ledger/memory-records.js");
  const { createHash } = await import("node:crypto");
  if (mode === "memory") useBackendFactory(() => createMemoryRecords());
  const backend = backendFor(agent);
  const event = (accountKey: string, index: number) => {
    const id = `ev-${accountKey}-${index}`;
    const body = Buffer.from(JSON.stringify({ id, entityId: id }));
    return {
      id,
      accountKey,
      entityId: id,
      kind: "work",
      body,
      hash: createHash("sha256").update(body).digest("hex"),
      createdAt: index,
      ackedAt: null,
      blocked: "",
    };
  };
  const must = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`delivery-status seed: ${what}`);
  };
  backend.tx(() => {
    for (let index = 0; index < 3; index++)
      backend.insertOutboxEvent(event("account-pending", index));
    for (let index = 0; index < 2; index++) {
      const acked = event("account-acked", index);
      backend.insertOutboxEvent(acked);
      must(
        backend.ackOutboxEvent("account-acked", acked.id, acked.hash, index),
        "acknowledge failed",
      );
    }
    for (let index = 0; index < 2; index++) {
      const blocked = event("account-blocked", index);
      backend.insertOutboxEvent(blocked);
      must(
        backend.blockOutboxEvent("account-blocked", blocked.id, blocked.hash, "driver"),
        "block failed",
      );
    }
    for (let index = 0; index < 3; index++) {
      const mixed = event("account-mixed", index);
      backend.insertOutboxEvent(mixed);
      if (index === 0)
        must(backend.ackOutboxEvent("account-mixed", mixed.id, mixed.hash, index), "ack failed");
      if (index === 1)
        must(
          backend.blockOutboxEvent("account-mixed", mixed.id, mixed.hash, "driver"),
          "block failed",
        );
    }
    for (let index = 0; index < 2; index++)
      backend.insertOutboxEvent(event("account-batched", index));
    for (let index = 0; index < 3; index++)
      backend.insertOutboxBatch({
        id: `batch-${index}`,
        accountKey: "account-batched",
        body: Buffer.alloc(0),
        eventIds: [],
        createdAt: index,
        orderKey: "",
      });
    backend.insertOutboxBatch({
      id: "batch-only",
      accountKey: "account-batchonly",
      body: Buffer.alloc(0),
      eventIds: [],
      createdAt: 0,
      orderKey: "",
    });
  });
  const projection = (
    rows: {
      accountKey: string;
      sendable: boolean;
      hasBatch: boolean;
      firstBatchId: string | null;
    }[],
  ) => JSON.stringify([...rows].sort((a, b) => a.accountKey.localeCompare(b.accountKey)));
  const full = readOutboxStatus(agent).map((status) => ({
    accountKey: status.accountKey,
    sendable: status.sendable > 0,
    hasBatch: status.batches > 0,
    firstBatchId: status.firstBatchId,
  }));
  const delivery = outboxDeliveryStatus(agent);
  const same = projection(full) === projection(delivery);
  // A cold reopen is only meaningful where state persists: the memory backend is
  // in-process, so closeBackends() leaves nothing behind to reopen.
  let reopenedSame: boolean | undefined;
  if (mode !== "memory") {
    closeBackends();
    const reopened = outboxDeliveryStatus(agent);
    reopenedSame = projection(reopened) === projection(delivery);
  }
  let plans: { sendable: string[]; firstBatch: string[] } | undefined;
  if (mode !== "memory") {
    const db = new Database(ledgerDbPath(agent), { readonly: true });
    const explain = (sql: string) =>
      db
        .prepare<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => String(row.detail));
    plans = {
      sendable: explain(
        "SELECT 1 FROM outbox_events WHERE account_key = 'account-pending' AND acked_at IS NULL AND blocked = '' LIMIT 1",
      ),
      firstBatch: explain(
        "SELECT id FROM outbox_batches WHERE account_key = 'account-batched' ORDER BY order_key, created_at, rowid LIMIT 1",
      ),
    };
    db.close();
  }
  out({ same, reopenedSame, accounts: delivery.length, delivery, plans });
  if (!same) throw new Error("delivery status disagrees with the full status projection");
  if (reopenedSame === false) throw new Error("delivery status changed across a cold reopen");
}

async function outboxTransport(agent: string): Promise<void> {
  const { observeEvents, pendingBatch, acknowledgeBatch } = await import(
    "../../src/ledger/outbox.js"
  );
  const { closeBackends } = await import("../../src/ledger/records.js");
  const current = () => {};
  const coverage = {
    entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source: "codex",
    sourceVersion: "test",
    deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    observeTime: "2026-10-24T01:00:00.123456789+01:00",
    startedAt: "2026-10-24T00:59:00+01:00",
    correction: {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      revision: 1,
      recordedAt: "2026-10-24T00:30:00+01:00",
      source: "work-command",
    },
    coverage: {
      code: "transport_time",
      count: "1",
      windowStartTime: "2026-10-24T00:00:00.000000001+01:00",
      windowEndTime: "2026-10-24T00:30:00.000000002+01:00",
    },
  };
  const pullRequest = {
    ...coverage,
    entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    startedAt: undefined,
    correction: undefined,
    coverage: undefined,
    repository: { provider: "github", host: "github.com", id: "repo" },
    pullRequest: {
      id: "pr",
      number: 1,
      uri: "https://github.com/example/repo/pull/1",
      state: "merged",
      createTime: "2026-10-23T09:00:00.123456789+01:00",
      closeTime: "2026-10-24T00:30:00+01:00",
      mergeTime: "2026-10-24T00:31:00+01:00",
    },
  };
  observeEvents(agent, "transport", [coverage, pullRequest], [], current);
  const first = pendingBatch(agent, "transport", current);
  if (!first) throw new Error("Missing first transport batch");
  const firstBody = JSON.parse(Buffer.from(first.body).toString("utf8"));
  acknowledgeBatch(
    agent,
    "transport",
    first,
    {
      batchId: first.id,
      receipts: firstBody.batch.events.map((event: { id: string; revision: string }) => ({
        id: event.id,
        revision: event.revision,
        status: "accepted",
      })),
    },
    current,
  );
  observeEvents(
    agent,
    "transport",
    [
      {
        ...coverage,
        observeTime: "2026-10-24T02:00:01.123456789+02:00",
        coverage: { ...coverage.coverage, count: "2" },
      },
    ],
    [],
    current,
  );
  const second = pendingBatch(agent, "transport", current);
  if (!second) throw new Error("Missing second transport batch");
  out({
    first: firstBody,
    second: JSON.parse(Buffer.from(second.body).toString("utf8")),
  });
  closeBackends();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function summaryState(agent: string, workId: string): void {
  const store = openStore(agent);
  try {
    out({
      authority: store.db
        .query("SELECT * FROM work_records WHERE work_id = ? ORDER BY rowid")
        .all(workId),
      markers: store.db
        .query("SELECT * FROM pending_translation WHERE work_id = ? ORDER BY record_hash")
        .all(workId),
      head:
        store.db
          .query<{ body: string }, [string]>(
            "SELECT body FROM work_projection_head WHERE work_id = ?",
          )
          .get(workId)?.body ?? null,
      rows: store.db
        .query("SELECT * FROM work_projection_rows WHERE work_id = ? ORDER BY log, pos")
        .all(workId),
    });
  } finally {
    store.close();
  }
}

/** A synchronous pipe gate holds a real transaction after its head write, never across await.
 * Writing 'r' cancels the writer after its head publish (the capture rolls back); 'c' lets it
 * commit. The rolled-back writer stays alive across a competing writer's commit, then closes. */
async function summaryWriter(agent: string, json: string): Promise<void> {
  const { backendFor, closeBackends } = await import("../../src/ledger/records.js");
  const { record } = JSON.parse(json) as { record: WorkRecord };
  const backend = backendFor(agent);
  const publish = backend.putHead;
  const cancelled = new Error("writer ownership cancelled before commit");
  const gate = () => {
    const byte = Buffer.alloc(1);
    if (readSync(0, byte, 0, 1, null) !== 1) throw new Error("Missing writer release");
    return byte[0] === 99;
  };
  const signal = (phase: string) => writeSync(1, `${JSON.stringify({ phase })}\n`);
  backend.putHead = (head) => {
    publish(head);
    signal("pending");
    if (!gate()) throw cancelled;
  };
  try {
    signal("ready");
    try {
      capture(agent, record, "summary-native");
    } catch (error) {
      if (error !== cancelled) throw error;
      signal("rolled-back");
      // Stay alive while the competing writer commits: the cancelled head must never reappear.
      gate();
      return;
    }
    signal("committed");
  } finally {
    backend.putHead = publish;
    closeBackends();
  }
}

async function knownRecordRegressions(agent: string, recordJson: string): Promise<void> {
  const { backendFor, closeBackends, ledgerSessionInfo, recoverDirty } = await import(
    "../../src/ledger/records.js"
  );
  const base = JSON.parse(recordJson) as WorkRecord;
  const requestId = "22222222-2222-4222-8222-222222222222";
  capture(agent, base, "ledger-driver");
  capture(
    agent,
    { ...base, type: "request", requestId, startedAt: "2026-10-01T00:01:00.000Z" },
    "ledger-driver",
  );
  capture(
    agent,
    { ...base, type: "request_response", requestId, responseId: "regression-response" },
    "ledger-driver",
  );
  closeBackends();

  const counts = (): Record<string, number> => {
    const store = openStore(agent);
    try {
      return Object.fromEntries(
        [
          ["authority", "work_records"],
          ["markers", "pending_translation"],
          ["heads", "work_projection_head"],
          ["rows", "work_projection_rows"],
          ["notes", "bookkeeping"],
          ["dirty", "work_dirty"],
          ["diagnostics", "diagnostics"],
        ].map(([name, table]) => [
          name,
          store.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count ?? -1,
        ]),
      );
    } finally {
      store.close();
    }
  };
  // Reopen through the real SQL backend, including its session-column mapping.
  const session = ledgerSessionInfo(agent, base.sessionId);
  const responseId = readWorkSummary(agent, base.workId)?.requests[0]?.responseId;
  const before = counts();
  let constraintRejected = false;
  try {
    capture(agent, { ...base, sessionId: null } as unknown as WorkRecord, "ledger-driver");
  } catch {
    constraintRejected = true;
  }
  closeBackends();
  const afterConstraint = counts();
  const backend = backendFor(agent);
  let rolledBack = false;
  try {
    backend.tx(() => {
      capture(agent, { ...base, recordedAt: "2026-10-01T00:05:00.000Z" }, "ledger-driver");
      backend.putNote(base.workId, "rollback-probe", "written");
      backend.markDirty(base.workId);
      backend.diagnostic("rollback-probe");
      throw new Error("rollback-probe");
    });
  } catch {
    rolledBack = true;
  }
  closeBackends();
  const afterRollback = counts();
  const replay = backendFor(agent);
  const originalRows = replay.readRecords({});
  let budgetChecks = 0;
  let iterationAborted = false;
  try {
    // The backend checks once before iteration, then once per SQL row: abort on row two.
    replay.readRecords({}, () => {
      if (++budgetChecks === 3) throw new Error("iteration budget exhausted");
    });
  } catch (error) {
    iterationAborted = error instanceof Error && error.message === "iteration budget exhausted";
  }
  // No reconnect: this must reuse the same prepared statement after its iterator was interrupted.
  const afterAbort = replay.readRecords({});
  replay.tx(() => replay.putNote(base.workId, "iteration-reuse", "committed"));
  const transactionWrite = replay.getNote(base.workId, "iteration-reuse") === "committed";
  closeBackends();
  const reopened = backendFor(agent);
  const reopenedRows = reopened.readRecords({});
  const iteration = {
    aborted: iterationAborted,
    budgetChecks,
    sameConnectionRows: afterAbort.length,
    sameConnectionUnchanged: JSON.stringify(afterAbort) === JSON.stringify(originalRows),
    transactionWrite,
    reopenedRows: reopenedRows.length,
    reopenedUnchanged: JSON.stringify(reopenedRows) === JSON.stringify(originalRows),
    reopenedNote: reopened.getNote(base.workId, "iteration-reuse") === "committed",
    noLegacyJournal: !readdirSync(agent).includes("work-attribution"),
  };
  closeBackends();
  const dirty = backendFor(agent);
  const beforeRecovery = dirty.readRecords({});
  const recoveryView = readWorkSummary(agent, base.workId);
  dirty.tx(() => {
    dirty.clearProjection(base.workId);
    dirty.markDirty(base.workId);
  });
  const clearDirty = dirty.clearDirty;
  let recoveryFailed = false;
  dirty.clearDirty = (workId) => {
    clearDirty(workId);
    throw new Error("recovery marker failure");
  };
  try {
    recoverDirty(agent);
  } catch (error) {
    recoveryFailed = error instanceof Error && error.message === "recovery marker failure";
  } finally {
    dirty.clearDirty = clearDirty;
  }
  closeBackends();
  const afterFailure = backendFor(agent);
  const recoveryRolledBack =
    afterFailure.dirtyWorks().includes(base.workId) &&
    afterFailure.getHead(base.workId) === undefined &&
    afterFailure.readLog(base.workId, "requests").length === 0 &&
    afterFailure.readLog(base.workId, "sessions").length === 0 &&
    JSON.stringify(afterFailure.readRecords({})) === JSON.stringify(beforeRecovery);
  afterFailure.tx(() => afterFailure.clearProjection(base.workId));
  closeBackends();
  const afterReopen = backendFor(agent);
  const reopenedDirty = afterReopen.dirtyWorks().includes(base.workId);
  const reopenedMissingHead = afterReopen.getHead(base.workId) === undefined;
  recoverDirty(agent);
  const recovery = {
    failed: recoveryFailed,
    rolledBack: recoveryRolledBack,
    reopenedDirty,
    reopenedMissingHead,
    headRestored: afterReopen.getHead(base.workId)?.workId === base.workId,
    viewRestored:
      JSON.stringify(readWorkSummary(agent, base.workId)) === JSON.stringify(recoveryView),
    dirtyCleared: !afterReopen.dirtyWorks().includes(base.workId),
    authorityUnchanged:
      JSON.stringify(afterReopen.readRecords({})) === JSON.stringify(beforeRecovery),
    persistedAfterReopen: false,
  };
  closeBackends();
  const final = backendFor(agent);
  recovery.persistedAfterReopen =
    final.getHead(base.workId)?.workId === base.workId &&
    !final.dirtyWorks().includes(base.workId) &&
    JSON.stringify(final.readRecords({})) === JSON.stringify(beforeRecovery) &&
    JSON.stringify(readWorkSummary(agent, base.workId)) === JSON.stringify(recoveryView);
  closeBackends();
  out({
    sessionWorkId: session.work?.workId,
    sessionRecords: session.recordCount,
    responseId,
    before,
    constraintRejected,
    afterConstraint,
    rolledBack,
    afterRollback,
    recovery,
    iteration,
  });
}

async function knownSchemaRaceOpen(agent: string): Promise<void> {
  // Signal after the real initial PRAGMA read, so the parent commits only after this opener saw version 0.
  type VersionStatement = { get: (...args: unknown[]) => { user_version?: number } | null };
  const prototype = Database.prototype as unknown as { query: (sql: string) => VersionStatement };
  const original = prototype.query;
  let announced = false;
  prototype.query = function (sql: string): VersionStatement {
    const statement = original.call(this, sql);
    if (sql === "PRAGMA user_version" && !announced) {
      const get = statement.get;
      statement.get = function (...args: unknown[]) {
        const value = get.apply(this, args);
        if (!announced) {
          announced = true;
          out({ versionRead: value?.user_version });
        }
        return value;
      };
    }
    return statement;
  };
  try {
    openStore(agent).close();
    out({ opened: true });
  } catch (error) {
    out({ opened: false, code: (error as { code?: string }).code });
  } finally {
    prototype.query = original;
  }
}

async function knownSchemaRace(agent: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = ledgerDbPath(agent);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const writer = new Database(path, { create: true });
  writer.exec(
    "PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; PRAGMA user_version=777; CREATE TABLE future_only(value TEXT)",
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "known-schema-race-open", agent],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let sawVersion = false;
  let committed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const readVersion = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`schema opener never read version 0: ${errors}`)),
      10_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"versionRead":0')) {
        sawVersion = true;
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", () => {
      if (!sawVersion)
        reject(new Error(`schema opener exited before stale read: ${output}${errors}`));
    });
  });
  try {
    await readVersion;
    writer.exec("COMMIT");
    committed = true;
    const code = await exited;
    if (code !== 0) throw new Error(`schema opener failed: ${errors}`);
    const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    out({
      ...result,
      version: writer.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
      tables: writer
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    });
  } finally {
    clearTimeout(timer);
    if (!committed) writer.exec("ROLLBACK");
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
    writer.close();
  }
}

const commands: Record<string, (agent: string, arg?: string) => void | Promise<void>> = {
  probe: (agent) => probe(agent),
  "foreign-check": (agent) => foreignCheck(agent),
  "hold-writer": (agent, ms) => holdWriter(agent, ms === "release" ? ms : Number(ms ?? "0")),
  "read-only": (agent) => readOnly(agent),
  "schema-check": (agent) => schemaCheck(agent),
  "plan-since": (agent, arg) => planSince(agent, arg),
  "write-probe": (agent) => writeProbe(agent),
  "self-heal": (agent) => selfHeal(agent),
  capture: (agent, json) => captureRecord(agent, json ?? "{}"),
  head: (agent, workId) => printHead(agent, workId ?? ""),
  rows: (agent, workId) => printRows(agent, workId ?? ""),
  records: (agent, workId) => printRecords(agent, workId || undefined),
  "transition-repositories": async (agent, damaged) => {
    if (damaged) {
      const store = openStore(agent);
      store.db
        .query(
          "INSERT INTO work_records (record_hash,type,work_id,session_id,body,source_path,source_generation,imported_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run("damaged-body", "file_transition", "work", "session", "{invalid", "bench", 0, 0);
      store.close();
    }
    out(readTransitionRepositories(agent));
  },
  "hold-raw": async (agent, ms) => {
    // Hold the writer lock WITHOUT opening through openStore: the additive/required
    // applies must not run in the holder, so the contended reader sees the pre-migration
    // schema exactly.
    const { Database } = createRequire(import.meta.url)(
      "bun:sqlite",
    ) as typeof import("bun:sqlite");
    const db = new Database(ledgerDbPath(agent));
    db.exec("BEGIN IMMEDIATE");
    out({ held: true });
    await new Promise((resolve) => setTimeout(resolve, Number(ms ?? "0")));
    db.exec("ROLLBACK");
    db.close();
  },
  "claims-parity": async (agent) => {
    const { createHash } = await import("node:crypto");
    const { backendFor } = await import("../../src/ledger/records.js");
    const { effectiveClaims, effectiveClaimsAsync } = await import("../../src/ledger/outbox.js");
    const backend = backendFor(agent);
    const entities: string[] = [];
    backend.tx(() => {
      for (let index = 0; index < 600; index++) {
        const entityId = `entity-${index}`;
        entities.push(entityId);
        for (let revision = 1; revision <= 3; revision++) {
          const event = {
            id: `ev-${index}-${revision}`,
            source: "kimchi",
            entityId,
            revision: String(revision),
            startedAt: `2026-01-0${revision}T00:00:00.000Z`,
            work: {},
          };
          const body = Buffer.from(JSON.stringify(event));
          backend.insertOutboxEvent({
            id: `ev-${index}-${revision}`,
            accountKey: "account",
            entityId,
            kind: "work",
            body,
            hash: createHash("sha256").update(body).digest("hex"),
            createdAt: index * 10 + revision,
            ackedAt: null,
            blocked: revision === 2 && index % 7 === 0 ? "conflict" : "",
          });
        }
      }
    });
    const sync = effectiveClaims(backend, "account", entities);
    let stretches = 0;
    const async = await effectiveClaimsAsync(
      backend,
      "account",
      entities,
      async () => {
        stretches++;
      },
      () => {},
    );
    let same = sync.size === async.size;
    for (const [id, event] of sync)
      if (JSON.stringify(event) !== JSON.stringify(async.get(id))) same = false;
    out({ same, entities: sync.size, stretches });
  },
  "claim-plan": (agent) => {
    const store = openStore(agent);
    const insert = store.db.query(
      "INSERT INTO outbox_events (id, account_key, entity_id, kind, body, hash, created_at, acked_at, blocked) VALUES (?, 'bulk', 'bulk', 'work', '{}', 'hash', ?, NULL, '')",
    );
    store.tx(() => {
      for (let index = 0; index < 25_000; index++) insert.run(`claim-plan-${index}`, index);
    });
    const plan = (paged: boolean): string[] => {
      const sql = `EXPLAIN QUERY PLAN ${outboxClaimsSql(["?", "?"], paged)}`;
      const rows = paged
        ? store.db
            .query<{ detail: string }, [string, string, string, number, number]>(sql)
            .all("bulk", "a", "b", 0, 256)
        : store.db.query<{ detail: string }, [string, string, string]>(sql).all("bulk", "a", "b");
      return rows.map((row) => row.detail);
    };
    out({ claimRows: plan(false), claimRowsPage: plan(true) });
    store.close();
  },
  "delivery-plan": (agent) => {
    // Several accounts, one with a large history: pending, acknowledged, blocked, and a batch without events.
    const store = openStore(agent);
    const insert = store.db.query(
      "INSERT INTO outbox_events (id, account_key, entity_id, kind, body, hash, created_at, acked_at, blocked) VALUES (?, ?, ?, 'work', '{}', 'hash', ?, ?, ?)",
    );
    store.tx(() => {
      for (let index = 0; index < 25_000; index++)
        insert.run(`bulk-${index}`, "bulk", `e-${index}`, index, null, "");
      insert.run("acked-1", "acked", "e-acked", 1, 2, "");
      insert.run("blocked-1", "blocked", "e-blocked", 1, null, "waiting");
      store.db
        .query(
          "INSERT INTO outbox_batches (id, account_key, body, event_ids, created_at, order_key) VALUES (?, ?, '{}', '[]', ?, ?)",
        )
        .run("batch-b", "batch-only", 2, "b");
      store.db
        .query(
          "INSERT INTO outbox_batches (id, account_key, body, event_ids, created_at, order_key) VALUES (?, ?, '{}', '[]', ?, ?)",
        )
        .run("batch-a", "bulk", 1, "a");
    });
    const plan = store.db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${OUTBOX_DELIVERY_STATUS_SQL}`)
      .all()
      .map((row) => row.detail);
    // The straightforward enumeration the indexed form must agree with, row for row.
    const reference = store.db
      .query(`
				SELECT a.account_key AS accountKey,
					EXISTS(SELECT 1 FROM outbox_events e
						WHERE e.account_key = a.account_key AND e.acked_at IS NULL AND e.blocked = '') AS sendable,
					EXISTS(SELECT 1 FROM outbox_batches b WHERE b.account_key = a.account_key) AS hasBatch,
					(SELECT id FROM outbox_batches WHERE account_key = a.account_key
						ORDER BY order_key, created_at, rowid LIMIT 1) AS firstBatchId
				FROM (SELECT account_key FROM outbox_events UNION SELECT account_key FROM outbox_batches) a
				ORDER BY a.account_key`)
      .all();
    store.close();
    const rows = backendFor(agent).outboxDeliveryStatus();
    closeBackends();
    out({ plan, rows, reference });
  },
  "pre-migrate": async (agent) => {
    // Strip a ledger to its pre-migration shape: no materialized repository
    // set and no additive imported_at index, with user_version still 1.
    const store = openStore(agent);
    store.db.exec("DROP TRIGGER IF EXISTS work_records_repository_probe");
    store.db.exec("DROP TABLE IF EXISTS transition_repositories");
    store.db.exec("DROP INDEX IF EXISTS work_records_imported");
    store.close();
    out({ preMigrated: true });
  },
  "records-since": (agent, arg) => {
    out(readRecords(agent, { modifiedSince: Number(arg ?? "0") }));
  },
  "repository-backfill": async (agent) => {
    // Odd rows first: the insert-time trigger must skip a damaged body and a non-text
    // repository without failing the insert.
    const odd = openStore(agent);
    const insert = odd.db.query(
      "INSERT INTO work_records (record_hash,type,work_id,session_id,body,source_path,source_generation,imported_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run("bf-damaged", "file_transition", "work", "session", "{invalid", "bench", 0, 0);
    insert.run(
      "bf-numeric",
      "file_transition",
      "work",
      "session",
      '{"repository": 123}',
      "bench",
      0,
      0,
    );
    odd.close();
    // Remove the materialized set entirely: the ledger now "predates" it, so the next
    // open's additive pass must backfill from the authority rows under the same tolerance.
    const pre = openStore(agent);
    pre.db.exec("DROP TRIGGER IF EXISTS work_records_repository_probe");
    pre.db.exec("DROP TABLE IF EXISTS transition_repositories");
    pre.close();
    const post = openStore(agent);
    const repositories = readTransitionRepositories(agent);
    post.close();
    out(repositories);
  },
  "import-journals": (agent) => importJournalsCommand(agent),
  outbox: (agent, mode) => outboxScenario(agent, mode ?? "sqlite"),
  "delivery-status": (agent, mode) => deliveryStatusScenario(agent, mode ?? "sqlite"),
  "outbox-transport": (agent) => outboxTransport(agent),
  "import-capture": async (agent) => {
    const { importJournals } = await import("../../src/ledger/import.js");
    let result = await importJournals(agent, { verifyCapturePrefix: true });
    while (result.pending) result = await importJournals(agent, { verifyCapturePrefix: true });
    out({ imported: result.imported, modes: result.files.map((file) => file.mode) });
  },
  listfiles: (agent) => listFiles(agent),
  "summary-state": (agent, workId) => summaryState(agent, workId ?? ""),
  "summary-writer": (agent, json) => summaryWriter(agent, json ?? "{}"),
  "known-record-regressions": (agent, json) => knownRecordRegressions(agent, json ?? "{}"),
  "known-schema-race": (agent) => knownSchemaRace(agent),
  "known-schema-race-open": (agent) => knownSchemaRaceOpen(agent),
};

if (!command || !agentDir || !commands[command]) {
  console.error(`usage: ledger-driver.ts <${Object.keys(commands).join("|")}> <agentDir> [arg]`);
  process.exit(1);
}
await commands[command](agentDir, arg);
