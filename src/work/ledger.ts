import type { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../platform.ts";
import {
  canonicalHash,
  digest,
  encodeBatch,
  encodeEvent,
  eventKind,
  protocolVersion,
  stableId,
  validateEvent,
  zeroTime,
  type Acknowledgement,
  type Batch,
  type Event,
} from "./protocol.ts";

const conflictError = new Error("event identity conflicts with persisted content");
const schemaVersion = 0x4b570002;
// Ledgers up to rc.5 named a revision's base by its hash.
const hashBaseVersion = 0x4b570001;
const schema = `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,kind TEXT NOT NULL,body BLOB NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL,acked_at INTEGER,blocked TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS pending_events ON events(acked_at,created_at);
CREATE INDEX IF NOT EXISTS entity_events ON events(entity_id);
CREATE TABLE IF NOT EXISTS export_receipts(target TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(target,event_id));
CREATE TABLE IF NOT EXISTS ledger_totals(id INTEGER PRIMARY KEY CHECK(id=1),total_bytes INTEGER NOT NULL,pending_bytes INTEGER NOT NULL);
INSERT OR IGNORE INTO ledger_totals SELECT 1,(SELECT COALESCE(SUM(length(body)),0) FROM events),(SELECT COALESCE(SUM(length(body)),0) FROM events WHERE acked_at IS NULL) WHERE NOT EXISTS(SELECT 1 FROM ledger_totals WHERE id=1);
CREATE TRIGGER IF NOT EXISTS event_size_insert AFTER INSERT ON events BEGIN UPDATE ledger_totals SET total_bytes=total_bytes+length(new.body),pending_bytes=pending_bytes+CASE WHEN new.acked_at IS NULL THEN length(new.body) ELSE 0 END WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS event_size_ack AFTER UPDATE OF acked_at ON events WHEN old.acked_at IS NULL AND new.acked_at IS NOT NULL BEGIN UPDATE ledger_totals SET pending_bytes=pending_bytes-length(new.body) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS event_size_delete AFTER DELETE ON events BEGIN UPDATE ledger_totals SET total_bytes=total_bytes-length(old.body),pending_bytes=pending_bytes-CASE WHEN old.acked_at IS NULL THEN length(old.body) ELSE 0 END WHERE id=1; DELETE FROM export_receipts WHERE event_id=old.id; END;
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,body BLOB NOT NULL,event_ids BLOB NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS batch_order(batch_id TEXT PRIMARY KEY,order_key TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS batch_order_delete AFTER DELETE ON batches BEGIN DELETE FROM batch_order WHERE batch_id=old.id; END;
CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,repository TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bindings(source TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,agent_id TEXT NOT NULL DEFAULT '',work_id TEXT NOT NULL,repository TEXT NOT NULL,PRIMARY KEY(source,session_id,turn_id,agent_id));
CREATE TABLE IF NOT EXISTS plans(repository TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,work_id TEXT NOT NULL,plan_id TEXT NOT NULL,revision_id TEXT NOT NULL,PRIMARY KEY(repository,path,hash,work_id));
CREATE TABLE IF NOT EXISTS tool_state(source TEXT NOT NULL,session_id TEXT NOT NULL,call_id TEXT NOT NULL,body BLOB NOT NULL,PRIMARY KEY(source,session_id,call_id));
CREATE TABLE IF NOT EXISTS file_identity(repository TEXT NOT NULL,path TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(repository,path));
CREATE TABLE IF NOT EXISTS file_revisions(repository TEXT NOT NULL,file_id TEXT NOT NULL,hash TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(repository,file_id,hash));
CREATE TABLE IF NOT EXISTS file_changes(id TEXT PRIMARY KEY,repository TEXT NOT NULL,path TEXT NOT NULL,before_hash TEXT,after_hash TEXT,work_id TEXT,quality TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commits(repository TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(repository,id));
CREATE TABLE IF NOT EXISTS cursors(path TEXT PRIMARY KEY,offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY,content BLOB NOT NULL,observed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blob_totals(id INTEGER PRIMARY KEY CHECK(id=1),total_bytes INTEGER NOT NULL);
INSERT OR IGNORE INTO blob_totals VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS blob_size_insert AFTER INSERT ON blobs BEGIN UPDATE blob_totals SET total_bytes=total_bytes+length(new.content) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_size_delete AFTER DELETE ON blobs BEGIN UPDATE blob_totals SET total_bytes=total_bytes-length(old.content) WHERE id=1; END;
CREATE TABLE IF NOT EXISTS diagnostics(code TEXT PRIMARY KEY,count INTEGER NOT NULL,updated_at INTEGER NOT NULL);`;
const now = () => Math.floor(Date.now() / 1000);
export const bodyText = (body: string | Uint8Array) =>
  typeof body === "string" ? body : Buffer.from(body).toString("utf8");
export class Store {
  readonly db: Database;
  constructor(readonly dir: string) {
    this.db = openDatabase(join(dir, "ledger.sqlite"));
    try {
      const version = (this.db.query("PRAGMA user_version").get() as any).user_version;
      if (version !== schemaVersion)
        this.db
          .transaction(() => {
            this.db.exec(schema);
            // Unknown future markers are not claimed by this version.
            if (version === 0 || version === hashBaseVersion) {
              this.baseByEventId();
              this.db.exec(`PRAGMA user_version=${schemaVersion}`);
            }
          })
          .immediate();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close(): void {
    this.db.close();
  }
  // No server accepted an event that names its base by hash, so the base becomes the event ID in place and a
  // frozen batch holding such a revision is rebuilt.
  private baseByEventId(): void {
    const rows = this.db.query("SELECT id,body FROM events").all() as any[];
    const events = rows.map((row) => JSON.parse(bodyText(row.body)));
    const ids = new Map(events.map((e) => [`${e.entityId}\n${e.revision}`, e.id]));
    const update = this.db.query("UPDATE events SET body=?,hash=? WHERE id=?");
    for (const [i, { baseHash, ...e }] of events.entries()) {
      if (!baseHash) continue;
      const rebased: Event = {
        ...e,
        baseEventId: ids.get(`${e.entityId}\n${e.baseRevision}`) ?? "",
      };
      update.run(Buffer.from(encodeEvent(rebased)), canonicalHash(rebased), rows[i].id);
    }
    for (const row of this.db.query("SELECT id,body FROM batches").all() as any[])
      if (JSON.parse(bodyText(row.body)).events.some((e: any) => e.baseHash))
        this.db.query("DELETE FROM batches WHERE id=?").run(row.id);
    this.db.exec(
      "UPDATE ledger_totals SET total_bytes=(SELECT COALESCE(SUM(length(body)),0) FROM events),pending_bytes=(SELECT COALESCE(SUM(length(body)),0) FROM events WHERE acked_at IS NULL) WHERE id=1",
    );
  }
  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  putBlob(input: Uint8Array | null): string {
    const content = Buffer.from(input ?? []);
    if (content.length > 4 << 20) throw new Error("file evidence exceeds size bound");
    const hash = digest(content);
    if (this.db.query("UPDATE blobs SET observed_at=? WHERE hash=?").run(now(), hash).changes === 1)
      return hash;
    let legacyBytes = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(join(this.dir, "blobs"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const entry of entries) {
      let info;
      try {
        info = lstatSync(join(this.dir, "blobs", entry));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (!info.isFile()) continue;
      if (entry === hash) {
        this.blob(hash);
        return hash;
      }
      legacyBytes += Math.min(info.size, (256 << 20) - legacyBytes);
    }
    const result = this.db
      .query(
        `INSERT INTO blobs(hash,content,observed_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM blobs WHERE hash=?) OR (SELECT total_bytes FROM blob_totals WHERE id=1)+?<=? ON CONFLICT(hash) DO UPDATE SET observed_at=excluded.observed_at`,
      )
      .run(hash, content, now(), hash, content.length, (256 << 20) - legacyBytes);
    // Bun reports trigger updates in changes as well as the inserted blob.
    if (result.changes < 1) throw new Error("local evidence capacity exceeded");
    return hash;
  }
  blob(hash: string): Buffer {
    const row = this.db.query("SELECT content FROM blobs WHERE hash=?").get(hash) as any;
    if (row) return Buffer.from(row.content);
    if (hash.length !== 64 || Buffer.from(hash, "hex").toString("hex") !== hash.toLowerCase())
      throw new Error("invalid evidence hash");
    const path = join(this.dir, "blobs", hash),
      before = lstatSync(path);
    if (!before.isFile() || before.size > 4 << 20) throw new Error("invalid legacy evidence");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = fstatSync(fd);
      if (
        !after.isFile() ||
        after.size > 4 << 20 ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        throw new Error("invalid legacy evidence");
      const buffer = Buffer.allocUnsafe((4 << 20) + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      const content = buffer.subarray(0, size);
      if (content.length > 4 << 20 || digest(content) !== hash)
        throw new Error("legacy evidence hash mismatch");
      return content;
    } finally {
      closeSync(fd);
    }
  }
  deviceId(): string {
    this.db.query("INSERT OR IGNORE INTO meta(key,value) VALUES('device',?)").run(randomUUID());
    return (this.db.query("SELECT value FROM meta WHERE key='device'").get() as any).value;
  }
  meta(key: string): string {
    return (this.db.query("SELECT value FROM meta WHERE key=?").get(key) as any)?.value ?? "";
  }
  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  private insert(e: Event): void {
    const body = Buffer.from(encodeEvent(e));
    const size = (this.db.query("SELECT total_bytes FROM ledger_totals WHERE id=1").get() as any)
      .total_bytes;
    if (size + body.length > 1 << 30)
      throw new Error("local accounting capacity exceeded; export records before cleanup");
    this.db
      .query("INSERT INTO events(id,entity_id,kind,body,hash,created_at) VALUES(?,?,?,?,?,?)")
      .run(e.id!, e.entityId, eventKind(e), body, canonicalHash(e), now());
  }
  put(e: Event): void {
    validateEvent(e);
    const hash = canonicalHash(e);
    this.tx(() => {
      const old = this.db.query("SELECT hash FROM events WHERE id=?").get(e.id!) as any;
      if (old) {
        if (old.hash !== hash) throw conflictError;
        return;
      }
      this.insert(e);
    });
  }
  latest(entityId: string): Event | null {
    const row = this.db
      .query("SELECT body FROM events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1")
      .get(entityId) as any;
    return row && JSON.parse(bodyText(row.body));
  }
  observe(input: Event): void {
    this.tx(() => {
      const e = { ...input, revision: "1", baseRevision: "0", baseEventId: "" };
      const old = this.latest(e.entityId);
      if (old) {
        const neutral = (v: Event): Event => ({
          ...v,
          id: "",
          revision: "0",
          baseRevision: "0",
          baseEventId: "",
          observeTime: zeroTime,
        });
        if (canonicalHash(neutral(old)) === canonicalHash(neutral(e))) return;
        e.revision = (BigInt(old.revision!) + 1n).toString();
        e.baseRevision = old.revision!;
        e.baseEventId = old.id!;
      }
      e.id = stableId(e.entityId, canonicalHash(e));
      validateEvent(e);
      this.insert(e);
    });
  }
  pendingBatch(signal?: AbortSignal): Batch | null {
    signal?.throwIfAborted();
    return this.tx(() => {
      const existing = this.db
        .query(
          "SELECT b.body FROM batches b LEFT JOIN batch_order o ON o.batch_id=b.id ORDER BY COALESCE(o.order_key,''),b.created_at,b.rowid LIMIT 1",
        )
        .get() as any;
      if (existing) return JSON.parse(bodyText(existing.body));
      const smaller = Number(this.meta("upload-batch-bytes"));
      const limit = smaller >= 16 << 10 && smaller < 1 << 20 ? smaller : 1 << 20;
      const b: Batch = { version: protocolVersion, id: randomUUID(), events: [] };
      let size = 0;
      for (const row of this.db
        .query(
          "SELECT body FROM events WHERE acked_at IS NULL AND blocked='' ORDER BY created_at,rowid LIMIT 100",
        )
        .all() as any[]) {
        const body = Buffer.from(row.body);
        if (size + body.length > limit && b.events.length) break;
        b.events.push(JSON.parse(body.toString()));
        size += body.length;
      }
      if (!b.events.length) return null;
      this.saveBatch(b);
      return b;
    });
  }
  private saveBatch(b: Batch): void {
    this.db
      .query("INSERT INTO batches(id,body,event_ids,created_at) VALUES(?,?,?,?)")
      .run(
        b.id,
        Buffer.from(encodeBatch(b)),
        Buffer.from(JSON.stringify(b.events.map((e) => e.id))),
        now(),
      );
  }
  acknowledge(b: Batch, ack: Acknowledgement): void {
    if (ack.batchId !== b.id || ack.receipts.length !== b.events.length)
      throw new Error("incomplete batch acknowledgement");
    const want = new Map(b.events.map((e) => [e.id, e.revision]));
    for (const r of ack.receipts) {
      if (
        !want.has(r.id) ||
        want.get(r.id) !== r.revision ||
        !["accepted", "unchanged", "conflict"].includes(r.status)
      )
        throw new Error("invalid event acknowledgement");
      want.delete(r.id);
    }
    if (want.size) throw new Error("missing event acknowledgement");
    // The server kept its own revision of a conflicting event's entity: the event stays out of later batches and
    // status counts it as blocked.
    const conflicts = new Set(ack.receipts.filter((r) => r.status === "conflict").map((r) => r.id));
    this.tx(() => {
      for (const e of b.events)
        this.db
          .query("UPDATE events SET acked_at=?,blocked=? WHERE id=? AND hash=?")
          .run(now(), conflicts.has(e.id!) ? "conflict" : "", e.id!, canonicalHash(e));
      this.db.query("DELETE FROM batches WHERE id=?").run(b.id);
    });
  }
  dropBatch(b: Batch): void {
    this.db.query("DELETE FROM batches WHERE id=?").run(b.id);
  }
  splitBatch(b: Batch): void {
    if (b.events.length < 2)
      throw new Error("one record exceeds the reporting payload limit; record retained");
    this.tx(() => {
      const row = this.db
        .query(
          "SELECT body,COALESCE((SELECT order_key FROM batch_order WHERE batch_id=batches.id),'') AS ordering FROM batches WHERE id=?",
        )
        .get(b.id) as any;
      if (!row) throw new Error("batch not found");
      if (canonicalHash(JSON.parse(bodyText(row.body))) !== canonicalHash(b)) throw conflictError;
      this.db.query("DELETE FROM batches WHERE id=?").run(b.id);
      const mid = Math.floor(b.events.length / 2);
      for (const [i, events] of [b.events.slice(0, mid), b.events.slice(mid)].entries()) {
        const part: Batch = { version: b.version, id: randomUUID(), events };
        this.saveBatch(part);
        this.db
          .query("INSERT INTO batch_order(batch_id,order_key) VALUES(?,?)")
          .run(part.id, row.ordering + String(i));
      }
      const limit = Math.max(16 << 10, Math.floor(Buffer.byteLength(row.body) / 2));
      this.db
        .query(
          "INSERT INTO meta(key,value) VALUES('upload-batch-bytes',?) ON CONFLICT(key) DO UPDATE SET value=MIN(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))",
        )
        .run(String(limit));
    });
  }
  diagnostic(code: string): void {
    try {
      this.db
        .query(
          "INSERT INTO diagnostics(code,count,updated_at) VALUES(?,1,?) ON CONFLICT(code) DO UPDATE SET count=count+1,updated_at=excluded.updated_at",
        )
        .run(code, now());
    } catch {}
  }
  status(): Record<string, any> {
    const n = this.db
      .query(
        "SELECT count(*) AS events,count(*) FILTER(WHERE acked_at IS NULL) AS pending,count(*) FILTER(WHERE blocked!='') AS blocked FROM events",
      )
      .get() as any;
    const bytes = this.db
      .query(
        "SELECT total_bytes AS normalizedBytes,pending_bytes AS pendingBytes FROM ledger_totals WHERE id=1",
      )
      .get() as any;
    const diagnostics = Object.fromEntries(
      (this.db.query("SELECT code,count FROM diagnostics ORDER BY code").all() as any[]).map(
        (r) => [r.code, r.count],
      ),
    );
    return { ...n, ...bytes, diagnostics };
  }
  events(): Event[] {
    return (this.db.query("SELECT body FROM events ORDER BY created_at,rowid").all() as any[]).map(
      (r) => JSON.parse(bodyText(r.body)),
    );
  }
}
