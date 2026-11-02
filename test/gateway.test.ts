import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCodexCatalog,
  buildCodexToml,
  claudeDesktop3pData,
  claudeSettingsPath,
  codexCatalogPath,
  codexConfigPath,
  disable,
  enable,
  ensureClaudeAutoMode,
  gatewayPort,
  gatewayStatePath,
  health,
  loadGatewayState,
  mergeCodexToml,
  proxyRequest,
  resolveMainModel,
  rewriteClaudeDesktopConfig,
  runDaemon,
  saveGatewayState,
  status,
  stripCodexToml,
  writeClaudeDesktopConfig,
  type GatewayModel,
  type GatewayState,
} from "../src/gateway.ts";
import { credentialPath, saveCredential } from "../src/oauth.ts";
import type { SignIn } from "../src/kimchi.ts";
import { tagFor } from "../src/request-tags.ts";

const org = "22222222-2222-4222-8222-222222222222";
const user = "11111111-1111-4111-8111-111111111111";

let root: string;
let previousRoot: string | undefined;
let previousBase: string | undefined;
let previousHome: string | undefined;
let previousXdg: string | undefined;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  previousRoot = process.env.KIMCHI_BRIDGE_HOME;
  previousBase = process.env.KIMCHI_BASE_URL;
  root = mkdtempSync(join(tmpdir(), "kimchi-bridge-gateway-"));
  // Kimchi's saved sign-in is read from HOME; never the developer's own.
  previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  process.env.KIMCHI_BRIDGE_CONFIG_HOME = join(root, "home");
  // On Linux, Claude Desktop's profiles live under XDG_CONFIG_HOME, which CI runners set to their own.
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "home", ".config");
  process.env.KIMCHI_BRIDGE_HOME = join(root, "state");
  process.env.KIMCHI_BRIDGE_SERVICE = "0";
  process.env.KIMCHI_BRIDGE_DAEMON = "0";
  process.env.KIMCHI_GATEWAY_PORT = "";
  delete process.env.KIMCHI_BASE_URL;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(root, { recursive: true, force: true });
  delete process.env.KIMCHI_BRIDGE_CONFIG_HOME;
  delete process.env.KIMCHI_BRIDGE_SERVICE;
  delete process.env.KIMCHI_BRIDGE_DAEMON;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  if (previousBase === undefined) delete process.env.KIMCHI_BASE_URL;
  else process.env.KIMCHI_BASE_URL = previousBase;
  if (previousRoot === undefined) delete process.env.KIMCHI_BRIDGE_HOME;
  else process.env.KIMCHI_BRIDGE_HOME = previousRoot;
});
function server(handler: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => running.stop(true));
  return running.url.href.slice(0, -1);
}

const models: GatewayModel[] = [
  {
    slug: "minimax-m3",
    display_name: "MiniMax M3",
    reasoning: true,
    input_modalities: ["text", "image"],
    is_serverless: true,
    limits: { context_window: 262144, max_output_tokens: 32768 },
  },
  {
    slug: "kimi-k2.6",
    display_name: "Kimi K2.6",
    reasoning: true,
    is_serverless: true,
    limits: { context_window: 262144, max_output_tokens: 32768 },
  },
];
/** Kimchi's saved API-key sign-in, as its global config stores it. */
function kimchiKey(apiKey: string, region = "us") {
  mkdirSync(join(root, "home", ".config", "kimchi"), { recursive: true });
  writeFileSync(
    join(root, "home", ".config", "kimchi", "config.json"),
    JSON.stringify({ apiKey, region }),
  );
}

function modelsEndpoint(listed = models): string {
  return server((request) => {
    if (new URL(request.url).pathname === "/v1/models/metadata")
      return Response.json({ models: listed });
    return new Response("not found", { status: 404 });
  });
}
function oauthCredential() {
  saveCredential({
    region: "us",
    tokenUrl: "https://login.kimchi.dev/oauth/token",
    clientId: "c",
    audience: "https://app.kimchi.dev",
    useIdToken: true,
    accessToken: "access",
    idToken: "id-token",
    refreshToken: "refresh",
    expires: Date.now() + 3600_000,
    orgId: org,
    orgName: "Org",
    actorId: user,
    actorUsername: "u",
  });
}
const oauthSignIn: SignIn = {
  apiUrl: "https://api.cast.ai",
  token: "id-token",
  organizationId: org,
};

test("buildCodexCatalog falls back to the slug when display_name is empty (blank picker rows)", () => {
  const catalog = buildCodexCatalog([
    {
      slug: "claude-opus-5",
      display_name: "",
      is_serverless: true,
      limits: { context_window: 262144, max_output_tokens: 32768 },
    },
    {
      slug: "glm-5.3-flash",
      display_name: "GLM 5.3 Flash",
      is_serverless: true,
      limits: { context_window: 262144, max_output_tokens: 32768 },
    },
  ] as unknown as GatewayModel[]);
  expect(catalog.models[0].display_name).toBe("claude-opus-5");
  expect(catalog.models[1].display_name).toBe("GLM 5.3 Flash");
});

test("buildCodexToml emits the provider block and top-level keys", () => {
  const out = buildCodexToml(
    "http://127.0.0.1:8766/openai/v1",
    "bearer-x",
    "kimi-k2.6",
    "/cat.json",
  );
  expect(out).toContain('model_provider = "kimchi"');
  expect(out).toContain('model = "kimi-k2.6"');
  expect(out).toContain('model_catalog_json = "/cat.json"');
  expect(out).toContain("[model_providers.kimchi]");
  expect(out).toContain('name = "Kimchi Gateway"');
  expect(out).toContain('base_url = "http://127.0.0.1:8766/openai/v1"');
  expect(out).toContain('http_headers = { Authorization = "Bearer bearer-x" }');
  expect(out).toContain('wire_api = "responses"');
});

test("strip and merge preserve user sections and replace only the kimchi block", () => {
  const existing = `model_provider = "openai"
model = "gpt-5"
model_catalog_json = "/old.json"

[model_providers.kimchi]
name = "Old"
base_url = "https://old.example/v1"

[model_providers.kimchi.deep]
nested = true

[features]
multi_agent = true

[[projects]]
name = "p"
path = "/p"
`;
  const stripped = stripCodexToml(existing);
  expect(stripped).not.toContain("model_providers.kimchi");
  expect(stripped).not.toContain("model_provider = ");
  expect(stripped).not.toContain("Old");
  expect(stripped).not.toContain('model_catalog_json = "/old.json"');
  expect(stripped).toContain("[features]");
  expect(stripped).toContain("multi_agent = true");
  expect(stripped).toContain("[[projects]]");
  const merged = mergeCodexToml(existing, buildCodexToml("http://l/v1", "k", "m", "/c.json"));
  expect(merged.startsWith('model_provider = "kimchi"')).toBe(true);
  expect(merged.split("model_provider =").length - 1).toBe(1);
  expect(merged).toContain("[features]");
  expect(merged).toContain("[[projects]]");
});

test("catalog and main-model resolution mirror Kimchi's selection", () => {
  const catalog = buildCodexCatalog(models);
  expect(catalog.models).toHaveLength(2);
  expect(catalog.models[0]).toMatchObject({
    slug: "minimax-m3",
    provider: "kimchi",
    context_window: 262144,
    supports_reasoning_summaries: true,
  });
  expect(catalog.models[0].supported_reasoning_levels.map((l) => l.effort)).toEqual([
    "low",
    "medium",
    "high",
  ]);
  expect(catalog.models[1].supports_reasoning_summaries).toBe(true);
  expect(resolveMainModel(models).slug).toBe("minimax-m3");
  expect(
    resolveMainModel([
      { ...models[1], is_serverless: false },
      {
        slug: "vision-model",
        display_name: "V",
        is_serverless: true,
        input_modalities: ["text", "image"],
        limits: { context_window: 10, max_output_tokens: 10 },
      },
    ]).slug,
  ).toBe("vision-model");
});

test("enable in proxy mode writes proxy URLs and never a real credential into the CLI configs", async () => {
  const llm = modelsEndpoint();
  process.env.KIMCHI_BASE_URL = llm;
  oauthCredential();
  const messages: string[] = [];
  await enable(oauthSignIn, (m) => messages.push(m));
  const claude = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  expect(claude.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8766/anthropic");
  expect(claude.env.ANTHROPIC_API_KEY).toBe("");
  expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe("kimchi-gateway");
  // The beta kill-switch is deliberately not written: the telemetry collector
  // that feeds PR-cost usage attribution is beta-gated.
  expect(claude.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
  // No model behind the gateway runs auto mode's server-side checks, so Claude Code makes its own classifier calls.
  expect(claude.env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe("0");
  const codex = readFileSync(codexConfigPath(), "utf8");
  expect(codex).toContain('base_url = "http://127.0.0.1:8766/openai/v1"');
  expect(codex).not.toContain("id-token");
  expect(codex).not.toContain("refresh");
  const catalog = JSON.parse(readFileSync(codexCatalogPath(), "utf8"));
  expect(catalog.models).toHaveLength(2);
  const state = loadGatewayState();
  expect(state.enabled).toBe(true);
  expect(state.mode).toBe("proxy");
  expect(state.port).toBe(8766);
  expect(messages.some((m) => m.includes("Gateway enabled"))).toBe(true);
});

/** Marks Claude Desktop installed: its main profile holds a config.json. Returns that profile's folder. */
function desktopInstalled(): string {
  const main = join(dirname(claudeDesktop3pData()), "Claude");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, "config.json"), "{}");
  return main;
}
/** The configLibrary entry the app applies. */
function desktopEntry(): Record<string, unknown> {
  const library = join(claudeDesktop3pData(), "configLibrary");
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  return JSON.parse(readFileSync(join(library, `${meta.appliedId}.json`), "utf8"));
}
/** A Claude model: without one, enable leaves Claude Desktop as it is. */
const sonnet: GatewayModel[] = [
  { ...models[0]!, slug: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
];
/** Serves the models with a Claude one and stores an OAuth sign-in, so enable wires Claude Desktop. */
function serveClaudeModels() {
  process.env.KIMCHI_BASE_URL = server((request) =>
    new URL(request.url).pathname === "/v1/models/metadata"
      ? Response.json({ models: [...models, ...sonnet] })
      : new Response("not found", { status: 404 }),
  );
  oauthCredential();
}

test("enable gives Claude Desktop only the Claude models, which it takes without a warning", async () => {
  desktopInstalled();
  const claude: GatewayModel[] = [
    { ...models[0]!, slug: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    { ...models[0]!, slug: "anthropic/claude-opus-4-6", display_name: "Claude Opus 4.6" },
  ];
  process.env.KIMCHI_BASE_URL = server((request) =>
    new URL(request.url).pathname === "/v1/models/metadata"
      ? Response.json({ models: [...models, ...claude] })
      : new Response("not found", { status: 404 }),
  );
  oauthCredential();
  await enable(oauthSignIn, () => {});
  expect(desktopEntry().inferenceModels).toEqual([
    { name: "claude-sonnet-4-6" },
    { name: "anthropic/claude-opus-4-6" },
  ]);
});

test("without a Claude model enable leaves Claude Desktop as it was", async () => {
  const main = desktopInstalled();
  process.env.KIMCHI_BASE_URL = modelsEndpoint();
  oauthCredential();
  await enable(oauthSignIn, () => {});
  expect(existsSync(join(claudeDesktop3pData(), "configLibrary"))).toBe(false);
  expect(existsSync(join(main, "claude_desktop_config.json"))).toBe(false);
});

test("the proxy's rewrite drops the models an older bridge gave Claude Desktop", () => {
  desktopInstalled();
  const library = join(claudeDesktop3pData(), "configLibrary"),
    id = "11111111-2222-4333-8444-555555555555";
  mkdirSync(library, { recursive: true });
  writeFileSync(
    join(library, "_meta.json"),
    JSON.stringify({ appliedId: id, entries: [{ id, name: "Kimchi Gateway" }] }),
  );
  writeFileSync(
    join(library, `${id}.json`),
    JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:8766/anthropic",
      inferenceModels: [{ name: "glm-5.3" }, { name: "claude-sonnet-4-6" }, { name: "kimi-k3" }],
    }),
  );
  rewriteClaudeDesktopConfig("http://127.0.0.1:8767/anthropic");
  expect(desktopEntry()).toMatchObject({
    inferenceGatewayBaseUrl: "http://127.0.0.1:8767/anthropic",
    inferenceModels: [{ name: "claude-sonnet-4-6" }],
  });
});

test("enable twice, then disable, restores Claude Desktop's own configuration", async () => {
  const main = desktopInstalled();
  serveClaudeModels();
  await enable(oauthSignIn, () => {});
  await enable(oauthSignIn, () => {}); // e.g. a second sign-in runs enable again
  // The re-enable keeps the first enable's snapshot: the recomputed one would
  // record the bridge's own 3P mode and entry as the person's.
  const snapshot = loadGatewayState().previous?.claudeDesktop;
  expect(snapshot?.mode).toBeNull();
  expect(snapshot?.appliedId).toBeNull();
  await disable(() => {});
  const config = JSON.parse(readFileSync(join(main, "claude_desktop_config.json"), "utf8"));
  expect(config.deploymentMode).toBeUndefined();
  const library = join(claudeDesktop3pData(), "configLibrary");
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  expect(meta.appliedId).toBeUndefined();
  expect(meta.entries).toEqual([]);
  expect(readdirSync(library)).toEqual(["_meta.json"]);
});

test("disable repairs a snapshot an older bridge saved after two enables", async () => {
  const main = desktopInstalled();
  // The older bridge's second enable recomputed the snapshot after its own
  // first one, so it recorded the bridge's entry as the applied one.
  writeClaudeDesktopConfig("http://127.0.0.1:8766/anthropic", sonnet);
  const damaged = writeClaudeDesktopConfig("http://127.0.0.1:8766/anthropic", sonnet);
  if (!damaged) throw new Error("the desktop writer returned no snapshot");
  expect(damaged.appliedId).toBe(damaged.entryId);
  saveGatewayState({
    enabled: true,
    mode: "proxy",
    port: 8766,
    previous: { claudeDesktop: damaged },
  });
  await disable(() => {});
  // The person's own setup is unrecoverable from such a snapshot, so the
  // disable restores the app default.
  const config = JSON.parse(readFileSync(join(main, "claude_desktop_config.json"), "utf8"));
  expect(config.deploymentMode).toBeUndefined();
  const library = join(claudeDesktop3pData(), "configLibrary");
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  expect(meta.appliedId).toBeUndefined();
  expect(meta.entries).toEqual([]);
  expect(readdirSync(library)).toEqual(["_meta.json"]);
});

test("enable twice, then disable, applies the person's own Claude Desktop entry again", async () => {
  const main = desktopInstalled();
  const library = join(claudeDesktop3pData(), "configLibrary"),
    work = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  mkdirSync(library, { recursive: true });
  writeFileSync(
    join(library, "_meta.json"),
    JSON.stringify({ appliedId: work, entries: [{ id: work, name: "Work" }] }),
  );
  writeFileSync(
    join(library, `${work}.json`),
    JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://work.example.invalid/anthropic",
    }),
  );
  writeFileSync(join(main, "claude_desktop_config.json"), JSON.stringify({ deploymentMode: "3p" }));
  serveClaudeModels();
  await enable(oauthSignIn, () => {});
  await enable(oauthSignIn, () => {});
  await disable(() => {});
  const config = JSON.parse(readFileSync(join(main, "claude_desktop_config.json"), "utf8"));
  expect(config.deploymentMode).toBe("3p");
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  expect(meta.appliedId).toBe(work);
  expect(meta.entries).toEqual([{ id: work, name: "Work" }]);
});

test("disable gives back a Kimchi Gateway entry the person applied before enabling", async () => {
  const main = desktopInstalled();
  const library = join(claudeDesktop3pData(), "configLibrary"),
    id = "11111111-2222-4333-8444-555555555555";
  mkdirSync(library, { recursive: true });
  // The person's own entry under the bridge's entry name, with their own gateway and key.
  const own = JSON.stringify({
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "https://llm.example.invalid/anthropic",
    inferenceGatewayApiKey: "the-person's-own-key",
  });
  writeFileSync(
    join(library, "_meta.json"),
    JSON.stringify({ appliedId: id, entries: [{ id, name: "Kimchi Gateway" }] }),
  );
  writeFileSync(join(library, `${id}.json`), own);
  writeFileSync(join(main, "claude_desktop_config.json"), JSON.stringify({ deploymentMode: "3p" }));
  serveClaudeModels();
  await enable(oauthSignIn, () => {});
  await disable(() => {});
  const config = JSON.parse(readFileSync(join(main, "claude_desktop_config.json"), "utf8"));
  expect(config.deploymentMode).toBe("3p");
  expect(existsSync(join(library, `${id}.json`))).toBe(true);
  expect(readFileSync(join(library, `${id}.json`), "utf8")).toBe(own);
  expect(JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")).appliedId).toBe(id);
});

test("repairing an older bridge's snapshot keeps an entry the person applied since", async () => {
  desktopInstalled();
  writeClaudeDesktopConfig("http://127.0.0.1:8766/anthropic", sonnet);
  const damaged = writeClaudeDesktopConfig("http://127.0.0.1:8766/anthropic", sonnet);
  if (!damaged) throw new Error("the desktop writer returned no snapshot");
  saveGatewayState({
    enabled: true,
    mode: "proxy",
    port: 8766,
    previous: { claudeDesktop: damaged },
  });
  // Since that enable, the person has switched Claude Desktop to an entry of their own.
  const library = join(claudeDesktop3pData(), "configLibrary"),
    work = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  meta.entries.push({ id: work, name: "Work" });
  meta.appliedId = work;
  writeFileSync(join(library, "_meta.json"), JSON.stringify(meta));
  writeFileSync(join(library, `${work}.json`), "{}");
  await disable(() => {});
  const after = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  expect(after.appliedId).toBe(work);
  expect(after.entries).toEqual([{ id: work, name: "Work" }]);
});

test("enable with an API key routes through the local proxy and keeps the key out of the CLI configs", async () => {
  const llm = modelsEndpoint();
  process.env.KIMCHI_BASE_URL = llm;
  kimchiKey("castai_v1_key");
  await enable({ apiUrl: "https://api.cast.ai", token: "castai_v1_key" }, undefined, null);
  const claude = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  expect(claude.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8766/anthropic");
  expect(claude.env.ANTHROPIC_AUTH_TOKEN).not.toBe("castai_v1_key");
  const codex = readFileSync(codexConfigPath(), "utf8");
  expect(codex).toContain('base_url = "http://127.0.0.1:8766/openai/v1"');
  expect(codex).not.toContain("castai_v1_key");
  expect(loadGatewayState().mode).toBe("proxy");
  expect(existsSync(credentialPath())).toBe(false);
});

test("an API-key sign-in's region picks the gateway behind the proxy (no KIMCHI_BASE_URL)", async () => {
  delete process.env.KIMCHI_BASE_URL;
  const original = globalThis.fetch;
  const fetched: string[] = [];
  const stub = (async (input: any) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    fetched.push(url);
    if (url.includes("/v1/models/metadata"))
      return Response.json({
        models: [
          {
            slug: "minimax-m3",
            is_serverless: true,
            limits: { context_window: 262144, max_output_tokens: 32768 },
          },
        ],
      });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = stub;
  try {
    kimchiKey("castai_v1_key", "us");
    await enable({ apiUrl: "https://app.kimchi.dev/api", token: "castai_v1_key" }, undefined, null);
    expect(fetched.some((url) => url.startsWith("https://llm.kimchi.dev/"))).toBe(true);
    expect(loadGatewayState().mode).toBe("proxy");
    await disable();
    kimchiKey("castai_v1_key", "eu");
    await enable(
      { apiUrl: "https://app.eu.kimchi.dev/api", token: "castai_v1_key" },
      undefined,
      null,
    );
    expect(fetched.some((url) => url.startsWith("https://llm.eu.kimchi.dev/"))).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("enable refuses a key that only KIMCHI_API_KEY holds, which the proxy daemon never sees", async () => {
  process.env.KIMCHI_BASE_URL = modelsEndpoint();
  await expect(
    enable({ apiUrl: "https://app.kimchi.dev/api", token: "castai_v1_key" }, undefined, null),
  ).rejects.toThrow("the gateway proxy needs a saved sign-in");
  expect(existsSync(claudeSettingsPath())).toBe(false);
  expect(existsSync(codexConfigPath())).toBe(false);
});

test("enable without a sign-in leaves nothing written", async () => {
  await expect(enable({ apiUrl: "", token: "" }, undefined, null)).rejects.toThrow(
    "run kimchi-bridge login before enabling the gateway",
  );
  expect(existsSync(claudeSettingsPath())).toBe(false);
  expect(existsSync(codexConfigPath())).toBe(false);
});

test("disable restores pre-existing values, removes the catalog, and stops the proxy mode", async () => {
  const llm = modelsEndpoint();
  process.env.KIMCHI_BASE_URL = llm;
  mkdirSync(join(root, "home", ".claude"), { recursive: true });
  mkdirSync(join(root, "home", ".codex"), { recursive: true });
  writeFileSync(
    claudeSettingsPath(),
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://old-gateway.example", ANTHROPIC_CUSTOM: "keep" },
      other: true,
    }),
  );
  writeFileSync(
    codexConfigPath(),
    `model = "gpt-5"\nmodel_reasoning_effort = "high"\n\n[features]\nmulti_agent = true\n`,
  );
  oauthCredential();
  await enable(oauthSignIn);
  await disable();
  const claude = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  expect(claude.env.ANTHROPIC_BASE_URL).toBe("https://old-gateway.example");
  expect(claude.env.ANTHROPIC_CUSTOM).toBe("keep");
  expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(claude.env.CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined();
  expect(claude.other).toBe(true);
  const codex = readFileSync(codexConfigPath(), "utf8");
  expect(codex).toContain('model = "gpt-5"');
  expect(codex).not.toContain("model_providers.kimchi");
  expect(codex).toContain("[features]");
  expect(existsSync(codexCatalogPath())).toBe(false);
  expect(loadGatewayState().enabled).toBe(false);
});

test("a gateway enabled before the auto-mode setting gets it once, and disable removes it again", async () => {
  process.env.KIMCHI_BASE_URL = modelsEndpoint();
  oauthCredential();
  await enable(oauthSignIn);
  // As an older bridge left it: no auto-mode setting and no earlier value recorded for it.
  const settings = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  delete settings.env.CLAUDE_CODE_AUTO_MODE_SERVER;
  writeFileSync(claudeSettingsPath(), JSON.stringify(settings));
  const state = loadGatewayState();
  delete state.previous?.claude?.CLAUDE_CODE_AUTO_MODE_SERVER;
  saveGatewayState(state);
  ensureClaudeAutoMode();
  ensureClaudeAutoMode();
  expect(
    JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env.CLAUDE_CODE_AUTO_MODE_SERVER,
  ).toBe("0");
  await disable();
  const after = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  expect(after.env.CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined();
  expect(after.env.ANTHROPIC_BASE_URL).toBeUndefined();
});

test("the auto-mode setting is added only through the proxy, and a person's own value stays", () => {
  mkdirSync(join(root, "home", ".claude"), { recursive: true });
  writeFileSync(claudeSettingsPath(), JSON.stringify({ env: {} }));
  ensureClaudeAutoMode();
  expect(
    JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env.CLAUDE_CODE_AUTO_MODE_SERVER,
  ).toBeUndefined();
  saveGatewayState({ enabled: true, mode: "proxy", port: 8766 });
  writeFileSync(
    claudeSettingsPath(),
    JSON.stringify({ env: { CLAUDE_CODE_AUTO_MODE_SERVER: "1" } }),
  );
  ensureClaudeAutoMode();
  expect(
    JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env.CLAUDE_CODE_AUTO_MODE_SERVER,
  ).toBe("1");
});

test("an organization without Claude routes gets Claude Code the models it has, until disable", async () => {
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    { ...models[1], slug: "deepseek-v4-flash-0731", is_serverless: false },
  ]);
  oauthCredential();
  await enable(oauthSignIn);
  const env = () => JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env;
  expect(env().ANTHROPIC_MODEL).toBe("minimax-m3");
  expect(env().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash-0731");
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBe("deepseek-v4-flash-0731");
  await disable();
  expect(env().ANTHROPIC_MODEL).toBeUndefined();
  expect(env().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
});

test("Claude routes keep Claude Code's own models, and a person's model stays", async () => {
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    { ...models[1], slug: "claude-sonnet-5", is_serverless: false },
  ]);
  oauthCredential();
  await enable(oauthSignIn);
  const env = () => JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env;
  expect(env().ANTHROPIC_MODEL).toBeUndefined();
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
  await disable();

  process.env.KIMCHI_BASE_URL = modelsEndpoint();
  writeFileSync(claudeSettingsPath(), JSON.stringify({ env: { ANTHROPIC_MODEL: "glm-5.3" } }));
  await enable(oauthSignIn);
  expect(env().ANTHROPIC_MODEL).toBe("glm-5.3");
  await disable();
  expect(env().ANTHROPIC_MODEL).toBe("glm-5.3");
});

test("re-enable after the org gains Claude routes removes the bridge's model choice", async () => {
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    { ...models[1], slug: "deepseek-v4-flash-0731", is_serverless: false },
  ]);
  oauthCredential();
  await enable(oauthSignIn);
  const env = () => JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env;
  expect(env().ANTHROPIC_MODEL).toBe("minimax-m3");
  // The organization adds Claude routes; a second sign-in runs enable again.
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    { ...models[1], slug: "claude-sonnet-5", is_serverless: false },
  ]);
  await enable(oauthSignIn);
  expect(env().ANTHROPIC_MODEL).toBeUndefined();
  expect(env().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
  expect(env().ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8766/anthropic");
  expect(loadGatewayState().wrote?.claude).toEqual({});
  await disable();
  expect(env().ANTHROPIC_BASE_URL).toBeUndefined();
  expect(loadGatewayState().wrote).toBeUndefined();
});

test("re-enable after the model list changes updates the bridge's choice, not the person's", async () => {
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    { ...models[1], slug: "deepseek-v4-flash-0731", is_serverless: false },
  ]);
  oauthCredential();
  await enable(oauthSignIn);
  // The person makes the background model their own while the gateway runs.
  const settings = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "glm-4.7-flash";
  writeFileSync(claudeSettingsPath(), JSON.stringify(settings));
  // The main model and the small model both change.
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    models[1],
    { ...models[1], slug: "deepseek-v4.1-flash-1017", is_serverless: false },
  ]);
  await enable(oauthSignIn);
  const env = () => JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env;
  expect(env().ANTHROPIC_MODEL).toBe("kimi-k2.6");
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBe("deepseek-v4.1-flash-1017");
  expect(env().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-4.7-flash");
  expect(loadGatewayState().wrote?.claude).toEqual({
    ANTHROPIC_MODEL: "kimi-k2.6",
    CLAUDE_CODE_AUTO_MODE_MODEL: "deepseek-v4.1-flash-1017",
  });
});

test("the small model is one known to answer directly, never just any model that does not reason", async () => {
  // Like the gateway's embedding models: marked as not reasoning, and answering no chat request.
  const embedding = {
    ...models[1],
    slug: "bge-m3",
    reasoning: false,
    limits: { context_window: 8192, max_output_tokens: 0 },
  };
  const known = (slug: string) => ({ ...models[1], slug, is_serverless: false });
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    embedding,
    known("deepseek-v4.1-flash-1017"),
    known("deepseek-v4-flash-0731"),
  ]);
  oauthCredential();
  await enable(oauthSignIn);
  const env = () => JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env;
  // The bridge's order decides, not the list's.
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBe("deepseek-v4-flash-0731");
  // Kimchi's own small model leaves the list: the second known one takes over.
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    embedding,
    known("deepseek-v4.1-flash-1017"),
  ]);
  await enable(oauthSignIn);
  expect(env().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4.1-flash-1017");
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBe("deepseek-v4.1-flash-1017");
  // Neither is listed: no model goes on the background checks.
  process.env.KIMCHI_BASE_URL = modelsEndpoint([...models, embedding]);
  await enable(oauthSignIn);
  expect(env().ANTHROPIC_MODEL).toBe("minimax-m3");
  expect(env().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  expect(env().CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
});

const claudeEnv = () => JSON.parse(readFileSync(claudeSettingsPath(), "utf8")).env ?? {};
/**
 * Starts the daemon over CLI settings an older bridge wired to its proxy, with no model choice, and
 * waits until it writes a main model. `stopDaemon` stops it and drops its pid: it ran in this test's
 * process, which a separate daemon that exited would not leave for disable to signal.
 */
async function daemonOverOlderWiring(previous?: GatewayState["previous"]) {
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    { ...models[1], slug: "deepseek-v4-flash-0731", is_serverless: false },
  ]);
  oauthCredential();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  const port = probe.port;
  probe.stop(true);
  process.env.KIMCHI_GATEWAY_PORT = String(port);
  process.env.KIMCHI_BRIDGE_DISABLE_POLL_MS = "20";
  cleanups.push(() => {
    process.env.KIMCHI_GATEWAY_PORT = "";
    delete process.env.KIMCHI_BRIDGE_DISABLE_POLL_MS;
  });
  saveGatewayState({ enabled: true, mode: "proxy", port, ...(previous ? { previous } : {}) });
  mkdirSync(join(root, "home", ".claude"), { recursive: true });
  writeFileSync(
    claudeSettingsPath(),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "kimchi-gateway",
        CLAUDE_CODE_AUTO_MODE_SERVER: "0",
      },
    }),
  );
  const run = runDaemon();
  for (let i = 0; i < 500 && claudeEnv().ANTHROPIC_MODEL === undefined; i++) await Bun.sleep(10);
  const stopDaemon = async () => {
    saveGatewayState({ ...loadGatewayState(), enabled: false });
    await run;
    saveGatewayState({ ...loadGatewayState(), pid: undefined });
  };
  return { stopDaemon };
}
// The snapshot an rc.19 or older bridge's enable took, plus the auto-mode key a later upgrade added:
// it has no model keys, so disable restores none of them.
const rc19Snapshot = {
  ANTHROPIC_BASE_URL: null,
  ANTHROPIC_API_KEY: null,
  ANTHROPIC_AUTH_TOKEN: null,
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: null,
  CLAUDE_CODE_AUTO_MODE_SERVER: null,
};

test("an existing proxy user gets the models when the daemon starts", async () => {
  // As an older bridge left the gateway: wired to a proxy, but with no model choice and no record of one.
  const { stopDaemon } = await daemonOverOlderWiring();
  expect(claudeEnv().ANTHROPIC_MODEL).toBe("minimax-m3");
  expect(claudeEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash-0731");
  expect(claudeEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBe("deepseek-v4-flash-0731");
  expect(loadGatewayState().wrote?.claude).toEqual({
    ANTHROPIC_MODEL: "minimax-m3",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash-0731",
    CLAUDE_CODE_AUTO_MODE_MODEL: "deepseek-v4-flash-0731",
  });
  await stopDaemon();
});

test("disable removes the models the daemon gave a gateway an rc.19 bridge enabled", async () => {
  const { stopDaemon } = await daemonOverOlderWiring({ claude: rc19Snapshot });
  expect(claudeEnv().ANTHROPIC_MODEL).toBe("minimax-m3");
  await stopDaemon();
  await disable();
  // Claude Code is back on the person's own provider: no Kimchi model may be left behind.
  expect(claudeEnv()).toEqual({});
});

test("re-enable removes the models an rc.21 bridge wrote once the org gains Claude routes", async () => {
  oauthCredential();
  // rc.21 snapshotted the model keys as absent, wrote them, and kept no record of writing them.
  saveGatewayState({
    enabled: true,
    mode: "proxy",
    port: 8766,
    previous: {
      claude: {
        ...rc19Snapshot,
        CLAUDE_CODE_AUTO_MODE_MODEL: null,
        ANTHROPIC_MODEL: null,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: null,
      },
    },
  });
  mkdirSync(join(root, "home", ".claude"), { recursive: true });
  writeFileSync(
    claudeSettingsPath(),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8766/anthropic",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "kimchi-gateway",
        CLAUDE_CODE_AUTO_MODE_SERVER: "0",
        ANTHROPIC_MODEL: "minimax-m3",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash-0731",
        CLAUDE_CODE_AUTO_MODE_MODEL: "deepseek-v4-flash-0731",
      },
    }),
  );
  process.env.KIMCHI_BASE_URL = modelsEndpoint([
    ...models,
    { ...models[1], slug: "claude-sonnet-5", is_serverless: false },
  ]);
  await enable(oauthSignIn);
  expect(claudeEnv().ANTHROPIC_MODEL).toBeUndefined();
  expect(claudeEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  expect(claudeEnv().CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
  expect(claudeEnv().ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8766/anthropic");
});

test("the launchd service waits while another daemon holds the port instead of exiting into a restart", async () => {
  process.env.KIMCHI_BASE_URL = modelsEndpoint();
  oauthCredential();
  const fake = server((request) =>
    new URL(request.url).pathname === "/healthz"
      ? Response.json({ ok: true, service: "kimchi-bridge-gateway", pid: 42 })
      : new Response("no", { status: 404 }),
  );
  saveGatewayState({ enabled: true, mode: "proxy", port: Number(new URL(fake).port) });
  // A daemon started any other way, such as from a hook, leaves at once.
  await runDaemon();
  process.env.XPC_SERVICE_NAME = "dev.kimchi.bridge.gateway";
  process.env.KIMCHI_BRIDGE_SERVICE_WAIT_MS = "20";
  cleanups.push(() => {
    delete process.env.XPC_SERVICE_NAME;
    delete process.env.KIMCHI_BRIDGE_SERVICE_WAIT_MS;
  });
  let settled = false;
  const run = runDaemon().then(() => {
    settled = true;
  });
  await Bun.sleep(200);
  expect(settled).toBe(false);
  saveGatewayState({ ...loadGatewayState(), enabled: false });
  await run;
  expect(settled).toBe(true);
});

test("proxyRequest injects the fresh bearer and org header, passes the body, and retries once on 401", async () => {
  // A local token endpoint so the forced rotation after 401 stays hermetic.
  let refreshes = 0;
  const tokenEndpoint = server(async (request) => {
    const body = new URLSearchParams(await request.text());
    if (body.get("grant_type") === "refresh_token") {
      refreshes++;
      return Response.json({
        access_token: "access-2",
        id_token: "id-token-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    }
    return Response.json({ error: "unsupported" }, { status: 400 });
  });
  saveCredential({
    region: "us",
    tokenUrl: `${tokenEndpoint}/oauth/token`,
    clientId: "c",
    useIdToken: true,
    accessToken: "access",
    idToken: "id-token",
    refreshToken: "refresh",
    expires: Date.now() + 3600_000,
    orgId: org,
    orgName: "Org",
  });
  let hits = 0;
  const upstream = server(async (request) => {
    hits++;
    const auth = request.headers.get("authorization") ?? "";
    const orgHeader = request.headers.get("x-castai-organization-id");
    const body = await request.text();
    if (hits === 1)
      return new Response("expired", { status: 401, headers: { "content-type": "text/plain" } });
    return Response.json({
      auth,
      orgHeader,
      bodyBytes: body.length,
      type: request.headers.get("content-type"),
    });
  });
  const request = new Request("http://127.0.0.1:8766/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer placeholder",
      "x-api-key": "client",
    },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  const response = await proxyRequest(request, upstream);
  expect(response.status).toBe(200);
  const seen = await response.json();
  expect(hits).toBe(2);
  expect(refreshes).toBe(1);
  expect(seen.auth).toBe("Bearer id-token-2");
  expect(seen.orgHeader).toBe(org);
  expect(seen.bodyBytes).toBeGreaterThan(10);
  expect(seen.type).toBe("application/json");
});

test("proxyRequest streams the upstream body through untouched", async () => {
  oauthCredential();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of ["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"]) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  const upstream = server(
    () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  );
  const request = new Request("http://127.0.0.1:8766/anthropic/v1/messages", {
    method: "POST",
    body: "{}",
  });
  const response = await proxyRequest(request, upstream);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toBe("data: one\n\ndata: two\n\ndata: [DONE]\n\n");
});

test("proxyRequest strips server-side web_search tools that break the gateway streaming path", async () => {
  oauthCredential();
  let seenTypes: (string | undefined)[] | undefined;
  const upstream = server(async (request) => {
    const parsed = JSON.parse(await request.text()) as { tools?: { type?: string }[] };
    seenTypes = parsed.tools?.map((tool) => tool.type);
    return Response.json({ ok: true });
  });
  const request = new Request("http://127.0.0.1:8766/openai/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "minimax-m3",
      stream: true,
      input: "Reply with exactly: OK",
      tools: [
        { type: "function", name: "exec_command" },
        { type: "web_search", external_web_access: false },
        { type: "web_search_preview" },
      ],
    }),
  });
  const response = await proxyRequest(request, upstream);
  expect(response.status).toBe(200);
  expect(seenTypes).toEqual(["function"]);
});

test("proxyRequest forwards bodies without unsupported tools byte-identical, including non-JSON", async () => {
  oauthCredential();
  let raw = "";
  const upstream = server(async (request) => {
    raw = await request.text();
    return Response.json({ ok: true });
  });
  const body = JSON.stringify({
    model: "minimax-m3",
    stream: true,
    input: "hi",
    tools: [{ type: "function", name: "exec_command" }],
  });
  await proxyRequest(
    new Request("http://127.0.0.1:8766/openai/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    upstream,
  );
  expect(raw).toBe(body);
  await proxyRequest(
    new Request("http://127.0.0.1:8766/openai/v1/responses", { method: "POST", body: "not json" }),
    upstream,
  );
  expect(raw).toBe("not json");
});

test("gateway state persists, port resolution honors the environment, and health checks the marker", async () => {
  saveGatewayState({ enabled: true, mode: "proxy", port: 9123 });
  expect(loadGatewayState().port).toBe(9123);
  expect(gatewayPort()).toBe(9123);
  process.env.KIMCHI_GATEWAY_PORT = "9455";
  expect(gatewayPort()).toBe(9455);
  process.env.KIMCHI_GATEWAY_PORT = "";
  expect(gatewayPort()).toBe(9123);
  saveGatewayState({ enabled: true, mode: "proxy", port: 0 });
  expect(gatewayPort()).toBe(8766);
  const fake = server((request) => {
    if (new URL(request.url).pathname === "/healthz")
      return Response.json({ ok: true, service: "kimchi-bridge-gateway", pid: 42 });
    return new Response("no", { status: 404 });
  });
  const port = Number(new URL(fake).port);
  expect(await health(port)).toMatchObject({
    ok: true,
    service: "kimchi-bridge-gateway",
    pid: 42,
  });
  expect((await health(port + 1)).ok).toBe(false);
  expect(existsSync(gatewayStatePath())).toBe(true);
});

test("plugin surfaces ship the sign-in command and skill", () => {
  const repo = join(import.meta.dir, "..");
  expect(
    existsSync(join(repo, "plugins", "kimchi-work", "claude", "commands", "kimchi-login.md")),
  ).toBe(true);
  expect(
    existsSync(join(repo, "plugins", "kimchi-work", "codex", "skills", "kimchi-login", "SKILL.md")),
  ).toBe(true);
  const manifest = JSON.parse(
    readFileSync(
      join(repo, "plugins", "kimchi-work", "codex", ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  expect(manifest.skills).toBe("./skills/");
});

test("Status reports the gateway state", async () => {
  // Port 1 is never listening in practice, so the health probe stays false
  // even when a real gateway daemon runs on the default 8766 locally.
  saveGatewayState({ enabled: true, mode: "proxy", port: 1, region: "us", organizationId: org });
  const state = await status();
  expect(state).toMatchObject({ enabled: true, mode: "proxy", port: 1, running: false });
});

async function recorded(responseId: string): Promise<string | undefined> {
  for (let i = 0; i < 100 && !tagFor(responseId); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return tagFor(responseId);
}

test("proxyRequest tags each model request as Kimchi does and records the tag for its response", async () => {
  oauthCredential();
  const seen: (string | null)[] = [];
  const upstream = server(async (request) => {
    seen.push(request.headers.get("x-tags"));
    await request.text();
    return new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_tagged"}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const response = await proxyRequest(
    new Request("http://127.0.0.1:8766/anthropic/v1/messages?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tags": "team:web" },
      body: JSON.stringify({ model: "m", messages: [] }),
    }),
    upstream,
  );
  expect(await response.text()).toContain("msg_tagged");
  const tags = seen[0] ?? "";
  expect(tags.startsWith("team:web,kimchi-request:")).toBe(true);
  expect(await recorded("msg_tagged")).toBe(tags.slice("team:web,kimchi-request:".length));
  // Token counts are not billed model requests.
  await proxyRequest(
    new Request("http://127.0.0.1:8766/anthropic/v1/messages/count_tokens", {
      method: "POST",
      body: "{}",
    }),
    upstream,
  );
  expect(seen[1]).toBeNull();
});

test("the proxy forwards an API-key sign-in with its key and tags its requests", async () => {
  kimchiKey("castai_v1_key");
  let auth = "";
  let tags: string | null = null;
  const upstream = server(async (request) => {
    auth = request.headers.get("authorization") ?? "";
    tags = request.headers.get("x-tags");
    await request.text();
    return Response.json({ id: "resp_key", object: "response" });
  });
  const response = await proxyRequest(
    new Request("http://127.0.0.1:8766/openai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer kimchi-gateway" },
      body: JSON.stringify({ model: "m", input: "hi" }),
    }),
    upstream,
  );
  expect(await response.json()).toEqual({ id: "resp_key", object: "response" });
  expect(auth).toBe("Bearer castai_v1_key");
  expect(String(tags).startsWith("kimchi-request:")).toBe(true);
  expect(await recorded("resp_key")).toBe(String(tags).slice("kimchi-request:".length));
  // Claude Code reports the call under this ID, which is how a call no transcript records finds its bill.
  expect(response.headers.get("request-id")).toBe(String(tags).slice("kimchi-request:".length));
});

test("a retried request carries a fresh billing tag, as in Kimchi", async () => {
  const tokenEndpoint = server(async () =>
    Response.json({ access_token: "access-2", id_token: "id-token-2", expires_in: 3600 }),
  );
  saveCredential({
    region: "us",
    tokenUrl: `${tokenEndpoint}/oauth/token`,
    clientId: "c",
    useIdToken: true,
    accessToken: "access",
    idToken: "id-token",
    refreshToken: "refresh",
    expires: Date.now() + 3600_000,
    orgId: org,
    orgName: "Org",
  });
  const seen: (string | null)[] = [];
  const upstream = server(async (request) => {
    seen.push(request.headers.get("x-tags"));
    await request.text();
    if (seen.length === 1) return new Response("expired", { status: 401 });
    return Response.json({ id: "msg_retry" });
  });
  await proxyRequest(
    new Request("http://127.0.0.1:8766/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    }),
    upstream,
  );
  expect(seen).toHaveLength(2);
  expect(seen[0]).not.toBe(seen[1]);
  expect(await recorded("msg_retry")).toBe(String(seen[1]).slice("kimchi-request:".length));
});
