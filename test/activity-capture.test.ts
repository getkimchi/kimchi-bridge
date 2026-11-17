import { expect, test } from "bun:test";
import {
  TOOL_ACTIVITY_LIMITS,
  activityAction,
  activityObservation,
  contentPayload,
  validateActivityEvent,
  type ActivityInput,
} from "../src/work/activity.ts";

const before: ActivityInput = {
  source: "claude-code",
  stage: "PreToolUse",
  sessionId: "session-7",
  cwd: "/workspace/repo",
  version: "2.1.311",
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-11-16T10:15:02.000Z",
  event: {
    tool_name: "Bash",
    tool_use_id: "toolu_bash_001",
    tool_input: { command: "git status --short" },
  },
};

const after = (
  action: ReturnType<typeof activityAction>,
  input: Partial<ActivityInput>,
): ReturnType<typeof activityObservation> =>
  activityObservation(action, {
    ...before,
    ...input,
    eventId: "22222222-2222-4222-8222-222222222222",
    occurredAt: "2026-11-16T10:15:02.183Z",
  });

test("Claude Bash Action preserves the exact command and hook attribution", () => {
  const event = activityAction(before);
  expect(event).toEqual({
    eventId: before.eventId!,
    occurredAt: before.occurredAt!,
    trajectoryId: "session-7",
    agent: { id: "main", platform: "claude-code", platformVersion: "2.1.311" },
    actor: { id: "main", type: "ACTOR_TYPE_AGENT" },
    action: {
      shellCommand: {
        callId: "toolu_bash_001",
        command: "git status --short",
        workingDir: "/workspace/repo",
      },
    },
  });
  expect(validateActivityEvent(event)).toEqual([]);
  expect(JSON.stringify(event)).not.toContain("workspace_id");
  expect(JSON.stringify(event)).not.toContain("organization_id");
});

test("Claude Bash Observation captures structured execution fields and causation", () => {
  const event = after(activityAction(before), {
    stage: "PostToolUse",
    event: {
      ...before.event,
      tool_response: {
        stdout: " M src/auth.ts\n",
        stderr: "",
        exit_code: 0,
      },
    },
  });
  expect(event).toMatchObject({
    eventId: "22222222-2222-4222-8222-222222222222",
    trajectoryId: "session-7",
    causality: { causationId: before.eventId },
    observation: {
      shellCommandOutput: {
        callId: "toolu_bash_001",
        exitCode: 0,
        stdout: " M src/auth.ts\n",
        stderr: "",
        outcome: "OUTCOME_COMPLETED",
        durationMs: "183",
      },
      invocation: {
        shellCommand: {
          callId: "toolu_bash_001",
          command: "git status --short",
          workingDir: "/workspace/repo",
        },
      },
    },
  });
  expect(validateActivityEvent(event)).toEqual([]);
});

test("Codex command output preserves the full raw result and only parses the documented exit prefix", () => {
  const event = after(activityAction(before), {
    stage: "PostToolUse",
    event: {
      ...before.event,
      tool_response: "Exit code: 0\n M src/auth.ts\n",
    },
  });
  const output = event.observation.shellCommandOutput!;
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toBe(" M src/auth.ts\n");
  expect(output.stderr).toBeUndefined();
  expect(output.durationMs).toBe("183");
});

test("WebFetch keeps its URL, prompt, status and provider text", () => {
  const web: ActivityInput = {
    ...before,
    event: {
      tool_name: "WebFetch",
      tool_use_id: "web-1",
      tool_input: { url: "https://api.github.com/repos/acme/app/pulls", prompt: "List PRs" },
    },
  };
  const event = after(activityAction(web), {
    event: {
      ...web.event,
      tool_response: { status: 200, text: '[{"number":42}]' },
    },
  });
  expect(event.observation).toEqual({
    webFetchOutput: {
      callId: "web-1",
      url: "https://api.github.com/repos/acme/app/pulls",
      code: 200,
      result: '[{"number":42}]',
      outcome: "OUTCOME_COMPLETED",
      durationMs: "183",
    },
    invocation: {
      webFetch: {
        callId: "web-1",
        url: "https://api.github.com/repos/acme/app/pulls",
        prompt: "List PRs",
      },
    },
  });
  expect(validateActivityEvent(event)).toEqual([]);
});

test("FileOperation read preserves path and content", () => {
  const read: ActivityInput = {
    ...before,
    event: {
      tool_name: "Read",
      tool_use_id: "read-1",
      tool_input: { file_path: "/workspace/repo/src/config.toml" },
    },
  };
  const event = after(activityAction(read), {
    event: { ...read.event, tool_response: "max_retries = 3\n" },
  });
  expect(event.observation.fileOperationResult).toEqual({
    callId: "read-1",
    success: true,
    path: "/workspace/repo/src/config.toml",
    content: "max_retries = 3\n",
    outcome: "OUTCOME_COMPLETED",
    durationMs: "183",
  });
  expect(validateActivityEvent(event)).toEqual([]);
});

test("multi-file patches remain rich generic ToolCall events rather than a lossy single FileOperation", () => {
  const patch =
    "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Update File: b.ts\n@@\n-old\n+new\n*** End Patch";
  const input: ActivityInput = {
    source: "codex",
    stage: "PostToolUse",
    sessionId: "session-7",
    cwd: "/workspace/repo",
    eventId: "33333333-3333-4333-8333-333333333333",
    occurredAt: "2026-11-16T10:15:05.000Z",
    event: {
      tool_name: "apply_patch",
      tool_use_id: "patch-1",
      tool_input: { command: patch },
      tool_response: "Success. Updated the following files:\n M a.ts\n M b.ts",
    },
  };
  const action = activityAction(input);
  expect(action.action.toolCall?.callId).toBe("patch-1");
  expect(action.action.toolCall?.arguments?.data).toBe(
    '{"command":"' + JSON.stringify(patch).slice(1, -1) + '"}',
  );
  const event = activityObservation(action, input);
  expect(event.observation.toolOutput).toMatchObject({
    callId: "patch-1",
    success: true,
    output: {
      encoding: "PAYLOAD_ENCODING_UTF8",
      data: "Success. Updated the following files:\n M a.ts\n M b.ts",
      complete: true,
    },
  });
  expect(event.observation.fileOperationResult).toBeUndefined();
});

test("array-shaped shell input falls back to a rich ToolCall without inventing a command string", () => {
  const event = activityAction({
    ...before,
    source: "codex",
    event: {
      tool: "exec_command",
      toolCallId: "sh-array",
      tool_input: { command: ["git", "status", "--short"] },
    },
  });
  expect(event.action.toolCall?.tool).toBe("exec_command");
  expect(event.action.toolCall?.arguments?.data).toBe('{"command":["git","status","--short"]}');
  expect(event.action.shellCommand).toBeUndefined();
});

test("oversized specialized input falls back to a bounded generic tool call", () => {
  const command = "x".repeat(TOOL_ACTIVITY_LIMITS.maxPayloadBytes + 1);
  const event = activityAction({
    ...before,
    event: { ...before.event, tool_input: { command } },
  });
  expect(event.action.toolCall?.callId).toBe("toolu_bash_001");
  expect(event.action.shellCommand).toBeUndefined();
  expect(event.action.toolCall?.arguments?.complete).toBe(false);
  const expectedOriginalBytes =
    TOOL_ACTIVITY_LIMITS.maxPayloadBytes + 1 + JSON.stringify({ command: "" }).length;
  expect(event.action.toolCall?.arguments?.originalBytes).toBe(String(expectedOriginalBytes));
  expect(validateActivityEvent(event)).toEqual([]);
});

test("missing and failure results keep absence and truth separate", () => {
  const nullResponse = after(activityAction(before), {
    event: { ...before.event, tool_response: null },
  });
  expect(nullResponse.observation.shellCommandOutput?.stdout).toBeUndefined();
  expect(nullResponse.observation.shellCommandOutput?.exitCode).toBeUndefined();
  const noResponse = after(activityAction(before), { event: { ...before.event } });
  expect(noResponse.observation.shellCommandOutput?.stdout).toBeUndefined();
  expect(noResponse.observation.shellCommandOutput?.outcome).toBe("OUTCOME_COMPLETED");
  const failure = after(activityAction(before), {
    stage: "PostToolUseFailure",
    event: { ...before.event, tool_response: { error: "permission denied" } },
  });
  expect(failure.observation.toolOutput?.success).toBe(false);
  expect(failure.observation.toolOutput?.error).toBe("permission denied");
  expect(failure.observation.toolOutput?.outcome).toBe("OUTCOME_FAILED");
});

test("long generic payloads are bounded with complete hashes and a lossless fragment marker", () => {
  const payload = contentPayload("x".repeat(90_000));
  expect(payload.complete).toBe(false);
  expect(Buffer.byteLength(payload.data)).toBe(TOOL_ACTIVITY_LIMITS.maxPayloadBytes);
  expect(payload.originalBytes).toBe("90000");
  expect(payload.capturedBytes).toBe(String(TOOL_ACTIVITY_LIMITS.maxPayloadBytes));
  expect(payload.dataSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(payload.originalSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(payload.dataSha256).not.toBe(payload.originalSha256);
  expect(contentPayload(payload.data).dataSha256).toBe(payload.dataSha256);
});

test("a truncated mid-UTF-8-prefix is valid UTF-8 and explicitly incomplete", () => {
  const original = "─".repeat(TOOL_ACTIVITY_LIMITS.maxPayloadBytes);
  const payload = contentPayload(original);
  expect(payload.complete).toBe(false);
  expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload.data))).toBe(
    payload.data,
  );
  expect(Number(payload.capturedBytes)).toBeLessThanOrEqual(TOOL_ACTIVITY_LIMITS.maxPayloadBytes);
  expect(payload.capturedBytes).toBe(String(Buffer.byteLength(payload.data)));
});

test("causation and ToolCall integrity validation reject mismatched invocation/input IDs", () => {
  const action = activityAction(before);
  const event = after(action, { event: { ...before.event, tool_use_id: "different-call" } });
  expect(validateActivityEvent(event)).toContain(
    "observation call_id does not match invocation call_id",
  );
  expect(() => validateActivityEvent({ ...event, observation: {} })).not.toThrow();
  expect(validateActivityEvent({ ...event, observation: {} }).length).toBeGreaterThan(0);
});
