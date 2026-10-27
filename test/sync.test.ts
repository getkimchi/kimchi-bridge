import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Run as CLI, csvText } from "../src/cli.ts";
import { Authenticate, CredentialHash } from "../src/kimchi.ts";
import { CheckSignal, WithDeadline, lockSync } from "../src/platform.ts";
import { Load, Save, SessionStateDir, StateDir, type Config } from "../src/settings.ts";
import { Recorder } from "../src/work/capture.ts";
import { Open } from "../src/work/ledger.ts";
import { NewID, Parse, type Batch } from "../src/work/protocol.ts";
import { Run } from "../src/work/sync.ts";

let root: string;
const variables = ["KIMCHI_BRIDGE_HOME", "KIMCHI_API_KEY", "HOME", "KIMCHI_REMOTE_ENDPOINT"];
let previous: (string | undefined)[] = [];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  previous = variables.map((name) => process.env[name]);
  root = mkdtempSync(join(tmpdir(), "kimchi-sync-"));
  process.env.KIMCHI_BRIDGE_HOME = root;
  // Kimchi's sign-in is read from this HOME, never the developer's.
  process.env.HOME = root;
  delete process.env.KIMCHI_API_KEY;
  delete process.env.KIMCHI_REMOTE_ENDPOINT;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(root, { recursive: true, force: true });
  variables.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});
function server(handler: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => running.stop(true));
  return running.url.href.slice(0, -1);
}
const stdin = (value: unknown) => async () => Buffer.from(JSON.stringify(value));

const signedOut = { apiUrl: "" };

test("sync makes one pass and skips an already held native worker lock", async () => {
  const c: Config = {};
  Save(c);
  const guard = lockSync(StateDir(c));
  expect(guard).not.toBeNull();
  await Run(signedOut);
  guard!.close();
  const started = performance.now();
  await Run(signedOut);
  expect(performance.now() - started).toBeLessThan(1000);
  const next = lockSync(StateDir(c));
  expect(next).not.toBeNull();
  next!.close();
});

test("sync honors cancellation and disabled capture", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(Run(signedOut, abort.signal)).rejects.toThrow();
  Save({ disabled: true });
  await Run({ apiUrl: "https://api.cast.ai", token: "never-verified" });
  expect(existsSync(join(StateDir({}), "worker.lock"))).toBe(false);
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
    await expect(Run(signedOut, WithDeadline(20))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(now).toBe(initialNow + 30);
    expect(recovery).toHaveBeenCalledTimes(1);
    const guard = lockSync(StateDir({}));
    expect(guard).not.toBeNull();
    guard!.close();
    recovery.mockImplementation((signal) => CheckSignal(signal));
    await Run(signedOut);
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
    bodies.push(await req.text());
    if (bodies.length === 1) return new Response(null, { status: 503 });
    const batch = Parse(bodies.at(-1)!).batch as Batch;
    return Response.json({
      batchId: batch.id,
      receipts: batch.events.map((e) => ({ id: e.id, revision: e.revision, status: "accepted" })),
    });
  });
  const k = { apiUrl, token: "synthetic-key" };
  const c = await Authenticate(k);
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
    await Run(k);
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
    await Run(k);
    expect(bodies.length).toBe(3);
    expect(bodies[0]).toBe(bodies[1]);
    await Run(k);
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

test("configure sets only OTLP export, keeps the disable state, and refuses keys", async () => {
  Save({ disabled: true });
  let output = "";
  const exporter = {
    otlpUrl: "https://collector.example/v1/logs",
    otlpHeaders: { Authorization: "Bearer collector-only" },
  };
  await CLI(["configure"], stdin({ ...exporter, disabled: false }), (text) => {
    output += text;
  });
  const c = Load();
  expect(c.otlpUrl).toBe(exporter.otlpUrl);
  expect(c.otlpHeaders).toEqual(exporter.otlpHeaders);
  expect(c.disabled).toBe(true);
  expect(output).toBe("OTLP export configured.\n");
  await expect(
    CLI(["configure"], stdin({ apiUrl: "https://api.cast.ai", apiKey: "synthetic-key" })),
  ).rejects.toThrow("Kimchi's sign-in");
  await expect(CLI(["login"])).rejects.toThrow("unknown command");
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
  Save({});
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
    credentialHash: CredentialHash({ apiUrl: "https://api.cast.ai", token: "synthetic-key" }),
  };
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
  mkdirSync(join(root, ".config", "kimchi"), { recursive: true });
  writeFileSync(
    join(root, ".config", "kimchi", "config.json"),
    JSON.stringify({ apiKey: "synthetic-private-key" }),
  );
  // Kimchi's default region uploads to its console's /api.
  const apiUrl = "https://app.kimchi.dev/api";
  const c: Config = {
    apiUrl,
    organizationId: NewID(),
    actorId: NewID(),
    credentialHash: CredentialHash({ apiUrl, token: "synthetic-private-key" }),
  };
  Save(c);
  let output = "";
  await CLI(["status"], undefined, (text) => {
    output += text;
  });
  expect(output).not.toContain("synthetic-private-key");
  expect(JSON.parse(output)).toMatchObject({ kimchiSignedIn: true, reportingVerified: true });
});
