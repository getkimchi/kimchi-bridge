import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";
import { closeBackends, readRecords, readWorkSummary } from "../../src/ledger/records.js";

/**
 * A cancelled writer rolls back its published head before a competing real process commits, and
 * closing the still-live cancelled owner cannot republish its stale projection afterwards. Both
 * writers are real Bun subprocesses gated on stdin, like Kimchi's native summary race; only the
 * direct ledger operations matter here, so the hydration flush Kimchi layers on top is absent.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

interface Writer {
  child: ReturnType<typeof spawn>;
  next: () => Promise<string>;
  done: Promise<number | null>;
  stop: () => Promise<void>;
}

/**
 * Reads one phase string per line of JSON written by the driver on stdout. Parsed lines are
 * queued by readline, so a phase is never lost when it arrives before next() or when one stdout
 * chunk carries several phase lines; when the stream ends, a pending next() rejects instead of
 * hanging until the test timeout.
 */
interface PhaseReader {
  next: () => Promise<string>;
  stop: () => void;
}

function startPhaseReader(input: NodeJS.ReadableStream, label = "Writer"): PhaseReader {
  const lines = createInterface({ input });
  const messages = lines[Symbol.asyncIterator]();
  return {
    next: async () => {
      const line = await messages.next();
      if (line.done) throw new Error(`${label} ended before its next phase`);
      return (JSON.parse(line.value) as { phase: string }).phase;
    },
    stop: () => lines.close(),
  };
}

function startWriter(dir: string, record: WorkRecord): Writer {
  const child = spawn("bun", [DRIVER, "summary-writer", dir, JSON.stringify({ record })], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const phases = startPhaseReader(child.stdout!);
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return {
    child,
    next: phases.next,
    done,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await done.catch(() => {});
      phases.stop();
    },
  };
}

it("delivers both phases when one stdout chunk coalesces two phase lines", async () => {
  const stdout = new PassThrough();
  const phases = startPhaseReader(stdout);
  stdout.write(`${JSON.stringify({ phase: "ready" })}\n${JSON.stringify({ phase: "pending" })}\n`);
  expect(await phases.next()).toBe("ready");
  expect(await phases.next()).toBe("pending");
  phases.stop();
  stdout.end();
}, 2_000);

it("delivers every phase when one chunk coalesces three phase lines", async () => {
  const stdout = new PassThrough();
  const phases = startPhaseReader(stdout);
  stdout.write(
    `${JSON.stringify({ phase: "ready" })}\n${JSON.stringify({ phase: "pending" })}\n${JSON.stringify({ phase: "rolled-back" })}\n`,
  );
  expect(await phases.next()).toBe("ready");
  expect(await phases.next()).toBe("pending");
  expect(await phases.next()).toBe("rolled-back");
  phases.stop();
  stdout.end();
}, 2_000);

it("rejects a pending phase read when the child stdout ends first", async () => {
  const stdout = new PassThrough();
  const phases = startPhaseReader(stdout);
  stdout.end();
  await expect(phases.next()).rejects.toThrow("Writer ended before its next phase");
  phases.stop();
}, 2_000);

function driver(...args: string[]): unknown {
  return JSON.parse(
    Bun.spawnSync(["bun", DRIVER, ...args], { cwd: ROOT, timeout: 60_000 })
      .stdout.toString()
      .trim()
      .split("\n")
      .at(-1) ?? "{}",
  );
}

const dirs: string[] = [];
afterEach(() => {
  closeBackends();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("rolls back a cancelled native publisher before a competing writer commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-summary-writer-"));
  dirs.push(dir);
  const workId = randomUUID();
  const base: WorkRecord = {
    version: 1,
    type: "request",
    workId,
    sessionId: "seed",
    requestId: "shared-request",
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
  driver("capture", dir, JSON.stringify(base));
  const before = driver("summary-state", dir, workId);
  const cancelled = startWriter(dir, {
    ...base,
    type: "request_response",
    sessionId: "cancelled",
    responseId: "stale",
  });
  let winner: Writer | undefined;
  try {
    expect(await cancelled.next()).toBe("ready");
    expect(await cancelled.next()).toBe("pending");
    winner = startWriter(dir, {
      ...base,
      type: "request_response",
      sessionId: "winner",
      responseId: "newer",
    });
    expect(await winner.next()).toBe("ready");
    // The cancelled writer's head is published only inside its open transaction: invisible.
    expect(driver("summary-state", dir, workId)).toEqual(before);
    cancelled.child.stdin?.write("r");
    expect(await cancelled.next()).toBe("rolled-back");
    expect(await winner.next()).toBe("pending");
    expect(driver("summary-state", dir, workId)).toEqual(before);
    winner.child.stdin?.write("c");
    expect(await winner.next()).toBe("committed");
    await winner.done;
    const committed = driver("summary-state", dir, workId);
    const view = readWorkSummary(dir, workId);
    expect(view?.requests).toEqual([
      expect.objectContaining({ requestId: base.requestId, responseId: "newer" }),
    ]);
    expect([...(view?.sessions ?? [])].sort()).toEqual(["seed", "winner"]);
    expect(readRecords(dir, { workId })).toHaveLength(2);
    // Closing the still-live cancelled owner cannot republish its old head after the winner.
    expect(cancelled.child.exitCode).toBeNull();
    cancelled.child.stdin?.write("c");
    await cancelled.done;
    expect(driver("summary-state", dir, workId)).toEqual(committed);
  } finally {
    await cancelled.stop();
    await winner?.stop();
  }
}, 30_000);
