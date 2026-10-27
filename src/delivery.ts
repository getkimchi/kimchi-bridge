import { createHash } from "node:crypto";
import type { Store } from "./ledger.ts";
import {
  EncodeBatch,
  Hash,
  Parse,
  Stringify,
  type Acknowledgement,
  type Event,
} from "./protocol.ts";

declare const Temporal: { Instant: { from(value: string): { epochNanoseconds: bigint } } };
/** The API answered, and the sign-in is not a verified account. */
export class IdentityError extends Error {}

/** Kimchi's sign-in, read for each upload and never saved. */
export interface SignIn {
  apiUrl: string;
  token?: string;
  /** Kimchi's SSO organization, sent as X-CastAi-Organization-Id with an SSO token. */
  organizationId?: string;
}

/** The account a Kimchi sign-in was verified as. */
export interface Config {
  apiUrl?: string;
  organizationId?: string;
  actorId?: string;
  credentialHash?: string;
  otlpUrl?: string;
  otlpHeaders?: Record<string, string>;
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

const hasControl = (text: string) => ["\r", "\n", "\0"].some((char) => text.includes(char));
export function BaseUrl(value: string): string {
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function secureEndpoint(endpoint: unknown): void {
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

export function ValidateOTLP(c: Config): void {
  if (c.otlpUrl) secureEndpoint(c.otlpUrl);
  const headers = c.otlpHeaders ?? {};
  if (typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 16)
    throw new Error("invalid OTLP headers");
  for (const [key, value] of Object.entries(headers)) {
    if (
      !key ||
      key.length > 64 ||
      typeof value !== "string" ||
      value.length > 2048 ||
      hasControl(key + value)
    )
      throw new Error("invalid OTLP header");
    if (["host", "content-length", "transfer-encoding"].includes(key.toLowerCase()))
      throw new Error("reserved OTLP header");
  }
}

export function ValidateConfig(c: Config): void {
  secureEndpoint(c.apiUrl);
  ValidateOTLP(c);
  if (!ValidID(c.organizationId) || !ValidID(c.actorId)) throw new Error("invalid account");
}

export function CredentialHash(k: SignIn): string {
  return createHash("sha256")
    .update([k.apiUrl, k.token ?? "", k.organizationId ?? ""].join("\0"))
    .digest("hex");
}

export function Ready(c: Config, k: SignIn): void {
  ValidateConfig(c);
  if (!k.token) throw new Error("sign in to Kimchi to report");
  if (c.credentialHash !== CredentialHash(k)) throw new Error("Kimchi sign-in not verified yet");
}

function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
}

async function jsonBody(response: Response, limit: number, allowEmpty = false): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    if (allowEmpty) return {};
    throw new Error("empty response");
  }
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
  if (!size && allowEmpty) return {};
  return Parse(Buffer.concat(chunks).toString("utf8"));
}

// Kimchi's gatewayAuthHeaders: the bearer, plus the organization header for SSO.
function authorization(k: SignIn): Record<string, string> {
  return {
    Authorization: `Bearer ${k.token}`,
    ...(k.organizationId ? { "X-CastAi-Organization-Id": k.organizationId } : {}),
  };
}

/** Verify a sign-in the way Kimchi's uploader does (api-keys:verify) and return its account. */
export async function Authenticate(k: SignIn, signal?: AbortSignal): Promise<Config> {
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
    identity = (await jsonBody(verify, 1 << 20)) as typeof identity;
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

export async function Flush(
  s: Store,
  c: Config,
  k: SignIn,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!k.token) return false;
  Ready(c, k);
  const batch = s.PendingBatch(signal);
  if (!batch) return false;
  let response: Response;
  try {
    response = await request(
      `${BaseUrl(c.apiUrl!)}/ai-optimizer/v1beta/organizations/${encodeURIComponent(c.organizationId!)}/pr-cost-events:batchIngest`,
      {
        method: "POST",
        headers: { ...authorization(k), "Content-Type": "application/json" },
        body: `{"batch":${EncodeBatch(batch)}}`,
      },
      signal,
    );
  } catch {
    s.Diagnostic("upload_network_failed");
    throw new Error("reporting endpoint unavailable");
  }
  if (response.status === 413) {
    await response.body?.cancel().catch(() => {});
    s.Diagnostic("upload_payload_split");
    s.SplitBatch(batch);
    return true;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    s.Diagnostic(`upload_http_${response.status}`);
    throw new Error(`reporting returned HTTP ${response.status}; batch retained`);
  }
  let ack: Acknowledgement;
  try {
    ack = (await jsonBody(response, 1 << 20)) as Acknowledgement;
  } catch {
    throw new Error("invalid reporting acknowledgement");
  }
  s.Acknowledge(batch, ack);
  return true;
}

export async function FlushOTLP(s: Store, c: Config, signal?: AbortSignal): Promise<boolean> {
  if (!c.otlpUrl) return false;
  ValidateConfig(c);
  const target = Hash([c.otlpUrl, c.otlpHeaders ?? null]);
  const rows = s.DB.query(
    "SELECT id,body FROM events e WHERE NOT EXISTS(SELECT 1 FROM export_receipts r WHERE r.target=? AND r.event_id=e.id) ORDER BY e.created_at,e.rowid LIMIT 100",
  ).all(target) as { id: string; body: Uint8Array | string }[];
  if (!rows.length) return false;
  const records = rows.map(({ id, body }) => {
    const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
    const event = Parse(text) as Event;
    return {
      timeUnixNano: Temporal.Instant.from(event.observeTime).epochNanoseconds.toString(),
      body: { stringValue: text },
      attributes: [
        { key: "event.id", value: { stringValue: id } },
        { key: "event.entity_id", value: { stringValue: event.entityId } },
        { key: "event.revision", value: { intValue: String(event.revision) } },
      ],
    };
  });
  const payload = Stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "kimchi-bridge" } }],
        },
        scopeLogs: [{ scope: { name: "getkimchi.work", version: "1" }, logRecords: records }],
      },
    ],
  });
  let response: Response;
  try {
    response = await request(
      c.otlpUrl,
      {
        method: "POST",
        headers: { ...c.otlpHeaders, "Content-Type": "application/json" },
        body: payload,
      },
      signal,
    );
  } catch {
    throw new Error("OTLP endpoint unavailable; records retained");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`OTLP returned HTTP ${response.status}; records retained`);
  }
  let result: { partialSuccess?: { rejectedLogRecords?: unknown } };
  try {
    result = (await jsonBody(response, 64 << 10, true)) as typeof result;
  } catch {
    throw new Error("invalid OTLP response");
  }
  const rejected = result?.partialSuccess?.rejectedLogRecords;
  if (rejected !== undefined && String(rejected) !== "0")
    throw new Error("OTLP partially rejected records; batch retained");
  s.DB.transaction(() => {
    const insert = s.DB.query("INSERT OR IGNORE INTO export_receipts(target,event_id) VALUES(?,?)");
    for (const { id } of rows) insert.run(target, id);
  })();
  return true;
}
