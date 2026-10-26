import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "../src/capture.ts";
import { Open, type Store } from "../src/ledger.ts";
import { Hash, Parse, type Event } from "../src/protocol.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pr-cost-model-hook-")));
  const root = join(base, "project");
  mkdirSync(root);
  const store = Open(join(base, "state")),
    recorder = new Recorder(store, "codex", store.DeviceID());
  cleanup.push(() => {
    store.Close();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, store, recorder };
}
function prompt(recorder: Recorder, root: string, turn: string, text = "implement") {
  recorder.Record({
    event: {
      hook_event_name: "UserPromptSubmit",
      session_id: "session",
      turn_id: turn,
      cwd: root,
      prompt: text,
    },
  });
}
function callback(root: string, extra: Record<string, unknown> = {}) {
  return Parse(
    JSON.stringify({
      hook_event_name: "PostModelRequest",
      session_id: "session",
      turn_id: "turn",
      cwd: root,
      model: "gpt-5.4",
      status: "completed",
      error: null,
      token_usage: {
        input_tokens: 31,
        cached_input_tokens: 13,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 2,
        total_tokens: 36,
      },
      ...extra,
    }),
  );
}
function observations(store: Store): Event[] {
  return store.Events().filter((e) => e.coverage?.code.startsWith("native_model_request_"));
}

test("identical completed callbacks remain two supplementary observations and never charge usage", () => {
  const { root, store, recorder } = fixture();
  recorder.Record({
    version: "0.164.0",
    event: { hook_event_name: "SessionStart", session_id: "session", cwd: root },
  });
  prompt(recorder, root, "turn");
  const native = callback(root);
  recorder.Record({ event: native });
  recorder.Record({ event: native });
  const records = observations(store);
  expect(records).toHaveLength(2);
  expect(records[0]!.entityId).not.toBe(records[1]!.entityId);
  expect(records[0]!.id).not.toBe(records[1]!.id);
  for (const e of records) {
    expect(e.source).toBe("codex");
    expect(e.sourceVersion).toBe("0.164.0");
    expect(e.turnId).toBe("turn");
    expect(e.workId).toBeTruthy();
    expect(e.usage).toBeUndefined();
    expect(e.coverage).toEqual({
      code: "native_model_request_completed",
      count: "1",
      model: "gpt-5.4",
      observedUsage: {
        inputTokens: "31",
        outputTokens: "5",
        cacheReadTokens: "13",
        cacheWriteTokens: "0",
        reasoningTokens: "2",
      },
    });
  }
  expect(store.Events().filter((e) => e.usage)).toHaveLength(0);
  expect(
    store.Events().filter((e) => e.coverage?.code === "native_auxiliary_usage_coverage_unknown"),
  ).toHaveLength(1);
  expect(store.Status().diagnostics.native_model_request_identity_missing).toBe(2);
  const batch = store.PendingBatch()!;
  expect(Hash(store.PendingBatch())).toBe(Hash(batch));
  store.Acknowledge(batch, {
    batchId: batch.id,
    receipts: batch.events.map((e) => ({ id: e.id!, revision: e.revision!, status: "accepted" })),
  });
  expect(store.PendingBatch()).toBeNull();
  const config = JSON.parse(
    readFileSync(new URL("../plugins/codex/hooks/hooks.json", import.meta.url), "utf8"),
  );
  const handler = config.hooks.PostModelRequest[0].hooks[0];
  expect(handler.type).toBe("command");
  expect(handler.timeout).toBe(3);
  expect(handler.async).toBeUndefined();
});

test("failure, cancellation and unknown status preserve missing usage and exclude raw error content", () => {
  const { root, store, recorder } = fixture();
  for (const status of ["failed", "cancelled", "SENSITIVE_STATUS"])
    recorder.Record({
      event: callback(root, {
        status,
        error: "SENSITIVE_ERROR",
        prompt: "SENSITIVE_PROMPT",
        tool_input: "SENSITIVE_ARGUMENT",
        token_usage: null,
      }),
    });
  expect(observations(store).map((e) => e.coverage!.code)).toEqual([
    "native_model_request_failed",
    "native_model_request_cancelled",
    "native_model_request_unknown",
  ]);
  for (const e of observations(store)) expect(e.coverage!.observedUsage).toBeUndefined();
  expect(JSON.stringify(store.Events()).includes("SENSITIVE")).toBe(false);
  for (const token_usage of [undefined, [], "SENSITIVE_USAGE", 7])
    recorder.Record({ event: callback(root, { token_usage }) });
  for (const e of observations(store)) expect(e.coverage!.observedUsage).toBeUndefined();
  expect(store.Events().some((e) => e.usage)).toBe(false);
});

test("model callbacks use exact turn or known agent work and never borrow a later session default", () => {
  const { root, store, recorder } = fixture();
  prompt(recorder, root, "first", "New work: first");
  const first = store.Events()[0]!.workId;
  recorder.Record({
    event: {
      hook_event_name: "SubagentStart",
      session_id: "session",
      turn_id: "first",
      agent_id: "child",
      cwd: root,
    },
  });
  prompt(recorder, root, "next", "New work: next");
  const next = store
    .Events()
    .filter((e) => e.work)
    .at(-1)!.workId;
  expect(first).not.toBe(next);
  recorder.Record({ event: callback(root, { turn_id: "first" }) });
  recorder.Record({ event: callback(root, { turn_id: "unknown" }) });
  recorder.Record({ event: callback(root, { turn_id: undefined }) });
  recorder.Record({ event: callback(root, { turn_id: "child-turn", agent_id: "child" }) });
  recorder.Record({ event: callback(root, { turn_id: "unknown", agent_id: "unseen-child" }) });
  const records = observations(store);
  expect(records[0]!.workId).toBe(first);
  expect(records[1]!.workId).toBeUndefined();
  expect(records[2]!.workId).toBeUndefined();
  expect(records[2]!.turnId).toBeUndefined();
  expect(records[3]!.workId).toBe(first);
  expect(records[3]!.agentId).toBe("child");
  expect(records[4]!.workId).toBeUndefined();
});

test("native counter normalization stays strict and never turns absent counters into zeros", () => {
  const { root, store, recorder } = fixture();
  recorder.Record({
    event: callback(root, {
      token_usage: { input_tokens: "31", cached_input_tokens: 0, output_tokens: 1.5 },
    }),
  });
  expect(observations(store)[0]!.coverage!.observedUsage).toEqual({ cacheReadTokens: "0" });
  for (const token_usage of [
    { input_tokens: -1 },
    { input_tokens: 1_000_000_000_001 },
    { output_tokens: 1, reasoning_output_tokens: 2 },
  ])
    expect(() => recorder.Record({ event: callback(root, { token_usage }) })).toThrow(
      "invalid typed event evidence",
    );
  expect(observations(store)).toHaveLength(1);
  expect(store.Events().some((e) => e.usage)).toBe(false);
});

test("model callbacks register native transcript/version without running recovery or changing financial records", () => {
  const { root, store, recorder } = fixture(),
    path = join(root, "rollout.jsonl");
  prompt(recorder, root, "turn");
  const at = "2026-10-23T12:30:40.123456789Z";
  const records = [
    { type: "session_meta", timestamp: at, payload: { cli_version: "0.164.0" } },
    { type: "turn_context", timestamp: at, payload: { turn_id: "turn", model: "gpt-5.4" } },
  ];
  for (const i of [1, 2])
    (records as any[]).push({
      type: "event_msg",
      timestamp: at,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 31, cached_input_tokens: 13, output_tokens: 5 },
          total_token_usage: { input_tokens: 31 * i, output_tokens: 5 * i },
        },
      },
    });
  writeFileSync(path, records.map((e) => JSON.stringify(e)).join("\n") + "\n");
  recorder.Record({ event: callback(root, { transcript_path: path }) });
  recorder.Record({ event: callback(root, { transcript_path: path }) });
  expect(observations(store).every((e) => e.sourceVersion === "0.164.0")).toBe(true);
  expect(store.Events().filter((e) => e.usage)).toHaveLength(0);
  expect(
    (
      store.DB.query(
        "SELECT count(*) AS n FROM meta WHERE key LIKE 'transcript:codex:%'",
      ).get() as any
    ).n,
  ).toBe(1);
  recorder.RecoverContext();
  expect(store.Events().filter((e) => e.usage)).toHaveLength(2);
  expect(observations(store)).toHaveLength(2);
});
