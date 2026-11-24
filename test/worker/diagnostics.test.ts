import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { HostPorts } from "../../src/reconcile/host.js";
import { withHostPorts } from "../../src/reconcile/host-ports.js";
import {
  debugWorkAttribution,
  setDiagnosticsRedactor,
} from "../../src/reconcile/work-attribution/diagnostics.js";
import { redactTokens } from "../../src/worker/protocol.js";

/**
 * The worker's diagnostics sink (reconcile-out-of-process plan, chunk B3):
 * opt-in debug lines are persisted to work-attribution.log, and in the worker
 * process they flow through the live secret registry before they are written,
 * so a credential carried in a logged error never reaches the file.
 */

const FAKE_TOKEN = "kchi_diag_fake_token_0123456789";
const dirs: string[] = [];

afterEach(() => {
  setDiagnosticsRedactor(undefined);
  delete process.env.NODE_DEBUG;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("a registered redactor scrubs logged errors before they persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-worker-diag-"));
  dirs.push(dir);
  process.env.NODE_DEBUG = "kimchi:work-attribution";
  const host = { agentDir: dir } as HostPorts;
  withHostPorts(host, () => {
    setDiagnosticsRedactor((text) => redactTokens(text, [FAKE_TOKEN]));
    debugWorkAttribution(
      "Could not report PR costs: %o",
      new Error(`upload failed for ${FAKE_TOKEN} at the gateway`),
    );
    // Without a registered redactor the line would persist verbatim; that is
    // the embedding process's own surface, kept unchanged.
    setDiagnosticsRedactor(undefined);
    debugWorkAttribution("plain line: %s", "no secrets here");
  });
  const log = join(dir, "logs", "work-attribution.log");
  expect(existsSync(log)).toBe(true);
  const text = readFileSync(log, "utf8");
  expect(text.includes(FAKE_TOKEN)).toBe(false);
  expect(text.includes("[redacted]")).toBe(true);
  expect(text.includes("no secrets here")).toBe(true);
});

test("short secrets are scrubbed from logged errors too", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-worker-diag-"));
  dirs.push(dir);
  process.env.NODE_DEBUG = "kimchi:work-attribution";
  const host = { agentDir: dir } as HostPorts;
  withHostPorts(host, () => {
    setDiagnosticsRedactor((text) => redactTokens(text, ["Q", "abcd", "abcdefgh"]));
    debugWorkAttribution("Could not reconcile costs: %o", new Error("key Q abcd abcdefgh"));
  });
  const text = readFileSync(join(dir, "logs", "work-attribution.log"), "utf8");
  for (const secret of ["Q", "abcd", "abcdefgh"]) expect(text.includes(secret)).toBe(false);
});
