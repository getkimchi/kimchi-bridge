import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { statSync as realStat } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StatOptions } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, mock } from "bun:test";
import { backendFor, closeBackends, readRecords, spoolFilePath } from "../../src/ledger/records.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * The spool-claim protocol against a deterministic replacement race: a second importer that
 * validated the old spool file, then finds a capture's replacement at the original path by the
 * time it renames, must leave the claimed bytes in the spool directory (still scanned, still
 * imported) instead of unlining them. The race is injected at the importer's own statSync call,
 * through a fresh module instance whose node:fs is wrapped — the rest of the suite keeps the
 * real one.
 */

const realFs = await import("node:fs");
// Captured before the mock installs: the namespace binding below is live, so reading it after
// would return the wrapper and recurse.
const realStatSync = realFs.statSync;
let statHook: ((path: string) => void) | undefined;
mock.module("node:fs", () => ({
  ...realFs,
  statSync: ((path: string, options?: StatOptions) => {
    const stat = realStatSync(path, options);
    statHook?.(path);
    return stat;
  }) as typeof realFs.statSync,
}));
// The query keeps this a fresh module instance, so the wrapped statSync above is the one it sees.
const { importSpool } = (await import(
  new URL("../../src/ledger/import.js?claim-test", import.meta.url).href
)) as typeof import("../../src/ledger/import.js");

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-claim-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  statHook = undefined;
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const WORK = "00000000-0000-4000-8000-000000000001";

function record(requestId: string): WorkRecord {
  return {
    version: 1,
    type: "request",
    workId: WORK,
    sessionId: "session",
    requestId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

it("a replacement spool claimed after validation is never unlinked", () => {
  const dir = agentDir();
  const path = spoolFilePath(dir, "session");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const old = record("req-old-1");
  const replacement = record("req-new-1");
  // Same length: the old size-only check could not tell these two files apart.
  expect(JSON.stringify(old).length).toBe(JSON.stringify(replacement).length);
  const content = `\n${JSON.stringify(old)}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  // A committed cursor at EOF, exactly as a first import leaves it — without retiring the file.
  const stat = realStat(path);
  backendFor(dir).putJournalCursor({
    path,
    dev: stat.dev,
    ino: stat.ino,
    generation: 1,
    offset: stat.size,
    boundaryHash: "",
    updatedAt: Date.now(),
  });
  let stats = 0;
  statHook = (statted) => {
    if (statted !== path) return;
    if (++stats !== 2) return;
    // Between this importer's validation and its rename: a first importer rotated the old file
    // away, and a capture durably returned a same-length replacement at the original path.
    renameSync(path, join(directory, "first-importer-claim.jsonl"));
    writeFileSync(path, `\n${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  };
  expect(statHook).toBeDefined();
  // The import phase lands the old record (dedup from the cursor's rows), then retirement claims
  // the replacement instead.
  importSpool(dir);
  expect(stats).toBeGreaterThanOrEqual(2);
  expect(readRecords(dir)).toHaveLength(1);
  // The claimed replacement still sits in the spool directory as a scannable file: its record
  // was never deleted before being imported.
  const claims = readdirSync(directory).filter((name) => name.startsWith("claim-"));
  expect(claims.length).toBe(1);
  expect(readFileSync(join(directory, claims[0]), "utf8")).toBe(
    `\n${JSON.stringify(replacement)}\n`,
  );
  // The next pass imports it exactly once, and the spool drains completely.
  statHook = undefined;
  importSpool(dir);
  importSpool(dir);
  expect(readRecords(dir)).toHaveLength(2);
  expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
});
