import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { mergePullRequestLinks, pullRequestFoldAmbiguous } from "./links.js";
import { mergeRecordsInto, type SummaryRows } from "./merge.js";
import {
  COLLECTIONS,
  type Collection,
  commitPullRequests,
  type LogName,
  observeLatest,
  ROW_KEYS,
  type Row,
  summaryLatest,
  type WorkHead,
  type WorkSummaryView,
} from "./row-log.js";
import {
  BUSY_TIMEOUT_MS,
  CAPTURE_BUSY_TIMEOUT_MS,
  currentLedgerWriteFence,
  ensureProjectionVersion,
  isBusyError,
  LedgerFencedError,
  type LedgerStore,
  openStore,
  pinAgentDir,
  readWriterEpoch,
  resetTxDurations,
  type TxDurations,
  txDurations,
} from "./store.js";
import { createTxChunkSizer, rememberSizer, type TxChunkSizer } from "./tx-budget.js";
import { object, type WorkRecord } from "./work-record.js";

/**
 * The one storage engine behind capture, import, the derived summary projection, and tracker bookkeeping. Both
 * backends (SQLite in production, in-memory in vitest) implement the same primitive contract; every higher-level
 * operation here is written once against it. Backends are resolved per agentDir and cached for the process.
 */

/** One durably stored work record. `body` is the canonical JSON of the record object. */
export interface StoredRecord {
  recordHash: string;
  type: string;
  workId: string;
  sessionId: string;
  body: string;
  sourcePath: string | null;
  sourceGeneration: number;
  sourceOffset: number | null;
  importedAt: number;
}

/** A stable insertion position for bounded authority reads; never a projection position. */
export interface PositionedRecord extends StoredRecord {
  position: number;
}

/** Where the C3 importer stopped in one journal file; bytes [0, offset) are the consumed prefix. */
export interface JournalCursor {
  path: string;
  dev: number;
  ino: number;
  generation: number;
  offset: number;
  boundaryHash: string;
  updatedAt: number;
}

export interface OutboxEvent {
  id: string;
  accountKey: string;
  entityId: string;
  kind: string;
  body: Uint8Array;
  hash: string;
  createdAt: number;
  ackedAt: number | null;
  blocked: string;
}

export interface OutboxBatch {
  id: string;
  accountKey: string;
  body: Uint8Array;
  eventIds: string[];
  createdAt: number;
  orderKey: string;
}

export interface OutboxAccountStatus {
  accountKey: string;
  pending: number;
  sendable: number;
  blocked: number;
  acknowledged: number;
  lastAcknowledgedAt: number | null;
  batches: number;
  firstBatchId: string | null;
}

/** Delivery-relevant account status: what the worker's delivery loop needs — the account, sendable
 * presence, batch presence and first batch — without the full read's aggregation over all event
 * history. */
export interface DeliveryAccountStatus {
  accountKey: string;
  sendable: boolean;
  hasBatch: boolean;
  firstBatchId: string | null;
}

/** Primitive storage contract; see schema.ts for the SQL tables and memory-records.ts for the test double. */
export interface RecordBackend {
  /** Runs `fn` atomically; no await may happen inside. */
  tx<T>(fn: () => T): T;
  /** The persisted writer epoch of this backend's store, for the file-write fence check; absent
   * on backends without a cross-process store (the in-memory double). */
  writerEpoch?(): number;
  /** Measured write-transaction durations of this backend's connection, for the bounded-
   * transaction budget; absent on backends that do not measure (the in-memory double). */
  txDurations?(): TxDurations;
  /** Zeroes the connection's duration histogram; a pass scopes its report this way. */
  resetTxDurations?(): void;
  /** Capture's contended write: runs commit() under the short busy timeout and returns false when
   * the writer was busy for that whole window (the caller parks the record in the spool);
   * absent on backends whose store cannot be busy. `busyMs` narrows the window below the
   * capture default, so time the caller spent planning is never added on top of it. */
  tryCaptureTx?(commit: () => void, busyMs?: number): boolean;
  /** True when a NEW row was inserted; false when the record hash already exists (import dedup). */
  insertRecord(row: StoredRecord): boolean;
  upsertMarker(recordHash: string, workId: string, type: string): void;
  pendingTranslations(after: number, through: number, limit: number): PositionedRecord[];
  /** Every record not yet translated into events, by work. */
  markedRecords(): { recordHash: string; workId: string; type: string }[];
  clearTranslation(recordHash: string): void;
  readTransitionRepositories(): string[];
  /** The entity's newest event that was not set aside. */
  latestOutboxEvent(accountKey: string, entityId: string): OutboxEvent | undefined;
  getOutboxEvent(accountKey: string, id: string): OutboxEvent | undefined;
  outboxEntityEvents(accountKey: string, entityId: string): OutboxEvent[];
  /** Every history row for these entities, each entity decoded at most once per claim pass. */
  outboxClaims(accountKey: string, entityIds: readonly string[]): OutboxEvent[];
  /**
   * One bounded claim-history read for at most 500 entity IDs (the bind cap), continuing
   * after a returned cursor. Rows come back rowid-ordered within the call; callers page
   * and breathe between calls so a big claim read cannot hold the UI loop in one burst.
   */
  outboxClaimRows(
    accountKey: string,
    entityIds: readonly string[],
    after: number,
    limit: number,
  ): { rows: OutboxEvent[]; nextAfter: number };
  insertOutboxEvent(event: OutboxEvent): void;
  pendingOutboxEvents(accountKey: string, limit: number): OutboxEvent[];
  outboxStatus(): OutboxAccountStatus[];
  /** Delivery-relevant account status for the worker's delivery loop; see DeliveryAccountStatus. */
  outboxDeliveryStatus(): DeliveryAccountStatus[];
  getOutboxBatch(accountKey: string): OutboxBatch | undefined;
  insertOutboxBatch(batch: OutboxBatch): void;
  ackOutboxEvent(accountKey: string, id: string, hash: string, at: number): boolean;
  /** Sets an unacknowledged event aside for `reason`; it stays out of every later batch. */
  blockOutboxEvent(accountKey: string, id: string, hash: string, reason: string): boolean;
  deleteOutboxBatch(accountKey: string, id: string): boolean;
  markDirty(workId: string): void;
  clearDirty(workId: string): void;
  dirtyWorks(): string[];
  /** Whether the work carries the dirty marker (its head is stale or missing and the next
   *  read repairs it); a cheap routing read, unlike `dirtyWorks`' full scan. OPTIONAL: the
   *  member was added after round 6, and backends written against round 6 do not have it —
   *  internal callers go through backendHasDirty, which falls back to dirtyWorks(). */
  hasDirty?(workId: string): boolean;
  /** The stored serialization's byte length of the work's saved head (0 when there is none):
   *  the oversize gate for the inline fold, read WITHOUT parsing the head. OPTIONAL for the
   *  same reason: backendHeadBodyBytes falls back to Buffer.byteLength(JSON.stringify(
   *  getHead())) when the backend predates the member. */
  headBodyBytes?(workId: string): number;
  getRow(workId: string, log: LogName, key: string): Row | undefined;
  /** A new key takes position `pos`; a later write of the same key replaces the body and keeps its position. */
  putRow(workId: string, log: LogName, key: string, body: Row, pos: number): void;
  readLog(workId: string, log: LogName): Row[];
  /** Drops the work's projection rows and manifest; its records stay untouched. */
  clearProjection(workId: string): void;
  /** Deletes the work's projection manifest (the head) only, leaving its rows: the sliced
   *  rebuild's clear starts here, so a kill mid-clear leaves a headless work every reader
   *  repairs — never a published head over missing rows. */
  clearProjectionHead(workId: string): void;
  /** Deletes at most `limit` of the work's projection rows, returning how many went: the sliced
   *  rebuild drains the old rows in bounded transactions instead of one whole-work delete. */
  deleteProjectionRows(workId: string, limit: number): number;
  getHead(workId: string): WorkHead | undefined;
  /** `body` is the head's precomputed serialization, for callers that stringified outside the
   *  write lock (the sliced publication); omitted, the store serializes the head itself. */
  putHead(head: WorkHead, body?: string): void;
  /** Optional WAL preparation before a timed, large-head publication. */
  prepareHeadPublication?(bodyBytes: number): void;
  allHeads(): WorkHead[];
  readRecords(
    opts: {
      workId?: string;
      sessionId?: string;
      modifiedSince?: number;
      type?: string;
    },
    checkBudget?: () => void,
  ): StoredRecord[];
  /** Pins an async read to the records committed when it started. */
  recordWatermark(): number;
  readRecordPage(
    after: number,
    through: number,
    limit: number,
    checkBudget?: () => void,
  ): PositionedRecord[];
  /** Pages the incremental window (records with imported_at >= modifiedSince) in rowid order within a
   * pinned watermark, so a large append backlog is read page by page instead of one uninterruptible scan. */
  readRecordsSincePage(
    modifiedSince: number,
    after: number,
    through: number,
    limit: number,
    checkBudget?: () => void,
  ): PositionedRecord[];
  /** Pages one work's records in rowid order within a pinned watermark; the
   * translation prelude reads big works without materializing them whole. */
  readWorkRecordPage(
    workId: string,
    after: number,
    through: number,
    limit: number,
    checkBudget?: () => void,
  ): PositionedRecord[];
  /** The stored body bytes of the work's records: the rebuild's whole-work branch gate,
   *  so a record-count-sized work whose merged projection is still large takes the sliced
   *  path instead of one unbounded transaction. */
  recordBytes(workId: string): number;
  recordCount(workId?: string): number;
  /** Whether the projection has any plan or commit rows for the work. */
  hasProjectionOutput(workId: string): boolean;
  hasNote(workId: string, name: string): boolean;
  getNote(workId: string, name: string): string | undefined;
  readNotePage(workId: string, after: string, limit: number): { name: string; body: string }[];
  putNote(workId: string, name: string, body: string): void;
  deleteNote(workId: string, name: string): void;
  diagnostic(code: string): void;
  getJournalCursor(path: string): JournalCursor | undefined;
  putJournalCursor(cursor: JournalCursor): void;
  deleteJournalCursor(path: string): void;
  /** Monotonic commit marker for pass-gate signatures: bumped by another process committing
   *  any row (SQLite `PRAGMA data_version`) AND by this connection's own commits (the pragma
   *  never moves for same-connection commits, so they are tracked and summed explicitly — see
   *  the ownCommits counter at the implementation). A pass's own writes are absorbed by the
   *  stamp's post-pass recompute, so an idle pass still sees it stable. */
  dataVersion(): number;
  /** Every cursor on record, so import can report files removed since the last pass. */
  listJournalCursors(): JournalCursor[];
  close(): void;
}

const backends = new Map<string, RecordBackend>();
let factory: ((agentDir: string) => RecordBackend) | undefined;

/** RecordBackend.hasDirty for internal callers: the member is optional (backends written
 *  against round 6 do not have it), so a backend without it falls back to the full
 *  dirtyWorks() scan — correct, only slower — instead of breaking at runtime. */
function backendHasDirty(backend: RecordBackend, workId: string): boolean {
  return backend.hasDirty?.(workId) ?? backend.dirtyWorks().includes(workId);
}

/** RecordBackend.headBodyBytes for internal callers: the member is optional, so a backend
 *  without it falls back to reading and reserializing the head — the same stored body the
 *  member would have measured, at the cost of the parse the member exists to avoid. */
function backendHeadBodyBytes(backend: RecordBackend, workId: string): number {
  const measured = backend.headBodyBytes?.(workId);
  if (measured !== undefined) return measured;
  const head = backend.getHead(workId);
  return head ? Buffer.byteLength(JSON.stringify(head)) : 0;
}

/** Tests register the in-memory backend; production always resolves the SQLite one. */
export function useBackendFactory(next: ((agentDir: string) => RecordBackend) | null): void {
  factory = next ?? undefined;
}

/** The file-write guard of a fenced pass: outside a transaction, re-reads the persisted writer
 * epoch and runs the fence's writable hook before a durable file step (a queue state rename, a
 * spool retirement). Backends without a cross-process store (the in-memory double) have no
 * epoch to read, so the check is inert there. The window between this check and the file write
 * is not covered by the SQLite fence: a holder that bumps the epoch inside it can still see
 * that one write land. */
export function assertLedgerWritable(agentDir: string): void {
  const fence = currentLedgerWriteFence();
  if (!fence || fence.agentDir !== agentDir) return;
  const backend = backendFor(agentDir);
  if (backend.writerEpoch) {
    const held = backend.writerEpoch();
    if (held !== fence.epoch) throw new LedgerFencedError(held, fence.epoch);
  }
  fence.assertWritable();
}

export function backendFor(agentDir: string): RecordBackend {
  const found = backends.get(agentDir);
  if (found) return found;
  const created = factory ? factory(agentDir) : sqliteBackend(agentDir);
  backends.set(agentDir, created);
  return created;
}

/** Capture's backend lookup: a warm cache returns as usual, but a COLD process — no cached
 *  backend yet — opens the ledger inside capture's own bounded busy window, so a writer held
 *  by another process fails the open (or its construction writes) with SQLITE_BUSY inside the
 *  remaining capture budget instead of stalling the session's event loop for the
 *  reconciliation timeout and escaping the spool path entirely. The opened connection is
 *  handed back with the normal busy timeout restored, exactly as tryCaptureTx leaves it. */
function captureBackendFor(agentDir: string, busyMs: number): RecordBackend {
  const found = backends.get(agentDir);
  if (found) return found;
  // The test factory (the in-memory double) cannot be busy; only the SQLite open is bounded.
  const created = factory ? factory(agentDir) : captureSqliteBackend(agentDir, busyMs);
  backends.set(agentDir, created);
  return created;
}

/** Tests drop every cached backend between agent dirs. */
export function closeBackends(): void {
  for (const backend of backends.values()) backend.close();
  backends.clear();
  rebuildSizers.clear();
  for (const [path, fd] of spoolAppendFds) closeSpoolAppendFd(path, fd);
}

/** Hash used for native capture; imported records retain the hash of their exact original line bytes. */
export function recordHashOf(record: WorkRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

/** The capture spool: where capture parks records it could not commit while another process held
 * the ledger's writer. Plain append with fsync, no locks, so it is safe on every platform.
 *
 * Downgrade note: records parked here are invisible to older releases, which do not scan this
 * directory — they stay durable on disk and are imported exactly once by the next release that
 * does. Drain the spool (one pass with the files channel) before rolling back if immediate
 * visibility is required. */
export function spoolDirectory(agentDir: string): string {
  // Pinned: the spool stays in the real tree the link pointed at when the process first used
  // it, so a repointed agentDir link cannot hide an acknowledged record from the importer.
  return join(pinAgentDir(agentDir), "work-attribution", "spool");
}

/** Total session-id encoding for the spool filename: `encodeURIComponent` for every
 * well-formed id, and an explicit `%uXXXX` escape for each unpaired UTF-16 surrogate it
 * rejects (a lone high or low half). ANY string session id therefore has a safe, collision-free
 * filename, so a contended capture can always park its record in the spool instead of throwing
 * it away — well-formed ids keep byte-for-byte the names earlier releases wrote. */
function encodeSpoolSessionId(sessionId: string): string {
  try {
    return encodeURIComponent(sessionId);
  } catch {
    let encoded = "";
    for (let index = 0; index < sessionId.length; index++) {
      const code = sessionId.charCodeAt(index);
      const next = index + 1 < sessionId.length ? sessionId.charCodeAt(index + 1) : 0;
      const pairedHigh = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
      const unpaired =
        (code >= 0xd800 && code <= 0xdbff && !pairedHigh) || (code >= 0xdc00 && code <= 0xdfff);
      if (unpaired) {
        encoded += `%u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      // A surrogate pair encodes as its combined code point, exactly like the fast path.
      const unit = pairedHigh ? sessionId.slice(index, index + 2) : sessionId[index];
      if (pairedHigh) index++;
      encoded += encodeURIComponent(unit);
    }
    return encoded;
  }
}

/** The session's spool file. The fixed `s-` prefix and the `.jsonl` suffix always surround the
 * encoded id, so Windows-reserved basenames (CON, NUL, COM1, …) and trailing dots or spaces can
 * never form the name on their own, and path separators never split it. */
export function spoolFilePath(agentDir: string, sessionId: string): string {
  return join(spoolDirectory(agentDir), `s-${encodeSpoolSessionId(sessionId)}.jsonl`);
}

/** Directory-entry fsync: persists a newly created spool directory or file, and the spool's
 * rotation renames, so a kernel crash cannot lose the path the next import scans. Windows cannot
 * open a directory for fsync, so the sync is skipped there — the file's own fsync still holds. */
export function fsyncDirectoryDurable(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** O_NOFOLLOW where the platform has it, so a symlinked spool path cannot capture the append. */
const O_NOFOLLOW = (constants.O_NOFOLLOW ?? 0) as number;

/** Creates the directory and any missing ancestors one level at a time, returning every
 * directory whose new entry needs its parent fsynced: each created directory plus the first
 * existing ancestor above them. Empty when the directory already existed. An ancestor that
 * appeared concurrently reads as already created — the EEXIST from the level's mkdir is
 * tolerated and the entry still needs no extra durability from this writer. */
function ensureDirectoryChain(directory: string): string[] {
  if (existsSync(directory)) return [];
  const created: string[] = [];
  for (let current = directory; !existsSync(current); ) {
    created.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // The loop above collected the missing levels deepest-first; creation runs topmost-first.
  created.reverse();
  for (const path of created) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!object(error) || error.code !== "EEXIST") throw error;
    }
  }
  // Each created level's new entry lives in the level above it, whose fsync persists it; the
  // topmost level's parent is the first existing ancestor.
  return created.map((path) => dirname(path));
}

/** Best-effort diagnostic line to stderr. It is observability only: a closed or failed
 * stream (an EPIPE on a closed stderr) must never break the capture path it reports for,
 * so any throw — or write failure — is swallowed and the caller continues. */
function writeDiagnosticNote(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // The diagnostic is best-effort by contract; the record's own path is unaffected.
  }
}

/** Appends the record's self-delimiting bytes to the spool file in ONE write: a leading newline
 * (which completes any torn earlier append as its own, separately quarantined line), the exact
 * line, and a trailing newline. The write loops until every byte is written, so a short write
 * cannot leave a torn record behind. The file must be a regular file with no other link and
 * owned by this user — anything else (a symlink or hardlink planted at the predictable path) is
 * refused so the caller falls back to the blocking SQLite wait. */
/** Cached append descriptors per spool path: a successful append parks its descriptor here, so
 *  the next append for the same entry writes through the very inode it verified — no name
 *  re-resolution at all, and the held descriptor pins the inode, so no replacement can recycle
 *  its number underneath the live-path identity check. Bounded, so a long-lived process cannot
 *  accumulate one per session it ever captured for. */
const spoolAppendFds = new Map<string, number>();
const SPOOL_APPEND_FD_CACHE_MAX = 16;

function closeSpoolAppendFd(path: string, fd: number): void {
  spoolAppendFds.delete(path);
  try {
    closeSync(fd);
  } catch {
    // The descriptor is gone either way; the next append re-opens the path.
  }
}

function appendSpoolRecord(path: string, line: string): boolean {
  const directory = dirname(path);
  const bytes = Buffer.from(`\n${line}\n`, "utf8");
  let fd = spoolAppendFds.get(path);
  // The first landing on an entry this process has not appended to yet: the open dance below
  // decides it exactly (an exclusive create made the entry, or the non-creating open observed
  // it) — never by comparing metadata, which a recycled inode with equal size and coarse
  // timestamps can defeat. The landing persists the directory record BEFORE any byte is
  // written, so whichever entry the append lands on — its own creation, another writer's
  // replacement, a concurrent creator's mid-flight entry — is durable at the pathname before
  // the append is acknowledged. Later appends through the cached descriptor sync only the
  // file: the directory is unchanged and its entry was already made durable by the landing.
  const firstLanding = fd === undefined;
  if (firstLanding) {
    const fsyncDirectories = ensureDirectoryChain(directory);
    try {
      fd = openSync(
        path,
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!object(error) || error.code !== "EEXIST") return false;
      // The non-creating open never creates: an entry retired between the attempts fails with
      // ENOENT and the caller's retry restarts at the exclusive create, whose own landing
      // fsync covers the fresh entry it makes.
      try {
        fd = openSync(path, constants.O_RDWR | constants.O_APPEND | O_NOFOLLOW, 0o600);
      } catch {
        return false;
      }
    }
    try {
      for (const durable of fsyncDirectories) fsyncDirectoryDurable(durable);
      fsyncDirectoryDurable(directory);
    } catch {
      // The landing's own durability step failed: nothing was written, so the attempt owes
      // nothing but a retry — which lands again and repeats the fsync.
      closeSpoolAppendFd(path, fd);
      return false;
    }
  }
  const descriptor = fd as number;
  let kept = false;
  try {
    const stat = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
      return false;
    }
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(descriptor, bytes, written, bytes.length - written);
      if (count <= 0) return false;
      written += count;
    }
    fsyncSync(descriptor);
    // The append is durable. A first landing already fsynced the directory (and any created
    // directory chain) before the first byte; a cached descriptor's entry was made durable by
    // its own landing, and the descriptor pins the inode, so no replacement can have recycled
    // it — an append to it syncs nothing but the file itself.
    // Verify through this descriptor that the record is the file's last line, and then that
    // the live pathname is still this user's private single-link regular file at the same
    // inode, never following a symlink (a link swapped in for the path would otherwise hide
    // the append from every importer scan). The write completes before the identity
    // check, so an importer that claimed the file away (renamed it to a claim, then unlinked)
    // between the open and this point is caught here: the append would otherwise live in an
    // inode no importer can ever scan again. A missing path or a different inode reports the
    // mismatch and the caller re-appends the same line to a fresh spool file — the importer's
    // line-hash dedup keeps the record exactly-once either way.
    const size = fstatSync(descriptor).size;
    if (size < bytes.length) return false;
    const tail = Buffer.alloc(bytes.length);
    readSync(descriptor, tail, 0, bytes.length, size - bytes.length);
    if (!tail.equals(bytes)) return false;
    let live: Stats;
    try {
      live = lstatSync(path);
    } catch (error) {
      if (object(error) && error.code === "ENOENT") return false;
      throw error;
    }
    if (!live.isFile() || live.nlink !== 1 || (uid !== undefined && live.uid !== uid)) {
      // The live pathname is not this user's private single-link regular file (a symlink
      // swapped in for it, an added hardlink, or a foreign owner): the append is not
      // acknowledged, the caller re-appends or falls back to the blocking SQLite wait, and
      // the unsafe path is reported so it can be repaired.
      writeDiagnosticNote(
        "kimchi: the capture spool path is unsafe; the record is being re-appended\n",
      );
      return false;
    }
    if (live.dev !== stat.dev || live.ino !== stat.ino) return false;
    kept = true;
    // Eviction runs only for a path the cache does not already hold: this append's own
    // descriptor is the one being re-cached below, and when its path is the oldest entry
    // the capacity check would close THAT SAME live descriptor and immediately re-cache
    // the closed fd — the next append to the path would then fail fstat with EBADF, abandon
    // the spool, and stall capture on the unlimited blocking SQLite wait although the
    // spool itself was healthy (the reproduced 10.7 s stall after a 16-path cache filled
    // and revisited its oldest entry). A cache hit inserts nothing, so it evicts nothing.
    if (!spoolAppendFds.has(path)) {
      while (spoolAppendFds.size >= SPOOL_APPEND_FD_CACHE_MAX) {
        const oldest = spoolAppendFds.keys().next().value;
        if (oldest === undefined) break;
        closeSpoolAppendFd(oldest, spoolAppendFds.get(oldest) as number);
      }
    }
    spoolAppendFds.set(path, descriptor);
    return true;
  } finally {
    if (!kept) closeSpoolAppendFd(path, descriptor);
  }
}

/** Appends the exact record line to the session's spool, fsynced, and confirms it is the live
 * file's last line; an append that landed in a file the importer rotated away is re-appended (the
 * importer's line-hash dedup makes that exactly-once). False when nothing durable was written —
 * the caller then falls back to the blocking capture wait, so a record is never dropped. */
function spoolCaptureLine(agentDir: string, sessionId: string, line: string): boolean {
  try {
    // The path itself is inside the try: ANY failure to derive a spool path for this session id
    // — however malformed — returns false, so the caller always continues to the blocking
    // no-drop capture instead of throwing the record away.
    const path = spoolFilePath(agentDir, sessionId);
    for (let attempt = 0; attempt < 5; attempt++) if (appendSpoolRecord(path, line)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * One capture: the record, its translation intent, and — when the work already has its projection —
 * the derived projection fold all commit atomically. A crash therefore leaves the record either
 * fully durable with its projection, or absent — never half-captured. A work whose projection is
 * missing (a version bump or a bug lost it, or another process's rebuild is mid-flight) commits
 * the record and its intent with a dirty marker instead, and the next read of that work (the
 * lazy head repair) or the reconciliation pass's recovery rebuilds the projection in bounded
 * slices; the capture's own transaction stays one small write either way.
 *
 * Under a writer held by another process, capture waits only its short busy window, then parks the exact
 * record line in the session's spool (fsynced) and returns normally — callers are void and need no new
 * handling. The in-memory/UI projection lags on that path: the record reaches the ledger, the projection
 * and the outbox when the reconciliation pass's files channel imports the spool exactly once. If the spool
 * itself cannot be written, capture blocks on the writer without a time limit — a frozen session in that
 * rare case is preferred to a lost record. A spooled record is not visible to this process's reads
 * (listWorks, /work details, identity resolution) until the next pass imports it; the alternative — an
 * in-memory overlay merged into every read path — was rejected because those readers are synchronous,
 * hot and numerous, while the spool path only triggers while another process holds the writer.
 */
/** How often a blocked capture reports that it is still waiting. */
const BLOCKED_NOTE_MS = 5000;
/** The spool append's reserve inside the total capture budget: the busy window — and a cold
 *  process's bounded open before it — leaves this much of the 250 ms budget for the fsynced
 *  spool write, so the whole contended return stays inside the 260 ms acceptance bound even
 *  when the append or the open's teardown costs a few extra milliseconds (the round-6 strict
 *  run measured one 266 ms cold sample against the unreserved window). */
const SPOOL_RESERVE_MS = 15;

/** The spool could not be written, so capture blocks on the SQLite writer without a time limit:
 * the record commits once the holder releases the lock and is never dropped. A diagnostic line
 * goes to stderr each time another 5 s elapses (the ledger itself may be the busy resource, so
 * the note cannot go there). Any non-busy error keeps today's behavior and propagates. */
function blockingCaptureCommit(commit: () => void): void {
  // The first expiry notes unconditionally: a busy error means SQLite already waited its full
  // timeout inside the statement, and a clock that lands a few milliseconds short of the note
  // interval must not silence the diagnostic for a whole extra timeout.
  let noted = Date.now() - BLOCKED_NOTE_MS;
  for (;;) {
    try {
      commit();
      return;
    } catch (error) {
      if (!isBusyError(error)) throw error;
      const now = Date.now();
      if (now - noted >= BLOCKED_NOTE_MS) {
        noted = now;
        // Best-effort: a throwing or failed stderr write (a closed stream) must never abort
        // the unlimited retry — the diagnostic is observability, not part of capture's path.
        writeDiagnosticNote(
          "kimchi: the work ledger's writer is busy; capture is blocking until it can commit\n",
        );
      }
    }
  }
}

export function capture(agentDir: string, record: WorkRecord, sourcePath: string | null): void {
  // The total bounded-return budget: planning, the busy wait and the spool append must all
  // fit inside the capture acceptance window (round-6 failure-010: a hoisted plan on a
  // 30 MB head added ~50 ms of parse, merge and serialization ON TOP of the 250 ms busy
  // window and the contended capture returned in 300.888 ms against the 260 ms bound). The
  // busy window below is whatever of the 250 ms budget remains after everything capture
  // did before it, so the whole path stays inside the window however large the plan was.
  const startedAtMs = performance.now();
  // Whatever of the total budget (the busy window minus the spool reserve) remains after
  // everything capture did so far is the window the next bounded step may wait.
  const remainingBudgetMs = (): number =>
    Math.max(
      0,
      CAPTURE_BUSY_TIMEOUT_MS - SPOOL_RESERVE_MS - Math.ceil(performance.now() - startedAtMs),
    );
  const line = JSON.stringify(record);
  const stored: StoredRecord = {
    recordHash: recordHashOf(record),
    type: record.type,
    workId: record.workId,
    sessionId: record.sessionId,
    body: line,
    sourcePath,
    sourceGeneration: 0,
    sourceOffset: null,
    importedAt: Date.now(),
  };
  // The commit's transaction: the insert, the marker and — when the planned fold is still
  // current — the precomputed projection publication. A plan that went stale (another writer
  // committed between the plan's FIRST read and this transaction) is never trusted and never
  // replayed: the record commits first, and the fold is then re-derived from fresh reads
  // inside the lock — but ONLY when the head it would merge onto is itself bounded (the
  // inline fold gate below); an oversized or already-dirty head takes the dirty marker
  // instead, so a competing writer's multi-megabyte publication can never turn this
  // transaction into the round-6 design-006 defect (a 441 ms capture transaction on the
  // reduced-head probe shape). A projection lost to a version bump or a bug is not rebuilt
  // here either way: this commit must stay one small transaction, and a rebuild that ran
  // inside it would hold the write lock across every slice (an outer tryCaptureTx
  // transaction cannot see the slice boundaries). The dirty marker hands the work to the
  // next read's lazy repair or the reconciliation pass's recovery, which rebuild in
  // bounded slices, folding this record with the rest of the authority.
  const commitPlanned = (backend: RecordBackend, planned: PlannedCaptureFold): void => {
    backend.tx(() => {
      // The currency check runs before any write of this transaction: the SQLite backend's
      // dataVersion cannot move for the writes the still-open transaction itself is about to
      // make (the write lock is held and own commits are counted after the transaction ends),
      // so checking first keeps the window exactly the plan's. The version the plan carries is
      // the one sampled BEFORE its first read (planCaptureFold), so any commit inside the
      // plan's read window — a same-work capture, an importer's batch, another process's
      // rebuild — moves the current version off it and the stale plan is never replayed.
      if (!planned.dirty && backend.dataVersion() !== planned.version) {
        backend.insertRecord(stored);
        backend.upsertMarker(stored.recordHash, record.workId, record.type);
        // Re-derive inside the lock ONLY when the head the fold would merge onto is itself
        // bounded: the gate reads the stored body's length without parsing it, so a head a
        // competing writer installed since the plan (a multi-megabyte reduced publication —
        // the round-6 design-006 probe's 441 ms transaction) routes to the dirty marker
        // instead, and a work already marked dirty keeps its marker rather than folding onto
        // a stale head the next read must repair anyway.
        if (
          backendHeadBodyBytes(backend, record.workId) > INLINE_FOLD_MAX_HEAD_BYTES ||
          backend.getHead(record.workId)?.truncated === true ||
          backendHasDirty(backend, record.workId)
        ) {
          backend.markDirty(record.workId);
          return;
        }
        // The bounded re-derivation: parse, merge and republish a head at most
        // INLINE_FOLD_MAX_HEAD_BYTES, reading only the rows this record touches — the same
        // fold capture always ran inside its transaction before the plan was hoisted out.
        foldWork(backend, record.workId, [record]);
        return;
      }
      backend.insertRecord(stored);
      backend.upsertMarker(stored.recordHash, record.workId, record.type);
      if (planned.dirty) {
        backend.markDirty(record.workId);
        return;
      }
      replayPlannedRows(backend, record.workId, planned.writes);
      backend.putHead(planned.head, planned.body);
    });
  };
  const commitInto = (backend: RecordBackend): void => {
    // The plan runs OUTSIDE every transaction (see planCaptureFold); the transaction above only
    // re-checks and writes.
    commitPlanned(backend, planCaptureFold(backend, record));
  };
  // The backend lookup itself is inside the bounded capture path: a cold process whose ledger
  // open (or its construction writes) hits the held writer spools the record like a busy commit
  // would, and on a failed spool blocks on the open and the commit without a time limit.
  let backend: RecordBackend;
  try {
    backend = captureBackendFor(agentDir, remainingBudgetMs());
  } catch (error) {
    if (!isBusyError(error)) throw error;
    if (spoolCaptureLine(agentDir, record.sessionId, line)) return;
    blockingCaptureCommit(() => commitInto(backendFor(agentDir)));
    return;
  }
  if (!backend.tryCaptureTx) {
    commitInto(backend);
    return;
  }
  // The plan is hoisted out of the commit closure so it never runs inside tryCaptureTx's
  // transaction: the whole head merge and serialization stay outside the write lock, and the
  // transaction the closure opens only writes. A busy tryCaptureTx discards the plan with the
  // attempt; the spool and blocking paths re-plan on every retry. The busy wait is bounded by
  // what remains of the total capture budget above, so planning time never pushes the
  // contended return past the acceptance window.
  const planned = planCaptureFold(backend, record);
  const commit = () => commitPlanned(backend, planned);
  const busyMs = remainingBudgetMs();
  if (busyMs > 0 && backend.tryCaptureTx(commit, busyMs)) return;
  if (spoolCaptureLine(agentDir, record.sessionId, line)) return;
  blockingCaptureCommit(() => commitInto(backendFor(agentDir)));
}

/** One journal line handed to the importer; the line bytes are the dedup key (sha256 of the exact line). */
export interface ImportEntry {
  line: string;
  record: WorkRecord;
  sourcePath: string;
  sourceGeneration: number;
  sourceOffset: number;
}

/**
 * One import batch — rows, translation intent and projection fold — to be called inside an open `backend.tx`: the
 * C3 importer wraps rows and the cursor advance in the same transaction, so a kill mid-pass resumes at the cursor.
 * Duplicate lines (same hash) are skipped; the translation marker is upserted only for genuinely new rows. Only
 * NEWLY inserted rows fold into the projection, so a duplicate line re-imported after a file anomaly can never
 * overwrite newer captured state; a missing projection is marked dirty for the bounded sliced repair instead of
 *  being rebuilt inside this transaction.
 */
export function importBatchInTx(backend: RecordBackend, entries: ImportEntry[]): number {
  const insertedByWork = new Map<string, WorkRecord[]>();
  const touched = new Set<string>();
  /** The works that already had records BEFORE this batch: a head missing for one of them was
   *  lost (a version bump, a bug, another process's rebuild between the importer's preflight
   *  and this commit), so the work is marked dirty for the bounded sliced repair — never
   *  rebuilt whole inside this transaction. A work without earlier records is brand new: its
   *  batch rows are its whole authority so far, so folding them creates the same projection
   *  the whole-work rebuild would. */
  const preexisting = new Set<string>();
  for (const workId of new Set(entries.map((entry) => entry.record.workId)))
    if (backend.recordCount(workId) > 0) preexisting.add(workId);
  let inserted = 0;
  for (const entry of entries) {
    touched.add(entry.record.workId);
    const recordHash = createHash("sha256").update(entry.line).digest("hex");
    const stored: StoredRecord = {
      recordHash,
      type: entry.record.type,
      workId: entry.record.workId,
      sessionId: entry.record.sessionId,
      body: JSON.stringify(entry.record),
      sourcePath: entry.sourcePath,
      sourceGeneration: entry.sourceGeneration,
      sourceOffset: entry.sourceOffset,
      importedAt: Date.now(),
    };
    // Only genuinely new rows fold into the projection; a duplicate line (same hash) must never apply its
    // older body over newer captured state.
    if (!backend.insertRecord(stored)) continue;
    inserted++;
    backend.upsertMarker(recordHash, entry.record.workId, entry.record.type);
    let list = insertedByWork.get(entry.record.workId);
    if (!list) {
      list = [];
      insertedByWork.set(entry.record.workId, list);
    }
    list.push(entry.record);
  }
  for (const workId of touched) {
    const records = insertedByWork.get(workId);
    // A duplicate-only batch inserted nothing for this head: there is no new row to fold,
    // and nothing this batch did can have invalidated the head — the importer's own preflight
    // repaired a missing one before the transaction — so the head is left exactly as it is.
    // Marking it dirty anyway (the pre-fix behavior) forced every clean oversized head touched
    // by a duplicate re-import into a full deferred rebuild (design-008).
    if (!records?.length) continue;
    // A projection lost to a version bump, a bug or another process's head removal (the
    // round-5 probe removed it between the importer's preflight rebuild and this batch's
    // commit) is NOT rebuilt here: this whole-work fallback ran the complete authority merge
    // and the head publication inside the caller's transaction — one 969.795 ms transaction
    // on the probe's 1,000-commit/500-links-each shape. A work whose saved head is OVER the
    // inline fold bound — or already dirty, so its head is stale by construction — is never
    // folded inline either (round-6 design-007: a head-intact one-link import on the same
    // probe shape measured a 350 ms transaction parsing, merging and republishing the whole
    // reduced head inside the importer's transaction). All of these mark the work dirty
    // instead, exactly as capture does: the next read of it (the lazy head repair), the next
    // batch's preflight or the reconciliation pass's recovery rebuilds it in bounded slices,
    // folding these records with the rest of the authority; otherwise fold exactly the newly
    // inserted rows.
    if (
      backend.recordCount(workId) > 0 &&
      (backendHasDirty(backend, workId) ||
        backendHeadBodyBytes(backend, workId) > INLINE_FOLD_MAX_HEAD_BYTES ||
        backend.getHead(workId)?.truncated === true ||
        (backendHeadBodyBytes(backend, workId) === 0 && preexisting.has(workId)))
    ) {
      backend.markDirty(workId);
      continue;
    }
    foldWork(backend, workId, records);
  }
  return inserted;
}

/** Replays stored records in capture/import order. */
export function readRecords(
  agentDir: string,
  opts: {
    workId?: string;
    modifiedSince?: number;
    type?: WorkRecord["type"];
  } = {},
  checkBudget?: () => void,
): WorkRecord[] {
  checkBudget?.();
  const records: WorkRecord[] = [];
  for (const row of backendFor(agentDir).readRecords(opts, checkBudget)) {
    checkBudget?.();
    try {
      records.push(JSON.parse(row.body) as WorkRecord);
    } catch {
      // A damaged body cannot happen through capture or import; skip rather than fail every reader.
    }
  }
  return records;
}

/** Repositories in the stored native file-transition history, without decoding complete records. */
export function readTransitionRepositories(agentDir: string): string[] {
  return backendFor(agentDir).readTransitionRepositories();
}

/** No transaction or live iterator crosses a yield; appends beyond the watermark belong to the next read. */
async function readRecordPrefixAsync<T>(
  agentDir: string,
  checkBudget: () => void,
  project: (row: StoredRecord) => T | undefined,
  stretch: () => Promise<void> = () => setImmediate(),
): Promise<T[]> {
  checkBudget();
  const backend = backendFor(agentDir);
  const through = backend.recordWatermark();
  const records: T[] = [];
  let after = 0;
  while (after < through) {
    await stretch();
    checkBudget();
    const page = backend.readRecordPage(after, through, 128, checkBudget);
    if (!page.length) break;
    for (const row of page) {
      checkBudget();
      const value = project(row);
      if (value !== undefined) records.push(value);
    }
    after = page[page.length - 1].position;
  }
  checkBudget();
  return records;
}

/** Retain original capture/import hashes for atomic translation; never hash the reserialized body instead. */
export function readStoredRecordsAsync(
  agentDir: string,
  checkBudget: () => void,
  stretch?: () => Promise<void>,
): Promise<StoredRecord[]> {
  return readRecordPrefixAsync(agentDir, checkBudget, (row) => row, stretch);
}

/**
 * The windowed incremental read. Without STAT4, the planner always prefers a full scan to the
 * imported_at index because `ORDER BY rowid` would force a temp sort — the index must be hinted.
 * The hint is chosen per connection: a ledger opened before the additive index landed (a contended
 * first open defers it) still runs the unhinted scan instead of erroring on the missing index.
 */
export function readRecordsSinceSql(hint: boolean): string {
  return `SELECT ${recordColumnsSql()} FROM work_records ${hint ? "INDEXED BY work_records_imported " : ""}WHERE imported_at >= ? ORDER BY rowid`;
}

function recordColumnsSql(): string {
  return "record_hash AS recordHash, type, work_id AS workId, session_id AS sessionId, body, source_path AS sourcePath, source_generation AS sourceGeneration, source_offset AS sourceOffset, imported_at AS importedAt";
}

/** Probe applied per open; statements prepared after openStore's additive apply see the index. */
export function workRecordsImportedPresent(db: {
  query: <T>(sql: string) => { get: () => T | null | undefined };
}): boolean {
  return (
    db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'work_records_imported'",
      )
      .get() != null
  );
}

/** Parse one stored row for an anchored read; damaged bodies skip, matching the sync reader. */
function windowedRow(row: StoredRecord): WindowedRecord | undefined {
  try {
    return {
      record: JSON.parse(row.body) as WorkRecord,
      hash: row.recordHash,
      importedAt: row.importedAt,
    };
  } catch {
    return undefined;
  }
}

/** The anchored full history, breathing between ledger pages for a caller driving the UI loop. */
export function readRecordsAsync(
  agentDir: string,
  checkBudget: () => void,
  stretch?: () => Promise<void>,
): Promise<WindowedRecord[]> {
  return readRecordPrefixAsync(agentDir, checkBudget, windowedRow, stretch);
}

/** A ledger row with its fixed-size identity anchors: the parsed record, its content hash (the
 * dedup identity — the ledger dedups bodies on it) and its import time (bounds which rows any future
 * window can re-read, so accumulated slack-window sets stay recent-tail-only). */
export interface WindowedRecord {
  record: WorkRecord;
  hash: string;
  importedAt: number;
}

/** The paged windowed read's SQL. The first page's rowid range is the whole table, so it rides the
 * imported index (the same hint discipline as the sync windowed statement); later pages read exact
 * rowid ranges and stay unhinted. */
export function readRecordsSincePageSql(first: boolean): string {
  return `SELECT rowid AS position, ${recordColumnsSql()} FROM work_records ${first ? "INDEXED BY work_records_imported " : ""}WHERE imported_at >= ?${first ? "" : " AND rowid > ?"} AND rowid <= ? ORDER BY rowid LIMIT ?`;
}

/** The incremental window (imported_at >= modifiedSince), paged rowid-cursored for a caller driving
 * the UI loop; appends beyond the pinned watermark belong to the next read, as with the prefix reader. */
export async function readRecordsSinceAsync(
  agentDir: string,
  modifiedSince: number,
  checkBudget: () => void,
  stretch: () => Promise<void> = () => setImmediate(),
): Promise<WindowedRecord[]> {
  checkBudget();
  const backend = backendFor(agentDir);
  const through = backend.recordWatermark();
  const records: WindowedRecord[] = [];
  let after = 0;
  for (;;) {
    await stretch();
    checkBudget();
    const page = backend.readRecordsSincePage(modifiedSince, after, through, 128, checkBudget);
    if (!page.length) break;
    for (const row of page) {
      checkBudget();
      const anchored = windowedRow(row);
      if (anchored !== undefined) records.push(anchored);
    }
    after = page[page.length - 1].position;
  }
  checkBudget();
  return records;
}

/** Changes whenever new records exist; capture-skip logic only needs that much honesty. */
export function fingerprint(agentDir: string): string {
  return String(backendFor(agentDir).recordCount());
}

/** The work's manifest, rebuilt from its records when the projection is missing or marked
 * dirty — in bounded slices, so a large work's lazy repair never runs as one unbounded
 * transaction. The dirty case is the round-6 lesson of correctness-012: a present head whose
 * work carries the dirty marker is STALE by construction (a deferred or invalidated fold
 * landed after it), and serving it silently would leave readers disagreeing with the
 * authority until some unrelated rebuild — so the marker, not the head's presence, decides
 * whether a read repairs. */
export function readWorkHead(agentDir: string, workId: string): WorkHead | undefined {
  const backend = backendFor(agentDir);
  const head = backend.getHead(workId);
  if (head && !backendHasDirty(backend, workId)) return head;
  if (backend.recordCount(workId) === 0) return head;
  rebuildWorkSliced(backend, agentDir, workId);
  return backend.getHead(workId);
}

/** One collection's rows in first-seen order. */
export function readWorkRows(
  agentDir: string,
  workId: string,
  collection: Collection,
): Row[] | undefined {
  if (!readWorkHead(agentDir, workId)) return undefined;
  return backendFor(agentDir).readLog(workId, collection);
}

/** The whole summary view; undefined when the work has no records. */
export function readWorkSummary(agentDir: string, workId: string): WorkSummaryView | undefined {
  if (!readWorkHead(agentDir, workId)) return undefined;
  const backend = backendFor(agentDir);
  const sessions = backend.readLog(workId, "sessions").map((row) => String(row.sessionId));
  const collections = Object.fromEntries(
    COLLECTIONS.map((name) => [name, backend.readLog(workId, name)]),
  );
  return { workId, sessions, ...collections } as WorkSummaryView;
}

/** Every work that has a projection; `/work` discovery reads this fast snapshot instead of
 * directories. A dirty head can be behind authority here: discovery never pays an unbounded
 * rebuild for it, while detail reads through readWorkHead read the repaired head. */
export function listWorks(agentDir: string): { workId: string; head: WorkHead }[] {
  return backendFor(agentDir)
    .allHeads()
    .map((head) => ({ workId: head.workId, head }));
}

/** The reconciliation connection's transaction-duration histogram (bounded-transaction
 * reporting); undefined on backends that do not measure, or before any backend opened. */
export function ledgerTxDurations(agentDir: string): TxDurations | undefined {
  return backends.get(agentDir)?.txDurations?.();
}

/** Zeroes the agent directory's histogram, scoping the next report to one pass; a directory
 * with no open backend yet has nothing to reset — opening one is a write path the pass's fence
 * must gate, so this never forces it. */
export function resetLedgerTxDurations(agentDir: string): void {
  backends.get(agentDir)?.resetTxDurations?.();
}

/** Refolds every work marked dirty; startup recovery and projection-version bumps land here. */
export function recoverDirty(agentDir: string): void {
  const backend = backendFor(agentDir);
  const dirty = backend.dirtyWorks();
  if (!dirty.length) return;
  for (const workId of dirty) rebuildWorkSliced(backend, agentDir, workId);
}

/** Deletes the work's projection and refolds it from its records; the authority is never touched. */
export function rebuildWork(agentDir: string, workId: string): void {
  const backend = backendFor(agentDir);
  rebuildWorkSliced(backend, agentDir, workId);
}

/** Rebuild slice sizing per agent directory: one sizer persists across passes, AIMD on measured
 * transaction duration. The start is a bounded cold-start size (the first transaction after a
 * process restart is already split); growth climbs back toward the historic whole-work rebuild. */
const rebuildSizers = new Map<string, TxChunkSizer>();
const REBUILD_SLICE_START = 1_000;
const REBUILD_SLICE_MAX = 100_000;
/** The ownership-generation note: each sliced rebuild's clear writes its unique generation, and
 * its publication requires that same generation — a competing rebuild (another process's lazy
 * repair, an importer's missing-projection rebuild) that cleared or replaced the projection
 * mid-fold is detected at publish time, and this rebuild restarts instead of publishing a
 * partial, clean-looking projection over the other's clear. */
const REBUILD_OWNERSHIP_NOTE = "__rebuild-ownership";
/** Publication retries before giving up on this rebuild attempt. Each failed publication
 * folded only the delta that landed since the last fold, in bounded slices outside the write
 * lock; a budget exhausted while the population still moving abandons the publication — the
 * headless-dirty state every reader and the next pass repair — rather than folding an
 * arbitrarily large arrival delta inside one outer transaction. */
const REBUILD_PUBLISH_RETRY_LIMIT = 8;
/** Whole restarts tolerated against a competing rebuild before this rebuild gives up: it
 * publishes nothing (no head, dirty marker intact — the state every reader and the next pass
 * repair) rather than spinning forever against an equally determined other writer. */
const REBUILD_RESTART_LIMIT = 8;
/** The largest head body the publication transaction may write: the SQLite put of a body at
 *  this bound measures ~100 ms idle and ~180 ms under the loaded full-suite runner on the
 *  CI-pinned Bun 1.4.0 — both inside the 250 ms ceiling (a first calibration at 48 MiB put
 *  ~150 ms idle and measured 272 ms loaded) — while the 200,000-link acceptance shape
 *  (~29 MB) stays below it and publishes whole. A merged head above the bound is PUBLISHED
 *  REDUCED — the newest PR links up to the bound, with an explicit `truncated` marker in the
 *  head object — never deferred: a recorded work must never become unreadable, and the full
 *  link set stays in the authority rows every rebuild refolds. */
const HEAD_PUBLISH_MAX_BYTES = 32 * 1024 * 1024;
/** The largest saved-head body a capture or import transaction may parse, merge and republish
 *  INLINE. A head over this bound is not touched by the incremental fold at all: the fold's
 *  merge and serialization are O(head) even when its row reads are O(new records), so a
 *  multi-megabyte head turns the fold's transaction into a multi-hundred-millisecond head put
 *  (the round-6 probes: a 441 ms capture transaction and a 350 ms import batch on the
 *  reduced-head shape). Oversized works defer instead — the record, its marker and the dirty
 *  marker commit alone, and the bounded rebuild (the lazy repair or the pass's recovery)
 *  owns the head derivation with its capped publication — while every ordinary work (heads in
 *  the kilobytes) keeps today's immediate fold. Reads stay correct because a dirty work is
 *  repaired by its next read (readWorkHead), never served its stale head silently. */
const INLINE_FOLD_MAX_HEAD_BYTES = 4 * 1024 * 1024;
/** Once a full head exceeds HEAD_PUBLISH_MAX_BYTES and must be reduced, cap its reduced
 *  write as well. Only the derived head loses links; authority rows keep all of them. */
const REDUCED_PUBLICATION_MAX_BYTES = INLINE_FOLD_MAX_HEAD_BYTES;
/** Record body bytes the whole-work rebuild's single atomic transaction may cover. The
 *  branch is otherwise chosen by record count alone, and a count-sized work can still merge
 *  to an arbitrarily large projection (the reviewed probe: 1,000 commit records carrying
 *  500 links each published a 76 MB head and its rows in one 1,638 ms transaction). A work
 *  over this bound runs the sliced rebuild instead, whose folds and publication are each
 *  bounded; a work under it stays one atomic transaction exactly as before. */
const WHOLE_WORK_REBUILD_MAX_BYTES = 4 * 1024 * 1024;
/** Record body bytes one fold transaction may write. The sliced rebuild's fold pages are
 *  sized by record count, and a count-sized page of link-heavy records can still write tens
 *  of megabytes of projection rows in one transaction; the fold therefore batches the page's
 *  records by the bytes it is about to write (a single record is atomic and never split),
 *  keeping every fold transaction inside the plan's ceiling even on a cold, unsized start. */
const FOLD_TX_MAX_BYTES = 2 * 1024 * 1024;

/** The head as it may be published: the serialization is precomputed OUTSIDE the write lock
 *  (the publication transaction only writes), and a merged body above HEAD_PUBLISH_MAX_BYTES
 *  is REDUCED rather than deferred — the newest links up to the bound with an explicit
 *  `truncated` marker, so the work keeps a readable head instead of a permanent headless
 *  state (data safety outranks the transaction ceiling). The `truncated` field is additive:
 *  an older release parsing the body simply ignores it. */
function headForPublication(head: WorkHead): { head: WorkHead; body: string } {
  const whole = JSON.stringify(head);
  if (Buffer.byteLength(whole) <= HEAD_PUBLISH_MAX_BYTES) return { head, body: whole };
  // Reduced publication: rank the merged links newest-first (by checkedAt, ties and missing
  // timestamps by first-seen order) and keep the newest that fit the budget. The kept links
  // keep their original relative order, so a reader sees a prefix-consistent subsequence of
  // the merged set, and the authority's commit rows still hold every link for a rebuild.
  const ranked = head.pullRequests
    .map((link, index) => ({
      index,
      bytes: Buffer.byteLength(JSON.stringify(link)),
      at: typeof link.checkedAt === "string" ? Date.parse(link.checkedAt) : Number.NaN,
    }))
    .sort(
      (a, b) =>
        (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0) ||
        a.index - b.index,
    );
  const base = JSON.stringify({ ...head, truncated: true, pullRequests: [] });
  // The base carries every other field; the budget is what remains for the links themselves
  // (the separators and the marker's few bytes stay inside the slack).
  const budget = REDUCED_PUBLICATION_MAX_BYTES - Buffer.byteLength(base) - 64;
  const taken: number[] = [];
  let bytes = 0;
  for (const item of ranked) {
    if (bytes + item.bytes > budget) continue;
    taken.push(item.index);
    bytes += item.bytes + 1;
  }
  for (;;) {
    const kept = [...taken].sort((a, b) => a - b).map((index) => head.pullRequests[index]);
    const reduced: WorkHead = { ...head, truncated: true, pullRequests: kept };
    const body = JSON.stringify(reduced);
    // The accounting above is exact up to the slack, so this normally publishes on the first
    // pass; a body still over the bound drops the oldest taken link and reserializes, and a
    // base that is itself over the bound (structurally impossible — logs and latest are
    // counters) publishes anyway: a readable head outranks the budget.
    if (Buffer.byteLength(body) <= HEAD_PUBLISH_MAX_BYTES || !taken.length) {
      writeDiagnosticNote(
        "kimchi: a work's projection head exceeded the publication budget; it was published reduced, keeping the newest PR links\n",
      );
      return { head: reduced, body };
    }
    taken.pop();
  }
}

/** Folds every record page in (after, through] into `rows`, parsing damaged bodies away. */
function foldWorkRecordPages(
  backend: RecordBackend,
  workId: string,
  rows: SummaryRows,
  after: number,
  through: number,
  readLimit: number,
  sizer?: TxChunkSizer,
): number {
  let position = after;
  let limit = readLimit;
  for (;;) {
    const page = backend.readWorkRecordPage(workId, position, through, limit);
    if (!page.length) return position;
    // The page's records fold in BYTE-BATCHED transactions: a record-count-sized page of
    // link-heavy records would otherwise write its whole merged projection in one
    // transaction (the reviewed probe: one 1,000-record page carried 76 MB of rows). A
    // single record is an atomic unit and never splits across transactions.
    let batch: WorkRecord[] = [];
    let bytes = 0;
    const fold = () => {
      if (!batch.length) return;
      backend.tx(() => mergeRecordsInto(rows, batch));
      const last = backend.txDurations?.().lastMs;
      if (last !== undefined) sizer?.observe(last);
      batch = [];
      bytes = 0;
    };
    for (const row of page) {
      let record: WorkRecord;
      try {
        record = JSON.parse(row.body) as WorkRecord;
      } catch {
        // Skip damaged bodies; rebuild must not fail because one row is unreadable.
        continue;
      }
      if (bytes && bytes + row.body.length > FOLD_TX_MAX_BYTES) fold();
      batch.push(record);
      bytes += row.body.length;
    }
    fold();
    if (page.length < limit) return page[page.length - 1].position;
    position = page[page.length - 1].position;
    limit = sizer ? sizer.size() : limit;
  }
}

/** Sliced rebuild: while the work's records fit one slice, the whole rebuild stays one
 * transaction — rows, head and the dirty-marker clear commit together exactly as before. Once
 * the slice size sits below the work's record count, the rebuild runs as bounded units only:
 * the head leaves first (with the dirty marker and this rebuild's ownership generation) so a
 * kill mid-clear leaves a headless work every reader repairs, the old rows drain in bounded
 * chunks, the records fold in adaptively sized slices (the head's counters live in memory
 * across slices, and only the final transaction publishes the head), and a kill mid-rebuild
 * leaves a work with rows but no head — never a partially published head.
 *
 * A capture on this work that commits during the rebuild is not in the folded pages when it
 * lands above the pinned watermark: publishing anyway would erase its projection row and clear
 * the dirty marker. The population is therefore always read BEFORE the watermark it publishes
 * against: if the publication transaction re-checks the work's record count inside the write
 * lock and finds it unchanged, every record was already folded (an unchanged count means no
 * same-work insert since before the watermark read). A moved count no longer restarts the
 * whole rebuild: only the delta above the folded watermark is folded — in slices again — and
 * the publication retried, so a continuously capturing session cannot make the rebuild redo
 * its work or fall back to an unbounded transaction. After REBUILD_PUBLISH_RETRY_LIMIT retries
 * with the population still moving, the rebuild abandons publication and returns: the work
 * keeps its headless-dirty state, which every reader's lazy repair and the next pass rebuild
 * in bounded slices — no transaction ever folds an unbounded arrival delta. A competing rebuild
 * is detected through the ownership generation instead: its clear replaced the note, so this
 * rebuild restarts whole — and after REBUILD_RESTART_LIMIT such restarts gives up without
 * publishing, leaving the repairable headless state rather than a partial projection. */
export function rebuildWorkSliced(backend: RecordBackend, agentDir: string, workId: string): void {
  const sizer = rememberSizer(rebuildSizers, agentDir, () =>
    createTxChunkSizer(REBUILD_SLICE_START, 1, REBUILD_SLICE_MAX),
  );
  const observe = () => {
    const last = backend.txDurations?.().lastMs;
    if (last !== undefined) sizer?.observe(last);
  };
  for (let restarts = 0; ; restarts++) {
    // The work's own population, read before the watermark: the pinned pages cover everything
    // the watermark includes, and only a write to this work moves the count before the
    // publication re-check below.
    const population = backend.recordCount(workId);
    const through = backend.recordWatermark();
    const limit = sizer.size();
    // The single-transaction path is chosen by record count AND the authority's stored bytes,
    // so a fitting work never pages (and never re-reads) the authority the transaction below
    // refolds anyway — while a count-sized work whose records merge to a large projection
    // (link-heavy commits) runs the sliced rebuild instead of one unbounded transaction.
    if (
      backend.recordCount(workId) <= limit &&
      backend.recordBytes(workId) <= WHOLE_WORK_REBUILD_MAX_BYTES
    ) {
      backend.prepareHeadPublication?.(backend.recordBytes(workId));
      backend.tx(() => rebuildWorkInTx(backend, workId));
      observe();
      return;
    }
    if (restarts >= REBUILD_RESTART_LIMIT) return;
    const generation = randomUUID();
    // `latest` and `pullRequests` are maintained incrementally while the records fold (the
    // projection-rows hook observes each written row), so the publication transaction never
    // scans the whole work's logs to derive them. The commit rows are kept per row key — the
    // hook overwrites each key's entry with its latest written version, exactly the rows the
    // projection stores (`putRow` upserts one row per key) and the whole-work rebuild and the
    // capture fold read back through `readLog` — instead of accumulating every intermediate
    // version: a commit observed many times (each observation carrying its own PR links) is
    // merged once from its final row, not rescanned version by version inside the publication
    // transaction.
    const head = emptyHead(workId);
    const commits = new Map<string, Row>();
    const rows = projectionRows(backend, head, (collection, row) => {
      observeLatest(head.latest, collection, row);
      if (collection === "commits") commits.set(ROW_KEYS.commits(row), row);
    });
    backend.tx(() => {
      // The head leaves with the dirty marker and this rebuild's ownership generation: a kill
      // anywhere after this transaction leaves the headless-but-dirty state readers repair.
      backend.clearProjectionHead(workId);
      backend.markDirty(workId);
      backend.putNote(workId, REBUILD_OWNERSHIP_NOTE, generation);
    });
    observe();
    // The old projection rows drain in bounded chunks: deleting them all in the transaction
    // above would make the clear itself an unbounded write for a huge work. The chunk size is
    // re-read from the sizer each round, so cheap deletions grow the chunks instead of paying
    // one transaction per row after the sizer has shrunk.
    for (;;) {
      let deleted = 0;
      backend.tx(() => {
        deleted = backend.deleteProjectionRows(workId, sizer.size());
      });
      observe();
      if (!deleted) break;
    }
    const foldedThrough = foldWorkRecordPages(
      backend,
      workId,
      rows,
      0,
      through,
      sizer.size(),
      sizer,
    );
    let expected = population;
    let publishedThrough = through;
    for (let attempts = 0; ; attempts++) {
      let published = false;
      let foreign = false;
      // The merged PR summary is a pure function of the commit rows folded so far, and it is
      // O(distinct commit rows + links): it is computed OUTSIDE the write lock, just before
      // each publication attempt, so the transaction below stays one small write — a work of
      // many distinct commits otherwise pays its whole summary merge inside the publication
      // transaction (the reviewed probe measured 323 ms for 200k distinct commit rows). A
      // failed attempt re-folds the delta first, so the next attempt's merge sees every row.
      const pullRequests = commitPullRequests(commits.values());
      // The head's serialization is also precomputed OUTSIDE the write lock, so the
      // publication transaction only writes — and the body's size is the bound on that write:
      // a merged head above the publication budget is PUBLISHED REDUCED (the newest links up
      // to the bound, an explicit `truncated` marker; the authority rows keep every link), so
      // the work always keeps a readable head and the transaction stays one small write.
      const { head: publishable, body } = headForPublication({
        ...head,
        updatedAt: new Date().toISOString(),
        pullRequests,
      });
      backend.prepareHeadPublication?.(Buffer.byteLength(body));
      backend.tx(() => {
        if (backend.getNote(workId, REBUILD_OWNERSHIP_NOTE) !== generation) {
          foreign = true;
          return;
        }
        // Publication requires the work's population unchanged since it was read before the
        // folded watermark: an unchanged count proves every record was already folded. The
        // write lock is held for the whole transaction, so nothing can move while it runs, and
        // the transaction itself stays one small write — it never folds records.
        if (backend.recordCount(workId) !== expected) return;
        backend.putHead(publishable, body);
        backend.clearDirty(workId);
        backend.deleteNote(workId, REBUILD_OWNERSHIP_NOTE);
        published = true;
      });
      observe();
      if (published) return;
      if (foreign) break;
      // The retry budget is exhausted while the population still moves: converge with bounded
      // transactions only — the delta that arrived during the retries has just been folded in
      // slices OUTSIDE the write lock, and the attempt above published only if the population
      // held still. A capture that landed during that last fold leaves the headless-dirty state
      // every reader and the next pass repair (abandon-and-repair) instead of folding an
      // arbitrarily large arrival delta inside one outer transaction.
      if (attempts >= REBUILD_PUBLISH_RETRY_LIMIT) return;
      // A same-work capture landed since the population was read: fold only the new delta —
      // the population is re-read BEFORE the watermark so the same invariant covers the next
      // publication attempt — and retry.
      expected = backend.recordCount(workId);
      const deltaThrough = backend.recordWatermark();
      foldWorkRecordPages(
        backend,
        workId,
        rows,
        publishedThrough,
        deltaThrough,
        sizer.size(),
        sizer,
      );
      publishedThrough = deltaThrough;
    }
  }
}

function rebuildWorkInTx(backend: RecordBackend, workId: string): void {
  backend.clearProjection(workId);
  // A fresh ownership generation rides the clear: a concurrent sliced rebuild detects this
  // whole-work rebuild's interference at its own publication and restarts instead of
  // publishing over rows this transaction replaced. This rebuild is atomic, so it never needs
  // to check the note itself.
  backend.putNote(workId, REBUILD_OWNERSHIP_NOTE, randomUUID());
  const records: WorkRecord[] = [];
  for (const row of backend.readRecords({ workId })) {
    try {
      records.push(JSON.parse(row.body) as WorkRecord);
    } catch {
      // Skip damaged bodies; rebuild must not fail because one row is unreadable.
    }
  }
  const head = emptyHead(workId);
  // `latest` and `pullRequests` are maintained incrementally while the records fold — the
  // same reference semantics the sliced rebuild's publication and the capture fold use — so
  // this transaction never rescans the work's logs to derive them, and its head publication
  // is precomputed and budget-capped like every other publication path (a body above the
  // bound publishes reduced with the `truncated` marker instead of one unbounded put).
  const commits = new Map<string, Row>();
  mergeRecordsInto(
    projectionRows(backend, head, (collection, row) => {
      observeLatest(head.latest, collection, row);
      if (collection === "commits") commits.set(ROW_KEYS.commits(row), row);
    }),
    records,
  );
  const { head: publishable, body } = headForPublication({
    ...head,
    updatedAt: new Date().toISOString(),
    pullRequests: commitPullRequests(commits.values()),
  });
  backend.putHead(publishable, body);
  backend.clearDirty(workId);
}

/** One row write a planned fold recorded outside the write lock, for replay inside the
 *  transaction that publishes it. */
interface PlannedRowWrite {
  log: LogName;
  key: string;
  row: Row;
  pos: number;
}

/** A capture's planned fold: either a full fold (the merged head, its serialized publication
 *  body and the row writes the transaction replays once the plan is confirmed current) or the
 *  deferred shape, which never touches the head at all — the record, its marker and the
 *  dirty marker commit alone and the bounded rebuild owns the head derivation. `dirty` marks
 *  every deferred case: a missing projection, an oversized saved head, or a work already
 *  carrying the dirty marker. */
type PlannedCaptureFold =
  | { dirty: true; version: number; head?: undefined; body?: undefined; writes?: undefined }
  | {
      dirty: false;
      /** The database version the plan was made against; the transaction replays it only when
       *  nothing committed in between (any commit — a same-work capture, an importer's batch,
       *  another process's rebuild — could have moved the rows, counters or head the plan
       *  derived from). */
      version: number;
      head: WorkHead;
      body: string;
      writes: PlannedRowWrite[];
    };

/** The capture fold's plan, computed OUTSIDE every transaction: the head's merge (counters,
 *  `latest`, the incrementally merged PR summary) and the publication body — the expensive
 *  parts on a large head — never run under the write lock, so the capture's transaction stays
 *  one small write even on a work whose head is a multi-megabyte reduced publication (the
 *  round-5 probe measured an 898 ms capture transaction when the fold rescanned every commit
 *  row and serialized the whole head inside it). The plan's version stamp is sampled BEFORE
 *  its first read, so the plan can never carry a version newer than the reads it derived
 *  from (round-6 correctness-012/failure-009: a version sampled after the reads absorbed a
 *  competing capture into the stamp without its rows, and the publication check accepted
 *  the stale plan). A work whose saved head is OVER the inline fold bound — or already dirty,
 *  so its head is stale by construction — never plans a fold at all: capture commits only the
 *  record, its marker and the dirty marker (O(new records), no head parse, merge or
 *  serialization anywhere on the path), and the head derivation stays with the bounded
 *  rebuild (the lazy repair or the pass's recovery), whose publication is capped exactly as
 *  every head publication is (round-6 design-006/failure-010/correctness-014: a 30 MB head
 *  made the plan itself ~50 ms and its transaction a 316–653 ms put). */
function planCaptureFold(backend: RecordBackend, record: WorkRecord): PlannedCaptureFold {
  // The version stamp precedes every read the plan derives from. Anything committing after
  // this sample — but before the transaction — moves the current version off the stamp and
  // the transaction takes the stale path instead of replaying the plan.
  const version = backend.dataVersion();
  // The oversize/dirty gate reads only the stored body's byte length and the dirty marker:
  // neither parses the head, so even a 30 MB head costs microseconds to route around.
  if (
    backendHeadBodyBytes(backend, record.workId) > INLINE_FOLD_MAX_HEAD_BYTES ||
    backendHasDirty(backend, record.workId)
  )
    return { dirty: true, version };
  const saved = backend.getHead(record.workId);
  // A truncated projection is partial: future captures must converge through the bounded
  // rebuild, not treat its compact encoding as complete authority.
  if (saved?.truncated === true) return { dirty: true, version };
  if (!saved && backend.recordCount(record.workId) > 0) return { dirty: true, version };
  const plan = planFold(backend, saved ?? emptyHead(record.workId), [record]);
  // A fold that cannot order its PR observations the way the rebuild would never publishes:
  // the work takes the dirty marker exactly as the oversize/dirty cases above, and the bounded
  // rebuild owns the head derivation.
  if (plan.ambiguous) return { dirty: true, version };
  return {
    dirty: false,
    version,
    head: plan.head,
    body: plan.body,
    writes: plan.writes,
  };
}

/** Replays a planned fold's row writes inside the transaction that publishes it. */
function replayPlannedRows(
  backend: RecordBackend,
  workId: string,
  writes: PlannedRowWrite[],
): void {
  for (const write of writes) backend.putRow(workId, write.log, write.key, write.row, write.pos);
}

/** Folds records into a COPY of the head without writing anything: the row writes are
 *  recorded for replay inside a transaction, `latest` is observed on the copy, and the merged
 *  PR summary is maintained INCREMENTALLY — the touched commit rows' final links merge into
 *  the head's existing summary — so the fold never rescans every commit row of a large work
 *  (a capture on a 2,000 × 250-link work paid a 76 MB row rescan inside its transaction). The
 *  incremental merge equals the full rescan the rebuild performs for every pair the merge's
 *  rank order can separate: every commit row only ever accumulates links (an empty or failed
 *  lookup never removes one), so the union of the head's summary and the touched rows' merged
 *  links is the same merged set `commitPullRequests` derives from every row. The one exception
 *  is `ambiguous`: the head's summary and a touched row hold two observations of one alias the
 *  rank order cannot separate (equal checkedAt, equal identity strength, differing content),
 *  so the merged entry depends on the fold's grouping order — head first — where the rebuild
 *  uses row order (correctness-013: capture published `merged`, rebuildWork `closed`, from the
 *  same final rows). The fold never picks a winner inline; the caller marks the work dirty and
 *  the bounded rebuild publishes the head. The serialized publication body is computed here too,
 *  so the caller can keep the whole derivation outside the write lock. */
function planFold(
  backend: RecordBackend,
  head: WorkHead,
  records: WorkRecord[],
): { head: WorkHead; body: string; writes: PlannedRowWrite[]; ambiguous: boolean } {
  const merged: WorkHead = {
    ...head,
    logs: Object.fromEntries(Object.entries(head.logs).map(([name, log]) => [name, { ...log }])),
    latest: { ...head.latest },
  };
  const writes: PlannedRowWrite[] = [];
  const commits = new Map<string, Row>();
  mergeRecordsInto(
    projectionRows(
      backend,
      merged,
      (collection, row) => {
        observeLatest(merged.latest, collection, row);
        if (collection === "commits") commits.set(ROW_KEYS.commits(row), row);
      },
      (log, key, row, pos) => writes.push({ log, key, row, pos }),
    ),
    records,
  );
  if (commits.size) {
    const rowLinks = [...commits.values()].map((row) =>
      Array.isArray(row.pullRequests) ? row.pullRequests.filter(object) : [],
    );
    // The head's summary and the touched rows hold conflicting observations the rank order
    // cannot separate: the merged entry would depend on this fold's grouping order, not the
    // rebuild's row order. Report it instead of merging; the caller defers to the rebuild.
    if (pullRequestFoldAmbiguous(merged.pullRequests, rowLinks))
      return { head: merged, body: "", writes, ambiguous: true };
    merged.pullRequests = mergePullRequestLinks(merged.pullRequests, ...rowLinks);
  }
  const { head: publishable, body } = headForPublication({
    ...merged,
    updatedAt: new Date().toISOString(),
  });
  return { head: publishable, body, writes, ambiguous: false };
}

/** Folds records into the saved head like the journal-era summary writer: only the rows they touch are read.
 *  A fold whose PR observations the merge cannot order the way the rebuild does (ambiguous)
 *  publishes nothing: the work takes the dirty marker, and the bounded rebuild — the next
 *  read's lazy repair or the pass's recovery — publishes the head from every row in one
 *  deterministic order. */
function foldWork(backend: RecordBackend, workId: string, records: WorkRecord[]): void {
  const head = backend.getHead(workId) ?? emptyHead(workId);
  const plan = planFold(backend, head, records);
  if (plan.ambiguous) {
    backend.markDirty(workId);
    return;
  }
  replayPlannedRows(backend, workId, plan.writes);
  // The publication is capped like every other head write: a capture folding onto an already
  // reduced head merges incrementally, and a body above the budget publishes reduced again
  // (the `truncated` marker) instead of one unbounded put inside the capture transaction.
  backend.putHead(plan.head, plan.body);
}

function emptyHead(workId: string): WorkHead {
  return {
    version: 2,
    workId,
    updatedAt: "",
    logs: {},
    latest: {},
    pullRequests: [],
  };
}

/**
 * Projection writes for one head. Each log's row count and size continue from the head, so writing a row never
 * rereads the rest of the work; only non-empty logs appear in the manifest, as legacy readers expect.
 */
function projectionRows(
  backend: RecordBackend,
  head: WorkHead,
  onSet?: (collection: Collection, row: Row) => void,
  write: (log: LogName, key: string, row: Row, pos: number) => void = (log, key, row, pos) =>
    backend.putRow(head.workId, log, key, row, pos),
): SummaryRows {
  const { workId, logs } = head;
  /** Stored size of each row this fold has seen; undefined while the key is new. */
  const sizes = new Map<string, number | undefined>();
  const get = (log: LogName, key: string) => {
    const row = backend.getRow(workId, log, key);
    sizes.set(`${log}\u0000${key}`, row && Buffer.byteLength(JSON.stringify(row)));
    return row;
  };
  const put = (log: LogName, key: string, row: Row) => {
    const id = `${log}\u0000${key}`;
    if (!sizes.has(id)) get(log, key);
    const previous = sizes.get(id);
    const bytes = Buffer.byteLength(JSON.stringify(row));
    logs[log] ??= { generation: 1, bytes: 0, rows: 0 };
    const meta = logs[log];
    if (previous === undefined) {
      meta.rows++;
      meta.bytes += bytes + 1;
    } else meta.bytes += bytes - previous;
    write(log, key, row, meta.rows);
    sizes.set(id, bytes);
  };
  const sessions = {
    add(sessionId: string) {
      const key = ROW_KEYS.sessions({ sessionId });
      // A repeated session in one planned batch is already queued, though not visible to get().
      if (!sizes.has(`sessions\u0000${key}`)) put("sessions", key, { sessionId });
    },
  };
  const store = (name: Collection) => ({
    get: (key: string) => get(name, key),
    has: (key: string) => get(name, key) !== undefined,
    // Merge output always carries sessionId, the one field Row demands beyond its index signature.
    set: (key: string, row: Record<string, unknown>) => {
      put(name, key, row as Row);
      onSet?.(name, row as Row);
    },
  });
  return {
    sessions,
    ...Object.fromEntries(COLLECTIONS.map((name) => [name, store(name)])),
  } as SummaryRows;
}

/** Tracker bookkeeping (cost caches, issue, intent, scope, progress) as named JSON notes per work. */
export function getNote(agentDir: string, workId: string, name: string): string | undefined {
  return backendFor(agentDir).getNote(workId, name);
}

export function hasNote(agentDir: string, workId: string, name: string): boolean {
  return backendFor(agentDir).hasNote(workId, name);
}

/** Unchanged bodies are not rewritten, mirroring the old writeChanged helper. */
export function setNote(agentDir: string, workId: string, name: string, body: string): void {
  const backend = backendFor(agentDir);
  if (backend.getNote(workId, name) === body) return;
  backend.putNote(workId, name, body);
}

export function diagnostic(agentDir: string, code: string): void {
  backendFor(agentDir).diagnostic(code);
}

/** Whole-view seeding for legacy fixture suites: inserts every session and collection row of the view. */
export function seedProjectionRows(agentDir: string, view: WorkSummaryView): void {
  const backend = backendFor(agentDir);
  backend.tx(() => {
    const head = backend.getHead(view.workId) ?? emptyHead(view.workId);
    const rows = projectionRows(backend, head);
    for (const sessionId of view.sessions) rows.sessions.add(sessionId);
    for (const collection of COLLECTIONS)
      for (const row of view[collection] ?? [])
        rows[collection].set(ROW_KEYS[collection](row), row);
    backend.putHead({
      ...head,
      updatedAt: new Date().toISOString(),
      ...summaryLatest((collection) => backend.readLog(view.workId, collection)),
    });
  });
}

/** Timeout-free capture/read of one session's records, used by `getWorkId` identity resolution. */
export function ledgerSessionInfo(
  agentDir: string,
  sessionId: string,
): { work: WorkRecord | undefined; recordCount: number } {
  const rows = backendFor(agentDir).readRecords({ sessionId });
  const last = rows.filter((row) => row.type === "work").at(-1);
  return {
    work: last ? (JSON.parse(last.body) as WorkRecord) : undefined,
    recordCount: rows.length,
  };
}

/** True when the work's projection has plan or commit rows (what /work lists as output evidence). */
export function ledgerHasWorkOutput(agentDir: string, workId: string): boolean {
  return backendFor(agentDir).hasProjectionOutput(workId);
}

/** The production backend over the C1 store; a failed construction never leaks the connection. */
function sqliteBackend(agentDir: string): RecordBackend {
  const store: LedgerStore = openStore(agentDir);
  try {
    return sqliteBackendFor(store);
  } catch (error) {
    store.close();
    throw error;
  }
}

/** Capture's cold open: bounded by the capture busy window, with the optional additive-schema
 *  apply deferred (the windowed read heals it lazily) and no open-retry budget, so the whole
 *  lookup fits inside the window tryCaptureTx commits within. The connection's normal busy
 *  timeout is restored once construction succeeded — a cached backend is a general ledger
 *  connection, not a capture-only one. */
function captureSqliteBackend(agentDir: string, busyMs: number): RecordBackend {
  const store: LedgerStore = openStore(agentDir, {
    busyTimeoutMs: Math.max(0, Math.min(busyMs, CAPTURE_BUSY_TIMEOUT_MS)),
    openRetryBudgetMs: 0,
    deferAdditiveSchema: true,
  });
  try {
    const backend = sqliteBackendFor(store);
    store.db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    return backend;
  } catch (error) {
    store.close();
    throw error;
  }
}

/** Drains one statement page to completion. Bun 1.4 leaves an interrupted iterator's cursor positioned
 * mid-result; get() resets before and after one row, so every page drain funnels through here. */
function drainStatementPage<T, A extends unknown[]>(
  page: { iterate: (...args: A) => Iterable<T>; get: (...args: A) => unknown },
  args: A,
  checkBudget?: () => void,
): T[] {
  const rows: T[] = [];
  try {
    for (const row of page.iterate(...args)) {
      checkBudget?.();
      rows.push(row);
    }
  } catch (error) {
    page.get(...args);
    throw error;
  }
  return rows;
}

const OUTBOX_CLAIM_COLUMNS =
  "id, account_key AS accountKey, entity_id AS entityId, kind, body, hash, created_at AS createdAt, acked_at AS ackedAt, blocked";

/**
 * One row per account with outbox events or batches. The few distinct account keys are reached by seeking the
 * outbox_pending index from one key to the next, so the cost follows the number of accounts, not the number of
 * events; the sendable probe is covered by outbox_pending_cover (account_key, acked_at, blocked) and the
 * first-batch lookup by outbox_batches_by_account (account_key, order_key, created_at).
 */
export const OUTBOX_DELIVERY_STATUS_SQL = `
	WITH RECURSIVE event_accounts(account_key) AS (
		SELECT (SELECT MIN(account_key) FROM outbox_events)
		UNION ALL
		SELECT (SELECT MIN(account_key) FROM outbox_events WHERE account_key > event_accounts.account_key)
		FROM event_accounts WHERE event_accounts.account_key IS NOT NULL
	)
	SELECT a.account_key AS accountKey,
		EXISTS(SELECT 1 FROM outbox_events e
			WHERE e.account_key = a.account_key AND e.acked_at IS NULL AND e.blocked = '') AS sendable,
		EXISTS(SELECT 1 FROM outbox_batches b WHERE b.account_key = a.account_key) AS hasBatch,
		(SELECT id FROM outbox_batches WHERE account_key = a.account_key
			ORDER BY order_key, created_at, rowid LIMIT 1) AS firstBatchId
	FROM (
		SELECT account_key FROM event_accounts WHERE account_key IS NOT NULL
		UNION SELECT account_key FROM outbox_batches
	) a
	ORDER BY a.account_key
`;

/** Pins the selective entity index; otherwise SQLite scans a whole account and sorts it per page. */
export function outboxClaimsSql(entityPlaceholders: readonly string[], paged: boolean): string {
  return `SELECT ${paged ? "rowid AS position, " : ""}${OUTBOX_CLAIM_COLUMNS} FROM outbox_events INDEXED BY outbox_entity WHERE account_key = ? AND entity_id IN (${entityPlaceholders.join(",")})${paged ? " AND rowid > ? ORDER BY rowid LIMIT ?" : " ORDER BY rowid"}`;
}

/** Cursor lookup keeps raw and realpath aliases interchangeable on the pinned journal tree.
 *  A removed path keeps its literal identity rather than losing the row to realpath failure. */
export function journalCursorLookupPath(path: string): string {
  try {
    return pinAgentDir(path);
  } catch {
    return path;
  }
}

function sqliteBackendFor(store: LedgerStore): RecordBackend {
  const db = store.db;
  if (ensureProjectionVersion(store)) {
    // Backend construction is reached from inside a fenced pass's context in the worker, so
    // this maintenance write rides the store's (fence-checked) transaction like every other.
    store.tx(() =>
      db
        .query(
          "INSERT OR IGNORE INTO work_dirty (work_id) SELECT DISTINCT work_id FROM work_records",
        )
        .run(),
    );
  }
  const insertRecord = db.query(
    // Targeted duplicate-hash no-op: any other integrity error surfaces and rolls the capture transaction back.
    "INSERT INTO work_records (record_hash, type, work_id, session_id, body, source_path, source_generation, source_offset, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_hash) DO NOTHING",
  );
  const upsertMarker = db.query(
    "INSERT OR REPLACE INTO pending_translation (record_hash, work_id, type, created_at) VALUES (?, ?, ?, ?)",
  );
  const translations = db.query<PositionedRecord, [number, number, number]>(
    "SELECT w.rowid AS position, w.record_hash AS recordHash, w.type, w.work_id AS workId, w.session_id AS sessionId, w.body, w.source_path AS sourcePath, w.source_generation AS sourceGeneration, w.source_offset AS sourceOffset, w.imported_at AS importedAt FROM pending_translation p JOIN work_records w ON w.record_hash = p.record_hash WHERE w.rowid > ? AND w.rowid <= ? ORDER BY w.rowid LIMIT ?",
  );
  const clearTranslation = db.query("DELETE FROM pending_translation WHERE record_hash = ?");
  const marked = db.query<{ recordHash: string; workId: string; type: string }, []>(
    "SELECT record_hash AS recordHash, work_id AS workId, type FROM pending_translation",
  );
  const eventColumns = OUTBOX_CLAIM_COLUMNS;
  const latestEvent = db.query<OutboxEvent, [string, string]>(
    `SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND entity_id = ? AND blocked = '' ORDER BY rowid DESC LIMIT 1`,
  );
  const getEvent = db.query<OutboxEvent, [string, string]>(
    `SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND id = ?`,
  );
  const entityEvents = db.query<OutboxEvent, [string, string]>(
    `SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND entity_id = ? ORDER BY rowid`,
  );
  const claimRows = (accountKey: string, entityIds: readonly string[]): OutboxEvent[] => {
    const rows: OutboxEvent[] = [];
    // SQLite's bind cap is 999; one bounded page avoids one full scan/statement
    // preparation per request in a big production ledger.
    for (let offset = 0; offset < entityIds.length; offset += 500) {
      const page = entityIds.slice(offset, offset + 500);
      rows.push(
        ...db
          .query<OutboxEvent, [string, ...string[]]>(
            outboxClaimsSql(
              page.map(() => "?"),
              false,
            ),
          )
          .all(accountKey, ...page),
      );
    }
    return rows;
  };
  const claimRowsPage = (
    accountKey: string,
    entityIds: readonly string[],
    after: number,
    limit: number,
  ): { rows: OutboxEvent[]; nextAfter: number } => {
    // The IN list stays within the bind cap; the rowid cursor keeps each entity's
    // history ordered across pages because the caller consumes pages in order.
    const positioned = db
      .query<OutboxEvent & { position: number }, [string, ...string[], number, number]>(
        outboxClaimsSql(
          entityIds.map(() => "?"),
          true,
        ),
      )
      .all(accountKey, ...entityIds, after, limit);
    const rows = positioned.map(({ position, ...event }) => event);
    return {
      rows,
      nextAfter: positioned.length ? positioned[positioned.length - 1].position : after,
    };
  };
  const insertEvent = db.query(
    "INSERT INTO outbox_events (id, account_key, entity_id, kind, body, hash, created_at, acked_at, blocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const pendingEvents = db.query<OutboxEvent, [string, number]>(
    `SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND acked_at IS NULL AND blocked = '' ORDER BY rowid LIMIT ?`,
  );
  const pendingBatch = db.query<Omit<OutboxBatch, "eventIds"> & { eventIds: Uint8Array }, [string]>(
    "SELECT id, account_key AS accountKey, body, event_ids AS eventIds, created_at AS createdAt, order_key AS orderKey FROM outbox_batches WHERE account_key = ? ORDER BY order_key, created_at, rowid LIMIT 1",
  );
  const insertBatch = db.query(
    "INSERT INTO outbox_batches (id, account_key, body, event_ids, created_at, order_key) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const ackEvent = db.query(
    "UPDATE outbox_events SET acked_at = ? WHERE account_key = ? AND id = ? AND hash = ? AND acked_at IS NULL",
  );
  const blockEvent = db.query(
    "UPDATE outbox_events SET blocked = ? WHERE account_key = ? AND id = ? AND hash = ? AND acked_at IS NULL AND blocked = ''",
  );
  const deleteBatch = db.query("DELETE FROM outbox_batches WHERE account_key = ? AND id = ?");
  const transitionRepositories = db.query<{ repository: string }, []>(
    "SELECT repository FROM transition_repositories ORDER BY repository",
  );
  const outboxStatus = db.query<OutboxAccountStatus, []>(`
		SELECT a.account_key AS accountKey, COALESCE(e.pending, 0) AS pending,
			COALESCE(e.sendable, 0) AS sendable, COALESCE(e.blocked, 0) AS blocked,
			COALESCE(e.acknowledged, 0) AS acknowledged, e.lastAcknowledgedAt,
			COALESCE(b.batches, 0) AS batches,
			(SELECT id FROM outbox_batches WHERE account_key = a.account_key
				ORDER BY order_key, created_at, rowid LIMIT 1) AS firstBatchId
		FROM (SELECT account_key FROM outbox_events UNION SELECT account_key FROM outbox_batches) a
		LEFT JOIN (SELECT account_key, SUM(acked_at IS NULL) AS pending,
			SUM(acked_at IS NULL AND blocked = '') AS sendable,
			SUM(acked_at IS NULL AND blocked != '') AS blocked,
			SUM(acked_at IS NOT NULL) AS acknowledged, MAX(acked_at) AS lastAcknowledgedAt
			FROM outbox_events GROUP BY account_key) e USING (account_key)
		LEFT JOIN (SELECT account_key, COUNT(*) AS batches FROM outbox_batches GROUP BY account_key) b
			USING (account_key)
		ORDER BY a.account_key
	`);
  const outboxDeliveryRows = db.query<
    {
      accountKey: string;
      sendable: number;
      hasBatch: number;
      firstBatchId: string | null;
    },
    []
  >(OUTBOX_DELIVERY_STATUS_SQL);
  const getRow = db.query<{ body: string }, [string, string, string]>(
    "SELECT body FROM work_projection_rows WHERE work_id = ? AND log = ? AND key = ?",
  );
  const putRow = db.query(
    "INSERT INTO work_projection_rows (work_id, log, key, pos, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (work_id, log, key) DO UPDATE SET body = excluded.body",
  );
  const readLog = db.query<{ body: string }, [string, string]>(
    "SELECT body FROM work_projection_rows WHERE work_id = ? AND log = ? ORDER BY pos",
  );
  const getHead = db.query<{ body: string }, [string]>(
    "SELECT body FROM work_projection_head WHERE work_id = ?",
  );
  const putHead = db.query(
    "INSERT OR REPLACE INTO work_projection_head (work_id, body, updated_at) VALUES (?, ?, ?)",
  );
  const allHeads = db.query<{ body: string }, []>("SELECT body FROM work_projection_head");
  const clearRows = db.query("DELETE FROM work_projection_rows WHERE work_id = ?");
  const clearHead = db.query("DELETE FROM work_projection_head WHERE work_id = ?");
  const deleteRowsPage = db.query<[number, number], [string, number]>(
    "DELETE FROM work_projection_rows WHERE rowid IN (SELECT rowid FROM work_projection_rows WHERE work_id = ? LIMIT ?)",
  );
  const recordColumns = recordColumnsSql();
  const readRecordsAll = db.query<StoredRecord, []>(
    `SELECT ${recordColumns} FROM work_records ORDER BY rowid`,
  );
  const readRecordsWork = db.query<StoredRecord, [string]>(
    `SELECT ${recordColumns} FROM work_records WHERE work_id = ? ORDER BY rowid`,
  );
  let readRecordsSince = db.query<StoredRecord, [number]>(
    readRecordsSinceSql(workRecordsImportedPresent(db)),
  );
  /** A contended open may have deferred the additive index, leaving this connection unhinted. The
   * windowed read retries the deferred apply lazily (contention is usually gone by the next read)
   * and re-prepares the hinted statement, so a cached backend self-heals within one process. */
  const readSinceStatement = (): typeof readRecordsSince => {
    if (store.additiveDeferred && store.tryAdditiveSchema())
      readRecordsSince = db.query<StoredRecord, [number]>(readRecordsSinceSql(true));
    return readRecordsSince;
  };
  const readRecordsSession = db.query<StoredRecord, [string]>(
    `SELECT ${recordColumns} FROM work_records WHERE session_id = ? ORDER BY rowid`,
  );
  const readRecordsType = db.query<StoredRecord, [string]>(
    `SELECT ${recordColumns} FROM work_records WHERE type = ? ORDER BY rowid`,
  );
  const watermark = db.query<{ position: number }, []>(
    "SELECT COALESCE(MAX(rowid), 0) AS position FROM work_records",
  );
  const recordPage = db.query<PositionedRecord, [number, number, number]>(
    `SELECT rowid AS position, ${recordColumns} FROM work_records WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
  );
  const recordSincePage = db.query<PositionedRecord, [number, number, number, number]>(
    readRecordsSincePageSql(false),
  );
  // The first page of a windowed read starts at the history's beginning, so the unhinted rowid range
  // would walk the whole table to reach a tail window — the same planner trap the sync windowed
  // statement avoids with INDEXED BY. Later pages read exact rowid ranges and never need the hint.
  // Prepared lazily: an indexless open (a contended first open defers the additive apply) must not
  // prepare the hint, or backend construction itself would fail on the missing index.
  const prepareSinceFirstPage = () =>
    db.query<PositionedRecord, [number, number, number]>(readRecordsSincePageSql(true));
  let recordSinceFirstPage: ReturnType<typeof prepareSinceFirstPage> | undefined;
  const workRecordPage = db.query<PositionedRecord, [string, number, number, number]>(
    `SELECT rowid AS position, ${recordColumns} FROM work_records WHERE work_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
  );
  const recordCountAll = db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM work_records",
  );
  const recordCountWork = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM work_records WHERE work_id = ?",
  );
  const recordBytesWork = db.query<{ bytes: number | null }, [string]>(
    "SELECT sum(length(body)) AS bytes FROM work_records WHERE work_id = ?",
  );
  const dirty = db.query<{ work_id: string }, []>("SELECT work_id FROM work_dirty");
  const hasDirtyStmt = db.query<{ one: number }, [string]>(
    "SELECT 1 AS one FROM work_dirty WHERE work_id = ?",
  );
  // The stored body's BYTE length: SQLite's length() on TEXT counts CHARACTERS, so a head
  // holding multibyte content measured smaller here than the memory backend's
  // Buffer.byteLength and the two backends routed the same head to different sides of the
  // inline fold gate (contracts-003). CAST to BLOB makes length() count UTF-8 bytes.
  const headBodyBytesStmt = db.query<{ bytes: number | null }, [string]>(
    "SELECT length(CAST(body AS BLOB)) AS bytes FROM work_projection_head WHERE work_id = ?",
  );
  const markDirty = db.query("INSERT OR IGNORE INTO work_dirty (work_id) VALUES (?)");
  const clearDirty = db.query("DELETE FROM work_dirty WHERE work_id = ?");
  const hasNote = db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM bookkeeping WHERE work_id = ? AND name = ?",
  );
  const getNote = db.query<{ body: string }, [string, string]>(
    "SELECT body FROM bookkeeping WHERE work_id = ? AND name = ?",
  );
  const putNote = db.query(
    "INSERT OR REPLACE INTO bookkeeping (work_id, name, body, updated_at) VALUES (?, ?, ?, ?)",
  );
  const deleteNote = db.query("DELETE FROM bookkeeping WHERE work_id = ? AND name = ?");
  const notePage = db.query<{ name: string; body: string }, [string, string, number]>(
    "SELECT name, body FROM bookkeeping WHERE work_id = ? AND name > ? ORDER BY name LIMIT ?",
  );
  const getCursor = db.query<JournalCursor, [string]>(
    "SELECT path, dev, ino, generation, offset, boundary_hash AS boundaryHash, updated_at AS updatedAt FROM journal_cursor WHERE path = ?",
  );
  const allCursors = db.query<JournalCursor, []>(
    "SELECT path, dev, ino, generation, offset, boundary_hash AS boundaryHash, updated_at AS updatedAt FROM journal_cursor ORDER BY path",
  );
  const putCursor = db.query(
    "INSERT OR REPLACE INTO journal_cursor (path, dev, ino, generation, offset, boundary_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const deleteCursor = db.query("DELETE FROM journal_cursor WHERE path = ?");
  const bumpDiagnostic = db.query(
    "INSERT INTO diagnostics (code, count, updated_at) VALUES (?, 1, ?) ON CONFLICT (code) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at",
  );
  const dataVersionStmt = db.query<{ data_version: number }, []>("PRAGMA data_version");
  // Own commits feed the count in addition to PRAGMA data_version: Bun:sqlite does NOT bump the
  // pragma for same-connection commits (standard SQLite semantics, verified empirically), so own
  // writes are tracked explicitly and both signals are summed — the probe just needs change
  // detection. Autocommit mutators outside tx() (e.g. diagnostic counters below) touch neither
  // signal and that is intentional: observability writes must not wake an idled gate.
  let ownCommits = 0;
  const rowsOf = (workId: string, log: LogName): Row[] =>
    readLog.all(workId, log).map((row) => JSON.parse(row.body) as Row);
  const runTx = <T>(fn: () => T): T => {
    const result = store.tx(fn);
    ownCommits++;
    return result;
  };
  /** Autocommit mutators a pass can reach (notes, diagnostics, cursors) run inside the store's
   * transaction when none is open, so the write fence and the duration budget cover them too;
   * inside an already-open transaction they run bare — that transaction was fenced at its
   * start, and nested transactions are not possible. */
  const runMutation = (run: () => unknown): void => {
    if (db.inTransaction) run();
    else store.tx(run);
  };
  return {
    tx: runTx,
    writerEpoch: () => readWriterEpoch(db),
    prepareHeadPublication: (bodyBytes) => {
      if (bodyBytes < 4 * 1024 * 1024) return;
      // Flush before the timed write lock, without waiting on a competing writer. The
      // publication itself keeps the existing WAL, ACID and synchronous=FULL guarantees.
      try {
        db.exec("PRAGMA busy_timeout=0");
        db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (error) {
        console.error(
          `kimchi: publication checkpoint preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
      }
    },
    txDurations: () => txDurations(store),
    resetTxDurations: () => resetTxDurations(store),
    tryCaptureTx: (commit: () => void, busyMs?: number): boolean => {
      // The short wait runs on this connection only, and the original timeout is restored before
      // the caller can fall back to the blocking wait. A caller that already spent part of the
      // capture budget planning narrows the window by what it consumed (never below zero —
      // a zero window fails the attempt immediately and takes the spool path).
      const window = Math.max(
        0,
        Math.min(busyMs ?? CAPTURE_BUSY_TIMEOUT_MS, CAPTURE_BUSY_TIMEOUT_MS),
      );
      db.exec(`PRAGMA busy_timeout=${window}`);
      try {
        runTx(commit);
        return true;
      } catch (error) {
        if (!isBusyError(error)) throw error;
        return false;
      } finally {
        db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
      }
    },
    insertRecord: (row) =>
      insertRecord.run(
        row.recordHash,
        row.type,
        row.workId,
        row.sessionId,
        row.body,
        row.sourcePath,
        row.sourceGeneration,
        row.sourceOffset,
        row.importedAt,
      ).changes > 0,
    upsertMarker: (recordHash, workId, type) =>
      upsertMarker.run(recordHash, workId, type, Date.now()),
    pendingTranslations: (after, through, limit) => translations.all(after, through, limit),
    markedRecords: () => marked.all(),
    clearTranslation: (recordHash) => clearTranslation.run(recordHash),
    latestOutboxEvent: (accountKey, entityId) => latestEvent.get(accountKey, entityId) ?? undefined,
    getOutboxEvent: (accountKey, id) => getEvent.get(accountKey, id) ?? undefined,
    readTransitionRepositories: () => transitionRepositories.all().map((row) => row.repository),
    outboxEntityEvents: (accountKey, entityId) => entityEvents.all(accountKey, entityId),
    outboxClaims: claimRows,
    outboxClaimRows: claimRowsPage,
    insertOutboxEvent: (event) =>
      insertEvent.run(
        event.id,
        event.accountKey,
        event.entityId,
        event.kind,
        event.body,
        event.hash,
        event.createdAt,
        event.ackedAt,
        event.blocked,
      ),
    pendingOutboxEvents: (accountKey, limit) => pendingEvents.all(accountKey, limit),
    outboxStatus: () => outboxStatus.all(),
    outboxDeliveryStatus: () =>
      outboxDeliveryRows.all().map((row) => ({
        accountKey: row.accountKey,
        sendable: row.sendable === 1,
        hasBatch: row.hasBatch === 1,
        firstBatchId: row.firstBatchId,
      })),
    getOutboxBatch: (accountKey) => {
      const batch = pendingBatch.get(accountKey);
      return batch
        ? {
            ...batch,
            eventIds: JSON.parse(Buffer.from(batch.eventIds).toString("utf8")),
          }
        : undefined;
    },
    insertOutboxBatch: (batch) =>
      insertBatch.run(
        batch.id,
        batch.accountKey,
        batch.body,
        Buffer.from(JSON.stringify(batch.eventIds)),
        batch.createdAt,
        batch.orderKey,
      ),
    ackOutboxEvent: (accountKey, id, hash, at) =>
      ackEvent.run(at, accountKey, id, hash).changes > 0,
    blockOutboxEvent: (accountKey, id, hash, reason) =>
      blockEvent.run(reason, accountKey, id, hash).changes > 0,
    deleteOutboxBatch: (accountKey, id) => deleteBatch.run(accountKey, id).changes > 0,
    markDirty: (workId) => markDirty.run(workId),
    clearDirty: (workId) => clearDirty.run(workId),
    dirtyWorks: () => dirty.all().map((row) => row.work_id),
    hasDirty: (workId) => hasDirtyStmt.get(workId) != null,
    headBodyBytes: (workId) => headBodyBytesStmt.get(workId)?.bytes ?? 0,
    getRow: (workId, log, key) => {
      const found = getRow.get(workId, log, key);
      return found ? (JSON.parse(found.body) as Row) : undefined;
    },
    putRow: (workId, log, key, body, pos) =>
      putRow.run(workId, log, key, pos, JSON.stringify(body)),
    readLog: rowsOf,
    clearProjection: (workId) => {
      clearRows.run(workId);
      clearHead.run(workId);
    },
    clearProjectionHead: (workId) => {
      clearHead.run(workId);
    },
    deleteProjectionRows: (workId, limit) => deleteRowsPage.run(workId, limit).changes,
    getHead: (workId) => {
      const found = getHead.get(workId);
      return found ? (JSON.parse(found.body) as WorkHead) : undefined;
    },
    putHead: (head, body) => putHead.run(head.workId, body ?? JSON.stringify(head), Date.now()),
    allHeads: () => allHeads.all().map((row) => JSON.parse(row.body) as WorkHead),
    readRecords: (opts, checkBudget) => {
      checkBudget?.();
      // An index narrows the read; any other option filters its rows.
      const source =
        opts.workId !== undefined
          ? readRecordsWork.iterate(opts.workId)
          : opts.type !== undefined
            ? readRecordsType.iterate(opts.type)
            : opts.modifiedSince !== undefined
              ? readSinceStatement().iterate(opts.modifiedSince)
              : opts.sessionId !== undefined
                ? readRecordsSession.iterate(opts.sessionId)
                : readRecordsAll.iterate();
      const rows: StoredRecord[] = [];
      try {
        for (const row of source) {
          checkBudget?.();
          if (
            (opts.sessionId === undefined || row.sessionId === opts.sessionId) &&
            (opts.type === undefined || row.type === opts.type) &&
            (opts.modifiedSince === undefined || row.importedAt >= opts.modifiedSince)
          )
            rows.push(row);
        }
      } catch (error) {
        // Bun 1.4 leaves an interrupted iterator's cursor positioned mid-result.
        // get() resets before and after one row; it never drains the remaining history.
        if (opts.workId !== undefined) readRecordsWork.get(opts.workId);
        else if (opts.type !== undefined) readRecordsType.get(opts.type);
        else if (opts.modifiedSince !== undefined) readSinceStatement().get(opts.modifiedSince);
        else if (opts.sessionId !== undefined) readRecordsSession.get(opts.sessionId);
        else readRecordsAll.get();
        throw error;
      }
      return rows;
    },
    recordWatermark: () => watermark.get()?.position ?? 0,
    readRecordPage: (after, through, limit, checkBudget) =>
      drainStatementPage(recordPage, [after, through, limit], checkBudget),
    readRecordsSincePage: (modifiedSince, after, through, limit, checkBudget) => {
      if (after !== 0)
        return drainStatementPage(
          recordSincePage,
          [modifiedSince, after, through, limit],
          checkBudget,
        );
      // The first page heals a deferred additive index (the windowed read is the hint's only
      // consumer), then rides it; a still-contended database falls back to the unhinted range.
      if (store.additiveDeferred) store.tryAdditiveSchema();
      if (store.additiveDeferred)
        return drainStatementPage(recordSincePage, [modifiedSince, 0, through, limit], checkBudget);
      recordSinceFirstPage ??= prepareSinceFirstPage();
      return drainStatementPage(recordSinceFirstPage, [modifiedSince, through, limit], checkBudget);
    },
    readWorkRecordPage: (workId, after, through, limit, checkBudget) =>
      drainStatementPage(workRecordPage, [workId, after, through, limit], checkBudget),
    hasProjectionOutput: (workId) =>
      readLog.all(workId, "plans").length > 0 || readLog.all(workId, "commits").length > 0,
    recordCount: (workId) =>
      workId ? (recordCountWork.get(workId)?.count ?? 0) : (recordCountAll.get()?.count ?? 0),
    recordBytes: (workId) => recordBytesWork.get(workId)?.bytes ?? 0,
    hasNote: (workId, name) => hasNote.get(workId, name) != null,
    getNote: (workId, name) => getNote.get(workId, name)?.body,
    readNotePage: (workId, after, limit) => notePage.all(workId, after, limit),
    putNote: (workId, name, body) => runMutation(() => putNote.run(workId, name, body, Date.now())),
    deleteNote: (workId, name) => {
      runMutation(() => deleteNote.run(workId, name));
    },
    diagnostic: (code) => runMutation(() => bumpDiagnostic.run(code, Date.now())),
    dataVersion: () => (dataVersionStmt.get()?.data_version ?? 0) + ownCommits,
    getJournalCursor: (path) => getCursor.get(journalCursorLookupPath(path)) ?? undefined,
    putJournalCursor: (cursor) =>
      runMutation(() =>
        putCursor.run(
          cursor.path,
          cursor.dev,
          cursor.ino,
          cursor.generation,
          cursor.offset,
          cursor.boundaryHash,
          cursor.updatedAt,
        ),
      ),
    deleteJournalCursor: (path) => {
      runMutation(() => deleteCursor.run(path));
    },
    listJournalCursors: () => allCursors.all(),
    close: () => store.close(),
  };
}
