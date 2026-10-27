import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "../src/capture.ts";
import { Run as CLI, csvText } from "../src/cli.ts";
import { Authenticate, CredentialHash } from "../src/delivery.ts";
import { Open } from "../src/ledger.ts";
import { CheckSignal, WithDeadline, lockSync } from "../src/platform.ts";
import { NewID, Parse, type Batch } from "../src/protocol.ts";
import { Load, Save, SessionStateDir, StateDir, type Config } from "../src/settings.ts";
import { Run } from "../src/sync.ts";

let root: string;
let previousRoot: string | undefined;
let previousKey: string | undefined;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  previousRoot = process.env.KIMCHI_ADAPTERS_HOME;
  previousKey = process.env.KIMCHI_API_KEY;
  root = mkdtempSync(join(tmpdir(), "kimchi-sync-"));
  process.env.KIMCHI_ADAPTERS_HOME = root;
  delete process.env.KIMCHI_API_KEY;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.KIMCHI_ADAPTERS_HOME;
  else process.env.KIMCHI_ADAPTERS_HOME = previousRoot;
  if (previousKey === undefined) delete process.env.KIMCHI_API_KEY;
  else process.env.KIMCHI_API_KEY = previousKey;
});
function server(handler: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => running.stop(true));
  return running.url.href.slice(0, -1);
}
const stdin = (value: unknown) => async () => Buffer.from(JSON.stringify(value));

test("sync makes one pass and skips an already held native worker lock", async () => {
  const c: Config = {};
  Save(c);
  const guard = lockSync(StateDir(c));
  expect(guard).not.toBeNull();
  await Run(c);
  guard!.close();
  const started = performance.now();
  await Run(c);
  expect(performance.now() - started).toBeLessThan(1000);
  const next = lockSync(StateDir(c));
  expect(next).not.toBeNull();
  next!.close();
});

test("sync honors cancellation, disabled capture, and switched active accounts", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(Run({}, abort.signal)).rejects.toThrow();
  Save({ disabled: true });
  await Run({});
  expect(existsSync(join(StateDir({}), "worker.lock"))).toBe(false);
  const c: Config = {
    apiUrl: "https://api.cast.ai",
    organizationId: NewID(),
    actorId: NewID(),
    apiKey: "synthetic-key",
    enabled: true,
  };
  c.credentialHash = CredentialHash(c);
  Save(c);
  await Run({});
  expect(existsSync(join(StateDir(c), "worker.lock"))).toBe(false);
});

test("sync stops when recovery exhausts its inherited deadline and releases the lock", async () => {
  Save({});
  const s = Open(StateDir({}));
  s.DB.query("INSERT INTO meta(key,value) VALUES('pruned-at',?)").run(
    Math.floor(Date.now() / 1000),
  );
  s.Close();
  const initialNow = Date.now();
  let now = initialNow;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const recovery = spyOn(Recorder.prototype, "RecoverContext").mockImplementation((signal) => {
    CheckSignal(signal);
    now += 30;
  });
  try {
    await expect(Run({}, WithDeadline(20))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(now).toBe(initialNow + 30);
    expect(recovery).toHaveBeenCalledTimes(1);
    const guard = lockSync(StateDir({}));
    expect(guard).not.toBeNull();
    guard!.close();
    recovery.mockImplementation((signal) => CheckSignal(signal));
    await Run({});
    expect(recovery).toHaveBeenCalledTimes(3);
  } finally {
    recovery.mockRestore();
    clock.mockRestore();
  }
});

test("next sync retries the original offline batch and recovers late usage exactly once", async () => {
  const actor = NewID(),
    org = NewID();
  const bodies: string[] = [];
  const apiUrl = server(async (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("api-keys:verify"))
      return Response.json({ organizationId: org, userId: actor });
    if (path === "/v1/me") return Response.json({ id: actor, username: "auth0|fixture" });
    bodies.push(await req.text());
    if (bodies.length === 1) return new Response(null, { status: 503 });
    const batch = Parse(bodies.at(-1)!).batch as Batch;
    return Response.json({
      batchId: batch.id,
      receipts: batch.events.map((e) => ({ id: e.id, revision: e.revision, status: "accepted" })),
    });
  });
  const c = await Authenticate({ apiUrl, apiKey: "synthetic-key", enabled: true });
  Save(c);
  const s = Open(StateDir(c));
  try {
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, "", { mode: 0o600 });
    await new Recorder(s, "codex", s.DeviceID()).Record({
      stage: "UserPromptSubmit",
      version: "test",
      event: {
        session_id: "s",
        turn_id: "t",
        cwd: root,
        prompt: "New work: fixture",
        transcript_path: path,
      },
    });
    await Run(c);
    expect(bodies.length).toBe(1);
    expect(s.Status().pending).toBe(1);
    writeFileSync(
      path,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 3 },
            total_token_usage: { input_tokens: 100, output_tokens: 3 },
          },
        },
      }) + "\n",
    );
    await Run(c);
    expect(bodies.length).toBe(3);
    expect(bodies[0]).toBe(bodies[1]);
    await Run(c);
    expect(bodies.length).toBe(3);
    expect(
      (
        s.DB.query("SELECT count(*) AS count FROM events WHERE kind='usage'").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(s.Status().pending).toBe(0);
  } finally {
    s.Close();
  }
});

test("configure takes the Kimchi environment key and retains runtime activation and disable state", async () => {
  const actor = NewID(),
    org = NewID();
  const apiUrl = server((req) => {
    expect(req.headers.get("authorization")).toBe("Bearer environment-synthetic-key");
    return Response.json(
      new URL(req.url).pathname.endsWith("api-keys:verify")
        ? { organizationId: org, userId: actor }
        : { id: actor, username: "fixture" },
    );
  });
  Save({ disabled: true, runtimeExecutable: "/owned/helper", runtimeRevision: NewID() });
  process.env.KIMCHI_API_KEY = "environment-synthetic-key";
  let output = "";
  await CLI(
    ["configure"],
    stdin({ apiUrl, apiKey: "stdin-synthetic-key", runtimeExecutable: "/untrusted/from-json" }),
    (text) => {
      output += text;
    },
  );
  const c = Load();
  expect(c.apiKey).toBe("environment-synthetic-key");
  expect(c.organizationId).toBe(org);
  expect(c.actorId).toBe(actor);
  expect(c.enabled).toBe(true);
  expect(c.disabled).toBe(true);
  expect(c.runtimeExecutable).toBe("/owned/helper");
  expect(process.env.KIMCHI_API_KEY).toBeUndefined();
  expect(output).not.toContain("environment-synthetic-key");
});

test("hook stores synchronously without spawning a worker and session stays in its original account", async () => {
  let output = "";
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "session",
    turn_id: "turn",
    cwd: root,
    prompt: "New work: fixture",
  };
  Save({ runtimeExecutable: "/does/not/run" });
  await CLI(["hook", "codex"], stdin(payload), (text) => {
    output += text;
  });
  expect(output).toBe("");
  const original = StateDir({});
  const s = Open(original);
  try {
    expect(
      (
        s.DB.query("SELECT count(*) AS count FROM events WHERE kind='work'").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  } finally {
    s.Close();
  }
  expect(existsSync(join(original, "worker.lock"))).toBe(false);
  const c: Config = {
    apiUrl: "https://api.cast.ai",
    organizationId: NewID(),
    actorId: NewID(),
    apiKey: "synthetic-key",
    enabled: true,
  };
  c.credentialHash = CredentialHash(c);
  Save(c);
  expect(SessionStateDir(c, "codex", "session")).toBe(original);
  await CLI(["hook", "codex"], stdin({ ...payload, turn_id: "turn-2" }), (text) => {
    output += text;
  });
  expect(output).toBe("");
  const pinned = Open(original);
  try {
    expect(pinned.Events().length).toBeGreaterThan(0);
  } finally {
    pinned.Close();
  }
});

test("CSV export guards formulas and status never outputs reporting credentials", async () => {
  for (const value of ['=HYPERLINK("bad")', "+1", "-1", "@x", "\tvalue", "\rvalue"])
    expect(csvText(value)).toBe("'" + value);
  for (const value of ["", "123", "normal"]) expect(csvText(value)).toBe(value);
  const c: Config = {
    apiUrl: "https://api.cast.ai",
    organizationId: NewID(),
    actorId: NewID(),
    apiKey: "synthetic-private-key",
    enabled: true,
  };
  c.credentialHash = CredentialHash(c);
  Save(c);
  let output = "";
  await CLI(["status"], undefined, (text) => {
    output += text;
  });
  expect(output).not.toContain("synthetic-private-key");
  expect(JSON.parse(output).reportingConfigured).toBe(true);
});
