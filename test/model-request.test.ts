import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "../src/work/capture.ts";
import { Store } from "../src/work/ledger.ts";
import { canonicalHash, parseJson, type Event } from "../src/work/protocol.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pr-cost-model-hook-")));
  const root = join(base, "project");
  mkdirSync(root);
  const store = new Store(join(base, "state")),
    recorder = new Recorder(store, "codex", store.deviceId());
  cleanup.push(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, store, recorder };
}
function prompt(recorder: Recorder, root: string, turn: string, text = "implement") {
  recorder.record({
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
  return parseJson(
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
  return store.events().filter((e) => e.coverage?.code.startsWith("native_model_request_"));
}

test("identical completed callbacks remain two supplementary observations and never charge usage", () => {
  const { root, store, recorder } = fixture();
  recorder.record({
    version: "0.164.0",
    event: { hook_event_name: "SessionStart", session_id: "session", cwd: root },
  });
  prompt(recorder, root, "turn");
  const native = callback(root);
  recorder.record({ event: native });
  recorder.record({ event: native });
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
  expect(store.events().filter((e) => e.usage)).toHaveLength(0);
  expect(
    store.events().filter((e) => e.coverage?.code === "native_auxiliary_usage_coverage_unknown"),
  ).toHaveLength(1);
  expect(store.status().diagnostics.native_model_request_identity_missing).toBe(2);
  const batch = store.pendingBatch()!;
  expect(canonicalHash(store.pendingBatch())).toBe(canonicalHash(batch));
  store.acknowledge(batch, {
    batchId: batch.id,
    receipts: batch.events.map((e) => ({ id: e.id!, revision: e.revision!, status: "accepted" })),
  });
  expect(store.pendingBatch()).toBeNull();
  const config = JSON.parse(
    readFileSync(new URL("../plugins/kimchi-work/codex/hooks/hooks.json", import.meta.url), "utf8"),
  );
  const handler = config.hooks.PostModelRequest[0].hooks[0];
  expect(handler.type).toBe("command");
  expect(handler.timeout).toBe(3);
  expect(handler.async).toBeUndefined();
});

test("failure, cancellation and unknown status preserve missing usage and exclude raw error content", () => {
  const { root, store, recorder } = fixture();
  for (const status of ["failed", "cancelled", "SENSITIVE_STATUS"])
    recorder.record({
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
  expect(JSON.stringify(store.events()).includes("SENSITIVE")).toBe(false);
  for (const token_usage of [undefined, [], "SENSITIVE_USAGE", 7])
    recorder.record({ event: callback(root, { token_usage }) });
  for (const e of observations(store)) expect(e.coverage!.observedUsage).toBeUndefined();
  expect(store.events().some((e) => e.usage)).toBe(false);
});

test("model callbacks use exact turn or known agent work and never borrow a later session default", () => {
  const { root, store, recorder } = fixture();
  prompt(recorder, root, "first", "New work: first");
  const first = store.events()[0]!.workId;
  recorder.record({
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
    .events()
    .filter((e) => e.work)
    .at(-1)!.workId;
  expect(first).not.toBe(next);
  recorder.record({ event: callback(root, { turn_id: "first" }) });
  recorder.record({ event: callback(root, { turn_id: "unknown" }) });
  recorder.record({ event: callback(root, { turn_id: undefined }) });
  recorder.record({ event: callback(root, { turn_id: "child-turn", agent_id: "child" }) });
  recorder.record({ event: callback(root, { turn_id: "unknown", agent_id: "unseen-child" }) });
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
  recorder.record({
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
    expect(() => recorder.record({ event: callback(root, { token_usage }) })).toThrow(
      "invalid typed event evidence",
    );
  expect(observations(store)).toHaveLength(1);
  expect(store.events().some((e) => e.usage)).toBe(false);
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
  recorder.record({ event: callback(root, { transcript_path: path }) });
  recorder.record({ event: callback(root, { transcript_path: path }) });
  expect(observations(store).every((e) => e.sourceVersion === "0.164.0")).toBe(true);
  expect(store.events().filter((e) => e.usage)).toHaveLength(0);
  expect(
    (
      store.db
        .query("SELECT count(*) AS n FROM meta WHERE key LIKE 'transcript:codex:%'")
        .get() as any
    ).n,
  ).toBe(1);
  recorder.recoverContext();
  expect(store.events().filter((e) => e.usage)).toHaveLength(2);
  expect(observations(store)).toHaveLength(2);
});
