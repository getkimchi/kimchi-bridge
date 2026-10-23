import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserLogin, Login } from "../src/login.ts";
import { CredentialHash, FlushOTLP } from "../src/delivery.ts";
import { Open } from "../src/ledger.ts";
import { Load, Save, SessionStateDir, StateDir } from "../src/settings.ts";
import { NewID } from "../src/protocol.ts";

let root: string, configPath: string;
let previousRoot: string | undefined;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  previousRoot = process.env.KIMCHI_ADAPTERS_HOME;
  root = mkdtempSync(join(tmpdir(), "kimchi-login-"));
  configPath = join(root, "kimchi-config.json");
  process.env.KIMCHI_ADAPTERS_HOME = join(root, "reporting");
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.KIMCHI_ADAPTERS_HOME;
  else process.env.KIMCHI_ADAPTERS_HOME = previousRoot;
});
function server(handler: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => running.stop(true));
  return running.url.href.slice(0, -1);
}
function identityServer(key: string, actor = NewID(), organization = NewID()) {
  const paths: string[] = [];
  const apiUrl = server((req) => {
    expect(req.headers.get("authorization")).toBe(`Bearer ${key}`);
    paths.push(new URL(req.url).pathname);
    return Response.json(
      paths.at(-1)!.endsWith("api-keys:verify")
        ? { organizationId: organization, userId: actor }
        : { id: actor, username: "auth0|fixture" },
    );
  });
  return { apiUrl, actor, organization, paths };
}
const base = () => ({
  _kimchiConfigPath: configPath,
  _environment: {},
  onMessage: (_message: string) => {},
});
async function sendKey(browserUrl: string, key = "castai_v1_synthetic") {
  const url = new URL(browserUrl),
    callback = new URL(url.searchParams.get("callback")!);
  expect(url.pathname).toBe("/cli-auth");
  expect(url.searchParams.get("state")!.length).toBe(64);
  expect(callback.hostname).toBe("127.0.0.1");
  expect(callback.pathname).toBe("/callback");
  callback.searchParams.set("token", key);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  const response = await fetch(callback);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(key);
}

test("explicit Kimchi import reuses environment key, verifies owner, and preserves both account pins and inference settings", async () => {
  const previous = {
    apiUrl: "https://api.cast.ai",
    organizationId: NewID(),
    actorId: NewID(),
    apiKey: "old-key",
    enabled: true,
    disabled: true,
    runtimeExecutable: "/owned/helper",
    runtimeRevision: NewID(),
    otlpUrl: "https://collector.example/v1/logs",
  };
  Save({ ...previous, credentialHash: CredentialHash(previous) });
  const oldDir = SessionStateDir(Load(), "codex", "existing-session");
  const { apiUrl, actor, organization } = identityServer("environment-key");
  const original = JSON.stringify({
    apiKey: "saved-key",
    region: "eu",
    llmEndpoint: "https://inference.example/keep",
    telemetry: { enabled: false },
  });
  writeFileSync(configPath, original);
  const output: string[] = [];
  expect(
    await Login({
      ...base(),
      fromKimchi: true,
      _environment: { KIMCHI_API_KEY: "environment-key", KIMCHI_REMOTE_ENDPOINT: apiUrl },
      onMessage: (line) => {
        output.push(line);
      },
    }),
  ).toBe(true);
  const c = Load();
  expect(c.apiKey).toBe("environment-key");
  expect(c.actorId).toBe(actor);
  expect(c.organizationId).toBe(organization);
  expect(c.disabled).toBe(true);
  expect(c.runtimeExecutable).toBe(previous.runtimeExecutable);
  expect(c.otlpUrl).toBeUndefined();
  expect(SessionStateDir(c, "codex", "existing-session")).toBe(oldDir);
  expect(StateDir(c)).not.toBe(oldDir);
  expect(readFileSync(configPath, "utf8")).toBe(original);
  expect(statSync(join(process.env.KIMCHI_ADAPTERS_HOME!, "config.json")).mode & 0o777).toBe(0o600);
  expect(output.join("\n")).not.toContain("environment-key");
});

test("installer import keeps the verified reporting account without reading another Kimchi login", async () => {
  const selected = {
    apiUrl: "https://reporting.example",
    organizationId: NewID(),
    actorId: NewID(),
    apiKey: "selected-reporting-key",
    enabled: true,
    disabled: true,
    runtimeExecutable: "/owned/helper",
    runtimeRevision: NewID(),
    otlpUrl: "https://collector.example/v1/logs",
  };
  Save({ ...selected, credentialHash: CredentialHash(selected) });
  const reportingPath = join(process.env.KIMCHI_ADAPTERS_HOME!, "config.json");
  const original = readFileSync(reportingPath, "utf8");
  writeFileSync(configPath, "Kimchi settings must not be read by an update");
  const { apiUrl, paths, actor } = identityServer("other-environment-key");
  const environment = { KIMCHI_API_KEY: "other-environment-key", KIMCHI_REMOTE_ENDPOINT: apiUrl };
  const messages: string[] = [];
  expect(
    await Login({
      ...base(),
      fromKimchi: true,
      ifPresent: true,
      _environment: environment,
      onMessage: (message) => {
        messages.push(message);
      },
    }),
  ).toBe(true);
  expect(paths).toEqual([]);
  expect(readFileSync(reportingPath, "utf8")).toBe(original);
  expect(messages.length).toBe(1);
  expect(messages[0]).not.toContain("selected-reporting-key");
  expect(messages[0]).not.toContain("other-environment-key");
  // A plain import remains an explicit request to select the current Kimchi account.
  writeFileSync(configPath, JSON.stringify({ apiKey: "other-saved-key" }));
  expect(await Login({ ...base(), fromKimchi: true, _environment: environment })).toBe(true);
  expect(paths.length).toBe(2);
  expect(Load().actorId).toBe(actor);
  expect(Load().apiKey).toBe("other-environment-key");
  expect(Load().disabled).toBe(true);
});

test("same-account key rotation preserves that account's exporter", async () => {
  const actor = NewID(),
    organization = NewID();
  const { apiUrl } = identityServer("rotated-key", actor, organization);
  const previous = {
    apiUrl,
    actorId: actor,
    organizationId: organization,
    apiKey: "old-key",
    enabled: true,
    otlpUrl: "https://collector.example/v1/logs",
    otlpHeaders: { Authorization: "Bearer same-account-exporter" },
  };
  Save({ ...previous, credentialHash: CredentialHash(previous) });
  const originalAccount = StateDir(Load());
  writeFileSync(configPath, JSON.stringify({ apiKey: "rotated-key" }));
  expect(
    await Login({ ...base(), fromKimchi: true, _environment: { KIMCHI_REMOTE_ENDPOINT: apiUrl } }),
  ).toBe(true);
  const current = Load();
  expect(StateDir(current)).toBe(originalAccount);
  expect(current.otlpUrl).toBe(previous.otlpUrl);
  expect(current.otlpHeaders).toEqual(previous.otlpHeaders);
});

test("switching report identity never exports the new account's records to the old exporter", async () => {
  const exported: string[] = [];
  const oldExporter = server(async (request) => {
    exported.push(await request.text());
    return Response.json({});
  });
  for (const changed of ["actor", "organization", "endpoint"]) {
    const actor = NewID(),
      organization = NewID();
    const { apiUrl } = identityServer("new-account-key", actor, organization);
    const previous = {
      apiUrl: changed === "endpoint" ? "https://old-reporting.example" : apiUrl,
      actorId: changed === "actor" ? NewID() : actor,
      organizationId: changed === "organization" ? NewID() : organization,
      apiKey: "old-account-key",
      enabled: true,
      disabled: true,
      runtimeExecutable: "/owned/helper",
      runtimeRevision: NewID(),
      otlpUrl: oldExporter + "/v1/logs",
      otlpHeaders: { Authorization: "Bearer old-account-exporter" },
    };
    Save({ ...previous, credentialHash: CredentialHash(previous) });
    writeFileSync(configPath, JSON.stringify({ apiKey: "new-account-key" }));
    expect(
      await Login({
        ...base(),
        fromKimchi: true,
        _environment: { KIMCHI_REMOTE_ENDPOINT: apiUrl },
      }),
    ).toBe(true);
    const current = Load(),
      s = Open(StateDir(current));
    try {
      s.Put({
        id: NewID(),
        entityId: NewID(),
        revision: "1",
        deviceId: s.DeviceID(),
        source: "codex",
        sourceVersion: "test",
        observeTime: new Date().toISOString(),
        coverage: { code: "new_account_record", count: "1" },
      });
      expect(await FlushOTLP(s, current)).toBe(false);
    } finally {
      s.Close();
    }
    expect(exported).toEqual([]);
    expect(current.otlpUrl).toBeUndefined();
    expect(current.otlpHeaders).toBeUndefined();
    expect(current.disabled).toBe(true);
    expect(current.runtimeExecutable).toBe(previous.runtimeExecutable);
    expect(current.runtimeRevision).toBe(previous.runtimeRevision);
  }
});

test("explicit import accepts legacy key spelling and missing-key installer mode stays quiet", async () => {
  const messages: string[] = [];
  expect(
    await Login({
      ...base(),
      fromKimchi: true,
      ifPresent: true,
      onMessage: (message) => {
        messages.push(message);
      },
    }),
  ).toBe(false);
  expect(messages).toEqual([]);
  await expect(Login({ ...base(), fromKimchi: true })).rejects.toThrow("No saved Kimchi API key");
  const { apiUrl } = identityServer("legacy-key");
  writeFileSync(configPath, JSON.stringify({ api_key: "legacy-key" }));
  expect(
    await Login({ ...base(), fromKimchi: true, _environment: { KIMCHI_REMOTE_ENDPOINT: apiUrl } }),
  ).toBe(true);
  expect(Load().apiKey).toBe("legacy-key");
});

test("Kimchi key login replaces a legacy reporting bearer without carrying two credentials", async () => {
  const legacy = {
    apiUrl: "https://api.cast.ai",
    organizationId: NewID(),
    actorId: NewID(),
    accessToken: "legacy-bearer",
    enabled: true,
  };
  Save({ ...legacy, credentialHash: CredentialHash(legacy) });
  const { apiUrl } = identityServer("replacement-key");
  writeFileSync(configPath, JSON.stringify({ apiKey: "replacement-key" }));
  expect(
    await Login({ ...base(), fromKimchi: true, _environment: { KIMCHI_REMOTE_ENDPOINT: apiUrl } }),
  ).toBe(true);
  expect(Load().apiKey).toBe("replacement-key");
  expect(Load().accessToken).toBeUndefined();
});

test("normal standalone login uses the house browser handoff and creates a reporting login without importing an old key", async () => {
  const { apiUrl, paths } = identityServer("castai_v1_new-key");
  writeFileSync(configPath, JSON.stringify({ apiKey: "do-not-reuse", region: "eu" }));
  let opened = "";
  expect(
    await Login({
      ...base(),
      _environment: { KIMCHI_REGION: "invalid", KIMCHI_REMOTE_ENDPOINT: apiUrl },
      _open: async (url) => {
        opened = url;
        await sendKey(url, "castai_v1_new-key");
      },
    }),
  ).toBe(true);
  expect(new URL(opened).origin).toBe("https://app.eu.kimchi.dev");
  expect(paths).toEqual(["/ai-optimizer/v1beta/api-keys:verify", "/v1/me"]);
  expect(Load().apiKey).toBe("castai_v1_new-key");
});

test("explicit self-hosted console uses discovery API origin and preserves inference config", async () => {
  const { apiUrl } = identityServer("castai_v1_selfhost");
  let discovery = 0;
  let consoleUrl = "";
  consoleUrl = server((req) => {
    expect(new URL(req.url).pathname).toBe("/env/endpoints.json");
    discovery++;
    return Response.json({
      api: apiUrl,
      console: consoleUrl,
      llm: "https://untouched-inference.example",
    });
  });
  expect(
    await Login({ ...base(), consoleUrl, _open: (url) => sendKey(url, "castai_v1_selfhost") }),
  ).toBe(true);
  expect(discovery).toBe(1);
  expect(Load().apiUrl).toBe(apiUrl);
  expect("llmEndpoint" in Load()).toBe(false);
});

test("self-hosted saved endpoint import and explicit region overrides are bounded by owner verification", async () => {
  const { apiUrl } = identityServer("selfhost-key");
  writeFileSync(
    configPath,
    JSON.stringify({
      apiKey: "selfhost-key",
      region: "self-hosted",
      selfHostedEndpoints: {
        api: apiUrl,
        console: "https://console.example",
        llm: "https://inference.example",
      },
    }),
  );
  expect(await Login({ ...base(), fromKimchi: true })).toBe(true);
  expect(Load().apiUrl).toBe(apiUrl);
  await expect(Login({ ...base(), region: "other" })).rejects.toThrow("choose region");
});

test("failed verification and cancelled callbacks never replace an existing reporting account", async () => {
  const original = {
    apiUrl: "https://api.cast.ai",
    organizationId: NewID(),
    actorId: NewID(),
    apiKey: "existing-key",
    enabled: true,
  };
  Save({ ...original, credentialHash: CredentialHash(original) });
  const saved = Load();
  const apiUrl = server(() => Response.json({ error: "never-log-key" }, { status: 401 }));
  writeFileSync(configPath, JSON.stringify({ apiKey: "revoked-key" }));
  await expect(
    Login({ ...base(), fromKimchi: true, _environment: { KIMCHI_REMOTE_ENDPOINT: apiUrl } }),
  ).rejects.toThrow("HTTP 401");
  expect(Load()).toEqual(saved);
  await expect(
    Login({
      ...base(),
      _open: async (browserUrl) => {
        const url = new URL(browserUrl),
          callback = new URL(url.searchParams.get("callback")!);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("error_description", "synthetic-secret-should-not-be-logged");
        const response = await fetch(callback);
        expect(await response.text()).not.toContain("synthetic-secret");
      },
    }),
  ).rejects.toThrow("cancelled or rejected");
  expect(Load()).toEqual(saved);
});

test("browser callback validates state, path, missing key and aborts without leaking token", async () => {
  for (const mode of ["state", "missing", "abort"]) {
    const controller = new AbortController();
    let callbackUrl = "";
    const operation = browserLogin({
      webAppUrl: "https://app.kimchi.dev",
      signal: controller.signal,
      onMessage: () => {},
      _open: async (browserUrl) => {
        const url = new URL(browserUrl),
          callback = new URL(url.searchParams.get("callback")!);
        callbackUrl = callback.href;
        const badPath = new URL(callback);
        badPath.pathname = "/other";
        expect((await fetch(badPath)).status).toBe(404);
        if (mode === "abort") {
          controller.abort();
          return;
        }
        callback.searchParams.set(
          "state",
          mode === "state" ? "wrong-state" : url.searchParams.get("state")!,
        );
        if (mode === "state") callback.searchParams.set("token", "castai_v1_private");
        const response = await fetch(callback);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("castai_v1_private");
      },
    });
    await expect(operation).rejects.toThrow();
    await Bun.sleep(110);
    await expect(fetch(callbackUrl)).rejects.toThrow();
  }
});

test("browser timeout, already-aborted signal and opener fallback are safe", async () => {
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  await expect(
    browserLogin({
      webAppUrl: "https://app.kimchi.dev",
      signal: controller.signal,
      _open: async () => {
        opened = true;
      },
    }),
  ).rejects.toThrow();
  expect(opened).toBe(false);
  const messages: string[] = [];
  await expect(
    browserLogin({
      webAppUrl: "https://app.kimchi.dev",
      onMessage: (message) => {
        messages.push(message);
      },
      _timeoutMs: 5,
      _open: async () => {
        throw new Error("synthetic opener failure");
      },
    }),
  ).rejects.toThrow("timed out");
  expect(messages.some((line) => line.includes("manually"))).toBe(true);
  expect(messages.join("\n")).not.toContain("synthetic opener failure");
});

test("headless browser login prints only the safe launch URL and returns a verified callback key", async () => {
  const key = await browserLogin({
    webAppUrl: "https://app.kimchi.dev",
    noBrowser: true,
    onMessage: (message) => {
      if (message.startsWith("Kimchi login: "))
        void sendKey(message.slice("Kimchi login: ".length));
    },
  });
  expect(key).toBe("castai_v1_synthetic");
});
