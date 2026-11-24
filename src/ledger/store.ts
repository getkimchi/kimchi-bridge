/**
 * Open/guard logic for the PR-cost ledger (src/extensions/pr-cost-reporting/ledger/).
 *
 * Runtime strategy (plan Decision 8): record capture and reads are synchronous
 * callers, so the `bun:sqlite` binding is loaded with a synchronous
 * `createRequire("bun:sqlite")`, lazily, on first open — never at module import,
 * so Node/vitest loads this module fine. Production always runs Bun; opening the
 * database under Node throws LedgerUnavailableError.
 *
 * Durability and concurrency: WAL with synchronous=FULL replaces the per-append
 * fsync of the journal era; a 5s busy timeout orders concurrent Kimchi processes;
 * a writer that cannot get the lock within it surfaces SQLITE_BUSY (proven by the
 * store test via the Bun driver), never corruption. The open path additionally
 * retries transient SQLITE_BUSY for a short window (an attempt started at the
 * deadline can still wait one busy timeout inside SQLite), because SQLite
 * does not invoke the busy handler for WAL shared-memory locks during a
 * concurrent WAL upgrade of a fresh database.
 */
import type * as Sqlite from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  LEDGER_ADDITIVE_SCHEMA,
  LEDGER_REQUIRED_SCHEMA,
  LEDGER_SCHEMA,
  LEDGER_TRANSITION_BACKFILL,
  META_PROJECTION_VERSION,
  META_WRITER_EPOCH,
  PROJECTION_VERSION,
  SCHEMA_VERSION,
} from "./schema.js";

/** SQLite's own read-write open flag, passed as the raw `bun:sqlite` flags number when an
 *  existing database must be opened read-write without creating it. */
export const SQLITE_OPEN_READWRITE = 2;

/** Thrown when the database cannot be opened in this runtime (no bun:sqlite). */
export class LedgerUnavailableError extends Error {
  readonly code = "pr-cost-ledger/unavailable";
  constructor(cause: unknown) {
    super("PR-cost ledger requires the Bun runtime (bun:sqlite)", { cause });
    this.name = "LedgerUnavailableError";
  }
}

/** Thrown when the database on disk was written by an incompatible schema; nothing is written. */
export class LedgerSchemaError extends Error {
  readonly code = "pr-cost-ledger/future-schema";
  constructor(readonly found: number) {
    super(`PR-cost ledger schema ${found} is not schema ${SCHEMA_VERSION}; refusing to write`);
    this.name = "LedgerSchemaError";
  }
}

/** Thrown inside a fenced store's write transaction when the writer epoch moved: this writer lost
 * the reconciliation lease (or never held it), so its transaction rolls back without writing. */
export class LedgerFencedError extends Error {
  readonly code = "pr-cost-ledger/fenced";
  /** `held` is the epoch the database now carries; `mine` is the epoch this connection was fenced with. */
  constructor(
    readonly held: number,
    readonly mine: number,
  ) {
    super(
      `Ledger writer epoch moved from ${mine} to ${held}; this reconciliation writer is fenced out`,
    );
    this.name = "LedgerFencedError";
  }
}

let sqlite: typeof Sqlite | undefined;
function bunSqlite(): typeof Sqlite {
  if (!sqlite) {
    try {
      sqlite = createRequire(import.meta.url)("bun:sqlite") as typeof Sqlite;
    } catch (error) {
      throw new LedgerUnavailableError(error);
    }
  }
  return sqlite;
}

/** A reconciliation pass's write fence. `epoch` is the writer epoch the lease holder granted
 * the pass; every fenced write re-reads the persisted epoch inside its transaction and aborts
 * whole on a mismatch. `assertWritable` is the injectable liveness hook the fence calls inside
 * every fenced write transaction, right after the epoch check, and again on the pass's durable
 * file-write paths (the reporting queue's state renames, spool retirement) where no SQLite
 * transaction surrounds the write. Contract: it must be cheap, synchronous and side-effect
 * free, and it throws to abort the fenced write. The epoch check alone cannot stop a stale
 * writer whose lease was taken by an old release that never bumps `meta.writer_epoch`, so the
 * worker (chunk B4b) wires this hook to its parent-heartbeat check: a worker whose parent died
 * stops writing even when the epoch row cannot move. A no-op hook keeps epoch-only fencing. */
export interface LedgerWriteFence {
  /** The agent directory whose ledger this fence scopes. */
  readonly agentDir: string;
  /** The writer epoch this pass was granted by the lease holder. */
  readonly epoch: number;
  /** Throws to abort a fenced write; see the interface contract above. */
  assertWritable(): void;
}

const writeFences = new AsyncLocalStorage<LedgerWriteFence>();

/** Runs body with this agent directory's write fence installed for the current async context:
 * every ledger write the body issues, directly or through anything it awaits, first re-checks
 * the persisted writer epoch inside its transaction and calls the fence's writable hook. The
 * fence is context-scoped, never connection-global: the same process's session capture runs
 * outside the pass context and is never fenced. The lease holder must call this before the
 * pass body runs; `acquireWriterEpoch` itself must run outside a fenced context of the same
 * agent directory, or it would fence its own bump. */
export function withLedgerWriteFence<T>(fence: LedgerWriteFence, body: () => T): T {
  return writeFences.run(fence, body);
}

/** The write fence of the current async context, if any. */
export function currentLedgerWriteFence(): LedgerWriteFence | undefined {
  return writeFences.getStore();
}

/** Inside an open write transaction on this agent directory's database: re-reads the persisted
 * epoch (only a new lease holder can have moved it, inside its own immediate transaction) and
 * runs the writable hook. Inert without a fence, or when the fence scopes another agent
 * directory's ledger. */
function assertFencedWritable(db: Sqlite.Database, agentDir: string): void {
  const fence = writeFences.getStore();
  if (!fence || fence.agentDir !== agentDir) return;
  const held = readWriterEpoch(db);
  if (held !== fence.epoch) throw new LedgerFencedError(held, fence.epoch);
  fence.assertWritable();
}

/** The ledger lives beside the legacy state.json queue, inheriting its directory's lock discipline. */
export function ledgerDbPath(agentDir: string): string {
  // Mirrors Kimchi's queue.reportingDirectory (agentDir/pr-cost-reporting); kept local so the
  // ledger library needs no Kimchi imports.
  return join(agentDir, "pr-cost-reporting", "ledger.db");
}

/** Pure version decision, unit-tested without a database. */
export function classifyUserVersion(version: number): "create" | "open" | "foreign" {
  if (version === 0) return "create";
  return version === SCHEMA_VERSION ? "open" : "foreign";
}

export interface LedgerStore {
  readonly db: Sqlite.Database;
  readonly path: string;
  /** True while the optional additive-index apply was skipped on a busy writer. Reads still work (the
   * windowed read probes and drops the index hint); readers retry the apply lazily until it lands,
   * so a cached backend self-heals without waiting for a fresh open. */
  additiveDeferred: boolean;
  /** Retry a deferred additive apply on this live connection; true when the indexes are present after it. */
  tryAdditiveSchema(): boolean;
  /** Run fn in an immediate transaction: all-or-nothing commit for capture/import/ACK points. */
  tx<T>(fn: () => T): T;
  /** Fences this connection's write transactions to one writer epoch: every subsequent tx first
   * checks `meta.writer_epoch` inside the transaction and throws LedgerFencedError on a mismatch,
   * rolling back before any statement of fn runs. Inert until called (capture connections and
   * old releases that never write the epoch are unaffected). */
  fence(epoch: number): void;
  close(): void;
}

/** Reads the persisted writer epoch; a missing row reads as 0 (no release ever fenced this ledger).
 *  A database whose base schema has not been created yet reads as 0 too: the create transaction
 *  in openStore checks the fence before the schema exists, and an unfenced ledger is exactly the
 *  state a fresh database is in. */
export function readWriterEpoch(db: Sqlite.Database): number {
  let row: { value: string } | null | undefined;
  try {
    row = db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(META_WRITER_EPOCH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("no such table") && message.includes("meta")) return 0;
    throw error;
  }
  return row ? Number(row.value) : 0;
}

/** Bumps the writer epoch and returns the new value, in one IMMEDIATE transaction: the lease
 * holder calls this per acquisition, and passes the result to the reconciliation pass it grants.
 * Old releases never write the epoch, so a fenced writer only ever races fences it can see. */
export function acquireWriterEpoch(store: LedgerStore): number {
  return store.tx(() => {
    const held = readWriterEpoch(store.db);
    if (!Number.isSafeInteger(held) || held < 0)
      throw new Error("Invalid PR-cost ledger writer epoch");
    const next = held + 1;
    store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
      META_WRITER_EPOCH,
      String(next),
    ]);
    return next;
  });
}

/** Per-connection busy timeout. */
export const BUSY_TIMEOUT_MS = 5000;
/** Capture's busy wait before the record parks in the spool: bounded, so a held writer in another
 * process cannot stall the session's event loop (plan chunk B4). */
export const CAPTURE_BUSY_TIMEOUT_MS = 250;
/**
 * Open-retry window. The loser of the fresh-database WAL-upgrade race only waits for the winner to
 * finish the upgrade and schema create: measured max 19ms over 120 three-way contended opens, so 1s
 * leaves wide headroom while capping the synchronous event-loop stall.
 */
const OPEN_RETRY_BUDGET_MS = 1000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(error: unknown): boolean {
  return String((error as { code?: unknown } | null)?.code ?? "").startsWith("SQLITE_BUSY");
}

/** True when the error is any SQLITE_BUSY* result — the signal capture's spool path keys on. */
export function isBusyError(error: unknown): boolean {
  return isBusy(error);
}

/** Additive-schema apply errors that mean "another writer holds the lock": retriable, never fatal. */
function isAdditiveBusy(error: unknown): boolean {
  if (isBusy(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is (locked|busy)/.test(message);
}

/** Upper edges (ms) of the write-transaction duration histogram; the last bucket is unbounded. */
export const TX_DURATION_EDGES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

/** Measured write-transaction durations of one store connection, for bounded-transaction
 * reporting: total count, wall time, slowest, the last transaction's duration (what the adaptive
 * chunk sizers observe), and the histogram counts above. */
export interface TxDurations {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  buckets: number[];
}

interface TxHistogram {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  buckets: number[];
}

const histograms = new WeakMap<LedgerStore, TxHistogram>();

/** The store's transaction-duration histogram; zeroes when nothing was measured yet. */
export function txDurations(store: LedgerStore): TxDurations {
  const histogram = histograms.get(store) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    buckets: Array.from({ length: TX_DURATION_EDGES.length + 1 }, () => 0),
  };
  return { ...histogram, buckets: [...histogram.buckets] };
}

/** Zeroes the store's histogram; a pass reports its own window by resetting first. */
export function resetTxDurations(store: LedgerStore): void {
  const histogram = histograms.get(store);
  if (!histogram) return;
  histogram.count = 0;
  histogram.totalMs = 0;
  histogram.maxMs = 0;
  histogram.lastMs = 0;
  histogram.buckets.fill(0);
}

let txClock: () => number = () => performance.now();

/** Replaces the clock the histogram measures with; tests inject a controllable one. */
export function useTxClock(clock: (() => number) | null): void {
  txClock = clock ?? (() => performance.now());
}

/** Records one measured transaction: bucketed, monotonic-clock, cheap. */
function recordTx(store: LedgerStore, start: number): void {
  const histogram = histograms.get(store);
  if (!histogram) return;
  const ms = Math.max(0, txClock() - start);
  histogram.count++;
  histogram.totalMs += ms;
  histogram.maxMs = Math.max(histogram.maxMs, ms);
  histogram.lastMs = ms;
  histogram.buckets[txBucketOf(ms)]++;
}

function txBucketOf(ms: number): number {
  for (let index = 0; index < TX_DURATION_EDGES.length; index++)
    if (ms <= TX_DURATION_EDGES[index]) return index;
  return TX_DURATION_EDGES.length;
}

/** One additive-schema attempt on a live connection: a short busy timeout orders it against other
 * writers, and a busy result is reported (not thrown) so the caller can retry later. Reached from
 * a fenced pass (a deferred heal on a cached connection), it carries the fence's checks inside
 * the apply transaction. */
function applyAdditiveSchema(
  ledger: Sqlite.Database,
  agentDir: string,
  restoreMs: number = BUSY_TIMEOUT_MS,
): boolean {
  ledger.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS / 20}`);
  try {
    ledger
      .transaction(() => {
        assertFencedWritable(ledger, agentDir);
        ledger.exec(LEDGER_ADDITIVE_SCHEMA);
      })
      .immediate();
    return true;
  } catch (error) {
    // A fenced-out writer defers the optional apply exactly like a busy one: reads still work
    // (the windowed read probes and drops the index hint) and a later context retries it.
    if (!isAdditiveBusy(error) && !(error instanceof LedgerFencedError)) throw error;
    return false;
  } finally {
    ledger.exec(`PRAGMA busy_timeout=${restoreMs}`);
  }
}

/**
 * Runs attempt, retrying with capped exponential backoff while it throws an SQLITE_BUSY* error and the
 * budget lasts. Any other error, or the last busy error once the budget is spent, is rethrown. An attempt
 * started just before the deadline may still wait inside SQLite, so the worst case is the budget plus one busy timeout.
 * attempt must be safe to repeat and release its own resources when it throws.
 */
export function retryOnBusy<T>(
  attempt: () => T,
  budgetMs: number,
  clock: { now(): number; sleep(ms: number): void } = { now: Date.now, sleep: sleepSync },
): T {
  const deadline = clock.now() + budgetMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    try {
      return attempt();
    } catch (error) {
      const remaining = deadline - clock.now();
      if (!isBusy(error) || remaining <= 0) throw error;
      clock.sleep(Math.min(delay, remaining));
    }
  }
}

/**
 * Opens (and on first use creates) the ledger. Foreign schemas fail closed:
 * the file is left exactly as found, and callers report the collector degraded
 * instead of writing records a different build cannot read.
 *
 * The whole open is retried on SQLITE_BUSY*: SQLite does not invoke the busy handler for WAL
 * shared-memory locks during a concurrent WAL upgrade of a fresh database, so two processes opening
 * the same brand-new ledger race past busy_timeout and the loser fails instantly.
 */
/** Options for the capture-mode open: the cold open runs inside capture's bounded busy
 *  window instead of the 5 s reconciliation timeout, defers the optional additive-schema apply
 *  (the windowed read heals it lazily once contention clears), and never retries past its own
 *  budget — so a held writer parks the record in the spool within the capture window rather
 *  than stalling or failing the session's event loop. */
export interface OpenStoreOptions {
  /** The connection's initial busy timeout. */
  busyTimeoutMs?: number;
  /** The open-retry budget for fresh-database WAL-upgrade races. */
  openRetryBudgetMs?: number;
  /** Skip the eager additive-schema apply; mark it deferred for the windowed read to heal. */
  deferAdditiveSchema?: boolean;
}

export function openStore(agentDir: string, options: OpenStoreOptions = {}): LedgerStore {
  const busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const { Database } = bunSqlite();
  const path = ledgerDbPath(agentDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  return retryOnBusy(() => {
    let db: Sqlite.Database | undefined;
    try {
      const ledger = new Database(path, { create: true, strict: true });
      db = ledger;
      // Connection-local: even the first schema read may race another process's initialization.
      ledger.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
      // Read the version before any persisting pragma so a foreign database is left exactly as found.
      const version =
        ledger.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      const decision = classifyUserVersion(version);
      if (decision === "foreign") throw new LedgerSchemaError(version);
      ledger.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON");
      if (decision === "create") {
        ledger
          .transaction(() => {
            // Re-read inside the immediate lock: a concurrent process may have finished creating (or written a
            // foreign version) between the outer read and this transaction.
            assertFencedWritable(ledger, agentDir);
            const again =
              ledger.query<{ user_version: number }, []>("PRAGMA user_version").get()
                ?.user_version ?? 0;
            if (again === SCHEMA_VERSION) return;
            if (classifyUserVersion(again) === "foreign") throw new LedgerSchemaError(again);
            ledger.exec(LEDGER_SCHEMA);
            ledger.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
          })
          .immediate();
      }
      // Indexes added after SCHEMA_VERSION shipped still land on pre-existing ledgers: every statement is
      // idempotent, so applying them on each open keeps older databases at size with fresh ones. These
      // are optional — readers probe their presence — so a held writer lock skips the pass rather than
      // stalling a reader. The store marks the skip, and readers retry the apply on this live connection
      // (a cached backend self-heals; it does not wait for the next open).
      const epochOf = ledger.query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?",
      );
      let fencedEpoch: number | undefined;
      const store: LedgerStore = {
        db: ledger,
        path,
        additiveDeferred: false,
        tryAdditiveSchema: () => {
          if (!store.additiveDeferred) return true;
          store.additiveDeferred = !applyAdditiveSchema(ledger, agentDir);
          return !store.additiveDeferred;
        },
        fence: (epoch: number) => {
          fencedEpoch = epoch;
        },
        tx: <T>(fn: () => T): T => {
          const start = txClock();
          try {
            return ledger
              .transaction(() => {
                // Checked after the immediate lock is held, before any statement of fn: a stale writer
                // aborts here and the transaction rolls back having written nothing at all.
                if (fencedEpoch !== undefined) {
                  const row = epochOf.get(META_WRITER_EPOCH);
                  const held = row ? Number(row.value) : 0;
                  if (held !== fencedEpoch) throw new LedgerFencedError(held, fencedEpoch);
                }
                // The context-scoped pass fence carries the same check plus the writable hook,
                // so a pass-scoped connection is fenced without touching the session's capture.
                assertFencedWritable(ledger, agentDir);
                return fn();
              })
              .immediate();
          } finally {
            recordTx(store, start);
          }
        },
        close: () => ledger.close(),
      };
      histograms.set(store, {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: 0,
        buckets: Array.from({ length: TX_DURATION_EDGES.length + 1 }, () => 0),
      });
      // A capture-mode open defers the optional apply: attempting it under the short busy
      // window would burn the whole window before capture even reaches its own commit, and
      // the windowed read heals a deferred apply lazily once contention clears.
      if (options.deferAdditiveSchema) store.additiveDeferred = true;
      else if (!applyAdditiveSchema(ledger, agentDir, busyTimeoutMs)) store.additiveDeferred = true;
      // Required objects: backend construction reads transition_repositories unconditionally, so
      // this apply is never skipped on a busy writer — the busy error propagates to the open's
      // retry loop (which re-attempts whole) instead of handing out a backend whose schema it cannot
      // read. The lock-free probe keeps the steady-state open read-only, so WAL readers stay
      // concurrent while nobody is migrating; only the one-time migration takes the write lock.
      // A ledger that predates the materialized repository set backfills its existing rows the first
      // time the table appears. Detection, creation, and population share one immediate
      // transaction, so a crash leaves the table absent and the next open retries whole.
      const requiredPresent = ledger
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'transition_repositories'",
        )
        .get();
      if ((requiredPresent?.count ?? 0) === 0)
        ledger
          .transaction(() => {
            // Re-read inside the write lock: another process may have finished the
            // migration between the outer lock-free probe and this transaction.
            assertFencedWritable(ledger, agentDir);
            const again = ledger
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'transition_repositories'",
              )
              .get();
            ledger.exec(LEDGER_REQUIRED_SCHEMA);
            if ((again?.count ?? 0) === 0) ledger.exec(LEDGER_TRANSITION_BACKFILL);
          })
          .immediate();
      return store;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // A failed close never masks the original open error.
      }
      throw error;
    }
  }, options.openRetryBudgetMs ?? OPEN_RETRY_BUDGET_MS);
}

/**
 * Clears the derived projection when its format version changed, so readers
 * rebuild from the authority table. Authority and outbox rows are never touched.
 */
export function ensureProjectionVersion(store: LedgerStore): boolean {
  const row = store.db
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(META_PROJECTION_VERSION);
  if (row && Number(row.value) === PROJECTION_VERSION) return false;
  store.tx(() => {
    store.db.run("DELETE FROM work_projection_rows");
    store.db.run("DELETE FROM work_projection_head");
    store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
      META_PROJECTION_VERSION,
      String(PROJECTION_VERSION),
    ]);
  });
  return true;
}
