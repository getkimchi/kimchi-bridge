import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./platform.ts";
import type { GatewayModel } from "./gateway.ts";

const CODEX_PROVIDER = "kimchi";
const CODEX_PROVIDER_NAME = "Kimchi Gateway";
const CHATGPT_FEED_PROVIDER = "chatgpt";
const UNSUPPORTED_SUBSCRIPTION_MODEL = "gpt-5.3-codex";

export type CodexRoute = "kimchi-dev" | "kimchi-dev/openai-codex";
export const CODEX_ORDINARY_ROUTE: CodexRoute = "kimchi-dev";
export const CODEX_SUBSCRIPTION_ROUTE: CodexRoute = "kimchi-dev/openai-codex";

const TOP_LEVEL_KEYS = ["model_provider", "model", "model_catalog_json"];

function codexHome(): string {
  return process.env.KIMCHI_BRIDGE_CONFIG_HOME ?? homedir();
}

export function codexConfigPath(): string {
  return join(codexHome(), ".codex", "config.toml");
}
export function codexCatalogPath(): string {
  return join(codexHome(), ".codex", "model_catalog.json");
}
export function codexAuthPath(): string {
  return join(codexHome(), ".codex", "auth.json");
}

export class CodexInstallation {
  constructor(
    private readonly configPath: string = codexConfigPath(),
    private readonly catalogPath: string = codexCatalogPath(),
  ) {}

  apply(options: {
    baseUrl: string;
    bearer: string;
    modelSlug: string;
    models: readonly GatewayModel[];
    subscriptionAvailable: boolean;
  }): CodexSnapshot {
    const existing = this.readConfig();
    const snapshot: CodexSnapshot = { topLevel: this.snapshotTopLevel(existing) };
    const catalog = buildCodexCatalog(options.models, options.subscriptionAvailable);
    writeFileAtomic(
      this.configPath,
      mergeCodexToml(
        existing,
        buildCodexToml(
          options.baseUrl,
          options.bearer,
          options.modelSlug,
          this.catalogPath,
          requiresOpenAIAuth(catalog.routes),
        ),
      ),
      0o644,
    );
    writeFileAtomic(this.catalogPath, JSON.stringify(catalog, null, 2) + "\n", 0o644);
    return snapshot.topLevel?.length ? snapshot : {};
  }

  restore(snapshot: CodexSnapshot = {}): void {
    const existing = this.readConfig();
    if (!existing) return;
    const stripped = stripCodexToml(existing);
    const previous = snapshot.topLevel ?? [];
    const restored = previous.length
      ? `${previous.map(([key, value]) => `${key} = ${value}`).join("\n")}\n${stripped ? `\n${stripped}\n` : ""}`
      : `${stripped}\n`;
    writeFileAtomic(this.configPath, restored, 0o644);
    try {
      rmSync(this.catalogPath, { force: true });
    } catch {
      /* the catalog is ours to drop; ignore failures */
    }
  }

  routeFor(model: unknown): CodexRoute {
    if (typeof model !== "string" || !model) return CODEX_ORDINARY_ROUTE;
    try {
      const bytes = readFileSync(this.catalogPath);
      if (bytes.length > 24 << 20) return CODEX_ORDINARY_ROUTE;
      const catalog = JSON.parse(bytes.toString("utf8")) as { routes?: unknown };
      const routes = catalog.routes;
      if (!routes || typeof routes !== "object" || Array.isArray(routes))
        return CODEX_ORDINARY_ROUTE;
      return (routes as Record<string, unknown>)[model] === CODEX_SUBSCRIPTION_ROUTE
        ? CODEX_SUBSCRIPTION_ROUTE
        : CODEX_ORDINARY_ROUTE;
    } catch {
      return CODEX_ORDINARY_ROUTE;
    }
  }

  private readConfig(): string {
    try {
      return readFileSync(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return "";
    }
  }

  private snapshotTopLevel(existing: string): Array<[string, string]> {
    const previous: Array<[string, string]> = [];
    let inAnySection = false;
    for (const { line, kind } of classifyTomlLines(existing)) {
      if (kind !== "body") {
        inAnySection = true;
        continue;
      }
      if (inAnySection) continue;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const split = trimmed.indexOf("=");
      const key = trimmed.slice(0, split).trim();
      const value = trimmed.slice(split + 1).trim();
      if (TOP_LEVEL_KEYS.includes(key) && value && !isLegacyProviderValue(key, value))
        previous.push([key, value]);
    }
    return previous;
  }
}

function isLegacyProviderValue(key: string, value: string): boolean {
  return (
    key === "model_provider" &&
    ['"kimchi"', "'kimchi'", '"kimchi_chatgpt"', "'kimchi_chatgpt'"].includes(value)
  );
}

function requiresOpenAIAuth(routes: Record<string, CodexRoute>): boolean {
  return Object.values(routes).includes(CODEX_SUBSCRIPTION_ROUTE);
}

export interface CodexSnapshot {
  topLevel?: Array<[string, string]>;
}

function tomlEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

function withoutComment(line: string): string {
  const hash = line.indexOf("#");
  if (hash === -1) return line;
  const before = line.slice(0, hash);
  if ((before.split('"').length - 1) % 2 === 1 || (before.split("'").length - 1) % 2 === 1)
    return line;
  return before.trimEnd();
}

type TomlLineKind = "kimchi-header" | "header" | "array-header" | "body";

function classifyTomlLine(line: string): TomlLineKind {
  const trimmed = line.trim();
  if (trimmed.startsWith("[[")) return "array-header";
  const core = trimmed.startsWith("[") ? withoutComment(trimmed) : trimmed;
  if (!core.startsWith("[") || !core.endsWith("]")) return "body";
  const section = core.slice(1, -1).trim();
  const owned = [CODEX_PROVIDER, "kimchi_chatgpt"].some(
    (provider) =>
      section === `model_providers.${provider}` ||
      section.startsWith(`model_providers.${provider}.`),
  );
  return owned ? "kimchi-header" : "header";
}

function classifyTomlLines(text: string): Array<{ line: string; kind: TomlLineKind }> {
  let multiline: '"""' | "'''" | undefined;
  return text.split("\n").map((line) => {
    const kind = multiline ? "body" : classifyTomlLine(line);
    let basic = false;
    let literal = false;
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (line.startsWith(multiline, i)) {
          multiline = undefined;
          i += 2;
        } else if (multiline === '"""' && line[i] === "\\") {
          i++;
        }
        continue;
      }
      if (basic) {
        if (line[i] === "\\") i++;
        else if (line[i] === '"') basic = false;
        continue;
      }
      if (literal) {
        if (line[i] === "'") literal = false;
        continue;
      }
      if (line[i] === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multiline = line.startsWith('"""', i) ? '"""' : "'''";
        i += 2;
      } else if (line[i] === '"') {
        basic = true;
      } else if (line[i] === "'") {
        literal = true;
      }
    }
    return { line, kind };
  });
}

export function buildCodexToml(
  baseUrlValue: string,
  bearer: string,
  modelSlug: string,
  catalogPath: string,
  requiresOpenAIAuth = false,
): string {
  const openAIAuth = requiresOpenAIAuth ? "requires_openai_auth = true\n" : "";
  return `model_provider = "${CODEX_PROVIDER}"
model = "${tomlEscape(modelSlug)}"
model_catalog_json = "${tomlEscape(catalogPath)}"

[model_providers.${CODEX_PROVIDER}]
name = "${CODEX_PROVIDER_NAME}"
base_url = "${tomlEscape(baseUrlValue)}"
http_headers = { Authorization = "Bearer ${tomlEscape(bearer)}" }
wire_api = "responses"
${openAIAuth}`;
}

/** Drops the bridge-owned top-level keys and provider sections, keeping the person's content. */
export function stripCodexToml(existingText: string): string {
  const kept: string[] = [];
  let inKimchiSection = false;
  let inAnySection = false;
  for (const { line, kind } of classifyTomlLines(existingText)) {
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
        if (TOP_LEVEL_KEYS.includes(key)) continue;
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

function splitTomlAtFirstHeader(text: string): { top: string; sections: string } {
  const lines = classifyTomlLines(text);
  const cut = lines.findIndex(({ kind }) => kind !== "body");
  if (cut === -1) return { top: text.trim(), sections: "" };
  return {
    top: lines
      .slice(0, cut)
      .map(({ line }) => line)
      .join("\n")
      .trim(),
    sections: lines
      .slice(cut)
      .map(({ line }) => line)
      .join("\n")
      .trim(),
  };
}

/** Places fresh bridge TOML first and the person's scalars above every table, so Codex parses it. */
export function mergeCodexToml(existingText: string, freshToml: string): string {
  const collapsed = stripCodexToml(existingText).trim();
  if (!collapsed) return freshToml.trim() + "\n";
  const fresh = splitTomlAtFirstHeader(freshToml.trim());
  const user = splitTomlAtFirstHeader(collapsed);
  return `${[fresh.top, user.top, fresh.sections, user.sections].filter(Boolean).join("\n\n")}\n`;
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
  supports_search_tool: boolean;
  web_search_tool_type: "text" | "text_and_image";
}

export interface CodexCatalog {
  models: CodexModelEntry[];
  routes: Record<string, CodexRoute>;
}

const REASONING_LEVELS = [
  { effort: "low", description: "Low reasoning effort" },
  { effort: "medium", description: "Medium reasoning effort" },
  { effort: "high", description: "High reasoning effort" },
] as const;

export function buildCodexCatalog(
  models: readonly GatewayModel[],
  subscriptionAvailable = false,
): CodexCatalog {
  const selected = new Map<string, { model: GatewayModel; route: CodexRoute }>();
  for (const model of models) {
    const subscription = model.provider === CHATGPT_FEED_PROVIDER;
    if (subscription && (!subscriptionAvailable || model.slug === UNSUPPORTED_SUBSCRIPTION_MODEL))
      continue;
    const route = subscription ? CODEX_SUBSCRIPTION_ROUTE : CODEX_ORDINARY_ROUTE;
    const existing = selected.get(model.slug);
    if (existing?.route === CODEX_SUBSCRIPTION_ROUTE || (existing && !subscription)) continue;
    selected.set(model.slug, { model, route });
  }
  const chosen = [...selected.values()];
  return {
    models: chosen.map(({ model, route }, index) => entryFor(model, route, index)),
    routes: Object.fromEntries(chosen.map(({ model, route }) => [model.slug, route])),
  };
}

function entryFor(model: GatewayModel, route: CodexRoute, index: number): CodexModelEntry {
  const subscription = route === CODEX_SUBSCRIPTION_ROUTE;
  return {
    slug: model.slug,
    // The registry currently serves empty display_name, and Codex's picker renders that field.
    display_name: model.display_name || model.slug,
    name: model.slug,
    model: model.slug,
    provider: CODEX_PROVIDER,
    context_window: model.limits.context_window,
    truncation_policy: { mode: "tokens", limit: model.limits.context_window },
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: (index + 1) * 10,
    base_instructions: "You are a helpful coding assistant.",
    supports_tools: true,
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    supports_reasoning_summaries: model.reasoning === true,
    support_verbosity: model.reasoning === true,
    supported_reasoning_levels: model.reasoning === true ? [...REASONING_LEVELS] : [],
    supports_search_tool: true,
    web_search_tool_type: subscription ? ("text_and_image" as const) : ("text" as const),
  };
}

export function hasUsableChatGPTLogin(path = codexAuthPath()): boolean {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 1 << 20) return false;
    const auth = JSON.parse(bytes.toString("utf8")) as {
      auth_mode?: unknown;
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown };
      personal_access_token?: unknown;
    };
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
    if (
      (auth.auth_mode !== undefined &&
        auth.auth_mode !== "chatgpt" &&
        auth.auth_mode !== "chatgptAuthTokens" &&
        auth.auth_mode !== "personalAccessToken") ||
      (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0)
    )
      return false;
    if (
      (auth.auth_mode === "personalAccessToken" || auth.auth_mode === undefined) &&
      typeof auth.personal_access_token === "string" &&
      auth.personal_access_token.trim().length > 0
    )
      return true;
    const accessToken = auth.tokens?.access_token;
    return (
      typeof accessToken === "string" &&
      accessToken.split(".").length === 3 &&
      accessToken.split(".").every((part) => part.length > 0)
    );
  } catch {
    return false;
  }
}
