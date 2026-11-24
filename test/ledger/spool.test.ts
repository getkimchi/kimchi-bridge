import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "bun:test";
import { importSpool, spoolFiles } from "../../src/ledger/import.js";
import {
  backendFor,
  capture,
  closeBackends,
  readRecords,
  readWorkSummary,
  spoolDirectory,
  spoolFilePath,
} from "../../src/ledger/records.js";
import { openStore } from "../../src/ledger/store.js";
import type { WorkRecord } from "../../src/ledger/work-record.js";

/**
 * The capture spool against the real SQLite backend and real other processes: with a writer held
 * across the process boundary, capture returns inside its short busy window with the exact record
 * line fsynced in the session's spool; the spool import lands it exactly once (against a
 * re-capture too) and deletes the file only after its cursor reached EOF with the rows
 * committed. A spool that cannot be written falls back to today's blocking wait — a record is
 * never dropped. One case adds WAL-checkpoint load, the risk the plan calls out.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(ROOT, "test/ledger/ledger-driver.ts");

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-spool-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const WORK = "00000000-0000-4000-8000-000000000001";

function record(requestId: string, sessionId = "session"): WorkRecord {
  return {
    version: 1,
    type: "request",
    workId: WORK,
    sessionId,
    requestId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

/** A ledger-driver child holding the writer lock: resolves once the IMMEDIATE transaction is
 * open; `done` settles when the holder exits and releases the lock. */
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

it("capture under a 6 s writer in another process returns within its bounded window and spools the exact line", async () => {
  const dir = agentDir();
  const rec = record("req-1");
  // Open the backend before contention, as the session process long since did.
  expect(readRecords(dir)).toHaveLength(0);
  const holder = await holdWriter(dir, 6000);
  try {
    const start = Date.now();
    capture(dir, rec, "summary-native");
    const elapsed = Date.now() - start;
    // The bounded path is the 250 ms busy window plus the spool append's fsyncs; a loaded
    // runner stretches that same path with scheduling delays, while the blocking fallback
    // would wait out the whole 6 s hold, so this bound still separates the two.
    expect(elapsed).toBeLessThan(1000);
    // The exact record line is fsynced in the session's spool as one append carrying its own
    // leading newline, so a torn earlier append can never glue onto it; nothing reached the ledger.
    const spool = spoolFilePath(dir, "session");
    expect(existsSync(spool)).toBe(true);
    expect(readFileSync(spool, "utf8")).toBe(`\n${JSON.stringify(rec)}\n`);
    expect(readRecords(dir)).toHaveLength(0);
    // The spool directory and file are private to this user.
    expect(statSync(spool).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(spool)).mode & 0o777).toBe(0o700);
  } finally {
    await holder.done;
  }

  // The next pass imports it exactly once; a second import and a re-capture of the same line
  // change nothing.
  expect(importSpool(dir).imported).toBe(1);
  expect(importSpool(dir).imported).toBe(0);
  expect(readRecords(dir)).toHaveLength(1);
  capture(dir, rec, "summary-native");
  expect(readRecords(dir)).toHaveLength(1);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
  // The spool file is gone: its cursor reached EOF after the rows committed.
  expect(existsSync(spoolFilePath(dir, "session"))).toBe(false);
}, 20_000);

it("a cold capture under a 6 s writer returns within its bounded window and spools the record", async () => {
  const dir = agentDir();
  const rec = record("req-cold");
  // No readRecords warm-up: the first backend this agent directory ever sees in the capturing
  // process is the capture's own — exactly a fresh session process under a held writer.
  const holder = await holdWriter(dir, 6000);
  let cold: { outcome: string; elapsedMs: number } | undefined;
  try {
    const child = spawn(
      "bun",
      [
        "-e",
        `const { capture } = await import(${JSON.stringify(`${ROOT}src/ledger/records.js`)});
const start = Date.now();
let outcome = "committed";
try { capture(${JSON.stringify(dir)}, ${JSON.stringify(rec)}, "cold-test"); }
catch (error) { outcome = "threw " + error.name + ": " + error.message; }
console.log(JSON.stringify({ outcome, elapsedMs: Date.now() - start }));`,
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
    );
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout!.on("data", (chunk) => {
        buffer += String(chunk);
        const index = buffer.indexOf("\n");
        if (index !== -1) resolve(buffer.slice(0, index));
      });
      child.once("exit", () => reject(new Error(`the cold capture child exited: ${buffer}`)));
    });
    cold = JSON.parse(line) as { outcome: string; elapsedMs: number };
  } finally {
    await holder.done;
  }
  // The cold open itself rode the bounded capture window: the record parked in the spool
  // within the busy window and its append instead of stalling the open on the 5 s
  // reconciliation timeout and throwing the record away. The bound tolerates a loaded
  // runner's scheduling delays; the blocking fallback would wait out the whole 6 s hold.
  expect(cold?.outcome).toBe("committed");
  expect(cold?.elapsedMs ?? Infinity).toBeLessThan(1000);
  const spool = spoolFilePath(dir, "session");
  expect(existsSync(spool)).toBe(true);
  expect(readFileSync(spool, "utf8")).toBe(`\n${JSON.stringify(rec)}\n`);
  // The next pass lands it exactly once, against a re-capture too.
  expect(importSpool(dir).imported).toBe(1);
  expect(readRecords(dir)).toHaveLength(1);
  capture(dir, rec, "cold-test");
  expect(readRecords(dir)).toHaveLength(1);
}, 20_000);

it("each spooled record is one self-delimiting append, so a killed writer's torn line never glues onto it", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  const spool = spoolFilePath(dir, "session");
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  // A killed writer left a partial line behind (no trailing newline).
  writeFileSync(spool, '{"version":1,"type":"request","workId":"00000000');
  const first = record("req-torn-1");
  const second = record("req-torn-2");
  let holder = await holdWriter(dir, 2500);
  try {
    capture(dir, first, "summary-native");
  } finally {
    await holder.done;
  }
  holder = await holdWriter(dir, 2500);
  try {
    capture(dir, second, "summary-native");
  } finally {
    await holder.done;
  }
  // The torn fragment ends on its own line; every record carries its leading newline.
  const lines = readFileSync(spool, "utf8").split("\n");
  expect(lines[0]).toBe('{"version":1,"type":"request","workId":"00000000');
  expect(lines[1]).toBe(JSON.stringify(first));
  expect(lines[3]).toBe(JSON.stringify(second));
  // The importer skips empty lines, consumes only complete lines, and lands both records.
  const result = importSpool(dir);
  expect(result.imported).toBe(2);
  expect(readRecords(dir)).toHaveLength(2);
}, 20_000);

it("session ids encode into safe spool filenames, Windows reserved names included", async () => {
  for (const id of ["CON", "NUL", "COM1", "LPT9", "AUX", "con", "prn", "a/b", "..", "x.", "tail "])
    expect(basename(spoolFilePath("/agents", id))).toBe(`s-${encodeURIComponent(id)}.jsonl`);
  // The reserved basenames never appear with their extension, and separators never split the path.
  for (const id of ["CON", "NUL", "COM1"])
    expect(basename(spoolFilePath("/agents", id))).not.toBe(`${id}.jsonl`);
  // A contended capture with a reserved-name session still spools: prefix and suffix always
  // surround the encoded id, so the name is legal on every platform.
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  const holder = await holdWriter(dir, 2500);
  try {
    capture(dir, record("req-con", "CON"), "summary-native");
  } finally {
    await holder.done;
  }
  const spool = spoolFilePath(dir, "CON");
  expect(existsSync(spool)).toBe(true);
  expect(importSpool(dir).imported).toBe(1);
  expect(readRecords(dir)).toHaveLength(1);
}, 20_000);

it("a contended capture with a lone-surrogate session id still lands the record exactly once", async () => {
  // Any string sessionId — including the unpaired UTF-16 surrogates encodeURIComponent rejects —
  // must have a spoolable filename: the record parks in the spool under contention and is
  // imported exactly once, never thrown back to the caller (capture never drops).
  const ids = ["\uD83D", "surrogate-\uDC44-tail", "emoji-🦀-session", "plain-ascii"];
  for (const sessionId of ids) {
    const dir = agentDir();
    const rec = record(`req-${ids.indexOf(sessionId)}`, sessionId);
    expect(readRecords(dir)).toHaveLength(0);
    const holder = await holdWriter(dir, 2500);
    try {
      const start = Date.now();
      capture(dir, rec, "summary-native");
      // The same bounded-window bound as above: well under the 2.5 s hold even on a loaded
      // runner, and never the blocking wait the holder would outlast.
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      await holder.done;
    }
    const spool = spoolFilePath(dir, sessionId);
    expect(existsSync(spool)).toBe(true);
    expect(readFileSync(spool, "utf8")).toBe(`\n${JSON.stringify(rec)}\n`);
    expect(importSpool(dir).imported).toBe(1);
    expect(importSpool(dir).imported).toBe(0);
    const rows = readRecords(dir);
    expect(rows).toHaveLength(1);
    // The record's body round-trips: the JSON line escapes the lone surrogate losslessly.
    expect(rows[0]).toEqual(rec);
    expect(existsSync(spool)).toBe(false);
    closeBackends();
  }
  // Uncontended, the same malformed id commits straight through the SQLite capture path.
  const direct = agentDir();
  capture(direct, record("req-direct", "\uD83D"), "summary-native");
  expect(readRecords(direct)).toHaveLength(1);
}, 30_000);

it("a spool path that is a symlink is refused, so capture blocks instead of writing elsewhere", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  const spool = spoolFilePath(dir, "session");
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  const outside = join(dir, "outside.jsonl");
  writeFileSync(outside, "keep\n");
  symlinkSync(outside, spool);
  const holder = await holdWriter(dir, 1500);
  try {
    const start = Date.now();
    capture(dir, record("req-link"), "summary-native");
    // Unsafe spool: capture blocks on the writer and commits the record itself.
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
  } finally {
    await holder.done;
  }
  expect(readRecords(dir)).toHaveLength(1);
  expect(readFileSync(outside, "utf8")).toBe("keep\n");
}, 20_000);

it("a spool path with another hardlink is refused, so capture blocks instead of sharing an inode", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  const spool = spoolFilePath(dir, "session");
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  const outside = join(dir, "outside.jsonl");
  writeFileSync(outside, "keep\n");
  linkSync(outside, spool);
  const holder = await holdWriter(dir, 1500);
  try {
    const start = Date.now();
    capture(dir, record("req-hard"), "summary-native");
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
  } finally {
    await holder.done;
  }
  expect(readRecords(dir)).toHaveLength(1);
  expect(readFileSync(outside, "utf8")).toBe("keep\n");
}, 20_000);

it("a spool that cannot be written falls back to the blocking wait and still lands the record", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  // The spool path is unusable (a directory where the file would go), so the spool write fails.
  const spool = spoolFilePath(dir, "session");
  mkdirSync(spool, { recursive: true });
  const holder = await holdWriter(dir, 1200);
  try {
    const start = Date.now();
    capture(dir, record("req-2"), "summary-native");
    const elapsed = Date.now() - start;
    // Blocked as today — past the holder's remaining window, inside the original busy timeout.
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(5000);
  } finally {
    await holder.done;
  }
  expect(readRecords(dir)).toHaveLength(1);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
}, 20_000);

it("an unwritable spool under a writer longer than the busy timeout still lands the record", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  // The spool path is unusable (a directory where the file would go), so the spool write fails.
  const spool = spoolFilePath(dir, "session");
  mkdirSync(spool, { recursive: true });
  const holder = await holdWriter(dir, 6000);
  let notes = 0;
  const stderr = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    if (String(chunk).includes("capture is blocking")) notes++;
    return true;
  }) as typeof process.stderr.write;
  try {
    const start = Date.now();
    // The spool cannot take the record, so capture blocks on the writer until it commits: the
    // 5 s busy timeout must not turn into a lost record when the holder outlasts it.
    capture(dir, record("req-long"), "summary-native");
    expect(Date.now() - start).toBeGreaterThanOrEqual(4000);
    expect(notes).toBeGreaterThanOrEqual(1);
  } finally {
    process.stderr.write = stderr;
    await holder.done;
  }
  expect(readRecords(dir)).toHaveLength(1);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
}, 20_000);

it("a throwing diagnostic cannot abort the blocking capture", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  // The spool path is unusable (a directory where the file would go), so the spool write fails.
  const spool = spoolFilePath(dir, "session");
  mkdirSync(spool, { recursive: true });
  const holder = await holdWriter(dir, 6000);
  // The diagnostic stream itself fails (an EPIPE from a closed stderr): the note is best-effort,
  // so the blocking retry continues and the record still commits once the holder releases.
  const stderr = process.stderr.write;
  let notes = 0;
  process.stderr.write = (() => {
    notes++;
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  }) as typeof process.stderr.write;
  try {
    const start = Date.now();
    capture(dir, record("req-diagnostic-epipe"), "summary-native");
    expect(Date.now() - start).toBeGreaterThanOrEqual(4000);
    expect(notes).toBeGreaterThanOrEqual(1);
  } finally {
    process.stderr.write = stderr;
    await holder.done;
  }
  expect(readRecords(dir)).toHaveLength(1);
  expect(readWorkSummary(dir, WORK)?.sessions).toEqual(["session"]);
}, 20_000);

it("an unparsable spool line is quarantined, never deleted", () => {
  const dir = agentDir();
  const spool = spoolFilePath(dir, "session");
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  // A corrupt complete line: parsed, reported, and covered by the cursor.
  const content = `\n${JSON.stringify(record("req-a"))}\nnot-a-record\n`;
  writeFileSync(spool, content, { mode: 0o600 });
  const result = importSpool(dir);
  // The intact record imported; the damaged one did not.
  expect(result.imported).toBe(1);
  expect(result.problems.map((problem) => problem.kind)).toEqual(["invalid"]);
  expect(readRecords(dir)).toHaveLength(1);
  // The file's bytes are preserved under quarantine, not deleted, and the diagnostic is counted.
  const quarantine = join(spoolDirectory(dir), "quarantine");
  const kept = readdirSync(quarantine);
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(quarantine, kept[0]), "utf8")).toBe(content);
  expect(existsSync(spool)).toBe(false);
  const probe = openStore(dir);
  try {
    expect(
      probe.db
        .query("SELECT COUNT(*) AS n FROM diagnostics WHERE code = 'spool-quarantined'")
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    probe.close();
  }
});

it("an unknown-type spool line is quarantined, never deleted", () => {
  const dir = agentDir();
  const spool = spoolFilePath(dir, "session");
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  const future = JSON.stringify({
    version: 1,
    type: "a_type_this_reader_does_not_know",
    workId: WORK,
    sessionId: "session",
  });
  const content = `\n${future}\n`;
  writeFileSync(spool, content, { mode: 0o600 });
  const result = importSpool(dir);
  expect(result.imported).toBe(0);
  expect(result.problems.map((problem) => problem.kind)).toEqual(["unknown-type"]);
  expect(readRecords(dir)).toHaveLength(0);
  const quarantine = join(spoolDirectory(dir), "quarantine");
  const kept = readdirSync(quarantine);
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(quarantine, kept[0]), "utf8")).toBe(content);
  expect(existsSync(spool)).toBe(false);
});

it("a spool file with an incomplete trailing line stays for a later pass", () => {
  const dir = agentDir();
  const spool = spoolFilePath(dir, "session");
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  // The second record's line has no trailing newline: it is not consumed yet.
  const complete = JSON.stringify(record("req-tail-a"));
  const partial = JSON.stringify(record("req-tail-b")).slice(0, 20);
  const content = `\n${complete}\n${partial}`;
  writeFileSync(spool, content, { mode: 0o600 });
  const result = importSpool(dir);
  expect(result.imported).toBe(1);
  expect(readRecords(dir)).toHaveLength(1);
  // The file is neither deleted nor quarantined: the partial line is not consumed.
  expect(readFileSync(spool, "utf8")).toBe(content);
  expect(existsSync(join(spoolDirectory(dir), "quarantine"))).toBe(false);
  // Once a later append completes the line, the record lands and the file retires.
  appendFileSync(spool, `${JSON.stringify(record("req-tail-b")).slice(20)}\n`);
  expect(importSpool(dir).imported).toBe(1);
  expect(readRecords(dir)).toHaveLength(2);
  expect(existsSync(spool)).toBe(false);
});

it("two concurrent importers with concurrent captures lose no record", async () => {
  const dir = agentDir();
  const spool = spoolFilePath(dir, "session");
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  const seeded = 10;
  writeFileSync(
    spool,
    Array.from(
      { length: seeded },
      (_, index) => `\n${JSON.stringify(record(`req-race-${index}`))}\n`,
    ).join(""),
    { mode: 0o600 },
  );
  const importer = () => {
    const child = spawn(
      "bun",
      [
        "-e",
        `const { importSpool } = await import(${JSON.stringify(`${ROOT}src/ledger/import.js`)});
for (let round = 0; round < 12; round++) { importSpool(${JSON.stringify(dir)}); await new Promise(r => setTimeout(r, 25)); }
console.log(JSON.stringify({ done: true }));`,
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
    );
    return new Promise<void>((resolve, reject) =>
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`importer exited ${code}`)),
      ),
    );
  };
  const captures = 20;
  const both = Promise.all([importer(), importer()]);
  for (let index = 0; index < captures; index++) {
    capture(dir, record(`req-live-${index}`), "summary-native");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  await both;
  // Drain: every spool file (a claim left behind, a replacement) imports and retires.
  for (let round = 0; round < 10 && spoolFiles(dir).length; round++) importSpool(dir);
  const ids = readRecords(dir).map((row) => row.requestId);
  expect(ids).toHaveLength(seeded + captures);
  expect(new Set(ids).size).toBe(seeded + captures);
  expect(spoolFiles(dir)).toHaveLength(0);
}, 30_000);

/** A child that keeps the writer busy with short transactions and WAL checkpoints, the load the
 * plan's risk section calls out: checkpoints in the worker must not stall or drop capture. */
async function checkpointLoad(dir: string, ms: number): Promise<{ done: Promise<number | null> }> {
  const child = spawn(
    "bun",
    [
      "-e",
      `const { openStore } = await import(${JSON.stringify(`${ROOT}src/ledger/store.js`)});
const store = openStore(${JSON.stringify(dir)});
const deadline = Date.now() + ${ms};
let n = 0;
while (Date.now() < deadline) {
  store.tx(() => store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('load', ?)", [String(++n)]));
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
store.close();
console.log(JSON.stringify({ rounds: n }));`,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || !(JSON.parse(first.value) as { rounds?: number }).rounds)
    throw new Error("checkpoint load child did not report");
  return { done: new Promise<number | null>((resolve) => child.once("exit", resolve)) };
}

it("capture stays quick and lossless under WAL checkpoint load from another process", async () => {
  const dir = agentDir();
  expect(readRecords(dir)).toHaveLength(0);
  const holder = await checkpointLoad(dir, 2000);
  const total = 20;
  try {
    for (let index = 0; index < total; index++) {
      const start = Date.now();
      capture(dir, record(`req-load-${index}`), "summary-native");
      // The bounded-window bound, stretched by the checkpoint load's own fsyncs and a loaded
      // runner's scheduling; the blocking fallback would wait the load child out.
      expect(Date.now() - start).toBeLessThan(1000);
    }
  } finally {
    await holder.done;
  }
  // Every record is either committed or spooled; none is dropped.
  const direct = readRecords(dir).length;
  const spooled = existsSync(spoolFilePath(dir, "session"))
    ? readFileSync(spoolFilePath(dir, "session"), "utf8")
        .split("\n")
        .filter((line) => line.trim()).length
    : 0;
  expect(direct + spooled).toBe(total);
  importSpool(dir);
  expect(readRecords(dir)).toHaveLength(total);
  expect(existsSync(spoolFilePath(dir, "session"))).toBe(false);
}, 20_000);
