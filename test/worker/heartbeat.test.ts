import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import {
  heartbeatTimeoutMs,
  HEARTBEAT_TIMEOUT_MS,
  LeaseHeartbeatLost,
  StdioTransport,
} from "../../src/worker/host-client.js";
import { HEARTBEAT_TIMEOUT_MS as PROTOCOL_HEARTBEAT_TIMEOUT_MS } from "../../src/worker/protocol.js";

const ROOT = join(import.meta.dir, "../..");

/**
 * The heartbeat fence's clock: the helper thread counts heartbeat ARRIVALS in shared memory
 * and the main thread anchors that count against its own monotonic clock, so no age is ever
 * converted between the two threads' clocks (the estimator that seven review rounds each
 * found a new race in). The ages below are therefore upper bounds — the time since the last
 * anchor plus the anchor bound (100 ms) — which a backward wall-clock move cannot shrink, and
 * which stay inside proper-lockfile's 5 s stale-lock interval whatever the environment asks
 * for. The check is also cheap: two loads and arithmetic, safe inside the fenced transaction.
 */

const transports: StdioTransport[] = [];
afterEach(() => {
  while (transports.length) transports.pop()?.close();
});

it("a backward wall-clock move cannot turn a stale heartbeat fresh", async () => {
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  // No heartbeat ever arrives; the fence window is a test-short 400 ms. The wall clock then
  // jumps 10 seconds backwards: the age must still be measured against real elapsed monotonic
  // time, so the fence refuses once the window elapses.
  const realNow = Date.now();
  const dateNow = Date.now;
  Date.now = () => realNow - 10_000;
  try {
    // The startup anchor bounds the age by the time since construction plus the anchor
    // bound: small right after construction, and finite from the start.
    expect(transport.heartbeatAgeMs()).toBeLessThan(250);
    await new Promise((resolve) => setTimeout(resolve, 500));
    let refused: LeaseHeartbeatLost | undefined;
    try {
      transport.assertHeartbeatFresh(400);
    } catch (error) {
      refused = error instanceof LeaseHeartbeatLost ? error : undefined;
    }
    expect(refused).toBeInstanceOf(LeaseHeartbeatLost);
    // The age the refusal reports is real elapsed time plus the anchor bound, not the
    // moved-back wall clock.
    expect(refused?.ageMs).toBeGreaterThanOrEqual(400);
    expect(refused?.ageMs).toBeLessThan(5_000);
  } finally {
    Date.now = dateNow;
  }
});

it("a main thread held past the window with no arrivals cannot turn the fence fresh", async () => {
  // The main thread is blocked past the fence window and no heartbeat arrives, so the
  // anchor timer cannot fire during the block either. The startup anchor — the transport's
  // construction on the main thread's own clock — still bounds the age, so once the block
  // ends the fence refuses with the age covering the whole silent span. (The pre-fix
  // mechanism this replaced calibrated a cross-thread offset from notes queued behind the
  // block; the drained calibration erased the block from every age.)
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  const start = Date.now();
  const blockedUntil = start + 350;
  while (Date.now() < blockedUntil) {
    /* A real block: the anchor timer cannot fire until it ends. */
  }
  const blockedFor = Date.now() - start;
  expect(blockedFor).toBeGreaterThanOrEqual(340);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const age = transport.heartbeatAgeMs();
  // The age covers the whole silent span since the transport's construction, not just the
  // time since the block ended.
  expect(age).toBeGreaterThanOrEqual(350);
  expect(age).toBeLessThan(5_000);
  let refused: LeaseHeartbeatLost | undefined;
  try {
    transport.assertHeartbeatFresh(100);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost ? error : undefined;
  }
  expect(refused).toBeInstanceOf(LeaseHeartbeatLost);
});

it("a heartbeat's staleness tracks real elapsed time on a quiet pipe", async () => {
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  expect(transport.heartbeatAgeMs()).toBeLessThan(250);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // With no heartbeat arriving, the age grew with real time and passes the short window.
  expect(transport.heartbeatAgeMs()).toBeGreaterThanOrEqual(250);
  expect(() => transport.assertHeartbeatFresh(100)).toThrow(LeaseHeartbeatLost);
});

it("a stuck reader thread fails closed: no arrivals, no anchor advances", async () => {
  // The helper thread is alive but never reads a heartbeat. Although the anchor timer keeps
  // firing (the wait below spans far more than two periods), no fire may move the anchor
  // without a new arrival — an anchor that advanced on silence would misdate the last real
  // arrival as fresh. now - anchor therefore grows monotonically on the main thread's own
  // clock, and the fence refuses after the window.
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  const early = transport.heartbeatAgeMs();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const late = transport.heartbeatAgeMs();
  // The fires did not re-anchor: the age grew by (at least) the real elapsed time.
  expect(late).toBeGreaterThanOrEqual(early + 200);
  expect(late).toBeLessThan(5_000);
  expect(() => transport.assertHeartbeatFresh(200)).toThrow(LeaseHeartbeatLost);
});

it("consecutive checks never report a smaller age with no new arrival anchored", async () => {
  // The monotonicity property the upper-bound argument rests on: with no arrival to anchor,
  // the anchor cannot move, so the reported age can only grow with the main thread's own
  // clock — across busy stretches (no timer fires at all) and event-loop turns alike.
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  let previous = transport.heartbeatAgeMs();
  for (let index = 0; index < 60; index++) {
    const spinUntil = performance.now() + 2;
    while (performance.now() < spinUntil) {
      /* Busy: the anchor timer cannot fire. */
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const age = transport.heartbeatAgeMs();
    expect(age).toBeGreaterThanOrEqual(previous);
    previous = age;
  }
  expect(previous).toBeGreaterThan(300);
});

it("the heartbeat window clamps above the proper-lockfile stale interval and keeps test-short values", () => {
  // Shorter values stay: the tests tighten the window through the environment.
  expect(heartbeatTimeoutMs({ KIMCHI_WORKER_HEARTBEAT_TIMEOUT_MS: "50" })).toBe(50);
  expect(heartbeatTimeoutMs({ KIMCHI_WORKER_HEARTBEAT_TIMEOUT_MS: "0" })).toBe(0);
  // Values at or above the protocol's timeout clamp to it: an override that reached the 5 s
  // proper-lockfile stale window would defeat the old-release fence the timeout exists for.
  expect(heartbeatTimeoutMs({ KIMCHI_WORKER_HEARTBEAT_TIMEOUT_MS: "2000" })).toBe(2000);
  expect(heartbeatTimeoutMs({ KIMCHI_WORKER_HEARTBEAT_TIMEOUT_MS: "5000" })).toBe(2000);
  expect(heartbeatTimeoutMs({ KIMCHI_WORKER_HEARTBEAT_TIMEOUT_MS: "9000" })).toBe(2000);
  // Garbage and absence keep the default.
  expect(heartbeatTimeoutMs({ KIMCHI_WORKER_HEARTBEAT_TIMEOUT_MS: "soon" })).toBe(2000);
  expect(heartbeatTimeoutMs({})).toBe(2000);
});

it("the timeout constant is shared through the worker-protocol export", () => {
  // The parent (K2) reads the contract from @getkimchi/kimchi-bridge/worker-protocol only;
  // the host client re-exports the same value, and it stays inside the 5 s stale-lock window.
  expect(PROTOCOL_HEARTBEAT_TIMEOUT_MS).toBe(2000);
  expect(HEARTBEAT_TIMEOUT_MS).toBe(PROTOCOL_HEARTBEAT_TIMEOUT_MS);
  expect(HEARTBEAT_TIMEOUT_MS).toBeLessThan(5000);
});

/** Writes one real heartbeat line into a child's stdin, as the parent does over the pipe. */
async function sendHeartbeat(stdin: Bun.FileSink): Promise<void> {
  stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
  await stdin.flush();
}

/** Parses the child's last stderr line as its summary. */
function lastSummary(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
}

it("a slow helper construction stops rejecting live heartbeats once a prompt one arrives", async () => {
  // The helper thread's construction is stretched 600 ms past the fence window (scheduler
  // pressure, a paused process) while the parent keeps heartbeating at the required cadence.
  // The startup anchor is sampled before the stretch, so it only overstates ages through
  // it; the anchor timer re-anchors on the queued heartbeats the helper reads once it
  // starts, and the ages then track the fresh arrivals instead of the construction delay.
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, "test/worker/heartbeat-child.ts"), "slow-construction"],
    cwd: ROOT,
    env: {
      ...process.env,
      KIMCHI_WORKER_TEST_CONSTRUCT_DELAY_MS: "600",
      HEARTBEAT_WINDOW_MS: "500",
      HEARTBEAT_SAMPLES: "12",
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrText = new Response(child.stderr).text();
  // The parent heartbeats every 100 ms for the child's whole run, including the delayed
  // construction: the lines queue in the pipe and the helper reads them once it starts.
  const feeder = (async () => {
    for (let index = 0; index < 30; index++) {
      try {
        await sendHeartbeat(child.stdin);
      } catch {
        // The child has exited; the pipe is gone. Its summary is already complete.
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const [code] = await Promise.all([child.exited, feeder]);
  const lines = (await stderrText).split("\n").filter((line) => line.trim() !== "");
  expect(code).toBe(0);
  const summary = lastSummary(lines) as { samples?: { ageMs: number; refused: boolean }[] };
  const samples = summary.samples ?? [];
  expect(samples).toHaveLength(12);
  // The startup anchor never outlives the first queued heartbeat: within the first couple
  // of samples the ages track the 100 ms heartbeat cadence (never the 600 ms construction
  // delay), and once accepted the live parent's writes STAY allowed instead of being refused
  // for the transport's lifetime.
  const lastRefused = samples.map((sample) => sample.refused).lastIndexOf(true);
  expect(lastRefused).toBeLessThan(3);
  for (const sample of samples.slice(lastRefused + 1)) {
    expect(sample.refused).toBe(false);
    expect(sample.ageMs).toBeLessThan(500);
  }
  expect(samples.length - lastRefused - 1).toBeGreaterThanOrEqual(10);
}, 20_000);

it("a late handshake never locks a live heartbeating parent out for the transport's lifetime", async () => {
  // The round-6 reproduced defect (failure-011): the transport's construction is stretched
  // 2.1 s past the fence window while the parent keeps heartbeating every 100 ms. The old
  // design's construction handshake could miss, leaving its conservative fallback in force
  // for the transport's lifetime — 12/12 samples refused at ~2189 ms ages against the
  // production 2 s fence. The anchored design has no handshake to miss: the startup anchor
  // covers the stretch and the live heartbeats re-anchor as they arrive, so the live
  // parent's writes are allowed again — and stay allowed.
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, "test/worker/heartbeat-child.ts"), "lockout"],
    cwd: ROOT,
    env: {
      ...process.env,
      KIMCHI_WORKER_TEST_CONSTRUCT_DELAY_MS: "2100",
      HEARTBEAT_WINDOW_MS: "2000",
      HEARTBEAT_SAMPLES: "12",
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrText = new Response(child.stderr).text();
  const feeder = (async () => {
    for (let index = 0; index < 60; index++) {
      try {
        await sendHeartbeat(child.stdin);
      } catch {
        // The child has exited; the pipe is gone. Its summary is already complete.
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const [code] = await Promise.all([child.exited, feeder]);
  const lines = (await stderrText).split("\n").filter((line) => line.trim() !== "");
  expect(code).toBe(0);
  const summary = lastSummary(lines) as { samples?: { ageMs: number; refused: boolean }[] };
  const samples = summary.samples ?? [];
  expect(samples).toHaveLength(12);
  // The lockout is not permanent: once the construction ends, the queued heartbeats anchor
  // and every sample tracks the 100 ms cadence (never the ~2.1 s construction delay the
  // pre-fix fallback baked into every age).
  const lastRefused = samples.map((sample) => sample.refused).lastIndexOf(true);
  expect(lastRefused).toBeLessThan(3);
  for (const sample of samples.slice(lastRefused + 1)) {
    expect(sample.refused).toBe(false);
    expect(sample.ageMs).toBeLessThan(500);
  }
  expect(samples.length - lastRefused - 1).toBeGreaterThanOrEqual(8);
}, 25_000);

it("a helper whose first action is delayed past the window keeps accepting live heartbeats", async () => {
  // The helper thread's ACTUAL first action is delayed past the fence window (scheduler
  // starvation at worker startup) while the parent keeps heartbeating at the required
  // cadence; the queued lines are read once the helper starts. Before that first action no
  // arrival has been counted, so the fence refuses (the startup anchor keeps the ages
  // growing — the safe direction, the delayed start itself covered by it). Once the helper
  // reads the queued heartbeats, the live parent's writes are allowed again and STAY
  // allowed: every sample from the first acceptance on tracks the 100 ms heartbeat cadence.
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, "test/worker/heartbeat-child.ts"), "slow-helper"],
    cwd: ROOT,
    env: {
      ...process.env,
      KIMCHI_WORKER_TEST_HELPER_START_DELAY_MS: "2000",
      HEARTBEAT_WINDOW_MS: "500",
      HEARTBEAT_SAMPLES: "40",
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrText = new Response(child.stderr).text();
  const feeder = (async () => {
    for (let index = 0; index < 50; index++) {
      try {
        await sendHeartbeat(child.stdin);
      } catch {
        // The child has exited; the pipe is gone. Its summary is already complete.
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const [code] = await Promise.all([child.exited, feeder]);
  const lines = (await stderrText).split("\n").filter((line) => line.trim() !== "");
  expect(code).toBe(0);
  const summary = lastSummary(lines) as { samples?: { ageMs: number; refused: boolean }[] };
  const samples = summary.samples ?? [];
  expect(samples).toHaveLength(40);
  // During the helper's delayed start the fence refuses (the startup anchor keeps the ages
  // growing past the window — the safe direction, the delayed start itself covered by it):
  // the last refusal sits well into the 2 s delay, proving the hook's silence was real.
  const lastRefused = samples.map((sample) => sample.refused).lastIndexOf(true);
  expect(lastRefused).toBeGreaterThanOrEqual(15);
  // Once the helper reads the queued heartbeats, the live parent's writes are allowed again
  // and STAY allowed: every sample after the last refusal tracks the 100 ms heartbeat
  // cadence, never the 2 s startup delay, and the recovery leaves at least a quarter of the
  // run's samples accepted, not a fluke at the boundary.
  for (const sample of samples.slice(lastRefused + 1)) {
    expect(sample.refused).toBe(false);
    expect(sample.ageMs).toBeLessThan(500);
  }
  expect(samples.length - lastRefused - 1).toBeGreaterThanOrEqual(10);
}, 20_000);

it("a heartbeat arriving during a bounded main-thread hold still ages from its arrival", async () => {
  // A heartbeat can land while the main thread is held (a scheduler pause bounded by the
  // anchor bound — the fence's one residual assumption, which this 90 ms hold respects).
  // The hold only delays the anchor that observes the arrival, so once the parent then
  // goes silent past the window the fence still refuses with the age covering the silence
  // since that arrival. (The pre-fix mechanism calibrated its cross-thread offset from the
  // heartbeat's late-delivered note, erasing the hold from every age instead.)
  const child = spawn("bun", [join(ROOT, "test/worker/heartbeat-child.ts"), "late-heartbeat"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HEARTBEAT_WINDOW_MS: "400",
      KIMCHI_WORKER_TEST_HOLD_MS: "90",
      KIMCHI_WORKER_TEST_SILENCE_MS: "600",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const lines: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => lines.push(String(line)));
  const saw = (phase: string) => lines.some((line) => line.includes(`"phase":"${phase}"`));
  for (let round = 0; round < 30 && !saw("block"); round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(saw("block")).toBe(true);
  // Exactly one more heartbeat lands ~40 ms into the child's 90 ms hold; the parent then
  // goes silent, so the write happens ~640 ms after that arrival — past the 400 ms window.
  await new Promise((resolve) => setTimeout(resolve, 40));
  child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(0);
  const summary = lines
    .map((line) => {
      try {
        return JSON.parse(line) as { phase?: string; ageMs?: number; refused?: boolean };
      } catch {
        return {} as { phase?: string; ageMs?: number; refused?: boolean };
      }
    })
    .find((note) => note.phase === "summary");
  expect(summary).toBeDefined();
  expect(summary?.refused).toBe(true);
  expect(summary?.ageMs ?? 0).toBeGreaterThanOrEqual(600);
  expect(summary?.ageMs ?? Infinity).toBeLessThan(2_000);
}, 20_000);

it("a post-wake deschedule across the fence window never reads the silence as fresh", async () => {
  // The round-7 reproduced defect (failure-012 / security-006): the main thread was
  // descheduled right after the old lazy re-sync woke up, the estimated cross-thread offset
  // absorbed the whole pause, and a stale heartbeat read as fresh — the probe reported
  // refused:false at an age of 0.046 ms after 5,861 ms of silence. The anchored fence never
  // converts between the two threads' clocks: the helper-start hook below delays the reader
  // thread's first action past the old design's handshake bound while the parent keeps
  // heartbeating; the parent then goes silent, and the child's wait spans the window on the
  // main thread's own clock. The check after it must refuse with the age covering the whole
  // silence since the last arrival.
  const child = spawn("bun", [join(ROOT, "test/worker/heartbeat-child.ts"), "post-wake"], {
    cwd: ROOT,
    env: {
      ...process.env,
      KIMCHI_WORKER_TEST_HELPER_START_DELAY_MS: "600",
      HEARTBEAT_WINDOW_MS: "500",
      HEARTBEAT_WAIT_MS: "2000",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const lines: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => lines.push(String(line)));
  // The parent heartbeats every 100 ms for the first ~1.2 s of the run — past the helper's
  // delayed start — and then goes silent: the last arrival is ~900 ms before the child's
  // check, well past the 500 ms window.
  for (let round = 0; round < 12; round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(0);
  const summary = lines
    .map((line) => {
      try {
        return JSON.parse(line) as { phase?: string; ageMs?: number; refused?: boolean };
      } catch {
        return {} as { phase?: string; ageMs?: number; refused?: boolean };
      }
    })
    .find((note) => note.phase === "summary");
  expect(summary).toBeDefined();
  // The silence since the last heartbeat is well past the 500 ms window; the age the fence
  // computes must cover it (never the ~0 ms a post-wake-calibrated offset would report).
  expect(summary?.refused).toBe(true);
  expect(summary?.ageMs ?? 0).toBeGreaterThanOrEqual(600);
  expect(summary?.ageMs ?? Infinity).toBeLessThan(5_000);
}, 20_000);

it("a live parent is never refused across a thousand samples under concurrent CPU load", async () => {
  // The residual assumption's empirical bound: the anchor timer's fire-to-fire interval
  // stays under the anchor bound even while the machine is busy, so a parent heartbeating
  // at the required 100 ms cadence is never refused against the production 2 s fence. The
  // child runs three spin worker threads for the whole sampling run, competing with the
  // anchor timer and the helper thread for the CPU.
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, "test/worker/heartbeat-child.ts"), "live-load"],
    cwd: ROOT,
    env: {
      ...process.env,
      HEARTBEAT_WINDOW_MS: "2000",
      KIMCHI_WORKER_SAMPLES: "1000",
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrText = new Response(child.stderr).text();
  const feeder = (async () => {
    for (let index = 0; index < 120; index++) {
      try {
        await sendHeartbeat(child.stdin);
      } catch {
        // The child has exited; the pipe is gone. Its summary is already complete.
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const [code] = await Promise.all([child.exited, feeder]);
  const lines = (await stderrText).split("\n").filter((line) => line.trim() !== "");
  expect(code).toBe(0);
  const summary = lastSummary(lines) as {
    samples?: number;
    refused?: number;
    maxAgeMs?: number;
  };
  // Not one of the thousand samples is refused, and the ages stay far inside the window:
  // the anchor bound (100 ms) plus the heartbeat cadence (100 ms) plus scheduling jitter.
  expect(summary.samples).toBe(1000);
  expect(summary.refused).toBe(0);
  expect(summary.maxAgeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(1_500);
}, 40_000);
