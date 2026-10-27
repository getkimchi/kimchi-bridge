import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  canonicalHash,
  canonicalTime,
  numberText,
  obj,
  parseJson,
  stableId,
  str,
  stringifyJson,
  zeroTime,
  type JsonObject,
  type RawUsage,
  type Usage,
} from "./protocol.ts";
import { checkSignal } from "../platform.ts";
import type { Recorder, Scope } from "./capture.ts";

interface Transcript {
  path: string;
  scope: Scope;
  route: string;
  basis: string;
}
const wireInteger = (v: unknown) => {
  const text = numberText(v);
  if (text === undefined) return;
  try {
    const n = BigInt(text);
    return n >= -(1n << 63n) && n < 1n << 63n && (n.toString() === text || text === "-0")
      ? n.toString()
      : undefined;
  } catch {
    return;
  }
};
const hasObject = (v: unknown): v is JsonObject =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function saveSourceVersion(r: Recorder, session: string, value: string) {
  if (!value || Buffer.byteLength(value) > 64 || ["\r", "\n", "\0"].some((c) => value.includes(c)))
    throw new Error("invalid source version");
  r.store.db
    .query(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
    )
    .run(`source-version:${r.source}:${session}`, value);
}

export function saveTranscriptVersion(r: Recorder, session: string, path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0),
      end = bytes.subarray(0, count).indexOf(10);
    if (end < 0 || end >= 4 * 1024 * 1024) return;
    const meta = parseJson(bytes.subarray(0, end).toString());
    const v = str(obj(meta.payload), "cli_version");
    if (str(meta, "type") === "session_meta" && v) saveSourceVersion(r, session, v);
  } catch {
    /* Native metadata is supplementary. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function registerTranscript(
  r: Recorder,
  s: Scope,
  path: string,
  observedRoute: string,
  basis: string,
) {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) throw new Error("invalid transcript path");
  r.store.setMeta(
    `transcript:${r.source}:${path}`,
    stringifyJson({ path, scope: s, route: observedRoute || "unknown", basis: basis || "unknown" }),
  );
}

export function recoverContext(r: Recorder, signal?: AbortSignal) {
  checkSignal(signal);
  const items = r.store.db
    .query("SELECT value FROM meta WHERE key LIKE ?")
    .all(`transcript:${r.source}:%`) as { value: string }[];
  const failures: unknown[] = [];
  for (const item of items) {
    checkSignal(signal);
    try {
      recoverFile(r, JSON.parse(item.value), signal);
    } catch (e) {
      r.store.diagnostic("transcript_recovery_failed");
      failures.push(e);
    }
  }
  if (failures.length) throw new AggregateError(failures, "transcript recovery incomplete");
}

function recoverFile(r: Recorder, t: Transcript, signal?: AbortSignal) {
  let fd: number;
  try {
    fd = openSync(t.path, "r");
  } catch (e: any) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("not a transcript file");
    let offset = Number(
      (r.store.db.query("SELECT offset FROM cursors WHERE path=?").get(t.path) as any)?.offset ?? 0,
    );
    if (info.size < offset) {
      r.store.diagnostic("transcript_truncated");
      throw new Error("transcript was truncated");
    }
    const context = r.store.meta(`cursor-context:${t.path}`);
    if (context) {
      try {
        t = JSON.parse(context);
      } catch {
        /* Keep registered context. */
      }
    }
    let consumed = 0,
      position = offset,
      pending = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    while (consumed < 32 * 1024 * 1024) {
      checkSignal(signal);
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (!count) break;
      position += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0 && consumed < 32 * 1024 * 1024) {
        let failed = false,
          failure: unknown;
        // Commit recovered observations with their cursor, amortizing FULL fsync.
        r.store.db
          .transaction(() => {
            for (
              let records = 0;
              records < 100 && (end = pending.indexOf(10)) >= 0 && consumed < 32 * 1024 * 1024;
              records++
            ) {
              try {
                checkSignal(signal);
                if (end + 1 > 4 * 1024 * 1024) throw new Error("transcript record exceeds bound");
                const line = pending.subarray(0, end + 1);
                consume(r, t, obj(parseJson(line.toString())));
                offset += line.length;
                consumed += line.length;
                pending = pending.subarray(end + 1);
              } catch (e) {
                failed = true;
                failure = e;
                break;
              }
            }
            r.store.db
              .query(
                "INSERT INTO cursors(path,offset) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset",
              )
              .run(t.path, offset);
            r.store.setMeta(`cursor-context:${t.path}`, stringifyJson(t));
          })
          .immediate();
        if (failed) throw failure;
      }
      if (pending.length > 4 * 1024 * 1024) throw new Error("transcript record exceeds bound");
    }
  } finally {
    closeSync(fd);
  }
}

function timestamp(value: string): string {
  if (!value || value === zeroTime) throw new Error("transcript timestamp missing");
  return canonicalTime(value);
}

function consume(r: Recorder, t: Transcript, v: JsonObject) {
  const s = { ...t.scope };
  if (r.source === "codex" && str(v, "type") === "session_meta") {
    const value = str(obj(v.payload), "cli_version");
    if (value) saveSourceVersion(r, s.Session, value);
    return;
  }
  if (r.source === "claude-code" && !["user", "assistant"].includes(str(v, "type"))) return;
  if (
    r.source === "codex" &&
    str(v, "type") !== "turn_context" &&
    !(
      str(v, "type") === "event_msg" &&
      ["token_count", "thread_settings_applied"].includes(str(obj(v.payload), "type"))
    )
  )
    return;
  const observed = timestamp(str(v, "timestamp"));
  if (r.source === "codex") {
    const p = obj(v.payload);
    if (str(v, "type") === "turn_context") {
      t.scope.Turn = str(p, "turn_id");
      r.store.setMeta(`model:${t.path}`, str(p, "model"));
      return;
    }
    // The backend prices only a known tier. Codex's thread settings name the tier it asks
    // for, such as "priority" for Fast; without one, OpenAI serves its "default" tier.
    if (str(p, "type") === "thread_settings_applied") {
      r.store.setMeta(`tier:${t.path}`, str(obj(p.thread_settings), "service_tier") || "default");
      return;
    }
    const info = obj(p.info);
    if (!hasObject(info.last_token_usage) || !hasObject(info.total_token_usage)) return;
    const usage: Usage = {
      channel: "transcript",
      schema: "openai-responses-v1",
      counterScope: "request",
      observedRoute: t.route,
      billingBasis: t.basis,
      correlation: s.Turn ? "native_transcript_turn" : "session_only",
      provider: "openai",
      serviceTier: r.store.meta(`tier:${t.path}`),
      raw: openAiUsage(info.last_token_usage),
      attemptsComplete: false,
      reportedModel: r.store.meta(`model:${t.path}`),
    };
    const e = r.event(s, `token-count:${canonicalHash(info.total_token_usage)}`, r.workExact(s));
    e.observeTime = observed;
    e.usage = usage;
    if (!s.Turn) r.store.diagnostic("usage_turn_missing");
    r.store.observe(e);
    return;
  }
  if (str(v, "type") === "user") {
    const prompt = str(v, "promptId");
    if (prompt) t.scope.Turn = r.store.meta(`prompt-turn:${s.Session}:${prompt}`);
    return;
  }
  const m = obj(v.message),
    raw = obj(m.usage),
    response = str(m, "id");
  if (!hasObject(m.usage) || !response) return;
  const u: Usage = {
    channel: "transcript",
    responseId: response,
    requestId: str(v, "requestId"),
    schema: "anthropic-messages-v1",
    counterScope: "request",
    observedRoute: t.route,
    billingBasis: t.basis,
    correlation: "session_only",
    provider: "anthropic",
    reportedModel: str(m, "model"),
    actualModel: str(m, "model"),
    serviceTier: str(raw, "service_tier"),
    region: str(raw, "inference_geo"),
    raw: claudeUsage(raw),
    stopReason: str(m, "stop_reason"),
    attemptsComplete: false,
  };
  if (Array.isArray(raw.iterations) && raw.iterations.length) {
    // A lone "message" iteration is the reply itself, so it ran on the reply's model; Anthropic
    // names a model only when iterations can differ, as with a fallback. Unknown models stay unpriced.
    const sole = raw.iterations.length === 1;
    u.iterations = raw.iterations.map((item: unknown, i: number) => {
      const it = obj(item);
      const flat = [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "cache_creation",
      ].some((key) => Object.hasOwn(it, key));
      return {
        id: str(it, "id") || stableId(response, canonicalHash(i)),
        model: str(it, "model") || (sole && str(it, "type") === "message" ? str(m, "model") : ""),
        schema: u.schema,
        raw: claudeUsage(flat ? it : obj(it.usage)),
        stopReason: str(it, "stop_reason"),
        billingStatus: str(it, "billing_status"),
      };
    });
  }
  let work = "";
  if (s.Agent) {
    work = r.work(s);
    if (work) u.correlation = "inherited_agent_work";
  }
  const turn = r.store.meta(`response-turn:${s.Session}:${response}`);
  if (turn) s.Turn = turn;
  if (s.Turn) {
    work = r.workExact(s);
    u.correlation = "native_transcript_prompt";
  }
  proxyAlias(u);
  const e = r.event(s, requestEntity(response, u.requestId || ""), work);
  e.observeTime = observed;
  e.usage = u;
  r.store.observe(e);
  if (Array.isArray(m.content))
    for (const part of m.content) {
      const block = obj(part);
      if (str(block, "type") === "tool_use") attachToolRequest(r, s, str(block, "id"), e.entityId);
    }
}

function attachToolRequest(r: Recorder, s: Scope, call: string, request: string) {
  if (!call) return;
  const key = `tool-request:${r.source}:${s.Session}:${call}`;
  const previous = r.store.db.query("SELECT value FROM meta WHERE key=?").get(key) as any;
  if (previous && previous.value !== request) {
    request = "";
    r.store.diagnostic("tool_request_identity_conflict");
  }
  r.store.setMeta(key, request);
  const event = r.store.latest(r.event(s, `tool:${call}`, "").entityId);
  if (event?.tool) {
    event.tool.requestEntityId = request;
    r.store.observe(event);
  }
}

function writes(v: JsonObject, fields: [string, number][]) {
  return fields.flatMap(([key, ttlSeconds]) => {
    const n = wireInteger(v[key]);
    return n === undefined ? [] : [{ ttlSeconds, tokens: n }];
  });
}
export function claudeUsage(v: JsonObject): RawUsage {
  const cacheWrites = writes(obj(v.cache_creation), [
    ["ephemeral_5m_input_tokens", 300],
    ["ephemeral_1h_input_tokens", 3600],
  ]);
  return {
    inputTokens: wireInteger(v.input_tokens),
    outputTokens: wireInteger(v.output_tokens),
    cacheReadTokens: wireInteger(v.cache_read_input_tokens),
    cacheWriteTokens: wireInteger(v.cache_creation_input_tokens),
    ...(cacheWrites.length ? { cacheWrites } : {}),
  };
}
export function openAiUsage(v: JsonObject): RawUsage {
  const cacheWrites = writes(obj(v.cache_write_tokens_details), [
    ["ttl_30m_tokens", 1800],
    ["ttl_12h_tokens", 43200],
  ]);
  return {
    inputTokens: wireInteger(v.input_tokens),
    outputTokens: wireInteger(v.output_tokens),
    cacheReadTokens: wireInteger(v.cached_input_tokens),
    cacheWriteTokens: wireInteger(v.cache_write_input_tokens),
    reasoningTokens: wireInteger(v.reasoning_output_tokens),
    ...(cacheWrites.length ? { cacheWrites } : {}),
  };
}
export function route(source: string): string {
  if (source !== "claude-code") return "unknown";
  if (
    ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
      (k) => process.env[k] === "1",
    )
  )
    return "cloud-provider";
  if (!process.env.ANTHROPIC_BASE_URL) return "provider-api";
  let host: string;
  try {
    host = new URL(process.env.ANTHROPIC_BASE_URL).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host === "api.anthropic.com") return "provider-api";
  if (["cast.ai", "kimchi.dev"].some((d) => host === d || host.endsWith(`.${d}`))) return "castai";
  return host ? "customer-gateway" : "unknown";
}
function requestEntity(response: string, request: string): string {
  return request ? `request:${request}` : `response:${response}`;
}
function proxyAlias(u: Usage) {
  if (u.observedRoute === "castai" && u.requestId?.length === 36)
    u.aliases = [{ namespace: "castai-request-id", id: u.requestId, source: u.channel }];
}
export function telemetry(
  r: Recorder,
  s: Scope,
  e: JsonObject,
  observedRoute: string,
  basis: string,
) {
  const a = obj(e.attributes);
  if (str(e, "event") !== "api_request" && str(a, "event.name") !== "api_request") return;
  const request = str(a, "request_id");
  if (!request) {
    r.store.diagnostic("telemetry_request_identity_missing");
    return;
  }
  s = { ...s, Turn: "" };
  const prompt = str(a, "prompt.id");
  if (prompt) s.Turn = r.store.meta(`prompt-turn:${s.Session}:${prompt}`);
  const event = r.event(s, requestEntity("", request), s.Turn ? r.workExact(s) : r.work(s));
  if (r.store.latest(event.entityId)?.usage?.channel === "transcript") return;
  event.observeTime = timestamp(str(a, "event.timestamp"));
  const cacheWrites = writes(a, [
    ["cache_creation_5m_tokens", 300],
    ["cache_creation_1h_tokens", 3600],
  ]);
  const u: Usage = {
    channel: "telemetry",
    requestId: request,
    schema: "anthropic-messages-v1",
    counterScope: "request",
    observedRoute,
    billingBasis: basis,
    reportedModel: str(a, "model"),
    provider: "anthropic",
    correlation: s.Turn ? "native_prompt_id" : "session_only",
    attemptsComplete: false,
    raw: {
      inputTokens: wireInteger(a.input_tokens),
      outputTokens: wireInteger(a.output_tokens),
      cacheReadTokens: wireInteger(a.cache_read_tokens),
      cacheWriteTokens: wireInteger(a.cache_creation_tokens),
      ...(cacheWrites.length ? { cacheWrites } : {}),
    },
    durationMs: wireInteger(a.duration_ms),
  };
  proxyAlias(u);
  event.usage = u;
  r.store.observe(event);
}
