import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  CanonicalTime,
  Hash,
  NumberText,
  Parse,
  StableID,
  Stringify,
  ZeroTime,
  obj,
  str,
  type Event,
  type RawUsage,
  type Usage,
} from "./protocol.ts";
import { CheckSignal } from "./platform.ts";
import type { Recorder, Scope } from "./capture.ts";

type Object = Record<string, any>;
interface Transcript {
  path: string;
  scope: Scope;
  route: string;
  basis: string;
}
const rowValue = (r: Recorder, key: string): string =>
  (r.Store.DB.query("SELECT value FROM meta WHERE key=?").get(key) as any)?.value ?? "";
const setValue = (r: Recorder, key: string, value: string) =>
  r.Store.DB.query(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
const textBody = (v: unknown) =>
  typeof v === "string" ? v : Buffer.from(v as Uint8Array).toString();
const wireInteger = (v: unknown) => {
  const text = NumberText(v);
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
const hasObject = (v: unknown): v is Object => !!v && typeof v === "object" && !Array.isArray(v);

export function version(r: Recorder, session: string, value: string) {
  if (!value || Buffer.byteLength(value) > 64 || ["\r", "\n", "\0"].some((c) => value.includes(c)))
    throw new Error("invalid source version");
  r.Store.DB.query(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
  ).run(`source-version:${r.Source}:${session}`, value);
}

export function transcriptVersion(r: Recorder, session: string, path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0),
      end = bytes.subarray(0, count).indexOf(10);
    if (end < 0 || end >= 4 * 1024 * 1024) return;
    const meta = Parse(bytes.subarray(0, end).toString());
    const v = str(obj(meta.payload), "cli_version");
    if (str(meta, "type") === "session_meta" && v) version(r, session, v);
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
  setValue(
    r,
    `transcript:${r.Source}:${path}`,
    Stringify({ path, scope: s, route: observedRoute || "unknown", basis: basis || "unknown" }),
  );
}

export function RecoverContext(r: Recorder, signal?: AbortSignal) {
  CheckSignal(signal);
  const items = r.Store.DB.query("SELECT value FROM meta WHERE key LIKE ?").all(
    `transcript:${r.Source}:%`,
  ) as { value: string }[];
  const failures: unknown[] = [];
  for (const item of items) {
    CheckSignal(signal);
    try {
      recoverFile(r, JSON.parse(item.value), signal);
    } catch (e) {
      r.Store.Diagnostic("transcript_recovery_failed");
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
      (r.Store.DB.query("SELECT offset FROM cursors WHERE path=?").get(t.path) as any)?.offset ?? 0,
    );
    if (info.size < offset) {
      r.Store.Diagnostic("transcript_truncated");
      throw new Error("transcript was truncated");
    }
    const context = rowValue(r, `cursor-context:${t.path}`);
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
      CheckSignal(signal);
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (!count) break;
      position += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0 && consumed < 32 * 1024 * 1024) {
        let failed = false,
          failure: unknown;
        // Commit recovered observations with their cursor, amortizing FULL fsync.
        r.Store.DB.transaction(() => {
          for (
            let records = 0;
            records < 100 && (end = pending.indexOf(10)) >= 0 && consumed < 32 * 1024 * 1024;
            records++
          ) {
            try {
              CheckSignal(signal);
              if (end + 1 > 4 * 1024 * 1024) throw new Error("transcript record exceeds bound");
              const line = pending.subarray(0, end + 1);
              consume(r, t, obj(Parse(line.toString())), offset);
              offset += line.length;
              consumed += line.length;
              pending = pending.subarray(end + 1);
            } catch (e) {
              failed = true;
              failure = e;
              break;
            }
          }
          r.Store.DB.query(
            "INSERT INTO cursors(path,offset) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset",
          ).run(t.path, offset);
          setValue(r, `cursor-context:${t.path}`, Stringify(t));
        }).immediate();
        if (failed) throw failure;
      }
      if (pending.length > 4 * 1024 * 1024) throw new Error("transcript record exceeds bound");
    }
  } finally {
    closeSync(fd);
  }
}

function timestamp(value: string): string {
  if (!value || value === ZeroTime) throw new Error("transcript timestamp missing");
  return CanonicalTime(value);
}

function consume(r: Recorder, t: Transcript, v: Object, _offset: number) {
  const s = { ...t.scope };
  if (r.Source === "codex" && str(v, "type") === "session_meta") {
    const value = str(obj(v.payload), "cli_version");
    if (value) version(r, s.Session, value);
    return;
  }
  if (r.Source === "claude-code" && !["user", "assistant"].includes(str(v, "type"))) return;
  if (
    r.Source === "codex" &&
    str(v, "type") !== "turn_context" &&
    !(str(v, "type") === "event_msg" && str(obj(v.payload), "type") === "token_count")
  )
    return;
  const observed = timestamp(str(v, "timestamp"));
  if (r.Source === "codex") {
    const p = obj(v.payload);
    if (str(v, "type") === "turn_context") {
      t.scope.Turn = str(p, "turn_id");
      setValue(r, `model:${t.path}`, str(p, "model"));
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
      raw: openAIUsage(info.last_token_usage),
      attemptsComplete: false,
      reportedModel: rowValue(r, `model:${t.path}`),
    };
    const e = r.event(s, `token-count:${Hash(info.total_token_usage)}`, r.workExact(s));
    e.observeTime = observed;
    e.usage = usage;
    if (!s.Turn) r.Store.Diagnostic("usage_turn_missing");
    r.Store.Observe(e);
    return;
  }
  if (str(v, "type") === "user") {
    const prompt = str(v, "promptId");
    if (prompt) t.scope.Turn = rowValue(r, `prompt-turn:${s.Session}:${prompt}`);
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
  if (Array.isArray(raw.iterations) && raw.iterations.length)
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
        id: str(it, "id") || StableID(response, Hash(i)),
        model: str(it, "model"),
        schema: u.schema,
        raw: claudeUsage(flat ? it : obj(it.usage)),
        stopReason: str(it, "stop_reason"),
        billingStatus: str(it, "billing_status"),
      };
    });
  let work = "";
  if (s.Agent) {
    work = r.work(s);
    if (work) u.correlation = "inherited_agent_work";
  }
  const turn = rowValue(r, `response-turn:${s.Session}:${response}`);
  if (turn) s.Turn = turn;
  if (s.Turn) {
    work = r.workExact(s);
    u.correlation = "native_transcript_prompt";
  }
  proxyAlias(u);
  const e = r.event(s, requestEntity(response, u.requestId || ""), work);
  e.observeTime = observed;
  e.usage = u;
  r.Store.Observe(e);
  if (Array.isArray(m.content))
    for (const part of m.content) {
      const block = obj(part);
      if (str(block, "type") === "tool_use") attachToolRequest(r, s, str(block, "id"), e.entityId);
    }
}

function attachToolRequest(r: Recorder, s: Scope, call: string, request: string) {
  if (!call) return;
  const key = `tool-request:${r.Source}:${s.Session}:${call}`;
  const previous = r.Store.DB.query("SELECT value FROM meta WHERE key=?").get(key) as any;
  if (previous && previous.value !== request) {
    request = "";
    r.Store.Diagnostic("tool_request_identity_conflict");
  }
  setValue(r, key, request);
  const entity = r.event(s, `tool:${call}`, "").entityId;
  const row = r.Store.DB.query(
    "SELECT body FROM events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1",
  ).get(entity) as any;
  if (!row) return;
  const event: Event = JSON.parse(textBody(row.body));
  if (event.tool) {
    event.tool.requestEntityId = request;
    r.Store.Observe(event);
  }
}

function writes(v: Object, fields: [string, number][]) {
  return fields.flatMap(([key, ttlSeconds]) => {
    const n = wireInteger(v[key]);
    return n === undefined ? [] : [{ ttlSeconds, tokens: n }];
  });
}
export function claudeUsage(v: Object): RawUsage {
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
export function openAIUsage(v: Object): RawUsage {
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
export function requestEntity(response: string, request: string): string {
  return request ? `request:${request}` : `response:${response}`;
}
export function proxyAlias(u: Usage) {
  if (u.observedRoute === "castai" && u.requestId?.length === 36)
    u.aliases = [{ namespace: "castai-request-id", id: u.requestId, source: u.channel }];
}
export function telemetry(r: Recorder, s: Scope, e: Object, observedRoute: string, basis: string) {
  const a = obj(e.attributes);
  if (str(e, "event") !== "api_request" && str(a, "event.name") !== "api_request") return;
  const request = str(a, "request_id");
  if (!request) {
    r.Store.Diagnostic("telemetry_request_identity_missing");
    return;
  }
  s = { ...s, Turn: "" };
  const prompt = str(a, "prompt.id");
  if (prompt) s.Turn = rowValue(r, `prompt-turn:${s.Session}:${prompt}`);
  const event = r.event(s, requestEntity("", request), s.Turn ? r.workExact(s) : r.work(s));
  const existing = r.Store.DB.query(
    "SELECT body FROM events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1",
  ).get(event.entityId) as any;
  if (existing && JSON.parse(textBody(existing.body)).usage?.channel === "transcript") return;
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
  r.Store.Observe(event);
}
