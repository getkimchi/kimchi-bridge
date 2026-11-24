import { describe, expect, test } from "bun:test";
import { ReconcileLeaseLostError } from "../../src/reconcile/pass.js";
import type { PassRunForWire } from "../../src/worker/pass-result.js";
import { passResultFromRun } from "../../src/worker/pass-result.js";
import type { PassMessage } from "../../src/worker/protocol.js";

/**
 * The worker's translation of a finished pass into the wire result
 * (reconcile-out-of-process plan, chunk B3). B2's runReconciliationPass
 * reports an outcome for every pass channel — files, pull-requests, costs,
 * continuations, reporting — and the wire result must carry exactly that:
 * `pull-requests` is reported as `pullRequests`, the continuations outcome
 * folds into the wire's `files` result, a lost lease fails every requested
 * channel, and no channel outcome is inferred from anything but the pass's
 * own result.
 */

const SECRET = "kchi_mapping_secret_token_0123456789";
const identity = (text: string): string => text;
const redact = (text: string): string => text.split(SECRET).join("[redacted]");

function pass(channels: PassMessage["channels"]): PassMessage {
  return { type: "pass", id: 1, channels, deadlineMs: 30000, epoch: 1 };
}

/** A pass result where every requested channel ran to completion. */
function runOf(
  channels: Partial<PassRunForWire["channels"]>,
  nextRepository?: string,
): PassRunForWire {
  return {
    channels: {
      files: { outcome: "skipped" },
      "pull-requests": { outcome: "skipped" },
      costs: { outcome: "skipped" },
      continuations: { outcome: "skipped" },
      reporting: { outcome: "skipped" },
      ...channels,
    },
    ...(nextRepository === undefined ? {} : { nextRepository }),
  };
}

describe("the pass result mapped onto the wire", () => {
  test("every pass channel reports, with pull-requests as pullRequests and continuations in files", () => {
    const result = passResultFromRun(
      pass({ files: true, pullRequests: true, costs: true, reporting: true }),
      { aborted: false },
      runOf({
        files: { outcome: "ok" },
        "pull-requests": { outcome: "ok" },
        costs: { outcome: "ok" },
        continuations: { outcome: "ok" },
        reporting: { outcome: "ok" },
      }),
      undefined,
      identity,
    );
    expect(result).toEqual({
      outcome: "ok",
      channels: {
        files: { outcome: "ok" },
        pullRequests: { outcome: "ok" },
        costs: { outcome: "ok" },
        reporting: { outcome: "ok" },
      },
    });
  });

  test("the wire's files result carries the repository the next pass starts from", () => {
    const result = passResultFromRun(
      pass({ files: true }),
      { aborted: false },
      runOf({ files: { outcome: "ok" }, continuations: { outcome: "ok" } }, "/next/.git"),
      undefined,
      identity,
    );
    expect(result.nextRepository).toBe("/next/.git");
    // A pass without a rotation reports nothing: the parent keeps its own.
    const without = passResultFromRun(
      pass({ files: true }),
      { aborted: false },
      runOf({ files: { outcome: "ok" }, continuations: { outcome: "ok" } }),
      undefined,
      identity,
    );
    expect("nextRepository" in without).toBe(false);
  });

  test("a continuation failure fails the wire's files result, never a silent ok", () => {
    const result = passResultFromRun(
      pass({ files: true }),
      { aborted: false },
      runOf({
        files: { outcome: "ok" },
        continuations: { outcome: "failed", error: `repair broke on ${SECRET}` },
      }),
      undefined,
      redact,
    );
    expect(result.outcome).toBe("failed");
    expect(result.channels.files).toEqual({
      outcome: "failed",
      error: "repair broke on [redacted]",
    });
  });

  test("a continuation cancellation cancels the wire's files result alongside an ok files channel", () => {
    const result = passResultFromRun(
      pass({ files: true }),
      { aborted: false },
      runOf({ files: { outcome: "ok" }, continuations: { outcome: "canceled" } }),
      undefined,
      identity,
    );
    expect(result.channels.files).toEqual({ outcome: "canceled" });
    expect(result.outcome).toBe("canceled");
  });

  test("a files failure beats an ok continuation, and the pull-request channel's own outcome reports", () => {
    const result = passResultFromRun(
      pass({ files: true, pullRequests: true }),
      { aborted: false },
      runOf({
        files: { outcome: "failed", error: "transition scan failed" },
        continuations: { outcome: "ok" },
        "pull-requests": { outcome: "failed", error: "provider unreachable" },
      }),
      undefined,
      identity,
    );
    expect(result.channels.files).toEqual({ outcome: "failed", error: "transition scan failed" });
    expect(result.channels.pullRequests).toEqual({
      outcome: "failed",
      error: "provider unreachable",
    });
    expect(result.outcome).toBe("failed");
  });

  test("a channel error is redacted through the worker's live secret registry", () => {
    const result = passResultFromRun(
      pass({ reporting: true }),
      { aborted: false },
      runOf({ reporting: { outcome: "failed", error: `delivery failed for ${SECRET}` } }),
      undefined,
      redact,
    );
    expect(result.channels.reporting?.error).not.toContain(SECRET);
    expect(result.channels.reporting?.error).toContain("[redacted]");
  });

  test("a lost lease fails every requested channel with the redacted lease error", () => {
    const leaseLost = new ReconcileLeaseLostError(new Error(`the lock broke on ${SECRET}`));
    const result = passResultFromRun(
      pass({ files: true, costs: true }),
      { aborted: false },
      undefined,
      leaseLost,
      redact,
    );
    expect(result.outcome).toBe("failed");
    expect(result.channels.files).toEqual({
      outcome: "failed",
      error: "Work attribution reconciliation lease was lost",
    });
    expect(result.channels.costs).toEqual({
      outcome: "failed",
      error: "Work attribution reconciliation lease was lost",
    });
    // The original failure's message never crosses the wire unredacted.
    const leaked = JSON.stringify(result);
    expect(leaked.includes(SECRET)).toBe(false);
  });

  test("the worker's own cancellation wins over the pass's per-channel outcomes", () => {
    const result = passResultFromRun(
      pass({ files: true, reporting: true }),
      { aborted: true, reason: "cancel" },
      runOf({
        files: { outcome: "ok" },
        continuations: { outcome: "ok" },
        reporting: { outcome: "failed", error: "cut short" },
      }),
      undefined,
      identity,
    );
    expect(result.outcome).toBe("canceled");
    expect(result.channels.files).toEqual({ outcome: "canceled" });
    expect(result.channels.reporting).toEqual({ outcome: "canceled" });
  });

  test("the pass deadline fails every requested channel with the deadline error", () => {
    const result = passResultFromRun(
      pass({ reporting: true }),
      { aborted: true, reason: "deadline" },
      runOf({ reporting: { outcome: "ok" } }),
      undefined,
      identity,
    );
    expect(result.outcome).toBe("failed");
    expect(result.channels.reporting).toEqual({
      outcome: "failed",
      error: "the pass exceeded its deadline",
    });
  });

  test("a channel the pass skipped or stopped on its own signal is never ok", () => {
    const result = passResultFromRun(
      pass({ costs: true, reporting: true }),
      { aborted: false },
      runOf({ costs: { outcome: "skipped" }, reporting: { outcome: "canceled" } }),
      undefined,
      identity,
    );
    expect(result.channels.costs).toEqual({ outcome: "canceled" });
    expect(result.channels.reporting).toEqual({ outcome: "canceled" });
    expect(result.outcome).toBe("canceled");
  });

  test("a run with no outcome for a requested channel refuses to guess", () => {
    const result = passResultFromRun(
      pass({ files: true }),
      { aborted: false },
      runOf({ files: { outcome: "ok" }, continuations: { outcome: "skipped" } }),
      undefined,
      identity,
    );
    // The pass never runs a requested channel's skipped half: the wire reports
    // it as not-run, never as ok.
    expect(result.channels.files).toEqual({ outcome: "canceled" });
    expect(result.outcome).toBe("canceled");
    const empty = passResultFromRun(
      pass({ reporting: true }),
      { aborted: false },
      undefined,
      undefined,
      identity,
    );
    expect(empty.channels.reporting?.outcome).toBe("failed");
  });
});
