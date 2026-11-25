import { spawn } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
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
const realLstatSync = realFs.lstatSync;
const realWriteSync = realFs.writeSync;
let spoolPath = "";
let retireBeforeCreate: (() => void) | undefined;
let injected = false;
let createdViaOpen = false;
/** When set, the spool path's FIRST append writeSync returns zero bytes — the created entry
 *  is then left with an unsynced directory entry until the caller's retry reopens it. */
let failFirstWrite = false;
/** When set, lstatSync on the spool path reports this inode number instead of the entry's
 *  real one, simulating a filesystem that recycled a retired entry's inode onto another
 *  creator's fresh replacement — only the rest of the stat can then tell the two apart. */
let lstatInoOverride: number | undefined;
const fdPaths = new Map<number, string>();
const fsynced = new Map<string, number>();
mock.module("node:fs", () => ({
  ...realFs,
  openSync: ((path: string, flags: number, mode?: number) => {
    // The real importer retires the checked file between the exclusive attempt's EEXIST and
    // this fallback open, so the fallback's O_CREAT creates a replacement entry the old
    // code never directory-fsynced.
    if (!injected && retireBeforeCreate && String(path) === spoolPath) {
      injected = true;
      retireBeforeCreate();
    }
    // Recorded before the real call: the exclusive attempt exists to fail with EEXIST when
    // the entry is there, and the append still ran its create-deciding open.
    if (String(path) === spoolPath && (flags & realFs.constants.O_CREAT) !== 0)
      createdViaOpen = true;
    const fd = realOpenSync(path, flags, mode);
    fdPaths.set(fd, String(path));
    return fd;
  }) as typeof realFs.openSync,
  closeSync: ((fd: number) => {
    fdPaths.delete(fd);
    return realCloseSync(fd);
  }) as typeof realFs.closeSync,
  lstatSync: ((path: string, options?: { bigint?: boolean; throwIfNoEntry?: boolean }) => {
    const result = realLstatSync(path, options);
    if (lstatInoOverride !== undefined && String(path) === spoolPath)
      return { ...result, ino: lstatInoOverride };
    return result;
  }) as typeof realFs.lstatSync,
  writeSync: ((...args: unknown[]) => {
    const fd = args[0] as number;
    if (failFirstWrite && fdPaths.get(fd) === spoolPath) {
      failFirstWrite = false;
      return 0;
    }
    return realWriteSync(...(args as Parameters<typeof realWriteSync>));
  }) as typeof realFs.writeSync,
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
  injected = false;
  createdViaOpen = false;
  failFirstWrite = false;
  lstatInoOverride = undefined;
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

it("a fallback append onto another creator's fresh replacement entry fsyncs the directory", async () => {
  const dir = agentDir();
  expect(records.readRecords(dir)).toHaveLength(0);
  spoolPath = records.spoolFilePath(dir, "session");
  const spool = spoolPath;
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  writeFileSync(spool, `\n${JSON.stringify(record("old"))}\n`, { mode: 0o600 });
  // A concurrent creator replaces the entry between the exclusive attempt's EEXIST and the
  // fallback open: the fallback appends to an entry it did not create through the exclusive
  // path and whose inode differs from the one the EEXIST saw, so the append itself must
  // persist that fresh directory record — the other creator's own durability obligations
  // cannot be assumed to still be alive.
  const other = join(dir, "other-creator-entry");
  writeFileSync(other, "", { mode: 0o600 });
  retireBeforeCreate = () => {
    // Rename the prepared entry over the spool path: the replacement's inode is the other
    // creator's own, guaranteed distinct from the one the EEXIST observed.
    renameSync(other, spool);
    fsynced.clear();
  };
  const holder = await holdWriter(dir, 1500);
  try {
    records.capture(dir, record("appended"), "summary-native");
  } finally {
    await holder.done;
  }
  expect(injected).toBe(true);
  expect(createdViaOpen).toBe(true);
  expect(fsynced.get(dirname(spool)) ?? 0).toBeGreaterThanOrEqual(1);
  // The appended record lands exactly once on the replacement entry the creator left.
  expect(importer.importSpool(dir).imported).toBe(1);
  expect(records.readRecords(dir).map((row) => row.requestId)).toEqual(["appended"]);
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

it("a zero-byte first write on a created entry still fsyncs its directory", async () => {
  const dir = agentDir();
  expect(records.readRecords(dir)).toHaveLength(0);
  spoolPath = records.spoolFilePath(dir, "session");
  const spool = spoolPath;
  // The first attempt's exclusive create makes the spool entry, but its first writeSync
  // returns zero bytes: the append fails before any fsync, and the caller's retry reopens
  // the entry as pre-existing. The creation's directory fsync cannot be dropped with the
  // failed attempt — the acknowledged retry would leave the pathname the next import
  // scans without the entry's durability.
  failFirstWrite = true;
  const holder = await holdWriter(dir, 1500);
  try {
    records.capture(dir, record("zero-write"), "summary-native");
  } finally {
    await holder.done;
  }
  expect(failFirstWrite).toBe(false);
  expect(fsynced.get(spool) ?? 0).toBeGreaterThanOrEqual(1);
  expect(fsynced.get(dirname(spool)) ?? 0).toBeGreaterThanOrEqual(1);
  expect(importer.importSpool(dir).imported).toBe(1);
  expect(records.readRecords(dir).map((row) => row.requestId)).toEqual(["zero-write"]);
  expect(importer.spoolFiles(dir)).toHaveLength(0);
}, 20_000);

it("a fallback append onto a recycled-inode replacement entry fsyncs the directory", async () => {
  const dir = agentDir();
  expect(records.readRecords(dir)).toHaveLength(0);
  spoolPath = records.spoolFilePath(dir, "session");
  const spool = spoolPath;
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  writeFileSync(spool, `\n${JSON.stringify(record("old"))}\n`, { mode: 0o600 });
  // Another creator's fresh replacement entry, prepared in advance: after the retirement
  // below renames it over the spool path, the entry the exclusive attempt's EEXIST observed
  // is reported with the replacement's inode number (a recycled inode), so the inode alone
  // cannot distinguish the entry the fallback open lands on — only its size and timestamps
  // can, and the append must then persist the fresh entry's directory record itself.
  const other = join(dir, "other-creator-entry");
  writeFileSync(other, "", { mode: 0o600 });
  lstatInoOverride = statSync(other).ino;
  retireBeforeCreate = () => {
    renameSync(spool, join(dir, "retired-old-entry"));
    renameSync(other, spool);
    lstatInoOverride = undefined;
    fsynced.clear();
  };
  const holder = await holdWriter(dir, 1500);
  try {
    records.capture(dir, record("appended"), "summary-native");
  } finally {
    await holder.done;
  }
  expect(injected).toBe(true);
  expect(createdViaOpen).toBe(true);
  expect(fsynced.get(dirname(spool)) ?? 0).toBeGreaterThanOrEqual(1);
  // The appended record lands exactly once on the replacement entry the creator left.
  expect(importer.importSpool(dir).imported).toBe(1);
  expect(records.readRecords(dir).map((row) => row.requestId)).toEqual(["appended"]);
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
