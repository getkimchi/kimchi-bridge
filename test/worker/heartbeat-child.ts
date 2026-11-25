/**
 * Real stdin-driven heartbeat-fence scenarios. The parent writes heartbeat lines while the
 * child samples the same transport used by the worker. Freshness follows only the helper's
 * arrival counter and the child's monotonic clock; wall offsets simulate host clock changes.
 *
 * Modes cover delayed construction/helper starts, quiet pipes, arrivals during main-thread
 * holds, forward/backward wall steps, live-parent recovery, and sustained CPU load. The
 * backward-hold and forward-back-hold summaries report a check immediately after the hold
 * and another after overdue anchors. Live-hold proves the accepted false refusal recovers.
 * Summaries are JSON on stderr; stdout is reserved for the transport's own messages.
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

/** Wall offsets simulate host clock corrections without affecting the monotonic fence. */
const realDateNow = Date.now;
const clock = { offset: 0 };
function setWallOffset(offset: number): void {
  clock.offset = offset;
  Date.now = () => realDateNow() + clock.offset;
}
let beats = 0;
let signalJump: (() => void) | undefined;
const jumped = new Promise<void>((resolve) => {
  signalJump = resolve;
});

function onEvent(event: TransportEvent): void {
  if (event.kind !== "message" || event.message.type !== "heartbeat") return;
  beats++;
  if (beats < Number(process.env.KIMCHI_WORKER_TEST_JUMP_AT_BEAT ?? 8) || clock.offset !== 0)
    return;
  setWallOffset(-Number(process.env.KIMCHI_WORKER_TEST_JUMP_MS ?? 10_000));
  report({ mode, phase: "jumped" });
  signalJump?.();
  signalJump = undefined;
}

const transport = new StdioTransport(
  mode === "clock-jump" || mode === "backward-live" ? onEvent : () => {},
);

function readFence(): { ageMs: number; refused: boolean } {
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  return { ageMs: transport.heartbeatAgeMs(), refused };
}

async function sampleFence(rounds: number): Promise<{ ageMs: number; refused: boolean }[]> {
  const samples: { ageMs: number; refused: boolean }[] = [];
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    samples.push(readFence());
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
    /* A real block: the main thread (and its arrival anchor timer) is held. */
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
  // A heartbeat arrives at the start of a multi-second main-thread hold. The overdue
  // observation keeps the preceding fire as its lower bound, so the age covers the hold.
  report({ mode, phase: "converge" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  report({ mode, phase: "block" });
  const holdMs = Number(process.env.KIMCHI_WORKER_TEST_HOLD_MS ?? 2200);
  const start = Date.now();
  while (Date.now() - start < holdMs) {
    /* A real multi-second block: the main thread (and its anchor timer) is held. */
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
  // The parent stops after a backward wall step. Arrival order and monotonic time still age
  // out the fence. The cap keeps the wait self-terminating without its triggering heartbeat.
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
  // Delay the helper's first action, queue heartbeats, and check after a silent wait.
  // Draining notes late cannot refresh the monotonic arrival lower bound.
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
} else if (mode === "backward-hold" || mode === "forward-back-hold") {
  report({ mode, phase: "converge" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (mode === "forward-back-hold") setWallOffset(60_000);
  report({ mode, phase: "block" });
  const holdMs = Number(process.env.KIMCHI_WORKER_TEST_HOLD_MS ?? 2200);
  const start = realDateNow();
  let corrected = false;
  while (realDateNow() - start < holdMs) {
    if (!corrected && realDateNow() - start >= 500) {
      setWallOffset(mode === "forward-back-hold" ? 0 : -10_000);
      corrected = true;
      report({ mode, phase: "jumped" });
    }
  }
  const immediate = readFence();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const afterTimer = readFence();
  transport.close();
  report({ mode, phase: "summary", immediate, afterTimer });
} else if (mode === "backward-live") {
  const samples = await sampleFence(Number(process.env.HEARTBEAT_SAMPLES ?? 14));
  transport.close();
  report({ mode, phase: "summary", samples });
} else if (mode === "live-hold") {
  report({ mode, phase: "converge" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  report({ mode, phase: "block" });
  const holdMs = Number(process.env.KIMCHI_WORKER_TEST_HOLD_MS ?? 2200);
  const start = realDateNow();
  while (realDateNow() - start < holdMs) {
    /* The helper keeps receiving while the main thread cannot observe anchors. */
  }
  const immediate = readFence();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const recovered = readFence();
  transport.close();
  report({ mode, phase: "summary", immediate, recovered });
} else if (mode === "live-load") {
  // A live parent is never refused while anchors stay punctual. Spin workers compete for
  // CPU with the anchor timer and helper, and stop on the shared flag or after 30 s.
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
          /* Spin: concurrent CPU load for the arrival anchor timer to compete with. */
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
