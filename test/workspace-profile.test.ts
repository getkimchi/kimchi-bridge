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
  process.env.KIMCHI_API_KEY = "synthetic-not-a-real-credential";
  process.env.KIMCHI_TELEMETRY_ENABLED = "1";
  process.env.KIMCHI_REMOTE_ENDPOINT = "http://127.0.0.1:1";
  process.env.CLAUDE_ENV_FILE = join(root, "legacy-trace.sh");
});
afterEach(() => {
  delete process.env.KIMCHI_BRIDGE_PROFILE;
  delete process.env.KIMCHI_BRIDGE_ACTIVITY_URL;
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

function parseActivity(value: string): { batchId: string; events: any[] } {
  return JSON.parse(value);
}
