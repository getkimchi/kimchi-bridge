// Local loopback reverse proxy for the Kimchi LLM gateway, plus the Claude
// Code and Codex config writers that point the CLIs at it. OAuth sign-ins
// route through the proxy so the bearer stays fresh and the SSO organization
// header rides on every request; API-key sign-ins are written direct to the
// gateway with the embedded key, mirroring Kimchi's own integrations
// (CAST AI, Apache-2.0: src/integrations/claude-code.ts, codex.ts).
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Config } from "./settings.ts";
import { stateRoot } from "./settings.ts";
import type { SignIn } from "./kimchi.ts";
import { baseUrl } from "./kimchi.ts";
import { cliEntry, lockSync } from "./platform.ts";
import {
  endpointsForCredential,
  ensureFresh,
  gatewayHeaders,
  isInvalidGrant,
  loadCredential,
  refreshOAuth,
  saveCredential,
  seedFromKimchi,
} from "./oauth.ts";

const DEFAULT_PORT = 8766;
const PORT_SCAN_SPAN = 10;
const HEALTH_PATH = "/healthz";
const HEALTH_MARKER = "kimchi-bridge-gateway";
const KIMCHI_PROVIDER = "kimchi";
const CODEX_PROVIDER_NAME = "Kimchi Gateway";
/** Placeholder bearer for proxy mode; the proxy replaces it per request. */
const PROXY_PLACEHOLDER = "kimchi-gateway";

export type GatewayMode = "proxy" | "direct";

export interface GatewayState {
  enabled?: boolean;
  mode?: GatewayMode;
  port?: number;
  pid?: number;
  region?: string;
  organizationId?: string;
  /** Pre-existing CLI values `enable` overwrote, so `disable` can restore them. */
  previous?: {
    claude?: Record<string, string | null>;
    codexTopLevel?: Array<[string, string]>;
  };
}

// ---------------------------------------------------------------------------
// Paths and state
// ---------------------------------------------------------------------------

export function gatewayStatePath(root = stateRoot()): string {
  return join(root, "gateway.json");
}
export function gatewayLogPath(root = stateRoot()): string {
  return join(root, "gateway.log");
}
export function claudeSettingsPath(): string {
  return join(homeDir(), ".claude", "settings.json");
}
export function codexConfigPath(): string {
  return join(homeDir(), ".codex", "config.toml");
}
export function codexCatalogPath(): string {
  return join(homeDir(), ".codex", "model_catalog.json");
}
/**
 * The home the CLI configs live under. KIMCHI_BRIDGE_CONFIG_HOME isolates test
 * runs: Bun's os.homedir() does not react to a mid-process $HOME swap, so HOME
 * alone cannot keep in-process tests away from real user configs.
 */
function homeDir(): string {
  return process.env.KIMCHI_BRIDGE_CONFIG_HOME ?? homedir();
}

export function loadGatewayState(path = gatewayStatePath()): GatewayState {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 16 << 10) throw new Error("gateway state too large");
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid gateway state");
    return value as GatewayState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("gateway state is unreadable");
  }
}

function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function saveGatewayState(state: GatewayState, path = gatewayStatePath()): void {
  writeAtomic(path, JSON.stringify(state, null, 2) + "\n", 0o600);
}

export function gatewayPort(state: GatewayState = loadGatewayState()): number {
  const env = Number.parseInt(process.env.KIMCHI_GATEWAY_PORT ?? "", 10);
  if (Number.isFinite(env) && env > 0 && env < 65536) return env;
  if (typeof state.port === "number" && state.port > 0 && state.port < 65536) return state.port;
  return DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// Claude Code settings (~/.claude/settings.json env block)
// ---------------------------------------------------------------------------

const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
] as const;

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path} could not be parsed; fix or remove it first`);
  }
}

function writeJsonFile(path: string, value: Record<string, unknown>): void {
  writeAtomic(path, JSON.stringify(value, null, 2) + "\n", 0o644);
}

function writeClaudeConfig(
  anthropicBaseUrl: string,
  authToken: string,
): Record<string, string | null> {
  const path = claudeSettingsPath();
  const settings = readJsonFile(path);
  const env =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};
  const previous: Record<string, string | null> = {};
  for (const key of CLAUDE_ENV_KEYS)
    previous[key] = typeof env[key] === "string" ? (env[key] as string) : null;
  // Empty ANTHROPIC_API_KEY keeps Claude Code on ANTHROPIC_AUTH_TOKEN.
  const pairs: Record<string, string> = {
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: authToken,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
  for (const [key, value] of Object.entries(pairs)) env[key] = value;
  settings.env = env;
  writeJsonFile(path, settings);
  return previous;
}

function restoreClaudeConfig(previous?: Record<string, string | null>): void {
  if (!previous) return;
  const path = claudeSettingsPath();
  const settings = readJsonFile(path);
  const env =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(previous)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  settings.env = env;
  writeJsonFile(path, settings);
}

// ---------------------------------------------------------------------------
// Codex config (~/.codex/config.toml + model catalog)
// ---------------------------------------------------------------------------

function tomlEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

const CODEX_TOP_LEVEL_KEYS = ["model_provider", "model", "model_catalog_json"];

function classifyTomlLine(line: string): "kimchi-header" | "header" | "array-header" | "body" {
  const trimmed = line.trim();
  if (trimmed.startsWith("[[")) return "array-header";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const section = trimmed.slice(1, -1).trim();
    // The whole kimchi namespace is ours: [model_providers.kimchi] and any
    // table nested under it re-defines the provider we replace.
    if (
      section === `model_providers.${KIMCHI_PROVIDER}` ||
      section.startsWith(`model_providers.${KIMCHI_PROVIDER}.`)
    )
      return "kimchi-header";
    return "header";
  }
  return "body";
}

export function buildCodexToml(
  baseUrlValue: string,
  bearer: string,
  modelSlug: string,
  catalogPath: string,
): string {
  return `model_provider = "${KIMCHI_PROVIDER}"
model = "${tomlEscape(modelSlug)}"
model_catalog_json = "${tomlEscape(catalogPath)}"

[model_providers.${KIMCHI_PROVIDER}]
name = "${CODEX_PROVIDER_NAME}"
base_url = "${tomlEscape(baseUrlValue)}"
http_headers = { Authorization = "Bearer ${tomlEscape(bearer)}" }
wire_api = "responses"
`;
}

/** Strip the kimchi top-level keys and provider section, keeping user sections. */
export function stripCodexToml(existingText: string): string {
  const kept: string[] = [];
  let inKimchiSection = false;
  let inAnySection = false;
  for (const line of existingText.split("\n")) {
    const kind = classifyTomlLine(line);
    if (kind === "kimchi-header") {
      inKimchiSection = true;
      inAnySection = true;
      continue;
    }
    if (kind === "header" || kind === "array-header") {
      inKimchiSection = false;
      inAnySection = true;
      kept.push(line);
      continue;
    }
    if (inKimchiSection) continue;
    if (!inAnySection) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
        if (CODEX_TOP_LEVEL_KEYS.includes(key)) continue;
      }
    }
    kept.push(line);
  }
  let collapsed = "";
  for (const line of kept) {
    if (!line && (collapsed === "" || collapsed.endsWith("\n\n"))) continue;
    collapsed += line + "\n";
  }
  return collapsed.trim();
}

/** Merge fresh kimchi TOML over a stripped existing config (user sections last). */
export function mergeCodexToml(existingText: string, freshToml: string): string {
  const collapsed = stripCodexToml(existingText).trim();
  if (!collapsed) return freshToml;
  return `${freshToml}\n${collapsed}\n`;
}

export interface GatewayModel {
  slug: string;
  display_name: string;
  reasoning?: boolean;
  input_modalities?: string[];
  is_serverless?: boolean;
  limits: { context_window: number; max_output_tokens: number };
}

/** Kimchi's "main" role resolution (src/integrations/models.ts), ported. */
export function resolveMainModel(models: readonly GatewayModel[]): GatewayModel {
  const serverless = models.filter((m) => m.is_serverless);
  const preferred = serverless.find((m) => m.slug === "minimax-m3");
  if (preferred) return preferred;
  const vision = serverless.find((m) => (m.input_modalities ?? []).includes("image"));
  return vision ?? serverless[0] ?? models[0];
}

export async function fetchModels(
  llmBaseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<GatewayModel[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(llmBaseUrl)}/v1/models/metadata?include_in_cli=true`, {
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`fetching the gateway model list failed: ${(error as Error).message}`);
  }
  if (!response.ok)
    throw new Error(`fetching the gateway model list failed (HTTP ${response.status})`);
  const body = (await response.json().catch(() => null)) as { models?: GatewayModel[] } | null;
  if (!body || !Array.isArray(body.models) || !body.models.length)
    throw new Error("the gateway model list is empty or malformed");
  return body.models.filter(
    (m) => typeof m?.slug === "string" && typeof m?.limits?.context_window === "number",
  );
}

interface CodexModelEntry {
  slug: string;
  display_name: string;
  name: string;
  model: string;
  provider: string;
  context_window: number;
  truncation_policy: { mode: "tokens"; limit: number };
  shell_type: "shell_command";
  visibility: "list";
  supported_in_api: boolean;
  priority: number;
  base_instructions: string;
  supports_tools: boolean;
  supports_parallel_tool_calls: boolean;
  experimental_supported_tools: string[];
  supports_reasoning_summaries: boolean;
  support_verbosity: boolean;
  supported_reasoning_levels: Array<{ effort: "low" | "medium" | "high"; description: string }>;
}

export function buildCodexCatalog(models: readonly GatewayModel[]): { models: CodexModelEntry[] } {
  const REASONING_LEVELS = [
    { effort: "low", description: "Low reasoning effort" },
    { effort: "medium", description: "Medium reasoning effort" },
    { effort: "high", description: "High reasoning effort" },
  ] as const;
  return {
    models: models.map((m, index) => ({
      slug: m.slug,
      // The gateway's model registry currently serves empty display_name;
      // codex's /model picker renders display_name, so fall back to the slug
      // rather than showing blank rows (backend data-quality ticket open).
      display_name: m.display_name || m.slug,
      name: m.slug,
      model: m.slug,
      provider: KIMCHI_PROVIDER,
      context_window: m.limits.context_window,
      truncation_policy: { mode: "tokens" as const, limit: m.limits.context_window },
      shell_type: "shell_command" as const,
      visibility: "list" as const,
      supported_in_api: true,
      priority: (index + 1) * 10,
      base_instructions: "You are a helpful coding assistant.",
      supports_tools: true,
      supports_parallel_tool_calls: true,
      experimental_supported_tools: [],
      supports_reasoning_summaries: m.reasoning === true,
      support_verbosity: m.reasoning === true,
      supported_reasoning_levels: m.reasoning === true ? [...REASONING_LEVELS] : [],
    })),
  };
}

function writeCodexConfig(
  base: string,
  bearer: string,
  models: readonly GatewayModel[],
): Array<[string, string]> | undefined {
  const path = codexConfigPath();
  let existingText = "";
  try {
    existingText = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Snapshot the user's top-level values our enable replaces.
  const previous: Array<[string, string]> = [];
  let inAnySection = false;
  for (const line of existingText.split("\n")) {
    const kind = classifyTomlLine(line);
    if (kind !== "body") {
      inAnySection = true;
      continue;
    }
    if (!inAnySection) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const split = trimmed.indexOf("=");
        const key = trimmed.slice(0, split).trim();
        const value = trimmed.slice(split + 1).trim();
        if (CODEX_TOP_LEVEL_KEYS.includes(key) && value) previous.push([key, value]);
      }
    }
  }
  const main = resolveMainModel(models);
  const catalogPath = codexCatalogPath();
  const fresh = buildCodexToml(base, bearer, main.slug, catalogPath);
  writeAtomic(path, mergeCodexToml(existingText, fresh), 0o644);
  writeAtomic(catalogPath, JSON.stringify(buildCodexCatalog(models), null, 2) + "\n", 0o644);
  return previous.length ? previous : undefined;
}

function restoreCodexConfig(previous?: Array<[string, string]>): void {
  const path = codexConfigPath();
  let existingText = "";
  try {
    existingText = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existingText) return;
  const stripped = stripCodexToml(existingText);
  const restored = previous?.length
    ? `${previous.map(([k, v]) => `${k} = ${v}`).join("\n")}\n${stripped ? `\n${stripped}\n` : ""}`
    : `${stripped}\n`;
  writeAtomic(path, restored, 0o644);
  try {
    rmSync(codexCatalogPath(), { force: true });
  } catch {
    /* the catalog is ours to drop; ignore failures */
  }
}

// ---------------------------------------------------------------------------
// OS-level persistence (best effort)
// ---------------------------------------------------------------------------

const SERVICE_LABEL = "dev.kimchi.bridge.gateway";

function serviceEnvOff(): boolean {
  const value = (process.env.KIMCHI_BRIDGE_SERVICE ?? "").trim().toLowerCase();
  return value === "0" || value === "false" || value === "no" || value === "off";
}

function launchAgentPath(): string {
  return join(homeDir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}
function systemdUnitPath(): string {
  return join(homeDir(), ".config", "systemd", "user", "kimchi-bridge-gateway.service");
}

function installService(entry: string[]): "launchd" | "systemd" | null {
  if (serviceEnvOff()) return null;
  if (process.platform === "darwin") {
    try {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${entry.map((part) => `    <string>${part}</string>`).join("\n")}
    <string>gateway</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${gatewayLogPath()}</string>
  <key>StandardErrorPath</key><string>${gatewayLogPath()}</string>
</dict>
</plist>
`;
      const path = launchAgentPath();
      writeAtomic(path, plist, 0o644);
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { stdio: "ignore" });
      if (result.status !== 0) {
        // An already-bootstrapped label answers with a bootstrap failure;
        // kickstart covers the reload case.
        spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`], {
          stdio: "ignore",
        });
      }
      return "launchd";
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    try {
      const unit = `[Unit]
Description=Kimchi bridge LLM gateway proxy

[Service]
ExecStart=${entry.join(" ")} gateway run
Restart=always

[Install]
WantedBy=default.target
`;
      const path = systemdUnitPath();
      writeAtomic(path, unit, 0o644);
      const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      if (reload.error) return null;
      spawnSync("systemctl", ["--user", "enable", "--now", "kimchi-bridge-gateway"], {
        stdio: "ignore",
      });
      return "systemd";
    } catch {
      return null;
    }
  }
  return null;
}

function removeService(): void {
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`], { stdio: "ignore" });
    try {
      rmSync(launchAgentPath(), { force: true });
    } catch {
      /* best effort */
    }
  } else if (process.platform === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "kimchi-bridge-gateway"], {
      stdio: "ignore",
    });
    try {
      rmSync(systemdUnitPath(), { force: true });
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Health, daemon lifecycle
// ---------------------------------------------------------------------------

export interface HealthInfo {
  ok: boolean;
  service?: string;
  pid?: number;
  port: number;
}

export async function health(port: number, timeoutMs = 250): Promise<HealthInfo> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, port };
    const body = (await response.json().catch(() => null)) as {
      service?: string;
      pid?: number;
    } | null;
    if (body?.service !== HEALTH_MARKER) return { ok: false, port };
    return { ok: true, service: body.service, pid: body.pid, port };
  } catch {
    return { ok: false, port };
  }
}

function log(line: string): void {
  try {
    const path = gatewayLogPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* the log must never break the daemon */
  }
}

function spawnDaemon(): void {
  const child = Bun.spawn([...cliEntry(), "gateway", "run"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
}

/**
 * The hook path: spawn detached when enabled and return immediately — bounded
 * well under a hook timeout, never blocking the session. Best effort only; a
 * duplicate exits on its own when the port already carries our daemon, and
 * the next tick (or the waiting ensure) completes the bring-up.
 */
export function ensureQuick(): "spawned" | "off" {
  const state = loadGatewayState();
  if (state.enabled !== true || state.mode === "direct") return "off";
  if (!loadCredential()) return "off";
  try {
    spawnDaemon();
  } catch {
    /* the next tick retries */
  }
  return "spawned";
}

/**
 * Health probe + lockfile-guarded respawn; never blocks a session on network
 * I/O beyond the bounded startup wait.
 */
export async function ensure(): Promise<
  "running" | "started" | "disabled" | "direct" | "unauthenticated"
> {
  const state = loadGatewayState();
  if (!state.enabled) return "disabled";
  if (state.mode === "direct") return "direct";
  if (!loadCredential()) return "unauthenticated";
  const port = gatewayPort(state);
  if ((await health(port)).ok) return "running";
  const guard = lockSync(join(dirname(gatewayStatePath()), "gateway-spawn.lock"));
  if (!guard) {
    // Another caller is spawning the daemon; wait for it to come up.
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if ((await health(port)).ok) return "running";
    }
    return "started";
  }
  try {
    if ((await health(port)).ok) return "running";
    spawnDaemon();
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if ((await health(port)).ok) return "started";
    }
    throw new Error("the gateway proxy did not come up; check gateway.log");
  } finally {
    guard.close();
  }
}

export function stop(): boolean {
  const state = loadGatewayState();
  removeService();
  const pid = state.pid;
  let stopped = false;
  if (typeof pid === "number" && pid > 1) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {
      /* already gone */
    }
  }
  delete state.pid;
  saveGatewayState(state);
  return stopped;
}

// ---------------------------------------------------------------------------
// The proxy daemon
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function forwardHeaders(incoming: Headers, auth: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "authorization" || lower === "x-api-key") continue;
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(auth)) headers.set(key, value);
  return headers;
}

export async function proxyRequest(request: Request, llmBase: string): Promise<Response> {
  const url = new URL(request.url);
  const upstream = `${baseUrl(llmBase)}${url.pathname}${url.search}`;
  // Buffer the body so a 401 retry can re-send it; LLM request bodies are
  // finite JSON, and one in-flight buffer per request is bounded.
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const forward = async (): Promise<Response> =>
    await fetch(upstream, {
      method: request.method,
      headers: forwardHeaders(request.headers, gatewayHeaders(await ensureFresh())),
      body: body === undefined ? undefined : Buffer.from(body),
      redirect: "manual",
    });
  let response = await forward();
  if (response.status === 401) {
    // The bearer was rejected despite being fresh: force one rotation, then retry once.
    try {
      saveCredential(await refreshOAuth(await ensureFresh()));
      log(`token rotated after 401 on ${url.pathname}`);
    } catch (error) {
      if (isInvalidGrant(error))
        return new Response("Kimchi sign-in required; run kimchi-bridge login\n", {
          status: 401,
          headers: { "content-type": "text/plain" },
        });
      log(`401 refresh failed: ${(error as Error).message}`);
    }
    await response.body?.cancel().catch(() => {});
    response = await forward();
  }
  const headers = new Headers();
  for (const [key, value] of response.headers) {
    const lower = key.toLowerCase();
    // Bun's fetch decompresses the upstream body; drop the stale encoding
    // descriptor so the client receives a consistent identity stream.
    if (HOP_BY_HOP.has(lower) || lower === "content-encoding") continue;
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export async function runDaemon(): Promise<void> {
  const credential = loadCredential();
  if (!credential) throw new Error("no saved sign-in; run kimchi-bridge login");
  const state = loadGatewayState();
  const preferred = gatewayPort(state);
  let port = preferred;
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let offset = 0; offset <= PORT_SCAN_SPAN; offset++) {
    const candidate = preferred + offset;
    if ((await health(candidate)).ok) {
      // Our daemon is already listening; nothing to do.
      log(`daemon already running on ${candidate}`);
      return;
    }
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: candidate,
        // Long agentic turns pause between SSE events; Bun's default idle
        // timeout (~10s) would cut those streams mid-response.
        idleTimeout: 255,
        fetch: async (request: Request): Promise<Response> => {
          const url = new URL(request.url);
          if (url.pathname === HEALTH_PATH) {
            const current = loadCredential();
            return Response.json({
              ok: true,
              service: HEALTH_MARKER,
              pid: process.pid,
              port: server?.port ?? candidate,
              region: current?.region,
              organizationId: current?.orgId,
            });
          }
          const started = Date.now();
          try {
            if (!loadCredential())
              return new Response("Kimchi sign-in required; run kimchi-bridge login\n", {
                status: 401,
                headers: { "content-type": "text/plain" },
              });
            const response = await proxyRequest(request, endpoints.llmBaseUrl);
            log(
              `${request.method} ${url.pathname} -> ${response.status} (${Date.now() - started}ms)`,
            );
            return response;
          } catch (error) {
            const message = error instanceof Error ? error.message : "proxy failure";
            log(`${request.method} ${url.pathname} failed: ${message}`);
            return new Response(`gateway proxy error: ${message}\n`, {
              status: 502,
              headers: { "content-type": "text/plain" },
            });
          }
        },
      });
      port = candidate;
      break;
    } catch {
      // The preferred port lost the race to another of our daemons: exit
      // quietly instead of scanning onto preferred+1 and lingering as a
      // second proxy (IS-2 duplicates). Anything else (foreign listener)
      // keeps the designed port-scan behaviour.
      if (candidate === preferred && (await health(preferred)).ok) {
        log(`duplicate daemon: port ${preferred} is already served; exiting`);
        return;
      }
      continue;
    }
  }
  if (!server)
    throw new Error(
      `no free port in ${preferred}..${preferred + PORT_SCAN_SPAN} for the gateway proxy`,
    );
  const endpoints = endpointsForCredential(credential);
  saveGatewayState({
    ...state,
    enabled: true,
    mode: "proxy",
    port,
    pid: process.pid,
    region: credential.region,
    organizationId: credential.orgId,
  });
  if (port !== preferred) {
    // The persisted port moved; repoint the CLI configs so new sessions follow.
    try {
      writeClaudeConfig(`http://127.0.0.1:${port}/anthropic`, PROXY_PLACEHOLDER);
      log(`port moved to ${port}; CLI configs rewritten`);
    } catch (error) {
      log(`port moved to ${port} but CLI config rewrite failed: ${(error as Error).message}`);
    }
  }
  log(`gateway proxy listening on 127.0.0.1:${port} -> ${endpoints.llmBaseUrl}`);
  // Poll for disable while running; SIGTERM also exits (default handler).
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    try {
      if (loadGatewayState().enabled === false) {
        log("disabled; shutting down");
        server.stop(true);
        return;
      }
    } catch {
      /* state read failures keep the daemon alive */
    }
  }
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

export interface EnableResult {
  mode: GatewayMode;
  port?: number;
  daemon: "running" | "started" | "off";
  service: "launchd" | "systemd" | null;
}

/**
 * Route the CLIs through the Kimchi gateway in the mode matching the sign-in:
 * OAuth credentials through the local proxy (adopting Kimchi's own saved
 * login into the shared credential store when only that exists), API keys
 * direct with the embedded key.
 */
export async function enable(
  signIn: SignIn,
  onMessage?: (message: string) => void,
  kimchiCredentialPath?: string | null,
): Promise<EnableResult> {
  // A stored credential exists (or can be adopted from Kimchi's) for OAuth
  // sign-ins; both carry an organization for the routing header.
  if (!loadCredential() && kimchiCredentialPath !== null) {
    const adopted = seedFromKimchi(kimchiCredentialPath);
    if (adopted && adopted.orgId) saveCredential(adopted);
  }
  const credential = loadCredential();
  const proxyMode = credential !== undefined;
  const previousState = loadGatewayState();

  let anthropicBaseUrl: string;
  let codexBaseUrl: string;
  let bearer: string;
  let modelHeaders: Record<string, string>;
  let llmBase: string;
  if (proxyMode) {
    const endpoints = endpointsForCredential(credential!);
    const port = gatewayPort(previousState);
    anthropicBaseUrl = `http://127.0.0.1:${port}/anthropic`;
    codexBaseUrl = `http://127.0.0.1:${port}/openai/v1`;
    bearer = PROXY_PLACEHOLDER;
    modelHeaders = gatewayHeaders(credential!);
    llmBase = endpoints.llmBaseUrl;
  } else {
    if (!signIn.token) throw new Error("run kimchi-bridge login before enabling the gateway");
    // Derive the gateway base from the sign-in's region. The kimchi CLI
    // sign-in reports the console API URL (app.kimchi.dev/api); the bridge's
    // own OAuth store reports the CAST API base — accept both so a plain
    // Kimchi sign-in (key or SSO) needs no KIMCHI_BASE_URL.
    const api = baseUrl(signIn.apiUrl);
    const env = process.env.KIMCHI_BASE_URL?.trim();
    if (env) llmBase = baseUrl(env);
    else if (api === "https://api.eu.cast.ai" || api === "https://app.eu.kimchi.dev/api")
      llmBase = "https://llm.eu.kimchi.dev";
    else if (api === "https://api.cast.ai" || api === "https://app.kimchi.dev/api")
      llmBase = "https://llm.kimchi.dev";
    else
      throw new Error(
        "the gateway redirect needs a us/eu Kimchi sign-in, or KIMCHI_BASE_URL for a custom gateway",
      );
    anthropicBaseUrl = `${llmBase}/anthropic`;
    codexBaseUrl = `${llmBase}/openai/v1`;
    bearer = signIn.token;
    modelHeaders = { Authorization: `Bearer ${signIn.token}` };
  }

  // Fetch the model list first: a failure leaves nothing written.
  const models = await fetchModels(llmBase, modelHeaders);
  const claudePrevious = writeClaudeConfig(anthropicBaseUrl, bearer);
  const codexPrevious = writeCodexConfig(codexBaseUrl, bearer, models);

  const state: GatewayState = {
    ...previousState,
    enabled: true,
    mode: proxyMode ? "proxy" : "direct",
    ...(proxyMode ? { port: gatewayPort(previousState) } : {}),
    previous: {
      claude: claudePrevious,
      ...(codexPrevious ? { codexTopLevel: codexPrevious } : {}),
    },
  };
  saveGatewayState(state);

  let daemon: EnableResult["daemon"] = "off";
  let service: EnableResult["service"] = null;
  // KIMCHI_BRIDGE_DAEMON=0 skips the bring-up (test seam; the configs are
  // still written and the hooks' ensure starts the daemon in production).
  if (proxyMode && process.env.KIMCHI_BRIDGE_DAEMON === "0") {
    daemon = (await health(gatewayPort(state))).ok ? "running" : "off";
  } else if (proxyMode) {
    const outcome = await ensure();
    daemon = outcome === "running" || outcome === "started" ? outcome : "off";
    service = installService(cliEntry());
  } else {
    stop();
  }
  onMessage?.(
    proxyMode
      ? `Gateway enabled through the local proxy (127.0.0.1:${gatewayPort(state)}).`
      : "Gateway enabled with a direct connection to the Kimchi gateway.",
  );
  onMessage?.("Claude Code and Codex now send their model requests through Kimchi.");
  onMessage?.("Revert anytime with: kimchi-bridge gateway disable");
  return {
    mode: proxyMode ? "proxy" : "direct",
    port: proxyMode ? gatewayPort(state) : undefined,
    daemon,
    service,
  };
}

export async function disable(onMessage?: (message: string) => void): Promise<void> {
  const state = loadGatewayState();
  restoreClaudeConfig(state.previous?.claude);
  restoreCodexConfig(state.previous?.codexTopLevel);
  stop();
  saveGatewayState({ ...state, enabled: false, previous: undefined });
  onMessage?.("Gateway disabled. Claude Code and Codex use their own providers again.");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface GatewayStatus {
  enabled: boolean;
  mode?: GatewayMode;
  port?: number;
  pid?: number;
  running: boolean;
  region?: string;
  organizationId?: string;
}

export async function status(): Promise<GatewayStatus> {
  const state = loadGatewayState();
  const port = state.mode === "direct" ? undefined : gatewayPort(state);
  const probe = port === undefined ? undefined : await health(port);
  return {
    enabled: state.enabled === true,
    mode: state.mode,
    ...(port === undefined ? {} : { port }),
    pid: probe?.pid,
    running: probe?.ok === true,
    region: state.region,
    organizationId: state.organizationId,
  };
}

/** The reporting Config is only used for its account pinning here. */
export type { Config };
