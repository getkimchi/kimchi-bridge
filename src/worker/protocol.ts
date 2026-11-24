/**
 * The worker's NDJSON wire protocol over its private stdin/stdout pipe with the
 * embedding Kimchi process (reconcile-out-of-process plan, chunk B3). One JSON
 * object per line; every line is parsed strictly — a truncated or invalid line
 * is an error, never a guess — and tokens travel only in `reply` messages, so
 * every other message the worker emits must stay token-free (see redactTokens).
 *
 * The parent (Kimchi, chunk K2) sends `hello`, `pass`, `cancel` and `reply`;
 * the worker answers with `ready`, `request`, `metric`, `progress`, `done` and
 * `error`. Kimchi imports this module through the package export
 * "./worker-protocol": only types are shared with "./reconcile", so the wire
 * contract never pulls the reconcile library's runtime graph into Kimchi's
 * inline-mode imports.
 */
import type { HostCredentials, HostEndpoints, HostMetric } from "../reconcile/host.js";

/** Bumped only on a breaking protocol change; the worker refuses any other version. */
export const PROTOCOL_VERSION = 1;

/** The host services the worker cannot resolve itself and must ask the parent for. */
export type HostRequestKind = "credentials" | "endpoints" | "policy" | "consent";

/** The channels one pass runs; the supervisor's channel set, on the wire. */
export interface PassChannels {
  /** File transitions and continuation repair. */
  files?: boolean;
  /** Pull-request status lookups. */
  pullRequests?: boolean;
  /** Billing cost reconciliation. */
  costs?: boolean;
  /** PR-cost translation and delivery; requires `reportingCwd` on the pass message. */
  reporting?: boolean;
}

/** A channel's end state as the worker observed it. */
export type ChannelOutcome = "ok" | "failed" | "canceled";

/** What the parent is told about one channel of a finished pass. */
export interface ChannelResult {
  outcome: ChannelOutcome;
  /** A redacted failure reason; absent when the channel ran or was canceled. */
  error?: string;
}

/**
 * Write-transaction duration histogram for one pass. Chunk B4 fills it from
 * LedgerStore.tx timings; the protocol carries the shape so no version bump is
 * needed when that lands.
 */
export interface TxDurations {
  /** Write transactions measured. */
  count: number;
  /** Longest write transaction in milliseconds. */
  maxMs: number;
  /** Each ceiling counts the transactions at or under it (cumulative buckets). */
  upTo25Ms: number;
  upTo50Ms: number;
  upTo100Ms: number;
  upTo250Ms: number;
  /** Transactions over 250 ms — the plan's hard maximum for a worker transaction. */
  over250Ms: number;
}

/** The result the worker reports for one pass. */
export interface PassResult {
  /** The pass as a whole. */
  outcome: ChannelOutcome;
  /** One entry per requested channel. */
  channels: {
    files?: ChannelResult;
    pullRequests?: ChannelResult;
    costs?: ChannelResult;
    reporting?: ChannelResult;
  };
  /** Where the files channel left off; the parent sends it back on the next pass. */
  nextRepository?: string;
  /** Filled by chunk B4; omitted until then. */
  txDurations?: TxDurations;
}

// ---------------------------------------------------------------------------
// Parent → worker
// ---------------------------------------------------------------------------

/** The handshake: version, build and agent directory the worker must match. */
export interface HelloMessage {
  type: "hello";
  v: number;
  build: string;
  agentDir: string;
  /** The e2e seams the worker's host answers with, by seam name. */
  seams?: Record<string, string>;
}

/** One reconciliation pass for the worker to run. */
export interface PassMessage {
  type: "pass";
  id: number;
  channels: PassChannels;
  nextRepository?: string;
  /** Required when `channels.reporting` is set: the reporting session's cwd. */
  reportingCwd?: string;
  /** The pass's total budget in milliseconds, measured from the worker's receipt. */
  deadlineMs: number;
  /** The lease fencing epoch; chunk B4 checks it inside every write transaction. */
  epoch: number;
}

/** Cancels a running pass; the parent sends this on lease loss or shutdown. */
export interface CancelMessage {
  type: "cancel";
  id: number;
}

/** The parent's answer to a `request`; the only message allowed to carry tokens. */
export interface ReplyMessage {
  type: "reply";
  rid: number;
  result: unknown;
}

export type ParentMessage = HelloMessage | PassMessage | CancelMessage | ReplyMessage;

// ---------------------------------------------------------------------------
// Worker → parent
// ---------------------------------------------------------------------------

/** The worker accepts the handshake: same protocol version, same bridge build. */
export interface ReadyMessage {
  type: "ready";
  v: number;
  build: string;
}

/** A host request: the worker blocks until the matching `reply` or a timeout. */
export interface RequestMessage {
  type: "request";
  rid: number;
  kind: HostRequestKind;
  /** The working directory the answer is resolved for, when the kind takes one. */
  cwd?: string;
}

/** A PR-cost metric replayed into the parent's telemetry context. */
export interface MetricMessage {
  type: "metric";
  metric: HostMetric;
}

/** A pass lifecycle note the parent can surface as worker health. */
export interface ProgressMessage {
  type: "progress";
  id: number;
  note: string;
}

/** The pass's result; exactly one per accepted pass message. */
export interface DoneMessage {
  type: "done";
  id: number;
  result: PassResult;
}

/** A refusal or a fatal worker condition, always token-free. */
export interface ErrorMessage {
  type: "error";
  message: string;
  /** The pass the error belongs to, when there is one in flight. */
  id?: number;
}

export type WorkerMessage =
  | ReadyMessage
  | RequestMessage
  | MetricMessage
  | ProgressMessage
  | DoneMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------

/** The result of one strict parse: a value, or the reason the line was rejected. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const reject = (error: string): { ok: false; error: string } => ({ ok: false, error });
const accept = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

function asObject(value: unknown, what: string): Parsed<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return reject(`${what} is not an object`);
  return accept(value as Record<string, unknown>);
}

/** Strict shape: no missing required fields, no unknown fields, no wrong types. */
function exactKeys(
  source: Record<string, unknown>,
  required: string[],
  optional: string[],
): Parsed<true> {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(source))
    if (!allowed.has(key)) return reject(`unexpected field "${key}"`);
  for (const key of required) if (!(key in source)) return reject(`missing field "${key}"`);
  return accept(true);
}

function fieldString(source: Record<string, unknown>, key: string): Parsed<string> {
  const value = source[key];
  return typeof value === "string" ? accept(value) : reject(`field "${key}" is not a string`);
}

function optionalFieldString(
  source: Record<string, unknown>,
  key: string,
): Parsed<string | undefined> {
  if (!(key in source) || source[key] === undefined) return accept(undefined);
  return fieldString(source, key);
}

function fieldInteger(
  source: Record<string, unknown>,
  key: string,
  minimum: number,
): Parsed<number> {
  const value = source[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? accept(value)
    : reject(`field "${key}" is not an integer >= ${minimum}`);
}

function optionalFieldInteger(
  source: Record<string, unknown>,
  key: string,
  minimum: number,
): Parsed<number | undefined> {
  if (!(key in source) || source[key] === undefined) return accept(undefined);
  return fieldInteger(source, key, minimum);
}

function fieldBoolean(source: Record<string, unknown>, key: string): Parsed<boolean> {
  const value = source[key];
  return typeof value === "boolean" ? accept(value) : reject(`field "${key}" is not a boolean`);
}

function fieldNumber(source: Record<string, unknown>, key: string): Parsed<number> {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value)
    ? accept(value)
    : reject(`field "${key}" is not a finite number`);
}

function parseRecordOfStrings(value: unknown, what: string): Parsed<Record<string, string>> {
  const object = asObject(value, what);
  if (!object.ok) return object;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object.value)) {
    if (typeof entry !== "string") return reject(`${what} has a non-string value at "${key}"`);
    out[key] = entry;
  }
  return accept(out);
}

const CHANNEL_KEYS = ["files", "pullRequests", "costs", "reporting"] as const;

function parseChannels(value: unknown): Parsed<PassChannels> {
  const object = asObject(value, 'field "channels"');
  if (!object.ok) return object;
  const shape = exactKeys(object.value, [], [...CHANNEL_KEYS]);
  if (!shape.ok) return shape;
  const channels: PassChannels = {};
  for (const key of CHANNEL_KEYS) {
    if (!(key in object.value)) continue;
    const flag = fieldBoolean(object.value, key);
    if (!flag.ok) return flag;
    channels[key] = flag.value;
  }
  return accept(channels);
}

const OUTCOMES = ["ok", "failed", "canceled"] as const;

/** Returns the value when it is one of the options; undefined otherwise (no guessing). */
function oneOf<T extends readonly string[]>(value: string, options: T): T[number] | undefined {
  return (options as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function parseChannelResult(value: unknown, what: string): Parsed<ChannelResult> {
  const object = asObject(value, what);
  if (!object.ok) return object;
  const shape = exactKeys(object.value, ["outcome"], ["error"]);
  if (!shape.ok) return shape;
  const outcome =
    typeof object.value.outcome === "string" ? oneOf(object.value.outcome, OUTCOMES) : undefined;
  if (!outcome) return reject(`${what} field "outcome" is not one of ${OUTCOMES.join("|")}`);
  const error = optionalFieldString(object.value, "error");
  if (!error.ok) return error;
  return accept({ outcome, ...(error.value === undefined ? {} : { error: error.value }) });
}

function parseTxDurations(value: unknown): Parsed<TxDurations> {
  const object = asObject(value, 'field "txDurations"');
  if (!object.ok) return object;
  const keys = ["count", "maxMs", "upTo25Ms", "upTo50Ms", "upTo100Ms", "upTo250Ms", "over250Ms"];
  const shape = exactKeys(object.value, keys, []);
  if (!shape.ok) return shape;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const number = fieldNumber(object.value, key);
    if (!number.ok) return number;
    out[key] = number.value;
  }
  return accept(out as unknown as TxDurations);
}

function parsePassResult(value: unknown): Parsed<PassResult> {
  const object = asObject(value, 'field "result"');
  if (!object.ok) return object;
  const shape = exactKeys(object.value, ["outcome", "channels"], ["nextRepository", "txDurations"]);
  if (!shape.ok) return shape;
  const outcome =
    typeof object.value.outcome === "string" ? oneOf(object.value.outcome, OUTCOMES) : undefined;
  if (!outcome) return reject(`field "result.outcome" is not one of ${OUTCOMES.join("|")}`);
  const channelsObject = asObject(object.value.channels, 'field "result.channels"');
  if (!channelsObject.ok) return channelsObject;
  const channelsShape = exactKeys(channelsObject.value, [], [...CHANNEL_KEYS]);
  if (!channelsShape.ok) return channelsShape;
  const channels: PassResult["channels"] = {};
  for (const key of CHANNEL_KEYS) {
    if (!(key in channelsObject.value)) continue;
    const channel = parseChannelResult(channelsObject.value[key], `field "result.channels.${key}"`);
    if (!channel.ok) return channel;
    channels[key] = channel.value;
  }
  const nextRepository = optionalFieldString(object.value, "nextRepository");
  if (!nextRepository.ok) return nextRepository;
  let txDurations: TxDurations | undefined;
  if ("txDurations" in object.value && object.value.txDurations !== undefined) {
    const parsed = parseTxDurations(object.value.txDurations);
    if (!parsed.ok) return parsed;
    txDurations = parsed.value;
  }
  return accept({
    outcome,
    channels,
    ...(nextRepository.value === undefined ? {} : { nextRepository: nextRepository.value }),
    ...(txDurations === undefined ? {} : { txDurations }),
  });
}

function parseHostMetric(value: unknown): Parsed<HostMetric> {
  const object = asObject(value, 'field "metric"');
  if (!object.ok) return object;
  const kind = object.value.kind;
  if (kind === "reconciliation") {
    const shape = exactKeys(object.value, ["kind"], []);
    if (!shape.ok) return shape;
    return accept({ kind });
  }
  if (kind === "delivery") {
    const shape = exactKeys(object.value, ["kind", "outcome"], []);
    if (!shape.ok) return shape;
    const outcome =
      typeof object.value.outcome === "string"
        ? oneOf(object.value.outcome, ["success", "failed", "canceled"] as const)
        : undefined;
    if (!outcome) return reject('field "metric.outcome" is not one of success|failed|canceled');
    return accept({ kind, outcome });
  }
  if (
    kind === "unpriced" ||
    kind === "queueDepth" ||
    kind === "snapshotRequests" ||
    kind === "snapshotBytes"
  ) {
    const shape = exactKeys(object.value, ["kind", "value"], []);
    if (!shape.ok) return shape;
    const counted = fieldNumber(object.value, "value");
    if (!counted.ok) return counted;
    return accept({ kind, value: counted.value });
  }
  return reject('field "metric.kind" is not a known metric kind');
}

function parseParentValue(value: unknown): Parsed<ParentMessage> {
  const object = asObject(value, "message");
  if (!object.ok) return object;
  switch (object.value.type) {
    case "hello": {
      const shape = exactKeys(object.value, ["type", "v", "build", "agentDir"], ["seams"]);
      if (!shape.ok) return shape;
      const v = fieldInteger(object.value, "v", 1);
      if (!v.ok) return v;
      const build = fieldString(object.value, "build");
      if (!build.ok) return build;
      const agentDir = fieldString(object.value, "agentDir");
      if (!agentDir.ok) return agentDir;
      let seams: Record<string, string> | undefined;
      if ("seams" in object.value && object.value.seams !== undefined) {
        const parsed = parseRecordOfStrings(object.value.seams, 'field "seams"');
        if (!parsed.ok) return parsed;
        seams = parsed.value;
      }
      return accept({
        type: "hello",
        v: v.value,
        build: build.value,
        agentDir: agentDir.value,
        ...(seams === undefined ? {} : { seams }),
      });
    }
    case "pass": {
      const shape = exactKeys(
        object.value,
        ["type", "id", "channels", "deadlineMs", "epoch"],
        ["nextRepository", "reportingCwd"],
      );
      if (!shape.ok) return shape;
      const id = fieldInteger(object.value, "id", 1);
      if (!id.ok) return id;
      const channels = parseChannels(object.value.channels);
      if (!channels.ok) return channels;
      const deadlineMs = fieldInteger(object.value, "deadlineMs", 1);
      if (!deadlineMs.ok) return deadlineMs;
      const epoch = fieldInteger(object.value, "epoch", 0);
      if (!epoch.ok) return epoch;
      const nextRepository = optionalFieldString(object.value, "nextRepository");
      if (!nextRepository.ok) return nextRepository;
      const reportingCwd = optionalFieldString(object.value, "reportingCwd");
      if (!reportingCwd.ok) return reportingCwd;
      return accept({
        type: "pass",
        id: id.value,
        channels: channels.value,
        deadlineMs: deadlineMs.value,
        epoch: epoch.value,
        ...(nextRepository.value === undefined ? {} : { nextRepository: nextRepository.value }),
        ...(reportingCwd.value === undefined ? {} : { reportingCwd: reportingCwd.value }),
      });
    }
    case "cancel": {
      const shape = exactKeys(object.value, ["type", "id"], []);
      if (!shape.ok) return shape;
      const id = fieldInteger(object.value, "id", 1);
      if (!id.ok) return id;
      return accept({ type: "cancel", id: id.value });
    }
    case "reply": {
      const shape = exactKeys(object.value, ["type", "rid", "result"], []);
      if (!shape.ok) return shape;
      const rid = fieldInteger(object.value, "rid", 1);
      if (!rid.ok) return rid;
      return accept({ type: "reply", rid: rid.value, result: object.value.result });
    }
    default:
      return reject(
        typeof object.value.type === "string"
          ? `unknown message type "${object.value.type}"`
          : 'field "type" is not a string',
      );
  }
}

function parseWorkerValue(value: unknown): Parsed<WorkerMessage> {
  const object = asObject(value, "message");
  if (!object.ok) return object;
  switch (object.value.type) {
    case "ready": {
      const shape = exactKeys(object.value, ["type", "v", "build"], []);
      if (!shape.ok) return shape;
      const v = fieldInteger(object.value, "v", 1);
      if (!v.ok) return v;
      const build = fieldString(object.value, "build");
      if (!build.ok) return build;
      return accept({ type: "ready", v: v.value, build: build.value });
    }
    case "request": {
      const shape = exactKeys(object.value, ["type", "rid", "kind"], ["cwd"]);
      if (!shape.ok) return shape;
      const rid = fieldInteger(object.value, "rid", 1);
      if (!rid.ok) return rid;
      const kind =
        typeof object.value.kind === "string"
          ? oneOf(object.value.kind, ["credentials", "endpoints", "policy", "consent"] as const)
          : undefined;
      if (!kind) return reject('field "kind" is not a known request kind');
      const cwd = optionalFieldString(object.value, "cwd");
      if (!cwd.ok) return cwd;
      return accept({
        type: "request",
        rid: rid.value,
        kind,
        ...(cwd.value === undefined ? {} : { cwd: cwd.value }),
      });
    }
    case "metric": {
      const shape = exactKeys(object.value, ["type", "metric"], []);
      if (!shape.ok) return shape;
      const metric = parseHostMetric(object.value.metric);
      if (!metric.ok) return metric;
      return accept({ type: "metric", metric: metric.value });
    }
    case "progress": {
      const shape = exactKeys(object.value, ["type", "id", "note"], []);
      if (!shape.ok) return shape;
      const id = fieldInteger(object.value, "id", 1);
      if (!id.ok) return id;
      const note = fieldString(object.value, "note");
      if (!note.ok) return note;
      return accept({ type: "progress", id: id.value, note: note.value });
    }
    case "done": {
      const shape = exactKeys(object.value, ["type", "id", "result"], []);
      if (!shape.ok) return shape;
      const id = fieldInteger(object.value, "id", 1);
      if (!id.ok) return id;
      const result = parsePassResult(object.value.result);
      if (!result.ok) return result;
      return accept({ type: "done", id: id.value, result: result.value });
    }
    case "error": {
      const shape = exactKeys(object.value, ["type", "message"], ["id"]);
      if (!shape.ok) return shape;
      const message = fieldString(object.value, "message");
      if (!message.ok) return message;
      const id = optionalFieldInteger(object.value, "id", 1);
      if (!id.ok) return id;
      return accept({
        type: "error",
        message: message.value,
        ...(id.value === undefined ? {} : { id: id.value }),
      });
    }
    default:
      return reject(
        typeof object.value.type === "string"
          ? `unknown message type "${object.value.type}"`
          : 'field "type" is not a string',
      );
  }
}

/** Parses one parent line strictly. The error never echoes the line: it can carry a token. */
export function parseParentLine(line: string): Parsed<ParentMessage> {
  if (line.trim() === "") return reject("empty line");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return reject("the line is not valid JSON");
  }
  return parseParentValue(value);
}

/** Parses one worker line strictly, for the parent's client. */
export function parseWorkerLine(line: string): Parsed<WorkerMessage> {
  if (line.trim() === "") return reject("empty line");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return reject("the line is not valid JSON");
  }
  return parseWorkerValue(value);
}

function stringifyChecked<T>(message: T, validate: (value: unknown) => Parsed<T>): string {
  const parsed = validate(message);
  // The reason never carries the message body either: refuse before serializing secrets.
  if (!parsed.ok) throw new Error(`refusing to emit an invalid message: ${parsed.error}`);
  return `${JSON.stringify(message)}\n`;
}

/** Encodes a worker→parent message, validating it first. */
export function encodeWorkerMessage(message: WorkerMessage): string {
  return stringifyChecked(message, parseWorkerValue);
}

/** Encodes a parent→worker message, validating it first. */
export function encodeParentMessage(message: ParentMessage): string {
  return stringifyChecked(message, parseParentValue);
}

// ---------------------------------------------------------------------------
// Reply payloads
// ---------------------------------------------------------------------------

/**
 * Validates a `reply` result for its request kind. The parent validates what it
 * sends; the worker validates what it receives — a malformed answer is an
 * error, never a guessed credential.
 */
export function parseHostCredentials(value: unknown): Parsed<HostCredentials> {
  const object = asObject(value, "credentials reply");
  if (!object.ok) return object;
  const shape = exactKeys(object.value, ["token", "apiUrl"], ["organizationId"]);
  if (!shape.ok) return shape;
  const token = fieldString(object.value, "token");
  if (!token.ok) return token;
  const apiUrl = fieldString(object.value, "apiUrl");
  if (!apiUrl.ok) return apiUrl;
  const organizationId = optionalFieldString(object.value, "organizationId");
  if (!organizationId.ok) return organizationId;
  return accept({
    token: token.value,
    apiUrl: apiUrl.value,
    ...(organizationId.value === undefined ? {} : { organizationId: organizationId.value }),
  });
}

export function parseHostEndpoints(value: unknown): Parsed<HostEndpoints> {
  const object = asObject(value, "endpoints reply");
  if (!object.ok) return object;
  const keys = [
    "llmEndpoint",
    "openAiBaseUrl",
    "anthropicBaseUrl",
    "experimentalOpenAiBaseUrl",
    "platformApiUrl",
  ];
  const shape = exactKeys(object.value, keys, []);
  if (!shape.ok) return shape;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const field = fieldString(object.value, key);
    if (!field.ok) return field;
    out[key] = field.value;
  }
  return accept(out as unknown as HostEndpoints);
}

/** The policy reply: resource enabledness by resource id, answered up front. */
export interface PolicyReply {
  resources: Record<string, boolean>;
}

export function parsePolicyReply(value: unknown): Parsed<PolicyReply> {
  const object = asObject(value, "policy reply");
  if (!object.ok) return object;
  const shape = exactKeys(object.value, ["resources"], []);
  if (!shape.ok) return shape;
  const resourcesObject = asObject(object.value.resources, "policy reply resources");
  if (!resourcesObject.ok) return resourcesObject;
  const resources: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(resourcesObject.value)) {
    if (typeof entry !== "boolean")
      return reject(`policy reply resource "${key}" is not a boolean`);
    resources[key] = entry;
  }
  return accept({ resources });
}

export interface ConsentReply {
  consent: boolean;
}

export function parseConsentReply(value: unknown): Parsed<ConsentReply> {
  const object = asObject(value, "consent reply");
  if (!object.ok) return object;
  const shape = exactKeys(object.value, ["consent"], []);
  if (!shape.ok) return shape;
  const consent = fieldBoolean(object.value, "consent");
  if (!consent.ok) return consent;
  return accept({ consent: consent.value });
}

// ---------------------------------------------------------------------------
// Token redaction
// ---------------------------------------------------------------------------

/**
 * Token scrubbing for every line the worker logs or reports as an error. This
 * is bridge-native code, so it scans strings with native operations instead of
 * regex literals (the no-regex policy). Three passes cover the shapes a secret
 * takes: quoted fields named after secrets, Authorization headers, and the
 * known credential schemes. Over-redaction is safe here; a missed token is not.
 */

/** Key names whose quoted value is a secret, whatever the case they appear in. */
const SECRET_KEYS = new Set([
  "token",
  "apikey",
  "api_key",
  "api-key",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "accesskey",
]);

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** The character set RFC 6750 and the provider formats build tokens from. */
function isTokenChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_" ||
    char === "-"
  );
}

function isUpperAlnum(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
}

/** Replaces ascending, non-overlapping spans with the redaction marker. */
function replaceSpans(text: string, spans: [number, number][]): string {
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += `${text.slice(cursor, start)}[redacted]`;
    cursor = end;
  }
  return out + text.slice(cursor);
}

/** The value spans of quoted fields whose key names a secret. */
function keyedSecretSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let opening = text.indexOf('"');
  while (opening !== -1) {
    const close = text.indexOf('"', opening + 1);
    if (close === -1) break;
    if (SECRET_KEYS.has(text.slice(opening + 1, close).toLowerCase())) {
      let colon = close + 1;
      while (colon < text.length && isSpace(text[colon])) colon++;
      let quote = colon + 1;
      while (quote < text.length && isSpace(text[quote])) quote++;
      if (text[colon] === ":" && text[quote] === '"') {
        const end = text.indexOf('"', quote + 1);
        if (end === -1) break;
        spans.push([quote + 1, end]);
        opening = end + 1;
        continue;
      }
    }
    opening = text.indexOf('"', close + 1);
  }
  return spans;
}

/** The token spans of Authorization headers: the scheme word, then the credential. */
function bearerSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const lower = text.toLowerCase();
  let schemeAt = lower.indexOf("bearer");
  while (schemeAt !== -1) {
    let after = schemeAt + "bearer".length;
    while (after < text.length && isSpace(text[after])) after++;
    let end = after;
    while (end < text.length && !isSpace(text[end]) && text[end] !== '"') end++;
    if (end - after >= 8) spans.push([after, end]);
    schemeAt = lower.indexOf("bearer", end);
  }
  return spans;
}

/** One credential scheme: the prefix, the shortest run that is real, and its shape. */
interface Scheme {
  prefix: string;
  min: number;
  /** Extra shape the scheme needs right after the prefix, when it has one. */
  middle?: (text: string, at: number) => boolean;
}

const SCHEMES: Scheme[] = [
  { prefix: "sk-", min: 8 },
  { prefix: "ghp_", min: 20 },
  { prefix: "gho_", min: 20 },
  { prefix: "ghu_", min: 20 },
  { prefix: "ghs_", min: 20 },
  { prefix: "ghr_", min: 20 },
  { prefix: "github_pat_", min: 20 },
  { prefix: "glpat-", min: 15 },
  // Slack: xox, one of baprs, a dash, then the credential proper.
  {
    prefix: "xox",
    min: 10,
    middle: (text, at) => "baprs".includes(text[at] ?? "") && text[at + 1] === "-",
  },
];

/** The credential spans of one scheme, wherever it appears. */
function schemeSpans(text: string, scheme: Scheme): [number, number][] {
  const spans: [number, number][] = [];
  const lower = text.toLowerCase();
  const needle = scheme.prefix.toLowerCase();
  let index = lower.indexOf(needle);
  while (index !== -1) {
    let start = index + needle.length;
    if (scheme.middle && !scheme.middle(text, start)) {
      index = lower.indexOf(needle, index + 1);
      continue;
    }
    if (scheme.middle) start += 2;
    let end = start;
    while (end < text.length && isTokenChar(text[end])) end++;
    if (end - start >= scheme.min) spans.push([index, end]);
    index = lower.indexOf(needle, end);
  }
  return spans;
}

/** The spans of AWS access key ids: AKIA plus sixteen upper-case alphanumerics. */
function awsSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let index = text.indexOf("AKIA");
  while (index !== -1) {
    let end = index + 4;
    while (end < text.length && isUpperAlnum(text[end])) end++;
    if (end - index >= 4 + 16) spans.push([index, end]);
    index = text.indexOf("AKIA", end);
  }
  return spans;
}

/**
 * Scrubs tokens from a line the worker is about to log or report as an error.
 * `secrets` are the exact values the worker knows it handled (credential
 * tokens from reply messages); everything else is matched by shape. A secret
 * shorter than 8 characters is too likely to be an ordinary word to scrub.
 */
export function redactTokens(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8 && secret.trim() !== "") out = out.split(secret).join("[redacted]");
  }
  out = replaceSpans(out, keyedSecretSpans(out));
  out = replaceSpans(out, bearerSpans(out));
  for (const scheme of SCHEMES) out = replaceSpans(out, schemeSpans(out, scheme));
  out = replaceSpans(out, awsSpans(out));
  return out;
}
