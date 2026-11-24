import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
// Imported through the package specifier, not the source path: this is the exact resolution
// Kimchi and later reconcile chunks depend on (package.json `exports`). If the exports mapping
// were removed or pointed at the wrong file, this import would fail before any assertion runs,
// and `pnpm typecheck` would fail to resolve the specifier in this typechecked file either way.
import * as ledger from "@getkimchi/kimchi-bridge/ledger";
import * as sourceBarrel from "../../src/ledger/index.js";

/**
 * The barrel is the public surface Kimchi consumes as `@getkimchi/kimchi-bridge/ledger`
 * (package.json exports). This pins that the names Kimchi's capture path, UI reads and the
 * later reconcile chunks need are reachable through it, and that the barrel loads without
 * side effects (no database, no platform probing).
 */
it("exports the public ledger API through the package barrel", () => {
  for (const name of [
    // capture + UI reads
    "capture",
    "backendFor",
    "closeBackends",
    "useBackendFactory",
    "listWorks",
    "readWorkHead",
    "readWorkRows",
    "readWorkSummary",
    "ledgerSessionInfo",
    "readRecords",
    "readTransitionRepositories",
    "recoverDirty",
    "rebuildWork",
    "getNote",
    "setNote",
    // legacy journal import (later: the capture spool)
    "importJournals",
    "importJournalSlice",
    "importSessionJournal",
    "workJournals",
    // outbox delivery
    "readOutboxStatus",
    "outboxDeliveryStatus",
    "effectiveClaim",
    "effectiveClaims",
    "effectiveClaimsAsync",
    "pendingBatch",
    "acknowledgeBatch",
    // storage
    "openStore",
    "ledgerDbPath",
    "LedgerUnavailableError",
    "LedgerSchemaError",
    "LedgerFencedError",
    "acquireWriterEpoch",
    "readWriterEpoch",
    "fenceLedgerWrites",
    "classifyUserVersion",
    "retryOnBusy",
    "createMemoryRecords",
    // protocol + event identity
    "encodeEvent",
    "encodeBatch",
    "eventHash",
    "stableID",
    "validateIngestEvent",
    "validateIngestBatch",
    // journal model
    "isWorkId",
    "journalParser",
  ]) {
    expect(ledger, `barrel export ${name}`).toHaveProperty(name);
  }
});

it("resolves the package specifier to the source barrel it exports", () => {
  expect(ledger.capture).toBe(sourceBarrel.capture);
  expect(ledger.createMemoryRecords).toBe(sourceBarrel.createMemoryRecords);
});

it("typechecks a consumer importing through the package specifier", () => {
  const dbPath: string = ledger.ledgerDbPath(
    join(tmpdir(), "kimchi-bridge-ledger-export-consumer"),
  );
  expect(dbPath.endsWith("ledger.db")).toBe(true);
});
