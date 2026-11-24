/**
 * The translation from a finished pass's result to the worker's wire result
 * (reconcile-out-of-process plan, chunk B3). B2's runReconciliationPass
 * returns a JSON-only PassResult with an outcome for every pass channel —
 * files, pull-requests, costs, continuations, reporting — and this module maps
 * it onto the wire's channel set: `pull-requests` becomes `pullRequests`, and
 * the continuations outcome folds into the wire's `files` result, so a
 * continuation failure or cancellation is never silently reported as ok.
 *
 * Nothing here infers a channel outcome from host request traffic or any
 * other side channel: the pass's own result decides, and the worker's direct
 * knowledge of its own cancellation or deadline only overrides it. The module
 * is separate from the worker entry so the parent's client and the tests can
 * import the mapping without starting the worker's main loop.
 */
import type { PassRun } from "../reconcile/pass.js";
import type { ReconcileChannel } from "../reconcile/pass.js";
import type { PassMessage, PassResult } from "./protocol.js";

/** Why the pass in flight was aborted. */
export type AbortCause = "cancel" | "deadline" | "parent-gone";

/** One wire channel and the pass channels it reports: the wire's `files` covers
 *  both the files channel and the continuation repair the pass runs under it. */
const WIRE_CHANNELS: { wire: keyof PassResult["channels"]; pass: ReconcileChannel[] }[] = [
  { wire: "files", pass: ["files", "continuations"] },
  { wire: "pullRequests", pass: ["pull-requests"] },
  { wire: "costs", pass: ["costs"] },
  { wire: "reporting", pass: ["reporting"] },
];

/** The pass-side state of one finished pass the wire result is built from. */
export interface PassRunForWire {
  /** The repository the next files channel starts from. */
  nextRepository?: string;
  /** Every pass channel's outcome, as the pass reported it. */
  channels: PassRun["channels"];
}

/**
 * Builds the wire result for one finished pass from what the pass itself
 * reported. The pass's own cancellation and deadline win over everything
 * (the worker knows them directly), a failure that escaped the pass fails
 * every requested channel, and otherwise each wire channel reports the
 * outcomes the pass recorded — every pass channel included, continuations
 * folded into the wire's files result. No channel outcome is inferred from
 * host request traffic.
 */
export function passResultFromRun(
  message: PassMessage,
  state: { aborted: boolean; reason?: AbortCause },
  run: PassRunForWire | undefined,
  passError: unknown,
  redact: (text: string) => string,
): PassResult {
  const aborted = state.aborted;
  const canceled = aborted && state.reason !== "deadline";
  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const channels: PassResult["channels"] = {};
  for (const [name, requested] of Object.entries(message.channels) as [string, boolean][]) {
    if (!requested) continue;
    if (canceled) {
      channels[name as keyof PassResult["channels"]] = { outcome: "canceled" };
      continue;
    }
    if (aborted) {
      channels[name as keyof PassResult["channels"]] = {
        outcome: "failed",
        error: "the pass exceeded its deadline",
      };
      continue;
    }
    // A failure that escaped the pass fails every requested channel: the
    // pass never reached the point where a channel could report for itself.
    // A lost lease arrives here as ReconcileLeaseLostError, and the worker's
    // own startup failures (an unwritable agent directory) as plain errors.
    if (passError !== undefined) {
      channels[name as keyof PassResult["channels"]] = {
        outcome: "failed",
        error: redact(describeError(passError)),
      };
      continue;
    }
    const reported = WIRE_CHANNELS.find((entry) => entry.wire === name);
    const outcomes = (reported?.pass ?? [])
      .map((channel) => run?.channels[channel])
      .filter((outcome) => outcome !== undefined);
    if (outcomes.length > 0) {
      const failed = outcomes.find((outcome) => outcome.outcome === "failed");
      if (failed)
        channels[name as keyof PassResult["channels"]] = {
          outcome: "failed",
          ...(failed.error === undefined ? {} : { error: redact(failed.error) }),
        };
      // A channel the pass never ran (a skipped one) or one it stopped on
      // its own signal reports as not-run on the wire: no error, no ok.
      else if (outcomes.some((outcome) => outcome.outcome !== "ok"))
        channels[name as keyof PassResult["channels"]] = { outcome: "canceled" };
      else channels[name as keyof PassResult["channels"]] = { outcome: "ok" };
      continue;
    }
    channels[name as keyof PassResult["channels"]] = {
      outcome: "failed",
      error: "the pass ended without reporting the channel",
    };
  }
  const results = Object.values(channels);
  const outcome = canceled
    ? "canceled"
    : aborted || passError !== undefined
      ? "failed"
      : results.some((channel) => channel?.outcome === "failed")
        ? "failed"
        : results.some((channel) => channel?.outcome === "canceled")
          ? "canceled"
          : "ok";
  return {
    outcome,
    channels,
    ...(run?.nextRepository === undefined ? {} : { nextRepository: run.nextRepository }),
    // txDurations is filled by chunk B4's transaction budget.
  };
}
