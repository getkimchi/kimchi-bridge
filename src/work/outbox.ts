// The durable upload queue of one or more accounts, as the Kimchi harness keeps it: each fact
// becomes the next revision of its entity, revisions are frozen into batches whose bytes never
// change, and only a complete acknowledgement advances them. The storage is the caller's; these
// rules are the same wherever the events are kept.
import { randomUUID } from "node:crypto";
import {
  digest,
  encodeBatch,
  encodeEvent,
  eventHash,
  eventKind,
  isClaim,
  normalizeIngestTimes,
  protocolVersion,
  stableId,
  timeNanos,
  validateIngestBatch,
  validateIngestEvent,
  type Acknowledgement,
  type Event,
  type IngestBatch,
  type IngestEvent,
} from "./protocol.ts";

const BATCH_EVENTS = 100;
const BATCH_BYTES = 1 << 20;

/** What a producer observed about an entity; the outbox assigns its ID and revision. */
export type Fact = Omit<Event, "id" | "revision" | "baseRevision" | "baseEventId">;

export interface OutboxEvent {
  id: string;
  accountKey: string;
  entityId: string;
  kind: string;
  body: Uint8Array;
  hash: string;
  createdAt: number;
  ackedAt: number | null;
  /** Why the server refused the event ("conflict"), or empty. A blocked event is never sent again. */
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

/** The storage an outbox needs. Every method reads or writes one account's rows. */
export interface OutboxStore {
  /** Runs `fn` in one transaction: all of its writes commit, or none. */
  tx<T>(fn: () => T): T;
  /** The entity's newest event the server may hold: one it refused as a conflict is left out. */
  latestOutboxEvent(accountKey: string, entityId: string): OutboxEvent | undefined;
  getOutboxEvent(accountKey: string, id: string): OutboxEvent | undefined;
  /** Every event of the entity, oldest first. */
  outboxEntityEvents(accountKey: string, entityId: string): OutboxEvent[];
  insertOutboxEvent(event: OutboxEvent): void;
  /** Unacknowledged, unblocked events, oldest first. */
  pendingOutboxEvents(accountKey: string, limit: number): OutboxEvent[];
  /** The account's first frozen batch, if any. */
  getOutboxBatch(accountKey: string): OutboxBatch | undefined;
  insertOutboxBatch(batch: OutboxBatch): void;
  ackOutboxEvent(accountKey: string, id: string, hash: string, at: number): boolean;
  /** Sets an unacknowledged event aside for `reason`; it stays out of every later batch. */
  blockOutboxEvent(accountKey: string, id: string, hash: string, reason: string): boolean;
  deleteOutboxBatch(accountKey: string, id: string): boolean;
}

function projectClaim(raw: IngestEvent, previous?: IngestEvent): IngestEvent {
  const effective = { ...raw };
  if (isClaim(raw) && raw.startedAt === undefined) effective.startedAt = raw.observeTime;
  if (raw.source === "kimchi" && previous?.source === "kimchi") {
    effective.allocation = raw.allocation ?? previous.allocation;
    effective.claimState = raw.claimState || previous.claimState;
    effective.correction = raw.correction ?? previous.correction;
    effective.startedAt = raw.startedAt ?? previous.startedAt ?? effective.startedAt;
  }
  return effective;
}

/**
 * What the server would refuse in a claim's next revision: a claim keeps its request, producer,
 * repository and start time, a plain request never becomes a claim, and one correction receipt
 * names one outcome.
 */
export function validateClaimUpdate(next: Event, previous?: Event): void {
  if (!isClaim(next) && (!previous || !isClaim(previous))) return;
  if (next.source !== "kimchi" || next.usage?.counterScope !== "request")
    throw new Error("Claim source and request scope are immutable");
  if (previous) {
    if (!isClaim(previous)) throw new Error("Native request identity cannot become a claim");
    const repository = (value: Event["repository"]) =>
      value ? [value.provider, value.host, value.id] : null;
    if (
      next.usage.requestId?.toLowerCase() !== previous.usage?.requestId?.toLowerCase() ||
      next.deviceId !== previous.deviceId ||
      JSON.stringify(repository(next.repository)) !==
        JSON.stringify(repository(previous.repository))
    )
      throw new Error("Claim request identity, producer and repository are immutable");
    if (
      next.startedAt &&
      timeNanos(next.startedAt) !== timeNanos(previous.startedAt ?? previous.observeTime)
    )
      throw new Error("Claim start time is immutable");
    const candidate = next.correction ?? previous.correction;
    const old = previous.correction;
    if (candidate && old) {
      const same =
        candidate.id === old.id &&
        candidate.revision === old.revision &&
        timeNanos(candidate.recordedAt) === timeNanos(old.recordedAt) &&
        candidate.source === old.source;
      if (same) {
        const allocation = (event: Event) =>
          event.allocation
            ? [
                event.allocation.kind,
                event.allocation.pullRequestIds ?? [],
                event.allocation.method,
                repository(event.allocation.targetRepository ?? event.repository),
              ]
            : null;
        if (
          (next.allocation &&
            JSON.stringify(allocation(next)) !== JSON.stringify(allocation(previous))) ||
          (next.claimState &&
            next.claimState !== previous.claimState &&
            !(previous.claimState === undefined && next.claimState === "active"))
        )
          throw new Error("Conflicting contents for one correction receipt");
      } else {
        const at = timeNanos(candidate.recordedAt);
        const before = timeNanos(old.recordedAt);
        if (
          (candidate.id === old.id && (candidate.revision <= old.revision || at < before)) ||
          (candidate.id !== old.id && at <= before)
        )
          throw new Error("Correction receipt is not newer");
      }
    }
  }
  if (next.correction && timeNanos(next.correction.recordedAt) > BigInt(Date.now()) * 1_000_000n)
    throw new Error("Correction receipt is in the future");
}

function unpack(row: OutboxEvent): IngestEvent {
  const body = Buffer.from(row.body);
  if (digest(body) !== row.hash) throw new Error("Outbox event hash mismatch");
  const event: Event = JSON.parse(body.toString("utf8"));
  validateIngestEvent(event);
  if (event.id !== row.id || event.entityId !== row.entityId || eventKind(event) !== row.kind)
    throw new Error("Outbox event identity mismatch");
  if (encodeEvent(event) !== encodeEvent(normalizeIngestTimes(event)))
    throw new Error("Outbox event differs from protobuf transport");
  return event;
}

/**
 * An entity's claim as the server holds it: each revision inherits what it leaves out. The stored
 * bytes stay the authority for revisions and upload; an event the server refused as a conflict
 * never became part of the claim.
 */
export function effectiveClaim(
  store: OutboxStore,
  accountKey: string,
  entityId: string,
): IngestEvent | undefined {
  let effective: IngestEvent | undefined;
  for (const row of store.outboxEntityEvents(accountKey, entityId))
    if (!row.blocked) effective = projectClaim(unpack(row), effective);
  return effective;
}

const neutral = (event: Event): Event => ({
  ...event,
  id: "",
  revision: "0",
  baseRevision: "0",
  baseEventId: "",
  observeTime: "0001-01-01T00:00:00Z",
});

/**
 * Stores each fact as its entity's next revision, unless nothing but the time changed. `committed`
 * runs in the same transaction after the events, so a caller's own bookkeeping commits with them
 * or not at all; `assertCurrent` runs first and last and throws to abandon the transaction.
 */
export function observeEvents(
  store: OutboxStore,
  accountKey: string,
  facts: readonly Fact[],
  assertCurrent: () => void = () => {},
  committed: () => void = () => {},
): void {
  if (!accountKey) throw new Error("Missing outbox account");
  store.tx(() => {
    assertCurrent();
    for (const fact of facts) {
      const event = normalizeIngestTimes({
        ...fact,
        id: "",
        revision: "1",
        baseRevision: "0",
        baseEventId: "",
      });
      event.id = stableId(accountKey, event.entityId, eventHash(event));
      validateIngestEvent(event);
      // The entity's last event the server may hold; one it refused as a conflict is set aside.
      const previous = store.latestOutboxEvent(accountKey, event.entityId);
      let old: IngestEvent | undefined;
      if (previous) {
        old = unpack(previous);
        if (eventKind(old) !== eventKind(event)) throw new Error("Outbox entity kind is immutable");
        // The stored revision already passed every check below.
        if (eventHash(neutral(old)) === eventHash(neutral(event))) continue;
      }
      const raw: Event = JSON.parse(encodeEvent(event));
      validateClaimUpdate(
        raw,
        old && (old.source === "kimchi" || raw.source === "kimchi")
          ? effectiveClaim(store, accountKey, event.entityId)
          : old,
      );
      if (previous && old) {
        event.revision = (BigInt(old.revision) + 1n).toString();
        event.baseRevision = old.revision;
        event.baseEventId = previous.id;
      }
      event.id = "";
      event.id = stableId(accountKey, event.entityId, eventHash(event));
      // The server refused this exact event once; it is never sent again.
      if (store.getOutboxEvent(accountKey, event.id)) continue;
      validateIngestEvent(event);
      store.insertOutboxEvent({
        id: event.id,
        accountKey,
        entityId: event.entityId,
        kind: eventKind(event),
        body: Buffer.from(encodeEvent(event)),
        hash: eventHash(event),
        createdAt: Date.now(),
        ackedAt: null,
        blocked: "",
      });
    }
    committed();
    assertCurrent();
  });
}

/** Splice stored event bodies verbatim so fields from newer builds survive delivery. */
function wireBody(id: string, bodies: readonly Uint8Array[]): Buffer {
  const head = encodeBatch({ version: protocolVersion, id, events: [] }).slice(0, -2);
  const events = bodies.map((bytes) => Buffer.from(bytes).toString("utf8")).join(",");
  return Buffer.from(`{"batch":${head}${events}]}}`);
}

function unpackBatch(
  row: OutboxBatch,
  store: OutboxStore,
): { batch: IngestBatch; events: OutboxEvent[] } {
  const body = Buffer.from(row.body);
  const batch = JSON.parse(body.toString("utf8")).batch;
  validateIngestBatch(batch);
  if (
    batch.id !== row.id ||
    !Array.isArray(row.eventIds) ||
    row.eventIds.length !== batch.events.length ||
    batch.events.some((event, index) => event.id !== row.eventIds[index])
  )
    throw new Error("Outbox batch identity mismatch");
  const events = batch.events.map((event) => {
    const stored = store.getOutboxEvent(row.accountKey, event.id);
    if (!stored) throw new Error("Outbox batch event mismatch");
    return stored;
  });
  for (const stored of events) unpack(stored);
  const expected = wireBody(
    row.id,
    events.map((stored) => stored.body),
  );
  if (!body.equals(expected)) throw new Error("Outbox batch identity mismatch");
  return { batch, events };
}

/**
 * The account's batch to send: the one already frozen, or a new one of its oldest pending events.
 * The HTTP body is frozen once; newer observations cannot replace it while its acknowledgement is
 * pending.
 */
export function pendingBatch(
  store: OutboxStore,
  accountKey: string,
  assertCurrent: () => void = () => {},
): OutboxBatch | undefined {
  if (!accountKey) throw new Error("Missing outbox account");
  return store.tx(() => {
    assertCurrent();
    const existing = store.getOutboxBatch(accountKey);
    if (existing) {
      unpackBatch(existing, store);
      return existing;
    }
    const batch: IngestBatch = { version: protocolVersion, id: randomUUID(), events: [] };
    const bodies: Uint8Array[] = [];
    for (const row of store.pendingOutboxEvents(accountKey, BATCH_EVENTS)) {
      batch.events.push(unpack(row));
      bodies.push(row.body);
      if (wireBody(batch.id, bodies).length > BATCH_BYTES) {
        batch.events.pop();
        bodies.pop();
        break;
      }
    }
    if (!batch.events.length) return undefined;
    validateIngestBatch(batch);
    const frozen: OutboxBatch = {
      id: batch.id,
      accountKey,
      body: wireBody(batch.id, bodies),
      eventIds: batch.events.map((event) => event.id),
      createdAt: Date.now(),
      orderKey: "",
    };
    store.insertOutboxBatch(frozen);
    assertCurrent();
    return frozen;
  });
}

/**
 * Applies the server's answer to the batch that was sent. Only a complete acknowledgement of this
 * account's persisted bytes advances its events and removes the batch; false means another batch
 * is current.
 */
export function acknowledgeBatch(
  store: OutboxStore,
  accountKey: string,
  sent: OutboxBatch,
  acknowledgement: Acknowledgement,
  assertCurrent: () => void = () => {},
): boolean {
  if (sent.accountKey !== accountKey) throw new Error("Outbox account changed");
  return store.tx(() => {
    assertCurrent();
    const current = store.getOutboxBatch(accountKey);
    if (!current || current.id !== sent.id) return false;
    if (!Buffer.from(current.body).equals(Buffer.from(sent.body)))
      throw new Error("Outbox batch changed");
    const { batch, events } = unpackBatch(current, store);
    if (
      acknowledgement.batchId !== batch.id ||
      !Array.isArray(acknowledgement.receipts) ||
      acknowledgement.receipts.length !== batch.events.length
    )
      throw new Error("Incomplete batch acknowledgement");
    const expected = new Map(batch.events.map((event) => [event.id, event.revision]));
    const conflicts = new Set<string>();
    for (const receipt of acknowledgement.receipts) {
      if (
        !expected.has(receipt.id) ||
        expected.get(receipt.id) !== receipt.revision ||
        !["accepted", "unchanged", "conflict"].includes(receipt.status)
      )
        throw new Error("Invalid event acknowledgement");
      expected.delete(receipt.id);
      if (receipt.status === "conflict") conflicts.add(receipt.id);
    }
    if (expected.size) throw new Error("Missing event acknowledgement");
    const at = Date.now();
    for (const stored of events) {
      // The server kept the entity's current revision instead: the event is set aside, never sent again.
      const settled = conflicts.has(stored.id)
        ? store.blockOutboxEvent(accountKey, stored.id, stored.hash, "conflict")
        : store.ackOutboxEvent(accountKey, stored.id, stored.hash, at);
      if (!settled) throw new Error("Outbox event changed");
    }
    if (!store.deleteOutboxBatch(accountKey, batch.id)) throw new Error("Outbox batch changed");
    assertCurrent();
    return true;
  });
}
