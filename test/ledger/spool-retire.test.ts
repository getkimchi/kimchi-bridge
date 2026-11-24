import { spawn, spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, mock } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * Retirement racing an in-flight spool append, with a real importer in a second process. A
 * capture holds the spool inode open while the importer claims the file (atomic rename) and
 * unlinks it: the writer-side fix re-checks the live path's identity after the append and
 * re-appends to a fresh spool file, and the importer-side fix never unlinks a claim that grew
 * past its committed cursor, so no acknowledged record can be lost to an unlinked inode. A
 * hardlinked spool (an unsafe inode) is refused at retirement instead of unlinked, keeping the
 * external name's raw bytes.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

const realFs = await import("node:fs");
const realWriteSync = realFs.writeSync;
const realRenameSync = realFs.renameSync;
let writeHook: (() => void) | undefined;
let renameHook: ((from: string, to: string) => void) | undefined;
mock.module("node:fs", () => ({
  ...realFs,
  writeSync: ((fd: number, buffer: string | Uint8Array, ...rest: unknown[]) => {
    if (String(buffer).includes("raced-retire") && writeHook) {
      const run = writeHook;
      writeHook = undefined;
      run();
    }
    return (realWriteSync as any)(fd, buffer, ...rest);
  }) as typeof realFs.writeSync,
  renameSync: ((from: string, to: string) => {
    if (renameHook) renameHook(from, to);
    return realRenameSync(from, to);
  }) as typeof realFs.renameSync,
}));
// Fresh module instances see the wrapped node:fs above; the rest of the suite keeps the real one.
const records = (await import(
  new URL("../../src/ledger/records.js?retire-race", import.meta.url).href
)) as typeof import("../../src/ledger/records.js");
const importer = (await import(
  new URL("../../src/ledger/import.js?retire-race", import.meta.url).href
)) as typeof import("../../src/ledger/import.js");

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-retire-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  writeHook = undefined;
  renameHook = undefined;
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

/** A spool file whose whole committed cursor covers it, as an import that could not retire yet. */
function seededSpool(dir: string, requestId: string): string {
  const path = records.spoolFilePath(dir, "session");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `\n${JSON.stringify(record(requestId))}\n`, { mode: 0o600 });
  const stat = statSync(path);
  records.backendFor(dir).putJournalCursor({
    path,
    dev: stat.dev,
    ino: stat.ino,
    generation: 1,
    offset: stat.size,
    boundaryHash: "",
    updatedAt: Date.now(),
  });
  return path;
}

/** A real importer child: waits out the holder, then imports and retires the spool. */
function importerChild(dir: string, holdMs: number): ReturnType<typeof spawnSync> {
  const code = `await new Promise((resolve) => setTimeout(resolve, ${holdMs + 200}));
const { importSpool } = await import(${JSON.stringify(join(ROOT, "src/ledger/import.js"))});
importSpool(${JSON.stringify(dir)});`;
  return spawnSync("bun", ["-e", code], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
}

it("a record appended to an inode the importer retired survives exactly once", async () => {
  const dir = agentDir();
  // Open the backend before contention, as the session process long since did.
  expect(records.readRecords(dir)).toHaveLength(0);
  const path = seededSpool(dir, "pre-covered");
  // A real second process holds the writer, so capture takes the spool path at all.
  const holder = spawn("bun", [DRIVER, "hold-writer", dir, "1000"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = (await import("node:readline")).createInterface({ input: holder.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || (JSON.parse(first.value) as { held?: boolean }).held !== true)
    throw new Error("holder did not report a held writer");
  // The importer runs while capture's descriptor is open but before its write: a real child
  // process claims the spool and retires (renames and unlinks) the inode capture is holding.
  writeHook = () => {
    writeHook = undefined;
    const child = importerChild(dir, 1000);
    if (child.status !== 0) throw new Error(`importer child failed: ${child.stderr}`);
  };
  try {
    records.capture(dir, record("raced-retire"), "summary-native");
  } finally {
    writeHook = undefined;
    if (holder.exitCode === null) holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
  }
  // Capture returned with the record durably spooled: the re-appended line is the only file the
  // next importer sees, and it lands exactly once.
  const imported = importer.importSpool(dir).imported;
  expect(imported).toBe(1);
  expect(importer.importSpool(dir).imported).toBe(0);
  const requestIds = records
    .readRecords(dir)
    .map((row) => row.requestId)
    .sort();
  expect(requestIds).toEqual(["pre-covered", "raced-retire"]);
  expect(importer.spoolFiles(dir)).toHaveLength(0);
  expect(records.readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
}, 30_000);

it("a claim that grew past its cursor is kept for the next import, never unlinked", () => {
  const dir = agentDir();
  const path = seededSpool(dir, "claim-covered");
  const directory = dirname(path);
  // A capture appends through its still-open descriptor after the importer's validation but
  // before its claim rename: the claimed inode grows past the committed cursor.
  const growth = `\n${JSON.stringify(record("claimed-growth"))}\n`;
  renameHook = (from, to) => {
    if (from !== path || !basename(String(to)).startsWith("claim-")) return;
    renameHook = undefined;
    realFs.appendFileSync(from, growth);
  };
  importer.importSpool(dir);
  renameHook = undefined;
  // The claim still sits in the spool directory holding the unimported line.
  const claims = readdirSync(directory).filter((name) => name.startsWith("claim-"));
  expect(claims).toHaveLength(1);
  expect(readFileSync(join(directory, claims[0]), "utf8")).toContain("claimed-growth");
  // The next pass imports it as its own file and the spool drains completely.
  importer.importSpool(dir);
  importer.importSpool(dir);
  const requestIds = records
    .readRecords(dir)
    .map((row) => row.requestId)
    .sort();
  expect(requestIds).toEqual(["claim-covered", "claimed-growth"]);
  expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
});

it("a hardlinked spool is never retired, so the external name keeps its bytes", async () => {
  const dir = agentDir();
  const path = seededSpool(dir, "shared-record");
  const outside = join(dir, "outside.jsonl");
  linkSync(path, outside);
  const before = readFileSync(outside, "utf8");
  importer.importSpool(dir);
  importer.importSpool(dir);
  // The record was imported exactly once, but retirement refuses the unsafe inode: the spool
  // file and the external hardlink both keep their bytes.
  expect(records.readRecords(dir).map((row) => row.requestId)).toEqual(["shared-record"]);
  expect(importer.spoolFiles(dir)).toEqual([path]);
  expect(readFileSync(outside, "utf8")).toBe(before);
  const { openStore } = (await import(
    new URL("../../src/ledger/store.js?retire-race", import.meta.url).href
  )) as typeof import("../../src/ledger/store.js");
  const store = openStore(dir);
  try {
    expect(
      store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM diagnostics").get()
        ?.count ?? 0,
    ).toBeGreaterThanOrEqual(1);
  } finally {
    store.close();
  }
});
