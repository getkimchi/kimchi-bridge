/**
 * A child process for the heartbeat fence regressions (see heartbeat.test.ts). Its stdin is a
 * pipe the test drives: the parent writes real heartbeat lines on the wire, each stamped
 * with its own Date.now() at send exactly as the protocol requires, while the child samples
 * the transport's fence — the same shape as the parent process driving the worker over
 * stdio. No cross-thread clock conversion happens anywhere: the helper thread stores the
 * parent's stamp verbatim, and the main thread subtracts it from its monotonically
 * reconstructed wall time (a high-water mark plus a backward-regression accumulator).
 *
 * Modes (argv[2]):
 *  - "slow-construction" / "slow-helper" / "lockout": the availability regressions. The
 *    child samples the fence every 100 ms and reports each sample's age and refusal while
 *    the parent keeps heartbeating at the required cadence (the construction hook stretches
 *    the transport's construction, or the helper-start hook delays the reader thread's
 *    first action, past the fence window). The startup stamp covers the whole stretch:
 *    ages only read older through it, and the live heartbeats re-date the fence as they
 *    arrive.
 *  - "late-heartbeat": the parent heartbeats while the child settles, the child then holds
 *    its main thread for KIMCHI_WORKER_TEST_HOLD_MS while the parent delivers one more
 *    heartbeat, then goes silent for KIMCHI_WORKER_TEST_SILENCE_MS before the child checks
 *    the fence. The hold cannot re-date the arrival: its send stamp travels with the event.
 *  - "delayed-anchor": the C4a severe (failure-013 / security-007 / correctness-016 /
 *    design-009). The parent heartbeats until the child's multi-second main-thread hold
 *    begins (KIMCHI_WORKER_TEST_HOLD_MS) and delivers one final heartbeat at the hold's
 *    START, then goes silent. The hold cannot re-date that arrival — its send stamp travels
 *    with the event — so the post-hold check must refuse with the age covering the hold.
 *  - "clock-jump": the backward wall-clock regression between a heartbeat's send and the
 *    check. The child reads its wall through an offset seam; when the
 *    KIMCHI_WORKER_TEST_JUMP_AT_BEAT-th heartbeat arrives it steps its clock back
 *    KIMCHI_WORKER_TEST_JUMP_MS and reports "jumped", and the parent stops sending. The
 *    child then waits KIMCHI_WORKER_TEST_SILENCE_MS and checks: the reconstruction must
 *    keep the computed age at the true silence (a raw wall read would compute a negative
 *    age and accept forever).
 *  - "post-wake": the round-7 deschedule reproduction (failure-012 / security-006). The
 *    helper thread's first action is delayed past the old design's handshake bound (the
 *    helper-start hook); the parent heartbeats at the required cadence for the first part
 *    of the run and then goes silent, and the child checks the fence once its wait expires.
 *    The write must be refused with the age covering the silence since the last arrival.
 *  - "live-load": the no-lockout bound. The child takes KIMCHI_WORKER_SAMPLES fence samples
 *    ~5 ms apart under concurrent CPU load (spin worker threads that self-terminate on a
 *    shared stop flag and after a hard 30 s cap), with the parent heartbeating at the
 *    required 100 ms cadence throughout: a live parent is never refused.
 *
 * The summary goes to stderr as one JSON line; stdout carries only the transport's own
 * request lines (none in these scenarios).
 */
import { Worker } from "node:worker_threads";
import {
  LeaseHeartbeatLost,
  StdioTransport,
  type TransportEvent,
} from "../../src/worker/host-client.js";

const mode = process.argv[2] ?? "";
const windowMs = Number(process.env.HEARTBEAT_WINDOW_MS ?? 100);

function report(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

/** The clock-jump mode's offset seam: the transport reads its wall through this offset,
 *  and the arrival of the jump-triggering heartbeat steps it backwards mid-run. */
const clock = { offset: 0 };
let beats = 0;
let signalJump: (() => void) | undefined;
const jumped = new Promise<void>((resolve) => {
  signalJump = resolve;
});

function onEvent(event: TransportEvent): void {
  if (event.kind !== "message" || event.message.type !== "heartbeat") return;
  beats++;
  if (beats < Number(process.env.KIMCHI_WORKER_TEST_JUMP_AT_BEAT ?? 8)) return;
  clock.offset = -Number(process.env.KIMCHI_WORKER_TEST_JUMP_MS ?? 10_000);
  report({ mode, phase: "jumped" });
  signalJump?.();
  signalJump = undefined;
}

const transport = new StdioTransport(
  mode === "clock-jump" ? onEvent : () => {},
  mode === "clock-jump" ? { now: () => Date.now() + clock.offset } : undefined,
);

async function sampleFence(rounds: number): Promise<{ ageMs: number; refused: boolean }[]> {
  const samples: { ageMs: number; refused: boolean }[] = [];
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    let refused = false;
    try {
      transport.assertHeartbeatFresh(windowMs);
    } catch (error) {
      refused = error instanceof LeaseHeartbeatLost;
    }
    samples.push({ ageMs: transport.heartbeatAgeMs(), refused });
  }
  return samples;
}

if (mode === "slow-construction" || mode === "slow-helper" || mode === "lockout") {
  const samples = await sampleFence(Number(process.env.HEARTBEAT_SAMPLES ?? 14));
  transport.close();
  report({ mode, samples });
} else if (mode === "late-heartbeat") {
  const holdMs = Number(process.env.KIMCHI_WORKER_TEST_HOLD_MS ?? 500);
  const silenceMs = Number(process.env.KIMCHI_WORKER_TEST_SILENCE_MS ?? 30);
  report({ mode, phase: "converge" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  report({ mode, phase: "block" });
  const start = Date.now();
  while (Date.now() - start < holdMs) {
    /* A real block: the main thread (and the wall sampler with it) is held. */
  }
  await new Promise((resolve) => setTimeout(resolve, silenceMs));
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  const ageMs = transport.heartbeatAgeMs();
  transport.close();
  report({ mode, phase: "summary", ageMs, refused });
} else if (mode === "delayed-anchor") {
  // The C4a severe (failure-013 / security-007 / correctness-016 / design-009): a heartbeat
  // arrives at the START of a multi-second main-thread hold. The held thread cannot observe
  // the arrival until the hold ends; under the anchored design the first post-hold anchor
  // fire sampled the current arrival counter and re-dated that old heartbeat as just-now
  // (writes accepted after seconds of silence at ~132 ms ages). The parent-stamped design
  // carries the heartbeat's send time with the event, so the post-hold check must refuse
  // with the age covering the whole hold.
  report({ mode, phase: "converge" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  report({ mode, phase: "block" });
  const holdMs = Number(process.env.KIMCHI_WORKER_TEST_HOLD_MS ?? 2200);
  const start = Date.now();
  while (Date.now() - start < holdMs) {
    /* A real multi-second block: the main thread (and its wall sampler) is held. */
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  const ageMs = transport.heartbeatAgeMs();
  transport.close();
  report({ mode, phase: "summary", ageMs, refused });
} else if (mode === "clock-jump") {
  // The backward wall-clock regression between a heartbeat's send and the check: the last
  // heartbeat is stamped with the pre-jump clock, and the worker's wall then steps back. A
  // raw wall read would compute a negative age (silence minus the jump) and accept the
  // write forever; the reconstruction's high-water floors effective time at the last
  // observed wall reading, the next sample absorbs the step, and the age keeps tracking the
  // true silence — so the fence refuses. The 10 s cap keeps the wait self-terminating even
  // if the jump-triggering heartbeat never arrives.
  const silenceMs = Number(process.env.KIMCHI_WORKER_TEST_SILENCE_MS ?? 1200);
  const cap = setTimeout(() => signalJump?.(), 10_000);
  await jumped;
  clearTimeout(cap);
  await new Promise((resolve) => setTimeout(resolve, silenceMs));
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  const ageMs = transport.heartbeatAgeMs();
  transport.close();
  report({ mode, phase: "summary", ageMs, refused });
} else if (mode === "post-wake") {
  // The deschedule reproduction: the helper-start hook delayed the reader thread's first
  // action past the old design's handshake bound, so the pre-fix offset calibration rested
  // entirely on what happened after the queued notes drained. The child's single wait
  // expires while the (instrumented) deschedule still holds the main thread, so the fence
  // is sampled the moment the thread wakes — the first sample the round-7 probe took.
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.HEARTBEAT_WAIT_MS ?? 2000)),
  );
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  const ageMs = transport.heartbeatAgeMs();
  transport.close();
  report({ mode, phase: "summary", ageMs, refused });
} else if (mode === "live-load") {
  // The no-lockout bound: a live parent heartbeating at the required cadence is never
  // refused, even with the machine busy. The spin workers compete for the CPU with the
  // wall sampler (and the helper thread); each stops the moment the shared flag is set and
  // unconditionally after a hard 30 s cap, so nothing can hang.
  const samples = Number(process.env.KIMCHI_WORKER_SAMPLES ?? 1000);
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const hogs: Worker[] = [];
  for (let index = 0; index < 3; index++) {
    hogs.push(
      new Worker(
        `
        "use strict";
        const { workerData } = require("node:worker_threads");
        const stop = new Int32Array(workerData);
        const deadline = performance.now() + 30000;
        while (Atomics.load(stop, 0) === 0 && performance.now() < deadline) {
          /* Spin: concurrent CPU load for the wall sampler to compete with. */
        }
        `,
        { eval: true, workerData: stop.buffer },
      ),
    );
  }
  let refused = 0;
  let maxAgeMs = 0;
  for (let index = 0; index < samples; index++) {
    try {
      transport.assertHeartbeatFresh(windowMs);
    } catch (error) {
      if (error instanceof LeaseHeartbeatLost) refused++;
      else throw error;
    }
    maxAgeMs = Math.max(maxAgeMs, transport.heartbeatAgeMs());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  Atomics.store(stop, 0, 1);
  for (const hog of hogs) await hog.terminate();
  transport.close();
  report({ mode, samples, refused, maxAgeMs });
}
process.exit(0);
