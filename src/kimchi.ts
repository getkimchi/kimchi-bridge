import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Kimchi's sign-in, read for each upload and never saved. */
export interface SignIn {
  apiUrl: string;
  token?: string;
  /** Kimchi's SSO organization, sent as X-CastAi-Organization-Id with an SSO token. */
  organizationId?: string;
}

/** The API answered, and the sign-in is not a verified account. */
export class IdentityError extends Error {}

// Kimchi's sign-in, in the order of its resolveGatewayCredentials: an API key (KIMCHI_API_KEY,
// then the global config), else its saved login, whose SSO token carries its organization.
// Project .kimchi/config.json keys stay Kimchi's: the plugins can't see its project trust.
export function KimchiSignIn(
  environmentKey = "",
  dir = join(process.env.HOME || homedir(), ".config", "kimchi"),
  env: Record<string, string | undefined> = process.env,
): SignIn {
  let config: Record<string, unknown> = {};
  try {
    config = kimchiFile(join(dir, "config.json"));
  } catch {
    // Kimchi reads a malformed config as empty too, and still uses its saved login.
  }
  const apiUrl = kimchiApiUrl(config, env);
  const key = environmentKey || text(config.apiKey) || text(config.api_key);
  if (key) return { apiUrl, token: key };
  const login = object(kimchiFile(join(dir, "harness", "auth.json"))["kimchi-dev"]);
  if (login.type === "oauth" && text(login.access))
    return { apiUrl, token: text(login.access), organizationId: text(login.orgId) || undefined };
  if (login.type === "api_key" && text(login.key)) return { apiUrl, token: text(login.key) };
  return { apiUrl };
}
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" ? v : "");
function kimchiFile(path: string): Record<string, unknown> {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 1 << 20) throw new Error();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Kimchi settings could not be read");
  }
}
// Where Kimchi's own uploads go (resolveEndpoints().platformApiUrl): KIMCHI_REMOTE_ENDPOINT,
// else the region's console with /api. Self-hosted needs all three stored endpoints, as in Kimchi.
function kimchiApiUrl(config: Record<string, unknown>, env: Record<string, string | undefined>) {
  if (env.KIMCHI_REMOTE_ENDPOINT) return env.KIMCHI_REMOTE_ENDPOINT;
  const region = [env.KIMCHI_REGION, config.region].find((r) =>
    ["us", "eu", "self-hosted"].includes(text(r)),
  );
  if (region === "eu") return "https://app.eu.kimchi.dev/api";
  if (region !== "self-hosted") return "https://app.kimchi.dev/api";
  const stored = object(config.selfHostedEndpoints);
  const [api, console, llm] = ["api", "console", "llm"].map((key) => origin(text(stored[key])));
  return api && console && llm ? console + "/api" : "";
}
// Kimchi's normalizeSelfHostedBaseUrl: an absolute http(s) URL without trailing slashes.
function origin(value: string): string {
  value = BaseUrl(value.trim());
  try {
    return ["http:", "https:"].includes(new URL(value).protocol) ? value : "";
  } catch {
    return "";
  }
}

export function ValidID(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const parts = id.split("-");
  if (parts.map((part) => part.length).join(",") !== "8,4,4,4,12") return false;
  const compact = parts.join("").toLowerCase(),
    bytes = Buffer.from(compact, "hex");
  return (
    bytes.length === 16 && bytes.toString("hex") === compact && !bytes.equals(Buffer.alloc(16))
  );
}

export const hasControl = (text: string) => ["\r", "\n", "\0"].some((char) => text.includes(char));
export function BaseUrl(value: string): string {
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

export function secureEndpoint(endpoint: unknown): void {
  let url: URL;
  try {
    url = new URL(typeof endpoint === "string" ? endpoint : "");
  } catch {
    throw new Error("invalid reporting API URL");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("invalid reporting API URL");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error("reporting requires HTTPS");
}

export function CredentialHash(k: SignIn): string {
  return createHash("sha256")
    .update([k.apiUrl, k.token ?? "", k.organizationId ?? ""].join("\0"))
    .digest("hex");
}

export function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
}

/** The response body as text, read up to a size bound. */
export async function readBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("response exceeds size bound");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Kimchi's gatewayAuthHeaders: the bearer, plus the organization header for SSO.
export function authorization(k: SignIn): Record<string, string> {
  return {
    Authorization: `Bearer ${k.token}`,
    ...(k.organizationId ? { "X-CastAi-Organization-Id": k.organizationId } : {}),
  };
}

/** Verify a sign-in the way Kimchi's uploader does (api-keys:verify) and return its account. */
export async function Authenticate(k: SignIn, signal?: AbortSignal) {
  secureEndpoint(k.apiUrl);
  if (!k.token || hasControl(k.token + (k.organizationId ?? "")))
    throw new Error("invalid Kimchi sign-in");
  const apiUrl = BaseUrl(k.apiUrl);
  let identity: { organizationId?: unknown; userId?: unknown };
  try {
    const verify = await request(
      `${apiUrl}/ai-optimizer/v1beta/api-keys:verify`,
      { method: "POST", headers: { ...authorization(k), Accept: "application/json" } },
      signal,
    );
    if (verify.status !== 200)
      throw new IdentityError(`Kimchi sign-in verification returned HTTP ${verify.status}`);
    identity = JSON.parse(await readBody(verify, 1 << 20));
    if (!identity || !ValidID(identity.organizationId) || !ValidID(identity.userId))
      throw new IdentityError("invalid reporting account identity");
    if (
      k.organizationId &&
      k.organizationId.toLowerCase() !== identity.organizationId.toLowerCase()
    )
      throw new IdentityError("organization does not match the Kimchi sign-in");
  } catch (error) {
    // Native transport exceptions may contain request headers or response bodies.
    if (error instanceof IdentityError) throw error;
    throw new Error("reporting identity endpoint unavailable or invalid response");
  }
  return {
    apiUrl,
    organizationId: (identity.organizationId as string).toLowerCase(),
    actorId: (identity.userId as string).toLowerCase(),
    credentialHash: CredentialHash(k),
  };
}
