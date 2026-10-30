// Local loopback reverse proxy for the Kimchi LLM gateway, plus the Claude
// Code and Codex config writers that point the CLIs at it. Every sign-in
// routes through the proxy: OAuth keeps its bearer fresh and its SSO
// organization header, an API key rides on each request, and each model
// request carries Kimchi's billing tag so its bill can be found, as Kimchi's
// own requests do (CAST AI, Apache-2.0: src/integrations/claude-code.ts,
// codex.ts, extensions/work-attribution/request-tags.ts).
import { randomUUID } from "node:crypto";
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
import { baseUrl, kimchiSignIn } from "./kimchi.ts";
import { cliEntry, lockSync } from "./platform.ts";
import {
  endpointsForCredential,
  ensureFresh,
  gatewayHeaders,
  isInvalidGrant,
  loadCredential,
  ORGANIZATION_HEADER,
  refreshOAuth,
  saveCredential,
  seedFromKimchi,
} from "./oauth.ts";
import { billingTags, readResponseId, recordTag } from "./request-tags.ts";

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
    claudeDesktop?: Desktop3pPrevious;
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
  // No CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: the telemetry collector that
  // feeds PR-cost usage attribution is beta-gated, and the desktop app's 3P
  // Code sessions load these settings too.
  const pairs: Record<string, string> = {
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: authToken,
  };
  for (const [key, value] of Object.entries(pairs)) env[key] = value;
  // A stale kill-switch from an older bridge would keep the beta-gated
  // telemetry collector off; remove what we no longer set.
  delete env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
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
// Claude Desktop (the app) — third-party inference mode
//
// The desktop app ignores ~/.claude/settings.json's env block: it spawns its
// bundled Claude Code with its own pinned ANTHROPIC_BASE_URL. The supported
// way to route it through the gateway is Claude Desktop's third-party (3P)
// mode: a "deploymentMode": "3p" key in the main profile's
// claude_desktop_config.json switches the app at launch, and the gateway
// credentials live in a separate Claude-3p profile's configLibrary that the
// in-app configuration window normally writes. The mode key cannot be set by
// the configLibrary itself, so both are written here.
// ---------------------------------------------------------------------------

/** The main profile's userData dir (the 1P app's), or null when Claude Desktop is not installed. */
export function claudeDesktopAppData(): string | null {
  const home = homeDir();
  const candidates =
    process.platform === "darwin"
      ? [join(home, "Library", "Application Support", "Claude")]
      : process.platform === "win32"
        ? [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")]
        : [join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude")];
  for (const dir of candidates)
    try {
      readFileSync(join(dir, "config.json"));
      return dir;
    } catch {
      /* try the next candidate */
    }
  return null;
}

/**
 * The 3P profile's userData dir. Unlike the main dir it may not exist yet; the
 * app creates it on first launch into 3P mode. Windows keeps it under
 * %LOCALAPPDATA% while the main profile is %APPDATA%.
 */
export function claudeDesktop3pData(): string {
  const home = homeDir();
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Claude-3p");
  const base =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(base, "Claude-3p");
}

const DESKTOP_CONFIG_FILE = "claude_desktop_config.json";

/**
 * Claude Desktop runs only Anthropic models: for a gateway it drops every other model name with a warning, and any
 * warning shows its "Configuration may need attention" banner. Kimchi names its Claude routes claude-* or anthropic/*.
 */
function isDesktopModel(name: string): boolean {
  const slug = name.toLowerCase();
  return slug.startsWith("claude-") || slug.startsWith("anthropic/");
}
const DESKTOP_MODE_KEY = "deploymentMode";
const DESKTOP_LIBRARY_ENTRY = "Kimchi Gateway";

/** The configLibrary ids are lowercase UUIDs; the app rejects any other shape. */
function isConfigId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false;
  for (const c of value)
    if (c !== "-" && !(c >= "0" && c <= "9") && !(c >= "a" && c <= "f")) return false;
  return true;
}

export interface Desktop3pPrevious {
  /** The deploymentMode value before enable, null when the key was absent. */
  mode: string | null;
  /** The applied config id before enable, null when none was applied. */
  appliedId: string | null;
  /** Whether our configLibrary entry was newly created (disable removes it). */
  createdEntry: boolean;
  /** The library file's id, so port rewrites and disable can find it. */
  entryId: string;
  /** A pre-existing entry's file content before enable overwrote it. */
  entryContent?: string;
}

function readDesktopConfig(dir: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(join(dir, DESKTOP_CONFIG_FILE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${DESKTOP_CONFIG_FILE} could not be parsed; fix or remove it first`);
  }
}

/**
 * Switches Claude Desktop into third-party inference mode through the local
 * gateway proxy: persists the mode choice in the main profile and writes the
 * gateway credentials into the 3P profile's configLibrary. The proxy does not
 * serve Anthropic's model-list endpoint, so the fetched models are written as
 * the app's explicit model list, which also skips discovery. Returns what
 * `disable` restores, or null when the desktop app is not installed.
 */
export function writeClaudeDesktopConfig(
  anthropicBaseUrl: string,
  models: readonly GatewayModel[],
): Desktop3pPrevious | null {
  const appData = claudeDesktopAppData();
  if (!appData) return null;
  const claude = models.filter((m) => isDesktopModel(m.slug));
  // Without a Claude model the app has nothing to run through the gateway: leave it as it is.
  if (!claude.length) return null;

  const config = readDesktopConfig(appData);
  const previous: Desktop3pPrevious = {
    mode:
      typeof config[DESKTOP_MODE_KEY] === "string" ? (config[DESKTOP_MODE_KEY] as string) : null,
    appliedId: null,
    createdEntry: false,
    entryId: "",
  };
  config[DESKTOP_MODE_KEY] = "3p";
  writeAtomic(join(appData, DESKTOP_CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", 0o644);

  const library = join(claudeDesktop3pData(), "configLibrary");
  mkdirSync(library, { recursive: true, mode: 0o700 });
  let meta: { appliedId?: string; entries?: Array<{ id: string; name: string }> } = {};
  try {
    meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  } catch {
    /* a missing or unreadable meta starts a fresh library */
  }
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const existing = entries.find((entry) => entry && entry.name === DESKTOP_LIBRARY_ENTRY);
  if (isConfigId(existing?.id)) {
    previous.entryId = existing.id;
    try {
      previous.entryContent = readFileSync(join(library, `${existing.id}.json`), "utf8");
    } catch {
      /* a missing entry file is one we are about to create */
    }
  } else {
    previous.entryId = randomUUID();
    previous.createdEntry = true;
    entries.push({ id: previous.entryId, name: DESKTOP_LIBRARY_ENTRY });
  }
  previous.appliedId = isConfigId(meta.appliedId) ? meta.appliedId : null;
  meta.appliedId = previous.entryId;
  meta.entries = entries;
  writeAtomic(join(library, "_meta.json"), JSON.stringify(meta, null, 2) + "\n", 0o600);
  writeAtomic(
    join(library, `${previous.entryId}.json`),
    JSON.stringify(
      {
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: anthropicBaseUrl,
        inferenceGatewayApiKey: PROXY_PLACEHOLDER,
        inferenceGatewayAuthScheme: "bearer",
        inferenceCredentialKind: "static",
        // The app's connection test needs a model without discovery, which the
        // proxy does not serve; the fetched list is what Codex catalogs too.
        inferenceModels: claude.slice(0, 200).map((m) => ({ name: m.slug })),
      },
      null,
      2,
    ) + "\n",
    0o600,
  );
  return previous;
}

/**
 * Points desktop sessions at the live proxy after a port move, and drops the model names an older bridge wrote that
 * the app rejects.
 */
export function rewriteClaudeDesktopConfig(anthropicBaseUrl: string): void {
  const appData = claudeDesktopAppData();
  if (!appData) return;
  const library = join(claudeDesktop3pData(), "configLibrary");
  let meta: { appliedId?: string; entries?: Array<{ id: string; name: string }> };
  try {
    meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
  } catch {
    return; /* the desktop app was never configured */
  }
  const ours = (meta.entries ?? []).find(
    (entry) => entry && entry.name === DESKTOP_LIBRARY_ENTRY && isConfigId(entry.id),
  );
  if (!ours || meta.appliedId !== ours.id) return;
  const path = join(library, `${ours.id}.json`);
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  const before = JSON.stringify(config, null, 2) + "\n";
  config.inferenceGatewayBaseUrl = anthropicBaseUrl;
  if (Array.isArray(config.inferenceModels))
    config.inferenceModels = config.inferenceModels.filter(
      (model) => typeof model?.name === "string" && isDesktopModel(model.name),
    );
  const after = JSON.stringify(config, null, 2) + "\n";
  if (after !== before) writeAtomic(path, after, 0o600);
}

/** Restores the desktop app to the mode and library it had before enable. */
export function restoreClaudeDesktopConfig(previous?: Desktop3pPrevious): void {
  const appData = claudeDesktopAppData();
  if (!appData || !previous) return;
  try {
    const config = readDesktopConfig(appData);
    if (config[DESKTOP_MODE_KEY] === "3p") {
      if (previous.mode === null) delete config[DESKTOP_MODE_KEY];
      else config[DESKTOP_MODE_KEY] = previous.mode;
      writeAtomic(
        join(appData, DESKTOP_CONFIG_FILE),
        JSON.stringify(config, null, 2) + "\n",
        0o644,
      );
    }
  } catch {
    /* the app data changed shape; leave the mode key alone */
  }
  try {
    const library = join(claudeDesktop3pData(), "configLibrary");
    if (previous.createdEntry) {
      rmSync(join(library, `${previous.entryId}.json`), { force: true });
      let meta: { appliedId?: string; entries?: Array<{ id: string; name: string }> } = {};
      try {
        meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
      } catch {
        return;
      }
      meta.entries = (meta.entries ?? []).filter((entry) => entry && entry.id !== previous.entryId);
      if (previous.appliedId && meta.entries.some((entry) => entry.id === previous.appliedId))
        meta.appliedId = previous.appliedId;
      else if (meta.appliedId === previous.entryId) delete meta.appliedId;
      writeAtomic(join(library, "_meta.json"), JSON.stringify(meta, null, 2) + "\n", 0o600);
    } else if (previous.entryContent !== undefined) {
      // A pre-existing entry we overwrote gets its original content and the
      // library's applied pointer back.
      writeAtomic(join(library, `${previous.entryId}.json`), previous.entryContent, 0o600);
      try {
        const meta: { appliedId?: string; entries?: Array<{ id: string; name: string }> } =
          JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
        if (meta.appliedId === previous.entryId) {
          if (previous.appliedId) meta.appliedId = previous.appliedId;
          else delete meta.appliedId;
          writeAtomic(join(library, "_meta.json"), JSON.stringify(meta, null, 2) + "\n", 0o600);
        }
      } catch {
        /* a library we cannot rewrite back is left as the app's */
      }
    }
  } catch {
    /* the 3P profile is the app's to keep once it has run; ignore failures */
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
  if (!upstream()) return "off";
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
  if (!upstream()) return "unauthenticated";
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

// The gateway's serving stack (LiteLLM in front of vLLM) only implements
// client-executed function tools. Responses-API server-side built-ins such as
// {"type":"web_search"} pass request validation but then kill the streaming
// path mid-stream with a generic overloaded_error, which codex surfaces as
// "stream disconnected before completion". Both proxied routes hard-fail on
// these tools today (the anthropic route answers 503), so strip the known
// broken built-ins to keep requests working; revisit when the backend learns
// to serve or cleanly reject them.
const UNSUPPORTED_SERVER_TOOLS = ["web_search", "web_search_preview"];

export function stripUnsupportedServerTools(body: ArrayBuffer, pathname: string): ArrayBuffer {
  let parsed: { tools?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.tools)) return body;
  const kept = parsed.tools.filter((tool) => !isUnsupportedTool(tool));
  if (kept.length === parsed.tools.length) return body; // nothing to drop: byte-identical passthrough
  const dropped = parsed.tools.filter(isUnsupportedTool).map(describeToolType);
  log(`stripped unsupported server tool(s) ${dropped.join(", ")} from ${pathname}`);
  parsed.tools = kept;
  return new TextEncoder().encode(JSON.stringify(parsed)).buffer as ArrayBuffer;
}

function isUnsupportedTool(tool: unknown): boolean {
  if (typeof tool !== "object" || tool === null) return false;
  const type = (tool as { type?: unknown }).type;
  return typeof type === "string" && UNSUPPORTED_SERVER_TOOLS.includes(type);
}

function describeToolType(tool: unknown): string {
  if (typeof tool === "object" && tool !== null && "type" in tool) {
    const type = (tool as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
}

// The model requests the gateway bills; each carries its own billing tag.
const BILLED_PATHS = [
  "/anthropic/v1/messages",
  "/openai/v1/responses",
  "/openai/v1/chat/completions",
];

/** The gateway for a Kimchi sign-in's region, or KIMCHI_BASE_URL for a custom gateway. */
export function llmBaseFor(apiUrl: string): string | undefined {
  const env = process.env.KIMCHI_BASE_URL?.trim();
  if (env) return baseUrl(env);
  // The kimchi CLI sign-in reports the console API URL (app.kimchi.dev/api);
  // the bridge's own OAuth store reports the CAST API base.
  const api = baseUrl(apiUrl);
  if (api === "https://api.eu.cast.ai" || api === "https://app.eu.kimchi.dev/api")
    return "https://llm.eu.kimchi.dev";
  if (api === "https://api.cast.ai" || api === "https://app.kimchi.dev/api")
    return "https://llm.kimchi.dev";
  return undefined;
}

/** The gateway auth for Kimchi's API-key sign-in: its bearer, and its SSO organization when it has one. */
function keyHeaders(signIn: SignIn): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${signIn.token}` };
  if (signIn.organizationId) headers[ORGANIZATION_HEADER] = signIn.organizationId;
  return headers;
}

/** Where the proxy forwards: the bridge's own OAuth sign-in, else Kimchi's API-key sign-in. */
export function upstream():
  | { llmBase: string; region?: string; organizationId?: string }
  | undefined {
  const credential = loadCredential();
  if (credential)
    return {
      llmBase: endpointsForCredential(credential).llmBaseUrl,
      region: credential.region,
      organizationId: credential.orgId,
    };
  // Kimchi's saved sign-in only: the CLI drops KIMCHI_API_KEY at start, and a detached daemon never inherits it.
  const signIn = kimchiSignIn();
  const llmBase = signIn.token ? llmBaseFor(signIn.apiUrl) : undefined;
  return llmBase ? { llmBase, organizationId: signIn.organizationId } : undefined;
}

const ANTHROPIC_MODELS_PATH = "/anthropic/v1/models";

/**
 * The proxy's own Anthropic-style model list, from the catalog `enable` wrote
 * for Codex. The gateway upstream does not serve Anthropic's model endpoint,
 * and Claude Desktop's connection test needs it; without entries in the
 * desktop config it probes the endpoint directly.
 */
function anthropicModelsResponse(url: URL): Response | undefined {
  if (
    url.pathname !== ANTHROPIC_MODELS_PATH &&
    !url.pathname.startsWith(`${ANTHROPIC_MODELS_PATH}/`)
  )
    return undefined;
  let models: Array<{ id: string; display_name: string; type: string }> = [];
  try {
    const catalog: { models?: Array<{ slug: string; display_name?: string }> } = JSON.parse(
      readFileSync(codexCatalogPath(), "utf8"),
    );
    models = (catalog.models ?? []).map((m) => ({
      id: m.slug,
      display_name: m.display_name || m.slug,
      type: "model",
    }));
  } catch {
    return new Response("model catalog unavailable; run kimchi-bridge gateway enable\n", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }
  const requested = decodeURIComponent(url.pathname.slice(ANTHROPIC_MODELS_PATH.length + 1));
  if (requested) {
    const model = models.find((m) => m.id === requested);
    return model
      ? Response.json(model)
      : new Response(`model: \`${requested}\` not found\n`, {
          status: 404,
          headers: { "content-type": "text/plain" },
        });
  }
  return Response.json({
    data: models,
    first_id: models[0]?.id,
    has_more: false,
    last_id: models[models.length - 1]?.id,
  });
}

export async function proxyRequest(request: Request, llmBase: string): Promise<Response> {
  const url = new URL(request.url);
  const upstream = `${baseUrl(llmBase)}${url.pathname}${url.search}`;
  const credential = loadCredential();
  const signIn = credential ? undefined : kimchiSignIn();
  if (!credential && !signIn?.token)
    return new Response("Kimchi sign-in required; run kimchi-bridge login\n", {
      status: 401,
      headers: { "content-type": "text/plain" },
    });
  // Buffer the body so a 401 retry can re-send it; LLM request bodies are
  // finite JSON, and one in-flight buffer per request is bounded.
  const buffered =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  // Drop server-side built-in tools the backend cannot serve; everything else
  // forwards byte-identical.
  const body =
    buffered === undefined ? undefined : stripUnsupportedServerTools(buffered, url.pathname);
  let json: unknown;
  if (request.method === "POST" && BILLED_PATHS.includes(url.pathname) && body !== undefined)
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      // An unreadable body goes untagged, as in Kimchi.
    }
  let requestId: string | undefined;
  const forward = async (): Promise<Response> => {
    const headers = forwardHeaders(
      request.headers,
      credential ? gatewayHeaders(await ensureFresh()) : keyHeaders(signIn!),
    );
    // Every attempt gets its own tag, so a retry's bill never joins the first attempt's.
    const id = randomUUID();
    const tags = billingTags(headers, json, id);
    if (tags) headers.set("X-Tags", tags);
    requestId = tags ? id : undefined;
    return await fetch(upstream, {
      method: request.method,
      headers,
      body: body === undefined ? undefined : Buffer.from(body),
      redirect: "manual",
    });
  };
  let response = await forward();
  if (response.status === 401 && credential) {
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
  let reply = response.body;
  const tagged = requestId;
  if (tagged && response.ok && reply) {
    // Transcripts name a call by its response ID, so remember which tag that response's request carried.
    const [client, copy] = reply.tee();
    reply = client;
    void readResponseId(copy)
      .then((id) => id && recordTag(id, tagged))
      .catch((error: unknown) => log(`billing tag not recorded: ${(error as Error).message}`));
  }
  return new Response(reply, { status: response.status, headers });
}

export async function runDaemon(): Promise<void> {
  const target = upstream();
  if (!target) throw new Error("no sign-in; run kimchi-bridge login or sign in to Kimchi");
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
            const current = upstream();
            return Response.json({
              ok: true,
              service: HEALTH_MARKER,
              pid: process.pid,
              port: server?.port ?? candidate,
              region: current?.region,
              organizationId: current?.organizationId,
            });
          }
          const started = Date.now();
          try {
            const current = upstream();
            if (!current)
              return new Response("Kimchi sign-in required; run kimchi-bridge login\n", {
                status: 401,
                headers: { "content-type": "text/plain" },
              });
            const models = anthropicModelsResponse(url);
            if (models) {
              log(
                `${request.method} ${url.pathname} -> ${models.status} (local catalog) (${Date.now() - started}ms)`,
              );
              return models;
            }
            const response = await proxyRequest(request, current.llmBase);
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
  saveGatewayState({
    ...state,
    enabled: true,
    mode: "proxy",
    port,
    pid: process.pid,
    region: target.region,
    organizationId: target.organizationId,
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
  try {
    rewriteClaudeDesktopConfig(`http://127.0.0.1:${port}/anthropic`);
  } catch (error) {
    log(`Claude Desktop config rewrite failed: ${(error as Error).message}`);
  }
  log(`gateway proxy listening on 127.0.0.1:${port} -> ${target.llmBase}`);
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
 * Route the CLIs through the Kimchi gateway via the local proxy, for every
 * sign-in: an OAuth credential (adopting Kimchi's own saved login into the
 * shared credential store when only that exists) or Kimchi's API key. The
 * proxy tags each model request so the backend can price it from its bill.
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
  const previousState = loadGatewayState();
  const port = gatewayPort(previousState);

  let modelHeaders: Record<string, string>;
  let llmBase: string;
  if (credential) {
    modelHeaders = gatewayHeaders(credential);
    llmBase = endpointsForCredential(credential).llmBaseUrl;
  } else {
    if (!signIn.token) throw new Error("run kimchi-bridge login before enabling the gateway");
    // The proxy reads Kimchi's saved sign-in; a key only in KIMCHI_API_KEY never reaches the daemon.
    const saved = kimchiSignIn();
    if (!saved.token)
      throw new Error(
        "the gateway proxy needs a saved sign-in: sign in to Kimchi, or run kimchi-bridge login",
      );
    const base = llmBaseFor(saved.apiUrl);
    if (!base)
      throw new Error(
        "the gateway redirect needs a us/eu Kimchi sign-in, or KIMCHI_BASE_URL for a custom gateway",
      );
    modelHeaders = keyHeaders(saved);
    llmBase = base;
  }

  // Fetch the model list first: a failure leaves nothing written.
  const models = await fetchModels(llmBase, modelHeaders);
  const claudePrevious = writeClaudeConfig(`http://127.0.0.1:${port}/anthropic`, PROXY_PLACEHOLDER);
  const codexPrevious = writeCodexConfig(
    `http://127.0.0.1:${port}/openai/v1`,
    PROXY_PLACEHOLDER,
    models,
  );
  // Claude Desktop ignores the CLI settings, so it is switched into its
  // third-party mode pointing at the same proxy; null when it is not installed
  // or its config cannot be written, which never blocks the CLI wiring.
  let desktopPrevious: Desktop3pPrevious | null = null;
  try {
    desktopPrevious = writeClaudeDesktopConfig(`http://127.0.0.1:${port}/anthropic`, models);
  } catch {
    desktopPrevious = null;
  }

  const state: GatewayState = {
    ...previousState,
    enabled: true,
    mode: "proxy",
    port,
    // Re-enabling over our own settings (a direct-mode upgrade) keeps the user's
    // original values, so disable still restores what they had before.
    previous:
      previousState.enabled && previousState.previous
        ? {
            ...previousState.previous,
            // The desktop snapshot is recomputed above, so re-enable keeps
            // what disable would need to restore now, not the first enable's.
            ...(desktopPrevious ? { claudeDesktop: desktopPrevious } : {}),
          }
        : {
            claude: claudePrevious,
            ...(codexPrevious ? { codexTopLevel: codexPrevious } : {}),
            ...(desktopPrevious ? { claudeDesktop: desktopPrevious } : {}),
          },
  };
  saveGatewayState(state);

  let daemon: EnableResult["daemon"] = "off";
  let service: EnableResult["service"] = null;
  // KIMCHI_BRIDGE_DAEMON=0 skips the bring-up (test seam; the configs are
  // still written and the hooks' ensure starts the daemon in production).
  if (process.env.KIMCHI_BRIDGE_DAEMON === "0") {
    daemon = (await health(port)).ok ? "running" : "off";
  } else {
    const outcome = await ensure();
    daemon = outcome === "running" || outcome === "started" ? outcome : "off";
    service = installService(cliEntry());
  }
  onMessage?.(`Gateway enabled through the local proxy (127.0.0.1:${port}).`);
  onMessage?.("Claude Code and Codex now send their model requests through Kimchi.");
  if (desktopPrevious)
    onMessage?.(
      "Claude Desktop is configured for the same proxy; restart the Claude app to switch it over.",
    );
  onMessage?.("Revert anytime with: kimchi-bridge gateway disable");
  return { mode: "proxy", port, daemon, service };
}

export async function disable(onMessage?: (message: string) => void): Promise<void> {
  const state = loadGatewayState();
  restoreClaudeConfig(state.previous?.claude);
  restoreCodexConfig(state.previous?.codexTopLevel);
  if (state.previous?.claudeDesktop) {
    restoreClaudeDesktopConfig(state.previous.claudeDesktop);
    onMessage?.("Restart the Claude app to leave third-party mode.");
  }
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
