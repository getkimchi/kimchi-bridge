import { randomUUID } from "node:crypto";
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
export type ActivityBatch = { batchId: string; events: WorkspaceActivityEvent[] };
export type ActivityReceipt = {
  eventId: string;
  status: "RECEIPT_STATUS_ACCEPTED" | "RECEIPT_STATUS_UNCHANGED" | "RECEIPT_STATUS_REJECTED";
  reasonCode?: string;
};
export type ActivityAcknowledgement = { batchId: string; receipts: ActivityReceipt[] };

const schema = `CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  body BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS event_order ON events(created_at);
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
  PRIMARY KEY(source,trajectory_id,call_id)
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
);`;

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

export class ActivityStore {
  readonly db: ReturnType<typeof openDatabase>;
  constructor(readonly dir: string) {
    this.db = openDatabase(join(dir, "activity.sqlite"));
    try {
      this.db.exec(schema);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
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
      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      if (acknowledged.body_sha256 !== createHash("sha256").update(body).digest("hex"))
        throw new Error("immutable activity event conflict");
      return;
    }
    this.db
      .query("INSERT INTO events(event_id,call_id,trajectory_id,body) VALUES(?,?,?,?)")
      .run(event.eventId, callId(event), event.trajectoryId ?? "", Buffer.from(body));
  }

  observe(n: Native, source: ActivityInput["source"]): void {
    const stage = n.stage || n.event.hook_event_name || "";
    const nativeStage = stage.startsWith("classic.") ? stage.slice("classic.".length) : stage;
    if (nativeStage === "PreToolUse" || nativeStage === "tool.before") {
      const input = { ...n, source, stage: nativeStage } as ActivityInput;
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
          // A replay preserves the original Action, including its occurredAt.
          return;
        }
        this.insert(action);
        this.db
          .query("INSERT INTO actions(source,trajectory_id,call_id,body) VALUES(?,?,?,?)")
          .run(source, trajectoryId, callId(action), Buffer.from(stringifyJson(action)));
      });
      return;
    }
    if (!["PostToolUse", "PostToolUseFailure", "tool.after"].includes(nativeStage)) return;
    const input = { ...n, source, stage: nativeStage } as ActivityInput;
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
    const duration = integer(input.event.duration_ms ?? input.result?.durationMs);
    const finish =
      duration !== undefined && duration >= 0 && duration <= 86_400_000
        ? new Date(Date.parse(action.occurredAt) + duration).toISOString()
        : undefined;
    const observation = activityObservation(action, { ...input, occurredAt: finish });
    observation.eventId = stableId("workspace-activity-observation", action.eventId);
    this.tx(() => this.insert(observation));
  }

  pendingBatch(): ActivityBatch | null {
    return this.tx(() => {
      const frozen = this.db
        .query("SELECT body FROM batches ORDER BY ordering,created_at,rowid LIMIT 1")
        .get() as { body: Uint8Array } | null;
      if (frozen) return parseJson(bodyText(frozen.body)) as ActivityBatch;
      const events: WorkspaceActivityEvent[] = [];
      let size = 64;
      for (const row of this.db
        .query("SELECT body FROM events ORDER BY created_at,rowid LIMIT 100")
        .all() as { body: Uint8Array }[]) {
        const body = bodyText(row.body);
        if (size + Buffer.byteLength(body) > activityBatchLimit && events.length) break;
        events.push(parseJson(body) as WorkspaceActivityEvent);
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

  /** A receipt never removes another event's body or advances an unrecognized ID. */
  acknowledge(batch: ActivityBatch, ack: ActivityAcknowledgement): void {
    if (!ack || ack.batchId !== batch.batchId || !Array.isArray(ack.receipts))
      throw new Error("invalid activity acknowledgement");
    const ids = new Set(batch.events.map((e) => e.eventId));
    if (ack.receipts.length !== ids.size) throw new Error("incomplete activity acknowledgement");
    for (const receipt of ack.receipts) {
      if (
        !receipt ||
        !ids.delete(receipt.eventId) ||
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
    }
    if (ids.size) throw new Error("missing activity event receipt");
    this.tx(() => {
      this.db.query("DELETE FROM batches WHERE id=?").run(batch.batchId);
      const remove = this.db.query("DELETE FROM events WHERE event_id=? AND body=?");
      const receipt = this.db.query(
        "INSERT INTO receipts(event_id,body_sha256,status,reason_code) VALUES(?,?,?,?)",
      );
      for (const [index, event] of batch.events.entries()) {
        const result = ack.receipts[index]!;
        const body = encoded(event);
        if (remove.run(event.eventId, Buffer.from(body)).changes !== 1)
          throw new Error("activity content changed while awaiting its receipt");
        const { createHash } = require("node:crypto") as typeof import("node:crypto");
        receipt.run(
          event.eventId,
          createHash("sha256").update(body).digest("hex"),
          result.status,
          result.reasonCode ?? "",
        );
      }
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
  diagnostic(code: string): void {
    if (!staticCode(code, 64)) throw new Error("invalid diagnostic");
    this.db
      .query(
        "INSERT INTO diagnostics(code,count,updated_at) VALUES(?,1,unixepoch()) ON CONFLICT(code) DO UPDATE SET count=count+1,updated_at=excluded.updated_at",
      )
      .run(code);
  }
  status(): Record<string, unknown> {
    return this.db
      .query(
        `SELECT (SELECT count(*) FROM events) AS pending_events,
          (SELECT count(*) FROM batches) AS pending_batches,
          (SELECT count(*) FROM receipts WHERE status IN ('RECEIPT_STATUS_ACCEPTED','RECEIPT_STATUS_UNCHANGED')) AS acknowledgements,
          (SELECT count(*) FROM receipts WHERE status='RECEIPT_STATUS_REJECTED') AS rejected,
          (SELECT count(*) FROM actions) AS preimages`,
      )
      .get() as Record<string, unknown>;
  }
  allEvents(): WorkspaceActivityEvent[] {
    return (
      this.db.query("SELECT body FROM events ORDER BY created_at,rowid").all() as {
        body: Uint8Array;
      }[]
    ).map((row) => parseJson(bodyText(row.body)) as WorkspaceActivityEvent);
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
