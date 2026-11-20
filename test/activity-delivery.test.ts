import { afterEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityStore, type ActivityBatch } from "../src/work/activity-store.ts";
import { flushActivity, flushAllActivities } from "../src/work/activity-delivery.ts";
import { parseJson } from "../src/work/protocol.ts";
import { workspaceActivityURL } from "../src/work/workspace.ts";
import type { Native } from "../src/work/capture.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_URL;
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function store(): ActivityStore {
  const dir = mkdtempSync(join(tmpdir(), "workspace-activity-"));
  const value = new ActivityStore(dir);
  cleanups.push(() => {
    value.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return value;
}
function nativeHooks(): Native[] {
  return readFileSync(join(import.meta.dir, "fixtures/claude-code-hooks.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => ({ event: parseJson(line) }) as Native);
}
function recordFixture(value: ActivityStore): void {
  for (const native of nativeHooks()) value.observe(native, "claude-code");
}
function endpoint(handler: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => running.stop(true));
  return new URL("/imds/tool-calls:batchRecord", running.url).href;
}
function ack(batch: ActivityBatch): Response {
  return Response.json({
    batchId: batch.batchId,
    receipts: batch.events.map((event) => ({
      eventId: event.eventId,
      status: "RECEIPT_STATUS_ACCEPTED",
    })),
  });
}

test("actual captured hooks become linked paired events and retain absence", () => {
  const value = store();
  const [before, after] = nativeHooks();
  value.observe(before, "claude-code");
  // Repeating a native PreToolUse callback is idempotent for the same call.
  value.observe(before, "claude-code");
  value.observe(after, "claude-code");
  recordFixture(value);
  const events = value.allEvents();
  expect(events).toHaveLength(4);
  expect(events[0].eventId).toMatch(/^[0-9a-f-]{36}$/);
  expect(events[1].eventId).toMatch(/^[0-9a-f-]{36}$/);
  expect(events[1].eventId).not.toBe(events[0].eventId);
  expect(events[1].causality?.causationId).toBe(events[0].eventId);
  expect(events[1].observation?.shellCommandOutput).toMatchObject({
    callId: "toolu_mock_bash_001",
    stdout: "/workspace/repo",
    stderr: "",
    durationMs: "60",
    outcome: "OUTCOME_COMPLETED",
  });
  expect(events[1].observation?.shellCommandOutput?.exitCode).toBeUndefined();
  expect(events[3].observation?.fileOperationResult).toMatchObject({
    callId: "toolu_mock_read_001",
    path: "/workspace/repo/fixture.txt",
    content: "activity-test: harmless synthetic value\n",
    durationMs: "6",
    outcome: "OUTCOME_COMPLETED",
  });
  expect(value.status().pending_events).toBe(4);
});

test("unknown results never fabricate an Action or lose a raw call identity", () => {
  const value = store();
  const after = nativeHooks()[1];
  value.observe(after, "claude-code");
  expect(value.allEvents()).toHaveLength(0);
  const code = value.db
    .query("SELECT code FROM diagnostics WHERE code='activity_preimage_missing'")
    .get();
  expect(code).toEqual({ code: "activity_preimage_missing" });
});

test("HTTP recording delivers actual protojson without credentials and removes pending bodies", async () => {
  const value = store();
  recordFixture(value);
  const received: ActivityBatch[] = [];
  const url = endpoint(async (request) => {
    const batch = parseJson(await request.text()) as ActivityBatch;
    received.push(batch);
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-castai-organization-id")).toBeNull();
    expect(request.headers.get("content-type")).toBe("application/json");
    return ack(batch);
  });
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = url;
  expect(workspaceActivityURL()).toBe(url);
  await flushAllActivities(value, url);
  expect(received).toHaveLength(1);
  expect(received[0].events).toHaveLength(4);
  expect(received[0].events[1].observation?.shellCommandOutput?.exitCode).toBeUndefined();
  expect(received[0].events[3].observation?.fileOperationResult?.content).toBe(
    "activity-test: harmless synthetic value\n",
  );
  expect(JSON.stringify(received)).not.toContain("organization_id");
  expect(JSON.stringify(received)).not.toContain("workspace_id");
  expect(value.status()).toMatchObject({
    pending_events: 0,
    pending_batches: 0,
    acknowledgements: 4,
  });
});

test("a failed reply retains the exact frozen batch for the retry", async () => {
  const value = store();
  recordFixture(value);
  let count = 0;
  const first = value.pendingBatch()!;
  const url = endpoint(async (request) => {
    const batch = parseJson(await request.text()) as ActivityBatch;
    if (++count === 1) return new Response("temporary", { status: 503 });
    expect(batch).toEqual(first);
    return ack(batch);
  });
  await expect(flushActivity(value, url)).rejects.toThrow("batch retained");
  expect(value.allEvents()).toHaveLength(4);
  expect(value.pendingBatch()).toEqual(first);
  await flushAllActivities(value, url);
  expect(count).toBe(2);
  expect(value.status().pending_events).toBe(0);
});

test("413 splits in causal order and acknowledgement advances each half", async () => {
  const value = store();
  recordFixture(value);
  const sizes: number[] = [];
  const url = endpoint(async (request) => {
    const batch = parseJson(await request.text()) as ActivityBatch;
    sizes.push(batch.events.length);
    return sizes.length === 1 ? new Response("too large", { status: 413 }) : ack(batch);
  });
  await flushAllActivities(value, url);
  expect(sizes).toEqual([4, 2, 2]);
  expect(value.status()).toMatchObject({
    pending_events: 0,
    pending_batches: 0,
    acknowledgements: 4,
  });
});

test("bad receipts do not advance the queue and terminal rejection is not retried forever", async () => {
  const value = store();
  recordFixture(value);
  let valid = false;
  const url = endpoint(async (request) => {
    const batch = parseJson(await request.text()) as ActivityBatch;
    if (!valid)
      return Response.json({
        batchId: batch.batchId,
        receipts: batch.events.map((event) => ({ eventId: event.eventId, status: "accepted" })),
      });
    return Response.json({
      batchId: batch.batchId,
      receipts: batch.events.map((event) => ({
        eventId: event.eventId,
        status: "RECEIPT_STATUS_REJECTED",
        reasonCode: "invalid_tool_event",
      })),
    });
  });
  await expect(flushActivity(value, url)).rejects.toThrow("invalid activity event receipt");
  expect(value.allEvents()).toHaveLength(4);
  valid = true;
  await flushAllActivities(value, url);
  expect(value.status()).toMatchObject({ pending_events: 0, rejected: 4, acknowledgements: 0 });
  recordFixture(value);
  expect(value.allEvents()).toHaveLength(0);
});

test("workspace activity accepts the exact sidekick IMDS destination", () => {
  const url = "http://__imds.kimchi.internal/imds/tool-calls:batchRecord";
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = url;
  expect(workspaceActivityURL()).toBe(url);
});

test("workspace activity rejects sidekick HTTPS and non-default ports", () => {
  for (const origin of ["https://__imds.kimchi.internal", "http://__imds.kimchi.internal:8080"]) {
    process.env.KIMCHI_BRIDGE_ACTIVITY_URL = `${origin}/imds/tool-calls:batchRecord`;
    expect(() => workspaceActivityURL()).toThrow("activity endpoint must be");
  }
});

test("workspace activity rejects a non-allowlisted remote override", () => {
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = "http://example.com/imds/tool-calls:batchRecord";
  expect(() => workspaceActivityURL()).toThrow("loopback");
});
