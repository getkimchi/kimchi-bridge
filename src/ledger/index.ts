/**
 * Public entry point of the Kimchi work-ledger library (`@getkimchi/kimchi-bridge/ledger`).
 *
 * The library is consumed as TypeScript source (the bridge ships no JS build): Kimchi pins the
 * commit and imports it under Bun, which resolves `.ts` directly, and under vitest/tsc with
 * `allowImportingTsExtensions`. It must keep loading on every platform Kimchi runs on,
 * Windows included: nothing under `src/ledger` may import `platform.ts`, `bun:ffi` or any
 * Kimchi-only module (enforced by `test/ledger/import-boundary.test.ts`).
 *
 * Everything the moved ledger modules export is public here: Kimchi's capture path, UI reads
 * (`listWorks`, `readWorkHead`, `readWorkRows`, `ledgerSessionInfo`, outbox status) and the
 * reconcile passes that move in later chunks all consume this surface, so the barrel
 * deliberately re-exports rather than curates.
 */
export * from "./schema.js";
export * from "./protocol.js";
export * from "./work-id.js";
export * from "./work-record.js";
export * from "./links.js";
export * from "./row-log.js";
export * from "./merge.js";
export * from "./store.js";
export * from "./tx-budget.js";
export * from "./records.js";
export * from "./import.js";
export * from "./outbox.js";
export * from "./memory-records.js";
