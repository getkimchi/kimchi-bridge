/**
 * Transaction-duration budgeting for reconciliation writes (reconcile-out-of-process plan,
 * chunk B4): the ledger store measures every write transaction, and the batch/chunk sizes the
 * passes commit with adapt to those measurements so transactions target p99 <= 50 ms and
 * max <= 250 ms. Pure module — no database, no platform — importable from any runtime.
 *
 * Atomic units are never split by this budgeting: an acknowledgement with its receipt state, a
 * journal cursor with the rows it covers, and a claim with its revision each stay one
 * transaction; only how many such units share one transaction adapts.
 */

/** Reconciliation write transactions target this p99 duration. */
export const TX_TARGET_MS = 50;
/** The hard ceiling the adaptive sizing pushes transactions under. */
export const TX_CEILING_MS = 250;

/**
 * AIMD sizing over measured transaction durations: multiplicative decrease above the ceiling,
 * a one-unit decrease above the target, additive growth after a run of good transactions, with
 * hard min and max. `start` is the historic fixed size, which is also the default max.
 */
export interface TxChunkSizer {
  /** The number of units the next transaction may carry. */
  size(): number;
  /** Feeds one measured transaction duration into the sizing decision. */
  observe(durationMs: number): void;
}

export function createTxChunkSizer(start: number, min = 1, max = start): TxChunkSizer {
  let size = Math.min(Math.max(Math.floor(start), min), max);
  let good = 0;
  return {
    size: () => size,
    observe(durationMs: number): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      if (durationMs > TX_CEILING_MS) {
        size = Math.max(min, Math.floor(size / 2));
        good = 0;
      } else if (durationMs > TX_TARGET_MS) {
        size = Math.max(min, size - 1);
        good = 0;
      } else if (++good >= 8) {
        size = Math.min(max, size + Math.max(1, Math.floor(size / 8)));
        good = 0;
      }
    },
  };
}
