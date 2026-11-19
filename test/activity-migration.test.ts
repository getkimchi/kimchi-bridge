import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/platform.ts";
import { ActivityStore } from "../src/work/activity-store.ts";
import { activityAction, activityObservation } from "../src/work/activity.ts";
import { stringifyJson } from "../src/work/protocol.ts";
import { bodyText } from "../src/work/ledger.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function temporaryState(): string {
  const dir = mkdtempSync(join(tmpdir(), "activity-migration-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Explicit pre-upgrade schema, before semantic observations and source columns existed.
const legacySchema = `CREATE TABLE events(
  event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  body BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE batches(
  id TEXT PRIMARY KEY,
  body BLOB NOT NULL,
  ordering TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE actions(
  source TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY(source,trajectory_id,call_id)
);
CREATE TABLE receipts(
  event_id TEXT PRIMARY KEY,
  body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE diagnostics(code TEXT PRIMARY KEY,count INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`;

function legacyFixture(dir: string) {
  const native = {
    session_id: "legacy-session",
    cwd: "/workspace/repo",
    tool_name: "Bash",
    tool_use_id: "legacy-call",
    tool_input: { command: "pwd" },
  };
  const action = activityAction({
    source: "claude-code",
    stage: "PreToolUse",
    occurredAt: "2026-11-17T10:00:00.000Z",
    event: { ...native, hook_event_name: "PreToolUse" },
  });
  action.eventId = "11111111-1111-4111-8111-111111111111";
  const observation = activityObservation(action, {
    source: "claude-code",
    stage: "PostToolUse",
    occurredAt: "2026-11-17T10:00:00.060Z",
    event: {
      ...native,
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "legacy-output", stderr: "" },
    },
  });
  observation.eventId = "22222222-2222-4222-8222-222222222222";
  // The exact missing presence produced by the pre-timing-fix observer.
  delete observation.observation.shellCommandOutput!.durationMs;
  const body = stringifyJson(observation);
  const db = openDatabase(join(dir, "activity.sqlite"));
  db.exec(legacySchema);
  db.query("INSERT INTO actions(source,trajectory_id,call_id,body) VALUES(?,?,?,?)").run(
    "claude-code",
    "legacy-session",
    "legacy-call",
    Buffer.from(stringifyJson(action)),
  );
  db.query("INSERT INTO events(event_id,call_id,trajectory_id,body) VALUES(?,?,?,?)").run(
    action.eventId,
    "legacy-call",
    "legacy-session",
    Buffer.from(stringifyJson(action)),
  );
  db.query("INSERT INTO events(event_id,call_id,trajectory_id,body) VALUES(?,?,?,?)").run(
    observation.eventId,
    "legacy-call",
    "legacy-session",
    Buffer.from(body),
  );
  const batch = stringifyJson({ batchId: "legacy-batch", events: [action, observation] });
  db.query("INSERT INTO batches(id,body) VALUES(?,?)").run("legacy-batch", Buffer.from(batch));
  db.close();
  return {
    action,
    observation,
    batch,
    replay: {
      stage: "PostToolUse",
      event: {
        ...native,
        hook_event_name: "PostToolUse",
        tool_response: { stdout: "legacy-output", stderr: "" },
      },
    },
  };
}

test("v1 pending replay preserves the immutable frozen batch and original timestamp", () => {
  const dir = temporaryState();
  const fixture = legacyFixture(dir);
  const store = new ActivityStore(dir);
  expect(() => store.observe(fixture.replay, "claude-code")).not.toThrow();
  const stored = store.db.query("SELECT body FROM batches WHERE id='legacy-batch'").get() as {
    body: Uint8Array;
  };
  expect(bodyText(stored.body)).toBe(fixture.batch);
  expect(store.pendingBatch()?.events.map((event) => event.eventId)).toEqual([
    fixture.action.eventId,
    fixture.observation.eventId,
  ]);
  expect(
    store.pendingBatch()?.events[1].observation?.shellCommandOutput?.durationMs,
  ).toBeUndefined();
  store.close();
});

test("v1 replay remains idempotent after the migrated batch is acknowledged", () => {
  const dir = temporaryState();
  const fixture = legacyFixture(dir);
  const store = new ActivityStore(dir);
  store.acknowledge(store.pendingBatch()!, {
    batchId: "legacy-batch",
    receipts: [
      { eventId: fixture.observation.eventId, status: "RECEIPT_STATUS_ACCEPTED" },
      { eventId: fixture.action.eventId, status: "RECEIPT_STATUS_ACCEPTED" },
    ],
  });
  expect(store.pendingBatch()).toBeNull();
  expect(() => store.observe(fixture.replay, "claude-code")).not.toThrow();
  expect(store.pendingBatch()).toBeNull();
  expect(
    store.db
      .query("SELECT event_id,body_sha256 FROM receipts WHERE event_id=?")
      .get(fixture.observation.eventId),
  ).toEqual({
    event_id: fixture.observation.eventId,
    body_sha256: createHash("sha256").update(stringifyJson(fixture.observation)).digest("hex"),
  });
  store.close();
});

test("a flattened generic tool retains its result when after-hook-only fields appear", () => {
  const dir = temporaryState();
  const store = new ActivityStore(dir);
  const native = {
    session_id: "generic-session",
    cwd: "/workspace/repo",
    tool_name: "custom_tool",
    tool_use_id: "generic-call",
    payload: { message: "input" },
  };
  store.observe({ stage: "PreToolUse", event: native }, "claude-code");
  store.observe(
    {
      stage: "PostToolUse",
      event: {
        ...native,
        hook_event_name: "PostToolUse",
        tool_response: { message: "output" },
        duration_ms: 2,
      },
    },
    "claude-code",
  );
  const events = store.allEvents();
  expect(events).toHaveLength(2);
  expect(events[1].observation?.toolOutput?.output?.data).toBe('{"message":"output"}');
  expect(events[1].causality?.causationId).toBe(events[0].eventId);
  expect(events[1].observation?.toolOutput?.output).toMatchObject({ complete: true });
  store.close();
});

test("changed legacy evidence gets a new linked event without replacing the frozen body", () => {
  const dir = temporaryState();
  const fixture = legacyFixture(dir);
  const store = new ActivityStore(dir);
  store.observe(
    {
      ...fixture.replay,
      event: {
        ...fixture.replay.event,
        tool_response: { stdout: "different-output", stderr: "" },
      },
    },
    "claude-code",
  );
  const frozen = store.db.query("SELECT body FROM batches WHERE id='legacy-batch'").get() as {
    body: Uint8Array;
  };
  expect(bodyText(frozen.body)).toBe(fixture.batch);
  const events = store.allEvents();
  expect(events).toHaveLength(3);
  expect(events[1].eventId).toBe(fixture.observation.eventId);
  expect(events[2].eventId).not.toBe(fixture.observation.eventId);
  expect(events[2].causality?.causationId).toBe(fixture.action.eventId);
  expect(events[2].observation?.shellCommandOutput?.stdout).toBe("different-output");
  store.close();
});
