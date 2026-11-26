import type * as Sqlite from "bun:sqlite";
import { BUSY_TIMEOUT_MS } from "./store.js";

/** Keeps large-head WAL checkpoint work outside the timed publication transaction. The
 * connection's prior automatic-checkpoint setting and normal busy timeout are restored by the
 * returned cleanup, after the publication commit (or a failed attempt). Authority rows, the
 * projection format, and synchronous=FULL remain unchanged. */
export function prepareHeadPublication(
  db: Sqlite.Database,
  bodyBytes: number,
): (() => void) | undefined {
  if (bodyBytes < 4 * 1024 * 1024) return undefined;
  const original = db
    .query<{ wal_autocheckpoint: number }, []>("PRAGMA wal_autocheckpoint")
    .get()!.wal_autocheckpoint;
  db.exec("PRAGMA busy_timeout=0");
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (error) {
    console.error(
      `kimchi: publication checkpoint preparation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A large head can cross the default 1000-page WAL threshold by itself. Prevent SQLite
  // from checkpointing that new WAL inside the publication commit; the cleanup below restores
  // the setting and checkpoints the new WAL after the timed transaction.
  try {
    db.exec("PRAGMA wal_autocheckpoint=0");
  } finally {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  }
  return () => {
    try {
      db.exec("PRAGMA busy_timeout=0");
      db.exec(`PRAGMA wal_autocheckpoint=${original}`);
    } catch (error) {
      console.error(
        `kimchi: publication automatic-checkpoint restoration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (error) {
        console.error(
          `kimchi: publication checkpoint cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
      }
    }
  };
}
