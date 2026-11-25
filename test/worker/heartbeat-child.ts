/**
 * A child process for the heartbeat fence regressions (see heartbeat.test.ts). Its stdin is a
 * pipe the test drives: the parent writes real heartbeat lines on the wire while the child
 * samples the transport's fence, so every age the child reports covers a real arrival read
 * by the real helper thread — the same shape as the parent process driving the worker over
 * stdio. Under the anchored fence no cross-thread clock conversion happens anywhere: the
 * helper counts arrivals, the main thread anchors them against its own clock, and the ages
 * below are the fence's upper bounds (elapsed-since-anchor plus the anchor bound).
 *
 * Modes (argv[2]):
 *  - "slow-construction" / "slow-helper" / "lockout": the availability regressions. The
 *    child samples the fence every 100 ms and reports each sample's age and refusal while
 *    the parent keeps heartbeating at the required cadence (the construction hook stretches
 *    the transport's construction, or the helper-start hook delays the reader thread's
 *    first action, past the fence window). The startup anchor covers the whole stretch:
 *    ages only read older through it, and the live heartbeats re-anchor as they arrive.
 *  - "late-heartbeat": the parent heartbeats while the child settles, the child then holds
 *    its main thread for KIMCHI_WORKER_TEST_HOLD_MS (kept inside the anchor bound, so the
 *    fence's upper-bound property still covers an arrival that lands during the hold)
 *    while the parent delivers one more heartbeat, then goes silent for
 *    KIMCHI_WORKER_TEST_SILENCE_MS before the child checks the fence.
 *  - "post-wake": the round-7 deschedule reproduction (failure-012 / security-006). The
 *    helper thread's first action is delayed past the old design's handshake bound (the
 *    helper-start hook); the parent heartbeats at the required cadence for the first part
 *    of the run and then goes silent, and the child checks the fence once its wait expires.
 *    The write must be refused with the age covering the silence since the last arrival.
 *    (On the pre-fix code, the same shape with a deterministic delay in the old resync's
 *    post-wake gap — the unobservable deschedule the round-7 reviewers instrumented —
 *    reported ageMs 0.046 / refused:false after 5,861 ms of silence.)
 *  - "live-load": the no-lockout bound. The child takes KIMCHI_WORKER_SAMPLES fence samples
 *    ~5 ms apart under concurrent CPU load (spin worker threads that self-terminate on a
 *    shared stop flag and after a hard 30 s cap), with the parent heartbeating at the
 *    required 100 ms cadence throughout: a live parent is never refused.
 *
 * The summary goes to stderr as one JSON line; stdout carries only the transport's own
 * request lines (none in these scenarios).
 */
import { Worker } from "node:worker_threads";
import { LeaseHeartbeatLost, StdioTransport } from "../../src/worker/host-client.js";

const mode = process.argv[2] ?? "";
const windowMs = Number(process.env.HEARTBEAT_WINDOW_MS ?? 100);

function report(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

const transport = new StdioTransport(() => {});

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
    /* A real block: the main thread (and the anchor timer with it) is held. */
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
  // anchor timer (and the helper thread); each stops the moment the shared flag is set and
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
          /* Spin: concurrent CPU load for the anchor timer to compete with. */
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
