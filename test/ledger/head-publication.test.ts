import { expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHeadPublication } from "../../src/ledger/head-publication.js";
import { createMemoryRecords } from "../../src/ledger/memory-records.js";
import { rebuildWorkSliced } from "../../src/ledger/records.js";
import { BUSY_TIMEOUT_MS, openStore, type LedgerStore } from "../../src/ledger/store.js";

const WORK = "00000000-0000-4000-8000-000000000001";
const LARGE_HEAD_BYTES = 4 * 1024 * 1024;

function withStore(run: (store: LedgerStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-head-publication-"));
  const store = openStore(dir);
  try {
    run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function autoCheckpoint(store: LedgerStore): number {
  return (
    store.db.query<{ wal_autocheckpoint: number }, []>("PRAGMA wal_autocheckpoint").get()
      ?.wal_autocheckpoint ?? -1
  );
}

function busyTimeout(store: LedgerStore): number {
  return store.db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? -1;
}

test("a small head leaves WAL scheduling untouched", () => {
  withStore((store) => {
    store.db.exec("PRAGMA wal_autocheckpoint=1234");
    expect(prepareHeadPublication(store.db, LARGE_HEAD_BYTES - 1)).toBeUndefined();
    expect(autoCheckpoint(store)).toBe(1234);
    expect(busyTimeout(store)).toBe(BUSY_TIMEOUT_MS);
  });
});

test("a large head restores its exact automatic-checkpoint setting outside the transaction", () => {
  withStore((store) => {
    const original = 2500;
    store.db.exec(`PRAGMA wal_autocheckpoint=${original}`);
    const finish = prepareHeadPublication(store.db, LARGE_HEAD_BYTES)!;
    expect(autoCheckpoint(store)).toBe(0);
    expect(busyTimeout(store)).toBe(BUSY_TIMEOUT_MS);
    finish();
    expect(autoCheckpoint(store)).toBe(original);
    expect(busyTimeout(store)).toBe(BUSY_TIMEOUT_MS);
  });
});

test("checkpoint errors are visible while preparation and cleanup restore scheduling", () => {
  withStore((store) => {
    store.db.exec("PRAGMA wal_autocheckpoint=2500");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const nativeExec = store.db.exec.bind(store.db);
    const forced = vi.spyOn(store.db, "exec").mockImplementation((statement: string) => {
      if (statement.includes("wal_checkpoint")) throw new Error("forced checkpoint failure");
      return nativeExec(statement);
    });
    try {
      const finish = prepareHeadPublication(store.db, LARGE_HEAD_BYTES);
      expect(finish).toBeDefined();
      expect(autoCheckpoint(store)).toBe(0);
      expect(busyTimeout(store)).toBe(BUSY_TIMEOUT_MS);
      finish!();
      expect(autoCheckpoint(store)).toBe(2500);
      expect(busyTimeout(store)).toBe(BUSY_TIMEOUT_MS);
      expect(diagnostic).toHaveBeenCalledTimes(2);
    } finally {
      diagnostic.mockRestore();
      forced.mockRestore();
    }
  });
});

test("both publication paths restore preparation after success and a failed write", () => {
  for (const sliced of [false, true]) {
    for (const fail of [false, true]) {
      const backend = createMemoryRecords();
      if (sliced) {
        backend.insertRecord({
          recordHash: "large-commit",
          type: "commit",
          workId: WORK,
          sessionId: "session",
          body: JSON.stringify({
            version: 1,
            type: "commit",
            workId: WORK,
            sessionId: "session",
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            repository: "github.com/o/r",
            worktree: "/w",
            recordedAt: "2026-11-26T00:00:00.000Z",
            pullRequests: [],
            description: "x".repeat(4 * 1024 * 1024),
          }),
          sourcePath: "/journal",
          sourceGeneration: 0,
          sourceOffset: 0,
          importedAt: 0,
        });
        backend.upsertMarker("large-commit", WORK, "commit");
      }
      let automaticCheckpoint = 1000;
      let preparations = 0;
      backend.prepareHeadPublication = () => {
        preparations++;
        automaticCheckpoint = 0;
        return () => {
          automaticCheckpoint = 1000;
        };
      };
      if (fail) {
        backend.putHead = () => {
          throw new Error("injected publication failure");
        };
        expect(() => rebuildWorkSliced(backend, "/memory", WORK)).toThrow(
          "injected publication failure",
        );
      } else {
        rebuildWorkSliced(backend, "/memory", WORK);
      }
      expect(preparations).toBeGreaterThan(0);
      expect(automaticCheckpoint).toBe(1000);
      if (sliced) expect(backend.recordCount(WORK)).toBe(1);
      backend.close();
    }
  }
});
