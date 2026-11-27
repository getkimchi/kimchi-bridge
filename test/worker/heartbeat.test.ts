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
 * Heartbeat freshness uses only the helper's arrival counter and the main thread's monotonic
 * clock. Each changed counter is bounded by the actual preceding observation, including when
 * that observation was delayed. Wall-clock steps, queued notes and late timer fires therefore
 * cannot make silence fresh. A long main-thread hold can overstate age; later punctual
 * observations recover with a live parent.
 */

const transports: StdioTransport[] = [];
afterEach(() => {
  while (transports.length) transports.pop()?.close();
});

it("a backward wall-clock move cannot turn a stale heartbeat fresh", async () => {
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  // No heartbeat arrives. A backward wall step must not pause monotonic age or prevent the
  // no-arrival startup datum from expiring after the test-short window.
  const realNow = Date.now();
  const dateNow = Date.now;
  const started = performance.now();
  Date.now = () => realNow - 10_000 + (performance.now() - started);
  try {
    // The wall correction does not produce a negative age or any startup heartbeat credit.
    expect(transport.heartbeatAgeMs()).toBeLessThan(250);
    await new Promise((resolve) => setTimeout(resolve, 500));
    let refused: LeaseHeartbeatLost | undefined;
    try {
      transport.assertHeartbeatFresh(400);
    } catch (error) {
      refused = error instanceof LeaseHeartbeatLost ? error : undefined;
    }
    expect(refused).toBeInstanceOf(LeaseHeartbeatLost);
    // The age the refusal reports is real elapsed time since the startup stamp, not the
    // moved-back wall clock.
    expect(refused?.ageMs).toBeGreaterThanOrEqual(400);
    expect(refused?.ageMs).toBeLessThan(5_000);
  } finally {
    Date.now = dateNow;
  }
});

it("monotonic elapsed time advances without a timer sample", () => {
  let mono = 0;
  const transport = new StdioTransport(() => {}, { mono: () => mono });
  transports.push(transport);
  expect(transport.heartbeatAgeMs()).toBe(0);
  mono += 600;
  expect(transport.heartbeatAgeMs()).toBe(600);
  expect(() => transport.assertHeartbeatFresh(400)).toThrow(LeaseHeartbeatLost);
});

it("a forward wall-clock jump cannot create age or heartbeat credit", () => {
  const dateNow = Date.now;
  Date.now = () => dateNow() + 60_000;
  try {
    let mono = 0;
    const transport = new StdioTransport(() => {}, { mono: () => mono });
    transports.push(transport);
    expect(transport.heartbeatAgeMs()).toBe(0);
    mono += 400;
    expect(() => transport.assertHeartbeatFresh(2000)).not.toThrow();
    mono += 1_700;
    expect(() => transport.assertHeartbeatFresh(2000)).toThrow(LeaseHeartbeatLost);
  } finally {
    Date.now = dateNow;
  }
});

it("a main thread held past the window with no arrivals cannot turn the fence fresh", async () => {
  // With no arrivals, construction is the arrival lower bound. The main thread's monotonic
  // clock advances through a held interval even though no anchor can fire during it.
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  const start = Date.now();
  const blockedUntil = start + 350;
  while (Date.now() < blockedUntil) {
    /* A real block: the arrival anchor timer cannot fire until it ends. */
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

it("a stuck reader thread fails closed: no arrivals, no stamp refresh", async () => {
  // Anchor fires alone never refresh the counter or the arrival lower bound. Only a real
  // heartbeat can do that, so a stuck reader keeps aging the startup datum and refuses.
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  const early = transport.heartbeatAgeMs();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const late = transport.heartbeatAgeMs();
  // The stamp never refreshed: the age grew by (at least) the real elapsed time.
  expect(late).toBeGreaterThanOrEqual(early + 200);
  expect(late).toBeLessThan(5_000);
  expect(() => transport.assertHeartbeatFresh(200)).toThrow(LeaseHeartbeatLost);
});

it("consecutive checks never report a smaller age with no new arrival", async () => {
  // With no arrival to change the lower bound, consecutive checks cannot report less silence,
  // whether anchors were delayed by a busy stretch or fired normally between checks.
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  let previous = transport.heartbeatAgeMs();
  for (let index = 0; index < 60; index++) {
    const spinUntil = performance.now() + 2;
    while (performance.now() < spinUntil) {
      /* Busy: the arrival anchor timer cannot fire. */
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

function childScenario(mode: string, env: Record<string, string> = {}) {
  const child = spawn("bun", [join(ROOT, "test/worker/heartbeat-child.ts"), mode], {
    cwd: ROOT,
    env: { ...process.env, HEARTBEAT_WINDOW_MS: "500", ...env },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const lines: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => lines.push(String(line)));
  return { child, lines };
}

function summary<T>(lines: string[]): T {
  return lastSummary(lines.filter((line) => line.includes('"phase":"summary"'))) as T;
}

function hasPhase(lines: string[], phase: string): boolean {
  return lines.some((line) => line.includes(`"phase":"${phase}"`));
}

interface FenceSample {
  ageMs: number;
  refused: boolean;
}

it("a slow helper construction stops rejecting live heartbeats once a prompt one arrives", async () => {
  // The helper thread's construction is stretched 600 ms past the fence window (scheduler
  // pressure, a paused process) while the parent keeps heartbeating at the required cadence.
  // The startup stamp predates the stretch, so it only overstates ages through it; the
  // queued heartbeats the helper reads once it starts carry their own send stamps, and the
  // ages then track the fresh arrivals instead of the construction delay.
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
  // The startup stamp never outlives the first queued heartbeat: within the first couple
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
  // Construction stretches 2.1 s past the production fence window while the parent keeps
  // heartbeating every 100 ms. The startup lower bound covers that stretch, and subsequent
  // punctual arrival observations recover instead of locking the live parent out forever.
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
  // The lockout is not permanent: once the construction ends, the queued heartbeats refresh
  // the stamp and every sample tracks the 100 ms cadence (never the ~2.1 s construction
  // delay the pre-fix fallback baked into every age).
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
  // arrival has been stamped, so the fence refuses (the startup stamp keeps the ages
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
      HEARTBEAT_SAMPLES: "60",
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
  expect(samples).toHaveLength(60);
  // During the helper's delayed start the fence refuses (the startup stamp keeps the ages
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
  expect(samples.length - lastRefused - 1).toBeGreaterThanOrEqual(Math.ceil(samples.length / 4));
}, 20_000);

it("a heartbeat arriving during a bounded main-thread hold still ages from its arrival", async () => {
  // A heartbeat can land while the main thread is held (a scheduler pause — the hold only
  // delays the observation, never the event). The stamp travels with the arrival, so once
  // the parent then goes silent past the window the fence still refuses with the age
  // covering the silence since that send. (The pre-fix mechanism calibrated its cross-thread
  // offset from the heartbeat's late-delivered note, erasing the hold from every age
  // instead.)
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
  // The parent heartbeats every 100 ms while the child settles; the poll is tight (20 ms) so
  // the one heartbeat sent after the marker truly lands inside the child's 90 ms hold.
  for (let round = 0; round < 150 && !saw("block"); round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(saw("block")).toBe(true);
  // Exactly one more heartbeat lands ~40 ms into the child's 90 ms hold; the parent then
  // goes silent past the 400 ms window. A delayed observation cannot re-date the arrival
  // because its lower bound stays at the preceding observation or earlier.
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
  // The age covers the hold's remainder plus the 600 ms silence, minus the (tight) delay
  // between the marker and the send: at least the silence's bulk, never a re-dated ~0.
  expect(summary?.ageMs ?? 0).toBeGreaterThanOrEqual(500);
  expect(summary?.ageMs ?? Infinity).toBeLessThan(2_000);
}, 20_000);

it("a heartbeat at the start of a multi-second main-thread hold is never re-dated", async () => {
  // A heartbeat lands at the start of a 2.2 s main-thread hold. The overdue anchor must use
  // the actual preceding fire as its lower bound, so the post-hold age includes the hold
  // instead of restarting at the current fire.
  const child = spawn("bun", [join(ROOT, "test/worker/heartbeat-child.ts"), "delayed-anchor"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HEARTBEAT_WINDOW_MS: "500",
      KIMCHI_WORKER_TEST_HOLD_MS: "2200",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const lines: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => lines.push(String(line)));
  const saw = (phase: string) => lines.some((line) => line.includes(`"phase":"${phase}"`));
  // The parent heartbeats every 100 ms while the child converges, and keeps doing so until
  // the hold begins: the last line it writes lands at the hold's start and is the last
  // arrival the helper ever reads.
  for (let round = 0; round < 40 && !saw("block"); round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(saw("block")).toBe(true);
  // Exactly one more heartbeat lands at the hold's start; the parent then goes silent, so
  // the check happens ~2.3 s after that arrival — far past the 500 ms window.
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
  // The conservative age is at least the whole hold regardless of when the timer observes it.
  expect(summary?.refused).toBe(true);
  expect(summary?.ageMs ?? 0).toBeGreaterThanOrEqual(2000);
  expect(summary?.ageMs ?? Infinity).toBeLessThan(15_000);
}, 20_000);

it("a backward wall step during a held anchor interval refuses before and after overdue timers", async () => {
  const { child, lines } = childScenario("backward-hold", {
    KIMCHI_WORKER_TEST_HOLD_MS: "2200",
  });
  for (let round = 0; round < 40 && !hasPhase(lines, "block"); round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(hasPhase(lines, "block")).toBe(true);
  child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(0);
  const result = summary<{ immediate: FenceSample; afterTimer: FenceSample }>(lines);
  for (const sample of [result.immediate, result.afterTimer]) {
    expect(sample.refused).toBe(true);
    expect(sample.ageMs).toBeGreaterThanOrEqual(2000);
    expect(sample.ageMs).toBeLessThan(15_000);
  }
}, 20_000);

it("a future send stamp corrected during the same hold grants no heartbeat credit", async () => {
  const { child, lines } = childScenario("forward-back-hold", {
    KIMCHI_WORKER_TEST_HOLD_MS: "2200",
  });
  for (let round = 0; round < 40 && !hasPhase(lines, "block"); round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(hasPhase(lines, "block")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  child.stdin.write(`{"type":"heartbeat","at":${Date.now() + 60_000}}\n`);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(0);
  const result = summary<{ immediate: FenceSample; afterTimer: FenceSample }>(lines);
  for (const sample of [result.immediate, result.afterTimer]) {
    expect(sample.refused).toBe(true);
    expect(sample.ageMs).toBeGreaterThanOrEqual(2000);
    expect(sample.ageMs).toBeLessThan(15_000);
  }
}, 20_000);

it("live heartbeats keep recovering after a backward wall step", async () => {
  const { child, lines } = childScenario("backward-live", {
    HEARTBEAT_WINDOW_MS: "2000",
    KIMCHI_WORKER_TEST_JUMP_AT_BEAT: "4",
    HEARTBEAT_SAMPLES: "14",
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  for (let round = 0; round < 30; round++) {
    try {
      const offset = hasPhase(lines, "jumped") ? -10_000 : 0;
      child.stdin.write(`{"type":"heartbeat","at":${Date.now() + offset}}\n`);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const code = await exited;
  expect(code).toBe(0);
  expect(hasPhase(lines, "jumped")).toBe(true);
  const result = summary<{ samples: FenceSample[] }>(lines);
  expect(result.samples).toHaveLength(14);
  expect(result.samples.every((sample) => !sample.refused)).toBe(true);
  expect(Math.max(...result.samples.map((sample) => sample.ageMs))).toBeLessThan(2000);
}, 20_000);

it("a long hold's false refusal recovers on later punctual live anchors", async () => {
  const { child, lines } = childScenario("live-hold", {
    KIMCHI_WORKER_TEST_HOLD_MS: "2200",
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  for (let round = 0; round < 40; round++) {
    try {
      child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const code = await exited;
  expect(code).toBe(0);
  const result = summary<{ immediate: FenceSample; recovered: FenceSample }>(lines);
  expect(result.immediate.refused).toBe(true);
  expect(result.immediate.ageMs).toBeGreaterThanOrEqual(2000);
  expect(result.recovered.refused).toBe(false);
  expect(result.recovered.ageMs).toBeLessThan(500);
}, 20_000);

it("a wall-clock regression between a heartbeat's send and the check keeps the age at the truth", async () => {
  // The parent stops after a backward wall step. Since freshness uses only arrival order and
  // monotonic time, the correction cannot create negative age or keep the worker writable.
  const child = spawn("bun", [join(ROOT, "test/worker/heartbeat-child.ts"), "clock-jump"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HEARTBEAT_WINDOW_MS: "500",
      KIMCHI_WORKER_TEST_JUMP_MS: "10000",
      KIMCHI_WORKER_TEST_JUMP_AT_BEAT: "8",
      KIMCHI_WORKER_TEST_SILENCE_MS: "1200",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const lines: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => lines.push(String(line)));
  const saw = (phase: string) => lines.some((line) => line.includes(`"phase":"${phase}"`));
  // The parent heartbeats every 100 ms until the child reports that its clock stepped
  // back, then goes silent: the regression sits between that last heartbeat's send and the
  // child's check ~1.2 s later.
  for (let round = 0; round < 150 && !saw("jumped"); round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(saw("jumped")).toBe(true);
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
  // The computed age is the true silence since the last send — at or above it, never the
  // negative age a raw wall read would produce — so the write is refused.
  expect(summary?.refused).toBe(true);
  expect(summary?.ageMs ?? 0).toBeGreaterThanOrEqual(600);
  expect(summary?.ageMs ?? Infinity).toBeLessThan(5_000);
}, 20_000);

it("a post-wake deschedule across the fence window never reads the silence as fresh", async () => {
  // The helper starts late, reads queued heartbeats, and the parent then goes silent past
  // the fence window. Draining notes or a delayed observation cannot re-date those arrivals
  // on the main thread's monotonic clock, so the write must be refused.
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
  // Punctual anchors track the required 100 ms cadence without reaching the 2 s timeout.
  // Three spin workers compete with the anchor timer and helper throughout the run.
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
  // the heartbeat cadence (100 ms) plus pipe transit and scheduling jitter.
  expect(summary.samples).toBe(1000);
  expect(summary.refused).toBe(0);
  expect(summary.maxAgeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(1_500);
}, 40_000);
