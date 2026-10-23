import { createHash, randomUUID } from "node:crypto";
declare const Temporal: {
  Instant: {
    from(value: string): {
      toString(): string;
      toZonedDateTimeISO(offset: string): {
        toString(options: { timeZoneName: "never"; calendarName: "never" }): string;
      };
    };
  };
};

export const Version = 1;
export const ZeroTime = "0001-01-01T00:00:00Z";
type Object = Record<string, any>;
export const obj = (value: unknown): Object =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Object) : {};
export function str(value: Object | undefined, ...keys: string[]): string {
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
export interface Event {
  id?: string;
  entityId: string;
  revision?: string;
  baseRevision?: string;
  baseHash?: string;
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
}
export interface Batch {
  version: number;
  id: string;
  events: Event[];
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
export class NativeNumber {
  constructor(public readonly lexeme: string) {}
  toString(): string {
    return this.lexeme;
  }
  valueOf(): number {
    return Number(this.lexeme);
  }
}
export function Parse(text: string): any {
  return JSON.parse(text, ((_: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" ? new NativeNumber(context?.source ?? String(value)) : value) as any);
}
export function NumberText(value: unknown): string | undefined {
  if (value instanceof NativeNumber) return value.lexeme;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
export function Integer(value: unknown): number | undefined {
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
    ["ttlSeconds", "n"],
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
    ["number", "n"],
    ["uri", "s"],
    ["state", "s"],
    ["createTime", "t", "nil"],
    ["closeTime", "t", "nil"],
    ["mergeTime", "t", "nil"],
    ["mergeCommitId", "s", "empty"],
    ["title", "s", "empty"],
    ["issueKeys", "[]issue", "empty"],
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
  event: [
    ["id", "s"],
    ["entityId", "s"],
    ["revision", "q"],
    ["baseRevision", "q", "empty"],
    ["baseHash", "s", "empty"],
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
function timeText(value: unknown): string {
  const s = value instanceof Date ? value.toISOString() : String(value ?? ZeroTime);
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
  if (timestampCache.size >= 128) timestampCache.clear();
  timestampCache.set(s, result);
  return result;
}
export const CanonicalTime = timeText;
function shape(name: string, value: any): Ordered {
  const fields: [string, unknown][] = [];
  for (const [key, type, omit] of schemas[name]!) {
    const v = value?.[key];
    if (
      omit &&
      (v == null ||
        (omit === "empty" &&
          (v === "" ||
            v === false ||
            v === 0 ||
            v === 0n ||
            (type === "q" && String(v) === "0") ||
            (Array.isArray(v) && !v.length))))
    )
      continue;
    fields.push([key, convert(type, v)]);
  }
  return new Ordered(fields);
}
function convert(type: string, value: any): any {
  if (type.startsWith("[]"))
    return value == null ? null : value.map((v: any) => convert(type.slice(2), v));
  if (type === "s") return value ?? "";
  if (type === "q") return String(value ?? "0");
  if (type === "n") return value ?? 0;
  if (type === "b") return value ?? false;
  if (type === "t") return timeText(value);
  return shape(type, value);
}
function quoted(value: string): string {
  return JSON.stringify(value.toWellFormed())
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
export function Stringify(value: any): string {
  if (value instanceof NativeNumber) return value.lexeme;
  if (value instanceof Ordered)
    return "{" + value.fields.map(([k, v]) => quoted(k) + ":" + Stringify(v)).join(",") + "}";
  if (value == null) return "null";
  if (typeof value === "string") return quoted(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return quoted(timeText(value));
  if (Array.isArray(value)) return "[" + value.map(Stringify).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .filter((k) => value[k] !== undefined)
      .map((k) => quoted(k) + ":" + Stringify(value[k]))
      .join(",") +
    "}"
  );
}
export function EncodeEvent(value: Event): string {
  return Stringify(shape("event", value));
}
export function EncodeBatch(value: Batch): string {
  return Stringify(shape("batch", value));
}
export function Hash(value: any): string {
  const body =
    value && typeof value === "object" && !Array.isArray(value) && "entityId" in value
      ? EncodeEvent(value)
      : value && typeof value === "object" && "version" in value && "events" in value
        ? EncodeBatch(value)
        : Stringify(value);
  return createHash("sha256").update(body).digest("hex");
}
export function NewID(): string {
  return randomUUID();
}
export function StableID(...parts: string[]): string {
  const h = createHash("sha256").update(Stringify(parts)).digest("hex").slice(0, 32);
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
export function Kind(e: Event): string {
  const key = payloads.find((k) => e[k] != null);
  return key === "pullRequest" ? "pull_request" : (key ?? "");
}
const containsAny = (s: string, chars: string) => Array.from(chars).some((c) => s.includes(c));
const digit = (c: string) => c >= "0" && c <= "9";
const bounded = (s: any, max: number) =>
  typeof (s ?? "") === "string" &&
  Buffer.byteLength(s ?? "") <= max &&
  !Array.from(s ?? ("" as string)).some((c) => {
    const n = (c as string).codePointAt(0)!;
    return n <= 31 || (n >= 127 && n <= 159);
  });
const opaque = (s: any) => bounded(s, 128) && !containsAny(s ?? "", "/\\@?#|");
const quality = (s: any) =>
  ["observed", "inferred", "confirmed", "tool_observed", "ambiguous", "unknown"].includes(s);
const gitID = (s: any) =>
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
export function Validate(e: Event): void {
  const rev = dec(e.revision),
    base = dec(e.baseRevision ?? "0");
  if (
    !e.id ||
    !e.entityId ||
    !e.deviceId ||
    rev == null ||
    rev < 1 ||
    !e.observeTime ||
    e.observeTime === ZeroTime ||
    !Number.isFinite(Date.parse(e.observeTime)) ||
    !e.source ||
    !bounded(e.source, 64)
  )
    throw new Error("missing event identity");
  if (payloads.filter((k) => e[k] != null).length !== 1)
    throw new Error("exactly one typed event is required");
  if (base !== rev - 1n || (rev > 1n && !e.baseHash)) throw new Error("invalid revision chain");
  for (const id of [e.id, e.entityId, e.deviceId, e.workId, e.sessionId, e.turnId, e.agentId])
    if (Buffer.byteLength(id ?? "") > 128 || containsAny(id ?? "", "\r\n\0"))
      throw new Error("invalid identity");
  if (Buffer.byteLength(EncodeEvent(e)) > 65536) throw new Error("event exceeds bound");
  const invalid = () => {
    throw new Error("invalid typed event evidence");
  };
  if (!bounded(e.sourceVersion, 64) || !e.sourceVersion) invalid();
  const r = e.repository;
  if (
    r &&
    (!["github", "gitlab"].includes(r.provider) ||
      !r.host ||
      !bounded(r.host, 253) ||
      containsAny(r.host, "/\\@?#| :") ||
      !r.id ||
      !opaque(r.id) ||
      !bounded(r.name, 256) ||
      containsAny(r.name ?? "", "@?#|\\"))
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
      !gitID(c.id) ||
      (c.parents?.length ?? 0) > 16 ||
      !quality(c.quality) ||
      c.parents?.some((p) => !gitID(p))
    )
      invalid();
  }
  if (e.pullRequest) {
    const p = e.pullRequest;
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
      u.hostname.toLowerCase() !== r.host.toLowerCase() ||
      !p.id ||
      !opaque(p.id) ||
      !Number.isInteger(p.number) ||
      p.number <= 0 ||
      p.number > 2147483647 ||
      !["open", "closed", "merged"].includes(p.state) ||
      !bounded(p.title, 512) ||
      !issueValid(p.issueKeys) ||
      (p.mergeCommitId && !gitID(p.mergeCommitId))
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
        Date.parse(c.windowEndTime) < Date.parse(c.windowStartTime))
    )
      invalid();
  }
}
export function ValidateBatch(b: Batch): void {
  if (
    b.version !== Version ||
    !b.id ||
    Buffer.byteLength(b.id) > 128 ||
    !b.events.length ||
    b.events.length > 500
  )
    throw new Error("invalid batch");
  const seen = new Set<string>();
  for (const e of b.events) {
    Validate(e);
    if (seen.has(e.id!)) throw new Error("duplicate event in batch");
    seen.add(e.id!);
  }
}
