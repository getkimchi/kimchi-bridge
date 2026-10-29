import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./settings.ts";

// Kimchi's billing tag (work-attribution/request-tags.ts): the gateway stores each request's tags with its bill, and
// the backend finds a request's bill by `kimchi-request:<request ID>`. The proxy tags Claude Code and Codex requests
// the same way, so their calls are priced from their own bills.

/** The gateway's limit on combined body and header tags, counted before deduplication. */
const GATEWAY_TAG_LIMIT = 10;
const BILLING_TAG = "kimchi-request";
/** Response IDs are kept long enough for transcripts recovered after a restart; tags older than this never price. */
const KEEP_SECONDS = 14 * 24 * 3600;

/**
 * The X-Tags value carrying the request's billing tag, or undefined when the request goes untagged. As in Kimchi, a
 * body that is not a JSON object, a billing tag already present, or reaching the gateway's tag limit skips the tag:
 * the gateway fails a request with an invalid tag set.
 */
export function billingTags(
  headers: Headers,
  body: unknown,
  requestId: string,
): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const bodyTags = (body as { tags?: unknown }).tags;
  if (bodyTags !== undefined && !Array.isArray(bodyTags)) return undefined;
  const header = headers.get("X-Tags") ?? "";
  const tags = [
    ...header.split(","),
    ...(headers.get("X-LiteLLM-Tags") ?? "").split(","),
    ...(bodyTags ?? []).map(String),
  ]
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.some((tag) => tag.split(":", 1)[0] === BILLING_TAG) || tags.length >= GATEWAY_TAG_LIMIT)
    return undefined;
  return [...header.split(",").filter((tag) => tag.trim()), `${BILLING_TAG}:${requestId}`].join(
    ",",
  );
}

/**
 * The response's ID from the start of its body: Anthropic's message_start event, the Responses API's response.created
 * event, a Chat Completions chunk, or a JSON reply's top-level id.
 */
export function responseId(text: string): string | undefined {
  if (text.trimStart().startsWith("{")) {
    try {
      return nonEmpty((JSON.parse(text) as { id?: unknown }).id);
    } catch {
      return undefined;
    }
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: { id?: unknown; message?: { id?: unknown }; response?: { id?: unknown } };
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    const id = nonEmpty(event?.message?.id) ?? nonEmpty(event?.response?.id) ?? nonEmpty(event?.id);
    if (id) return id;
  }
  return undefined;
}

const nonEmpty = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/**
 * Reads one branch of a teed response until its ID appears, then releases it. Stops after `limit` characters: an ID
 * comes first in every supported reply, and an unread branch would buffer the whole stream.
 */
export async function readResponseId(
  body: ReadableStream<Uint8Array>,
  limit = 1 << 20,
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return responseId(text);
      text += decoder.decode(value, { stream: true });
      // A JSON reply parses only once complete; a stream names its ID in its first event.
      const id = text.trimStart().startsWith("{") ? undefined : responseId(text);
      if (id) return id;
      if (text.length > limit) return undefined;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

let database: Database | undefined;
let databasePath = "";

function tags(root = stateRoot()): Database {
  const path = join(root, "gateway-request-tags.sqlite");
  if (database && databasePath === path) return database;
  database?.close();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  database = new Database(path, { create: true });
  databasePath = path;
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA busy_timeout=2000");
  database.exec(
    "CREATE TABLE IF NOT EXISTS tags(response_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  return database;
}

/** Remembers which billing tag a response's request carried; the proxy writes it, transcript readers look it up. */
export function recordTag(responseId: string, requestId: string, now = Date.now()): void {
  const db = tags();
  const seconds = Math.floor(now / 1000);
  db.query("INSERT OR REPLACE INTO tags(response_id, request_id, created_at) VALUES(?, ?, ?)").run(
    responseId,
    requestId,
    seconds,
  );
  db.query("DELETE FROM tags WHERE created_at < ?").run(seconds - KEEP_SECONDS);
}

/** The billing tag's request ID for a response, when the proxy tagged its request. */
export function tagFor(responseId: string): string | undefined {
  // Only the proxy creates the store; a machine that never routed through it has no tags.
  if (!responseId || !existsSync(join(stateRoot(), "gateway-request-tags.sqlite")))
    return undefined;
  try {
    const row = tags()
      .query("SELECT request_id FROM tags WHERE response_id = ?")
      .get(responseId) as { request_id: string } | null;
    return row?.request_id;
  } catch {
    // A missing or locked store leaves the call unpriced, as it was before tagging.
    return undefined;
  }
}
