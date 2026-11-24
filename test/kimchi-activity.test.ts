import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityStore } from "../src/work/activity-store.ts";
import { run as runBridgeCli } from "../src/cli.ts";
import type { Native } from "../src/work/capture.ts";
import { workspaceActivityState } from "../src/work/workspace.ts";
import { workspaceCommand } from "../src/work/workspace-command.ts";

const cleanups: (() => void)[] = [];
const environmentKeys = [
  "KIMCHI_BRIDGE_HOME",
  "KIMCHI_BRIDGE_ACTIVITY_DRY_RUN",
  "KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE",
  "KIMCHI_BRIDGE_PROFILE",
] as const;

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function activityHome(): void {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-native-activity-"));
  process.env.KIMCHI_BRIDGE_HOME = dir;
  process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN = "1";
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
}

function inspectStore(): ActivityStore {
  const store = new ActivityStore(workspaceActivityState());
  cleanups.push(() => store.close());
  return store;
}

function before(callId = "kimchi-call-1"): Native {
  return {
    stage: "classic.PreToolUse",
    event: {
      hook_event_name: "PreToolUse",
      session_id: "kimchi-headless-session",
      cwd: "/workspace",
      tool_name: "Bash",
      tool_use_id: callId,
      tool_input: { command: "printf 'kimchi-activity-proof\\n'" },
    },
  };
}

function after(callId = "kimchi-call-1"): Native {
  return {
    stage: "classic.PostToolUse",
    event: {
      ...before(callId).event,
      hook_event_name: "PostToolUse",
      tool_response: {
        content: [{ type: "text", text: "kimchi-activity-proof" }],
        details: { exitCode: 0 },
      },
      tool_output: "kimchi-activity-proof",
      is_error: false,
      duration_ms: 7,
    },
  };
}

function observeTool(
  value: ActivityStore,
  toolName: string,
  callId: string,
  toolInput: Record<string, unknown>,
  response: unknown,
): void {
  const start = before(callId);
  start.event.tool_name = toolName;
  start.event.tool_input = toolInput;
  const finish = after(callId);
  finish.event.tool_name = toolName;
  finish.event.tool_input = toolInput;
  finish.event.tool_response = response;
  value.observe(start, "kimchi");
  value.observe(finish, "kimchi");
}

function temporaryStore(): ActivityStore {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-private-shapes-"));
  const value = new ActivityStore(dir);
  cleanups.push(() => {
    value.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return value;
}

async function runHook(native: Native): Promise<void> {
  await workspaceCommand("hook", ["hook", "kimchi"], {
    readHookInput: async () => Buffer.from(JSON.stringify(native.event)),
    output: () => {},
  });
}

test("hook kimchi preserves source identity and generic structured results", async () => {
  activityHome();
  process.env.KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE = "1";
  await runHook(before());
  await runHook(after());

  const events = inspectStore().allEvents();
  expect(events).toHaveLength(2);
  expect(events.map((event) => event.agent?.platform)).toEqual(["kimchi", "kimchi"]);
  expect(events.map((event) => event.trajectoryId)).toEqual([
    "kimchi-headless-session",
    "kimchi-headless-session",
  ]);
  expect(events[0].action?.shellCommand).toMatchObject({
    callId: "kimchi-call-1",
    command: "printf 'kimchi-activity-proof\\n'",
    workingDir: "/workspace",
  });
  expect(events[1].causality).toEqual({ causationId: events[0].eventId });
  expect(events[1].observation?.toolOutput).toMatchObject({
    callId: "kimchi-call-1",
    success: true,
    outcome: "OUTCOME_COMPLETED",
    durationMs: "7",
  });
  expect(events[1].observation?.toolOutput?.output?.data).toContain("kimchi-activity-proof");
});

test("private Kimchi failures retain one redacted result across duplicate hooks", () => {
  const store = temporaryStore();
  const failure: Native = {
    ...after(),
    stage: "classic.PostToolUseFailure",
    event: {
      ...before().event,
      hook_event_name: "PostToolUseFailure",
      is_error: true,
      error: "sensitive provider error",
      duration_ms: 9,
    },
  };
  store.observe(before(), "kimchi");
  store.observe(failure, "kimchi");
  store.observe(failure, "kimchi");

  const events = store.allEvents();
  expect(events).toHaveLength(2);
  expect(events[1].agent?.platform).toBe("kimchi");
  expect(events[1].observation?.toolOutput).toEqual({
    callId: "kimchi-call-1",
    success: false,
    outcome: "OUTCOME_FAILED",
    durationMs: "9",
  });
  expect(JSON.stringify(events)).not.toContain("sensitive provider error");
});

test("private Kimchi maps terminal shell metadata and leaves background handoffs generic", () => {
  const value = temporaryStore();
  observeTool(
    value,
    "Bash",
    "terminal",
    { command: "pwd" },
    {
      content: [{ type: "text", text: "formatted output" }],
      details: {
        exited: true,
        exitCode: 0,
        display: { state: "exited", output: "/workspace" },
      },
    },
  );
  observeTool(
    value,
    "Bash",
    "handoff",
    { command: "sleep 2" },
    {
      content: [{ type: "text", text: "backgrounded" }],
      details: {
        handoff: true,
        exited: false,
        exitCode: null,
        display: { state: "running", output: "" },
      },
    },
  );

  const events = value.allEvents();
  expect(events[1].observation?.shellCommandOutput).toEqual({
    callId: "terminal",
    exitCode: 0,
    outcome: "OUTCOME_COMPLETED",
    durationMs: "7",
  });
  expect(events[1].observation?.toolOutput).toBeUndefined();
  expect(events[3].observation?.shellCommandOutput).toBeUndefined();
  expect(events[3].observation?.toolOutput).toMatchObject({
    callId: "handoff",
    success: true,
    outcome: "OUTCOME_COMPLETED",
  });
  expect(JSON.stringify(events)).not.toContain("formatted output");
  expect(JSON.stringify(events)).not.toContain("backgrounded");
});

test("private Kimchi types file and web results without retaining native payloads", () => {
  const value = temporaryStore();
  observeTool(
    value,
    "Read",
    "read",
    { path: "/workspace/private.txt" },
    {
      content: [{ type: "text", text: "private file body" }],
      structuredContent: "private file body",
    },
  );
  observeTool(
    value,
    "Edit",
    "edit",
    {
      path: "/workspace/private.txt",
      edits: [{ oldText: "private old text", newText: "private new text" }],
    },
    {
      content: [{ type: "text", text: "edited" }],
      details: { patch: "private patch body" },
    },
  );
  observeTool(
    value,
    "web_fetch",
    "fetch",
    { url: "https://example.com/search?q=private-token" },
    {
      content: [{ type: "text", text: "private web body" }],
      details: { words: 42 },
    },
  );

  const events = value.allEvents();
  expect(events[1].observation?.fileOperationResult).toMatchObject({
    callId: "read",
    success: true,
    path: "/workspace/private.txt",
    outcome: "OUTCOME_COMPLETED",
  });
  expect(events[1].observation?.fileOperationResult?.content).toBeUndefined();
  expect(events[3].observation?.fileOperationResult).toMatchObject({
    callId: "edit",
    success: true,
    path: "/workspace/private.txt",
    outcome: "OUTCOME_COMPLETED",
  });
  expect(events[5].observation?.webFetchOutput).toMatchObject({
    callId: "fetch",
    url: "https://example.com/search",
    outcome: "OUTCOME_COMPLETED",
    durationMs: "7",
  });
  expect(events[5].observation?.webFetchOutput?.result).toBeUndefined();
  expect(events[5].observation?.webFetchOutput?.code).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain("private file body");
  expect(JSON.stringify(events)).not.toContain("private old text");
  expect(JSON.stringify(events)).not.toContain("private new text");
  expect(JSON.stringify(events)).not.toContain("private patch body");
  expect(JSON.stringify(events)).not.toContain("private web body");
  expect(JSON.stringify(events)).not.toContain("private-token");
});

test("CLI run routes a Kimi hook through the workspace capture handler", async () => {
  activityHome();
  process.env.KIMCHI_BRIDGE_PROFILE = "workspace";
  await runBridgeCli(["hook", "kimchi"], async () => Buffer.from(JSON.stringify(before().event)));
  const events = inspectStore().allEvents();
  expect(events).toHaveLength(1);
  expect(events[0].agent?.platform).toBe("kimchi");
  expect(events[0].action?.shellCommand?.command).toBe("printf 'kimchi-activity-proof\\n'");
});

test("workspace hook still rejects unsupported sources", async () => {
  activityHome();
  await expect(
    workspaceCommand("hook", ["hook", "unsupported"], {
      readHookInput: async () => Buffer.from("{}"),
      output: () => {},
    }),
  ).rejects.toThrow("missing hook source");
});
