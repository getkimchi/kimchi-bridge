import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activityAction,
  activityObservation,
  type ActivityInput,
  type WorkspaceActionEvent,
} from "../src/work/activity.ts";
import { ActivityStore, type ActivityBatch } from "../src/work/activity-store.ts";
import type { Native } from "../src/work/capture.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function store(): ActivityStore {
  const dir = mkdtempSync(join(tmpdir(), "activity-review-"));
  const value = new ActivityStore(dir);
  cleanups.push(() => {
    value.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return value;
}
function input(tool: "Bash" | "Read" | "custom_tool" = "Bash"): ActivityInput {
  return {
    source: "claude-code",
    stage: "PostToolUse",
    sessionId: "review-session",
    cwd: "/workspace/repo",
    occurredAt: "2026-11-17T10:00:00.060Z",
    event: {
      tool_name: tool,
      tool_use_id: "review-tool-1",
      tool_input:
        tool === "Read" ? { file_path: "/workspace/repo/fixture.txt" } : { command: "pwd" },
    },
  };
}
function observation(before: WorkspaceActionEvent, body: Partial<ActivityInput>) {
  const occurredAt = new Date(Date.parse(before.occurredAt) + 60).toISOString();
  return activityObservation(before, { ...input(), occurredAt, ...body } as ActivityInput);
}

test("supported mod Bash, Read and unknown payload results are not discarded", () => {
  const bash = observation(activityAction({ ...input(), stage: "PreToolUse" }), {
    stage: "tool.after",
    result: { stdout: "/tmp", stderr: "", durationMs: 60 },
  });
  expect(bash.observation.shellCommandOutput).toMatchObject({
    stdout: "/tmp",
    stderr: "",
    durationMs: "60",
    outcome: "OUTCOME_COMPLETED",
  });
  const read = observation(activityAction({ ...input("Read"), stage: "PreToolUse" }), {
    stage: "tool.after",
    result: { result: "fixture-content\n" },
  });
  expect(read.observation.fileOperationResult).toMatchObject({
    path: "/workspace/repo/fixture.txt",
    content: "fixture-content\n",
  });
  const unknown = observation(activityAction({ ...input(), stage: "PreToolUse" }), {
    stage: "tool.after",
    result: { result: { payload: { message: "preserve-me" } } },
  });
  expect(unknown.observation.toolOutput?.output).toMatchObject({
    complete: true,
    data: '{"payload":{"message":"preserve-me"}}',
  });
});

test("oversized error text keeps a bounded raw result instead of rejecting the observation", () => {
  const original = "─".repeat(1400);
  const event = observation(activityAction({ ...input(), stage: "PreToolUse" }), {
    stage: "PostToolUseFailure",
    event: { ...input().event, tool_response: { error: original } },
  });
  expect(event.observation.toolOutput).toMatchObject({
    success: false,
    outcome: "OUTCOME_FAILED",
    output: {
      encoding: "PAYLOAD_ENCODING_JSON",
      complete: true,
      originalBytes: String(Buffer.byteLength('{"error":' + JSON.stringify(original) + "}")),
    },
  });
  expect(event.observation.toolOutput?.error).toBeUndefined();
  expect(event.observation.toolOutput?.output?.data).toBe(
    '{"error":' + JSON.stringify(original) + "}",
  );
  const bounded = observation(activityAction({ ...input(), stage: "PreToolUse" }), {
    stage: "PostToolUseFailure",
    event: { ...input().event, tool_response: { error: "─".repeat(1365) } },
  });
  expect(bounded.observation.toolOutput?.error).toBe("─".repeat(1365));
});

test("explicit interruption determines completed, failed and generic outcomes", () => {
  const response = { stdout: "", stderr: "", interrupted: true };
  const shell = observation(activityAction({ ...input(), stage: "PreToolUse" }), {
    event: { ...input().event, tool_response: response },
  });
  expect(shell.observation.shellCommandOutput?.outcome).toBe("OUTCOME_INTERRUPTED");
  const generic = observation(activityAction({ ...input("custom_tool"), stage: "PreToolUse" }), {
    stage: "PostToolUseFailure",
    result: { result: { interrupted: true }, isError: true },
  });
  expect(generic.observation.toolOutput).toMatchObject({
    success: false,
    outcome: "OUTCOME_INTERRUPTED",
  });
});

function native(id: string): Record<string, any> {
  return {
    session_id: "review-session",
    cwd: "/workspace/repo",
    tool_name: "Bash",
    tool_use_id: id,
    turn_id: "turn-1",
    tool_input: { command: "pwd" },
  };
}
function before(id: string): Native {
  return { stage: "tool.before", event: native(id), version: "2.1.326" };
}
function modAfter(id: string, stdout = "/workspace/repo"): Native {
  return { stage: "tool.after", event: native(id), result: { stdout, stderr: "", durationMs: 60 } };
}
function classicAfter(id: string, stdout = "/workspace/repo", exitCode?: number): Native {
  return {
    stage: "PostToolUse",
    event: {
      ...native(id),
      tool_response: {
        stdout,
        stderr: "",
        ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      },
      duration_ms: 60,
    },
  };
}
function ackAll(value: ActivityStore): ActivityBatch {
  const batch = value.pendingBatch();
  if (!batch) throw new Error("expected pending activity");
  value.acknowledge(batch, {
    batchId: batch.batchId,
    receipts: batch.events.map((event) => ({
      eventId: event.eventId,
      status: "RECEIPT_STATUS_ACCEPTED",
    })),
  });
  return batch;
}

test("mod and classic observations deduplicate in both orders", () => {
  for (const classicFirst of [false, true]) {
    const value = store();
    value.observe(before("shared-call"), "claude-code");
    if (classicFirst) {
      value.observe(classicAfter("shared-call"), "claude-code");
      value.observe(modAfter("shared-call"), "claude-code");
    } else {
      value.observe(modAfter("shared-call"), "claude-code");
      value.observe(classicAfter("shared-call"), "claude-code");
    }
    const events = value.allEvents();
    expect(events).toHaveLength(2);
    expect(events[1].observation?.shellCommandOutput?.stdout).toBe("/workspace/repo");
    expect(events[1].causality?.causationId).toBe(events[0].eventId);
    expect(events[1].observation?.shellCommandOutput?.durationMs).toBe("60");
  }
});

test("an exact duplicate without duration preserves the first event and accepted body", () => {
  const value = store();
  value.observe(before("replay"), "claude-code");
  const after = classicAfter("replay");
  delete after.event.duration_ms;
  value.observe(after, "claude-code");
  const first = value.allEvents()[1];
  const now = Date.now;
  Date.now = () => now() + 100;
  try {
    value.observe(after, "claude-code");
  } finally {
    Date.now = now;
  }
  expect(value.allEvents()).toHaveLength(2);
  expect(value.allEvents()[1]).toEqual(first);
  value.acknowledge(value.pendingBatch()!, {
    batchId: value.pendingBatch()!.batchId,
    receipts: value
      .pendingBatch()!
      .events.map((e) => ({ eventId: e.eventId, status: "RECEIPT_STATUS_ACCEPTED" })),
  });
  expect(value.allEvents()).toHaveLength(0);
  value.observe(after, "claude-code");
  expect(value.allEvents()).toHaveLength(0);
  expect(value.allEvents()[0]?.eventId).toBeUndefined();
});

test("new evidence is a distinct linked observation after acknowledgement, not an overwrite", () => {
  const value = store();
  value.observe(before("enriched-call"), "claude-code");
  value.observe(modAfter("enriched-call"), "claude-code");
  const delivered = ackAll(value);
  value.observe(classicAfter("enriched-call", "/workspace/repo", 0), "claude-code");
  const events = value.allEvents();
  expect(events).toHaveLength(1);
  expect(events[0].eventId).not.toBe(delivered.events[1].eventId);
  expect(events[0].observation?.shellCommandOutput).toMatchObject({
    stdout: "/workspace/repo",
    exitCode: 0,
  });
  expect(events[0].causality?.causationId).toBe(delivered.events[0].eventId);
  const prior = value.db
    .query("SELECT event_id,status FROM receipts WHERE event_id=?")
    .get(delivered.events[1].eventId);
  expect(prior).toEqual({
    event_id: delivered.events[1].eventId,
    status: "RECEIPT_STATUS_ACCEPTED",
  });
});

test("mixed-status receipts are joined by event identity even when reversed", () => {
  const value = store();
  value.observe(before("first"), "claude-code");
  value.observe(classicAfter("first"), "claude-code");
  value.observe(before("second"), "claude-code");
  value.observe(modAfter("second"), "claude-code");
  const batch = value.pendingBatch()!;
  const expected = new Map(
    batch.events.map((event, index) => [
      event.eventId,
      index === 0
        ? { status: "RECEIPT_STATUS_REJECTED", reason_code: "bad_event" }
        : { status: "RECEIPT_STATUS_ACCEPTED", reason_code: "" },
    ]),
  );
  value.acknowledge(batch, {
    batchId: batch.batchId,
    receipts: [...batch.events].reverse().map((event) => ({
      eventId: event.eventId,
      status: expected.get(event.eventId)!.status as
        | "RECEIPT_STATUS_ACCEPTED"
        | "RECEIPT_STATUS_REJECTED",
      reasonCode: expected.get(event.eventId)!.reason_code,
    })),
  });
  for (const [id, result] of expected)
    expect(
      value.db.query("SELECT status,reason_code FROM receipts WHERE event_id=?").get(id),
    ).toEqual(result);
  expect(value.allEvents()).toHaveLength(0);
});
