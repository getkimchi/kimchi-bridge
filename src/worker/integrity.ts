/**
 * The worker's startup integrity gate (reconcile-out-of-process plan, chunk B4).
 *
 * Once per day per agent directory, before its first write of a pass, the worker
 * runs `PRAGMA quick_check` over the ledger. On failure it stops writing,
 * reports `ledger_integrity_failed` with every channel failed, and leaves the
 * database untouched. The check's own marker file is written atomically (a
 * temp file renamed into place) only after a passing check, so a crash between
 * check and marker simply repeats the check on the next pass.
 *
 * The check opens the ledger database read-write but never writes on its own: a read-only
 * open cannot recover a WAL or rollback journal left behind by a crash, which would misreport
 * a recoverable ledger as failed. The gate's failure path never writes; the pass it was
 * gating never runs.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { BUSY_TIMEOUT_MS, ledgerDbPath, SQLITE_OPEN_READWRITE } from "../ledger/store.js";

/** The marker's validity window: one check per agent directory per day. */
export const INTEGRITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The marker's shape; a damaged or older shape means the check runs again. */
interface IntegrityMarker {
  version: 1;
  checkedAt: number;
}

/** The gate's outcome: ok, or the failure the worker must report instead of writing. */
export type IntegrityCheck = { ok: true } | { ok: false; error: string };

/** The marker file's path under the agent directory. */
export function integrityMarkerPath(agentDir: string): string {
  return join(agentDir, "work-attribution", "integrity-check.json");
}

/** Reads the marker; any unreadable or stale marker counts as absent. */
function markerAgeMs(path: string, now: number): number | undefined {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const marker = JSON.parse(body) as Partial<IntegrityMarker>;
    if (marker.version !== 1 || typeof marker.checkedAt !== "number") return undefined;
    return now - marker.checkedAt;
  } catch {
    return undefined;
  }
}

/** Writes the marker atomically: a temp file in the same directory, then one rename. Best
 *  effort: an agent directory that cannot hold the marker (permissions, a non-directory in
 *  the way) does not fail the pass on its own — the pass's own work fails there instead, and
 *  the next pass simply re-runs the check. */
function writeMarker(path: string, checkedAt: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(dirname(path), ".integrity-check-"));
    const temp = join(directory, "marker.json");
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, checkedAt } satisfies IntegrityMarker)}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    renameSync(temp, path);
    rmdirSync(directory);
  } catch (error) {
    // The marker is a best-effort optimization, but a filesystem failure must be visible.
    console.error(
      `kimchi: could not persist integrity-check marker: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Runs `PRAGMA quick_check` over the ledger; the rows are the problems found (["ok"] when clean).
 *  The open is read-write so SQLite can recover a journal a crash left behind, but the check
 *  itself only reads. */
function quickCheckRows(agentDir: string): string[] {
  const database = new Database(ledgerDbPath(agentDir), SQLITE_OPEN_READWRITE);
  try {
    // A brief competing writer is transient contention, not corruption. Stay within the
    // existing bounded-wait policy; a longer held lock still fails closed and retries later.
    database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    return (
      database.query<{ quick_check: string }, []>("PRAGMA quick_check").all() as {
        quick_check: string;
      }[]
    ).map((row) => row.quick_check);
  } finally {
    database.close();
  }
}

/**
 * The gate: returns ok when the pass may write. A fresh marker short-circuits the
 * check; otherwise quick_check runs and its marker is written only on success, so
 * a failed check leaves the marker absent and every later pass re-checks until
 * someone repairs the ledger.
 */
export function integrityCheckGate(agentDir: string, now: () => number = Date.now): IntegrityCheck {
  const marker = integrityMarkerPath(agentDir);
  const age = markerAgeMs(marker, now());
  if (age !== undefined && age >= 0 && age < INTEGRITY_CHECK_INTERVAL_MS) return { ok: true };
  if (!existsSync(ledgerDbPath(agentDir))) {
    // Nothing to check yet; the first pass creates the ledger. The marker still
    // records the passing state, so the day's later passes skip straight to work.
    writeMarker(marker, now());
    return { ok: true };
  }
  let rows: string[];
  try {
    rows = quickCheckRows(agentDir);
  } catch (error) {
    // An unreadable ledger is not a quick_check verdict; it is reported with its own
    // message so the failure is distinguishable from corruption rows.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (rows.length === 1 && rows[0] === "ok") {
    writeMarker(marker, now());
    return { ok: true };
  }
  return { ok: false, error: rows.length > 0 ? rows.join("; ") : "quick_check returned no result" };
}
