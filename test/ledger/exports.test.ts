import { expect, it } from "bun:test";
import * as ledger from "../../src/ledger/index.js";

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
