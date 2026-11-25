import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createMemoryRecords } from "../../src/ledger/memory-records.js";
import {
  backendFor,
  capture,
  closeBackends,
  importBatchInTx,
  type ImportEntry,
  type RecordBackend,
  readWorkHead,
  useBackendFactory,
} from "../../src/ledger/records.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * Backend-factory compatibility (contracts-002): hasDirty and headBodyBytes were added to
 * RecordBackend after round 6, and making them required breaks every backend written against
 * round 6 — a TypeError at runtime (capture calls the missing member) and a typecheck failure.
 * They are optional members: internal callers go through backendHasDirty and
 * backendHeadBodyBytes, which fall back to dirtyWorks() and
 * Buffer.byteLength(JSON.stringify(getHead())) when the backend predates the members, so a
 * round-6-shaped backend passes capture, import and readWorkHead unchanged.
 */

const WORK = "11111111-1111-4111-8111-111111111111";
const SESSION = "session-backend-compat";

const record = (requestId: string): WorkRecord => ({
  version: 1,
  type: "request",
  workId: WORK,
  sessionId: SESSION,
  requestId,
  startedAt: "2026-10-01T00:01:00.000Z",
  recordedAt: "2026-10-01T00:30:00.000Z",
});

const entry = (requestId: string): ImportEntry => ({
  line: JSON.stringify(record(requestId)),
  record: record(requestId),
  sourcePath: "/journal",
  sourceGeneration: 1,
  sourceOffset: 0,
});

/** The RecordBackend surface as round 6 defined it: every required member present, the two
 *  later additions absent. */
type RoundSixBackend = Omit<RecordBackend, "hasDirty" | "headBodyBytes">;

/** Strips the two post-round-6 members from a backend, exactly as a round-6 implementation
 *  would be missing them. */
function roundSixShape(backend: RecordBackend): RoundSixBackend {
  const stripped: RecordBackend = { ...backend };
  delete stripped.hasDirty;
  delete stripped.headBodyBytes;
  return stripped;
}

function agentDir(): string {
  return mkdtempSync(join(tmpdir(), "kimchi-backend-compat-"));
}

describe("round-6 shaped backends stay valid RecordBackends", () => {
  const dirs: string[] = [];
  afterEach(() => {
    useBackendFactory(null);
    closeBackends();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a backend without hasDirty and headBodyBytes captures, imports and reads", () => {
    const dir = agentDir();
    dirs.push(dir);
    const roundSix = roundSixShape(createMemoryRecords());
    // The round-6 shape must satisfy the RecordBackend contract without the later members:
    // this assignment is the typecheck half of the proof, the exercise below is the runtime half.
    const asContract: RecordBackend = roundSix;
    useBackendFactory(() => asContract);
    // Capture: the planned fold's oversize/dirty gate reads the stored head's byte length and
    // the dirty marker — the first member a round-6 backend lacks.
    capture(dir, record("req-1"), "/ignored/source");
    // Import: the batch's touched-works gate reads the same members; req-2 is new, req-1 is a
    // duplicate of the captured record, so the fold path runs with one inserted row.
    asContract.tx(() => {
      expect(importBatchInTx(asContract, [entry("req-2"), entry("req-1")])).toBe(1);
    });
    // Read: the clean head is served without repair, the dirty one is rebuilt — the dirty
    // check falls back to dirtyWorks() on a backend without the cheap routing member.
    const head = readWorkHead(dir, WORK);
    expect(head?.logs.requests?.rows).toBe(2);
    asContract.markDirty(WORK);
    const repaired = readWorkHead(dir, WORK);
    expect(repaired?.logs.requests?.rows).toBe(2);
    expect(asContract.dirtyWorks()).toEqual([]);
    expect(backendFor(dir)).toBe(asContract);
  });
});
