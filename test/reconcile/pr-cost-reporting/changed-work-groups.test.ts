import { expect, it } from "bun:test";
import { createMemoryRecords } from "../../../src/ledger/memory-records.js";
import { changedWorkGroups } from "../../../src/reconcile/pr-cost-reporting/worker.js";
import type { WorkHead } from "../../../src/ledger/row-log.js";

function head(
  workId: string,
  pullRequests: Record<string, unknown>[],
  truncated = false,
): WorkHead {
  return {
    version: 2,
    workId,
    updatedAt: "2026-10-24T08:00:00.000Z",
    logs: {},
    latest: {},
    pullRequests,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

it("unchanged truncated heads reuse their link index and authority appends refresh it", () => {
  const backend = createMemoryRecords();
  const shared = {
    provider: "github",
    url: "https://example.test/pull/1",
    checkedAt: "2026-10-24T08:00:00Z",
  };
  const other = {
    provider: "github",
    url: "https://example.test/pull/2",
    checkedAt: "2026-10-24T08:00:00Z",
  };
  backend.putHead(head("a", [], true));
  backend.putHead(head("b", [shared]));
  backend.putRow(
    "a",
    "commits",
    "one",
    { sessionId: "session", sha: "one", pullRequests: [shared] },
    0,
  );

  const readLog = backend.readLog.bind(backend);
  let completeReads = 0;
  backend.readLog = (workId, collection) => {
    if (collection === "commits") completeReads++;
    return readLog(workId, collection);
  };

  expect(changedWorkGroups(backend, new Set(["a"]))).toEqual([["a", "b"]]);
  expect(completeReads).toBe(1);
  expect(changedWorkGroups(backend, new Set(["b"]))).toEqual([["a", "b"]]);
  expect(completeReads).toBe(1);

  backend.putHead(head("c", [other]));
  backend.putRow(
    "a",
    "commits",
    "two",
    { sessionId: "session", sha: "two", pullRequests: [other] },
    1,
  );
  backend.insertRecord({
    recordHash: "a".repeat(64),
    type: "note",
    workId: "a",
    sessionId: "session",
    body: "{}",
    sourcePath: "journal.jsonl",
    sourceGeneration: 1,
    sourceOffset: 0,
    importedAt: 1,
  });
  expect(changedWorkGroups(backend, new Set(["a"]))).toEqual([["a", "b", "c"]]);
  expect(completeReads).toBe(2);
});
