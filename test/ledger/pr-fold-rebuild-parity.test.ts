import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createMemoryRecords } from "../../src/ledger/memory-records.js";
import {
  backendFor,
  capture,
  closeBackends,
  readWorkHead,
  rebuildWork,
  useBackendFactory,
} from "../../src/ledger/records.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * Capture/rebuild parity on equal-timestamp PR observations (correctness-013). Two commit rows
 * observe the SAME pull request — same valid id, URL and checkedAt — with different states, and
 * the older row is updated after the newer row was captured. The incremental capture fold merges
 * the saved head's summary with the touched rows (head first); the whole-work rebuild merges
 * every commit row in projection order. When the merge's rank order cannot separate two
 * conflicting observations (equal checkedAt, equal identity strength), the fold must not pick a
 * winner inline: it defers to the bounded rebuild, so capture and rebuildWork publish the SAME
 * final state from the same final rows.
 */

const WORK = "11111111-1111-4111-8111-111111111111";
const SESSION = "session-pr-fold";
const CHECKED_AT = "2026-10-01T00:00:00.000Z";

/** The one alias every observation shares: a confirmed GitHub identity, one URL, one timestamp. */
const observation = (state: "open" | "closed" | "merged", checkedAt = CHECKED_AT) => ({
  provider: "github",
  host: "github.com",
  id: "PR_kwDOExampleExample1",
  url: "https://github.com/example/repo/pull/7",
  number: 7,
  state,
  checkedAt,
});

const commit = (
  sha: string,
  state: "open" | "closed" | "merged",
  checkedAt = CHECKED_AT,
): WorkRecord => ({
  version: 1,
  type: "commit",
  workId: WORK,
  sessionId: SESSION,
  sha,
  repository: "/src/app/.git",
  worktree: "/src/app",
  recordedAt: CHECKED_AT,
  pullRequests: [observation(state, checkedAt)],
});

/** A-open, then B-closed, then A-updated-to-merged: all on one alias, all at one timestamp. */
function captureSequence(agentDir: string): void {
  capture(agentDir, commit("a".repeat(40), "open"), "/ignored/source");
  capture(agentDir, commit("b".repeat(40), "closed"), "/ignored/source");
  capture(agentDir, commit("a".repeat(40), "merged"), "/ignored/source");
}

function prStates(head: ReturnType<typeof readWorkHead>): string[] | undefined {
  return head?.pullRequests.map((pr) => String(pr.state)).sort();
}

function agentDir(): string {
  return mkdtempSync(join(tmpdir(), "kimchi-pr-fold-"));
}

describe("capture/rebuild parity on equal-timestamp PR observations", () => {
  const dirs: string[] = [];
  afterEach(() => {
    useBackendFactory(null);
    closeBackends();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("the A-open/B-closed/A-merged sequence publishes one state from capture and rebuild (memory)", () => {
    const dir = agentDir();
    dirs.push(dir);
    useBackendFactory(() => createMemoryRecords());
    captureSequence(dir);
    const fromCapture = prStates(readWorkHead(dir, WORK));
    rebuildWork(dir, WORK);
    const fromRebuild = prStates(readWorkHead(dir, WORK));
    expect(fromCapture).toEqual(fromRebuild);
    // The fold could not order the conflicting observations the way the rebuild does, so it
    // deferred: the work carries the dirty marker, not a head the rebuild would not reproduce.
    expect(backendFor(dir).hasDirty(WORK)).toBe(false);
  });

  it("the A-open/B-closed/A-merged sequence publishes one state from capture and rebuild (SQLite)", () => {
    const dir = agentDir();
    dirs.push(dir);
    useBackendFactory(null);
    captureSequence(dir);
    const fromCapture = prStates(readWorkHead(dir, WORK));
    rebuildWork(dir, WORK);
    const fromRebuild = prStates(readWorkHead(dir, WORK));
    expect(fromCapture).toEqual(fromRebuild);
    expect(backendFor(dir).hasDirty(WORK)).toBe(false);
  });

  it("unambiguous observations keep folding inline: capture still publishes without a rebuild", () => {
    // The same alias at DIFFERENT timestamps is a total order — the newest observation wins in
    // both paths — so the fold must not defer.
    const dir = agentDir();
    dirs.push(dir);
    useBackendFactory(() => createMemoryRecords());
    capture(dir, commit("a".repeat(40), "open", "2026-10-01T00:00:00.000Z"), "/ignored/source");
    capture(dir, commit("b".repeat(40), "closed", "2026-10-01T01:00:00.000Z"), "/ignored/source");
    expect(backendFor(dir).hasDirty(WORK)).toBe(false);
    const head = readWorkHead(dir, WORK);
    expect(head?.pullRequests.map((pr) => String(pr.state))).toEqual(["closed"]);
  });
});
