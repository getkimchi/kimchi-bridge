import { mock } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * A real child running one session-side (unfenced) queue update — setReportingEnabled — whose
 * consent comes from the reportingConsent host port, backed by a file the test owns so a second
 * actor can flip the choice mid-flight. It pauses INSIDE the state.json rename, after the
 * pre-rename fence check has already run and passed: that is the residual window a file rename
 * cannot fence, so the resumed rename still publishes the child's stale mirror over whatever
 * the successor wrote. The port, not the mirror, decides consent — the next read re-derives it.
 */

const dir = process.argv[2];
const consentFile = process.argv[3];
const realPromises = await import("node:fs/promises");
const realRename = realPromises.rename;
let paused = false;
mock.module("node:fs/promises", () => ({
  ...realPromises,
  rename: (async (from: unknown, to: unknown) => {
    if (!paused && String(to).endsWith("/state.json")) {
      paused = true;
      console.log(JSON.stringify({ beforeStateRename: true }));
      // The parent SIGSTOPs this real child here — past the fence check, inside the
      // rename the residual window leaves — across the lease handover and the stale
      // queue-lock window.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 9_000);
    }
    return realRename(from as `${string}/${string}`, to as `${string}/${string}`);
  }) as typeof realPromises.rename,
}));

/** The port's live read: the choice file's current text, re-read on every call. */
const consentPort = (): "on" | "off" | "follow-telemetry" | undefined => {
  try {
    const text = readFileSync(consentFile, "utf8").trim();
    return text === "" ? undefined : (text as "on" | "off" | "follow-telemetry");
  } catch (error) {
    // Fail closed, never guessed: an unreadable choice is "off".
    process.stderr.write(`stale-consent-child: consent read failed: ${String(error)}\n`);
    return "off";
  }
};

const { setDefaultHostPorts } = await import("../../../src/reconcile/host-ports.js");
setDefaultHostPorts({
  agentDir: dir,
  e2eSeam: () => undefined,
  now: () => Date.now(),
  credentials: () => ({ token: "key", apiUrl: "https://account.example" }),
  gitToken: () => undefined,
  endpoints: () => ({
    llmEndpoint: "https://llm.example",
    openAiBaseUrl: "https://openai.example",
    anthropicBaseUrl: "https://anthropic.example",
    experimentalOpenAiBaseUrl: "https://experimental.example",
    platformApiUrl: "https://account.example",
  }),
  orgPolicy: () => ({ resourceEnabled: () => true }),
  telemetryConsent: () => false,
  reportingConsent: consentPort,
  metric: () => {},
  fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
});
const { setReportingEnabled } = await import("../../../src/reconcile/pr-cost-reporting/queue.js");
let threw: string | undefined;
try {
  await setReportingEnabled(dir, true);
} catch (error) {
  threw = String(error);
}
console.log(JSON.stringify({ done: true, threw }));
