import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
 * The heartbeat fence's clock: heartbeat ages are measured on the monotonic clocks the reader
 * thread and the main thread share, so a backward wall-clock move (an NTP step) after the last
 * heartbeat cannot keep a stale worker writable beyond the window — and the window itself stays
 * inside proper-lockfile's 5 s stale-lock interval whatever the environment asks for.
 */

const transports: StdioTransport[] = [];
afterEach(() => {
  while (transports.length) transports.pop()?.close();
});

/** A transport whose helper thread has reported its startup clock, so ages are measurable. */
async function startedTransport(): Promise<StdioTransport> {
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  for (let round = 0; round < 100; round++) {
    if (transport.heartbeatAgeMs() !== Number.POSITIVE_INFINITY) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(transport.heartbeatAgeMs()).not.toBe(Number.POSITIVE_INFINITY);
  return transport;
}

it("a backward wall-clock move cannot turn a stale heartbeat fresh", async () => {
  const transport = await startedTransport();
  // No heartbeat ever arrives; the fence window is a test-short 100 ms. The wall clock then
  // jumps 10 seconds backwards: the age must still be measured against real elapsed monotonic
  // time, so the fence refuses once the window elapses.
  const realNow = Date.now();
  const dateNow = Date.now;
  Date.now = () => realNow - 10_000;
  try {
    expect(transport.heartbeatAgeMs()).toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let refused: LeaseHeartbeatLost | undefined;
    try {
      transport.assertHeartbeatFresh(100);
    } catch (error) {
      refused = error instanceof LeaseHeartbeatLost ? error : undefined;
    }
    expect(refused).toBeInstanceOf(LeaseHeartbeatLost);
    // The age the refusal reports is real elapsed time, not the moved-back wall clock.
    expect(refused?.ageMs).toBeGreaterThanOrEqual(100);
    expect(refused?.ageMs).toBeLessThan(5_000);
  } finally {
    Date.now = dateNow;
  }
});

it("a startup clock note delivered late cannot turn a stale heartbeat fresh", async () => {
  // The helper posts its startup clock while the main thread is blocked past the heartbeat
  // window and no heartbeat arrives; the note sits queued until the main thread yields. The
  // offset must be calibrated from the main thread's time BEFORE it constructed the helper
  // — a bound no delivery delay can move — so the age after the note finally drains still
  // covers the whole silent span. (An offset calibrated at note handling would subtract the
  // queuing delay from every age: ~350 ms silent read as ~20 ms fresh.)
  const transport = new StdioTransport(() => {});
  transports.push(transport);
  const start = Date.now();
  const blockedUntil = start + 350;
  while (Date.now() < blockedUntil) {
    /* A real block: the event loop cannot drain the queued startup note. */
  }
  const blockedFor = Date.now() - start;
  expect(blockedFor).toBeGreaterThanOrEqual(340);
  // The note drains only now — after the fence window has long passed.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(transport.heartbeatAgeMs()).not.toBe(Number.POSITIVE_INFINITY);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const age = transport.heartbeatAgeMs();
  // The age covers the whole silent span since the transport's construction, not just the
  // time since the queued note was handled.
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
  const transport = await startedTransport();
  expect(transport.heartbeatAgeMs()).toBeLessThan(250);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // With no heartbeat arriving, the age grew with real time and passes the short window.
  expect(transport.heartbeatAgeMs()).toBeGreaterThanOrEqual(250);
  expect(() => transport.assertHeartbeatFresh(100)).toThrow(LeaseHeartbeatLost);
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

it("a slow helper construction stops rejecting live heartbeats once a prompt one arrives", async () => {
  // The helper thread's construction is stretched 600 ms past the fence window (scheduler
  // pressure, a paused process) while the parent keeps heartbeating at the required cadence.
  // The construction-derived fallback offset understates the true offset by that whole
  // interval, so it must not stay in force: the first heartbeat's own send-time estimate
  // replaces it (each estimate is an upper bound), and the ages then track the fresh
  // arrivals instead of the construction delay.
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, "test/worker/heartbeat-child.ts"), "slow-construction"],
    cwd: ROOT,
    env: {
      ...process.env,
      KIMCHI_WORKER_TEST_CONSTRUCT_DELAY_MS: "600",
      HEARTBEAT_WINDOW_MS: "250",
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
  const summary = JSON.parse(lines[lines.length - 1] ?? "{}") as {
    samples?: { ageMs: number; refused: boolean }[];
  };
  const samples = summary.samples ?? [];
  expect(samples).toHaveLength(12);
  // The fallback sample never survives the first heartbeat: every sampled age tracks the
  // 100 ms heartbeat cadence (never the 600 ms construction delay), so a live parent's
  // writes are allowed again instead of being refused for the transport's lifetime.
  for (const sample of samples.slice(1)) {
    expect(sample.refused).toBe(false);
    expect(sample.ageMs).toBeLessThan(250);
  }
}, 20_000);

it("a late-delivered heartbeat never makes a stale worker writable", async () => {
  // The offset is the running MINIMUM of per-heartbeat estimates, each an upper bound (the
  // true offset plus that note's delivery latency). A heartbeat whose note is queued behind
  // a blocked main thread therefore cannot calibrate the offset to itself: an already
  // converged offset stays, and the heartbeat's age keeps counting from its true arrival,
  // so a parent silent past the window is still refused. (An offset calibrated from the
  // latest note would instead read that stale heartbeat as fresh.)
  const child = spawn("bun", [join(ROOT, "test/worker/heartbeat-child.ts"), "late-heartbeat"], {
    cwd: ROOT,
    env: { ...process.env, HEARTBEAT_WINDOW_MS: "100" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const lines: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => lines.push(String(line)));
  const saw = (phase: string) => lines.some((line) => line.includes(`"phase":"${phase}"`));
  // Converge on prompt heartbeats until the child blocks (a bounded wait: the phase lines
  // arrive on the child's stderr as they are written).
  for (let round = 0; round < 30 && !saw("block"); round++) {
    child.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(saw("block")).toBe(true);
  // No more converge heartbeats: the parent goes silent, then delivers exactly one more
  // heartbeat ~50 ms into the child's 500 ms block. Its note can only drain after the
  // block, hundreds of ms after its true arrival — well past the 100 ms window.
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  // The drained note is late by the whole block: its age still covers the true silent span
  // (never the zero a latest-note-calibrated offset would report), so the fence refuses.
  expect(summary?.refused).toBe(true);
  expect(summary?.ageMs ?? 0).toBeGreaterThanOrEqual(250);
  expect(summary?.ageMs ?? Infinity).toBeLessThan(2_000);
}, 20_000);
