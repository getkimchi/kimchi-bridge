import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { createMemoryRecords } from "../../src/ledger/memory-records.js";
import {
  backendFor,
  capture,
  closeBackends,
  readRecords,
  useBackendFactory,
} from "../../src/ledger/records.js";

// Adapted from Kimchi's vitest node-test-setup suite: bun:test has no vi.resetModules, so the
// module-reset loop became repeated reads against the same in-process backend. What stays under
// test is the part the bridge owns: a memory backend keeps seeded history readable without ever
// opening the SQLite file. Kimchi's vitest still runs the original module-reset variant.

const agentDir = join(tmpdir(), "kimchi-bridge-ledger-setup");
const WORK = "11111111-1111-4111-8111-111111111111";

it.each([1, 2])("keeps seeded history across %i re-reads without opening SQLite", (reads) => {
  useBackendFactory(() => createMemoryRecords());
  try {
    const backend = backendFor(agentDir);
    expect(backend.recordCount()).toBe(0);
    capture(
      agentDir,
      { version: 1, type: "work", workId: WORK, sessionId: "node-test" },
      "node-test",
    );
    for (let count = 0; count < reads; count++) {
      const reloaded = readRecords(agentDir);
      expect(reloaded).toHaveLength(1);
    }
    expect(existsSync(join(agentDir, "pr-cost-reporting", "ledger.db"))).toBe(false);
  } finally {
    closeBackends();
    rmSync(join(agentDir, "pr-cost-reporting"), { recursive: true, force: true });
  }
});
