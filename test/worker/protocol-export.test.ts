import { mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../../src/worker/protocol.js";

/**
 * The ./worker-protocol export's runtime isolation (reconcile-out-of-process
 * plan, chunk B3). Kimchi imports the wire contract from the bridge package;
 * that import must never pull the reconciliation runtime — the ledger, the
 * passes, sqlite — into Kimchi's process. The gate bundles the export the way
 * a consumer's bundler would — through the public specifier, resolved by the
 * package's own name — and inspects the bundler's input list (the bundle's
 * sourcemap sources): only the protocol module itself may be an input. A
 * negative fixture proves the gate rejects an entry that reaches into the
 * reconcile runtime.
 */

const ROOT = join(import.meta.dir, "../..");

// Staged inside the package: the public specifier resolves through the
// package's own name (self-reference), exactly as a consumer's import does.
const stages: string[] = [];

afterEach(() => {
  while (stages.length) rmSync(stages.pop() as string, { recursive: true, force: true });
});

function stage(): string {
  const dir = mkdtempSync(join(ROOT, "node_modules", ".protocol-export-"));
  stages.push(dir);
  return dir;
}

/** The runtime the export must never load, by input path. */
const FORBIDDEN_INPUTS: { prefix: string; what: string }[] = [
  { prefix: join(ROOT, "src/reconcile"), what: "the reconcile runtime" },
  { prefix: join(ROOT, "src/ledger"), what: "the ledger runtime" },
  { prefix: join(ROOT, "src/worker/main.ts"), what: "the worker entry" },
  { prefix: join(ROOT, "src/worker/host-client.ts"), what: "the worker host client" },
];

/** Bundles one entry and returns the bundler's input list: the modules that
 *  actually became part of the artifact. */
async function bundleInputs(entry: string): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    minify: true,
    sourcemap: "external",
  });
  if (!result.success) throw new AggregateError(result.logs, "the worker-protocol bundle failed");
  const map = result.outputs.find((output) => output.kind === "sourcemap");
  if (!map) throw new Error("the bundler produced no input list");
  const parsed = JSON.parse(await map.text()) as { sources: string[] };
  return parsed.sources.map((source) => (isAbsolute(source) ? source : resolve(ROOT, source)));
}

/** The containment the gate enforces: no input comes from the runtime. */
function runtimeInputs(inputs: string[]): string[] {
  return inputs.filter((input) =>
    FORBIDDEN_INPUTS.some(({ prefix }) => input === prefix || input.startsWith(`${prefix}/`)),
  );
}

test("bundling the worker-protocol export pulls no reconcile or ledger runtime code", async () => {
  const dir = stage();
  const entry = join(dir, "entry.mjs");
  await Bun.write(
    entry,
    `import { PROTOCOL_VERSION, encodeParentMessage, parseParentLine } from "@getkimchi/kimchi-bridge/worker-protocol";
export { PROTOCOL_VERSION, encodeParentMessage, parseParentLine };
`,
  );
  const inputs = await bundleInputs(entry);
  // The export itself is an input: the bundle really is the protocol module.
  expect(inputs).toContain(join(ROOT, "src/worker/protocol.ts"));
  expect(runtimeInputs(inputs)).toEqual([]);
  // The bundle loads and speaks the protocol version.
  const outfile = join(dir, "worker-protocol.mjs");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "the worker-protocol bundle failed");
  await Bun.write(outfile, result.outputs[0] as Blob);
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

test("the input-list gate rejects an entry that reaches the reconcile runtime", async () => {
  const dir = stage();
  const entry = join(dir, "negative.mjs");
  await Bun.write(
    entry,
    `import { PROTOCOL_VERSION } from "@getkimchi/kimchi-bridge/worker-protocol";
import { plainURL } from "../../src/reconcile/shared/url.js";
export { PROTOCOL_VERSION, plainURL };
`,
  );
  // A live import from the reconcile runtime appears in the bundler's input
  // list: had the gate only grepped the artifact for marker strings, this
  // module could ride along unnoticed.
  const inputs = await bundleInputs(entry);
  expect(runtimeInputs(inputs).length).toBeGreaterThan(0);
  expect(inputs).toContain(join(ROOT, "src/reconcile/shared/url.ts"));
});
