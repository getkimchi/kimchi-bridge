import { expect, test } from "bun:test";
import {
  acknowledgeBatch,
  effectiveClaim,
  observeEvents,
  pendingBatch,
  validateClaimUpdate,
  type Fact,
  type OutboxBatch,
  type OutboxEvent,
  type OutboxStore,
} from "../src/work/outbox.ts";
import type { Acknowledgement, IngestEvent } from "../src/work/protocol.ts";

const ACCOUNT = "account-a";
const ENTITY = "fc4d5bcd-7b11-4497-ed93-f29b8f22397a";
const DEVICE = "b0c8ee08-2158-46df-a2e8-4b4e944d0a57";
const REQUEST = "600a5684-c3af-425c-b289-3b79082e9eff";

/** A store that keeps rows in arrays and undoes a transaction that throws. */
function memoryStore() {
  let events: OutboxEvent[] = [];
  let batches: OutboxBatch[] = [];
  let depth = 0;
  const store: OutboxStore = {
    tx(fn) {
      if (depth) return fn();
      const saved = [
        events.map((row) => ({ ...row })),
        batches.map((row) => ({ ...row })),
      ] as const;
      depth++;
      try {
        return fn();
      } catch (error) {
        [events, batches] = [saved[0], saved[1]];
        throw error;
      } finally {
        depth--;
      }
    },
    latestOutboxEvent: (accountKey, entityId) =>
      events.findLast(
        (row) => row.accountKey === accountKey && row.entityId === entityId && !row.blocked,
      ),
    getOutboxEvent: (accountKey, id) =>
      events.find((row) => row.accountKey === accountKey && row.id === id),
    outboxEntityEvents: (accountKey, entityId) =>
      events.filter((row) => row.accountKey === accountKey && row.entityId === entityId),
    insertOutboxEvent: (event) => void events.push(event),
    pendingOutboxEvents: (accountKey, limit) =>
      events
        .filter((row) => row.accountKey === accountKey && row.ackedAt === null && !row.blocked)
        .slice(0, limit),
    getOutboxBatch: (accountKey) => batches.find((row) => row.accountKey === accountKey),
    insertOutboxBatch: (batch) => void batches.push(batch),
    ackOutboxEvent(accountKey, id, hash, at) {
      const row = events.find(
        (e) => e.accountKey === accountKey && e.id === id && e.hash === hash && e.ackedAt === null,
      );
      if (row) row.ackedAt = at;
      return !!row;
    },
    blockOutboxEvent(accountKey, id, hash, reason) {
      const row = events.find(
        (e) => e.accountKey === accountKey && e.id === id && e.hash === hash && e.ackedAt === null,
      );
      if (row) [row.ackedAt, row.blocked] = [Date.now(), reason];
      return !!row;
    },
    deleteOutboxBatch(accountKey, id) {
      const before = batches.length;
      batches = batches.filter((row) => !(row.accountKey === accountKey && row.id === id));
      return batches.length < before;
    },
  };
  return { store, rows: () => events, frozen: () => batches };
}

const usage = (outputTokens: string) => ({
  channel: "native",
  requestId: REQUEST,
  schema: "anthropic-messages-v1",
  counterScope: "request",
  observedRoute: "castai",
  reportedModel: "glm-5.3-flash",
  billingBasis: "api",
  correlation: "exact",
  raw: { inputTokens: "1200", outputTokens },
  attemptsComplete: true,
});
/** A plain request, as Claude Code or Codex report one. */
const native = (outputTokens = "350", observeTime = "2026-10-23T13:34:23Z"): Fact => ({
  entityId: ENTITY,
  source: "claude-code",
  sourceVersion: "2.1.309",
  deviceId: DEVICE,
  observeTime,
  usage: usage(outputTokens),
});
/** A Kimchi request claim: the harness says where the request's cost goes. */
const claim = (fields: Partial<Fact> = {}): Fact => ({
  ...native(),
  source: "kimchi",
  startedAt: "2026-10-23T13:30:00Z",
  ...fields,
});
const decode = (row: OutboxEvent): IngestEvent => JSON.parse(Buffer.from(row.body).toString());
const receipts = (batch: OutboxBatch, status = "accepted"): Acknowledgement => ({
  batchId: batch.id,
  receipts: JSON.parse(Buffer.from(batch.body).toString()).batch.events.map(
    (event: IngestEvent) => ({ id: event.id, status, revision: event.revision }),
  ),
});

test("a changed fact is the entity's next revision, and one that only moved in time is not stored", () => {
  const { store, rows } = memoryStore();
  observeEvents(store, ACCOUNT, [native("350")]);
  observeEvents(store, ACCOUNT, [native("350", "2026-10-23T14:00:00Z")]);
  observeEvents(store, ACCOUNT, [native("400")]);
  const stored = rows().map(decode);
  expect(stored.map((event) => event.revision)).toEqual(["1", "2"]);
  expect(stored[0]!.baseEventId).toBeUndefined();
  expect([stored[1]!.baseRevision, stored[1]!.baseEventId]).toEqual(["1", stored[0]!.id]);
});

test("an entity's kind never changes", () => {
  const { store } = memoryStore();
  observeEvents(store, ACCOUNT, [native()]);
  const { usage: _, ...identity } = native();
  const tool = { callId: "call", category: "edit", outcome: "completed" };
  expect(() => observeEvents(store, ACCOUNT, [{ ...identity, tool }])).toThrow(
    "Outbox entity kind is immutable",
  );
});

test("accounts keep separate queues, and the same fact has a different event ID in each", () => {
  const { store, rows } = memoryStore();
  observeEvents(store, ACCOUNT, [native()]);
  observeEvents(store, "account-b", [native()]);
  const [a, b] = rows();
  expect(a!.id).not.toBe(b!.id);
  expect(pendingBatch(store, ACCOUNT)!.eventIds).toEqual([a!.id]);
  expect(pendingBatch(store, "account-b")!.eventIds).toEqual([b!.id]);
  expect(() => observeEvents(store, "", [native()])).toThrow("Missing outbox account");
});

test("a frozen batch keeps its bytes while newer events wait for the next one", () => {
  const { store, rows } = memoryStore();
  observeEvents(store, ACCOUNT, [native("350")]);
  const first = pendingBatch(store, ACCOUNT)!;
  observeEvents(store, ACCOUNT, [native("400")]);
  const again = pendingBatch(store, ACCOUNT)!;
  expect(Buffer.from(again.body).equals(Buffer.from(first.body))).toBe(true);
  // The body splices the stored event bytes unchanged.
  expect(Buffer.from(first.body).toString()).toBe(
    `{"batch":{"version":1,"id":"${first.id}","events":[${Buffer.from(rows()[0]!.body)}]}}`,
  );
  expect(acknowledgeBatch(store, ACCOUNT, first, receipts(first))).toBe(true);
  expect(rows()[0]!.ackedAt).not.toBeNull();
  const second = pendingBatch(store, ACCOUNT)!;
  expect(second.eventIds).toEqual([rows()[1]!.id]);
  expect(acknowledgeBatch(store, ACCOUNT, second, receipts(second))).toBe(true);
  expect(pendingBatch(store, ACCOUNT)).toBeUndefined();
});

test("a batch holds at most 100 events", () => {
  const { store } = memoryStore();
  const many = Array.from({ length: 101 }, (_, index) => ({
    ...native(),
    entityId: `${ENTITY.slice(0, -3)}${String(index).padStart(3, "0")}`,
  }));
  observeEvents(store, ACCOUNT, many);
  expect(pendingBatch(store, ACCOUNT)!.eventIds).toHaveLength(100);
});

test("only a complete acknowledgement of the current batch advances it", () => {
  const { store, rows, frozen } = memoryStore();
  observeEvents(store, ACCOUNT, [native()]);
  const batch = pendingBatch(store, ACCOUNT)!;
  const ack = receipts(batch);
  expect(() => acknowledgeBatch(store, ACCOUNT, batch, { ...ack, receipts: [] })).toThrow(
    "Incomplete batch acknowledgement",
  );
  expect(() =>
    acknowledgeBatch(store, ACCOUNT, batch, {
      ...ack,
      receipts: [{ ...ack.receipts[0]!, status: "stored" }],
    }),
  ).toThrow("Invalid event acknowledgement");
  expect(() =>
    acknowledgeBatch(store, ACCOUNT, batch, {
      ...ack,
      receipts: [{ ...ack.receipts[0]!, revision: "2" }],
    }),
  ).toThrow("Invalid event acknowledgement");
  expect(() => acknowledgeBatch(store, "account-b", batch, ack)).toThrow("Outbox account changed");
  expect([rows()[0]!.ackedAt, frozen()]).toEqual([null, [batch]]);
  // A batch that is no longer the account's current one is someone else's to settle.
  expect(acknowledgeBatch(store, ACCOUNT, { ...batch, id: "other" }, ack)).toBe(false);
  expect(acknowledgeBatch(store, ACCOUNT, batch, ack)).toBe(true);
});

test("an event the server refused is set aside, and the next revision builds on the one it kept", () => {
  const { store, rows } = memoryStore();
  observeEvents(store, ACCOUNT, [native("350")]);
  const first = pendingBatch(store, ACCOUNT)!;
  acknowledgeBatch(store, ACCOUNT, first, receipts(first));
  observeEvents(store, ACCOUNT, [native("400")]);
  const refused = pendingBatch(store, ACCOUNT)!;
  acknowledgeBatch(store, ACCOUNT, refused, receipts(refused, "conflict"));
  expect(rows()[1]!.blocked).toBe("conflict");
  expect(pendingBatch(store, ACCOUNT)).toBeUndefined();
  // The same content is the same event: it is not stored or sent a second time.
  observeEvents(store, ACCOUNT, [native("400")]);
  expect(rows()).toHaveLength(2);
  observeEvents(store, ACCOUNT, [native("450")]);
  const next = decode(rows()[2]!);
  expect([next.revision, next.baseEventId]).toEqual(["2", rows()[0]!.id]);
});

test("a claim's later revisions inherit what they leave out", () => {
  const { store } = memoryStore();
  const allocation = { kind: "pull-request", pullRequestIds: ["2000000000"], method: "native" };
  observeEvents(store, ACCOUNT, [claim({ allocation })]);
  observeEvents(store, ACCOUNT, [claim({ claimState: "retracted" })]);
  const effective = effectiveClaim(store, ACCOUNT, ENTITY)!;
  expect(effective.allocation).toEqual(allocation);
  expect(effective.claimState).toBe("retracted");
  expect(effective.startedAt).toBe("2026-10-23T13:30:00Z");
  expect(effectiveClaim(store, ACCOUNT, "missing")).toBeUndefined();
});

test("a claim keeps its request, producer and start time, and a plain request never becomes one", () => {
  const { store, rows } = memoryStore();
  observeEvents(store, ACCOUNT, [claim()]);
  const other = "700a5684-c3af-425c-b289-3b79082e9eff";
  for (const [changed, message] of [
    [
      claim({ usage: { ...usage("350"), requestId: other } }),
      "Claim request identity, producer and repository are immutable",
    ],
    [
      claim({ deviceId: "c0c8ee08-2158-46df-a2e8-4b4e944d0a57" }),
      "Claim request identity, producer and repository are immutable",
    ],
    [claim({ startedAt: "2026-10-23T13:31:00Z" }), "Claim start time is immutable"],
    [{ ...native("400") }, "Claim source and request scope are immutable"],
  ] as const)
    expect(() => observeEvents(store, ACCOUNT, [changed])).toThrow(message);
  expect(rows()).toHaveLength(1);

  const plain = memoryStore();
  observeEvents(plain.store, ACCOUNT, [{ ...native(), source: "kimchi" }]);
  expect(() => observeEvents(plain.store, ACCOUNT, [claim()])).toThrow(
    "Native request identity cannot become a claim",
  );
});

test("a correction receipt names one outcome, and only a newer receipt replaces it", () => {
  const correction = {
    id: "6d0e2b7a-8f8b-4e5f-9a4d-1c2b3a4d5e6f",
    revision: 2,
    recordedAt: "2026-10-23T13:40:00Z",
    source: "work-command",
  };
  const linked = { kind: "pull-request", pullRequestIds: ["1"], method: "user-correction" };
  const previous = { ...claim({ allocation: linked, correction }), id: "id", revision: "1" };
  const next = (fields: Partial<Fact>) => ({ ...previous, ...fields });
  validateClaimUpdate(next({}), previous);
  expect(() =>
    validateClaimUpdate(next({ allocation: { ...linked, pullRequestIds: ["2"] } }), previous),
  ).toThrow("Conflicting contents for one correction receipt");
  expect(() =>
    validateClaimUpdate(next({ correction: { ...correction, revision: 1 } }), previous),
  ).toThrow("Correction receipt is not newer");
  expect(() =>
    validateClaimUpdate(
      next({ correction: { ...correction, id: "7d0e2b7a-8f8b-4e5f-9a4d-1c2b3a4d5e6f" } }),
      previous,
    ),
  ).toThrow("Correction receipt is not newer");
  validateClaimUpdate(
    next({ correction: { ...correction, revision: 3, recordedAt: "2026-10-23T13:41:00Z" } }),
    previous,
  );
  expect(() =>
    validateClaimUpdate(
      next({ correction: { ...correction, recordedAt: "2999-01-01T00:00:00Z" } }),
    ),
  ).toThrow("Correction receipt is in the future");
});

test("the caller's bookkeeping commits with the events, or neither does", () => {
  const { store, rows } = memoryStore();
  let committed = 0;
  observeEvents(store, ACCOUNT, [native()], undefined, () => committed++);
  expect([rows().length, committed]).toEqual([1, 1]);
  expect(() =>
    observeEvents(store, ACCOUNT, [native("400")], undefined, () => {
      throw new Error("bookkeeping failed");
    }),
  ).toThrow("bookkeeping failed");
  expect(rows()).toHaveLength(1);
  // The same guard runs first and last: a caller that lost its lease abandons the write.
  let calls = 0;
  expect(() =>
    observeEvents(store, ACCOUNT, [native("400")], () => {
      if (++calls === 2) throw new Error("lease lost");
    }),
  ).toThrow("lease lost");
  expect(rows()).toHaveLength(1);
});

test("stored bytes that no longer match their hash are refused, not sent", () => {
  const { store, rows } = memoryStore();
  observeEvents(store, ACCOUNT, [native()]);
  rows()[0]!.body = Buffer.from(Buffer.from(rows()[0]!.body).toString().replace("350", "351"));
  expect(() => pendingBatch(store, ACCOUNT)).toThrow("Outbox event hash mismatch");
  expect(() => observeEvents(store, ACCOUNT, [native("400")])).toThrow(
    "Outbox event hash mismatch",
  );
});

test("an event the ingest service would not admit is never stored", () => {
  const { store, rows } = memoryStore();
  expect(() => observeEvents(store, ACCOUNT, [{ ...native(), entityId: "not-a-uuid" }])).toThrow(
    "Invalid event identity",
  );
  expect(() => observeEvents(store, ACCOUNT, [native("350", "2999-01-01T00:00:00Z")])).toThrow(
    "Event outside supported accounting timestamps",
  );
  expect(rows()).toHaveLength(0);
});
