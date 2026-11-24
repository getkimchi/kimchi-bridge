import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, expect, it, mock } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * Directory-entry durability for the capture spool: creation is never inferred from a
 * pre-open existsSync. A retirement can remove the checked file between the check and the
 * O_CREAT open, so every append fsyncs the spool directory, and a created directory chain
 * fsyncs every level it added plus the first existing ancestor. The race is injected at the
 * openSync that creates the file, through a fresh module instance whose node:fs is wrapped —
 * the rest of the suite keeps the real one.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

const realFs = await import("node:fs");
const realOpenSync = realFs.openSync;
const realCloseSync = realFs.closeSync;
const realFsyncSync = realFs.fsyncSync;
let spoolPath = "";
let retireBeforeCreate: (() => void) | undefined;
let injected = false;
let createdViaOpen = false;
const fdPaths = new Map<number, string>();
const fsynced = new Map<string, number>();
mock.module("node:fs", () => ({
  ...realFs,
  openSync: ((path: string, flags: number, mode?: number) => {
    // The real importer retires the checked file before this open creates its replacement.
    if (
      !injected &&
      retireBeforeCreate &&
      String(path) === spoolPath &&
      (flags & realFs.constants.O_CREAT) !== 0
    ) {
      injected = true;
      retireBeforeCreate();
    }
    const fd = realOpenSync(path, flags, mode);
    fdPaths.set(fd, String(path));
    if (String(path) === spoolPath && (flags & realFs.constants.O_CREAT) !== 0)
      createdViaOpen = true;
    return fd;
  }) as typeof realFs.openSync,
  closeSync: ((fd: number) => {
    fdPaths.delete(fd);
    return realCloseSync(fd);
  }) as typeof realFs.closeSync,
  fsyncSync: ((fd: number) => {
    const result = realFsyncSync(fd);
    const path = fdPaths.get(fd);
    if (path?.startsWith(spoolPath.slice(0, spoolPath.indexOf("/work-attribution"))))
      fsynced.set(path, (fsynced.get(path) ?? 0) + 1);
    return result;
  }) as typeof realFs.fsyncSync,
}));
// Fresh module instances see the wrapped node:fs above; the rest of the suite keeps the real one.
const records = (await import(
  new URL("../../src/ledger/records.js?dirsync-test", import.meta.url).href
)) as typeof import("../../src/ledger/records.js");
const importer = (await import(
  new URL("../../src/ledger/import.js?dirsync-test", import.meta.url).href
)) as typeof import("../../src/ledger/import.js");

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-dirsync-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  retireBeforeCreate = undefined;
  records.closeBackends();
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

/** A ledger-driver child holding the writer lock, so capture parks the record in the spool. */
async function holdWriter(dir: string, ms: number): Promise<{ done: Promise<number | null> }> {
  const child = spawn("bun", [DRIVER, "hold-writer", dir, String(ms)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || (JSON.parse(first.value) as { held?: boolean }).held !== true)
    throw new Error("holder did not report a held writer");
  return { done: new Promise<number | null>((resolve) => child.once("exit", resolve)) };
}

it("an O_CREAT-created replacement spool entry gets its directory fsynced", async () => {
  const dir = agentDir();
  expect(records.readRecords(dir)).toHaveLength(0);
  spoolPath = records.spoolFilePath(dir, "session");
  mkdirSync(dirname(spoolPath), { recursive: true, mode: 0o700 });
  writeFileSync(spoolPath, `\n${JSON.stringify(record("old"))}\n`, { mode: 0o600 });
  const stat = statSync(spoolPath);
  records.backendFor(dir).putJournalCursor({
    path: spoolPath,
    dev: stat.dev,
    ino: stat.ino,
    generation: 1,
    offset: stat.size,
    boundaryHash: "",
    updatedAt: Date.now(),
  });
  // The check observes the old file, then the real importer claims and unlinks that inode; the
  // O_CREAT open below creates a replacement despite any pre-open existence check. Its own
  // retirement fsyncs are cleared, so only the append's own directory durability counts.
  retireBeforeCreate = () => {
    importer.importSpool(dir);
    fsynced.clear();
  };
  const holder = await holdWriter(dir, 1500);
  try {
    records.capture(dir, record("replacement"), "summary-native");
  } finally {
    await holder.done;
  }
  // The replacement was created through the O_CREAT open, and the acknowledged directory entry is
  // durable: the spool directory was fsynced after it.
  expect(injected).toBe(true);
  expect(createdViaOpen).toBe(true);
  expect(fsynced.get(dirname(spoolPath)) ?? 0).toBeGreaterThanOrEqual(1);
  // The record survives the round trip exactly once.
  expect(importer.importSpool(dir).imported).toBe(1);
  expect(
    records
      .readRecords(dir)
      .map((row) => row.requestId)
      .sort(),
  ).toEqual(["old", "replacement"]);
  expect(importer.spoolFiles(dir)).toHaveLength(0);
}, 20_000);

it("an append to an existing spool file syncs the file only, not the directory", async () => {
  const dir = agentDir();
  expect(records.readRecords(dir)).toHaveLength(0);
  spoolPath = records.spoolFilePath(dir, "session");
  const spool = spoolPath;
  // First contended capture: the O_EXCL open creates the file, so the append fsyncs the file
  // and the spool directory that took its new entry.
  let holder = await holdWriter(dir, 1500);
  try {
    records.capture(dir, record("first"), "summary-native");
  } finally {
    await holder.done;
  }
  const dirFsyncsAfterFirst = fsynced.get(dirname(spool)) ?? 0;
  expect(dirFsyncsAfterFirst).toBeGreaterThanOrEqual(1);
  expect(fsynced.get(spool) ?? 0).toBeGreaterThanOrEqual(1);
  // Steady state under sustained contention: the file's entry is unchanged, so every later
  // append syncs only the file — no avoidable blocking directory flush on the capture path.
  for (let index = 0; index < 3; index++) {
    holder = await holdWriter(dir, 800);
    try {
      records.capture(dir, record(`again-${index}`), "summary-native");
    } finally {
      await holder.done;
    }
  }
  expect(fsynced.get(dirname(spool)) ?? 0).toBe(dirFsyncsAfterFirst);
  expect(fsynced.get(spool) ?? 0).toBeGreaterThanOrEqual(4);
  // Every record survives the round trip exactly once.
  expect(importer.importSpool(dir).imported).toBe(4);
  expect(records.readRecords(dir)).toHaveLength(4);
  expect(importer.spoolFiles(dir)).toHaveLength(0);
}, 20_000);

it("a created spool directory chain fsyncs every level it added plus the first ancestor", async () => {
  const dir = agentDir();
  // Open the backend before contention, as the session process long since did.
  expect(records.readRecords(dir)).toHaveLength(0);
  spoolPath = records.spoolFilePath(dir, "session");
  const holder = await holdWriter(dir, 500);
  try {
    records.capture(dir, record("fresh-chain"), "summary-native");
  } finally {
    await holder.done;
  }
  const spool = dirname(spoolPath);
  const attribution = dirname(spool);
  const agent = dirname(attribution);
  // The file's entry (spool), the spool directory's entry (attribution) and the attribution
  // directory's entry (agent) are each persisted by an fsync of the directory holding them.
  expect(fsynced.get(spool) ?? 0).toBeGreaterThanOrEqual(1);
  expect(fsynced.get(attribution) ?? 0).toBeGreaterThanOrEqual(1);
  expect(fsynced.get(agent) ?? 0).toBeGreaterThanOrEqual(1);
  expect(importer.importSpool(dir).imported).toBe(1);
  expect(records.readRecords(dir).map((row) => row.requestId)).toEqual(["fresh-chain"]);
}, 20_000);
