import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { WorkRecord } from "../../src/ledger/work-record.js";
import { afterEach, expect, it, mock } from "bun:test";

/**
 * The round-3 residual for failure-003: the same-inode/same-metadata REPLACEMENT. The entry
 * at the spool path is retired and replaced by another creator's entry whose recycled inode,
 * size, mtime and ctime ALL match the original's — the exact shape that defeated the old
 * fresh-entry metadata comparison (the pre-fix run acknowledged the append with
 * dirFsyncs: 0). The append must land on the live entry with the directory record persisted
 * before its first byte, whatever the metadata says.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

const realFs = await import("node:fs");
const realOpenSync = realFs.openSync;
const realCloseSync = realFs.closeSync;
const realFsyncSync = realFs.fsyncSync;
const realLstatSync = realFs.lstatSync;
const realFstatSync = realFs.fstatSync;
const realWriteSync = realFs.writeSync;
let spoolPath = "";
let retireBeforeCreate: (() => void) | undefined;
let injected = false;
/** The complete metadata collision, simulated on a fine-grained filesystem the way the
 *  adjudication's coarse-timestamp/recycled-inode shape behaves: the fstat of the fallback
 *  open's descriptor (really the replacement's inode) reports the ORIGINAL entry's stat, so
 *  every field the production code compares — inode, size, mtime, ctime — matches. */
let fstatOverride: { ino: number; size: number; mtimeMs: number; ctimeMs: number } | undefined;
const fdPaths = new Map<number, string>();
const fsynced = new Map<string, number>();
mock.module("node:fs", () => ({
  ...realFs,
  openSync: ((path: string, flags: number, mode?: number) => {
    if (!injected && retireBeforeCreate && String(path) === spoolPath) {
      injected = true;
      retireBeforeCreate();
    }
    const fd = realOpenSync(path, flags, mode);
    fdPaths.set(fd, String(path));
    return fd;
  }) as typeof realFs.openSync,
  closeSync: ((fd: number) => {
    fdPaths.delete(fd);
    return realCloseSync(fd);
  }) as typeof realFs.closeSync,
  fstatSync: ((fd: number) => {
    const result = realFstatSync(fd);
    if (fstatOverride !== undefined && fdPaths.get(fd) === spoolPath) {
      // Keep the Stats prototype: the append's identity checks call isFile().
      const overridden = Object.create(Object.getPrototypeOf(result));
      Object.assign(overridden, result, fstatOverride);
      return overridden;
    }
    return result;
  }) as typeof realFs.fstatSync,
  fsyncSync: ((fd: number) => {
    const result = realFsyncSync(fd);
    const path = fdPaths.get(fd);
    if (path?.startsWith(spoolPath.slice(0, spoolPath.indexOf("/work-attribution"))))
      fsynced.set(path, (fsynced.get(path) ?? 0) + 1);
    return result;
  }) as typeof realFs.fsyncSync,
  writeSync: ((...args: unknown[]) => {
    // The first write on the spool descriptor ends the collision: the fresh-entry decision
    // (which reads the overridden fstat) precedes every write, and the append's own tail
    // verification must see the real post-write size.
    if (fdPaths.get(args[0] as number) === spoolPath) fstatOverride = undefined;
    return realWriteSync(...(args as Parameters<typeof realWriteSync>));
  }) as typeof realFs.writeSync,
}));
const records = (await import(
  new URL("../../src/ledger/records.js?collision-probe", import.meta.url).href
)) as typeof import("../../src/ledger/records.js");
const importer = (await import(
  new URL("../../src/ledger/import.js?collision-probe", import.meta.url).href
)) as typeof import("../../src/ledger/import.js");

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-b4-r4-collision-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  retireBeforeCreate = undefined;
  injected = false;
  fstatOverride = undefined;
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

it("a complete-metadata collision replacement still gets its directory fsynced before the ack", async () => {
  const dir = agentDir();
  spoolPath = records.spoolFilePath(dir, "session");
  const spool = spoolPath;
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  // Another writer's EMPTY entry at the spool path (created but not yet written).
  writeFileSync(spool, "", { mode: 0o600 });
  // Another creator's EMPTY replacement, prepared in advance.
  const other = join(dir, "other-creator-entry");
  writeFileSync(other, "", { mode: 0o600 });
  // The collision: the fallback open lands on the replacement, but its fstat reports the
  // ORIGINAL entry's stat — a recycled inode with equal size and coarse timestamps — so
  // every compared field (ino, size, mtimeMs, ctimeMs) matches and the old fresh-entry
  // detection misses the replacement.
  const originalStat = realLstatSync(spool);
  fstatOverride = {
    ino: originalStat.ino,
    size: originalStat.size,
    mtimeMs: originalStat.mtimeMs,
    ctimeMs: originalStat.ctimeMs,
  };
  retireBeforeCreate = () => {
    renameSync(spool, join(dir, "retired-old-entry"));
    renameSync(other, spool);
    fsynced.clear();
  };
  const holder = await holdWriter(dir, 1500);
  try {
    records.capture(dir, record("appended"), "summary-native");
  } finally {
    await holder.done;
  }
  console.log(
    JSON.stringify({
      fsynced: [...fsynced.entries()],
      liveStat: realLstatSync(spool),
      spoolText: realFs.readFileSync(spool, "utf8"),
    }),
  );
  const result = {
    injected,
    fileFsyncs: fsynced.get(spool) ?? 0,
    dirFsyncs: fsynced.get(dirname(spool)) ?? 0,
  };

  expect(injected).toBe(true);
  expect(importer.importSpool(dir).imported).toBe(1);
  expect(records.readRecords(dir).map((row) => row.requestId)).toEqual(["appended"]);
  expect(result.dirFsyncs).toBeGreaterThanOrEqual(1);
}, 20_000);
