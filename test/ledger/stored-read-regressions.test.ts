import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";
import {
  backendFor,
  capture,
  closeBackends,
  readStoredRecordsAsync,
  recordHashOf,
  rebuildWork,
} from "../../src/ledger/records.js";

/**
 * The async stored reader against the real SQLite backend with more rows than one page: a read
 * cancelled mid-iteration must leave no broken state behind on the same connection, a capture
 * that commits between pages must stay invisible to the snapshot that already started, and a cold
 * reopen must see exactly the committed history.
 */

const dirs: string[] = [];
afterEach(() => {
  closeBackends();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("cancels inside stored SQLite reading and preserves same-connection and reopened history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-stored-reader-"));
  dirs.push(dir);
  const base: WorkRecord = {
    version: 1,
    type: "work",
    workId: "11111111-1111-4111-8111-111111111111",
    sessionId: "native-reader",
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
  // 1,025 rows: the first page (128) is far from the whole store.
  const native: WorkRecord[] = [
    base,
    ...Array.from(
      { length: 1024 },
      (_, index): WorkRecord => ({
        ...base,
        type: "request",
        requestId: `native-${index}`,
        scope: null,
        padding: "x".repeat(1024),
      }),
    ),
  ];
  const sourcePath = join(dir, "work-attribution", `${encodeURIComponent(base.sessionId)}.jsonl`);
  const backend = backendFor(dir);
  backend.tx(() => {
    for (const record of native) {
      const recordHash = recordHashOf(record);
      backend.insertRecord({
        recordHash,
        type: record.type,
        workId: record.workId,
        sessionId: record.sessionId,
        body: JSON.stringify(record),
        sourcePath,
        sourceGeneration: 0,
        sourceOffset: null,
        importedAt: Date.now(),
      });
      backend.upsertMarker(recordHash, record.workId, record.type);
    }
  });
  rebuildWork(dir, base.workId);
  const read = backend.readRecords.bind(backend);
  const page = backend.readRecordPage.bind(backend);
  const before = read({});
  const readAsync = async (signal: AbortSignal): Promise<WorkRecord[]> =>
    (await readStoredRecordsAsync(dir, () => signal.throwIfAborted())).map((row) =>
      JSON.parse(row.body),
    );

  const controller = new AbortController();
  const sentinel = new Error("native reader closed");
  let visited = 0;
  let callbackRan = false;
  let rowsAtAbort = 0;
  backend.readRecordPage = (after, through, limit, checkBudget) =>
    page(after, through, limit, () => {
      if (++visited === 2)
        setImmediate(() => {
          callbackRan = true;
          rowsAtAbort = visited;
          controller.abort(sentinel);
        });
      checkBudget?.();
    });
  let cancelled = false;
  try {
    await readAsync(controller.signal);
  } catch (error) {
    if (error !== sentinel) throw error;
    cancelled = true;
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve));
    backend.readRecordPage = page;
  }
  // No reconnect: the same connection must read the complete, unchanged history after the abort.
  const sameConnectionComplete = JSON.stringify(read({})) === JSON.stringify(before);

  const added: WorkRecord = {
    ...base,
    type: "request",
    requestId: "native-after-abort",
    scope: null,
  };
  capture(dir, added, sourcePath);
  const committed = read({});
  let insertedDuringRead = false;
  backend.readRecordPage = (after, through, limit, checkBudget) => {
    const rows = page(after, through, limit, checkBudget);
    if (!insertedDuringRead) {
      insertedDuringRead = true;
      setImmediate(() => capture(dir, { ...added, requestId: "native-during-page" }, sourcePath));
    }
    return rows;
  };
  // The snapshot pins the records committed when it started: the mid-read capture stays invisible.
  const snapshot = await readAsync(new AbortController().signal);
  backend.readRecordPage = page;
  const next = await readAsync(new AbortController().signal);
  const afterCapture = read({});
  closeBackends();
  const reopened = backendFor(dir).readRecords({});

  expect(visited).toBeGreaterThan(0);
  expect(callbackRan).toBe(true);
  expect(cancelled).toBe(true);
  expect(before).toHaveLength(1025);
  expect(rowsAtAbort).toBeGreaterThan(0);
  expect(rowsAtAbort).toBeLessThan(before.length);
  expect(sameConnectionComplete).toBe(true);
  expect(committed).toHaveLength(before.length + 1);
  expect(JSON.stringify(snapshot)).toBe(
    JSON.stringify(committed.map((row) => JSON.parse(row.body))),
  );
  expect(next).toHaveLength(snapshot.length + 1);
  expect(next.at(-1)?.requestId).toBe("native-during-page");
  expect(JSON.stringify(reopened)).toBe(JSON.stringify(afterCapture));
  expect(readdirSync(dir).includes("work-attribution")).toBe(false);
});
