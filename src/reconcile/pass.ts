/**
 * One reconciliation pass: the body of Kimchi's supervisor scan()
 * (work-attribution/reconcile-supervisor.ts), moved behind HostPorts. The lease
 * (proper-lockfile on <agentDir>/work-attribution), the timer, the subscriber
 * registry and the delayed first tick stay in Kimchi; the pass receives the
 * combined cancellation signal and an assertLease that throws once the lease
 * is lost or compromised.
 *
 * The channel order and budgets are the supervisor's, unchanged:
 * files → pull-requests → costs → continuations → reporting, with a 3 s pass
 * budget (PASS_BUDGET_MS), the pull-request channel's own 10 s network budget
 * and each reporting delivery's 5 s window.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { importSpool } from "../ledger/import.js";
import { ledgerTxDurations, resetLedgerTxDurations } from "../ledger/records.js";
import { type TxDurations, withLedgerWriteFence } from "../ledger/store.js";
import type { HostPorts } from "./host.js";
import { withHostPorts } from "./host-ports.js";
import { reconcileWorkCosts } from "./work-attribution/cost-sync.js";
import { debugWorkAttribution as debug } from "./work-attribution/diagnostics.js";
import {
  knownTransitionRepositories,
  reconcileRepositoryTransitions,
  type SharedTypeReads,
} from "./work-attribution/file-transitions.js";
import { type ContinuationProgress, reconcileWorkContinuations } from "./work-attribution/links.js";
import { reconcileReporting } from "./pr-cost-reporting/worker.js";
import {
  reconcileWorkPullRequests,
  type WorkPullRequestUpdate,
} from "./pull-request-status/pull-requests.js";

const PASS_BUDGET_MS = 3000;

/** The channels of a pass, in run order. */
export type ReconcileChannel = "files" | "pull-requests" | "costs" | "continuations" | "reporting";

/** One channel's outcome in a pass. */
export interface ReconcileChannelOutcome {
  /** "ok" ran to completion; "failed" rejected and the error was logged or reported;
   *  "canceled" the channel's signal aborted; "skipped" the channel was not enabled. */
  outcome: "ok" | "failed" | "canceled" | "skipped";
  /** The channel's rejection message; present only when the outcome is "failed". */
  error?: string;
}

export interface PassInput {
  /** The files channel: transition reconciliation, followed by continuation repair. */
  files?: boolean;
  /** The pull-requests channel; durable updates stream to onUpdate. */
  pullRequests?: {
    onUpdate?: (update: WorkPullRequestUpdate) => void;
    /** Replaces the supervisor's subscriber onError hooks; defaults to the debug log. */
    onError?: (error: unknown) => void;
    /** Stops only this channel, as the supervisor's per-channel controller did. */
    signal?: AbortSignal;
  };
  /** The billing cost channel: enabled, or enabled with its own cancellation signal. */
  costs?: boolean | { signal?: AbortSignal };
  /** PR-cost translation and delivery, with the reporting session's cwd. */
  reporting?: { cwd: string; signal?: AbortSignal };
  /** Where the files channel left off last pass; the new position is returned. */
  nextRepository?: string;
  /** Continuation repair progress, carried across passes (the supervisor's ContinuationProgress).
   *
   * The object is mutated in place, and a fresh one is created (and returned) when omitted, so a
   * caller that threads PassRun.progress into the next pass keeps the incremental history,
   * settled journals and receipt set exactly as Kimchi's live supervisor kept them on itself. */
  progress?: ContinuationProgress;
  /** The writer epoch the lease holder granted this pass: every ledger write below runs inside a
   * pass-scoped fence that re-checks `meta.writer_epoch` in each write transaction, so a pass
   * whose lease was lost (the epoch moved) writes nothing. The fence is scoped to this pass's
   * async context only — the same process's session capture is never fenced. */
  epoch?: number;
  /** The fence's writable hook: called inside every fenced ledger transaction right after the
   * epoch check, and before the pass's durable file writes (queue state renames, spool
   * retirement). Throw to abort the write. The worker wires this to its parent-heartbeat check:
   * it is the only guard when an old release holds the lease and never bumps the epoch. */
  assertWritable?: () => void;
}

/**
 * A pass ended because io.assertLease threw: the lease was lost or compromised mid-pass.
 * The original failure is carried as `cause`.
 */
export class ReconcileLeaseLostError extends Error {
  constructor(cause: unknown) {
    super("Work attribution reconciliation lease was lost", { cause });
  }
}

export interface PassResult {
  /** The repository the next files channel starts from. */
  nextRepository?: string;
  /** Every channel's outcome for this pass; disabled channels are recorded as "skipped". */
  channels: Record<ReconcileChannel, ReconcileChannelOutcome>;
  /** Write-transaction durations of this pass's ledger connection (bounded-transaction
   * reporting); undefined on backends that do not measure. */
  txDurations?: TxDurations;
}

/** The in-memory return of one pass: the JSON protocol result above plus the continuation
 * progress the caller threads into the next pass's input. The progress object carries Sets and
 * Maps that JSON.stringify empties, so it stays in the calling process and never crosses the
 * B3 wire; a worker sends only the PassResult half of this object. */
export interface PassRun extends PassResult {
  /** The continuation progress the pass built on and mutated; thread it into the next pass's input. */
  progress: ContinuationProgress;
}

/**
 * Runs one pass. The first io.assertLease failure aborts the whole pass: the failure is
 * rethrown to the caller as ReconcileLeaseLostError, no further channel runs and nothing
 * is written after the loss.
 */
export function runReconciliationPass(
  input: PassInput,
  host: HostPorts,
  io: { signal: AbortSignal; assertLease: () => void },
): Promise<PassRun> {
  return withHostPorts(host, async () => {
    const agentDir = host.agentDir;
    let leaseFailure: ReconcileLeaseLostError | undefined;
    // Kimchi's supervisor aborted its lease signal in the same callback that marked the
    // lease compromised, so a lost lease always stopped later work. io.assertLease carries
    // no such guarantee, so the pass aborts its own internal signal on the first assertion
    // failure and rethrows that failure instead of treating it as a channel error.
    const leaseLost = new AbortController();
    const signal = AbortSignal.any([io.signal, leaseLost.signal]);
    const assertLease = () => {
      if (leaseFailure) throw leaseFailure;
      try {
        io.assertLease();
      } catch (error) {
        leaseFailure = new ReconcileLeaseLostError(error);
        leaseLost.abort();
        throw leaseFailure;
      }
    };
    // Fencing is applied before any channel runs: the epoch this pass was granted is checked
    // inside every write transaction it issues, so a stale pass cannot commit after a handover.
    const run = async (): Promise<PassRun> => {
      // The pass's transaction-duration report is scoped to this pass.
      resetLedgerTxDurations(agentDir);
      const directory = join(agentDir, "work-attribution");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const deadline = Date.now() + PASS_BUDGET_MS;
      host.metric({ kind: "reconciliation" });
      const exhausted = new Error("Work attribution reconciliation time limit exceeded");
      const channels: Record<ReconcileChannel, ReconcileChannelOutcome> = {
        files: { outcome: "skipped" },
        "pull-requests": { outcome: "skipped" },
        costs: { outcome: "skipped" },
        continuations: { outcome: "skipped" },
        reporting: { outcome: "skipped" },
      };
      const describeError = (error: unknown): string =>
        error instanceof Error ? error.message : String(error);
      const checkBudget = () => {
        assertLease();
        if (Date.now() > deadline) throw exhausted;
      };
      /** A channel's guard: the pass's lease and that channel's cancellation, as runChannel composed them. */
      const assertChannelWith = (channelSignal: AbortSignal) => () => {
        assertLease();
        channelSignal.throwIfAborted();
      };
      /** A channel error reaches its handlers; without one it reaches the debug log. */
      const channelError = (
        error: unknown,
        channelSignal: AbortSignal,
        handlers: ((error: unknown) => void)[] | undefined,
        label: string,
      ) => {
        if (leaseFailure) throw leaseFailure;
        if (channelSignal.aborted) return;
        if (handlers?.length) for (const handler of handlers) handler(error);
        else debug(label, error);
      };
      /** A rejected channel's outcome: cancellation when its signal aborted, failure otherwise. */
      const rejected = (error: unknown, channelSignal: AbortSignal): ReconcileChannelOutcome =>
        channelSignal.aborted
          ? { outcome: "canceled" }
          : { outcome: "failed", error: describeError(error) };
      let nextRepository = input.nextRepository;
      // Materialized once per pass: mutated in place by the continuations channel, and returned so a
      // caller that only keeps the result still carries the incremental history across passes.
      const progress: ContinuationProgress = input.progress ?? {};
      if (input.files) {
        channels.files = { outcome: "ok" };
        try {
          // The spool first: records capture parked while the writer was busy import exactly once
          // before any channel reads them.
          importSpool(agentDir, checkBudget);
          // One whole-type read serves every repository of the pass, not one full table scan each.
          const shared: SharedTypeReads = {};
          const repositories = await knownTransitionRepositories(checkBudget);
          const start = Math.max(0, repositories.indexOf(nextRepository ?? ""));
          for (let offset = 0; offset < repositories.length; offset++) {
            checkBudget();
            const index = (start + offset) % repositories.length;
            // Move on after a slow/broken repository; its own checkpoints preserve partial progress.
            nextRepository = repositories[(index + 1) % repositories.length];
            try {
              await reconcileRepositoryTransitions(
                repositories[index],
                signal,
                checkBudget,
                assertLease,
                shared,
              );
            } catch (error) {
              if (leaseFailure) throw leaseFailure;
              if (error === exhausted || signal.aborted) throw error;
              debug("Could not reconcile repository %s: %o", repositories[index], error);
            }
          }
        } catch (error) {
          if (leaseFailure) throw leaseFailure;
          // Kimchi's supervisor swallowed the pass budget and cancellation here and still ran the
          // later channels (reconcile-supervisor.ts:151-153): an exhausted files channel ends only
          // the files work, never the pull-request, cost, continuation or reporting work after it.
          // Cancellation stays reserved for an aborted signal; an unaborted budget stop is a
          // failure carrying the exhaustion message, so the outcome tells a requested stop from a
          // starving channel apart.
          if (signal.aborted) channels.files = { outcome: "canceled" };
          else {
            channels.files = { outcome: "failed", error: describeError(error) };
            debug("Could not discover repositories: %o", error);
          }
        }
      }
      // Network lookup has its own deadline. A slow local repository must not starve it,
      // and Bash-only commits have no transition repository to visit above.
      if (input.pullRequests) {
        if (leaseFailure) throw leaseFailure;
        const channel = input.pullRequests;
        const channelSignal = AbortSignal.any([signal, ...(channel.signal ? [channel.signal] : [])]);
        channels["pull-requests"] = { outcome: "ok" };
        try {
          await reconcileWorkPullRequests(
            agentDir,
            channelSignal,
            assertChannelWith(channelSignal),
            (update) => channel.onUpdate?.(update),
          );
        } catch (error) {
          channelError(
            error,
            channelSignal,
            channel.onError ? [channel.onError] : undefined,
            "Reconciliation unavailable:",
          );
          channels["pull-requests"] = rejected(error, channelSignal);
        }
      }
      const costsChannel = input.costs && typeof input.costs === "object" ? input.costs : undefined;
      if (input.costs) {
        if (leaseFailure) throw leaseFailure;
        const channelSignal = AbortSignal.any([
          signal,
          ...(costsChannel?.signal ? [costsChannel.signal] : []),
        ]);
        channels.costs = { outcome: "ok" };
        try {
          await reconcileWorkCosts(agentDir, channelSignal, assertChannelWith(channelSignal));
        } catch (error) {
          channelError(error, channelSignal, undefined, "Could not reconcile costs: %o");
          channels.costs = rejected(error, channelSignal);
        }
      }
      // Historical repair is local and has its own budget; PR and billing work run first.
      if (input.files) {
        if (leaseFailure) throw leaseFailure;
        channels.continuations = { outcome: "ok" };
        try {
          await reconcileWorkContinuations(agentDir, signal, assertLease, progress);
        } catch (error) {
          if (leaseFailure) throw leaseFailure;
          if (!signal.aborted) {
            channels.continuations = {
              outcome: "failed",
              error: describeError(error),
            };
            debug("Could not reconcile work continuations: %o", error);
          } else channels.continuations = { outcome: "canceled" };
        }
      }
      if (input.reporting) {
        if (leaseFailure) throw leaseFailure;
        const channelSignal = AbortSignal.any([
          signal,
          ...(input.reporting.signal ? [input.reporting.signal] : []),
        ]);
        channels.reporting = { outcome: "ok" };
        try {
          await reconcileReporting(
            agentDir,
            input.reporting.cwd,
            channelSignal,
            assertChannelWith(channelSignal),
          );
        } catch (error) {
          channelError(error, channelSignal, undefined, "Could not report PR costs: %o");
          channels.reporting = rejected(error, channelSignal);
        }
      }
      return {
        nextRepository,
        channels,
        txDurations: ledgerTxDurations(agentDir),
        progress,
      };
    };
    // Fencing wraps the whole pass before any channel runs: the epoch this pass was granted is
    // re-checked inside every write transaction the pass's context issues, so a stale pass
    // cannot commit after a handover — while the process's session capture, which runs outside
    // this context, stays unfenced.
    return input.epoch === undefined
      ? run()
      : withLedgerWriteFence(
          { agentDir, epoch: input.epoch, assertWritable: input.assertWritable ?? (() => {}) },
          run,
        );
  });
}
