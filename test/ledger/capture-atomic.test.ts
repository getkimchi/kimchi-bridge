import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";
import { backendFor, capture, closeBackends, readRecords } from "../../src/ledger/records.js";
import { openStore } from "../../src/ledger/store.js";

/**
 * Capture atomicity against the real SQLite backend: a fault injected immediately after the
 * authority insert, the translation-marker upsert or the projection-head publish must roll the
 * whole capture back, and the same record must capture cleanly afterwards. Everything here runs
 * against moved library code (records.ts); the hydration that Kimchi layers on top stays there.
 */

/** The four ledger tables one work's capture touches, read through a fresh store connection. */
function summaryState(
  dir: string,
  workId: string,
): {
  authority: unknown[];
  markers: unknown[];
  head: string | null;
  rows: unknown[];
} {
  const store = openStore(dir);
  try {
    return {
      authority: store.db
        .query("SELECT * FROM work_records WHERE work_id = ? ORDER BY rowid")
        .all(workId),
      markers: store.db
        .query("SELECT * FROM pending_translation WHERE work_id = ? ORDER BY record_hash")
        .all(workId),
      head:
        store.db
          .query<{ body: string }, [string]>(
            "SELECT body FROM work_projection_head WHERE work_id = ?",
          )
          .get(workId)?.body ?? null,
      rows: store.db
        .query("SELECT * FROM work_projection_rows WHERE work_id = ? ORDER BY log, pos")
        .all(workId),
    };
  } finally {
    store.close();
  }
}

function record(workId: string, requestId: string): WorkRecord {
  return {
    version: 1,
    type: "request",
    workId,
    sessionId: "session",
    requestId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

const dirs: string[] = [];
afterEach(() => {
  closeBackends();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(["authority", "translation", "projection"] as const)(
  "capture rolls back fully after the %s write and retries cleanly",
  (failure) => {
    it("keeps prior history and never half-publishes", () => {
      const dir = mkdtempSync(join(tmpdir(), "kimchi-capture-atomic-"));
      dirs.push(dir);
      const workId = randomUUID();
      const failedWorkId = randomUUID();
      const retry = record(workId, "retry-request");
      capture(dir, { ...retry, type: "work" }, "summary-native");
      capture(dir, { ...retry, requestId: "prior" }, "summary-native");
      const before = summaryState(dir, workId);

      const backend = backendFor(dir);
      const insert = backend.insertRecord;
      const mark = backend.upsertMarker;
      const publish = backend.putHead;
      const sentinel = new Error("after-write cancellation");
      let mutations = 0;
      if (failure === "authority")
        backend.insertRecord = (row) => {
          const inserted = insert(row);
          if (inserted) {
            mutations++;
            throw sentinel;
          }
          return inserted;
        };
      if (failure === "translation")
        backend.upsertMarker = (...args) => {
          mark(...args);
          mutations++;
          throw sentinel;
        };
      if (failure === "projection")
        backend.putHead = (head) => {
          publish(head);
          mutations++;
          throw sentinel;
        };
      let rejected = 0;
      try {
        for (const next of [retry, { ...retry, type: "work" as const, workId: failedWorkId }]) {
          try {
            capture(dir, next, "summary-native");
          } catch (error) {
            if (error !== sentinel) throw error;
            rejected++;
          }
        }
      } finally {
        backend.insertRecord = insert;
        backend.upsertMarker = mark;
        backend.putHead = publish;
        closeBackends();
      }

      expect(mutations).toBe(2);
      expect(rejected).toBe(2);
      // Full rollback: the seeded authority, markers, head and rows are byte-for-byte unchanged.
      const after = summaryState(dir, workId);
      expect(after).toEqual(before);
      // The failed attempt's work never existed, not even partially.
      expect(summaryState(dir, failedWorkId)).toEqual({
        authority: [],
        markers: [],
        head: null,
        rows: [],
      });

      // The very same record captures cleanly afterwards, exactly once.
      capture(dir, retry, "summary-native");
      capture(dir, retry, "summary-native");
      closeBackends();
      const recovered = summaryState(dir, workId);
      expect(recovered.authority).toHaveLength(before.authority.length + 1);
      const requests = backendFor(dir)
        .readLog(workId, "requests")
        .map((row) => row.requestId);
      closeBackends();
      expect(requests).toEqual(["prior", retry.requestId]);
      expect(summaryState(dir, workId).head).not.toBeNull();
      expect(readRecords(dir, { workId })).toHaveLength(recovered.authority.length);
    });
  },
);
