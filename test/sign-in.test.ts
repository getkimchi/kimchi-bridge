import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Run as CLI } from "../src/cli.ts";
import { CredentialHash, FlushOTLP } from "../src/delivery.ts";
import { Open } from "../src/ledger.ts";
import { NewID, Parse, type Batch, type Event } from "../src/protocol.ts";
import { KimchiSignIn, Load, Save, SessionStateDir, StateDir, Verify } from "../src/settings.ts";

let root: string, kimchi: string;
const variables = [
  "KIMCHI_ADAPTERS_HOME",
  "KIMCHI_API_KEY",
  "HOME",
  "KIMCHI_REMOTE_ENDPOINT",
  "KIMCHI_REGION",
];
let previous: (string | undefined)[] = [];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  previous = variables.map((name) => process.env[name]);
  root = mkdtempSync(join(tmpdir(), "kimchi-sign-in-"));
  kimchi = join(root, ".config", "kimchi");
  mkdirSync(join(kimchi, "harness"), { recursive: true });
  process.env.HOME = root;
  process.env.KIMCHI_ADAPTERS_HOME = join(root, "reporting");
  for (const name of variables.slice(3)) delete process.env[name];
  delete process.env.KIMCHI_API_KEY;
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
function kimchiFiles(config?: object, auth?: object) {
  rmSync(join(kimchi, "config.json"), { force: true });
  rmSync(join(kimchi, "harness", "auth.json"), { force: true });
  if (config) writeFileSync(join(kimchi, "config.json"), JSON.stringify(config));
  if (auth) writeFileSync(join(kimchi, "harness", "auth.json"), JSON.stringify(auth));
}
const stdin = (value: unknown) => async () => Buffer.from(JSON.stringify(value));
function event(): Event {
  return {
    id: NewID(),
    entityId: NewID(),
    revision: "1",
    source: "codex",
    sourceVersion: "test",
    deviceId: NewID(),
    observeTime: new Date().toISOString(),
    coverage: { code: "fixture", count: "1" },
  };
}

test("reads Kimchi's API key, saved login and region in Kimchi's order", () => {
  const organization = NewID();
  const read = (env: Record<string, string> = {}, key = "") => KimchiSignIn(key, kimchi, env);
  expect(read()).toEqual({ apiUrl: "https://api.cast.ai" });
  kimchiFiles(undefined, {
    "kimchi-dev": {
      type: "oauth",
      access: "sso-token",
      refresh: "r",
      expires: 1,
      orgId: organization,
    },
  });
  expect(read()).toEqual({
    apiUrl: "https://api.cast.ai",
    token: "sso-token",
    organizationId: organization,
  });
  kimchiFiles(undefined, { "kimchi-dev": { type: "api_key", key: "saved-key" } });
  expect(read()).toEqual({ apiUrl: "https://api.cast.ai", token: "saved-key" });
  kimchiFiles({ api_key: "legacy-key", region: "eu" });
  expect(read()).toEqual({ apiUrl: "https://api.eu.cast.ai", token: "legacy-key" });
  kimchiFiles(
    { apiKey: "config-key", region: "eu" },
    { "kimchi-dev": { type: "oauth", access: "sso-token" } },
  );
  expect(read()).toEqual({ apiUrl: "https://api.eu.cast.ai", token: "config-key" });
  expect(read({ KIMCHI_REGION: "us" }, "environment-key")).toEqual({
    apiUrl: "https://api.cast.ai",
    token: "environment-key",
  });
  kimchiFiles({ region: "self-hosted", selfHostedEndpoints: { api: "https://api.example" } });
  expect(read()).toEqual({ apiUrl: "https://api.example" });
  kimchiFiles({ region: "self-hosted", selfHostedUrl: "https://kimchi.example/" });
  expect(read().apiUrl).toBe("https://kimchi.example/api");
  expect(read({ KIMCHI_REMOTE_ENDPOINT: "http://127.0.0.1:9" }).apiUrl).toBe("http://127.0.0.1:9");
  writeFileSync(join(kimchi, "config.json"), "{");
  expect(() => read()).toThrow("Kimchi settings could not be read");
});

test("a new key for the same account keeps its exporter; another account drops it", async () => {
  const exported: string[] = [];
  const exporter = server(async (request) => {
    exported.push(await request.text());
    return Response.json({});
  });
  for (const changed of ["actor", "organization", "endpoint"]) {
    const actor = NewID(),
      organization = NewID(),
      calls: string[] = [];
    const identity = () =>
      server((request) => {
        calls.push(request.headers.get("authorization")!);
        return Response.json({ organizationId: organization, userId: actor });
      });
    const apiUrl = identity();
    const kept = {
      disabled: true,
      runtimeExecutable: "/owned/helper",
      runtimeRevision: NewID(),
    };
    Save({ ...kept, otlpUrl: exporter + "/v1/logs", otlpHeaders: { Authorization: "Bearer old" } });
    // The first verification keeps an exporter configured before it.
    let c = await Verify({ apiUrl, token: "first-key" });
    expect(c).toMatchObject({ ...kept, actorId: actor, otlpUrl: exporter + "/v1/logs" });
    const account = StateDir(c);
    c = await Verify({ apiUrl, token: "rotated-key" });
    expect(StateDir(c)).toBe(account);
    expect(c.otlpUrl).toBe(exporter + "/v1/logs");
    expect(await Verify({ apiUrl, token: "rotated-key" })).toEqual(c);
    expect(calls).toEqual(["Bearer first-key", "Bearer rotated-key"]);

    const other = changed === "endpoint" ? identity() : apiUrl;
    const switched = server(() =>
      Response.json({
        organizationId: changed === "organization" ? NewID() : organization,
        userId: changed === "actor" ? NewID() : actor,
      }),
    );
    c = await Verify({ apiUrl: changed === "endpoint" ? other : switched, token: "new-key" });
    expect(StateDir(c)).not.toBe(account);
    expect(c).toMatchObject(kept);
    expect(c.otlpUrl).toBeUndefined();
    expect(c.otlpHeaders).toBeUndefined();
    const s = Open(StateDir(c));
    try {
      s.Put(event());
      expect(await FlushOTLP(s, c)).toBe(false);
    } finally {
      s.Close();
    }
  }
  expect(exported).toEqual([]);
});

test("a session reports to the account Kimchi was signed in to when it started", async () => {
  const actor = NewID(),
    organization = NewID();
  let verifications = 0;
  process.env.KIMCHI_REMOTE_ENDPOINT = server((request) => {
    expect(request.headers.get("authorization")).toBe("Bearer kimchi-key");
    verifications++;
    return Response.json({ organizationId: organization, userId: actor });
  });
  const start = (session: string) =>
    stdin({ hook_event_name: "SessionStart", session_id: session, cwd: root, source: "startup" });
  await CLI(["hook", "codex"], start("before-sign-in"));
  expect(verifications).toBe(0);
  kimchiFiles({ apiKey: "kimchi-key" });
  await CLI(["hook", "codex"], start("after-sign-in"));
  await CLI(["hook", "codex"], start("next"));
  expect(verifications).toBe(1);
  const c = Load();
  expect(c.actorId).toBe(actor);
  expect(SessionStateDir(c, "codex", "before-sign-in")).toBe(StateDir({}));
  expect(SessionStateDir(c, "codex", "after-sign-in")).toBe(StateDir(c));
  expect(SessionStateDir(c, "codex", "next")).toBe(StateDir(c));
});

test("flush verifies first and uploads only the signed-in account's ledger, with SSO's organization", async () => {
  const organization = NewID(),
    actor = NewID(),
    requests: { path: string; organization: string | null; body: string }[] = [];
  const apiUrl = server(async (request) => {
    const path = new URL(request.url).pathname;
    requests.push({
      path,
      organization: request.headers.get("x-castai-organization-id"),
      body: await request.text(),
    });
    if (path.endsWith("api-keys:verify"))
      return Response.json({ organizationId: organization, userId: actor });
    const batch = Parse(requests.at(-1)!.body).batch as Batch;
    return Response.json({
      batchId: batch.id,
      receipts: batch.events.map((e) => ({ id: e.id, revision: e.revision, status: "accepted" })),
    });
  });
  process.env.KIMCHI_REMOTE_ENDPOINT = apiUrl;
  // A record queued for the previously verified account stays with that account.
  const previousAccount = {
    apiUrl,
    organizationId: NewID(),
    actorId: NewID(),
    credentialHash: CredentialHash({ apiUrl, token: "earlier-key" }),
  };
  Save(previousAccount);
  const earlier = Open(StateDir(previousAccount));
  earlier.Put(event());
  earlier.Close();
  kimchiFiles(undefined, {
    "kimchi-dev": { type: "oauth", access: "sso-token", orgId: organization },
  });
  let output = "";
  await CLI(["flush"], undefined, (text) => {
    output += text;
  });
  expect(output).toBe("All pending records acknowledged.\n");
  expect(requests).toEqual([
    { path: "/ai-optimizer/v1beta/api-keys:verify", organization, body: "" },
  ]);
  const current = Open(StateDir(Load()));
  try {
    current.Put(event());
  } finally {
    current.Close();
  }
  await CLI(["flush"], undefined, () => {});
  expect(requests.map((r) => [r.path, r.organization])).toEqual([
    ["/ai-optimizer/v1beta/api-keys:verify", organization],
    [`/ai-optimizer/v1beta/organizations/${organization}/pr-cost-events:batchIngest`, organization],
  ]);
  const kept = Open(StateDir(previousAccount));
  try {
    expect(kept.Status().pending).toBe(1);
  } finally {
    kept.Close();
  }
  kimchiFiles();
  await expect(CLI(["flush"])).rejects.toThrow("sign in to Kimchi");
});
