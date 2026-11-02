// OAuth (Authorization Code + PKCE, S256) against the per-region CAST AI Auth0
// tenants, ported from Kimchi's src/cli-auth and src/oauth-config (CAST AI,
// Apache-2.0): fixed-port loopback callback, RFC 6749 error mapping,
// rotation-tolerant refresh, and the org-scoped credential store the gateway
// proxy shares. The stored credential also surfaces as a Kimchi sign-in for
// reporting, exactly like the one read from Kimchi's own config.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { validId } from "./kimchi.ts";
import { stateRoot } from "./settings.ts";
import { lockSync } from "./platform.ts";

export type RegionId = "us" | "eu";

export interface OAuthEndpoints {
  region: RegionId;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  audience?: string;
  castApiUrl: string;
  llmBaseUrl: string;
  useIdToken: boolean;
}

export interface OAuthCredential {
  region: RegionId;
  tokenUrl: string;
  clientId: string;
  audience?: string;
  useIdToken: boolean;
  accessToken: string;
  idToken?: string;
  refreshToken: string;
  /** Epoch ms when the bearer stops being trustworthy; 60s of IdP-clock skew margin is baked in. */
  expires: number;
  orgId: string;
  orgName: string;
  actorId?: string;
  actorUsername?: string;
}

interface TokenFlowConfig {
  region: RegionId;
  tokenUrl: string;
  clientId: string;
  audience?: string;
  useIdToken: boolean;
}

type Environment = Record<string, string | undefined>;

const TOKEN_TIMEOUT_MS = 15_000;
const EXPIRY_MARGIN_MS = 60_000;
/** Refresh this long before the stored expiry so requests never start at the edge. */
const FRESH_WINDOW_MS = 30_000;
const CALLBACK_PORT = 8765;
const CALLBACK_TIMEOUT_MS = 300_000;
export const OAUTH_SCOPE = "openid profile email offline_access";
export const ORGANIZATION_HEADER = "X-CastAi-Organization-Id";

// Per-region native-app clients, mirroring Kimchi's src/oauth-config. Client
// ids are public identifiers, not secrets. The redirect URI is exactly
// `http://localhost:8765/callback`; refresh-token rotation must stay OFF.
const REGION_DEFAULTS: Record<
  RegionId,
  Omit<OAuthEndpoints, "region" | "audience" | "useIdToken">
> = {
  us: {
    authorizeUrl: "https://login.kimchi.dev/authorize",
    tokenUrl: "https://login.kimchi.dev/oauth/token",
    clientId: "rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS",
    castApiUrl: "https://api.cast.ai",
    llmBaseUrl: "https://llm.kimchi.dev",
  },
  eu: {
    authorizeUrl: "https://login.eu.kimchi.dev/authorize",
    tokenUrl: "https://login.eu.kimchi.dev/oauth/token",
    clientId: "Bw2sA2DJyUAN2wpGiHU72Wh2Xenw6xma",
    castApiUrl: "https://api.eu.cast.ai",
    llmBaseUrl: "https://llm.eu.kimchi.dev",
  },
};

function boolEnv(env: Environment, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  return value === "1" || value === "true" || value === "yes";
}
function textEnv(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}
/** Normalize an origin-ish endpoint; https required away from the loopback (test seams). */
function origin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid ${label}: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`invalid ${label}`);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error(`${label} requires HTTPS`);
  let base = url.origin;
  if (url.pathname !== "/" && url.pathname !== "") {
    let path = url.pathname;
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    base += path;
  }
  return base;
}

export function oauthEndpoints(region: RegionId, env: Environment = process.env): OAuthEndpoints {
  const base = REGION_DEFAULTS[region];
  if (!base) throw new Error(`OAuth is not available for region ${region}`);
  const tag = region.toUpperCase().replaceAll("-", "_");
  return {
    region,
    authorizeUrl: origin(
      textEnv(env, "KIMCHI_OAUTH_AUTHORIZE_URL") ?? base.authorizeUrl,
      "authorize URL",
    ),
    tokenUrl: origin(textEnv(env, "KIMCHI_OAUTH_TOKEN_URL") ?? base.tokenUrl, "token URL"),
    clientId:
      textEnv(env, `KIMCHI_OAUTH_CLIENT_ID_${tag}`) ??
      textEnv(env, "KIMCHI_OAUTH_CLIENT_ID") ??
      base.clientId,
    audience: textEnv(env, "KIMCHI_OAUTH_AUDIENCE") ?? "https://app.kimchi.dev",
    castApiUrl: origin(
      textEnv(env, "KIMCHI_REMOTE_ENDPOINT") ?? base.castApiUrl,
      "Cast AI API URL",
    ),
    llmBaseUrl: origin(textEnv(env, "KIMCHI_BASE_URL") ?? base.llmBaseUrl, "LLM gateway URL"),
    useIdToken: boolEnv(env, "KIMCHI_OAUTH_USE_ID_TOKEN") ?? true,
  };
}

/** Endpoints for a stored credential: region defaults with current env overrides applied. */
export function endpointsForCredential(
  credential: Pick<OAuthCredential, "region">,
  env: Environment = process.env,
): OAuthEndpoints {
  return oauthEndpoints(credential.region, env);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) and state
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
export function generateState(): string {
  return randomBytes(32).toString("hex");
}

export function buildAuthorizeUrl(
  config: Pick<OAuthEndpoints, "authorizeUrl" | "clientId" | "audience">,
  params: { codeChallenge: string; state: string; redirectUri: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: params.redirectUri,
    scope: OAUTH_SCOPE,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    ...(config.audience ? { audience: config.audience } : {}),
  }).toString();
  return url.toString();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OAuthTokenError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "OAuthTokenError";
    this.code = options.code;
    this.status = options.status;
  }
}
/** True when the refresh token is dead and the user must sign in again. */
export function isInvalidGrant(error: unknown): boolean {
  return error instanceof OAuthTokenError && error.code === "invalid_grant";
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponseBody {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postTokenRequest(
  tokenUrl: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenResponseBody> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)])
        : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Login cancelled");
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new OAuthTokenError(`Token request to ${tokenUrl} timed out`);
    throw new OAuthTokenError(`Token request to ${tokenUrl} failed`);
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => "")) || response.statusText;
    let code: string | undefined;
    let description: string | undefined;
    try {
      const parsed = JSON.parse(body) as TokenResponseBody;
      code = parsed.error;
      description = parsed.error_description;
    } catch {
      /* non-JSON error body: fall through to the raw text */
    }
    throw new OAuthTokenError(
      `Token request failed (HTTP ${response.status}): ${description ?? code ?? body}`,
      { code, status: response.status },
    );
  }
  return (await response.json()) as TokenResponseBody;
}

function requireTokenField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`token response has invalid ${field}`);
  return value;
}

function credentialFromTokenResponse(
  token: TokenResponseBody,
  config: TokenFlowConfig,
  previous?: OAuthCredential,
): OAuthCredential {
  const accessToken = requireTokenField(token.access_token, "access_token");
  const idToken =
    typeof token.id_token === "string" && token.id_token.trim() ? token.id_token : undefined;
  // Rotation handling: a rotated refresh token replaces the stored one; when the
  // server omits it the existing token remains valid.
  const refreshToken =
    typeof token.refresh_token === "string" && token.refresh_token.trim()
      ? token.refresh_token
      : previous?.refreshToken;
  if (!refreshToken)
    throw new Error(
      "CAST AI sign-in did not return a refresh token; offline_access must be allowed for the client",
    );
  if (
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  )
    throw new Error("token response has invalid expires_in");
  if (config.useIdToken && !idToken)
    throw new Error(
      "CAST AI sign-in did not return an ID token (set KIMCHI_OAUTH_USE_ID_TOKEN=0 to use the access token)",
    );
  return {
    region: config.region,
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    ...(config.audience ? { audience: config.audience } : {}),
    useIdToken: config.useIdToken,
    accessToken,
    ...(idToken ? { idToken } : {}),
    refreshToken,
    expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
    orgId: previous?.orgId ?? "",
    orgName: previous?.orgName ?? "",
    ...(previous?.actorId ? { actorId: previous.actorId } : {}),
    ...(previous?.actorUsername ? { actorUsername: previous.actorUsername } : {}),
  };
}

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

export function credentialPath(root = stateRoot()): string {
  return join(root, "gateway-auth.json");
}

function shapeCredential(value: unknown): OAuthCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.region !== "us" && v.region !== "eu") return null;
  const region: RegionId = v.region;
  const strings = ["tokenUrl", "clientId", "accessToken", "refreshToken", "orgName"];
  if (strings.some((key) => typeof v[key] !== "string" || !(v[key] as string).trim())) return null;
  if (!validId(v.orgId)) return null;
  if (typeof v.expires !== "number" || !Number.isFinite(v.expires) || v.expires <= 0) return null;
  if (v.idToken !== undefined && typeof v.idToken !== "string") return null;
  if (v.audience !== undefined && typeof v.audience !== "string") return null;
  if (typeof v.useIdToken !== "boolean") return null;
  if (v.actorId !== undefined && !validId(v.actorId)) return null;
  if (v.actorUsername !== undefined && typeof v.actorUsername !== "string") return null;
  return {
    region,
    tokenUrl: v.tokenUrl as string,
    clientId: v.clientId as string,
    ...(typeof v.audience === "string" ? { audience: v.audience } : {}),
    useIdToken: v.useIdToken,
    accessToken: v.accessToken as string,
    ...(typeof v.idToken === "string" && v.idToken ? { idToken: v.idToken } : {}),
    refreshToken: v.refreshToken as string,
    expires: v.expires,
    orgId: (v.orgId as string).toLowerCase(),
    orgName: v.orgName as string,
    ...(validId(v.actorId) ? { actorId: (v.actorId as string).toLowerCase() } : {}),
    ...(typeof v.actorUsername === "string" ? { actorUsername: v.actorUsername } : {}),
  };
}

export function loadCredential(path = credentialPath()): OAuthCredential | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (bytes.length > 64 << 10)
    throw new Error("stored sign-in is invalid; run kimchi-bridge login");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("stored sign-in is invalid; run kimchi-bridge login");
  }
  const credential = shapeCredential(parsed);
  if (!credential) throw new Error("stored sign-in is invalid; run kimchi-bridge login");
  return credential;
}

export function saveCredential(credential: OAuthCredential, path = credentialPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.gateway-auth-${randomBytes(8).toString("hex")}`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(credential, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function deleteCredential(path = credentialPath()): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** The bearer string requests send: the ID token or the access token per the stored choice. */
export function bearerToken(credential: OAuthCredential): string {
  return credential.useIdToken ? (credential.idToken ?? "") : credential.accessToken;
}

/** Gateway auth headers for a credential: bearer plus SSO organization routing. */
export function gatewayHeaders(credential: OAuthCredential): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${bearerToken(credential)}` };
  if (credential.orgId) headers[ORGANIZATION_HEADER] = credential.orgId;
  return headers;
}

/**
 * The stored OAuth credential as a Kimchi sign-in, the same shape kimchiSignIn
 * returns for Kimchi's own saved login: the region's API URL, the bearer, and
 * the organization the SSO credential is scoped to.
 */
export function storedSignIn(env: Environment = process.env): {
  apiUrl: string;
  token: string;
  organizationId: string;
} | null {
  let credential: OAuthCredential | undefined;
  try {
    credential = loadCredential();
  } catch {
    return null;
  }
  if (!credential) return null;
  const token = bearerToken(credential);
  if (!token) return null;
  return {
    apiUrl: endpointsForCredential(credential, env).castApiUrl,
    token,
    organizationId: credential.orgId,
  };
}

// ---------------------------------------------------------------------------
// Organizations and identity
// ---------------------------------------------------------------------------

export interface KimchiOrganization {
  id: string;
  name: string;
}

export async function listOrganizations(
  castApiUrl: string,
  bearer: string,
  signal?: AbortSignal,
): Promise<KimchiOrganization[]> {
  let response: Response;
  try {
    response = await fetch(`${castApiUrl}/v1/organizations`, {
      headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)])
        : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Login cancelled");
    throw new Error(`fetching organizations failed: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`fetching organizations failed (HTTP ${response.status})`);
  const body = (await response.json().catch(() => null)) as {
    organizations?: Array<{ id?: unknown; name?: unknown }>;
  } | null;
  return (body?.organizations ?? [])
    .filter((org) => typeof org?.id === "string" && validId(org.id))
    .map((org) => ({
      id: (org.id as string).toLowerCase(),
      name: typeof org.name === "string" && org.name ? org.name : (org.id as string),
    }));
}

function selectOrganization(
  organizations: KimchiOrganization[],
  requested?: string,
): KimchiOrganization {
  if (!organizations.length) throw new Error("This CAST AI account has no organizations");
  if (requested) {
    const wanted = organizations.find(
      (org) => org.id === requested.toLowerCase() || org.name === requested,
    );
    if (!wanted)
      throw new Error(
        `organization ${requested} is not available to this account; available: ${organizations
          .map((org) => org.id)
          .join(", ")}`,
      );
    return wanted;
  }
  if (organizations.length === 1) return organizations[0];
  throw new Error(
    "this account belongs to multiple organizations; sign in again with --org <id>:\n" +
      organizations.map((org) => `  ${org.id}  ${org.name}`).join("\n"),
  );
}

export async function verifyActor(
  castApiUrl: string,
  bearer: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<{ id: string; username: string }> {
  let response: Response;
  try {
    response = await fetch(`${castApiUrl}/v1/me`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bearer}`,
        [ORGANIZATION_HEADER]: organizationId,
      },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)])
        : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Login cancelled");
    throw new Error("reporting identity endpoint unavailable or invalid response");
  }
  if (!response.ok) throw new Error(`reporting identity returned HTTP ${response.status}`);
  const profile = (await response.json().catch(() => null)) as {
    id?: unknown;
    username?: unknown;
  } | null;
  if (!profile || !validId(profile.id) || typeof profile.username !== "string" || !profile.username)
    throw new Error("the signed-in account is not a verified Kimchi user");
  return { id: (profile.id as string).toLowerCase(), username: profile.username };
}

// ---------------------------------------------------------------------------
// Loopback callback server (mode: authorization code)
// ---------------------------------------------------------------------------

interface CallbackServer {
  url: string;
  result: Promise<{ code?: string; error?: string; errorCode?: string }>;
  close: () => void;
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function pageHtml(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#16181d;color:#e6e6e6;\
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}\
.card{max-width:28rem;padding:2.5rem;border:1px solid #2f333b;border-radius:12px;text-align:center}\
h1{font-size:1.25rem;margin:0 0 .75rem}</style></head><body><div class="card"><h1>${escapeHtml(
    title,
  )}</h1><p>${escapeHtml(body)}</p></div></body></html>`;
}

async function startCallbackServer(
  state: string,
  options: { port?: number; successMessage?: string; timeoutMs?: number },
): Promise<CallbackServer> {
  let server: Server | undefined;
  let settled = false;
  let resolveResult!: (r: { code?: string; error?: string; errorCode?: string }) => void;
  const result = new Promise<{ code?: string; error?: string; errorCode?: string }>((resolve) => {
    resolveResult = resolve;
  });
  result.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (value: { code?: string; error?: string; errorCode?: string }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveResult(value);
    server?.close();
    setTimeout(() => server?.closeAllConnections?.(), 100).unref();
  };
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, html: string) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        Connection: "close",
      });
      response.end(html);
    };
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const peer = request.socket.remoteAddress ?? "";
      if (!(peer.startsWith("127.") || peer === "::1" || peer === "::ffff:127.0.0.1")) {
        reply(403, pageHtml("Forbidden", "Only localhost connections are allowed."));
        return;
      }
      if (request.method !== "GET" || url.pathname !== "/callback") {
        reply(404, pageHtml("Not found", "Nothing is served here."));
        return;
      }
      const received = Buffer.from(url.searchParams.get("state") ?? "");
      if (received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) {
        const message =
          "OAuth state mismatch — the sign-in attempt was rejected for your protection";
        reply(400, pageHtml("Sign-in failed", message));
        finish({ error: message });
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? error;
        reply(200, pageHtml("Authentication failed", description));
        finish({ error: description, errorCode: error });
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        const message = "Missing authorization code in the OAuth callback";
        reply(400, pageHtml("Missing code", message));
        finish({ error: message });
        return;
      }
      reply(
        200,
        pageHtml(
          "Signed in with CAST AI",
          options.successMessage ?? "You can close this window and return to your terminal.",
        ),
      );
      finish({ code });
    } catch {
      reply(500, pageHtml("Unexpected error", "The sign-in callback could not be processed."));
      finish({ error: "Unexpected callback server error" });
      request.socket.destroy();
    }
  };
  server = createServer(onRequest);
  // KIMCHI_OAUTH_CALLBACK_PORT (e.g. 0) is a test seam for compiled-binary
  // runs; production must keep the registered 8765 redirect exactly.
  const envPort = Number.parseInt(process.env.KIMCHI_OAUTH_CALLBACK_PORT ?? "", 10);
  const port = options.port ?? (Number.isFinite(envPort) ? envPort : CALLBACK_PORT);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", (error: NodeJS.ErrnoException) => {
      server = undefined;
      if (error.code === "EADDRINUSE")
        reject(
          new Error(
            `Port ${port} is in use, probably by an unfinished CAST AI sign-in in another Kimchi session. Cancel that sign-in and try again.`,
          ),
        );
      else reject(error);
    });
    server!.listen(port, "127.0.0.1", () => resolve());
  });
  timer = setTimeout(
    () => finish({ error: "Browser sign-in timed out; try again" }),
    options.timeoutMs ?? CALLBACK_TIMEOUT_MS,
  );
  // OAuth redirect URIs are registered with the `localhost` host, exact string.
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}/callback`,
    result,
    close: () => finish({ error: "Login cancelled" }),
  };
}

// ---------------------------------------------------------------------------
// Browser sign-in flow
// ---------------------------------------------------------------------------

export async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = Bun.spawn([command, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
}

export interface SSOLoginOptions {
  org?: string;
  noBrowser?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
  /** Invoked once the callback server is listening, with the sign-in URL. */
  onStarted?: (url: string) => void;
  /** Test seam: full endpoint set instead of region defaults + env overrides. */
  _endpoints?: OAuthEndpoints;
  /** Test seam: callback port (0 binds an ephemeral port like the key handoff). */
  _callbackPort?: number;
  /** Test seam for the opener. */
  _open?: (url: string) => Promise<unknown>;
  /** Test seam for the callback timeout. */
  _timeoutMs?: number;
}

export interface SSOLoginResult {
  credential: OAuthCredential;
  actorId: string;
  username: string;
  organization: KimchiOrganization;
}

export async function loginSSO(
  region: RegionId,
  options: SSOLoginOptions = {},
): Promise<SSOLoginResult> {
  const endpoints = options._endpoints ?? oauthEndpoints(region);
  const signal = options.signal;
  signal?.throwIfAborted();
  const verifier = generateCodeVerifier();
  const state = generateState();
  const callback = await startCallbackServer(state, {
    port: options._callbackPort,
    successMessage: "Signed in with CAST AI. You can close this window.",
    timeoutMs: options._timeoutMs,
  });
  const abort = () => callback.close();
  signal?.addEventListener("abort", abort, { once: true });
  const log = options.onMessage ?? console.log;
  try {
    if (signal?.aborted) throw new Error("Login cancelled");
    const url = buildAuthorizeUrl(endpoints, {
      codeChallenge: generateCodeChallenge(verifier),
      state,
      redirectUri: callback.url,
    });
    options.onStarted?.(url);
    log(`CAST AI sign-in: ${url}`);
    if (!options.noBrowser) {
      try {
        await (options._open ?? openBrowser)(url);
      } catch {
        log("Couldn't open the browser. Open the sign-in URL above manually.");
      }
    }
    const received = await callback.result;
    if (received.errorCode)
      throw new OAuthTokenError(`CAST AI sign-in failed: ${received.errorCode}`, {
        code: received.errorCode,
      });
    if (received.error) throw new Error(received.error);
    if (!received.code) throw new Error("CAST AI sign-in returned no authorization code");
    const token = await postTokenRequest(
      endpoints.tokenUrl,
      {
        grant_type: "authorization_code",
        client_id: endpoints.clientId,
        code: received.code,
        code_verifier: verifier,
        redirect_uri: callback.url,
        ...(endpoints.audience ? { audience: endpoints.audience } : {}),
      },
      signal,
    );
    let credential = credentialFromTokenResponse(token, endpoints);
    const bearer = bearerToken(credential);
    if (!bearer) throw new Error("CAST AI sign-in produced no usable bearer token");
    const organizations = await listOrganizations(endpoints.castApiUrl, bearer, signal);
    const organization = selectOrganization(organizations, options.org);
    const { id, username } = await verifyActor(
      endpoints.castApiUrl,
      bearer,
      organization.id,
      signal,
    );
    credential = {
      ...credential,
      orgId: organization.id,
      orgName: organization.name,
      actorId: id,
      actorUsername: username,
    };
    saveCredential(credential);
    return { credential, actorId: id, username, organization };
  } finally {
    signal?.removeEventListener("abort", abort);
    callback.close();
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export async function refreshOAuth(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const token = await postTokenRequest(
    credential.tokenUrl,
    {
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
      ...(credential.audience ? { audience: credential.audience } : {}),
    },
    signal,
  );
  return credentialFromTokenResponse(token, credential, credential);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load the stored credential and make sure its bearer is fresh: refresh under
 * the cross-process file lock (a concurrent refresher's write is picked up by
 * re-reading after the lock is acquired), so parallel requests and processes
 * never double-refresh. Throws when no credential is stored or refresh fails;
 * isInvalidGrant distinguishes a dead refresh token.
 */
export async function ensureFresh(
  signal?: AbortSignal,
  path = credentialPath(),
): Promise<OAuthCredential> {
  const initial = loadCredential(path);
  if (!initial) throw new Error("no saved sign-in; run kimchi-bridge login");
  if (Date.now() + FRESH_WINDOW_MS < initial.expires) return initial;
  const lockDir = join(dirname(path), "gateway-auth.lock");
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    const guard = lockSync(lockDir);
    if (guard) {
      try {
        const latest = loadCredential(path);
        if (!latest) throw new Error("no saved sign-in; run kimchi-bridge login");
        if (Date.now() + FRESH_WINDOW_MS < latest.expires) return latest;
        const refreshed = await refreshOAuth(latest, signal);
        saveCredential(refreshed, path);
        return refreshed;
      } finally {
        guard.close();
      }
    }
    await sleep(100);
    const reloaded = loadCredential(path);
    if (reloaded && Date.now() + FRESH_WINDOW_MS < reloaded.expires) return reloaded;
  }
  throw new Error("sign-in refresh is busy; try again");
}

// ---------------------------------------------------------------------------
// Reuse of the Kimchi CLI's stored credential
// ---------------------------------------------------------------------------

/** The Kimchi CLI's credential store next to its models.json (pi-coding-agent shape). */
export function kimchiAuthPath(): string {
  return join(homedir(), ".config", "kimchi", "harness", "auth.json");
}

/**
 * Read the Kimchi CLI's saved SSO credential (read-only; rotation is OFF on
 * the Auth0 client, so a shared refresh token stays valid for both clients).
 * Returns undefined when it is absent or not an OAuth credential.
 */
export function seedFromKimchi(path = kimchiAuthPath()): OAuthCredential | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (bytes.length > 64 << 10) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entry = (parsed as Record<string, unknown>)["kimchi-dev"];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const value = entry as Record<string, unknown>;
  if (value.type !== "oauth") return undefined;
  return (
    shapeCredential({
      ...value,
      // Map the pi-ai credential field names onto this helper's shape: `access`
      // is the bearer the Kimchi CLI selected (ID or access token per its own
      // useIdToken); we carry the raw tokens and the flag, not the choice.
      accessToken: value.accessToken ?? value.access,
      refreshToken: value.refresh,
    }) ?? undefined
  );
}

// ---------------------------------------------------------------------------
// Sign-in flow (browser or Kimchi CLI adoption) and detached progress
// ---------------------------------------------------------------------------

export interface SignInFlowOptions extends SSOLoginOptions {
  fromKimchi?: boolean;
  region?: RegionId;
  _kimchiAuthPath?: string;
}

export interface SignInFlowResult {
  credential: OAuthCredential;
  organization: KimchiOrganization;
  adopted: boolean;
}

/**
 * The sign-in flow: adopt the Kimchi CLI's saved credential when asked, or run
 * the CAST AI SSO browser flow. Verifies the acting user when needed (the
 * browser flow already did), honors --org, and stores the credential.
 */
export async function signInFlow(options: SignInFlowOptions = {}): Promise<SignInFlowResult> {
  const env = process.env;
  if (options.fromKimchi) {
    const seed = seedFromKimchi(options._kimchiAuthPath);
    if (seed) {
      saveCredential(seed);
      const credential = await ensureFresh(options.signal);
      if (
        options.org &&
        options.org.toLowerCase() !== credential.orgId &&
        options.org !== credential.orgName
      ) {
        const organizations = await listOrganizations(
          endpointsForCredential(credential, env).castApiUrl,
          bearerToken(credential),
          options.signal,
        );
        const wanted = organizations.find(
          (org) => org.id === options.org!.toLowerCase() || org.name === options.org,
        );
        if (!wanted)
          throw new Error(
            `organization ${options.org} is not available to this account; available: ${organizations
              .map((org) => org.id)
              .join(", ")}`,
          );
        const updated = { ...credential, orgId: wanted.id, orgName: wanted.name };
        saveCredential(updated);
        return finishSignIn(updated, options);
      }
      return finishSignIn(credential, options);
    }
    throw new Error("No saved Kimchi sign-in found; run kimchi-bridge login for the browser flow");
  }
  const region = options.region ?? "us";
  const result = await loginSSO(region, options);
  return { credential: result.credential, organization: result.organization, adopted: false };
}

/** Verify the acting user when the credential doesn't know it yet (adopted seeds). */
async function finishSignIn(
  credential: OAuthCredential,
  options: SignInFlowOptions,
): Promise<SignInFlowResult> {
  if (!credential.actorId) {
    const actor = await verifyActor(
      endpointsForCredential(credential).castApiUrl,
      bearerToken(credential),
      credential.orgId,
      options.signal,
    );
    const updated = { ...credential, actorId: actor.id, actorUsername: actor.username };
    saveCredential(updated);
    return {
      credential: updated,
      organization: { id: updated.orgId, name: updated.orgName },
      adopted: true,
    };
  }
  return {
    credential,
    organization: { id: credential.orgId, name: credential.orgName },
    adopted: true,
  };
}

// ---------------------------------------------------------------------------
// Detached sign-in progress and status (in-client sign-in commands)
// ---------------------------------------------------------------------------

export interface LoginProgress {
  phase: "starting" | "waiting" | "done" | "error";
  startedAt: number;
  url?: string;
  error?: string;
  finishedAt?: number;
}

export function loginProgressPath(root = stateRoot()): string {
  return join(root, "login-progress.json");
}

/** Best-effort progress marker for detached sign-ins; never fatal. */
export function writeLoginProgress(progress: LoginProgress, path = loginProgressPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(path), `.login-progress-${randomBytes(6).toString("hex")}`);
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(progress, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } finally {
      try {
        unlinkSync(tmp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch {
    /* progress is advisory */
  }
}

export function readLoginProgress(path = loginProgressPath()): LoginProgress | undefined {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 4096) return undefined;
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as LoginProgress;
  } catch {
    return undefined;
  }
}

/** A browser OAuth sign-in holds the fixed callback port while it waits. */
export async function loginInProgress(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(CALLBACK_PORT, "127.0.0.1");
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface LoginStatusResult {
  state: "signed-in" | "in-progress" | "signed-out";
  auth?: "oauth";
  region?: RegionId;
  organizationId?: string;
  organizationName?: string;
  actorId?: string;
  username?: string;
  expires?: string;
  fresh?: boolean;
  error?: string;
}

export async function loginStatus(): Promise<LoginStatusResult> {
  const progress = readLoginProgress();
  const status: LoginStatusResult = { state: "signed-out" };
  if (progress?.error) status.error = progress.error;
  try {
    const credential = loadCredential();
    if (credential) {
      status.state = "signed-in";
      status.auth = "oauth";
      status.region = credential.region;
      status.organizationId = credential.orgId;
      status.organizationName = credential.orgName;
      status.actorId = credential.actorId;
      if (credential.actorUsername) status.username = credential.actorUsername;
      status.expires = new Date(credential.expires).toISOString();
      status.fresh = credential.expires > Date.now();
    } else if (!status.error) {
      status.error = "stored sign-in is missing; run kimchi-bridge login";
    }
  } catch (error) {
    status.error = error instanceof Error ? error.message : "stored sign-in is unreadable";
  }
  // Another program may hold the callback port; only a login this plugin started counts.
  if (["starting", "waiting"].includes(progress?.phase ?? "") && (await loginInProgress()))
    status.state = "in-progress";
  return status;
}
