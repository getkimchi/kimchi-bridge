import { createHash } from "node:crypto";
declare const Temporal: {
  Instant: {
    from(value: string): {
      readonly epochNanoseconds: bigint;
      toString(): string;
      toZonedDateTimeISO(offset: string): {
        toString(options: { timeZoneName: "never"; calendarName: "never" }): string;
      };
    };
  };
};

export const protocolVersion = 1;
export const zeroTime = "0001-01-01T00:00:00Z";
export type JsonObject = Record<string, any>;
export const obj = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
export function str(value: JsonObject | undefined, ...keys: string[]): string {
  for (const key of keys) if (typeof value?.[key] === "string" && value[key]) return value[key];
  return "";
}
export interface Repository {
  provider: string;
  host: string;
  id: string;
  name?: string;
}
export interface RawUsage {
  inputTokens?: string;
  outputTokens?: string;
  cacheReadTokens?: string;
  cacheWriteTokens?: string;
  cacheWrites?: CacheWrite[];
  reasoningTokens?: string;
}
export interface CacheWrite {
  ttlSeconds: number;
  tokens: string;
}
export interface IssueKey {
  key: string;
  source: string;
  revision?: string;
}
export interface RequestAlias {
  namespace: string;
  id: string;
  source: string;
}
export interface Credit {
  amount: string;
  unit: string;
  basis: string;
}
export interface Iteration {
  id: string;
  model?: string;
  schema: string;
  raw: RawUsage;
  stopReason?: string;
  billingStatus?: string;
}
export interface Usage {
  channel: string;
  requestId?: string;
  responseId?: string;
  schema: string;
  counterScope: string;
  observedRoute: string;
  reportedModel?: string;
  actualModel?: string;
  provider?: string;
  serviceTier?: string;
  region?: string;
  billingBasis: string;
  correlation: string;
  raw: RawUsage;
  iterations?: Iteration[];
  finalIterationId?: string;
  attemptsComplete: boolean;
  stopReason?: string;
  billingStatus?: string;
  durationMs?: string;
  credits?: Credit[];
  aliases?: RequestAlias[];
}
export interface Work {
  title?: string;
  planId?: string;
  planRevision?: string;
  reason: string;
  quality: string;
  issueKeys?: IssueKey[];
}
export interface Tool {
  callId: string;
  name?: string;
  requestEntityId?: string;
  category: string;
  outcome: string;
  durationMs?: string;
}
export interface File {
  fileId: string;
  toolCallId?: string;
  beforeRevision?: string;
  afterRevision?: string;
  operation: string;
  quality: string;
}
export interface Commit {
  id: string;
  parents?: string[];
  quality: string;
}
export interface PullRequest {
  id: string;
  number: number;
  uri: string;
  state: string;
  createTime?: string;
  closeTime?: string;
  mergeTime?: string;
  mergeCommitId?: string;
  title?: string;
  issueKeys?: IssueKey[];
  author?: string;
}
export interface Link {
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  quality: string;
  reason: string;
}
export interface Coverage {
  code: string;
  count: string;
  windowStartTime?: string;
  windowEndTime?: string;
  observedUsage?: RawUsage;
  model?: string;
}
/** Where a Kimchi request's cost goes, as its producer decided it. Only the kimchi source sends one. */
export interface Allocation {
  kind: string;
  pullRequestIds?: string[];
  method: string;
  targetRepository?: Repository;
}
/** The receipt of an explicit correction: it supersedes earlier allocations whatever order they arrive in. */
export interface Correction {
  id: string;
  revision: number;
  recordedAt: string;
  source: string;
}
export interface Event {
  id?: string;
  entityId: string;
  revision?: string;
  baseRevision?: string;
  baseEventId?: string;
  source: string;
  sourceVersion: string;
  deviceId: string;
  observeTime: string;
  repository?: Repository;
  workId?: string;
  sessionId?: string;
  turnId?: string;
  agentId?: string;
  work?: Work;
  usage?: Usage;
  tool?: Tool;
  file?: File;
  commit?: Commit;
  pullRequest?: PullRequest;
  link?: Link;
  coverage?: Coverage;
  allocation?: Allocation;
  claimState?: string;
  correction?: Correction;
  startedAt?: string;
}
export interface Batch {
  version: number;
  id: string;
  events: Event[];
}
/** An event as it is uploaded: its ID and revision are assigned. */
export type IngestEvent = Event & { id: string; revision: string };
export interface IngestBatch extends Batch {
  events: IngestEvent[];
}
export interface Receipt {
  id: string;
  status: string;
  revision: string;
}
export interface Acknowledgement {
  batchId: string;
  receiveTime?: string;
  generation?: string;
  receipts: Receipt[];
}

// JSON.parse's source argument prevents rounding provider IDs and changing native
// numeric lexemes used in Go's map hashes (for example 1e3 versus 1000).
class NativeNumber {
  constructor(public readonly lexeme: string) {}
  toString(): string {
    return this.lexeme;
  }
  valueOf(): number {
    return Number(this.lexeme);
  }
}
export function parseJson(text: string): any {
  return JSON.parse(text, ((_: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" ? new NativeNumber(context?.source ?? String(value)) : value) as any);
}
export function numberText(value: unknown): string | undefined {
  if (value instanceof NativeNumber) return value.lexeme;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
export function integer(value: unknown): number | undefined {
  if (value instanceof NativeNumber) {
    let n: bigint;
    try {
      n = BigInt(value.lexeme);
    } catch {
      return;
    }
    if (n.toString() !== value.lexeme && value.lexeme !== "-0") return;
    if (n < -(1n << 63n) || n >= 1n << 63n) return;
    return Number(n);
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -(2 ** 63) &&
    value < 2 ** 63
  )
    return value;
}

type Field = readonly [name: string, type: string, omit?: "empty" | "nil"];
const schemas: Record<string, readonly Field[]> = {
  repository: [
    ["provider", "s"],
    ["host", "s"],
    ["id", "s"],
    ["name", "s", "empty"],
  ],
  issue: [
    ["key", "s"],
    ["source", "s"],
    ["revision", "q", "empty"],
  ],
  work: [
    ["title", "s", "empty"],
    ["planId", "s", "empty"],
    ["planRevision", "s", "empty"],
    ["reason", "s"],
    ["quality", "s"],
    ["issueKeys", "[]issue", "empty"],
  ],
  raw: [
    ["inputTokens", "q", "nil"],
    ["outputTokens", "q", "nil"],
    ["cacheReadTokens", "q", "nil"],
    ["cacheWriteTokens", "q", "nil"],
    ["cacheWrites", "[]cacheWrite", "empty"],
    ["reasoningTokens", "q", "nil"],
  ],
  cacheWrite: [
    ["ttlSeconds", "i32"],
    ["tokens", "q"],
  ],
  iteration: [
    ["id", "s"],
    ["model", "s", "empty"],
    ["schema", "s"],
    ["raw", "raw"],
    ["stopReason", "s", "empty"],
    ["billingStatus", "s", "empty"],
  ],
  credit: [
    ["amount", "s"],
    ["unit", "s"],
    ["basis", "s"],
  ],
  alias: [
    ["namespace", "s"],
    ["id", "s"],
    ["source", "s"],
  ],
  usage: [
    ["channel", "s"],
    ["requestId", "s", "empty"],
    ["responseId", "s", "empty"],
    ["schema", "s"],
    ["counterScope", "s"],
    ["observedRoute", "s"],
    ["reportedModel", "s", "empty"],
    ["actualModel", "s", "empty"],
    ["provider", "s", "empty"],
    ["serviceTier", "s", "empty"],
    ["region", "s", "empty"],
    ["billingBasis", "s"],
    ["correlation", "s"],
    ["raw", "raw"],
    ["iterations", "[]iteration", "empty"],
    ["finalIterationId", "s", "empty"],
    ["attemptsComplete", "b"],
    ["stopReason", "s", "empty"],
    ["billingStatus", "s", "empty"],
    ["durationMs", "q", "nil"],
    ["credits", "[]credit", "empty"],
    ["aliases", "[]alias", "empty"],
  ],
  tool: [
    ["callId", "s"],
    ["name", "s", "empty"],
    ["requestEntityId", "s", "empty"],
    ["category", "s"],
    ["outcome", "s"],
    ["durationMs", "q", "empty"],
  ],
  file: [
    ["fileId", "s"],
    ["toolCallId", "s", "empty"],
    ["beforeRevision", "s", "empty"],
    ["afterRevision", "s", "empty"],
    ["operation", "s"],
    ["quality", "s"],
  ],
  commit: [
    ["id", "s"],
    ["parents", "[]s", "empty"],
    ["quality", "s"],
  ],
  pullRequest: [
    ["id", "s"],
    ["number", "i32"],
    ["uri", "s"],
    ["state", "s"],
    ["createTime", "t", "nil"],
    ["closeTime", "t", "nil"],
    ["mergeTime", "t", "nil"],
    ["mergeCommitId", "s", "empty"],
    ["title", "s", "empty"],
    ["issueKeys", "[]issue", "empty"],
    ["author", "s", "empty"],
  ],
  link: [
    ["fromKind", "s"],
    ["fromId", "s"],
    ["toKind", "s"],
    ["toId", "s"],
    ["quality", "s"],
    ["reason", "s"],
  ],
  coverage: [
    ["code", "s"],
    ["count", "q"],
    ["windowStartTime", "t", "nil"],
    ["windowEndTime", "t", "nil"],
    ["observedUsage", "raw", "nil"],
    ["model", "s", "empty"],
  ],
  allocation: [
    ["kind", "s"],
    ["pullRequestIds", "[]s", "empty"],
    ["method", "s"],
    ["targetRepository", "repository", "nil"],
  ],
  correction: [
    ["id", "s"],
    ["revision", "i32"],
    ["recordedAt", "t"],
    ["source", "s"],
  ],
  event: [
    ["id", "s"],
    ["entityId", "s"],
    ["revision", "q"],
    ["baseRevision", "q", "empty"],
    ["baseEventId", "s", "empty"],
    ["source", "s"],
    ["sourceVersion", "s"],
    ["deviceId", "s"],
    ["observeTime", "t"],
    ["repository", "repository", "nil"],
    ["workId", "s", "empty"],
    ["sessionId", "s", "empty"],
    ["turnId", "s", "empty"],
    ["agentId", "s", "empty"],
    ["work", "work", "nil"],
    ["usage", "usage", "nil"],
    ["tool", "tool", "nil"],
    ["file", "file", "nil"],
    ["commit", "commit", "nil"],
    ["pullRequest", "pullRequest", "nil"],
    ["link", "link", "nil"],
    ["coverage", "coverage", "nil"],
    ["allocation", "allocation", "nil"],
    ["claimState", "s", "empty"],
    ["correction", "correction", "nil"],
    ["startedAt", "t", "nil"],
  ],
  batch: [
    ["version", "n"],
    ["id", "s"],
    ["events", "[]event"],
  ],
};
class Ordered {
  constructor(readonly fields: [string, unknown][]) {}
}
const timestampCache = new Map<string, string>();
export function canonicalTime(value: unknown): string {
  const s = value instanceof Date ? value.toISOString() : String(value ?? zeroTime);
  const cached = timestampCache.get(s);
  if (cached !== undefined) return cached;
  const instant = Temporal.Instant.from(s);
  const offset = s.endsWith("Z") ? "Z" : s.slice(-6);
  const result =
    offset === "Z" || offset === "+00:00" || offset === "-00:00"
      ? instant.toString()
      : instant
          .toZonedDateTimeISO(offset)
          .toString({ timeZoneName: "never", calendarName: "never" });
  // A year outside 0001-9999 has no four-digit form on the wire.
  if (result[4] !== "-") throw new TypeError("Invalid wire year");
  if (timestampCache.size >= 128) timestampCache.clear();
  timestampCache.set(s, result);
  return result;
}
export function timeNanos(value: string): bigint {
  return Temporal.Instant.from(value).epochNanoseconds;
}
/**
 * Protobuf carries timestamps in UTC; normalizing first keeps an event's local hash and ID
 * independent of its offset.
 */
export function normalizeIngestTimes<T extends Event>(event: T): T {
  const utc = (value: string): string => {
    const text = Temporal.Instant.from(value).toString();
    if (text[4] !== "-" || text.startsWith("0000-"))
      throw new TypeError("Invalid protobuf timestamp year");
    return text;
  };
  const normalized = { ...event, observeTime: utc(event.observeTime) };
  if (event.startedAt != null) normalized.startedAt = utc(event.startedAt);
  if (event.correction)
    normalized.correction = { ...event.correction, recordedAt: utc(event.correction.recordedAt) };
  if (event.coverage) {
    normalized.coverage = { ...event.coverage };
    if (event.coverage.windowStartTime != null)
      normalized.coverage.windowStartTime = utc(event.coverage.windowStartTime);
    if (event.coverage.windowEndTime != null)
      normalized.coverage.windowEndTime = utc(event.coverage.windowEndTime);
  }
  if (event.pullRequest) {
    normalized.pullRequest = { ...event.pullRequest };
    if (event.pullRequest.createTime != null)
      normalized.pullRequest.createTime = utc(event.pullRequest.createTime);
    if (event.pullRequest.closeTime != null)
      normalized.pullRequest.closeTime = utc(event.pullRequest.closeTime);
    if (event.pullRequest.mergeTime != null)
      normalized.pullRequest.mergeTime = utc(event.pullRequest.mergeTime);
  }
  return normalized;
}
// A field of the wrong type is a caller's mistake, never a value to coerce: the frozen bytes of an
// event are its identity, and the backend refuses what protobuf cannot carry.
function wire(message: string): never {
  throw new TypeError(message);
}
function shape(name: string, value: any): Ordered {
  if (value != null && (typeof value !== "object" || Array.isArray(value)))
    wire("Invalid wire object");
  const fields: [string, unknown][] = [];
  for (const [key, type, omit] of schemas[name]!) {
    const input = value?.[key];
    if (omit && input == null) continue;
    const converted = convert(type, input);
    if (
      omit === "empty" &&
      (converted === "" ||
        converted === false ||
        converted === 0 ||
        (type === "q" && converted === "0") ||
        (Array.isArray(converted) && !converted.length))
    )
      continue;
    fields.push([key, converted]);
  }
  return new Ordered(fields);
}
function convert(type: string, value: any): any {
  if (type.startsWith("[]")) {
    if (value == null) return null;
    if (!Array.isArray(value)) wire("Invalid wire array");
    return value.map((v: any) => convert(type.slice(2), v));
  }
  if (type === "s") {
    if (value == null) return "";
    if (typeof value !== "string") wire("Invalid wire string");
    return value;
  }
  if (type === "q") {
    if (value == null) return "0";
    const n = typeof value === "string" ? dec(value) : undefined;
    if (n === undefined) wire("Invalid wire int64");
    return n.toString();
  }
  if (type === "n" || type === "i32") {
    if (value == null) return 0;
    // A parsed event keeps its numbers' lexemes (parseJson); they are written back unchanged.
    const n =
      value instanceof NativeNumber
        ? integer(value)
        : typeof value === "number" && Number.isSafeInteger(value)
          ? value
          : undefined;
    if (n === undefined) wire("Invalid wire integer");
    if (type === "i32" && (n < -2147483648 || n > 2147483647)) wire("Invalid wire int32");
    return value;
  }
  if (type === "b") {
    if (value == null) return false;
    if (typeof value !== "boolean") wire("Invalid wire boolean");
    return value;
  }
  if (type === "t") {
    if (value != null && typeof value !== "string" && !(value instanceof Date))
      wire("Invalid wire time");
    return canonicalTime(value);
  }
  return shape(type, value);
}
function quoted(value: string): string {
  // A UTF-8 round trip replaces lone surrogates with U+FFFD, as Go does. It is what
  // String.prototype.toWellFormed does, without asking importers for an ES2024 library.
  return JSON.stringify(Buffer.from(value).toString("utf8"))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
export function stringifyJson(value: any): string {
  if (value instanceof NativeNumber) return value.lexeme;
  if (value instanceof Ordered)
    return "{" + value.fields.map(([k, v]) => quoted(k) + ":" + stringifyJson(v)).join(",") + "}";
  if (value == null) return "null";
  if (typeof value === "string") return quoted(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return quoted(canonicalTime(value));
  if (Array.isArray(value)) return "[" + value.map(stringifyJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .filter((k) => value[k] !== undefined)
      .map((k) => quoted(k) + ":" + stringifyJson(value[k]))
      .join(",") +
    "}"
  );
}
export function encodeEvent(value: Event): string {
  return stringifyJson(shape("event", value));
}
export function encodeBatch(value: Batch): string {
  return stringifyJson(shape("batch", value));
}
export const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export function canonicalHash(value: any): string {
  const body =
    value && typeof value === "object" && !Array.isArray(value) && "entityId" in value
      ? encodeEvent(value)
      : value && typeof value === "object" && "version" in value && "events" in value
        ? encodeBatch(value)
        : stringifyJson(value);
  return digest(body);
}
/** An event's local hash: the digest of its wire bytes. */
export const eventHash = (event: Event): string => digest(encodeEvent(event));
export function stableId(...parts: string[]): string {
  const h = digest(stringifyJson(parts)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const payloads = [
  "work",
  "usage",
  "tool",
  "file",
  "commit",
  "pullRequest",
  "link",
  "coverage",
] as const;
export function eventKind(e: Event): string {
  const key = payloads.find((k) => e[k] != null);
  return key === "pullRequest" ? "pull_request" : (key ?? "");
}
const containsAny = (s: string, chars: string) => Array.from(chars).some((c) => s.includes(c));
const digit = (c: string) => c >= "0" && c <= "9";
// A Git host, optionally with its HTTPS port (name or name:port, 1-65535 without a leading zero),
// as the snapshot route accepted. The backend and Kimchi apply the same rule.
export function validHost(host: string): boolean {
  const colon = host.indexOf(":");
  const name = colon < 0 ? host : host.slice(0, colon);
  if (!name || containsAny(name, "/\\@?#| :")) return false;
  if (colon < 0) return true;
  const port = host.slice(colon + 1);
  return (
    port.length >= 1 &&
    port.length <= 5 &&
    port[0] !== "0" &&
    Array.from(port).every(digit) &&
    Number(port) >= 1 &&
    Number(port) <= 65535
  );
}
const bounded = (s: any, max: number) =>
  typeof (s ?? "") === "string" &&
  Buffer.byteLength(s ?? "") <= max &&
  !Array.from(s ?? ("" as string)).some((c) => {
    const n = (c as string).codePointAt(0)!;
    return n <= 31 || (n >= 127 && n <= 159);
  });
export const opaque = (s: any) => bounded(s, 128) && !containsAny(s ?? "", "/\\@?#|");
const quality = (s: any) =>
  ["observed", "inferred", "confirmed", "tool_observed", "ambiguous", "unknown"].includes(s);
export const gitId = (s: any) =>
  typeof s === "string" &&
  (s.length === 40 || s.length === 64) &&
  Buffer.from(s, "hex").toString("hex") === s;
function dec(s: any): bigint | undefined {
  if (typeof s === "number" && Number.isSafeInteger(s)) return BigInt(s);
  if (typeof s !== "string" || !s.length) return;
  const digits = s.startsWith("-") ? s.slice(1) : s;
  if (!digits.length || !Array.from(digits).every(digit)) return;
  const n = BigInt(s);
  return n >= -(1n << 63n) && n < 1n << 63n ? n : undefined;
}
function rawValid(raw: RawUsage = {}): boolean {
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const) {
    if (raw[key] != null) {
      const n = dec(raw[key]);
      if (n == null || n < 0 || n > 1_000_000_000_000n) return false;
    }
  }
  if ((raw.cacheWrites?.length ?? 0) > 16) return false;
  const ttls = new Set<number>();
  let writes = 0n;
  for (const w of raw.cacheWrites ?? []) {
    const n = dec(w.tokens);
    if (
      !Number.isInteger(w.ttlSeconds) ||
      w.ttlSeconds < 1 ||
      w.ttlSeconds > 86400 ||
      n == null ||
      n < 0 ||
      n > 1_000_000_000_000n ||
      ttls.has(w.ttlSeconds)
    )
      return false;
    ttls.add(w.ttlSeconds);
    writes += n;
  }
  return (
    (raw.cacheWriteTokens == null || writes <= dec(raw.cacheWriteTokens)!) &&
    (raw.reasoningTokens == null ||
      raw.outputTokens == null ||
      dec(raw.reasoningTokens)! <= dec(raw.outputTokens)!)
  );
}
function issueValid(keys: IssueKey[] = []): boolean {
  return (
    keys.length <= 20 &&
    keys.every((v) => {
      const parts = v.key.split("-"),
        prefix = parts[0] ?? "",
        suffix = parts[1] ?? "";
      return (
        parts.length === 2 &&
        prefix.length >= 1 &&
        prefix.length <= 32 &&
        suffix.length >= 1 &&
        suffix.length <= 20 &&
        Array.from(prefix).every((c, i) => (c >= "A" && c <= "Z") || (i > 0 && digit(c))) &&
        Array.from(suffix).every(digit) &&
        ["work", "branch", "title", "commit", "explicit"].includes(v.source) &&
        (dec(v.revision ?? "0") ?? -1n) >= 0n
      );
    })
  );
}
function uuidBytes(value: unknown): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("-");
  if (parts.map((part) => part.length).join(",") !== "8,4,4,4,12") return undefined;
  const compact = parts.join("").toLowerCase();
  const bytes = Buffer.from(compact, "hex");
  return bytes.length === 16 && bytes.toString("hex") === compact ? bytes : undefined;
}
const nonzeroUuid = (value: unknown) => uuidBytes(value)?.some((byte) => byte !== 0) ?? false;
/** A Kimchi request claim: the kimchi source says where the request's cost goes. */
export const isClaim = (e: Event): boolean =>
  e.source === "kimchi" &&
  e.usage?.counterScope === "request" &&
  Boolean(e.allocation || e.claimState || e.correction || e.startedAt);
function validateClaimEvidence(e: Event, invalid: () => never): void {
  if (e.claimState && !["active", "retracted"].includes(e.claimState)) invalid();
  const allocation = e.allocation;
  if (allocation) {
    const ids = allocation.pullRequestIds ?? [];
    if (
      !["pull-request", "unmerged", "post-merge", "shared", "unlinked", "unknown"].includes(
        allocation.kind,
      ) ||
      !["native", "explicit", "user-correction", "model", "session"].includes(allocation.method) ||
      ids.length > 250 ||
      ids.some((id) => !id || !opaque(id)) ||
      new Set(ids).size !== ids.length ||
      (["pull-request", "unmerged", "post-merge"].includes(allocation.kind) && ids.length !== 1) ||
      (allocation.kind === "shared" && ids.length < 2) ||
      (allocation.kind === "unlinked" && ids.length !== 0)
    )
      invalid();
  }
  if (e.correction) {
    const correction = e.correction;
    const at = timeNanos(correction.recordedAt);
    if (
      !nonzeroUuid(correction.id) ||
      correction.revision < 1 ||
      !["work-command", "producer-confirmation"].includes(correction.source) ||
      at < 0n ||
      at >= timeNanos("2200-01-01T00:00:00Z")
    )
      invalid();
  }
  if (e.startedAt) {
    const at = timeNanos(e.startedAt);
    if (at < 0n || at > timeNanos(e.observeTime) + 600_000_000_000n) invalid();
  }
  if (isClaim(e) && !nonzeroUuid(e.usage?.requestId ?? "")) invalid();
}
export function validateEvent(e: Event): void {
  const rev = dec(e.revision),
    base = dec(e.baseRevision ?? "0");
  if (
    !e.id ||
    !e.entityId ||
    !e.deviceId ||
    rev == null ||
    rev < 1 ||
    !e.observeTime ||
    e.observeTime === zeroTime ||
    !Number.isFinite(Date.parse(e.observeTime)) ||
    !e.source ||
    !bounded(e.source, 64)
  )
    throw new Error("missing event identity");
  if (timeNanos(e.observeTime) === timeNanos(zeroTime)) throw new Error("missing event identity");
  if (payloads.filter((k) => e[k] != null).length !== 1)
    throw new Error("exactly one typed event is required");
  if (base !== rev - 1n || (rev > 1n && !e.baseEventId)) throw new Error("invalid revision chain");
  for (const id of [e.id, e.entityId, e.deviceId, e.workId, e.sessionId, e.turnId, e.agentId])
    if (Buffer.byteLength(id ?? "") > 128 || containsAny(id ?? "", "\r\n\0"))
      throw new Error("invalid identity");
  if (Buffer.byteLength(encodeEvent(e)) > 65536) throw new Error("event exceeds bound");
  const invalid = (): never => {
    throw new Error("invalid typed event evidence");
  };
  validateClaimEvidence(e, invalid);
  if (!bounded(e.sourceVersion, 64) || !e.sourceVersion) invalid();
  const r = e.repository;
  for (const repository of [r, e.allocation?.targetRepository])
    if (
      repository &&
      (!["github", "gitlab"].includes(repository.provider) ||
        !repository.host ||
        !bounded(repository.host, 253) ||
        !validHost(repository.host) ||
        !repository.id ||
        !opaque(repository.id) ||
        !bounded(repository.name, 256) ||
        containsAny(repository.name ?? "", "@?#|\\"))
    )
      invalid();
  if (e.work) {
    const w = e.work;
    if (
      !bounded(w.title, 512) ||
      !opaque(w.planId) ||
      !opaque(w.planRevision) ||
      !bounded(w.reason, 64) ||
      !quality(w.quality) ||
      !issueValid(w.issueKeys)
    )
      invalid();
  }
  if (e.usage) {
    const u = e.usage;
    if (
      !rawValid(u.raw) ||
      !["request", "cumulative"].includes(u.counterScope) ||
      !["api", "subscription", "credits", "gateway", "unknown"].includes(u.billingBasis) ||
      !bounded(u.observedRoute, 253) ||
      containsAny(u.observedRoute, "@?#\r\n") ||
      !opaque(u.requestId) ||
      !opaque(u.responseId) ||
      ["reportedModel", "actualModel"].some((k) => !bounded((u as any)[k], 128)) ||
      [
        "provider",
        "serviceTier",
        "region",
        "channel",
        "correlation",
        "schema",
        "stopReason",
        "billingStatus",
      ].some((k) => !bounded((u as any)[k], 64)) ||
      (u.iterations?.length ?? 0) > 16 ||
      (u.aliases?.length ?? 0) > 8 ||
      (u.credits?.length ?? 0) > 16
    )
      invalid();
    if (
      u.durationMs != null &&
      ((dec(u.durationMs) ?? -1n) < 0n || dec(u.durationMs)! > 86_400_000n)
    )
      invalid();
    for (const it of u.iterations ?? [])
      if (
        !opaque(it.id) ||
        !rawValid(it.raw) ||
        !bounded(it.model, 128) ||
        ["schema", "billingStatus", "stopReason"].some((k) => !bounded((it as any)[k], 64))
      )
        invalid();
    for (const a of u.aliases ?? [])
      if (
        !["castai-request-id", "provider-request-id", "provider-response-id"].includes(
          a.namespace,
        ) ||
        !a.id ||
        !opaque(a.id) ||
        !["mod", "transcript", "telemetry"].includes(a.source)
      )
        invalid();
    for (const c of u.credits ?? [])
      if (
        !c.amount ||
        !bounded(c.amount, 64) ||
        !bounded(c.unit, 32) ||
        !bounded(c.basis, 64) ||
        c.amount.split(".").length > 2 ||
        !Array.from(c.amount).every((v) => digit(v) || v === ".")
      )
        invalid();
  }
  if (e.tool) {
    const t = e.tool,
      d = dec(t.durationMs ?? "0");
    if (
      !bounded(t.name, 128) ||
      !opaque(t.requestEntityId) ||
      !t.callId ||
      !opaque(t.callId) ||
      !["read", "edit", "shell", "plan", "other"].includes(t.category) ||
      !["completed", "failed", "interrupted"].includes(t.outcome) ||
      d == null ||
      d < 0 ||
      d > 86_400_000
    )
      invalid();
  }
  if (e.file) {
    const f = e.file;
    if (
      !f.fileId ||
      [f.fileId, f.beforeRevision, f.afterRevision, f.toolCallId].some((v) => !opaque(v)) ||
      !quality(f.quality) ||
      !["created", "modified", "deleted", "renamed", "read"].includes(f.operation)
    )
      invalid();
  }
  if (e.commit) {
    const c = e.commit;
    if (
      !gitId(c.id) ||
      (c.parents?.length ?? 0) > 16 ||
      !quality(c.quality) ||
      c.parents?.some((p) => !gitId(p))
    )
      invalid();
  }
  if (e.pullRequest) {
    const p = e.pullRequest;
    // URL parsing drops tabs and newlines; a link carrying them is not the provider's.
    if (
      typeof p.uri !== "string" ||
      Array.from(p.uri).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      invalid();
    let u: URL;
    try {
      u = new URL(p.uri);
    } catch {
      return invalid();
    }
    if (
      u.protocol !== "https:" ||
      !u.host ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !r ||
      u.host.toLowerCase() !== r.host.toLowerCase() ||
      !p.id ||
      !opaque(p.id) ||
      !Number.isInteger(p.number) ||
      p.number <= 0 ||
      p.number > 2147483647 ||
      !["open", "closed", "merged"].includes(p.state) ||
      // The provider's display bounds, counted in characters: a title of 1,024 and a login of 255.
      !bounded(p.title, 1024 * 4) ||
      Array.from(p.title ?? "").length > 1024 ||
      !bounded(p.author, 255 * 4) ||
      Array.from(p.author ?? "").length > 255 ||
      !issueValid(p.issueKeys) ||
      (p.mergeCommitId && !gitId(p.mergeCommitId))
    )
      invalid();
  }
  if (e.link) {
    const l = e.link,
      kinds = ["work", "commit", "pull_request", "usage", "file"];
    if (
      !kinds.includes(l.fromKind) ||
      !kinds.includes(l.toKind) ||
      !l.fromId ||
      !opaque(l.fromId) ||
      !l.toId ||
      !opaque(l.toId) ||
      !quality(l.quality) ||
      !bounded(l.reason, 64)
    )
      invalid();
  }
  if (e.coverage) {
    const c = e.coverage;
    if (
      !c.code ||
      !opaque(c.code) ||
      (dec(c.count) ?? 0n) < 1n ||
      !bounded(c.model, 128) ||
      (c.observedUsage != null && !rawValid(c.observedUsage)) ||
      (c.windowStartTime &&
        c.windowEndTime &&
        timeNanos(c.windowEndTime) < timeNanos(c.windowStartTime))
    )
      invalid();
  }
}
export function validateBatch(b: Batch): void {
  if (
    b.version !== protocolVersion ||
    !b.id ||
    Buffer.byteLength(b.id) > 128 ||
    !b.events.length ||
    b.events.length > 500
  )
    throw new Error("invalid batch");
  const seen = new Set<string>();
  for (const e of b.events) {
    validateEvent(e);
    if (seen.has(e.id!)) throw new Error("duplicate event in batch");
    seen.add(e.id!);
  }
}

/** The counters a request can be priced from: valid on their own, and consistent as a partition. */
export function validateAccountingRaw(schema: string, raw: RawUsage, partition: boolean): void {
  if (!rawValid(raw)) throw new Error("Invalid raw usage");
  let writes = 0n;
  for (const write of raw.cacheWrites ?? []) writes += BigInt(write.tokens);
  if (writes > 1_000_000_000_000n) throw new Error("Cache TTL counters exceed total");
  if (
    partition &&
    ["openai-responses-v1", "openai-chat-completions-v1"].includes(schema) &&
    raw.inputTokens !== undefined &&
    raw.cacheReadTokens !== undefined &&
    raw.cacheWriteTokens !== undefined &&
    BigInt(raw.cacheReadTokens) + BigInt(raw.cacheWriteTokens) > BigInt(raw.inputTokens)
  )
    throw new Error("Included cache counters exceed input");
}

/**
 * What the ingest service admits, checked before an event is stored for upload: UUID identities, a
 * supported timestamp and usage that can be accounted. Cumulative counters stay supplemental
 * evidence.
 */
export function validateIngestEvent(event: Event): asserts event is IngestEvent {
  validateEvent(event);
  if ([event.id, event.entityId, event.deviceId].some((id) => !uuidBytes(id)))
    throw new Error("Invalid event identity");
  const observed = timeNanos(event.observeTime);
  if (observed < 0n || observed > BigInt(Date.now()) * 1_000_000n + 600_000_000_000n)
    throw new Error("Event outside supported accounting timestamps");
  const usage = event.usage;
  if (!usage) return;
  validateAccountingRaw(usage.schema, usage.raw, false);
  if (usage.counterScope === "cumulative") return;
  const iterations = usage.iterations ?? [];
  if (!iterations.length) {
    if (usage.finalIterationId) throw new Error("Final iteration does not exist");
    validateAccountingRaw(usage.schema, usage.raw, true);
    return;
  }
  const ids = new Set<string>();
  for (const iteration of iterations) {
    if (!iteration.id || ids.has(iteration.id))
      throw new Error("Invalid or duplicate iteration identity");
    ids.add(iteration.id);
    validateAccountingRaw(iteration.schema, iteration.raw, true);
  }
  if (usage.finalIterationId && !ids.has(usage.finalIterationId))
    throw new Error("Final iteration does not exist");
}

export function validateIngestBatch(batch: Batch): asserts batch is IngestBatch {
  validateBatch(batch);
  if (!uuidBytes(batch.id)) throw new Error("Invalid batch identity");
  for (const event of batch.events) validateIngestEvent(event);
}
