import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, mock } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * A link swap after the spool append: while another process holds the ledger writer, the append
 * lands in the spool, and an external hardlink preserves the inode while the spool pathname is
 * replaced by a symlink to it. The live-path verification must not follow the symlink: the
 * append is not acknowledged as spooled, capture falls back to the blocking SQLite wait, and
 * the record commits exactly once — never only in the unimportable external name.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

const realFs = await import("node:fs");
const realLstatSync = realFs.lstatSync;
let spoolPath = "";
let outside = "";
let armed = false;
let injected = false;
mock.module("node:fs", () => ({
  ...realFs,
  lstatSync: ((path: string, ...rest: unknown[]) => {
    if (armed && !injected && path === spoolPath) {
      injected = true;
      // After the descriptor's fstat checks, append, fsync and tail check, but before the
      // live-path lstat: preserve the inode at an external name and replace the scanned spool
      // pathname with a symlink to it. A following stat would see the same inode; the lstat
      // must see the link itself and refuse to acknowledge the append.
      realFs.linkSync(spoolPath, outside);
      realFs.unlinkSync(spoolPath);
      realFs.symlinkSync(outside, spoolPath);
    }
    return realLstatSync(path, ...(rest as []));
  }) as typeof realFs.lstatSync,
}));
// Fresh module instances see the wrapped node:fs above; the rest of the suite keeps the real one.
const records = (await import(
  new URL("../../src/ledger/records.js?live-symlink-race", import.meta.url).href
)) as typeof import("../../src/ledger/records.js");
const importer = (await import(
  new URL("../../src/ledger/import.js?live-symlink-race", import.meta.url).href
)) as typeof import("../../src/ledger/import.js");

const dirs: string[] = [];
afterEach(() => {
  records.closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const record = (requestId: string): WorkRecord => ({
  version: 1,
  type: "request",
  workId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session",
  requestId,
  scope: null,
  recordedAt: "2026-10-01T00:00:00.000Z",
});

it("an append whose spool path became a symlink commits through the blocking wait, not the link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-spool-symlink-race-"));
  dirs.push(dir);
  spoolPath = records.spoolFilePath(dir, "session");
  outside = join(dir, "outside.jsonl");
  realFs.mkdirSync(join(spoolPath, ".."), { recursive: true, mode: 0o700 });
  realFs.writeFileSync(spoolPath, `\n${JSON.stringify(record("old"))}\n`, { mode: 0o600 });
  // Open the backend before contention, as a real session does.
  records.readRecords(dir);
  armed = true;
  const child = spawn("bun", [DRIVER, "hold-writer", dir, "1200"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || JSON.parse(first.value).held !== true) throw new Error("writer not held");
  // Capture parks the record in the spool while the writer is held; the injected link swap
  // must make every spool attempt fail, so capture blocks on the writer instead of
  // acknowledging a record only the unscanned external name holds.
  records.capture(dir, record("acknowledged-through-symlink"), "summary-native");
  await new Promise((resolve) => child.once("exit", resolve));
  armed = false;
  const importResult = importer.importSpool(dir);
  const stored = records.readRecords(dir).map((row) => row.requestId);
  expect(injected).toBe(true);
  // The spool pathname is still the attacker's symlink; importers never scan it.
  expect(realFs.lstatSync(spoolPath).isSymbolicLink()).toBe(true);
  // The record is durable exactly once, through the blocking SQLite commit.
  expect(stored.filter((id) => id === "acknowledged-through-symlink")).toHaveLength(1);
  expect(importResult.imported).toBe(0);
  expect(importer.spoolFiles(dir)).toEqual([]);
}, 30_000);
