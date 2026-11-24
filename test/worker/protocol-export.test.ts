import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../../src/worker/protocol.js";

/**
 * The ./worker-protocol export's runtime isolation (reconcile-out-of-process
 * plan, chunk B3). Kimchi imports the wire contract from the bridge package;
 * that import must never pull the reconciliation runtime — the ledger, the
 * passes, sqlite — into Kimchi's process. The gate bundles the export the way
 * a consumer's bundler would and inspects what came along: only the protocol's
 * own code may be in the artifact.
 */

const ROOT = join(import.meta.dir, "../..");
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Identifiers that exist only in the reconcile runtime the export must not load. */
const RUNTIME_MARKERS: string[] = [
  "runReconciliationPass",
  "reconcileRepositoryTransitions",
  "reconcileWorkCosts",
  "reconcileReporting",
  "bun:sqlite",
  "proper-lockfile",
  "hostPorts",
  "withHostPorts",
];

test("bundling the worker-protocol export pulls no reconcile runtime code", async () => {
  const stage = mkdtempSync(join(tmpdir(), "kimchi-worker-protocol-"));
  dirs.push(stage);
  const outfile = join(stage, "worker-protocol.mjs");
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/worker/protocol.ts")],
    target: "bun",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Protocol bundle build failed");
  await Bun.write(outfile, result.outputs[0]!);
  const bundled = readFileSync(outfile, "utf8");
  for (const marker of RUNTIME_MARKERS)
    expect(bundled.includes(marker), `the protocol bundle reaches ${marker}`).toBe(false);
  // The bundle is the export itself: it loads and speaks the protocol version.
  const loaded = await import(outfile);
  expect(loaded.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  const parsed = loaded.parseParentLine(
    loaded.encodeParentMessage({
      type: "hello",
      v: PROTOCOL_VERSION,
      build: "gate",
      agentDir: "/a",
    }),
  );
  expect(parsed.ok).toBe(true);
});
