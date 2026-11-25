import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createMemoryRecords } from "../../src/ledger/memory-records.js";
import { backendFor, closeBackends, useBackendFactory } from "../../src/ledger/records.js";
import type { WorkHead } from "../../src/ledger/row-log.js";

/**
 * headBodyBytes parity across backends (contracts-003): the member is the oversize gate for
 * the inline fold (INLINE_FOLD_MAX_HEAD_BYTES, 4 MiB), so every backend must measure the stored
 * serialization's BYTE length. The SQLite statement used length() on TEXT — which counts
 * CHARACTERS — so a head holding multibyte content measured smaller on SQLite than on the
 * in-memory backend's Buffer.byteLength, and the two backends could route the same head to
 * different sides of the gate (the reviewer probe: 625 bytes expected, 400 counted).
 */

const WORK = "11111111-1111-4111-8111-111111111111";
/** One emoji, four UTF-8 bytes but a single TEXT character: the shape the char count missed. */
const EMOJI = "\u{1F389}";
const INLINE_FOLD_MAX_HEAD_BYTES = 4 * 1024 * 1024;

const headWith = (emojiCount: number): WorkHead => ({
  version: 2,
  workId: WORK,
  updatedAt: "2026-10-01T00:00:00.000Z",
  logs: {},
  latest: {},
  pullRequests: [
    {
      url: "https://github.com/example/repo/pull/1",
      checkedAt: "2026-10-01T00:00:00.000Z",
      state: "open",
      title: EMOJI.repeat(emojiCount),
    },
  ],
});

/** The emoji count whose serialized head is nearest `target` bytes. */
const emojiCountFor = (target: number): number =>
  Math.max(0, Math.floor((target - Buffer.byteLength(JSON.stringify(headWith(0)))) / 4));

function agentDir(): string {
  return mkdtempSync(join(tmpdir(), "kimchi-head-bytes-"));
}

describe("headBodyBytes measures bytes on every backend", () => {
  const dirs: string[] = [];
  afterEach(() => {
    useBackendFactory(null);
    closeBackends();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("memory and SQLite agree on a head containing 100 emoji", () => {
    const sqliteDir = agentDir();
    dirs.push(sqliteDir);
    const memory = createMemoryRecords();
    const sqlite = (useBackendFactory(null), backendFor(sqliteDir));
    const head = headWith(100);
    memory.putHead(head);
    sqlite.putHead(head);
    const expected = Buffer.byteLength(JSON.stringify(head));
    expect(expected).toBeGreaterThan(400); // the emoji are real multibyte weight, not padding
    expect(memory.headBodyBytes?.(WORK)).toBe(expected);
    expect(sqlite.headBodyBytes?.(WORK)).toBe(expected);
  });

  it("memory and SQLite agree on heads straddling the inline fold bound", () => {
    const sqliteDir = agentDir();
    dirs.push(sqliteDir);
    const memory = createMemoryRecords();
    const sqlite = (useBackendFactory(null), backendFor(sqliteDir));
    // One head just under the gate, one just over it: the byte count must put them on the
    // same side in both backends, or the same head folds inline on one and defers on the other.
    const under = headWith(emojiCountFor(INLINE_FOLD_MAX_HEAD_BYTES - 2048));
    const over = headWith(emojiCountFor(INLINE_FOLD_MAX_HEAD_BYTES + 2048));
    const expectedUnder = Buffer.byteLength(JSON.stringify(under));
    const expectedOver = Buffer.byteLength(JSON.stringify(over));
    expect(expectedUnder).toBeLessThan(INLINE_FOLD_MAX_HEAD_BYTES);
    expect(expectedOver).toBeGreaterThan(INLINE_FOLD_MAX_HEAD_BYTES);
    memory.putHead(under);
    sqlite.putHead(under);
    expect(memory.headBodyBytes?.(WORK)).toBe(expectedUnder);
    expect(sqlite.headBodyBytes?.(WORK)).toBe(expectedUnder);
    memory.putHead(over);
    sqlite.putHead(over);
    expect(memory.headBodyBytes?.(WORK)).toBe(expectedOver);
    expect(sqlite.headBodyBytes?.(WORK)).toBe(expectedOver);
  });
});
