import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The wait-expiry state race in the transport's blocking request (see
 * state-race-child.ts for why the race cannot be forced deterministically):
 * a terminal state the reader thread stores in the window between the wait's
 * expiry and the compare-exchange that ends it must be honored, never
 * misreported as a timeout or deadline. The stress child drives the real
 * request against a racing thread thousands of times and fails on any
 * misclassification.
 */

const ROOT = join(import.meta.dir, "../..");

test("a terminal state winning the wait-expiry race is never reported as a timeout", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, "test/worker/state-race-child.ts")],
    cwd: ROOT,
    // stdin stays an open, silent pipe: the transport's reader thread blocks
    // on it; stdout is /dev/null for the request lines; the summary is stderr.
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  expect(code).toBe(0);
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  const summary = JSON.parse(lines[lines.length - 1] ?? "{}") as {
    iterations: number;
    won: number;
    lost: number;
    violations: unknown[];
  };
  expect(summary.violations).toEqual([]);
  expect(summary.iterations).toBeGreaterThan(0);
  // Both sides of the race were actually exercised: the racer both won the
  // compare-exchange (its terminal state was stored before the request's own)
  // and lost it (the request ended the wait first).
  expect(summary.won).toBeGreaterThan(0);
  expect(summary.lost).toBeGreaterThan(0);
}, 60000);
