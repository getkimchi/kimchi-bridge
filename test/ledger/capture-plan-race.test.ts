import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import {
  backendFor,
  capture,
  closeBackends,
  importBatchInTx,
  readRecords,
  readWorkHead,
  readWorkSummary,
  rebuildWork,
} from "../../src/ledger/records.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * The capture fold's plan-versus-publication ordering (round-6 correctness-012 / failure-009):
 * a capture plan must never be stamped with a database version NEWER than the reads it
 * actually derived from. The version sample and the plan's head/row reads bracket a window
 * another writer can commit inside: a plan stamped after its reads carries the competing
 * writer's version without its rows, so the publication transaction's currency check accepts
 * it and replays stale projection state over the newer committed authority — a clean head that
 * permanently disagrees with the records until a rebuild happens to run. The regressions here
 * inject a real competing capture at exactly those read boundaries against the real SQLite
 * backend, deterministically, in one process.
 */

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-plan-race-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const WORK = "00000000-0000-4000-8000-000000000001";

/** One commit record; `links` may be empty or carry URL-only/id-bearing PR observations at one time. */
function commitRecord(
  sha: string,
  links: { id?: string; url: string; state: string }[] = [],
): WorkRecord {
  return {
    version: 1,
    type: "commit",
    workId: WORK,
    sessionId: "session",
    sha,
    repository: "github.com/o/r",
    worktree: "/w",
    recordedAt: "2026-10-01T00:00:00.000Z",
    pullRequests: links.map((link) => ({
      provider: "github",
      host: "github.com",
      ...(link.id === undefined ? {} : { id: link.id }),
      url: `https://github.com/o/r${link.url}`,
      checkedAt: "2026-10-01T00:00:00.000Z",
      state: link.state,
    })),
  } as WorkRecord;
}

/** The link ids a work's published head carries. */
function headLinkIds(dir: string): string[] {
  return (readWorkHead(dir, WORK)?.pullRequests ?? []).map((link) => String(link.id));
}

it("a competing capture between the plan's head read and its version sample cannot publish a stale head", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  // The seeded head carries PR 100; the plan under test folds PR 200 onto it, and a competing
  // capture commits PR 300 in the window between the plan's head read and its version sample.
  capture(
    dir,
    commitRecord("a".repeat(40), [{ id: "100", url: "/pull/100", state: "open" }]),
    "/ignored/source",
  );
  const planned = commitRecord("b".repeat(40), [{ id: "200", url: "/pull/200", state: "open" }]);
  const competing = commitRecord("c".repeat(40), [{ id: "300", url: "/pull/300", state: "open" }]);
  const realGetHead = backend.getHead;
  let injected = false;
  backend.getHead = ((workId: string) => {
    const saved = realGetHead.call(backend, workId);
    if (!injected && workId === WORK) {
      injected = true;
      // The competing capture commits here: AFTER the plan's head read (the plan keeps the
      // pre-compete head) and BEFORE the plan's sole version sample.
      capture(dir, competing, "/ignored/source");
    }
    return saved;
  }) as typeof realGetHead;
  try {
    capture(dir, planned, "/ignored/source");
  } finally {
    backend.getHead = realGetHead;
  }
  // The authority holds all three commits — nothing was dropped.
  expect(readRecords(dir).filter((row) => row.workId === WORK)).toHaveLength(3);
  // The published head agrees with the authority: the competing capture's PR 300 link is
  // present (the pre-fix plan replayed the stale head without it, cleanly, and no reader
  // repaired a present, clean head).
  const head = readWorkHead(dir, WORK);
  expect(headLinkIds(dir)).toEqual(expect.arrayContaining(["100", "200", "300"]));
  expect(head?.logs.commits?.rows).toBe(3);
});

it("a competing capture between the plan's row reads and its version sample cannot undercount the head", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  // failure-009's shape: the seeded commit and the planned capture's commit both fold; a
  // competing capture commits a third commit row inside the plan's row-read window.
  capture(
    dir,
    commitRecord("0".repeat(40), [{ id: "1", url: "/pull/1", state: "open" }]),
    "/ignored/source",
  );
  const planned = commitRecord("b".repeat(40), [{ id: "2", url: "/pull/2", state: "open" }]);
  const competing = commitRecord("c".repeat(40), [{ id: "3", url: "/pull/3", state: "open" }]);
  const realGetRow = backend.getRow;
  let injected = false;
  backend.getRow = ((workId: string, log: Parameters<typeof realGetRow>[1], key: string) => {
    const row = realGetRow.call(backend, workId, log, key);
    if (!injected && workId === WORK) {
      injected = true;
      // The competing capture commits here: after the plan read the head, among the plan's
      // touched-row reads, and before the plan's sole version sample.
      capture(dir, competing, "/ignored/source");
    }
    return row;
  }) as typeof realGetRow;
  try {
    capture(dir, planned, "/ignored/source");
  } finally {
    backend.getRow = realGetRow;
  }
  expect(readRecords(dir).filter((row) => row.workId === WORK)).toHaveLength(3);
  // The published head counts every commit row (the pre-fix plan published a clean head with
  // 2 rows against 3 committed, and head.logs.commits.rows stayed wrong until a rebuild).
  const head = readWorkHead(dir, WORK);
  expect(head?.logs.commits?.rows).toBe(3);
  expect(readWorkSummary(dir, WORK)?.commits).toHaveLength(3);
});

it("a truncated projection defers capture and import until bounded re-derivation", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  capture(
    dir,
    commitRecord("a".repeat(40), [{ id: "100", url: "/pull/100", state: "open" }]),
    "/ignored/source",
  );
  backend.putHead({ ...backend.getHead(WORK)!, truncated: true });

  capture(
    dir,
    commitRecord("b".repeat(40), [{ id: "200", url: "/pull/200", state: "open" }]),
    "/ignored/source",
  );
  expect(backend.dirtyWorks()).toEqual([WORK]);
  const incoming = commitRecord("c".repeat(40), [{ id: "300", url: "/pull/300", state: "open" }]);
  backend.tx(() => {
    const inserted = importBatchInTx(backend, [
      {
        line: JSON.stringify(incoming),
        record: incoming,
        sourcePath: "/journal",
        sourceGeneration: 1,
        sourceOffset: 2,
      },
    ]);
    expect(inserted).toBe(1);
  });
  expect(backend.dirtyWorks()).toEqual([WORK]);

  const repaired = readWorkHead(dir, WORK);
  expect(backend.dirtyWorks()).toEqual([]);
  expect(repaired?.truncated).not.toBe(true);
  expect(headLinkIds(dir)).toEqual(["100", "200", "300"]);
  expect(readRecords(dir).filter((row) => row.workId === WORK)).toHaveLength(3);
});

it("a competing truncated publication cannot be folded by a stale capture plan", () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  capture(
    dir,
    commitRecord("a".repeat(40), [{ id: "100", url: "/pull/100", state: "open" }]),
    "/ignored/source",
  );
  const planned = commitRecord("b".repeat(40), [{ id: "200", url: "/pull/200", state: "open" }]);
  const realGetHead = backend.getHead;
  let injected = false;
  backend.getHead = ((workId: string) => {
    const saved = realGetHead.call(backend, workId);
    if (!injected && workId === WORK) {
      injected = true;
      if (saved) backend.putHead({ ...saved, truncated: true });
      backend.tx(() => {});
    }
    return saved;
  }) as typeof realGetHead;
  try {
    capture(dir, planned, "/ignored/source");
  } finally {
    backend.getHead = realGetHead;
  }
  expect(injected).toBe(true);
  expect(backend.dirtyWorks()).toEqual([WORK]);
  const repaired = readWorkHead(dir, WORK);
  expect(backend.dirtyWorks()).toEqual([]);
  expect(repaired?.truncated).not.toBe(true);
  expect(headLinkIds(dir)).toEqual(expect.arrayContaining(["100", "200"]));
  expect(readRecords(dir).filter((row) => row.workId === WORK)).toHaveLength(2);
});

it("the incremental capture fold and the rebuild agree on URL-alias ties with equal checkedAt", () => {
  const dir = agentDir();
  // correctness-013's three-capture shape: commit A with no links, commit B with PR id 2 /
  // URL /pull/5 / open, then commit A again with the same URL but no id / closed — all at
  // the same valid timestamp, final row order A then B. The capture fold merges the already
  // folded head first and the touched row second; the rebuild merges every commit row in
  // projection order. mergePullRequestLinks resolves equal-checkedAt URL aliases
  // order-sensitively today, so the two paths can publish different persisted state
  // (the round-6 probe: the capture head said closed where rebuildWork said open).
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  capture(dir, commitRecord(A), "/ignored/source");
  capture(dir, commitRecord(B, [{ id: "2", url: "/pull/5", state: "open" }]), "/ignored/source");
  capture(dir, commitRecord(A, [{ url: "/pull/5", state: "closed" }]), "/ignored/source");
  const captureState = readWorkHead(dir, WORK)?.pullRequests.find(
    (link) => link.url === "https://github.com/o/r/pull/5",
  )?.state;
  rebuildWork(dir, WORK);
  const rebuildState = readWorkHead(dir, WORK)?.pullRequests.find(
    (link) => link.url === "https://github.com/o/r/pull/5",
  )?.state;
  // Both paths publish the same persisted state for the same rows — the id-bearing
  // observation of the alias wins the equal-timestamp tie in either merge order.
  expect(captureState).toBe(rebuildState);
  expect(rebuildState).toBe("open");
});
