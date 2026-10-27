import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cli } from "../src/cli.ts";
import { credentialHash, kimchiSignIn } from "../src/kimchi.ts";
import {
  loadConfig,
  saveConfig,
  sessionStateDir,
  stateDir,
  verifySignIn,
} from "../src/settings.ts";
import { flushOtlp } from "../src/work/delivery.ts";
import { Store } from "../src/work/ledger.ts";
import { parseJson, type Batch, type Event } from "../src/work/protocol.ts";

let root: string, kimchi: string;
const variables = [
  "KIMCHI_BRIDGE_HOME",
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
  process.env.KIMCHI_BRIDGE_HOME = join(root, "reporting");
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
    id: randomUUID(),
    entityId: randomUUID(),
    revision: "1",
    source: "codex",
    sourceVersion: "test",
    deviceId: randomUUID(),
    observeTime: new Date().toISOString(),
    coverage: { code: "fixture", count: "1" },
  };
}

test("reads Kimchi's API key, saved login and API in Kimchi's order", () => {
  const organization = randomUUID();
  const read = (env: Record<string, string> = {}, key = "") => kimchiSignIn(key, kimchi, env);
  const us = "https://app.kimchi.dev/api",
    eu = "https://app.eu.kimchi.dev/api";
  expect(read()).toEqual({ apiUrl: us });
  const sso = { "kimchi-dev": { type: "oauth", access: "sso-token", orgId: organization } };
  kimchiFiles(undefined, sso);
  expect(read()).toEqual({ apiUrl: us, token: "sso-token", organizationId: organization });
  kimchiFiles(undefined, { "kimchi-dev": { type: "api_key", key: "saved-key" } });
  expect(read()).toEqual({ apiUrl: us, token: "saved-key" });
  kimchiFiles({ api_key: "legacy-key", region: "eu" });
  expect(read()).toEqual({ apiUrl: eu, token: "legacy-key" });
  kimchiFiles({ apiKey: "config-key", region: "eu" }, sso);
  expect(read()).toEqual({ apiUrl: eu, token: "config-key" });
  expect(read({ KIMCHI_REGION: "us" }, "environment-key")).toEqual({
    apiUrl: us,
    token: "environment-key",
  });
  expect(read({ KIMCHI_REMOTE_ENDPOINT: "http://127.0.0.1:9" }).apiUrl).toBe("http://127.0.0.1:9");
  // Self-hosted needs all three endpoints, as Kimchi does; the old single base URL is ignored.
  const endpoints = {
    api: "https://api.example",
    console: "https://console.example/",
    llm: "https://llm.example",
  };
  kimchiFiles({ region: "self-hosted", selfHostedEndpoints: endpoints });
  expect(read().apiUrl).toBe("https://console.example/api");
  kimchiFiles({ region: "self-hosted", selfHostedEndpoints: { ...endpoints, llm: "not a url" } });
  expect(read().apiUrl).toBe("");
  kimchiFiles({ region: "self-hosted", selfHostedUrl: "https://kimchi.example/" });
  expect(read({ KIMCHI_SELF_HOSTED_URL: "https://kimchi.example" }).apiUrl).toBe("");
  // A malformed config reads as empty, as in Kimchi, so the saved login still counts.
  kimchiFiles(undefined, sso);
  writeFileSync(join(kimchi, "config.json"), "{");
  expect(read().token).toBe("sso-token");
  // An unreadable login, as while Kimchi rewrites auth.json, is not a signed-out state.
  writeFileSync(join(kimchi, "harness", "auth.json"), "{");
  expect(() => read()).toThrow("Kimchi settings could not be read");
});

test("a new key for the same account keeps its exporter; another account drops it", async () => {
  const exported: string[] = [];
  const exporter = server(async (request) => {
    exported.push(await request.text());
    return Response.json({});
  });
  for (const changed of ["actor", "organization", "endpoint"]) {
    const actor = randomUUID(),
      organization = randomUUID(),
      calls: string[] = [];
    const identity = () =>
      server((request) => {
        calls.push(request.headers.get("authorization")!);
        return Response.json({ organizationId: organization, userId: actor });
      });
    const apiUrl = identity();
    const kept = { disabled: true };
    saveConfig({
      ...kept,
      otlpUrl: exporter + "/v1/logs",
      otlpHeaders: { Authorization: "Bearer old" },
    });
    // The first verification keeps an exporter configured before it.
    let c = await verifySignIn({ apiUrl, token: "first-key" });
    expect(c).toMatchObject({ ...kept, actorId: actor, otlpUrl: exporter + "/v1/logs" });
    const account = stateDir(c);
    c = await verifySignIn({ apiUrl, token: "rotated-key" });
    expect(stateDir(c)).toBe(account);
    expect(c.otlpUrl).toBe(exporter + "/v1/logs");
    expect(await verifySignIn({ apiUrl, token: "rotated-key" })).toEqual(c);
    expect(calls).toEqual(["Bearer first-key", "Bearer rotated-key"]);

    const other = changed === "endpoint" ? identity() : apiUrl;
    const switched = server(() =>
      Response.json({
        organizationId: changed === "organization" ? randomUUID() : organization,
        userId: changed === "actor" ? randomUUID() : actor,
      }),
    );
    c = await verifySignIn({ apiUrl: changed === "endpoint" ? other : switched, token: "new-key" });
    expect(stateDir(c)).not.toBe(account);
    expect(c).toMatchObject(kept);
    expect(c.otlpUrl).toBeUndefined();
    expect(c.otlpHeaders).toBeUndefined();
    const s = new Store(stateDir(c));
    try {
      s.put(event());
      expect(await flushOtlp(s, c)).toBe(false);
    } finally {
      s.close();
    }
  }
  expect(exported).toEqual([]);
});

test("a session reports to the account Kimchi was signed in to when it started", async () => {
  const actor = randomUUID(),
    organization = randomUUID();
  let verifications = 0;
  process.env.KIMCHI_REMOTE_ENDPOINT = server((request) => {
    expect(request.headers.get("authorization")).toBe("Bearer kimchi-key");
    verifications++;
    return Response.json({ organizationId: organization, userId: actor });
  });
  const start = (session: string) =>
    stdin({ hook_event_name: "SessionStart", session_id: session, cwd: root, source: "startup" });
  await cli(["hook", "codex"], start("before-sign-in"));
  expect(verifications).toBe(0);
  kimchiFiles({ apiKey: "kimchi-key" });
  await cli(["hook", "codex"], start("after-sign-in"));
  await cli(["hook", "codex"], start("next"));
  expect(verifications).toBe(1);
  const c = loadConfig();
  expect(c.actorId).toBe(actor);
  expect(sessionStateDir(c, "codex", "before-sign-in")).toBe(stateDir({}));
  expect(sessionStateDir(c, "codex", "after-sign-in")).toBe(stateDir(c));
  expect(sessionStateDir(c, "codex", "next")).toBe(stateDir(c));
});

test("flush verifies first and uploads only the signed-in account's ledger, with SSO's organization", async () => {
  const organization = randomUUID(),
    actor = randomUUID(),
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
    const batch = parseJson(requests.at(-1)!.body).batch as Batch;
    return Response.json({
      batchId: batch.id,
      receipts: batch.events.map((e) => ({ id: e.id, revision: e.revision, status: "accepted" })),
    });
  });
  process.env.KIMCHI_REMOTE_ENDPOINT = apiUrl;
  // A record queued for the previously verified account stays with that account.
  const previousAccount = {
    apiUrl,
    organizationId: randomUUID(),
    actorId: randomUUID(),
    credentialHash: credentialHash({ apiUrl, token: "earlier-key" }),
  };
  saveConfig(previousAccount);
  const earlier = new Store(stateDir(previousAccount));
  earlier.put(event());
  earlier.close();
  kimchiFiles(undefined, {
    "kimchi-dev": { type: "oauth", access: "sso-token", orgId: organization },
  });
  let output = "";
  await cli(["flush"], undefined, (text) => {
    output += text;
  });
  expect(output).toBe("All pending records acknowledged.\n");
  expect(requests).toEqual([
    { path: "/ai-optimizer/v1beta/api-keys:verify", organization, body: "" },
  ]);
  const current = new Store(stateDir(loadConfig()));
  try {
    current.put(event());
  } finally {
    current.close();
  }
  await cli(["flush"], undefined, () => {});
  expect(requests.map((r) => [r.path, r.organization])).toEqual([
    ["/ai-optimizer/v1beta/api-keys:verify", organization],
    [`/ai-optimizer/v1beta/organizations/${organization}/pr-cost-events:batchIngest`, organization],
  ]);
  const kept = new Store(stateDir(previousAccount));
  try {
    expect(kept.status().pending).toBe(1);
  } finally {
    kept.close();
  }
  kimchiFiles();
  await expect(cli(["flush"])).rejects.toThrow("sign in to Kimchi");
});

test("a session whose sign-in cannot be verified reports to the old account only for a refreshed SSO token", async () => {
  const organization = randomUUID(),
    actor = randomUUID();
  type Answer = "401" | "slow" | "ok";
  let answer = "ok" as Answer;
  const apiUrl = server(async () => {
    if (answer === "401") return new Response(null, { status: 401 });
    if (answer === "slow") await Bun.sleep(1500);
    return Response.json({ organizationId: organization, userId: actor });
  });
  process.env.KIMCHI_REMOTE_ENDPOINT = apiUrl;
  const start = (session: string) =>
    cli(
      ["hook", "codex"],
      stdin({ hook_event_name: "SessionStart", session_id: session, cwd: root }),
    );
  const sso = (token: string, orgId = organization) =>
    kimchiFiles(undefined, { "kimchi-dev": { type: "oauth", access: token, orgId } });
  sso("first-token");
  await start("verified");
  const account = stateDir(loadConfig());
  expect(account).not.toBe(stateDir({}));
  const cases: [string, () => void, Answer, string][] = [
    ["rejected key", () => kimchiFiles({ apiKey: "rejected-key" }), "401", stateDir({})],
    [
      "unreachable with another key",
      () => kimchiFiles({ apiKey: "other-key" }),
      "slow",
      stateDir({}),
    ],
    [
      "unreachable with another SSO organization",
      () => sso("other-org-token", randomUUID()),
      "slow",
      stateDir({}),
    ],
    ["unreachable with a refreshed SSO token", () => sso("refreshed-token"), "slow", account],
    [
      "unreadable login",
      () => writeFileSync(join(kimchi, "harness", "auth.json"), "{"),
      "ok",
      account,
    ],
  ];
  for (const [name, change, response, expected] of cases) {
    change();
    answer = response;
    await start(name);
    expect([name, sessionStateDir(loadConfig(), "codex", name)]).toEqual([name, expected]);
  }
});

test("verifying keeps settings changed while the request was in flight", async () => {
  const apiUrl = server(async () => {
    // The user pauses recording while the sign-in is being verified.
    await cli(["disable"], undefined, () => {});
    return Response.json({ organizationId: randomUUID(), userId: randomUUID() });
  });
  const c = await verifySignIn({ apiUrl, token: "kimchi-key" });
  expect(c.disabled).toBe(true);
  expect(loadConfig().disabled).toBe(true);
});
