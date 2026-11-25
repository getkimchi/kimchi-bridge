import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, mock } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * The agentDir pin (security-006, agentDir variant): whoever controls a symlink in the
 * agentDir path can repoint it after capture's spool live-check but before capture returns;
 * capture then acknowledges a record the importer, now resolving through the moved link,
 * never scans. pinAgentDir resolves the real path once per input and memoizes it for the
 * process lifetime, so every path built from the agentDir — the spool, the ledger database,
 * the reporting directory, the import scan — stays in the tree the link pointed at when it
 * was first used. A repointed link takes effect at the next process start.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

const realFs = await import("node:fs");
const realLstatSync = realFs.lstatSync;
const realRealpathSync = realFs.realpathSync;

let armed = false;
let injected = false;
let spoolPath = "";
let linkPath = "";
let repointedTo = "";
let realpathCalls = 0;
mock.module("node:fs", () => ({
  ...realFs,
  lstatSync: ((path: string, ...rest: unknown[]) => {
    const stat = realLstatSync(path, ...(rest as []));
    if (armed && !injected && path === spoolPath) {
      injected = true;
      // After the spool's live-check lstat resolved the ORIGINAL tree, but before capture
      // returns: repoint the agentDir link at a second tree. The append is acknowledged into
      // the original tree either way; the question is whether the importer ever scans it.
      unlinkSync(linkPath);
      symlinkSync(repointedTo, linkPath);
    }
    return stat;
  }) as typeof realFs.lstatSync,
  realpathSync: ((path: string, ...rest: unknown[]) => {
    if (path === linkPath) realpathCalls++;
    return realRealpathSync(path, ...(rest as []));
  }) as typeof realFs.realpathSync,
}));
// Fresh module instances see the wrapped node:fs above; the rest of the suite keeps the real one.
const records = (await import(
  new URL("../../src/ledger/records.js?agentdir-pin", import.meta.url).href
)) as typeof import("../../src/ledger/records.js");
const importer = (await import(
  new URL("../../src/ledger/import.js?agentdir-pin", import.meta.url).href
)) as typeof import("../../src/ledger/import.js");
const store = (await import(
  new URL("../../src/ledger/store.js?agentdir-pin", import.meta.url).href
)) as typeof import("../../src/ledger/store.js");

const dirs: string[] = [];
afterEach(() => {
  armed = false;
  injected = false;
  records.closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const record = (requestId: string): WorkRecord => ({
  version: 1,
  type: "request",
  workId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session",
  requestId,
  scope: null,
  recordedAt: "2026-10-01T00:00:00.000Z",
});

it("a record acknowledged before an agentDir link repoint is imported from the original tree", async () => {
  const root = tempDir("kimchi-agentdir-pin-");
  const original = join(root, "original-agent");
  const replacement = join(root, "replacement-agent");
  const link = join(root, "agent-link");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  mkdirSync(replacement, { recursive: true, mode: 0o700 });
  symlinkSync(original, link);
  linkPath = link;
  repointedTo = replacement;
  spoolPath = records.spoolFilePath(link, "session");

  // Open the backend before contention, as a real session does.
  records.readRecords(link);
  // Another process holds the ledger writer, so capture parks the record in the spool.
  const child = spawn("bun", [DRIVER, "hold-writer", original, "1200"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || JSON.parse(first.value).held !== true) throw new Error("writer not held");
  armed = true;
  // The spool append is acknowledged inside the window: its lstat live-check passed against
  // the original tree, then the link moved before capture returned.
  records.capture(link, record("acknowledged-before-repoint"), "summary-native");
  armed = false;
  await new Promise((resolve) => child.once("exit", resolve));

  // The acknowledged record is durable in the ORIGINAL tree.
  const originalSpool = records.spoolFilePath(original, "session");
  expect(realFs.existsSync(originalSpool)).toBe(true);
  // The importer resolves through the (now moved) link like any later reader would.
  const result = importer.importSpool(link);
  expect(result.imported).toBe(1);
  expect(records.fingerprint(link)).toBe("1");
  // The repointed tree never saw the record.
  expect(records.fingerprint(replacement)).toBe("0");
});

it("pinAgentDir memoizes the real path per input", () => {
  const root = tempDir("kimchi-agentdir-memo-");
  const real = join(root, "real-agent");
  const link = join(root, "agent-link");
  mkdirSync(real, { recursive: true, mode: 0o700 });
  symlinkSync(real, link);
  linkPath = link;
  realpathCalls = 0;
  const first = store.pinAgentDir(link);
  const second = store.pinAgentDir(link);
  expect(second).toBe(first);
  expect(realpathCalls).toBe(1);
  expect(first).toBe(realpathSync(real));
});

it("a non-symlink agentDir keeps its behavior", () => {
  const dir = tempDir("kimchi-agentdir-plain-");
  const pinned = store.pinAgentDir(dir);
  // The real path of a plain directory is the directory itself, whatever the platform's
  // own spelling of its ancestors is; every derived path stays inside it.
  expect(pinned).toBe(realpathSync(dir));
  expect(records.spoolDirectory(dir).startsWith(pinned)).toBe(true);
  expect(store.ledgerDbPath(dir).startsWith(pinned)).toBe(true);
  // Capture still commits through the ordinary path: one record, one fingerprint.
  records.capture(dir, record("plain-directory"), "summary-native");
  expect(records.fingerprint(dir)).toBe("1");
});
