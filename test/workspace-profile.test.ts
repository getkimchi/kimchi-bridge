import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/cli.ts";
import { ActivityStore } from "../src/work/activity-store.ts";

const variables = [
  "HOME",
  "KIMCHI_BRIDGE_HOME",
  "KIMCHI_BRIDGE_CONFIG_HOME",
  "KIMCHI_BRIDGE_PROFILE",
  "KIMCHI_BRIDGE_ACTIVITY_URL",
  "KIMCHI_BRIDGE_ACTIVITY_DRY_RUN",
  "KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE",
  "KIMCHI_API_KEY",
  "KIMCHI_TELEMETRY_ENABLED",
  "KIMCHI_REMOTE_ENDPOINT",
  "CLAUDE_ENV_FILE",
];
let saved: (string | undefined)[] = [];
let root = "";
const cleanups: (() => void)[] = [];
beforeEach(() => {
  saved = variables.map((name) => process.env[name]);
  root = mkdtempSync(join(tmpdir(), "workspace-profile-"));
  process.env.HOME = join(root, "home");
  process.env.KIMCHI_BRIDGE_HOME = join(root, "bridge-state");
  process.env.KIMCHI_BRIDGE_CONFIG_HOME = join(root, "kimi-config");
  process.env.KIMCHI_BRIDGE_PROFILE = "workspace";
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN;
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE;
  process.env.KIMCHI_API_KEY = "synthetic-not-a-real-credential";
  process.env.KIMCHI_TELEMETRY_ENABLED = "1";
  process.env.KIMCHI_REMOTE_ENDPOINT = "http://127.0.0.1:1";
  process.env.CLAUDE_ENV_FILE = join(root, "legacy-trace.sh");
});
afterEach(() => {
  delete process.env.KIMCHI_BRIDGE_PROFILE;
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_URL;
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN;
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE;
  delete process.env.CLAUDE_ENV_FILE;
  for (const cleanup of cleanups.splice(0)) cleanup();
  rmSync(root, { recursive: true, force: true });
  variables.forEach((name, index) => {
    if (saved[index] === undefined) delete process.env[name];
    else process.env[name] = saved[index];
  });
});
function stdin(body: unknown): () => Promise<Buffer> {
  return async () => Buffer.from(JSON.stringify(body));
}
function toolEvent(id: string): unknown {
  return {
    stage: "tool.before",
    event: {
      session_id: "workspace-profile-session",
      cwd: "/workspace/repo",
      tool_use_id: id,
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    },
    version: "2.1.326",
  };
}
function localRecorder(reply: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: reply });
  cleanups.push(() => running.stop(true));
  return new URL("/imds/tool-calls:batchRecord", running.url).href;
}

test("workspace sync and callbacks cannot create legacy account or routing state", async () => {
  let reads = 0;
  await run(
    ["sync"],
    async () => {
      reads++;
      throw new Error("worker should not read a legacy hook");
    },
    () => {},
  );
  expect(existsSync(join(root, "bridge-state", "accounts", "local", "ledger.sqlite"))).toBe(false);
  expect(existsSync(join(root, "bridge-state", "session-accounts.sqlite"))).toBe(false);
  expect(reads).toBe(0);
  for (const args of [
    ["gateway", "ensure", "--quick"],
    ["hint"],
    ["trace-env"],
    ["activate"],
    ["codex-trace", "on"],
  ]) {
    await run(
      args,
      async () => {
        reads++;
        throw new Error("legacy command must be inert");
      },
      () => {},
    );
  }
  expect(reads).toBe(0);
  expect(existsSync(process.env.CLAUDE_ENV_FILE!)).toBe(false);
  await expect(run(["login"], stdin({}), () => {})).rejects.toThrow("workspace activity capture");
  expect(existsSync(join(root, "bridge-state", "accounts", "local", "ledger.sqlite"))).toBe(false);
});

test("workspace sync retains and retries the same activity batch without account credentials", async () => {
  const requests: { body: string; authorization: string | null }[] = [];
  const endpoint = localRecorder(async (request) => {
    const raw = await request.text();
    const body = parseActivity(raw);
    requests.push({ body: raw, authorization: request.headers.get("authorization") });
    if (requests.length === 1) return new Response("temporary", { status: 503 });
    return Response.json({
      batchId: body.batchId,
      receipts: body.events.map((event: any) => ({
        eventId: event.eventId,
        status: "RECEIPT_STATUS_ACCEPTED",
      })),
    });
  });
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = endpoint;
  await run(["hook", "claude-code"], stdin(toolEvent("retry-001")), () => {});
  const before = requests[0].body;
  await run(["sync"], stdin({}), () => {});
  expect(requests).toHaveLength(2);
  expect(requests[1].body).toBe(before);
  expect(requests[1].authorization).toBeNull();
  let output = "";
  await run(["status"], stdin({}), (text) => {
    output += text;
  });
  const status = JSON.parse(output);
  expect(status.profile).toBe("workspace");
  expect(status).toMatchObject({ pending_events: 0, pending_batches: 0, acknowledgements: 1 });
  expect(status.diagnostics.activity_delivery_pending).toBeGreaterThan(0);
  expect(status.diagnostics.activity_http_503).toBeGreaterThan(0);
  expect(existsSync(join(root, "bridge-state", "accounts", "local", "ledger.sqlite"))).toBe(false);
});

test("workspace export reads pending activity as JSONL and CSV instead of the legacy ledger", async () => {
  await run(["hook", "claude-code"], stdin(toolEvent("export-001")), () => {});
  let jsonl = "";
  await run(["export", "jsonl"], stdin({}), (text) => {
    jsonl += text;
  });
  const records = jsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(1);
  expect(records[0].action.shellCommand).toMatchObject({ callId: "export-001", command: "pwd" });
  let csv = "";
  await run(["export", "csv"], stdin({}), (text) => {
    csv += text;
  });
  const rows = csv.trim().split("\n");
  expect(rows[0]).toBe("event_id,variant,source,trajectory_id,turn_id,occurred_at,event_json");
  expect(rows).toHaveLength(2);
  expect(rows[1]).toContain("workspace-profile-session");
  expect(rows[1]).toContain("export-001");
  expect(existsSync(join(root, "bridge-state", "accounts", "local", "ledger.sqlite"))).toBe(false);
});

test("workspace dry run stores and exports events without delivery, then resumes normally", async () => {
  process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN = "1";
  let requests = 0;
  const endpoint = localRecorder(async (request) => {
    requests++;
    const batch = parseActivity(await request.text());
    return Response.json({
      batchId: batch.batchId,
      receipts: batch.events.map((event: any) => ({
        eventId: event.eventId,
        status: "RECEIPT_STATUS_ACCEPTED",
      })),
    });
  });
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = endpoint;
  await run(["hook", "claude-code"], stdin(toolEvent("dry-run-001")), () => {});
  await run(["sync"], stdin({}), () => {});
  let flushOutput = "";
  await run(["flush"], stdin({}), (text) => {
    flushOutput += text;
  });
  expect(requests).toBe(0);
  expect(flushOutput).toBe("Dry run: pending activity records kept locally.\n");
  let statusText = "";
  await run(["status"], stdin({}), (text) => {
    statusText += text;
  });
  expect(JSON.parse(statusText)).toMatchObject({
    dryRun: true,
    pending_events: 1,
    acknowledgements: 0,
    diagnostics: {},
  });
  let exported = "";
  await run(["export", "jsonl"], stdin({}), (text) => {
    exported += text;
  });
  expect(JSON.parse(exported).action.shellCommand.callId).toBe("dry-run-001");
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN;
  await run(["flush"], stdin({}), () => {});
  expect(requests).toBe(1);
});

test("workspace flush drains every pending activity batch", async () => {
  const store = new ActivityStore(join(root, "bridge-state", "workspace-activity"));
  for (let index = 0; index < 1002; index++)
    store.observe(
      {
        event: {
          session_id: "large-flush-session",
          cwd: "/workspace/repo",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: `call-${String(index).padStart(4, "0")}`,
          tool_input: { command: "pwd" },
        },
      },
      "claude-code",
    );
  store.close();
  const sizes: number[] = [];
  const endpoint = localRecorder(async (request) => {
    const batch = parseActivity(await request.text());
    sizes.push(batch.events.length);
    return Response.json({
      batchId: batch.batchId,
      receipts: batch.events.map((event: any) => ({
        eventId: event.eventId,
        status: "RECEIPT_STATUS_ACCEPTED",
      })),
    });
  });
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = endpoint;
  let output = "";
  await run(["flush"], stdin({}), (text) => {
    output += text;
  });
  expect(sizes).toEqual([...Array(10).fill(100), 2]);
  expect(output).toBe("All pending activity records acknowledged.\n");
  let statusText = "";
  await run(["status"], stdin({}), (text) => {
    statusText += text;
  });
  expect(JSON.parse(statusText)).toMatchObject({
    pending_events: 0,
    pending_batches: 0,
    acknowledgements: 1002,
  });
});

function richToolEvent(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  response: unknown,
  failed = false,
): unknown[] {
  const event = {
    session_id: "workspace-profile-session",
    cwd: "/workspace/repo",
    tool_use_id: id,
    tool_name: tool,
    tool_input: input,
  };
  return [
    { stage: "tool.before", event, version: "2.1.326" },
    {
      stage: failed ? "PostToolUseFailure" : "PostToolUse",
      event: { ...event, tool_response: response, duration_ms: 5 },
      version: "2.1.326",
    },
  ];
}
async function recordEvents(events: unknown[]): Promise<void> {
  for (const event of events) await run(["hook", "claude-code"], stdin(event), () => {});
}

test("default private capture keeps sensitive fields out of SQLite, exports, and IMDS", async () => {
  process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN = "1";
  const requests: string[] = [];
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = localRecorder(async (request) => {
    const raw = await request.text();
    requests.push(raw);
    const batch = parseActivity(raw);
    return Response.json({
      batchId: batch.batchId,
      receipts: batch.events.map((event: any) => ({
        eventId: event.eventId,
        status: "RECEIPT_STATUS_ACCEPTED",
      })),
    });
  });
  const fixtures = [
    richToolEvent(
      "private-edit",
      "Edit",
      {
        file_path: "/workspace/repo/src/private.ts",
        old_string: "SENSITIVE_OLD_CONTENT",
        new_string: "SENSITIVE_NEW_CONTENT",
      },
      "SENSITIVE_FILE_RESULT",
    ),
    richToolEvent(
      "private-bash",
      "Bash",
      { command: "pwd" },
      { stdout: "SENSITIVE_STDOUT", stderr: "SENSITIVE_STDERR", exit_code: 0 },
    ),
    richToolEvent(
      "private-web",
      "WebFetch",
      {
        url: "https://SENSITIVE_URL_USERINFO:SENSITIVE_URL_PASSWORD@example.com:8443/search?q=SENSITIVE_URL_QUERY#SENSITIVE_URL_FRAGMENT",
        prompt: "SENSITIVE_WEB_PROMPT",
      },
      { code: 200, result: "SENSITIVE_WEB_RESULT" },
    ),
    richToolEvent(
      "private-generic",
      "custom_tool",
      { pattern: "SENSITIVE_GENERIC_ARGUMENT" },
      { error: "SENSITIVE_RAW_ERROR", detail: "SENSITIVE_GENERIC_RESULT" },
      true,
    ),
  ];
  for (const events of fixtures) await recordEvents(events);
  expect(requests).toHaveLength(0);

  let jsonl = "";
  await run(["export", "jsonl"], stdin({}), (chunk) => {
    jsonl += chunk;
  });
  const records = jsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(8);
  expect(records[0].action.fileOperation).toEqual({
    callId: "private-edit",
    operation: "FILE_OP_TYPE_EDIT",
    path: "/workspace/repo/src/private.ts",
  });
  expect(records[3].observation.shellCommandOutput).toMatchObject({
    callId: "private-bash",
    exitCode: 0,
    outcome: "OUTCOME_COMPLETED",
  });
  expect(records[5].observation.webFetchOutput).toMatchObject({
    callId: "private-web",
    url: "https://example.com:8443/search",
    code: 200,
  });
  expect(records[6].action.toolCall).toEqual({
    callId: "private-generic",
    tool: "custom_tool",
  });
  expect(records[7].observation.toolOutput).toMatchObject({
    callId: "private-generic",
    success: false,
    outcome: "OUTCOME_FAILED",
  });

  let csv = "";
  await run(["export", "csv"], stdin({}), (chunk) => {
    csv += chunk;
  });
  const secrets = [
    "SENSITIVE_OLD_CONTENT",
    "SENSITIVE_NEW_CONTENT",
    "SENSITIVE_FILE_RESULT",
    "SENSITIVE_STDOUT",
    "SENSITIVE_STDERR",
    "SENSITIVE_URL_USERINFO",
    "SENSITIVE_URL_PASSWORD",
    "SENSITIVE_URL_QUERY",
    "SENSITIVE_URL_FRAGMENT",
    "SENSITIVE_WEB_PROMPT",
    "SENSITIVE_WEB_RESULT",
    "SENSITIVE_GENERIC_ARGUMENT",
    "SENSITIVE_RAW_ERROR",
    "SENSITIVE_GENERIC_RESULT",
  ];
  for (const secret of secrets) {
    expect(jsonl).not.toContain(secret);
    expect(csv).not.toContain(secret);
  }

  let statusText = "";
  await run(["status"], stdin({}), (chunk) => {
    statusText += chunk;
  });
  expect(JSON.parse(statusText)).toMatchObject({ captureMode: "private", dryRun: true });

  const store = new ActivityStore(join(root, "bridge-state", "workspace-activity"));
  expect(store.pendingBatch()?.events).toHaveLength(8);
  const persisted = (["events", "actions", "batches"] as const)
    .flatMap((table) => store.db.query(`SELECT body FROM ${table}`).all() as { body: Uint8Array }[])
    .map((row) => Buffer.from(row.body).toString("utf8"))
    .join("\n");
  store.close();
  for (const secret of secrets) expect(persisted).not.toContain(secret);

  delete process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN;
  let output = "";
  await run(["flush"], stdin({}), (chunk) => {
    output += chunk;
  });
  expect(output).toBe("All pending activity records acknowledged.\n");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("https://example.com:8443/search");
  for (const secret of secrets) expect(requests[0]).not.toContain(secret);
});

test("full capture is explicit, respects dry run, and queued full bodies flush normally in private mode", async () => {
  process.env.KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE = "1";
  process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN = "1";
  const requests: string[] = [];
  process.env.KIMCHI_BRIDGE_ACTIVITY_URL = localRecorder(async (request) => {
    const raw = await request.text();
    requests.push(raw);
    const batch = parseActivity(raw);
    return Response.json({
      batchId: batch.batchId,
      receipts: batch.events.map((event: any) => ({
        eventId: event.eventId,
        status: "RECEIPT_STATUS_ACCEPTED",
      })),
    });
  });
  await recordEvents(
    richToolEvent(
      "full-bash",
      "Bash",
      { command: "pwd" },
      { stdout: "SENSITIVE_FULL_OUTPUT", stderr: "SENSITIVE_FULL_ERROR", exit_code: 0 },
    ),
  );
  expect(requests).toHaveLength(0);

  let exported = "";
  await run(["export", "jsonl"], stdin({}), (chunk) => {
    exported += chunk;
  });
  expect(exported).toContain("SENSITIVE_FULL_OUTPUT");
  expect(exported).toContain("SENSITIVE_FULL_ERROR");
  let fullStatus = "";
  await run(["status"], stdin({}), (chunk) => {
    fullStatus += chunk;
  });
  expect(JSON.parse(fullStatus)).toMatchObject({ captureMode: "full", dryRun: true });

  delete process.env.KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE;
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN;
  let privateStatus = "";
  await run(["status"], stdin({}), (chunk) => {
    privateStatus += chunk;
  });
  expect(JSON.parse(privateStatus)).toMatchObject({ captureMode: "private", dryRun: false });

  await run(["flush"], stdin({}), () => {});
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("SENSITIVE_FULL_OUTPUT");
  expect(requests[0]).toContain("SENSITIVE_FULL_ERROR");
});

function parseActivity(value: string): { batchId: string; events: any[] } {
  return JSON.parse(value);
}
