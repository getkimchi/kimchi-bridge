import { mock } from "bun:test";

/**
 * A real child running one session-side (unfenced) queue update: setReportingEnabled. It
 * pauses between its sidecar rename and the state.json rename — the exact window a suspended
 * process sits in — so the parent can hand the lease to a successor, let the successor publish
 * newer queue state through the stale queue lock, and then resume this child. Its resumed
 * pre-rename check must abort the update instead of renaming the older state over the
 * successor's.
 */

const dir = process.argv[2];
const realPromises = await import("node:fs/promises");
const realRename = realPromises.rename;
let paused = false;
mock.module("node:fs/promises", () => ({
  ...realPromises,
  rename: (async (from: unknown, to: unknown) => {
    if (!paused && String(to).endsWith("/state.version")) {
      paused = true;
      console.log(JSON.stringify({ beforeStateRename: true }));
      // The parent SIGSTOPs this real child here, across the lease handover and the stale
      // queue-lock window.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 9_000);
    }
    return realRename(from as `${string}/${string}`, to as `${string}/${string}`);
  }) as typeof realPromises.rename,
}));
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
