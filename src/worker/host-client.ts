/**
 * The worker process's HostPorts (reconcile-out-of-process plan, chunk B3).
 *
 * HostPorts' credential, endpoint, policy and consent reads are synchronous and
 * are called at many synchronous sites inside the moved passes, whose timing
 * must not change now that they run in the worker. So the worker answers them
 * with a blocking RPC over its private stdin/stdout pipe:
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
  parseHostCredentials,
  parseHostEndpoints,
  parseParentLine,
  parsePolicyReply,
  parseConsentReply,
  redactTokens,
  resourceEnabledFromPolicy,
  type HostRequestKind,
  type ParentMessage,
  type WorkerMessage,
} from "./protocol.js";

/** The parent must answer a host request within this window. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** SharedArrayBuffer header (int32 slots) followed by the reply line's bytes. */
const STATE = 0;
const LENGTH = 1;
const RID = 2;
const ACTIVE_PASS = 3;
const HEADER_BYTES = 16;
/** The longest reply line (a credentials or policy answer is a few hundred bytes). */
const REPLY_BYTES = 64 * 1024;

const STATE_IDLE = 0;
const STATE_WAITING = 1;
const STATE_READY = 2;
const STATE_PARENT_GONE = 3;
const STATE_CANCELLED = 4;

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
const payload = new Uint8Array(workerData, ${HEADER_BYTES});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_LINE_BYTES = 1048576;
const chunk = Buffer.alloc(65536);
let pending = "";
function forward(line) { parentPort.postMessage({ line: line, at: Date.now() }); }
function reply(line, parsed) {
  if (Atomics.load(ia, ${STATE}) !== ${STATE_WAITING}) return false; // nobody is waiting
  if (parsed.rid !== Atomics.load(ia, ${RID})) return false; // late or stale reply
  const bytes = encoder.encode(line);
  if (bytes.length <= payload.length) { payload.set(bytes); Atomics.store(ia, ${LENGTH}, bytes.length); }
  else Atomics.store(ia, ${LENGTH}, -1);
  Atomics.store(ia, ${STATE}, ${STATE_READY});
  Atomics.notify(ia, ${STATE});
  return true;
}
function cancel(parsed) {
  // Fast wake: a cancel for the pass in flight must not sit behind a pending
  // request's timeout. The line is still forwarded for the main thread to own.
  if (parsed.id !== Atomics.load(ia, ${ACTIVE_PASS})) return;
  if (Atomics.load(ia, ${STATE}) !== ${STATE_WAITING}) return;
  Atomics.store(ia, ${STATE}, ${STATE_CANCELLED});
  Atomics.notify(ia, ${STATE});
}
function gone() {
  Atomics.store(ia, ${STATE}, ${STATE_PARENT_GONE});
  Atomics.notify(ia, ${STATE});
  parentPort.postMessage({ eof: true });
}
function onLine(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return forward(line); }
  if (parsed === null || typeof parsed !== "object") return forward(line);
  if (parsed.type === "reply" && typeof parsed.rid === "number" && reply(line, parsed)) return;
  if (parsed.type === "cancel" && typeof parsed.id === "number") cancel(parsed);
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

  constructor(private readonly emit: (event: TransportEvent) => void) {
    this.helper = new Worker(HELPER_SOURCE, { eval: true, workerData: this.shared });
    this.helper.on("message", (note: HelperNote) => this.onHelperNote(note));
    this.helper.on("error", (error) => {
      this.transportError(`the stdin reader thread failed: ${String(error)}`);
    });
    this.helper.on("exit", (code) => {
      if (!this.closed)
        this.transportError(`the stdin reader thread exited unexpectedly (${code})`);
    });
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
  request(kind: HostRequestKind, cwd?: string): unknown {
    // A parent that already died must not be overwritten by a new wait: the
    // reader thread is gone with it, so the request would never be answered.
    if (this.#pipeGone || Atomics.load(this.slots, STATE) === STATE_PARENT_GONE)
      throw new HostRequestError(
        `the parent is gone; the ${kind} request cannot be answered`,
        kind,
        "parent-gone",
      );
    const rid = ++this.rid;
    Atomics.store(this.slots, RID, rid);
    Atomics.store(this.slots, LENGTH, 0);
    Atomics.store(this.slots, STATE, STATE_WAITING);
    try {
      writeSync(
        1,
        encodeWorkerMessage({
          type: "request",
          rid,
          kind,
          ...(cwd === undefined ? {} : { cwd }),
        }),
      );
    } catch {
      // The parent died between the pre-check and the write: a failed request
      // write is parent death, reported through the typed error like the rest.
      Atomics.compareExchange(this.slots, STATE, STATE_WAITING, STATE_PARENT_GONE);
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
      STATE,
      STATE_WAITING,
      Math.ceil(Math.max(remaining, 0)),
    );
    if (waited === "timed-out") {
      Atomics.compareExchange(this.slots, STATE, STATE_WAITING, STATE_IDLE);
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
    const state = Atomics.load(this.slots, STATE);
    if (state === STATE_PARENT_GONE)
      throw new HostRequestError(
        `the parent is gone; the ${kind} request cannot be answered`,
        kind,
        "parent-gone",
      );
    if (state === STATE_CANCELLED) {
      Atomics.store(this.slots, STATE, STATE_IDLE);
      throw new HostRequestError(
        `the pass was canceled while the ${kind} request was pending`,
        kind,
        "canceled",
      );
    }
    const length = Atomics.load(this.slots, LENGTH);
    Atomics.store(this.slots, STATE, STATE_IDLE);
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
    const parsed = parseHostCredentials(this.transport.request("credentials", cwd));
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

  endpoints(cwd: string) {
    const parsed = parseHostEndpoints(this.transport.request("endpoints", cwd));
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

  metric(metric: Parameters<HostPorts["metric"]>[0]): void {
    this.transport.send({ type: "metric", metric });
  }

  /** The parent's user agent, or the worker's own identity when it sent none. */
  readonly fetch: HostPorts["fetch"];
}
