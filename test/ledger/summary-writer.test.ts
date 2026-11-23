import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

function startWriter(dir: string, record: WorkRecord): Writer {
  const child = spawn("bun", [DRIVER, "summary-writer", dir, JSON.stringify({ record })], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  const pending: ((phase: string) => void)[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const phase = (JSON.parse(line) as { phase: string }).phase;
      for (const resolve of pending.splice(0)) resolve(phase);
    }
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return {
    child,
    next: () => new Promise((resolve) => pending.push(resolve)),
    done,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await done.catch(() => {});
    },
  };
}

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
