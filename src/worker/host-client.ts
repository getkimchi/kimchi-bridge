/**
 * The worker process's HostPorts (reconcile-out-of-process plan, chunk B3).
 *
 * HostPorts' credential, git-token, endpoint, policy and consent reads are
 * synchronous and are called at many synchronous sites inside the moved
 * passes, whose timing must not change now that they run in the worker. So
 * the worker answers them with a blocking RPC over its private stdin/stdout
 * pipe:
 *
 *   - the main thread writes a `request` line to stdout with fs.writeSync and
 *     blocks in Atomics.wait on a SharedArrayBuffer (10 s timeout);
 *   - a helper thread (a Bun `Worker` with eval'd source) owns reading stdin:
 *     it writes the matching `reply` line into the shared buffer and notifies,
 *     and forwards every other parent line (hello, pass, cancel) to the main
 *     thread through postMessage, which the (blocked) main thread drains once
 *     it wakes. The helper also fast-wakes the main thread on stdin EOF and on
 *     a cancel for the pass in flight, so neither waits out a pending timeout;
 *   - a timeout (or a malformed reply) throws a typed error that fails the
 *     current channel — never a guessed value, never a write.
 *
 * No answer is cached, not even within one pass: the mid-pass ownership
 * re-check (pr-cost-reporting/worker.ts, assertOwnership) compares both the
 * credential token and the platform API URL against the values captured at the
 * start of delivery, so both must be live reads of the parent's answer.
 */
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { HostPorts } from "../reconcile/host.js";
import { DEFAULT_WORKER_USER_AGENT, makeWorkerFetch } from "./fetch.js";
import {
  encodeWorkerMessage,
  HEARTBEAT_TIMEOUT_MS,
  parseConsentReply,
  parseGitTokenReply,
  parseHostCredentials,
  parseHostEndpoints,
  parseParentLine,
  parsePolicyReply,
  parseReportingConsentReply,
  redactTokens,
  resourceEnabledFromPolicy,
  type HostRequestKind,
  type ParentMessage,
  type WorkerMessage,
} from "./protocol.js";

/** The parent must answer a host request within this window. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** SharedArrayBuffer header (int32 control and heartbeat-arrival slots) followed by the
 *  reply line's bytes. */
/** Slot 0 holds the state in its low bits and the owning request's rid above. */
const COMBINED = 0;
const LENGTH = 1;
const ACTIVE_PASS = 3;
/** Int32 slot 4 (byte 16): the heartbeat arrival counter. The helper increments it once per
 *  heartbeat line it reads; the main thread uses changes to bound the newest arrival in time. */
const HEARTBEAT_SEQ = 4;
const HEADER_BYTES = 32;
/** The longest reply line (a credentials or policy answer is a few hundred bytes). */
const REPLY_BYTES = 64 * 1024;

const STATE_IDLE = 0;
const STATE_WAITING = 1;
const STATE_READY = 2;
const STATE_PARENT_GONE = 3;
const STATE_CANCELLED = 4;
/** The state bits of the combined word; the rid occupies the bits above. */
const STATE_MASK = 0b111;
/** How far the rid sits above the state bits in the combined word. */
const RID_SHIFT = 3;
/** The rid's bits of the combined word; the mask keeps the word a positive int32. */
const RID_MASK = 0x0fffffff;
/** How often the main thread bounds newly observed arrivals on its own monotonic clock. */
const ANCHOR_PERIOD_MS = 50;

/** Packs a slot owner into one word: state in the low bits, rid above. */
/** The next request id: cycles through 1..RID_MASK, never the zero the wire forbids. */
export function nextRequestId(current: number): number {
  return (current % RID_MASK) + 1;
}

function combined(rid: number, state: number): number {
  return (rid << RID_SHIFT) | state;
}

/** The worker refuses ledger writes when no heartbeat arrived for this long. The value is the
 *  protocol module's: it must stay inside proper-lockfile's 5 s stale-lock window (Decision 7).
 *  Re-exported so the parent and the worker share one constant through the package. */
export { HEARTBEAT_TIMEOUT_MS };

/** The heartbeat window, overridable through the environment (the tests use a shorter or longer
 *  one); the parent that spawns the worker controls its environment, like the idle exit. Values
 *  above the protocol's timeout are clamped to it: an override that reached or passed the
 *  proper-lockfile stale window would defeat the old-release fence the timeout exists for
 *  (Decision 7). Shorter values stay as given, so tests can tighten the window. */
export function heartbeatTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KIMCHI_WORKER_HEARTBEAT_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, HEARTBEAT_TIMEOUT_MS);
  }
  return HEARTBEAT_TIMEOUT_MS;
}

/** The parent's lease heartbeat went silent: the worker refuses every ledger write through the
 *  pass's write fence. Thrown by the fence's assertWritable hook, so it fails the pass's writes
 *  the same way a lost epoch does; the channel reports it and nothing is committed. */
export class LeaseHeartbeatLost extends Error {
  /** How stale the freshest heartbeat was, in milliseconds. */
  readonly ageMs: number;
  constructor(ageMs: number) {
    super(
      `the parent lease heartbeat was last seen ${Math.round(ageMs)} ms ago; refusing ledger writes`,
    );
    this.name = "LeaseHeartbeatLost";
    this.ageMs = ageMs;
  }
}

/** What failed when a host request cannot be answered. */
export type HostRequestCause =
  | "timeout"
  | "parent-gone"
  | "invalid-reply"
  | "canceled"
  | "deadline";

/** A failed host request. Fails the current channel; never falls back to a guess. */
export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly requestKind: HostRequestKind,
    readonly cause: HostRequestCause,
  ) {
    super(message);
    this.name = "HostRequestError";
  }
}

/** One note from the helper thread: a forwarded line, or a stdin condition. Its wall timestamp
 *  is for pass deadlines; heartbeat freshness instead uses the shared arrival counter, so a
 *  note drained late cannot re-date an arrival on the main thread's monotonic clock. */
interface HelperNote {
  line?: string;
  /** When the helper read the line (ms since epoch): the true receipt time. */
  at?: number;
  eof?: boolean;
  oversized?: boolean;
  readError?: string;
}

/** What the transport hands the entry point. */
export type TransportEvent =
  | { kind: "message"; message: ParentMessage; receivedAt: number }
  | { kind: "invalid-line"; reason: string }
  | { kind: "parent-gone" }
  | { kind: "transport-error"; reason: string };

/**
 * The helper thread's whole program, eval'd so it needs no second file in the
 * bundle (the worker ships as one lib/worker.mjs). It reads fd 0 in a blocking
 * loop — a worker thread's `process.stdin` is not wired to the real stdin — and
 * never touches stdout, which only the main thread writes. The shared buffer's
 * slot indexes and state values are interpolated from the constants above, so
 * the two threads cannot drift apart on the layout.
 */
const HELPER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { readSync } = require("node:fs");
const ia = new Int32Array(workerData);
const seq = new Int32Array(workerData, ${HEARTBEAT_SEQ * 4}, 1);
const payload = new Uint8Array(workerData, ${HEADER_BYTES});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_LINE_BYTES = 1048576;
const chunk = Buffer.alloc(65536);
let pending = "";
// This thread owns stdin through a BLOCKING readSync loop (below): it never takes an
// event-loop turn between reads, so it cannot answer postMessages — the heartbeat fence
// therefore never asks it anything. On each heartbeat it increments the shared arrival
// counter; the main thread bounds those changes on its own monotonic clock.
// Test-only hook: a delay inserted before this thread's first action, so a test can
// reproduce a helper whose actual start is delayed past the fence window (scheduler
// starvation) without touching the main thread. Zero (unset) keeps it dormant.
const TEST_HELPER_START_DELAY_MS = Number(process.env.KIMCHI_WORKER_TEST_HELPER_START_DELAY_MS || 0);
if (TEST_HELPER_START_DELAY_MS > 0) {
  const until = performance.now() + TEST_HELPER_START_DELAY_MS;
  while (performance.now() < until) {
    /* A real block: no first action, no store, no wake until it ends. */
  }
}
// Test-only hook: a delay inserted between the reply checks and the
// publication, so a test can hold a checked reply across a request's
// timeout and the next request's start. Zero (unset) keeps it dormant.
const TEST_REPLY_DELAY_MS = Number(process.env.KIMCHI_WORKER_TEST_REPLY_DELAY_MS || 0);
const TEST_SLEEP = new Int32Array(new SharedArrayBuffer(4));
function forward(line) {
  parentPort.postMessage({ line: line, at: Date.now() });
}
function reply(line, parsed) {
  const word = Atomics.load(ia, ${COMBINED});
  if ((word & ${STATE_MASK}) !== ${STATE_WAITING}) return false; // nobody is waiting
  if (parsed.rid !== (word >>> ${RID_SHIFT})) return false; // late or stale reply
  // The slot may only be written while it is WAITING: then the request's
  // thread is blocked and cannot be reading the payload.
  if (TEST_REPLY_DELAY_MS > 0) Atomics.wait(TEST_SLEEP, 0, 0, TEST_REPLY_DELAY_MS);
  const expected = (parsed.rid << ${RID_SHIFT}) | ${STATE_WAITING};
  const bytes = encoder.encode(line);
  if (bytes.length <= payload.length) { payload.set(bytes); Atomics.store(ia, ${LENGTH}, bytes.length); }
  else Atomics.store(ia, ${LENGTH}, -1);
  // Publication must win a compare-exchange on the combined rid/state word:
  // the slot accepts the reply only if it still belongs to this rid in
  // WAITING. A reply that passed the checks above can no longer publish
  // after its request timed out and a newer request took the slot — the
  // exchange fails and the reply is declined, never delivered to the next
  // request as a poisoned READY.
  if (Atomics.compareExchange(ia, ${COMBINED}, expected, (parsed.rid << ${RID_SHIFT}) | ${STATE_READY}) !== expected) return false;
  Atomics.notify(ia, ${COMBINED});
  return true;
}
function cancel(parsed) {
  // Fast wake: a cancel for the pass in flight must not sit behind a pending
  // request's timeout. The line is still forwarded for the main thread to own.
  if (parsed.id !== Atomics.load(ia, ${ACTIVE_PASS})) return;
  if ((Atomics.load(ia, ${COMBINED}) & ${STATE_MASK}) !== ${STATE_WAITING}) return;
  Atomics.store(ia, ${COMBINED}, ${STATE_CANCELLED});
  Atomics.notify(ia, ${COMBINED});
}
function heartbeat(parsed) {
  if (parsed.type !== "heartbeat" || typeof parsed.at !== "number") return;
  Atomics.add(seq, 0, 1);
  Atomics.notify(seq, 0);
}
function gone() {
  Atomics.store(ia, ${COMBINED}, ${STATE_PARENT_GONE});
  Atomics.notify(ia, ${COMBINED});
  parentPort.postMessage({ eof: true });
}
function onLine(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return forward(line); }
  if (parsed === null || typeof parsed !== "object") return forward(line);
  if (parsed.type === "reply" && typeof parsed.rid === "number" && reply(line, parsed)) return;
  if (parsed.type === "cancel" && typeof parsed.id === "number") cancel(parsed);
  heartbeat(parsed);
  forward(line);
}
for (;;) {
  let read;
  try { read = readSync(0, chunk, 0, chunk.length, null); }
  catch (error) {
    // Fast wake, like EOF: a blocked request must not sit out its timeout on
    // an already-fatal stdin error.
    parentPort.postMessage({ readError: String(error) });
    return gone();
  }
  if (read === 0) return gone();
  pending += decoder.decode(chunk.subarray(0, read), { stream: true });
  for (;;) {
    const index = pending.indexOf("\\n");
    if (index === -1) break;
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.trim() === "") continue;
    if (line.length > MAX_LINE_BYTES) { parentPort.postMessage({ oversized: true }); return gone(); }
    onLine(line);
  }
  if (pending.length > MAX_LINE_BYTES) { parentPort.postMessage({ oversized: true }); return gone(); }
}
`;

/**
 * The worker's side of the pipe: message emission, event delivery and the
 * blocking host request. One instance per process; constructed before `hello`
 * is read so that the helper thread owns stdin from its first byte.
 */
export class StdioTransport {
  #activePassId = 0;
  /** The id of the pass in flight; the reader thread matches cancel lines against it. */
  get activePassId(): number {
    return this.#activePassId;
  }
  set activePassId(id: number) {
    this.#activePassId = id;
    Atomics.store(this.slots, ACTIVE_PASS, id);
  }
  #deadlineAt = 0;
  /** The absolute deadline of the pass in flight (ms since epoch); 0 when none. */
  get deadlineAt(): number {
    return this.#deadlineAt;
  }
  set deadlineAt(at: number) {
    this.#deadlineAt = at;
  }
  private readonly shared = new SharedArrayBuffer(HEADER_BYTES + REPLY_BYTES);
  private readonly slots: Int32Array = new Int32Array(this.shared);
  private readonly helper: Worker;
  private rid = 0;
  private closed = false;
  private readonly secrets = new Set<string>();
  /** The main thread's monotonic clock; injectable for deterministic elapsed-time tests. */
  readonly #mono: () => number;
  /** The actual preceding observation fire, not a delayed current fire mislabeled as it. */
  #previousFireAt: number;
  /** The arrival count observed at a fire or fence check on the main thread. */
  #previousObservedSeq: number;
  /** A time at or before the newest observed arrival; age from it is an upper bound. */
  #arrivalLowerBound: number;
  /** The arrival anchor timer; stopped by close(). */
  #anchorTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly emit: (event: TransportEvent) => void,
    options?: { ridSeed?: number; mono?: () => number },
  ) {
    this.rid = options?.ridSeed ?? 0;
    this.#mono = options?.mono ?? (() => performance.now());
    // A parent that never heartbeats ages out from construction. Every value is read by this
    // main thread: no wall clock and no cross-thread clock conversion participates in the fence.
    const startedAt = this.#mono();
    this.#previousFireAt = startedAt;
    this.#arrivalLowerBound = startedAt;
    this.#previousObservedSeq = Atomics.load(this.slots, HEARTBEAT_SEQ) >>> 0;
    // Test-only hook: a delay inserted between the startup stamp above and the helper
    // thread's start, so a test can reproduce a Worker construction stretched past the fence
    // window (scheduler pressure, a paused process). The startup stamp covers the whole
    // stretch — ages only read older through it, never fresher. Zero (unset) keeps it
    // dormant.
    const TEST_CONSTRUCT_DELAY_MS = Number(process.env.KIMCHI_WORKER_TEST_CONSTRUCT_DELAY_MS || 0);
    if (TEST_CONSTRUCT_DELAY_MS > 0) {
      const until = performance.now() + TEST_CONSTRUCT_DELAY_MS;
      while (performance.now() < until) {
        /* A real block: the helper thread cannot start until it ends. */
      }
    }
    this.helper = new Worker(HELPER_SOURCE, { eval: true, workerData: this.shared });
    this.helper.on("message", (note: HelperNote) => this.onHelperNote(note));
    this.helper.on("error", (error) => {
      this.transportError(`the stdin reader thread failed: ${String(error)}`);
    });
    this.helper.on("exit", (code) => {
      if (!this.closed)
        this.transportError(`the stdin reader thread exited unexpectedly (${code})`);
    });
    this.#anchorTimer = setInterval(() => this.#observeArrivalAnchors(), ANCHOR_PERIOD_MS);
  }

  /** Bound changed arrivals at the actual preceding fire P, not this possibly delayed fire D.
   *  Any newly observed arrival lies in [P, D], so P is always a conservative lower bound. */
  #observeArrivalAnchors(): void {
    const fireAt = this.#mono();
    const observedSeq = Atomics.load(this.slots, HEARTBEAT_SEQ) >>> 0;
    if (observedSeq !== this.#previousObservedSeq)
      this.#arrivalLowerBound = this.#previousFireAt;
    this.#previousObservedSeq = observedSeq;
    this.#previousFireAt = fireAt;
  }

  /** An upper bound on silence. A check also observes arrivals, but leaves previousFireAt alone:
   *  a changed sequence can only be newer than the preceding fire, never newer than this check. */
  heartbeatAgeMs(): number {
    const observedSeq = Atomics.load(this.slots, HEARTBEAT_SEQ) >>> 0;
    if (observedSeq !== this.#previousObservedSeq) {
      this.#arrivalLowerBound = this.#previousFireAt;
      this.#previousObservedSeq = observedSeq;
    }
    return Math.max(0, this.#mono() - this.#arrivalLowerBound);
  }

  /** Throws LeaseHeartbeatLost when the newest heartbeat's conservative silence bound exceeds
   *  the window. Delayed helper/pipe/main-thread observation and wall-clock steps cannot lower
   *  this bound. A long main-thread hold may overstate it; later punctual observations recover. */
  assertHeartbeatFresh(timeoutMs: number = heartbeatTimeoutMs()): void {
    const age = this.heartbeatAgeMs();
    if (age > timeoutMs) throw new LeaseHeartbeatLost(age);
  }

  private transportError(reason: string): void {
    if (!this.closed) this.emit({ kind: "transport-error", reason });
  }

  private onHelperNote(note: HelperNote): void {
    if (note.line !== undefined) {
      // The helper's read time is the true receipt moment: the main thread
      // may sit blocked in a host request long before it drains the event,
      // and a pass's budget runs from receipt, not from the drain.
      const receivedAt = note.at ?? Date.now();
      const parsed = parseParentLine(note.line);
      if (parsed.ok) this.emit({ kind: "message", message: parsed.value, receivedAt });
      else this.emit({ kind: "invalid-line", reason: parsed.error });
      return;
    }
    if (note.readError !== undefined) {
      this.transportError(`stdin could not be read: ${note.readError}`);
      return;
    }
    if (note.oversized === true) {
      this.transportError("a parent line exceeded the 1 MiB protocol limit");
      return;
    }
    if (note.eof === true) this.emit({ kind: "parent-gone" });
  }

  /** Writes one worker→parent message; blocking, so a request line is out before its wait.
   *  A failed write means the read end of the pipe is gone: the parent is
   *  dead for delivery purposes, so the worker reports it and stops writing.
   *  A parent that stays alive but stops reading can hold this write once the
   *  pipe fills — that stalled-parent case is bounded by the parent's kill
   *  watchdog, the same backstop the protocol's supervision relies on. */
  send(message: WorkerMessage): void {
    if (this.#pipeGone) return;
    try {
      writeSync(1, encodeWorkerMessage(message));
    } catch {
      this.pipeGone();
    }
  }

  #pipeGone = false;

  /** The parent's read end is gone: nothing more can be delivered to it. */
  private pipeGone(): void {
    if (this.#pipeGone) return;
    this.#pipeGone = true;
    this.emit({ kind: "parent-gone" });
  }

  /** Registers a secret value (a credential token) for redaction on every error path. */
  addSecret(secret: string): void {
    // Every nonempty accepted credential is a secret, however short — a
    // whitespace-only token is accepted by the credential reply and by
    // Kimchi's own config reader, so only the empty string is excluded.
    if (secret !== "") this.secrets.add(secret);
  }

  /** Redacts every known secret and credential shape from a line about to be reported. */
  redact(text: string): string {
    return redactTokens(text, this.secrets);
  }

  /**
   * The blocking host request. Throws HostRequestError on timeout, parent
   * death, a cancel for the pass in flight, a malformed reply, or the pass
   * deadline expiring while the request was pending — never returns a guessed
   * value. The wait is capped at the pass deadline too, so a stalled parent
   * cannot hold the pass past its budget behind the request timeout.
   */
  request(kind: HostRequestKind, params?: { cwd?: string; host?: string }): unknown {
    // A parent that already died must not be overwritten by a new wait: the
    // reader thread is gone with it, so the request would never be answered.
    if (this.#pipeGone || (Atomics.load(this.slots, COMBINED) & STATE_MASK) === STATE_PARENT_GONE)
      throw new HostRequestError(
        `the parent is gone; the ${kind} request cannot be answered`,
        kind,
        "parent-gone",
      );
    const rid = (this.rid = nextRequestId(this.rid));
    // One store claims the slot for this rid in WAITING, so the helper's
    // publication compare-exchange — not a separate rid check — decides
    // whether the slot still belongs to this request when a reply lands.
    Atomics.store(this.slots, LENGTH, 0);
    Atomics.store(this.slots, COMBINED, combined(rid, STATE_WAITING));
    try {
      writeSync(
        1,
        encodeWorkerMessage({
          type: "request",
          rid,
          kind,
          ...(params?.cwd === undefined ? {} : { cwd: params.cwd }),
          ...(params?.host === undefined ? {} : { host: params.host }),
        }),
      );
    } catch {
      // The parent died between the pre-check and the write: a failed
      // request write is parent death. The compare-exchange converts only
      // this request's own WAITING slot, never a state another writer stored.
      Atomics.compareExchange(
        this.slots,
        COMBINED,
        combined(rid, STATE_WAITING),
        STATE_PARENT_GONE,
      );
      this.pipeGone();
      throw new HostRequestError(
        `the parent is gone; the ${kind} request cannot be answered`,
        kind,
        "parent-gone",
      );
    }
    const remaining =
      this.#deadlineAt > 0
        ? Math.min(REQUEST_TIMEOUT_MS, this.#deadlineAt - Date.now())
        : REQUEST_TIMEOUT_MS;
    // Atomics.wait truncates a fractional timeout toward zero; round up so a
    // deadline scheduled mid-millisecond still gets its full remainder.
    const waited = Atomics.wait(
      this.slots,
      COMBINED,
      combined(rid, STATE_WAITING),
      Math.ceil(Math.max(remaining, 0)),
    );
    if (waited === "timed-out") {
      // The compare-exchange is the race's referee: this thread is the only
      // writer that may end its own WAITING, so a value other than its own
      // combined WAITING word back means the reader thread stored a terminal
      // state (a reply, a cancel, or parent death) after the wait expired but
      // before this exchange. That state wins over the timeout and is handled
      // below — never misreported as one.
      const observed = Atomics.compareExchange(
        this.slots,
        COMBINED,
        combined(rid, STATE_WAITING),
        STATE_IDLE,
      );
      if (observed === combined(rid, STATE_WAITING)) {
        if (this.#deadlineAt > 0 && Date.now() >= this.#deadlineAt)
          throw new HostRequestError(
            `the pass deadline expired while the ${kind} request was pending`,
            kind,
            "deadline",
          );
        throw new HostRequestError(
          `the parent did not answer the ${kind} request within ${REQUEST_TIMEOUT_MS} ms`,
          kind,
          "timeout",
        );
      }
    }
    const state = Atomics.load(this.slots, COMBINED) & STATE_MASK;
    if (state === STATE_PARENT_GONE)
      throw new HostRequestError(
        `the parent is gone; the ${kind} request cannot be answered`,
        kind,
        "parent-gone",
      );
    if (state === STATE_CANCELLED) {
      Atomics.store(this.slots, COMBINED, STATE_IDLE);
      throw new HostRequestError(
        `the pass was canceled while the ${kind} request was pending`,
        kind,
        "canceled",
      );
    }
    const length = Atomics.load(this.slots, LENGTH);
    Atomics.store(this.slots, COMBINED, STATE_IDLE);
    if (length < 0)
      throw new HostRequestError(
        `the parent's ${kind} reply exceeded the ${REPLY_BYTES} byte pipe buffer`,
        kind,
        "invalid-reply",
      );
    const line = Buffer.from(this.shared, HEADER_BYTES, length).toString("utf8");
    const parsed = parseParentLine(line);
    if (!parsed.ok || parsed.value.type !== "reply" || parsed.value.rid !== rid)
      throw new HostRequestError(
        `the parent's ${kind} reply was not a valid reply message`,
        kind,
        "invalid-reply",
      );
    return parsed.value.result;
  }

  /** Stops the arrival anchor timer and the reader thread; the process is exiting anyway. */
  close(): void {
    this.closed = true;
    clearInterval(this.#anchorTimer);
    this.helper.terminate();
  }
}

/**
 * HostPorts over the pipe: credentials, endpoints, policy and consent are
 * blocking requests; metrics are replayed as `metric` messages; fetch is the
 * user-agent and idle-timeout wrapper over the worker's own fetch (see
 * fetch.ts); the seam answers come from `hello.seams`; the agent directory and
 * clock are local.
 */
export class StdioHostClient implements HostPorts {
  private readonly seams: Record<string, string>;
  constructor(
    private readonly transport: StdioTransport,
    private readonly hello: {
      agentDir: string;
      seams?: Record<string, string>;
      userAgent?: string;
    },
  ) {
    this.seams = hello.seams ?? {};
    // The parent sends its own wrapper's user agent; without one the worker
    // still identifies itself, never the bare runtime default.
    this.fetch = makeWorkerFetch(hello.userAgent ?? DEFAULT_WORKER_USER_AGENT);
  }

  get agentDir(): string {
    return this.hello.agentDir;
  }

  e2eSeam(name: string): string | undefined {
    return this.seams[name];
  }

  now(): number {
    return Date.now();
  }

  credentials(cwd: string) {
    const parsed = parseHostCredentials(this.transport.request("credentials", { cwd }));
    if (!parsed.ok)
      throw new HostRequestError(
        `the parent's credentials reply was invalid: ${parsed.error}`,
        "credentials",
        "invalid-reply",
      );
    // The token is now known to this process: every reported error scrubs it.
    this.transport.addSecret(parsed.value.token);
    return parsed.value;
  }

  gitToken(host: string): string | undefined {
    const parsed = parseGitTokenReply(this.transport.request("gitToken", { host }));
    if (!parsed.ok)
      throw new HostRequestError(
        `the parent's gitToken reply was invalid: ${parsed.error}`,
        "gitToken",
        "invalid-reply",
      );
    // A saved token is now known to this process: every reported error scrubs it.
    if (parsed.value.token !== undefined) this.transport.addSecret(parsed.value.token);
    return parsed.value.token;
  }

  endpoints(cwd: string) {
    const parsed = parseHostEndpoints(this.transport.request("endpoints", { cwd }));
    if (!parsed.ok)
      throw new HostRequestError(
        `the parent's endpoints reply was invalid: ${parsed.error}`,
        "endpoints",
        "invalid-reply",
      );
    return parsed.value;
  }

  orgPolicy() {
    const parsed = parsePolicyReply(this.transport.request("policy"));
    if (!parsed.ok)
      throw new HostRequestError(
        `the parent's policy reply was invalid: ${parsed.error}`,
        "policy",
        "invalid-reply",
      );
    // Unknown or unanswered ids fall back to Kimchi's ungoverned default:
    // the parent answers effective policy for the ids it is asked about.
    return {
      resourceEnabled: (resourceId: string) => resourceEnabledFromPolicy(parsed.value, resourceId),
    };
  }

  telemetryConsent(): boolean {
    const parsed = parseConsentReply(this.transport.request("consent"));
    if (!parsed.ok)
      throw new HostRequestError(
        `the parent's consent reply was invalid: ${parsed.error}`,
        "consent",
        "invalid-reply",
      );
    return parsed.value.consent;
  }

  /** The user's PR-reporting consent, exactly like telemetryConsent: a live blocking request
   *  per call — never cached, so a mid-pass choice change is honored — with a timeout that
   *  fails the channel through a typed error rather than ever guessing a value. */
  reportingConsent(): "on" | "off" | "follow-telemetry" | undefined {
    const parsed = parseReportingConsentReply(this.transport.request("reportingConsent"));
    if (!parsed.ok)
      throw new HostRequestError(
        `the parent's reportingConsent reply was invalid: ${parsed.error}`,
        "reportingConsent",
        "invalid-reply",
      );
    return parsed.value.reportingConsent;
  }

  metric(metric: Parameters<HostPorts["metric"]>[0]): void {
    this.transport.send({ type: "metric", metric });
  }

  /** The write fence's heartbeat hook: throws LeaseHeartbeatLost once the parent's lease
   *  heartbeat has been silent past the window. Delegates to the transport, whose reader
   *  thread owns the heartbeat slot. */
  assertHeartbeatFresh(): void {
    this.transport.assertHeartbeatFresh();
  }

  /** The parent's user agent, or the worker's own identity when it sent none. */
  readonly fetch: HostPorts["fetch"];
}
