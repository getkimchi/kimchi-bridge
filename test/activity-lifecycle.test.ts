import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityCapacityError,
  ActivityStore,
  type ActivityRetention,
} from "../src/work/activity-store.ts";
import type { Native } from "../src/work/capture.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function store(limits?: ActivityRetention): ActivityStore {
  const dir = mkdtempSync(join(tmpdir(), "activity-lifecycle-"));
  const value = new ActivityStore(dir, { databaseBytes: 8 << 20, ...limits });
  cleanups.push(() => {
    value.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return value;
}
function call(value: ActivityStore, id: string): void {
  const event = {
    session_id: "retention-session",
    cwd: "/workspace/repo",
    tool_use_id: id,
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  };
  value.observe({ stage: "PreToolUse", event }, "claude-code");
  value.observe(
    {
      stage: "PostToolUse",
      event: {
        ...event,
        tool_response: { stdout: "/workspace/repo", stderr: "" },
        duration_ms: 10,
      },
    },
    "claude-code",
  );
}
function accept(value: ActivityStore): void {
  const batch = value.pendingBatch();
  if (!batch) throw new Error("expected an activity batch");
  value.acknowledge(batch, {
    batchId: batch.batchId,
    receipts: batch.events.map((e) => ({ eventId: e.eventId, status: "RECEIPT_STATUS_ACCEPTED" })),
  });
}

test("aged preimages and receipts are pruned with their deduplication metadata", () => {
  const value = store();
  call(value, "finished");
  accept(value);
  const now = Math.floor(Date.now() / 1000) + 31 * 86400;
  value.db.query("UPDATE actions SET last_seen_at=?").run(now - value.limits.actionSeconds - 1);
  value.db.query("UPDATE receipts SET received_at=?").run(now - value.limits.receiptSeconds - 1);
  value.prune(now);
  expect(value.status()).toMatchObject({
    preimages: 0,
    observations: 0,
    receipts: 0,
    pending_events: 0,
  });
  expect(value.status().storage).toMatchObject({ actionBytes: 0 });
});

test("retention never removes an active preimage referenced by a pending event", () => {
  const value = store();
  call(value, "offline");
  const before = value.allEvents();
  const now = Math.floor(Date.now() / 1000) + 365 * 86400;
  value.db.query("UPDATE actions SET last_seen_at=0").run();
  value.prune(now);
  expect(value.status()).toMatchObject({ preimages: 1, observations: 1, pending_events: 2 });
  expect(value.allEvents()).toEqual(before);
});

test("byte-budget pruning removes an older completed preimage but protects a pending call", () => {
  const first = store();
  call(first, "oldest");
  const cost = Buffer.from(
    (first.db.query("SELECT body FROM actions").get() as { body: Uint8Array }).body,
  ).byteLength;
  accept(first);
  const value = store({ actionBytes: cost });
  call(value, "oldest");
  accept(value);
  const secondBody = (
    value.db.query("SELECT body FROM actions LIMIT 1").get() as { body: Uint8Array }
  ).body;
  call(value, "new-pending");
  value.prune();
  // The older completed preimage is reclaimable; the pending one is not,
  // even when its payload is slightly larger than the selected cache budget.
  const pending = value.db.query("SELECT body FROM actions WHERE call_id='new-pending'").get() as {
    body: Uint8Array;
  };
  expect((value.status().storage as { actionBytes: number }).actionBytes).toBe(
    Buffer.from(pending.body).byteLength,
  );
  expect(value.status()).toMatchObject({ preimages: 1, pending_events: 2 });
  expect(secondBody).not.toEqual(
    (value.db.query("SELECT body FROM actions LIMIT 1").get() as { body: Uint8Array }).body,
  );
});

test("receipt caches retain the newest bounded deduplication identities", () => {
  const value = store({ receiptRecords: 2 });
  for (const id of ["first", "second", "third"]) {
    call(value, id);
    accept(value);
  }
  const retained = value.db.query("SELECT event_id FROM receipts ORDER BY rowid").all() as {
    event_id: string;
  }[];
  const last = value.db
    .query("SELECT event_id FROM observations ORDER BY rowid DESC LIMIT 1")
    .get() as { event_id: string };
  expect(retained).toHaveLength(2);
  expect(retained[1].event_id).toBe(last.event_id);
  const newest = retained[0].event_id;
  const now = Math.floor(Date.now() / 1000);
  value.db
    .query("UPDATE receipts SET received_at=? WHERE event_id=?")
    .run(now - value.limits.receiptSeconds - 1, newest);
  value.prune(now);
  expect(
    (value.db.query("SELECT count(*) AS value FROM receipts").get() as { value: number }).value,
  ).toBe(1);
});

test("pending byte budgets fail atomically and report visible backpressure", () => {
  const value = store({ pendingBytes: 1 });
  const event = {
    session_id: "bounded-session",
    cwd: "/workspace/repo",
    tool_use_id: "capacity-call",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  };
  expect(() => value.observe({ stage: "PreToolUse", event }, "claude-code")).toThrow(
    ActivityCapacityError,
  );
  expect(value.status()).toMatchObject({ pending_events: 0, preimages: 0 });
  expect(value.status().diagnostics).toEqual({ activity_backpressure: 1 });
  expect((value.status().storage as { pendingByteLimit: number }).pendingByteLimit).toBe(1);
});

test("status exposes missing preimages and diagnostics instead of a false healthy state", () => {
  const value = store();
  const missing: Native = {
    stage: "PostToolUse",
    event: {
      session_id: "missing-session",
      cwd: "/workspace/repo",
      tool_name: "Bash",
      tool_use_id: "no-action",
      tool_input: { command: "pwd" },
      tool_response: { stdout: "/workspace/repo", stderr: "" },
    },
  };
  value.observe(missing, "claude-code");
  expect(value.status().diagnostics).toEqual({ activity_preimage_missing: 1 });
  expect(value.status()).toMatchObject({ rejected: 0, pending_events: 0 });
});

test("an incomplete aged Action expires without inventing an outcome", () => {
  const value = store();
  const event = {
    session_id: "abandoned-session",
    cwd: "/workspace/repo",
    tool_use_id: "abandoned-call",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  };
  value.observe({ stage: "PreToolUse", event }, "claude-code");
  accept(value);
  const now = Math.floor(Date.now() / 1000);
  value.db.query("UPDATE actions SET last_seen_at=?").run(now - value.limits.actionSeconds - 1);
  value.prune(now);
  expect(value.status()).toMatchObject({ preimages: 0, observations: 0, pending_events: 0 });
  value.observe(
    { stage: "PostToolUse", event: { ...event, tool_response: { stdout: "/workspace/repo" } } },
    "claude-code",
  );
  expect(value.status().diagnostics).toEqual({ activity_preimage_missing: 1 });
});

test("database exhaustion returns typed backpressure without a partially credited preimage", () => {
  const value = store({ databaseBytes: 1 << 20 });
  let error: unknown;
  for (let index = 0; index < 32; index++) {
    const event = {
      session_id: "storage-capacity",
      cwd: "/workspace/repo",
      tool_use_id: `capacity-${index}`,
      tool_name: "Bash",
      tool_input: { command: "x".repeat(64 << 10) },
    };
    try {
      value.observe({ stage: "PreToolUse", event }, "claude-code");
    } catch (cause) {
      error = cause;
      break;
    }
  }
  expect(error).toBeInstanceOf(ActivityCapacityError);
  expect((error as ActivityCapacityError).code).toBe("activity_backpressure");
  const events = value.allEvents();
  expect(events.length).toBeGreaterThan(0);
  expect(
    (value.db.query("SELECT count(*) AS value FROM actions").get() as { value: number }).value,
  ).toBe(events.length);
  expect(
    (value.status().diagnostics as Record<string, number>).activity_backpressure,
  ).toBeGreaterThan(0);
});

test("a busy retention lock defers cleanup without aborting capture", () => {
  const value = store();
  value.prune = () => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  };
  expect(() => value.pruneIfDue()).not.toThrow();
  expect(value.status().diagnostics).toEqual({ activity_retention_pending: 1 });
});

test("competing-process capture survives cleanup and late receipts", async () => {
  const value = store();
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, "helpers/activity-worker.ts"), value.dir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: value.dir },
    },
  );
  let output = "",
    errors = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  let finished = false;
  try {
    const deadline = Date.now() + 5000;
    while (
      (value.db.query("SELECT count(*) AS value FROM actions").get() as { value: number }).value ===
      0
    ) {
      if (Date.now() > deadline) throw new Error("worker produced no tool Action");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let index = 0; index < 12; index++) {
      value.prune();
      await Promise.resolve();
    }
    expect(await done).toBe(0);
    finished = true;
    expect(JSON.parse(output)).toMatchObject({ pending_events: 6, preimages: 3, observations: 3 });
    const batch = value.pendingBatch()!;
    value.acknowledge(batch, {
      batchId: batch.batchId,
      receipts: batch.events.map((event) => ({
        eventId: event.eventId,
        status: "RECEIPT_STATUS_ACCEPTED",
      })),
    });
    expect(value.status()).toMatchObject({ pending_events: 0, observations: 3 });
    value.prune(Math.floor(Date.now() / 1000) + 31 * 86400);
    expect(value.status()).toMatchObject({ pending_events: 0, preimages: 0, observations: 0 });
  } catch (error) {
    if (errors) throw new Error(errors);
    throw error;
  } finally {
    if (!finished) child.kill();
  }
});
