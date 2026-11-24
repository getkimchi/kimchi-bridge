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
 * The sliced rebuild pins the work's population and the authority watermark in that order: a
 * same-work capture that commits while the rebuild runs is either inside the pinned pages or
 * moves the record count, so the publication re-check restarts the rebuild instead of
 * publishing a projection that omits it. Each regression races a real capture child process —
 * one that commits between the two snapshot reads, and one that commits after the watermark —
 * and requires the published projection to contain it with the dirty marker cleared.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");
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

/** Seeds an unheaded work big enough to page, arms the watermark hook, and runs the rebuild. */
function rebuildWithCaptureAt(hook: "between" | "after"): {
  injected: boolean;
  childStatus: number | null;
} {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-rebuild-snapshot-race-"));
  dirs.push(dir);
  const backend = backendFor(dir);
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
  let injected = false;
  let childStatus: number | null = null;
  const captureChild = () => {
    injected = true;
    const child = spawnSync("bun", [DRIVER, "capture", dir, JSON.stringify(record("req-raced"))], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    childStatus = child.status;
  };
  const watermark = backend.recordWatermark;
  backend.recordWatermark = () => {
    if (injected) return watermark();
    if (hook === "between") captureChild();
    const through = watermark();
    if (hook === "after") captureChild();
    return through;
  };
  rebuildWork(dir, WORK);
  return { injected, childStatus };
}

/** The raced record must survive in the authority and the published projection, with no dirty. */
function requireRacedRecordPublished(injected: boolean, childStatus: number | null): void {
  expect(injected).toBe(true);
  expect(childStatus).toBe(0);
  const dir = dirs[dirs.length - 1];
  const projection = readWorkSummary(dir, WORK);
  expect(projection?.requests.some((row) => row.requestId === "req-raced")).toBe(true);
  expect(backendFor(dir).dirtyWorks()).toEqual([]);
}

it("a capture between the rebuild's population and watermark reads reaches the projection", () => {
  // Seeding 2,500 records and racing a real child process (a fresh Bun startup) makes this
  // legitimately multi-second work; a loaded machine can need more than the 5 s default.
  const race = rebuildWithCaptureAt("between");
  requireRacedRecordPublished(race.injected, race.childStatus);
}, 30_000);

it("a capture after the rebuild's watermark reaches the projection, not just the authority", () => {
  const race = rebuildWithCaptureAt("after");
  requireRacedRecordPublished(race.injected, race.childStatus);
}, 30_000);
