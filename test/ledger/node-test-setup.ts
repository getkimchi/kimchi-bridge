import { afterEach, beforeEach } from "bun:test";
import { createMemoryRecords } from "../../src/ledger/memory-records.js";
import { closeBackends, useBackendFactory } from "../../src/ledger/records.js";

/**
 * Bun port of Kimchi's tests/setup/work-ledger.ts, the node test setup the ledger move carried
 * over: every test starts from an empty in-memory backend, and no test can leave a backend open.
 * Kimchi wrapped the module in vi.mock so suites with partial SDK mocks never load the ledger's
 * dependency graph; the bridge has no such suites, so the setup installs the memory factory
 * directly. Importing this module registers the hooks for the importing test file, the role
 * Kimchi's vitest setupFiles list plays there.
 *
 * Bun runs the whole suite in one process with a single module registry, so there is no
 * vi.resetModules() to survive: the closest equivalent of "the backend stays across module
 * resets" is that the installed factory and the cached backends stay reachable from every later
 * import of the same specifier for the whole run (see node-test-setup.test.ts). Real Bun
 * subprocesses are unaffected, exactly as in Kimchi.
 */
beforeEach(() => {
  closeBackends();
  useBackendFactory(() => createMemoryRecords());
});
// Kimchi's vitest setup only closes; each test file there runs in its own module environment.
// Bun shares one process across every file, so the setup must also restore the default SQLite
// factory afterwards, or the in-memory backend would leak into suites that expect SQLite.
afterEach(() => {
  closeBackends();
  useBackendFactory(null);
});
