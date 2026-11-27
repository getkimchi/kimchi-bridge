import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "bun:test";
import {
  backendFor,
  closeBackends,
  readWorkSummary,
  rebuildWork,
} from "../../src/ledger/records.js";

/**
 * Competing sliced rebuilds: a second rebuild (another process's lazy repair, an importer's
 * missing-projection rebuild) can commit its clear between this rebuild's folded slices and its
 * publication, and can die there. Publication re-verifies the ownership generation that each
 * clear persists, so the interleaving is detected at publish time and this rebuild restarts
 * whole instead of publishing a partial, clean-looking projection over the other's clear. The
 * races are deterministic: rebuild A runs in this process with its second page read intercepted,
 * and actor B is a real child process running the production rebuild, dying exactly after its
 * clear transaction committed (its first fold-page read throws) — the state a SIGKILL leaves.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SEED = 2500;
const WORK = "00000000-0000-4000-8000-000000000001";

const record = (requestId: string) => ({
  version: 1 as const,
  type: "request" as const,
  workId: WORK,
  sessionId: "session",
  requestId,
  scope: null,
  recordedAt: "2026-10-01T00:00:00.000Z",
});

const dirs: string[] = [];
afterEach(() => {
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Seeds an unheaded work big enough to page (2,500 records, 1,000-record cold-start slice). */
function seedUnheaded(dir: string): void {
  const backend = backendFor(dir);
  backend.tx(() => {
    for (let index = 0; index < SEED; index++)
      backend.insertRecord({
        recordHash: `seed-${index}`,
        type: "request",
        workId: WORK,
        sessionId: "session",
        body: JSON.stringify(record(`req-${index}`)),
        sourcePath: "/seed",
        sourceGeneration: 0,
        sourceOffset: index,
        importedAt: index,
      });
  });
}

/** Actor B, a real child process whose production rebuild dies after committing its clear: its
 *  first fold-page read throws, which is exactly the on-disk state a SIGKILL landing between
 *  the clear transaction and the first fold leaves behind (cleared rows, dirty, nothing folded). */
function actorBDiesAfterClear(dir: string): number {
  const child = spawnSync(
    "bun",
    [
      "-e",
      `const { backendFor, rebuildWork } = await import(${JSON.stringify(`${ROOT}src/ledger/records.js`)});
const backend = backendFor(${JSON.stringify(dir)});
backend.readWorkRecordPage = () => { throw new Error("killed after clear"); };
try { rebuildWork(${JSON.stringify(dir)}, ${JSON.stringify(WORK)}); }
catch (error) { if (!String(error).includes("killed after clear")) throw error; }`,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  return child.status ?? -1;
}

/** Actor B, a real child process running the production rebuild to completion. */
function actorBCompletes(dir: string): number {
  const child = spawnSync(
    "bun",
    [
      "-e",
      `const { rebuildWork } = await import(${JSON.stringify(`${ROOT}src/ledger/records.js`)});
rebuildWork(${JSON.stringify(dir)}, ${JSON.stringify(WORK)});`,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  return child.status ?? -1;
}

/** Runs rebuild A with actor B injected after its first folded slice — the interleaving window
 *  where B's clear deletes everything A folded so far. */
function rebuildAWithActorB(dir: string, actorB: (dir: string) => number): number {
  const backend = backendFor(dir);
  const page = backend.readWorkRecordPage.bind(backend);
  let reads = 0;
  let bStatus: number | undefined;
  backend.readWorkRecordPage = (...args: Parameters<typeof page>) => {
    if (++reads === 2) bStatus = actorB(dir);
    return page(...args);
  };
  try {
    rebuildWork(dir, WORK);
  } finally {
    backend.readWorkRecordPage = page;
  }
  return bStatus ?? -1;
}

/** The published projection must be complete — every seeded record a row — with no dirty work
 *  and no residual ownership generation note. */
function requireCompleteProjection(dir: string): void {
  const projection = readWorkSummary(dir, WORK);
  expect(projection?.requests).toHaveLength(SEED);
  expect(new Set(projection?.requests.map((row) => row.requestId))).toHaveLength(SEED);
  expect(backendFor(dir).dirtyWorks()).toEqual([]);
  expect(backendFor(dir).getNote(WORK, "__rebuild-ownership")).toBeUndefined();
}

it("a rebuild that dies after a competing clear is never published partial", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-rebuild-ownership-"));
  dirs.push(dir);
  seedUnheaded(dir);
  // A folds its first slice; B commits its clear and dies before folding anything; A resumes
  // and must detect B's generation at publication and restart whole — never publish the
  // partial rows that survived B's clear as a clean-looking projection.
  expect(rebuildAWithActorB(dir, actorBDiesAfterClear)).toBe(0);
  requireCompleteProjection(dir);
}, 60_000);

it("a rebuild that completes over a competing rebuild's folded slices forces a whole restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-rebuild-ownership-"));
  dirs.push(dir);
  seedUnheaded(dir);
  // A folds its first slice; B (a competing rebuild, run to completion by another process)
  // replaces the projection wholesale; A's publication must detect B's generation and restart,
  // so the final head is built from a single consistent fold.
  expect(rebuildAWithActorB(dir, actorBCompletes)).toBe(0);
  requireCompleteProjection(dir);
}, 60_000);
