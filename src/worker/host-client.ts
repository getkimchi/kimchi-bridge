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

/** SharedArrayBuffer header (int32 slots, then the aligned 64-bit heartbeat slot) followed by
 *  the reply line's bytes. The heartbeat's arrival time lives in its own BigInt64 slot at an
 *  8-byte-aligned offset, measured on the reader thread's monotonic clock (see below). */
/** Slot 0 holds the state in its low bits and the owning request's rid above. */
const COMBINED = 0;
const LENGTH = 1;
const ACTIVE_PASS = 3;
const HEARTBEAT_OFFSET = 16;
/** Byte 24 (int32 slot 6): the helper's STARTED flag. The helper flips it only after its
 *  startup clock is in shared memory, and notifies it, so the main thread's construction-time
 *  handshake wait below wakes through the futex path — never the postMessage queue. */
const SYNC_STATE_OFFSET = 24;
/** Byte 32 (8-aligned BigInt64): the helper's startup clock, the same reading that seeds the
 *  shared heartbeat slot. Read by the handshake, never queued. */
const SYNC_CLOCK_OFFSET = 32;
const HEADER_BYTES = 40;
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
/** How long the construction-time start handshake waits for the helper thread's first
 *  action. A normally scheduled thread starts in single-digit milliseconds; a thread that
 *  cannot start within this bound leaves the offset uncalibrated from the handshake, and the
 *  startup note's conservative construction-derived fallback (which can only overstate ages)
 *  stays in force — heartbeat estimates are then never folded at all, the safe direction. */
const STARTUP_HANDSHAKE_MS = 250;
/** The delivery bound a heartbeat note must meet before its offset estimate may be folded:
 *  the estimate is the true offset plus the note's delivery latency, so a note that sat
 *  queued behind a blocked main thread would erase exactly that latency from every heartbeat
 *  age. A promptly delivered note (the common case) measures well under a millisecond; the
 *  reproduced defect delivered the first note ~450 ms late. */
const HEARTBEAT_NOTE_DELIVERY_BOUND_MS = 50;
/** The longest the main thread may block re-establishing the sync offset through the lazy
 *  shared-memory heartbeat handshake (see #resyncOffsetThroughHeartbeat): one heartbeat
 *  interval plus the delivery bound, capped, and only while the offset is uncalibrated. */
const RESYNC_MAX_WAIT_MS = 1000;

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

/** One note from the helper thread: a forwarded line, or a stdin condition. */
interface HelperNote {
  line?: string;
  /** When the helper read the line (ms since epoch): the true receipt time. */
  at?: number;
  /** The helper's monotonic clock (performance.now of its own thread): at startup, on the
   *  note with no line (the same reading that seeded the shared heartbeat slot), and on every
   *  heartbeat note, where it is the send time of that very heartbeat — the reading the main
   *  thread's running-minimum offset calibration below is estimated from. */
  clock?: number;
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
const hb = new BigInt64Array(workerData, ${HEARTBEAT_OFFSET}, 1);
const syncState = new Int32Array(workerData, ${SYNC_STATE_OFFSET}, 1);
const syncClock = new BigInt64Array(workerData, ${SYNC_CLOCK_OFFSET}, 1);
const payload = new Uint8Array(workerData, ${HEADER_BYTES});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_LINE_BYTES = 1048576;
const chunk = Buffer.alloc(65536);
let pending = "";
// The heartbeat clock is this thread's monotonic performance.now, never the wall clock: a
// backward wall-clock move (an NTP step) must not turn a stale heartbeat fresh. The worker
// thread's performance.now origin differs from the main thread's, so the first action reports
// this clock to the main thread twice — once through SHARED MEMORY with a futex wake (the
// construction-time handshake, whose reading carries no message-delivery latency) and once on
// the startup note, from which the main thread derives a conservative fallback offset from
// its own time BEFORE it constructed this thread (a value guaranteed to precede this thread's
// start, so no delivery delay can shrink an age); both sides then measure ages in the same
// monotonic domain. Every heartbeat's send time rides its forwarded note as well, so the
// main thread re-estimates the offset per heartbeat and keeps the running minimum of the
// estimates whose delivery is bounded — each estimate is the true offset plus that note's
// delivery latency, so the minimum converges toward the truth without ever dropping below
// it. The startup baseline below is the grace period the transport's construction used to
// seed itself with, and one reading both seeds the shared slot and rides the startup note,
// so the main thread's fallback calibration and the slot's baseline are the very same
// instant.
// Test-only hook: a delay inserted before this thread's first action, so a test can
// reproduce a helper whose actual start is delayed past the handshake bound and the fence
// window (scheduler starvation) without touching the main thread's clock samples. Zero
// (unset) keeps it dormant.
const TEST_HELPER_START_DELAY_MS = Number(process.env.KIMCHI_WORKER_TEST_HELPER_START_DELAY_MS || 0);
if (TEST_HELPER_START_DELAY_MS > 0) {
  const until = performance.now() + TEST_HELPER_START_DELAY_MS;
  while (performance.now() < until) {
    /* A real block: no first action, no store, no wake until it ends. */
  }
}
const startupClock = performance.now();
Atomics.store(hb, 0, BigInt(Math.round(startupClock)));
// The start handshake: the same startup clock reading also goes into shared memory and flips
// the STARTED flag AFTER it is in place, waking the main thread's bounded construction-time
// wait through the futex path — never the postMessage queue — so the main thread calibrates
// the cross-thread offset with no delivery latency at all.
Atomics.store(syncClock, 0, BigInt(Math.round(startupClock)));
Atomics.store(syncState, 0, 1);
Atomics.notify(syncState, 0);
parentPort.postMessage({ clock: startupClock });
// Test-only hook: a delay inserted between the reply checks and the
// publication, so a test can hold a checked reply across a request's
// timeout and the next request's start. Zero (unset) keeps it dormant.
const TEST_REPLY_DELAY_MS = Number(process.env.KIMCHI_WORKER_TEST_REPLY_DELAY_MS || 0);
const TEST_SLEEP = new Int32Array(new SharedArrayBuffer(4));
function forward(line, clock) {
  parentPort.postMessage(
    clock === undefined
      ? { line: line, at: Date.now() }
      : { line: line, at: Date.now(), clock: clock },
  );
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
  // The reader thread records each heartbeat's arrival directly in the shared buffer, so
  // a busy main thread still observes fresh data whenever it next checks. The arrival is
  // stamped on this thread's monotonic clock, not the parent's own clock value and not
  // the wall clock: staleness must not depend on either moving backwards. The stamped
  // reading rides the forwarded note too, so the main thread can estimate the constant
  // cross-thread offset from this very heartbeat's send time (see the main thread's
  // heartbeat-note handler): every estimate is the true offset plus the note's delivery
  // latency, an upper bound, so the minimum of them can only converge toward the truth
  // from the safe side.
  if (parsed.type !== "heartbeat" || typeof parsed.at !== "number") return;
  const at = Math.round(performance.now());
  Atomics.store(hb, 0, BigInt(at));
  // The futex wake lets a main thread blocked in the lazy re-handshake observe this arrival
  // the moment it lands — through shared memory, never the postMessage queue.
  Atomics.notify(hb, 0);
  return at;
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
  const heartbeatClock = heartbeat(parsed);
  forward(line, heartbeatClock);
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
  private readonly heartbeatSlot: BigInt64Array = new BigInt64Array(
    this.shared,
    HEARTBEAT_OFFSET,
    1,
  );
  /** The helper's STARTED flag and startup clock, read through the construction-time handshake. */
  private readonly syncState: Int32Array = new Int32Array(this.shared, SYNC_STATE_OFFSET, 1);
  private readonly syncClock: BigInt64Array = new BigInt64Array(this.shared, SYNC_CLOCK_OFFSET, 1);
  private readonly helper: Worker;
  private rid = 0;
  private closed = false;
  private readonly secrets = new Set<string>();
  /** The conservative fallback offset between the main thread's and the helper thread's monotonic
   *  clocks (both performance.now; their origins differ by the helper's startup): derived once from
   *  the main thread's time BEFORE it constructed the helper. The helper thread's own clock cannot
   *  have started before the Worker's construction began, so this sample always precedes the
   *  helper's clock origin — it understates the true offset by at most the construction's own
   *  duration, and therefore only ever overstates a heartbeat's age (refuse early, the safe
   *  direction). It is NEVER replaced: the startup note's clock includes the helper's whole
   *  in-thread startup delay, and subtracting that delay (as an earlier revision did) understates
   *  the true offset by the whole delay — a helper whose first action was delayed past the fence
   *  window would then refuse every live heartbeat for the transport's lifetime. A delivery-delayed
   *  startup note moves nothing here, so no note can shrink an age through it either. */
  #monoOffsetMs: number | undefined;
  /** The running MINIMUM of the per-heartbeat offset estimates: each estimate is the helper's
   *  send-time clock subtracted from the main thread's time when it handled that heartbeat's
   *  note, so each equals the true offset plus that note's delivery latency — an upper bound.
   *  The minimum can therefore only shrink toward the true offset, never below it: a
   *  late-delivered heartbeat (whose own estimate bakes its queuing delay) can never loosen an
   *  already-calibrated offset, and a prompt heartbeat converges it to the truth, dropping the
   *  construction-time staleness of the fallback above. Only notes whose delivery is bounded —
   *  measured against the handshake offset — are folded: a note queued behind a blocked main
   *  thread would otherwise erase exactly its queuing delay from every age. Undefined until a
   *  bounded note is handled, which keeps the conservative fallback in force. */
  #heartbeatOffsetMs: number | undefined;
  /** The cross-thread offset measured by the construction-time start handshake: the helper
   *  stores its startup clock in shared memory and wakes this thread's bounded wait through the
   *  futex path, so no postMessage queue — and no blocked event loop — can delay the reading.
   *  The wake follows the helper's store, so this is an upper bound on the true offset whose
   *  error is the futex wake latency (microseconds), not a message-delivery latency — PROVIDED the
   *  whole wait-and-read observation completed promptly: the main thread can be descheduled
   *  between the futex wake and the clock read, and that unbounded delay would fold itself into
   *  the offset (the reproduced defect calibrated a late first heartbeat to itself through it).
   *  The observation is therefore measured with monotonic timestamps around the entire wait, one
   *  post-wait reading is reused for the offset itself, and the offset is trusted only when that
   *  whole observation stayed inside the delivery bound — the wait's own window for the helper to
   *  start plus the bound would hide a deschedule inside it, and a slower (but healthy) start is
   *  still covered by the conservative fallback above, which only overstates ages by the
   *  construction's duration. Undefined when the helper did not start inside the handshake's
   *  bound, or the observation exceeded it — and then re-established later, while the parent
   *  keeps heartbeating, by the lazy shared-memory heartbeat handshake (#resyncOffsetThroughHeartbeat):
   *  a late construction handshake must never lock a live parent out of worker writes for the
   *  transport's lifetime (the round-6 failure-011 probe refused 12/12 samples at ~2189 ms ages
   *  against the production 2 s fence with real 100 ms heartbeats). */
  #syncOffsetMs: number | undefined;
  /** The helper clock of the last heartbeat note handled — the same domain as `note.clock`, so
   *  the difference of two of them is the parent's live heartbeat interval with no offset
   *  needed; it sizes the lazy re-handshake's wait below. */
  #lastHeartbeatClockMs: number | undefined;
  /** The main thread's monotonic clock immediately before the helper thread was constructed. */
  readonly #constructedAtMs: number;

  constructor(
    private readonly emit: (event: TransportEvent) => void,
    options?: { ridSeed?: number },
  ) {
    this.rid = options?.ridSeed ?? 0;
    // The heartbeat clock starts at the helper thread's startup (it seeds the shared slot and
    // reports its clock so this thread can derive the cross-thread offset above): the parent
    // has not had a chance to send one yet. From then on only the reader thread records
    // arrivals, so a parent that never heartbeats locks the worker out of writes after the
    // window — exactly the old-release fence decision 7 calls for.
    this.#constructedAtMs = performance.now();
    // Test-only hook: a delay inserted between the construction-time sampling above and the
    // helper thread's start, so a test can reproduce a Worker construction stretched past the
    // fence window (scheduler pressure, a paused process) without perturbing the clock
    // readings themselves. Zero (unset) keeps it dormant.
    const TEST_CONSTRUCT_DELAY_MS = Number(process.env.KIMCHI_WORKER_TEST_CONSTRUCT_DELAY_MS || 0);
    if (TEST_CONSTRUCT_DELAY_MS > 0) {
      const until = this.#constructedAtMs + TEST_CONSTRUCT_DELAY_MS;
      while (performance.now() < until) {
        /* A real block: the helper thread cannot start until it ends. */
      }
    }
    // The construction-time start handshake: the helper's first action puts its startup clock
    // in SHARED MEMORY and wakes this bounded wait through the futex path, so the reading
    // carries no postMessage delivery latency — no blocked event loop can stretch it. The
    // observation's start is sampled BEFORE the helper thread is constructed (the line
    // above): the helper can publish its startup clock — and read the parent's first
    // heartbeat — as soon as `new Worker` starts the thread, so a sample taken after the
    // construction returns would leave the gap between them unmeasured, and a deschedule
    // there inflated the offset while the observation looked prompt (the round-5 probe
    // delivered one heartbeat 50 ms into a 500 ms gap and read it back 31.8 ms fresh with
    // refused:false). Sampled before the construction, the measured window covers
    // EVERYTHING between the sample and the observation — the construction itself, the
    // helper's start, and any pause in between. The whole wait-and-read is additionally
    // bounded by monotonic timestamps (and one test-only hook can deschedule exactly the
    // post-wake read, reproducing the delayed observation); the resulting offset is the
    // only sound yardstick for bounding later notes' delivery, and it is trusted only when
    // the whole observation stayed inside the delivery bound — an observation descheduled
    // past it leaves the offset uncalibrated and the conservative fallback above in force
    // (which never folds a note, the safe direction).
    const handshakeStartedAt = performance.now();
    this.helper = new Worker(HELPER_SOURCE, { eval: true, workerData: this.shared });
    // Test-only hook: a delay inserted between the helper's construction and the handshake
    // wait — precisely the gap a pre-fix sample after the construction left unmeasured. The
    // helper thread has already started here and may already have published its startup
    // clock and read the parent's first heartbeat, so a block here is a real deschedule the
    // measured window must cover. Zero (unset) keeps it dormant.
    const TEST_GAP_DELAY_MS = Number(process.env.KIMCHI_WORKER_TEST_HANDSHAKE_GAP_MS || 0);
    if (TEST_GAP_DELAY_MS > 0) {
      const until = performance.now() + TEST_GAP_DELAY_MS;
      while (performance.now() < until) {
        /* A real deschedule-shaped block between the helper's start and the observation. */
      }
    }
    // The conservative fallback is pinned the moment the pre-construction sample exists: the
    // helper's clock cannot have started before it, and no later note — however delivered — can
    // move it (the startup note used to replace it with a value biased by the helper's whole
    // startup delay, locking a slow-started helper out of writes for the transport's lifetime).
    this.#monoOffsetMs = this.#constructedAtMs;
    Atomics.wait(this.syncState, 0, 0, STARTUP_HANDSHAKE_MS);
    const TEST_OBSERVE_DELAY_MS = Number(
      process.env.KIMCHI_WORKER_TEST_HANDSHAKE_OBSERVE_DELAY_MS || 0,
    );
    if (TEST_OBSERVE_DELAY_MS > 0) {
      const until = performance.now() + TEST_OBSERVE_DELAY_MS;
      while (performance.now() < until) {
        /* A real deschedule-shaped block between the futex wake and the clock read. */
      }
    }
    const observedAt = performance.now();
    if (
      Atomics.load(this.syncState, 0) === 1 &&
      observedAt - handshakeStartedAt <= HEARTBEAT_NOTE_DELIVERY_BOUND_MS
    ) {
      const helperClock = Number(Atomics.load(this.syncClock, 0));
      this.#syncOffsetMs = observedAt - helperClock;
    }
    this.helper.on("message", (note: HelperNote) => this.onHelperNote(note));
    this.helper.on("error", (error) => {
      this.transportError(`the stdin reader thread failed: ${String(error)}`);
    });
    this.helper.on("exit", (code) => {
      if (!this.closed)
        this.transportError(`the stdin reader thread exited unexpectedly (${code})`);
    });
  }

  /** How long ago the reader thread last saw a parent heartbeat, in milliseconds, measured on
   *  the monotonic clocks both threads share (never the wall clock, whose backward moves
   *  would turn a stale heartbeat fresh). */
  heartbeatAgeMs(): number {
    // The heartbeat-calibrated offset wins once any heartbeat has landed: it is an upper
    // bound that converges toward the true offset, while the construction-derived fallback
    // can only overstate ages (a slow helper construction would otherwise refuse every live
    // heartbeat for the transport's lifetime). Either way the arrival is the helper's
    // monotonic read time, never the wall clock.
    const offset = this.#heartbeatOffsetMs ?? this.#monoOffsetMs;
    if (offset === undefined) return Number.POSITIVE_INFINITY;
    const arrival = Number(Atomics.load(this.heartbeatSlot, 0));
    // A slot that never landed (the helper died before its first store) reads as ancient, not
    // as fresh: refusing writes is the safe direction.
    if (arrival === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, performance.now() - (arrival + offset));
  }

  /** Throws LeaseHeartbeatLost when no heartbeat arrived within the window; the write fence's
   *  assertWritable hook calls this inside every fenced ledger transaction. */
  assertHeartbeatFresh(timeoutMs: number = heartbeatTimeoutMs()): void {
    const age = this.heartbeatAgeMs();
    if (age > timeoutMs) throw new LeaseHeartbeatLost(age);
  }

  private transportError(reason: string): void {
    if (!this.closed) this.emit({ kind: "transport-error", reason });
  }

  /** Re-establishes #syncOffsetMs through a LATER, independently bounded shared-memory
   *  observation, after the construction handshake failed to calibrate (a helper that started
   *  slower than its bound, or an observation descheduled past it). The heartbeat slot is the
   *  channel: the helper stamps every heartbeat's arrival (its own monotonic clock) into the
   *  slot and wakes this thread's futex wait the moment it lands, so the observation carries no
   * postMessage latency — the same property the construction handshake has.
   *
   *  The bound: each Atomics.wait window lasts HEARTBEAT_NOTE_DELIVERY_BOUND_MS, and the store
   *  that changes the slot can only happen AFTER the window's opening load of the slot's value
   *  (a store before it would have been loaded as the new value). The reading taken when the
   *  change is detected therefore trails the helper's store by at most one window — the offset
   *  it yields overstates the true offset by at most the delivery bound, exactly the error the
   *  note-fold guard accepts, and ages are understated by at most that much, never more. A
   *  main thread descheduled through a window simply misses that heartbeat and retries on a
   *  later note: the failure direction is "stay conservative", never "calibrate a stale
   *  heartbeat as fresh".
   *
   *  The whole wait loop blocks the main thread at most the parent's observed heartbeat
   *  interval plus the delivery bound (capped), and only while the offset is uncalibrated —
   *  a state in which every fenced write is refused anyway. A parent that stops heartbeating
   *  stops sending notes, so this never runs for a dead parent at all. */
  #resyncOffsetThroughHeartbeat(gapMs: number): void {
    const slot = this.heartbeatSlot;
    const expected = Atomics.load(slot, 0);
    if (expected === 0n) return; // no heartbeat has ever landed; nothing to observe.
    const deadline =
      performance.now() +
      Math.min(Math.max(gapMs, 0) + HEARTBEAT_NOTE_DELIVERY_BOUND_MS, RESYNC_MAX_WAIT_MS);
    for (;;) {
      const windowStart = performance.now();
      if (windowStart >= deadline) return;
      // The window is bounded by the delivery bound even when it would cross the deadline:
      // a shorter window only misses heartbeats, it never widens the offset's error.
      const wait = Math.min(HEARTBEAT_NOTE_DELIVERY_BOUND_MS, deadline - windowStart);
      Atomics.wait(slot, 0, expected, wait);
      const arrival = Atomics.load(slot, 0);
      if (arrival !== expected) {
        const observedAt = performance.now();
        // observedAt - arrival overstates the true offset by at most the window above:
        // the store that wrote `arrival` happened after this iteration's `expected` load,
        // and the detection (futex wake or the post-wait load) trails it by less than one
        // bounded window.
        this.#syncOffsetMs = observedAt - Number(arrival);
        return;
      }
    }
  }

  private onHelperNote(note: HelperNote): void {
    if (note.clock !== undefined && note.line === undefined) {
      // The helper's startup clock report. The conservative fallback is already pinned to the
      // main thread's pre-construction sample — a lower bound no delivery delay and no helper
      // startup delay can move below the truth — so this note changes nothing: its own clock
      // reading includes the helper's whole in-thread startup delay, and an earlier revision
      // replaced the fallback with (pre-construction sample - that delay), understating the true
      // offset by the whole delay. A helper whose first action was delayed past the fence
      // window then refused every live heartbeat for the transport's lifetime; with the pinned
      // bound its ages overstate by at most the construction's own duration, so live
      // heartbeats pass the fence without any calibration at all.
      return;
    }
    if (note.line !== undefined) {
      if (note.clock !== undefined) {
        // A heartbeat note carrying its send time: estimate the cross-thread offset from
        // this very heartbeat. The estimate is the main thread's handling time minus the
        // helper's send time, which is the true offset plus the note's delivery latency
        // (postMessage queuing plus any main-thread block) — an UPPER bound: a heartbeat
        // whose note sat queued can only overstate the offset, never understate it. Keeping
        // the running minimum therefore cannot move the offset below the truth, while a
        // promptly delivered heartbeat converges it — availability restored after a slow
        // helper construction, whose stale fallback sample the minimum drops.
        //
        // The fold is guarded by delivery: only a note the main thread handled within
        // HEARTBEAT_NOTE_DELIVERY_BOUND_MS of its arrival may calibrate. The delivery is
        // measured against the handshake offset — an upper bound on the truth whose error is
        // the futex wake, not a queue — because any offset derived from a note's own handling
        // time would subtract exactly the latency being measured. Without the guard, the
        // FIRST note could be one that sat queued behind a blocked main thread: its estimate
        // would fold in its whole queuing delay and heartbeatAgeMs would erase that delay
        // from the heartbeat's real age, letting a stale parent's write pass the fence. When
        // the handshake never calibrated (the helper started slower than its bound), no note
        // is folded at all and the conservative fallback keeps refusing early.
        const estimate = performance.now() - note.clock;
        if (
          this.#syncOffsetMs !== undefined &&
          performance.now() - (note.clock + this.#syncOffsetMs) <=
            HEARTBEAT_NOTE_DELIVERY_BOUND_MS &&
          (this.#heartbeatOffsetMs === undefined || estimate < this.#heartbeatOffsetMs)
        )
          this.#heartbeatOffsetMs = estimate;
        // A heartbeat arrived while the sync offset is still uncalibrated: the construction
        // handshake missed (a slow helper start, a descheduled observation), and without a
        // later calibration the conservative fallback — which understates the true offset by
        // the whole construction delay — would refuse every live heartbeat for the
        // transport's lifetime. Re-establish the offset now through the bounded
        // shared-memory heartbeat handshake above; once it is calibrated, the delivery guard
        // starts folding prompt notes and the ages converge on the truth. The gap between
        // this note's send time and the previous one is the parent's live cadence — measured
        // in the helper's clock domain, so it needs no offset at all.
        if (this.#syncOffsetMs === undefined) {
          const gapMs =
            this.#lastHeartbeatClockMs === undefined
              ? HEARTBEAT_NOTE_DELIVERY_BOUND_MS
              : Math.max(0, note.clock - this.#lastHeartbeatClockMs);
          this.#resyncOffsetThroughHeartbeat(gapMs);
        }
        this.#lastHeartbeatClockMs = note.clock;
      }
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

  /** Stops the reader thread; the process is exiting anyway. */
  close(): void {
    this.closed = true;
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
