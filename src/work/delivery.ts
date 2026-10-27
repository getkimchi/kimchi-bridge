import {
  authorization,
  baseUrl,
  credentialHash,
  readBody,
  request,
  type SignIn,
} from "../kimchi.ts";
import { validateConfig, type Config } from "../settings.ts";
import { bodyText, type Store } from "./ledger.ts";
import {
  canonicalHash,
  encodeBatch,
  parseJson,
  stringifyJson,
  type Acknowledgement,
  type Event,
} from "./protocol.ts";

declare const Temporal: { Instant: { from(value: string): { epochNanoseconds: bigint } } };

export function checkReady(c: Config, k: SignIn): void {
  validateConfig(c);
  if (!k.token) throw new Error("sign in to Kimchi to report");
  if (c.credentialHash !== credentialHash(k)) throw new Error("Kimchi sign-in not verified yet");
}

export async function flush(
  s: Store,
  c: Config,
  k: SignIn,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!k.token) return false;
  checkReady(c, k);
  const batch = s.pendingBatch(signal);
  if (!batch) return false;
  let response: Response;
  try {
    response = await request(
      `${baseUrl(c.apiUrl!)}/ai-optimizer/v1beta/organizations/${encodeURIComponent(c.organizationId!)}/pr-cost-events:batchIngest`,
      {
        method: "POST",
        headers: { ...authorization(k), "Content-Type": "application/json" },
        body: `{"batch":${encodeBatch(batch)}}`,
      },
      signal,
    );
  } catch {
    s.diagnostic("upload_network_failed");
    throw new Error("reporting endpoint unavailable");
  }
  if (response.status === 413) {
    await response.body?.cancel().catch(() => {});
    s.diagnostic("upload_payload_split");
    s.splitBatch(batch);
    return true;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    s.diagnostic(`upload_http_${response.status}`);
    throw new Error(`reporting returned HTTP ${response.status}; batch retained`);
  }
  let ack: Acknowledgement;
  try {
    ack = parseJson(await readBody(response, 1 << 20)) as Acknowledgement;
  } catch {
    throw new Error("invalid reporting acknowledgement");
  }
  s.acknowledge(batch, ack);
  return true;
}

export async function flushOtlp(s: Store, c: Config, signal?: AbortSignal): Promise<boolean> {
  if (!c.otlpUrl) return false;
  validateConfig(c);
  const target = canonicalHash([c.otlpUrl, c.otlpHeaders ?? null]);
  const rows = s.db
    .query(
      "SELECT id,body FROM events e WHERE NOT EXISTS(SELECT 1 FROM export_receipts r WHERE r.target=? AND r.event_id=e.id) ORDER BY e.created_at,e.rowid LIMIT 100",
    )
    .all(target) as { id: string; body: Uint8Array | string }[];
  if (!rows.length) return false;
  const records = rows.map(({ id, body }) => {
    const text = bodyText(body);
    const event = parseJson(text) as Event;
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
  const payload = stringifyJson({
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
    const body = await readBody(response, 64 << 10);
    result = body ? parseJson(body) : {};
  } catch {
    throw new Error("invalid OTLP response");
  }
  const rejected = result?.partialSuccess?.rejectedLogRecords;
  if (rejected !== undefined && String(rejected) !== "0")
    throw new Error("OTLP partially rejected records; batch retained");
  s.db.transaction(() => {
    const insert = s.db.query("INSERT OR IGNORE INTO export_receipts(target,event_id) VALUES(?,?)");
    for (const { id } of rows) insert.run(target, id);
  })();
  return true;
}
