import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { backendFor, capture, closeBackends, readRecords } from "../../src/ledger/records.js";
// Importing the setup installs its hooks for this file, the role Kimchi's vitest setupFiles
// list plays for tests/setup/work-ledger.ts.
import "./node-test-setup.js";

const agentDir = join(tmpdir(), "kimchi-bridge-node-ledger-setup");
const WORK = "11111111-1111-4111-8111-111111111111";
const sqliteDir = mkdtempSync(join(tmpdir(), "kimchi-bridge-node-ledger-fresh-"));

it.each([1, 2])(
  "keeps seeded Node history across %i module re-imports without opening SQLite",
  async (reimports) => {
    rmSync(join(agentDir, "pr-cost-reporting"), { recursive: true, force: true });
    const backend = backendFor(agentDir);
    expect(backend.recordCount()).toBe(0);
    capture(
      agentDir,
      { version: 1, type: "work", workId: WORK, sessionId: "node-test" },
      "node-test",
    );
    // Bun keeps one module registry for the whole run: re-importing the same specifier returns
    // the identical module, so the backend the setup installed stays reachable from every
    // re-import. This is the closest equivalent of Kimchi's vi.resetModules() loop, which Bun
    // has no counterpart for.
    for (let count = 0; count < reimports; count++) {
      const reloaded = await import("../../src/ledger/records.js");
      expect(reloaded.backendFor(agentDir)).toBe(backend);
      expect(reloaded.readRecords(agentDir)).toEqual(readRecords(agentDir));
      expect(reloaded.readRecords(agentDir)).toHaveLength(1);
    }
    expect(existsSync(join(agentDir, "pr-cost-reporting", "ledger.db"))).toBe(false);
  },
);

it("resets the in-memory backend between tests", () => {
  // The history seeded by the test above must not leak into this one.
  expect(backendFor(agentDir).recordCount()).toBe(0);
  expect(readRecords(agentDir)).toEqual([]);
  expect(existsSync(join(agentDir, "pr-cost-reporting", "ledger.db"))).toBe(false);
});

it("keeps SQLite for module instances the setup never installed", async () => {
  // Bun cannot reset modules, so a genuinely fresh instance is simulated with a cache-busting
  // dynamic import. It is a separate module with its own factory slot, which the setup above
  // never touched: the memory backend cannot follow it there, and it opens the real SQLite
  // backend instead. That is why this setup installs the memory factory once per process
  // rather than surviving module resets like Kimchi's vitest wrapper.
  const fresh = await import(`../../src/ledger/records.ts?fresh=${Date.now()}`);
  const backend = fresh.backendFor(sqliteDir);
  fresh.capture(
    sqliteDir,
    { version: 1, type: "work", workId: WORK, sessionId: "fresh-instance" },
    "node-test",
  );
  expect(backend.recordCount()).toBe(1);
  expect(existsSync(join(sqliteDir, "pr-cost-reporting", "ledger.db"))).toBe(true);
  fresh.closeBackends();
  rmSync(sqliteDir, { recursive: true, force: true });
});

// Close any backend the reset assertions may have cached before the process ends.
it("leaves no backend open", () => {
  closeBackends();
});
