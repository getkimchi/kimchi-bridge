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
class IdentityError extends Error {}

export interface Config {
  apiUrl?: string;
  organizationId?: string;
  apiKey?: string;
  /** Read existing installations without changing their account binding. New configure uses a Kimchi API key. */
  accessToken?: string;
  actorId?: string;
  credentialHash?: string;
  enabled?: boolean;
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
function baseUrl(value: string): string {
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

export function ValidateConfig(c: Config, allowMissingOrganization = false): void {
  secureEndpoint(c.apiUrl);
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
  if ((!allowMissingOrganization || c.organizationId) && !ValidID(c.organizationId))
    throw new Error("invalid organization");
  if (!c.apiKey && !c.accessToken) throw new Error("Kimchi API key required");
  if (c.apiKey && c.accessToken) throw new Error("provide one reporting credential");
  const key = c.apiKey || c.accessToken;
  if (typeof key !== "string" || hasControl(key)) throw new Error("invalid reporting credential");
}

export function CredentialHash(c: Config): string {
  return createHash("sha256")
    .update((c.accessToken ?? "") + "\0" + (c.apiKey ?? ""))
    .digest("hex");
}

export function Ready(c: Config): void {
  ValidateConfig(c);
  if (!ValidID(c.actorId) || c.credentialHash !== CredentialHash(c))
    throw new Error("run configure to verify this reporting user");
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

function bearer(c: Config): Record<string, string> {
  return { Authorization: `Bearer ${c.apiKey || c.accessToken}` };
}

export async function Authenticate(c: Config, signal?: AbortSignal): Promise<Config> {
  ValidateConfig(c, true);
  if (!c.apiKey || c.accessToken) throw new Error("configure requires a Kimchi API key");
  const apiUrl = baseUrl(c.apiUrl!);
  let identity: { organizationId?: unknown; userId?: unknown };
  let profile: { id?: unknown; username?: unknown };
  try {
    const verify = await request(
      `${apiUrl}/ai-optimizer/v1beta/api-keys:verify`,
      { method: "POST", headers: { ...bearer(c), Accept: "application/json" } },
      signal,
    );
    if (verify.status !== 200)
      throw new IdentityError(`reporting key verification returned HTTP ${verify.status}`);
    identity = (await jsonBody(verify, 1 << 20)) as typeof identity;
    if (!identity || !ValidID(identity.organizationId) || !ValidID(identity.userId))
      throw new IdentityError("invalid reporting account identity");
    if (
      c.organizationId &&
      c.organizationId.toLowerCase() !== identity.organizationId.toLowerCase()
    )
      throw new IdentityError("organization does not match Kimchi API key");
    const me = await request(
      `${apiUrl}/v1/me`,
      { headers: { ...bearer(c), Accept: "application/json" } },
      signal,
    );
    if (me.status !== 200) throw new IdentityError(`reporting identity returned HTTP ${me.status}`);
    profile = (await jsonBody(me, 1 << 20)) as typeof profile;
    if (
      !profile ||
      !ValidID(profile.id) ||
      typeof profile.username !== "string" ||
      !profile.username ||
      profile.id.toLowerCase() !== identity.userId.toLowerCase()
    )
      throw new IdentityError("reporting requires a verified Kimchi user");
  } catch (error) {
    // Native transport exceptions may contain request headers or response bodies.
    if (error instanceof IdentityError) throw error;
    throw new Error("reporting identity endpoint unavailable or invalid response");
  }
  return {
    ...c,
    apiUrl,
    organizationId: (identity.organizationId as string).toLowerCase(),
    actorId: (profile.id as string).toLowerCase(),
    credentialHash: CredentialHash(c),
  };
}

export async function Flush(s: Store, c: Config, signal?: AbortSignal): Promise<boolean> {
  if (!c.enabled) return false;
  Ready(c);
  const batch = s.PendingBatch(signal);
  if (!batch) return false;
  let response: Response;
  try {
    response = await request(
      `${baseUrl(c.apiUrl!)}/ai-optimizer/v1beta/organizations/${encodeURIComponent(c.organizationId!)}/pr-cost-events:batchIngest`,
      {
        method: "POST",
        headers: { ...bearer(c), "Content-Type": "application/json" },
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
          attributes: [{ key: "service.name", value: { stringValue: "kimchi-adapters" } }],
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
