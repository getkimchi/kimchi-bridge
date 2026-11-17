import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { openDatabase } from "../platform.ts";
import type { Native } from "./capture.ts";
import {
  activityAction,
  activityObservation,
  validateActivityEvent,
  type ActivityInput,
  type WorkspaceActionEvent,
  type WorkspaceActivityEvent,
  type WorkspaceObservationEvent,
} from "./activity.ts";
import { bodyText } from "./ledger.ts";
import { integer, parseJson, stableId, stringifyJson } from "./protocol.ts";

export const activityBatchLimit = 1 << 20;
export const ACTIVITY_RETENTION = {
  pendingBytes: 64 << 20,
  actionBytes: 64 << 20,
  receiptRecords: 50_000,
  databaseBytes: 256 << 20,
  actionSeconds: 7 * 86400,
  receiptSeconds: 30 * 86400,
} as const;
export type ActivityRetention = { [K in keyof typeof ACTIVITY_RETENTION]?: number };

export class ActivityCapacityError extends Error {
  readonly code = "activity_backpressure";
}
export type ActivityBatch = { batchId: string; events: WorkspaceActivityEvent[] };
export type ActivityReceipt = {
  eventId: string;
  status: "RECEIPT_STATUS_ACCEPTED" | "RECEIPT_STATUS_UNCHANGED" | "RECEIPT_STATUS_REJECTED";
  reasonCode?: string;
};
export type ActivityAcknowledgement = { batchId: string; receipts: ActivityReceipt[] };

const tables = `CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  call_id TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  body BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS batches(
  id TEXT PRIMARY KEY,
  body BLOB NOT NULL,
  ordering TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS actions(
  source TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  body BLOB NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(source,trajectory_id,call_id)
);
CREATE TABLE IF NOT EXISTS observations(
  source TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  legacy_missing_duration INTEGER NOT NULL DEFAULT 0,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(source,trajectory_id,call_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS receipts(
  event_id TEXT PRIMARY KEY,
  body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS diagnostics(
  code TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`;

const indexes = `CREATE INDEX IF NOT EXISTS event_order ON events(created_at);
CREATE INDEX IF NOT EXISTS event_call ON events(source,trajectory_id,call_id);
CREATE INDEX IF NOT EXISTS action_last_seen ON actions(last_seen_at);
CREATE INDEX IF NOT EXISTS receipt_received ON receipts(received_at);`;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function sqlField(row: any, key: string): unknown {
  return row && typeof row === "object" ? row[key] : row;
}
function hasSqliteCode(
  error: unknown,
  code: "SQLITE_FULL" | "SQLITE_BUSY" | "SQLITE_LOCKED",
): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}
function staticCode(value: unknown, limit: number): value is string {
  if (typeof value !== "string" || !value || value.length > limit) return false;
  for (const char of value)
    if (!((char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_"))
      return false;
  return true;
}
function encoded(event: WorkspaceActivityEvent): string {
  const errors = validateActivityEvent(event);
  if (errors.length) throw new Error(`invalid activity event: ${errors.join(", ")}`);
  const body = stringifyJson(event);
  if (Buffer.byteLength(body) > 256 << 10) throw new Error("activity event exceeds size bound");
  return body;
}
function eventSource(event: WorkspaceActivityEvent): string {
  return event.agent?.platform ?? "";
}
function normalizeActivityEvent(event: WorkspaceActivityEvent): WorkspaceActivityEvent {
  // Only schema-declared int32 fields are converted back to JS numbers. Generic
  // tool JSON and uint64/decimal payload strings retain their original lexemes.
  const output = event.observation;
  const int32 = (value: unknown): number => {
    const code = integer(value);
    if (code === undefined || code < -2147483648 || code > 2147483647)
      throw new Error("invalid activity int32 field");
    return code;
  };
  if (output?.shellCommandOutput?.exitCode !== undefined)
    output.shellCommandOutput.exitCode = int32(output.shellCommandOutput.exitCode);
  if (output?.webFetchOutput?.code !== undefined)
    output.webFetchOutput.code = int32(output.webFetchOutput.code);
  return event;
}
function decodeActivityEvent(body: string): WorkspaceActivityEvent {
  return normalizeActivityEvent(JSON.parse(body) as WorkspaceActivityEvent);
}
function decodeActivityBatch(body: string): ActivityBatch {
  const batch = JSON.parse(body) as ActivityBatch;
  batch.events = batch.events.map(normalizeActivityEvent);
  return batch;
}

function observationFingerprint(event: WorkspaceObservationEvent): string {
  // The identity belongs to normalized evidence at this call, not the time its
  // duplicate callback arrived. Invocation/content/status are retained, while
  // the derived phase timing is deliberately removed from this fingerprint.
  const projection: WorkspaceObservationEvent = {
    ...event,
    eventId: "",
    occurredAt: "",
    observation: { ...event.observation },
  };
  for (const key of ["toolOutput", "shellCommandOutput", "webFetchOutput", "fileOperationResult"]) {
    const value = (projection.observation as any)[key];
    if (value) (projection.observation as any)[key] = { ...value, durationMs: undefined };
  }
  return sha256(stringifyJson(projection));
}

function legacyMissingDuration(event: WorkspaceActivityEvent): number {
  const observation = event.observation;
  if (!observation) return 0;
  for (const key of ["toolOutput", "shellCommandOutput", "webFetchOutput", "fileOperationResult"]) {
    const output = (observation as any)[key];
    if (output) return output.durationMs === undefined ? 1 : 0;
  }
  return 0;
}

function preserveLegacyDurationAbsence(event: WorkspaceObservationEvent): void {
  for (const key of ["toolOutput", "shellCommandOutput", "webFetchOutput", "fileOperationResult"]) {
    const output = (event.observation as any)[key];
    if (output) {
      // Preserve the recorded absence for matching legacy replays instead of
      // changing an immutable body merely because the normalizer learned duration.
      delete output.durationMs;
    }
  }
}

export class ActivityStore {
  readonly db: ReturnType<typeof openDatabase>;
  readonly limits: Required<ActivityRetention>;
  constructor(
    readonly dir: string,
    options?: ActivityRetention,
  ) {
    this.limits = { ...ACTIVITY_RETENTION, ...options };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid activity retention");
    this.db = openDatabase(join(dir, "activity.sqlite"));
    try {
      const pageSize = Number(sqlField(this.db.query("PRAGMA page_size").get(), "page_size"));
      this.db.exec(
        `PRAGMA max_page_count=${Math.max(1, Math.floor(this.limits.databaseBytes / pageSize))}`,
      );
      // Only incremental vacuum is used, never a whole-database rewrite while a hook is live.
      this.db.exec("PRAGMA auto_vacuum=INCREMENTAL");
      this.tx(() => {
        this.db.exec(tables);
        this.addColumn("actions", "last_seen_at", "INTEGER NOT NULL DEFAULT 0");
        this.addColumn("events", "source", "TEXT NOT NULL DEFAULT ''");
        this.addColumn("observations", "legacy_missing_duration", "INTEGER NOT NULL DEFAULT 0");
        this.db.exec(
          "UPDATE actions SET last_seen_at=unixepoch() WHERE last_seen_at=0; UPDATE events SET source=CAST(json_extract(body,'$.agent.platform') AS TEXT) WHERE source=''",
        );
        this.db.exec(indexes);
        // Preserve exact pending bodies from the earlier observation-ID scheme.
        // Accepted old records cannot be reconstructed and will not have their IDs rewritten.
        const pending = this.db
          .query("SELECT body FROM events ORDER BY created_at,rowid")
          .all() as {
          body: Uint8Array;
        }[];
        for (const row of pending) {
          const event = decodeActivityEvent(bodyText(row.body));
          if (!event.observation) continue;
          this.db
            .query(
              "INSERT OR IGNORE INTO observations(source,trajectory_id,call_id,fingerprint,event_id,occurred_at,last_seen_at,legacy_missing_duration) VALUES(?,?,?,?,?,?,unixepoch(),?)",
            )
            .run(
              eventSource(event),
              event.trajectoryId ?? "",
              callId(event),
              observationFingerprint(event as WorkspaceObservationEvent),
              event.eventId,
              event.occurredAt,
              legacyMissingDuration(event),
            );
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private addColumn(
    table: "actions" | "events" | "observations",
    column: "source" | "last_seen_at" | "legacy_missing_duration",
    type: string,
  ) {
    const names = (this.db.query(`PRAGMA table_info(${table})`).all() as any[]).map(
      (row) => row.name,
    );
    if (!names.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  close(): void {
    this.db.close();
  }
  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  private count(sql: string, ...bindings: (string | number)[]): number {
    return Number(sqlField(this.db.query(sql).get(...bindings), "value") ?? 0);
  }
  private pendingBytes(): number {
    return this.count(
      "SELECT (SELECT COALESCE(SUM(length(body)),0) FROM events)+(SELECT COALESCE(SUM(length(body)),0) FROM batches) AS value",
    );
  }
  private actionBytes(): number {
    return this.count("SELECT COALESCE(SUM(length(body)),0) AS value FROM actions");
  }
  private insert(event: WorkspaceActivityEvent): void {
    const body = encoded(event);
    const queued = this.db.query("SELECT body FROM events WHERE event_id=?").get(event.eventId) as {
      body: Uint8Array;
    } | null;
    if (queued) {
      if (bodyText(queued.body) !== body) throw new Error("immutable activity event conflict");
      return;
    }
    const acknowledged = this.db
      .query("SELECT body_sha256 FROM receipts WHERE event_id=?")
      .get(event.eventId) as { body_sha256: string } | null;
    if (acknowledged) {
      if (acknowledged.body_sha256 !== sha256(body))
        throw new Error("immutable activity event conflict");
      return;
    }
    const size = Buffer.byteLength(body);
    if (this.pendingBytes() + size > this.limits.pendingBytes)
      throw new ActivityCapacityError("activity pending byte budget exceeded; event not queued");
    this.db
      .query("INSERT INTO events(event_id,source,call_id,trajectory_id,body) VALUES(?,?,?,?,?)")
      .run(
        event.eventId,
        eventSource(event),
        callId(event),
        event.trajectoryId ?? "",
        Buffer.from(body),
      );
  }

  observe(n: Native, source: ActivityInput["source"]): void {
    try {
      this.observeInternal(n, source);
    } catch (error) {
      if (error instanceof ActivityCapacityError || hasSqliteCode(error, "SQLITE_FULL")) {
        this.diagnostic("activity_backpressure");
        if (error instanceof ActivityCapacityError) throw error;
        throw new ActivityCapacityError("activity storage byte budget reached; event not queued");
      }
      throw error;
    }
  }
  private observeInternal(n: Native, source: ActivityInput["source"]): void {
    const stage = n.stage || n.event.hook_event_name || "";
    const nativeStage = stage.startsWith("classic.") ? stage.slice("classic.".length) : stage;
    if (nativeStage === "PreToolUse" || nativeStage === "tool.before") {
      const input = { ...n, source, stage: nativeStage, event: { ...n.event } } as ActivityInput;
      const action = activityAction(input);
      const trajectoryId = action.trajectoryId!;
      action.eventId = stableId("workspace-activity-action", source, trajectoryId, callId(action));
      encoded(action);
      this.tx(() => {
        const old = this.db
          .query("SELECT body FROM actions WHERE source=? AND trajectory_id=? AND call_id=?")
          .get(source, trajectoryId, callId(action)) as { body: Uint8Array } | null;
        if (old) {
          const prior = parseJson(bodyText(old.body)) as WorkspaceActionEvent;
          if (stringifyJson(prior.action) !== stringifyJson(action.action))
            throw new Error("tool action preimage conflicts");
          this.db
            .query(
              "UPDATE actions SET last_seen_at=unixepoch() WHERE source=? AND trajectory_id=? AND call_id=?",
            )
            .run(source, trajectoryId, callId(action));
          // A replay preserves the original Action, including its occurredAt.
          return;
        }
        this.insert(action);
        this.db
          .query(
            "INSERT INTO actions(source,trajectory_id,call_id,body,last_seen_at) VALUES(?,?,?,?,unixepoch())",
          )
          .run(source, trajectoryId, callId(action), Buffer.from(stringifyJson(action)));
      });
      return;
    }
    if (!["PostToolUse", "PostToolUseFailure", "tool.after"].includes(nativeStage)) return;
    const input = { ...n, source, stage: nativeStage, event: { ...n.event } } as ActivityInput;
    const particle = activityAction({ ...input, occurredAt: "2026-11-16T00:00:00.000Z" });
    const id = callId(particle);
    const old = this.db
      .query("SELECT body FROM actions WHERE source=? AND trajectory_id=? AND call_id=?")
      .get(source, particle.trajectoryId!, id) as { body: Uint8Array } | null;
    if (!old) {
      this.diagnostic("activity_preimage_missing");
      return;
    }
    const action = parseJson(bodyText(old.body)) as WorkspaceActionEvent;
    const trajectoryId = action.trajectoryId!;
    if (stringifyJson(particle.action) !== stringifyJson(action.action))
      throw new Error("tool observation invocation differs from its Action");
    if (!input.version && action.agent?.platformVersion)
      input.version = action.agent.platformVersion;
    if (!input.event.turn_id && !input.event.turnId && action.turnId)
      input.event.turn_id = action.turnId;
    const duration = integer(input.event.duration_ms ?? input.result?.durationMs);
    const finish =
      duration !== undefined && duration >= 0 && duration <= 86_400_000
        ? new Date(Date.parse(action.occurredAt) + duration).toISOString()
        : undefined;
    const candidate = activityObservation(action, { ...input, occurredAt: finish });
    const fingerprint = observationFingerprint(candidate);
    this.tx(() => {
      const binding = this.db
        .query(
          "SELECT event_id,occurred_at,legacy_missing_duration FROM observations WHERE source=? AND trajectory_id=? AND call_id=? AND fingerprint=?",
        )
        .get(source, trajectoryId, id, fingerprint) as {
        event_id: string;
        occurred_at: string;
        legacy_missing_duration: number;
      } | null;
      let observation = candidate;
      if (binding) {
        const pending = this.db
          .query("SELECT body FROM events WHERE event_id=?")
          .get(binding.event_id) as { body: Uint8Array } | null;
        if (pending && decodeActivityEvent(bodyText(pending.body)).observation) {
          // A frozen legacy batch is already immutable evidence. Never reconstruct
          // it with today's normalizer and cause a different body under its old ID.
          this.db
            .query("UPDATE observations SET last_seen_at=unixepoch() WHERE event_id=?")
            .run(binding.event_id);
          this.db
            .query(
              "UPDATE actions SET last_seen_at=unixepoch() WHERE source=? AND trajectory_id=? AND call_id=?",
            )
            .run(source, trajectoryId, id);
          return;
        }
        // Repeat the semantic result with its first observedAt/duration, never a
        // fresh wall-clock attempt and never a mutation of the accepted body.
        observation = activityObservation(action, { ...input, occurredAt: binding.occurred_at });
        if (binding.legacy_missing_duration) preserveLegacyDurationAbsence(observation);
        observation.eventId = binding.event_id;
      } else {
        // Different evidence is a separate linked observation, not an overwrite
        // of a previously accepted event and not a claim of a second execution.
        observation.eventId = stableId(
          "workspace-activity-observation-v2",
          action.eventId,
          fingerprint,
        );
      }
      this.db
        .query(
          "INSERT OR IGNORE INTO observations(source,trajectory_id,call_id,fingerprint,event_id,occurred_at,last_seen_at) VALUES(?,?,?,?,?,?,unixepoch())",
        )
        .run(source, trajectoryId, id, fingerprint, observation.eventId, observation.occurredAt);
      this.insert(observation);
      this.db
        .query(
          "UPDATE observations SET last_seen_at=unixepoch() WHERE source=? AND trajectory_id=? AND call_id=? AND fingerprint=?",
        )
        .run(source, trajectoryId, id, fingerprint);
      this.db
        .query(
          "UPDATE actions SET last_seen_at=unixepoch() WHERE source=? AND trajectory_id=? AND call_id=?",
        )
        .run(source, trajectoryId, id);
    });
  }

  pendingBatch(): ActivityBatch | null {
    return this.tx(() => {
      const frozen = this.db
        .query("SELECT body FROM batches ORDER BY ordering,created_at,rowid LIMIT 1")
        .get() as { body: Uint8Array } | null;
      if (frozen) return decodeActivityBatch(bodyText(frozen.body));
      const events: WorkspaceActivityEvent[] = [];
      let size = 64;
      for (const row of this.db
        .query("SELECT body FROM events ORDER BY created_at,rowid LIMIT 100")
        .all() as { body: Uint8Array }[]) {
        const body = bodyText(row.body);
        if (size + Buffer.byteLength(body) > activityBatchLimit && events.length) break;
        events.push(decodeActivityEvent(body));
        size += Buffer.byteLength(body) + 1;
      }
      if (!events.length) return null;
      const batch = { batchId: randomUUID(), events };
      const body = stringifyJson(batch);
      if (Buffer.byteLength(body) > activityBatchLimit)
        throw new Error("an activity record exceeds the batch capacity; event retained");
      this.db
        .query("INSERT INTO batches(id,body) VALUES(?,?)")
        .run(batch.batchId, Buffer.from(body));
      return batch;
    });
  }

  /** Join by event identity, never by the peer's arbitrarily ordered receipt array. */
  acknowledge(batch: ActivityBatch, ack: ActivityAcknowledgement): void {
    if (!ack || ack.batchId !== batch.batchId || !Array.isArray(ack.receipts))
      throw new Error("invalid activity acknowledgement");
    const receipts = new Map<string, ActivityReceipt>();
    if (ack.receipts.length !== batch.events.length)
      throw new Error("incomplete activity acknowledgement");
    for (const receipt of ack.receipts) {
      if (
        !receipt ||
        !batch.events.some((event) => event.eventId === receipt.eventId) ||
        receipts.has(receipt.eventId) ||
        ![
          "RECEIPT_STATUS_ACCEPTED",
          "RECEIPT_STATUS_UNCHANGED",
          "RECEIPT_STATUS_REJECTED",
        ].includes(receipt.status) ||
        (receipt.reasonCode !== undefined &&
          !(receipt.reasonCode === "" && receipt.status !== "RECEIPT_STATUS_REJECTED") &&
          !staticCode(receipt.reasonCode, 128))
      )
        throw new Error("invalid activity event receipt");
      receipts.set(receipt.eventId, receipt);
    }
    if (receipts.size !== batch.events.length) throw new Error("missing activity event receipt");
    this.tx(() => {
      this.db.query("DELETE FROM batches WHERE id=?").run(batch.batchId);
      const remove = this.db.query("DELETE FROM events WHERE event_id=? AND body=?");
      const receipt = this.db.query(
        "INSERT INTO receipts(event_id,body_sha256,status,reason_code) VALUES(?,?,?,?)",
      );
      for (const event of batch.events) {
        const result = receipts.get(event.eventId)!;
        const body = encoded(event);
        if (remove.run(event.eventId, Buffer.from(body)).changes !== 1)
          throw new Error("activity content changed while awaiting its receipt");
        receipt.run(event.eventId, sha256(body), result.status, result.reasonCode ?? "");
      }
      this.trimReceipts();
    });
  }
  dropBatch(batch: ActivityBatch): void {
    this.db.query("DELETE FROM batches WHERE id=?").run(batch.batchId);
  }
  splitBatch(batch: ActivityBatch): void {
    if (batch.events.length < 2)
      throw new Error("one activity event exceeds the recording capacity; event retained");
    this.tx(() => {
      const old = this.db
        .query("SELECT body,ordering FROM batches WHERE id=?")
        .get(batch.batchId) as { body: Uint8Array; ordering: string } | null;
      if (!old) throw new Error("activity batch no longer exists");
      if (bodyText(old.body) !== stringifyJson(batch)) throw new Error("activity batch changed");
      this.db.query("DELETE FROM batches WHERE id=?").run(batch.batchId);
      for (const [index, events] of [
        batch.events.slice(0, Math.floor(batch.events.length / 2)),
        batch.events.slice(Math.floor(batch.events.length / 2)),
      ].entries()) {
        const part = { batchId: randomUUID(), events };
        this.db
          .query("INSERT INTO batches(id,body,ordering) VALUES(?,?,?)")
          .run(part.batchId, Buffer.from(stringifyJson(part)), old.ordering + String(index));
      }
    });
  }

  /** Metadata-only retention. Pending queues are never sacrificed to reclaim a preimage. */
  prune(now = Math.floor(Date.now() / 1000)): void {
    this.tx(() => {
      let actionOverBudget = this.actionBytes() > this.limits.actionBytes;
      let remaining = 512;
      for (;;) {
        if (remaining-- <= 0) break;
        // A call with no Observation might be executing now. Capacity cleanup
        // only removes calls with evidence, never assumed-abandoned in-flight work.
        const row = this.db
          .query(
            `SELECT a.rowid,length(a.body) AS size,a.source,a.trajectory_id,a.call_id FROM actions a
             WHERE (a.last_seen_at<? OR (?=1 AND EXISTS(
               SELECT 1 FROM observations o WHERE o.source=a.source AND o.trajectory_id=a.trajectory_id AND o.call_id=a.call_id)))
               AND NOT EXISTS(SELECT 1 FROM events e WHERE e.source=a.source AND e.trajectory_id=a.trajectory_id AND e.call_id=a.call_id)
             ORDER BY a.last_seen_at,a.rowid LIMIT 1`,
          )
          .get(now - this.limits.actionSeconds, actionOverBudget ? 1 : 0) as {
          rowid: number;
          size: number;
          source: string;
          trajectory_id: string;
          call_id: string;
        } | null;
        if (!row) break;
        if (this.db.query("DELETE FROM actions WHERE rowid=?").run(row.rowid).changes !== 1)
          throw new Error("activity retention race");
        this.db
          .query("DELETE FROM observations WHERE source=? AND trajectory_id=? AND call_id=?")
          .run(row.source, row.trajectory_id, row.call_id);
        actionOverBudget = this.actionBytes() - row.size > this.limits.actionBytes;
      }
      this.db
        .query(
          "DELETE FROM observations WHERE NOT EXISTS(SELECT 1 FROM actions a WHERE a.source=observations.source AND a.trajectory_id=observations.trajectory_id AND a.call_id=observations.call_id)",
        )
        .run();
      this.db
        .query("DELETE FROM receipts WHERE received_at<?")
        .run(now - this.limits.receiptSeconds);
      this.trimReceipts();
    });
    this.db.exec("PRAGMA incremental_vacuum(64)");
  }
  pruneIfDue(now = Math.floor(Date.now() / 1000)): void {
    try {
      const row = this.db.query("SELECT value FROM meta WHERE key='pruned_at'").get();
      const previousValue = Number(sqlField(row, "value") ?? 0);
      const previous = Number.isFinite(previousValue) ? previousValue : 0;
      if (now - previous < 3600) return;
      this.prune(now);
      this.db
        .query(
          "INSERT INTO meta(key,value) VALUES('pruned_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(now);
    } catch (error) {
      // Another hook may hold a write lock. Keep capturing and defer maintenance.
      if (hasSqliteCode(error, "SQLITE_BUSY") || hasSqliteCode(error, "SQLITE_LOCKED")) {
        this.diagnostic("activity_retention_pending");
        return;
      }
      throw error;
    }
  }
  private trimReceipts(): void {
    const count = this.count("SELECT count(*) AS value FROM receipts");
    const excess = Math.max(0, count - this.limits.receiptRecords);
    if (excess)
      this.db
        .query(
          "DELETE FROM receipts WHERE event_id IN (SELECT event_id FROM receipts ORDER BY received_at,rowid LIMIT ?)",
        )
        .run(excess);
  }
  diagnostic(code: string): void {
    if (!staticCode(code, 64)) throw new Error("invalid diagnostic");
    // Diagnostics are best-effort: storage exhaustion cannot turn observability
    // into a reason to block the user's tool call.
    try {
      this.db
        .query(
          "INSERT INTO diagnostics(code,count,updated_at) VALUES(?,1,unixepoch()) ON CONFLICT(code) DO UPDATE SET count=count+1,updated_at=excluded.updated_at",
        )
        .run(code);
    } catch {}
  }
  status(): Record<string, unknown> {
    const counters = this.db
      .query(
        `SELECT (SELECT count(*) FROM events) AS pending_events,
          (SELECT count(*) FROM batches) AS pending_batches,
          (SELECT count(*) FROM receipts WHERE status IN ('RECEIPT_STATUS_ACCEPTED','RECEIPT_STATUS_UNCHANGED')) AS acknowledgements,
          (SELECT count(*) FROM receipts WHERE status='RECEIPT_STATUS_REJECTED') AS rejected,
          (SELECT count(*) FROM actions) AS preimages,
          (SELECT count(*) FROM observations) AS observations,
          (SELECT count(*) FROM receipts) AS receipts`,
      )
      .get() as Record<string, unknown>;
    const page = this.db.query("PRAGMA page_count").get() as any;
    const size = this.db.query("PRAGMA page_size").get() as any;
    const diagnostics = Object.fromEntries(
      (this.db.query("SELECT code,count FROM diagnostics ORDER BY code").all() as any[]).map(
        (row) => [row.code, row.count],
      ),
    );
    return {
      ...counters,
      diagnostics,
      storage: {
        pendingBytes: this.pendingBytes(),
        pendingByteLimit: this.limits.pendingBytes,
        actionBytes: this.actionBytes(),
        actionByteLimit: this.limits.actionBytes,
        receiptLimit: this.limits.receiptRecords,
        databaseBytes: Number(sqlField(page, "page_count")) * Number(sqlField(size, "page_size")),
        databaseByteLimit: this.limits.databaseBytes,
        actionSeconds: this.limits.actionSeconds,
        receiptSeconds: this.limits.receiptSeconds,
      },
    };
  }
  allEvents(): WorkspaceActivityEvent[] {
    return (
      this.db.query("SELECT body FROM events ORDER BY created_at,rowid").all() as {
        body: Uint8Array;
      }[]
    ).map((row) => decodeActivityEvent(bodyText(row.body)));
  }
}

function callId(event: WorkspaceActivityEvent | WorkspaceObservationEvent): string {
  const subject = "action" in event ? event.action : event.observation;
  for (const key of ["toolCall", "shellCommand", "webFetch", "fileOperation"]) {
    const value = (subject as any)?.[key];
    if (value) return value.callId;
  }
  for (const key of ["toolOutput", "shellCommandOutput", "webFetchOutput", "fileOperationResult"]) {
    const value = (subject as any)?.[key];
    if (value) return value.callId;
  }
  return "";
}
