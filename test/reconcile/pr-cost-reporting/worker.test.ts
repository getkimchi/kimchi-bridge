import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { HostMetric, HostPorts } from "../../../src/reconcile/host.js";
import { setDefaultHostPorts } from "../../../src/reconcile/host-ports.js";
import type {
  WorkRecord,
  WorkRecordProblem,
} from "../../../src/reconcile/work-attribution/summary.js";

/**
 * Ported from Kimchi's vitest worker suite (src/extensions/pr-cost-reporting/worker.test.ts).
 * The vitest suite mocked Kimchi's config, the global fetch and five modules. On the bridge
 * those seams are HostPorts (credentials, endpoints, consent, metric, fetch) plus bun's
 * mock.module for events, outbox, cost-sync, summary, costs, provider-api, queue and the
 * durable write, and bun's spyOn on the node:fs namespace (readSync, watchFile, watch) where
 * the vitest suite spied through its module mock. Defaults match the vitest suite exactly:
 * buildEvents answers an empty report, observeEvents is a no-op whose calls the tests read,
 * and everything else passes through to the real moved code.
 *
 * Not ported (stay in Kimchi, see the report): the two statusText wording assertions in the
 * server-limits suite — status.ts is unmoved TUI code — and nothing else; every remaining
 * assertion is carried over unchanged.
 */

// --- Mocked modules: actuals first, then bun mocks with the vitest defaults, then the SUT. ---
const eventsActual = await import("../../../src/reconcile/pr-cost-reporting/events.js");
const outboxActual = await import("../../../src/ledger/outbox.js");
const costSyncActual = await import("../../../src/reconcile/work-attribution/cost-sync.js");
const summaryActual = await import("../../../src/reconcile/work-attribution/summary.js");
const costsActual = await import("../../../src/reconcile/work-attribution/costs.js");
const providerApiActual = await import(
  "../../../src/reconcile/pull-request-status/provider-api.js"
);
const queueActual = await import("../../../src/reconcile/pr-cost-reporting/queue.js");
const durableActual = await import("../../../src/reconcile/shared/durable-write.js");
const timersActual = await import("node:timers/promises");
// Plain snapshots of the real exports, taken before mock.module patches the live bindings:
// after registration, XActual.foo resolves to the mock itself, so a passthrough that read the
// namespace would recurse into itself.
const eventsReal = { ...eventsActual };
const outboxReal = { ...outboxActual };
const costSyncReal = { ...costSyncActual };
const summaryReal = { ...summaryActual };
const costsReal = { ...costsActual };
const providerApiReal = { ...providerApiActual };
const queueReal = { ...queueActual };
const durableReal = { ...durableActual };
const timersReal = { ...timersActual };

type BuildEventsResult = Awaited<ReturnType<typeof eventsReal.buildEvents>>;
const emptyReport: BuildEventsResult = { accounts: [], units: [], unresolved: [] };
const buildEvents = mock(
  async (...args: Parameters<typeof eventsReal.buildEvents>): Promise<BuildEventsResult> => {
    void args;
    return emptyReport;
  },
);
const observeEvents = mock((...args: Parameters<typeof outboxReal.observeEvents>): undefined => {
  void args;
  return undefined;
});
const pendingBatch = mock((...args: Parameters<typeof outboxReal.pendingBatch>) =>
  outboxReal.pendingBatch(...args),
);
const readOutboxStatus = mock((...args: Parameters<typeof outboxReal.readOutboxStatus>) =>
  outboxReal.readOutboxStatus(...args),
);
const outboxDeliveryStatus = mock((...args: Parameters<typeof outboxReal.outboxDeliveryStatus>) =>
  outboxReal.outboxDeliveryStatus(...args),
);
const readWorkCostReportAsync = mock(
  (...args: Parameters<typeof costSyncReal.readWorkCostReportAsync>) =>
    costSyncReal.readWorkCostReportAsync(...args),
);
const importWorkRecordsAsync = mock(
  (...args: Parameters<typeof summaryReal.importWorkRecordsAsync>) =>
    summaryReal.importWorkRecordsAsync(...args),
);
const readWorkRecords = mock((...args: Parameters<typeof summaryReal.readWorkRecords>) =>
  summaryReal.readWorkRecords(...args),
);
const calculatePullRequestCostsAsync = mock(
  (...args: Parameters<typeof costsReal.calculatePullRequestCostsAsync>) =>
    costsReal.calculatePullRequestCostsAsync(...args),
);
const lookupRepositoryIdentity = mock(
  (...args: Parameters<typeof providerApiReal.lookupRepositoryIdentity>) =>
    providerApiReal.lookupRepositoryIdentity(...args),
);
const freezeSnapshots = mock((...args: Parameters<typeof queueReal.freezeSnapshots>) =>
  queueReal.freezeSnapshots(...args),
);
const writeFileDurably = mock((...args: Parameters<typeof durableReal.writeFileDurably>) =>
  durableReal.writeFileDurably(...args),
);
/** Pass-through timers: real macrotask semantics, with a call counter the tests can read. */
let immediateCalls = 0;
const setImmediateCalls = (): number => {
  const count = immediateCalls;
  immediateCalls = 0;
  return count;
};
mock.module("../../../src/reconcile/pr-cost-reporting/events.js", () => ({
  ...eventsReal,
  buildEvents,
}));
mock.module("../../../src/ledger/outbox.js", () => ({
  ...outboxReal,
  observeEvents,
  pendingBatch,
  readOutboxStatus,
  outboxDeliveryStatus,
}));
mock.module("../../../src/reconcile/work-attribution/cost-sync.js", () => ({
  ...costSyncReal,
  readWorkCostReportAsync,
}));
mock.module("../../../src/reconcile/work-attribution/summary.js", () => ({
  ...summaryReal,
  importWorkRecordsAsync,
  readWorkRecords,
}));
mock.module("../../../src/reconcile/work-attribution/costs.js", () => ({
  ...costsReal,
  calculatePullRequestCostsAsync,
}));
mock.module("../../../src/reconcile/pull-request-status/provider-api.js", () => ({
  ...providerApiReal,
  lookupRepositoryIdentity,
}));
mock.module("../../../src/reconcile/pr-cost-reporting/queue.js", () => ({
  ...queueReal,
  freezeSnapshots,
}));
mock.module("../../../src/reconcile/shared/durable-write.js", () => ({
  ...durableReal,
  writeFileDurably,
}));
mock.module("node:timers/promises", () => ({
  ...timersReal,
  setImmediate: (...args: Parameters<typeof timersReal.setImmediate>) => {
    immediateCalls += 1;
    return timersReal.setImmediate(...args);
  },
}));

// Imported after the module mocks above: the worker must see the mocked modules.
const { LookupError } = await import(
  "../../../src/reconcile/pull-request-status/provider-records.js"
);
const { requestTagSelector } = await import(
  "../../../src/reconcile/work-attribution/billing-source.js"
);
const { reportJournalProblems } = await import("../../../src/ledger/import.js");
const { backendFor, readRecords } = await import("../../../src/ledger/records.js");
const { appendWorkRecord } = await import("../../../src/reconcile/work-attribution.js");
const {
  HOLD_EXPIRY_MS,
  pendingFrozenSnapshots,
  queueSnapshots,
  readPendingBody,
  readReportingState,
  recordReportingError,
  setReportingEnabled,
  UPLOAD_INTERVAL_MS,
} = await import("../../../src/reconcile/pr-cost-reporting/queue.js");
const { flushWorkSummaries } = await import("../../../src/reconcile/work-attribution/summary.js");
import type {
  RepositorySnapshot,
  WireSnapshot,
} from "../../../src/reconcile/pr-cost-reporting/snapshot.js";
const { accountKey } = await import("../../../src/reconcile/pr-cost-reporting/snapshot.js");
const {
  deliverEvents,
  deliverSnapshots,
  LIMIT_RETRY_MS,
  preludeStretch,
  reconcileReporting,
  resetReportingPassGates,
  serverLimit,
} = await import("../../../src/reconcile/pr-cost-reporting/worker.js");
import type { Batch } from "../../../src/ledger/protocol.js";

/** Bun's it.each types reject the vitest-style tables below (plain and object rows). */
const each = (rows: readonly unknown[]): ((name: string, fn: (...args: any[]) => void) => void) =>
  (
    it.each as unknown as (
      this: unknown,
      rows: readonly unknown[],
    ) => (name: string, fn: (...args: any[]) => void) => void
  ).call(it, rows);

const org = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const content: RepositorySnapshot = {
  account: { apiUrl: "https://api.example", organizationId: org, userId: user },
  content: {
    repository: { provider: "github", host: "github.com", id: "42" },
    pullRequests: [],
    requests: [
      {
        requestId,
        billingRecordIds: [],
        startedAt: "2026-10-04T12:00:00Z",
        allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
      },
    ],
    coverage: { observedRequests: 1, unpricedRequests: 1, historyComplete: true },
  },
};
let directory: string;
// The vitest suite's config.js mock: one key, one endpoint, telemetry on.
let credential: { token: string; organizationId?: string; apiUrl: string } = {
  token: "test-key",
  apiUrl: "https://api.example",
};
let endpoint = "https://api.example";
/** Where the fake host resolves the SSO credential from (the stubbed agent dir of the vitest suite). */
let ssoAgentDir: string | undefined;
const recordedMetrics: HostMetric[] = [];
const http = mock(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    String(input).endsWith("api-keys:verify")
      ? Response.json({ organizationId: org, userId: user })
      : Response.json({
          status: "accepted",
          revision: JSON.parse(String(init?.body)).revision,
          receivedAt: new Date().toISOString(),
        }),
);
const workerHost: HostPorts = {
  get agentDir() {
    return directory;
  },
  e2eSeam: (name) => process.env[name],
  now: () => Date.now(),
  credentials(_cwd) {
    // An empty API key resolves to the SSO credential from auth.json in the agent directory —
    // exactly what Kimchi's host does (K1); the fake host reproduces the vitest suite's
    // loadConfig + auth.json stubbing so the SSO delivery path keeps its original coverage.
    if (credential.token === "" && ssoAgentDir) {
      const stored = JSON.parse(fs.readFileSync(join(ssoAgentDir, "auth.json"), "utf8")) as Record<
        string,
        { type?: string; access?: string; orgId?: string }
      >;
      const auth = stored["kimchi-dev"];
      if (auth?.type === "oauth" && auth.access)
        return { token: auth.access, organizationId: auth.orgId, apiUrl: endpoint };
    }
    return credential;
  },
  gitToken: () => undefined,
  endpoints(_cwd) {
    return {
      llmEndpoint: "https://llm.example",
      openAiBaseUrl: "https://llm.example/openai/v1",
      anthropicBaseUrl: "https://llm.example/anthropic",
      experimentalOpenAiBaseUrl: "https://llm.example/experimental/openai/v1",
      platformApiUrl: endpoint,
    };
  },
  orgPolicy: () => ({ resourceEnabled: () => true }),
  telemetryConsent: () => true,
  metric(metric) {
    recordedMetrics.push(metric);
  },
  fetch: (input, init) => http(input, init),
};
// Each hook takes the queue lock (with its fsync-heavy durable writes) and flushes every
// summary the test wrote, so a loaded machine can legitimately need more than the 5 s default
// test timeout; 30 s keeps these hooks from reporting a timeout that is really contention.
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kimchi-reporting-http-"));
  ssoAgentDir = undefined;
  credential = { token: "test-key", apiUrl: "https://api.example" };
  endpoint = "https://api.example";
  recordedMetrics.length = 0;
  buildEvents.mockReset();
  buildEvents.mockImplementation(async () => emptyReport);
  observeEvents.mockReset();
  observeEvents.mockImplementation(() => undefined);
  pendingBatch.mockReset();
  pendingBatch.mockImplementation((...args) => outboxReal.pendingBatch(...args));
  readOutboxStatus.mockReset();
  readOutboxStatus.mockImplementation((...args) => outboxReal.readOutboxStatus(...args));
  outboxDeliveryStatus.mockReset();
  outboxDeliveryStatus.mockImplementation((...args) => outboxReal.outboxDeliveryStatus(...args));
  readWorkCostReportAsync.mockReset();
  readWorkCostReportAsync.mockImplementation((...args) =>
    costSyncReal.readWorkCostReportAsync(...args),
  );
  importWorkRecordsAsync.mockReset();
  importWorkRecordsAsync.mockImplementation((...args) =>
    summaryReal.importWorkRecordsAsync(...args),
  );
  readWorkRecords.mockReset();
  readWorkRecords.mockImplementation((...args) => summaryReal.readWorkRecords(...args));
  calculatePullRequestCostsAsync.mockReset();
  calculatePullRequestCostsAsync.mockImplementation((...args) =>
    costsReal.calculatePullRequestCostsAsync(...args),
  );
  lookupRepositoryIdentity.mockReset();
  lookupRepositoryIdentity.mockImplementation((...args) =>
    providerApiReal.lookupRepositoryIdentity(...args),
  );
  freezeSnapshots.mockReset();
  freezeSnapshots.mockImplementation((...args) => queueReal.freezeSnapshots(...args));
  writeFileDurably.mockReset();
  writeFileDurably.mockImplementation((...args) => durableReal.writeFileDurably(...args));
  http.mockReset();
  http.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      String(input).endsWith("api-keys:verify")
        ? Response.json({ organizationId: org, userId: user })
        : Response.json({
            status: "accepted",
            revision: JSON.parse(String(init?.body)).revision,
            receivedAt: new Date().toISOString(),
          }),
  );
  setDefaultHostPorts(workerHost);
  await setReportingEnabled(directory, true);
  await queueSnapshots(directory, [content]);
}, 30_000);
afterEach(async () => {
  // Restores the spyOn'd globals (Date.now, Math.random, node:fs) like vi.restoreAllMocks.
  mock.restore();
  // bun test keeps mock.module registrations for the rest of the run, so the file loaded
  // next sees whatever implementations this suite last installed. buildEvents and
  // observeEvents end on their no-op stand-ins after the final test, which would silently
  // drop real reports and events for any later suite importing these modules; both return to
  // full pass-through here so the registered mocks behave exactly like the real exports.
  buildEvents.mockImplementation((...args) => eventsReal.buildEvents(...args));
  observeEvents.mockImplementation((...args) => {
    outboxReal.observeEvents(...args);
    return undefined;
  });
  setDefaultHostPorts(undefined);
  await flushWorkSummaries();
  await rm(directory, { recursive: true, force: true });
}, 30_000);
const capturedReport = () => buildEvents.mock.calls.at(-1)?.[1];
/** Every request each connected group of works passed to the producer. */
const capturedRequests = () => buildEvents.mock.calls.flatMap(([, report]) => report.requests);
const deliver = () =>
  deliverSnapshots(directory, "/project", new AbortController().signal, () => {});
const eventUploads = () =>
  http.mock.calls.filter(([url]) => String(url).endsWith("pr-cost-events:batchIngest"));

async function seedCoverageEvents(
  storedKey: string,
  count: number,
  alternates: readonly string[] = [],
): Promise<void> {
  for (let index = 0; index < count; index++) {
    const key = alternates[index % alternates.length] ?? storedKey;
    outboxReal.observeEvents(
      directory,
      key,
      [
        {
          entityId: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
          source: "codex",
          sourceVersion: "test",
          deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          observeTime: "2026-10-24T00:00:00.123456789Z",
          coverage: { code: "observed", count: "1" },
        },
      ],
      [],
      () => {},
    );
  }
  pendingBatch.mockImplementation((...args) => outboxReal.pendingBatch(...args));
}

function acceptEventBatches(
  onBatch?: (attempt: number, batch: Batch) => Response | undefined | Promise<Response | undefined>,
): void {
  let attempts = 0;
  http.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("api-keys:verify"))
        return Response.json({ organizationId: org, userId: user });
      const batch: Batch = JSON.parse(String(init?.body)).batch;
      const intercepted = await onBatch?.(++attempts, batch);
      if (intercepted) return intercepted;
      return Response.json({
        batchId: batch.id,
        receipts: batch.events.map((event) => ({
          id: event.id,
          revision: event.revision,
          status: "accepted",
        })),
      });
    },
  );
}

async function seedLinked(priced = true) {
  const at = "2026-10-04T12:00:00.000Z";
  const common = {
    version: 1,
    workId: "55555555-5555-4555-8555-555555555555",
    sessionId: "private-session",
    recordedAt: at,
  };
  const source = {
    apiUrl: "https://api.example",
    gatewayUrl: "https://gateway.example/v1/chat/completions",
    credentialHash: "a".repeat(64),
  };
  const rows = [
    {
      ...common,
      type: "request",
      requestId,
      startedAt: at,
      scope: { account: content.account, repository: "/private/repo/.git" },
    },
    {
      ...common,
      type: "request_dispatch",
      requestId,
      startedAt: at,
      dispatchedAt: at,
      billingSource: source,
      billingSelector: requestTagSelector(requestId, at),
    },
    ...(priced
      ? [
          {
            ...common,
            type: "request_cost",
            requestId,
            billingSource: source,
            billingSelector: requestTagSelector(requestId, at),
            billingRows: [{ id: "44444444-4444-4444-8444-444444444444", costUsd: "0.123456789" }],
            billingLookup: { status: "priced", checkedAt: at, organizationId: org, userId: user },
          },
        ]
      : []),
    {
      ...common,
      type: "commit",
      repository: "/private/repo/.git",
      worktree: "/private/repo",
      sha: "b".repeat(40),
      pullRequests: [
        {
          provider: "github",
          id: "101",
          repositoryId: "42",
          host: "github.com",
          repository: "example/repo",
          number: 1,
          url: "https://github.com/example/repo/pull/1",
          state: "merged",
          mergedAt: "2026-10-04T13:00:00.000Z",
          closedAt: null,
          checkedAt: at,
          headSha: "b".repeat(40),
          mergeCommitSha: null,
        },
      ],
    },
  ];
  await mkdir(join(directory, "work-attribution"), { recursive: true });
  await writeFile(
    join(directory, "work-attribution", "source.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

describe("account-fenced reporting delivery", () => {
  it("verifies the credential once per pass for a multi-entry queue", async () => {
    const extra = (id: string): RepositorySnapshot => ({
      ...content,
      content: {
        ...content.content,
        repository: { provider: "github", host: "github.com", id },
      },
    });
    await queueSnapshots(directory, [extra("43"), extra("44")]);
    await deliverSnapshots(directory, "/project", new AbortController().signal, () => {});
    const verifies = http.mock.calls.filter(([input]) => String(input).endsWith("api-keys:verify"));
    const uploads = http.mock.calls.filter(([input]) => !String(input).endsWith("api-keys:verify"));
    expect(verifies).toHaveLength(1);
    expect(uploads).toHaveLength(3);
  });

  it("replays a cached verify failure within the pass without repeating the request", async () => {
    http.mockReset();
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("api-keys:verify")) return new Response("nope", { status: 403 });
        return Response.json({
          status: "accepted",
          revision: JSON.parse(String(init?.body)).revision,
          receivedAt: new Date().toISOString(),
        });
      },
    );
    const extra = (id: string): RepositorySnapshot => ({
      ...content,
      content: {
        ...content.content,
        repository: { provider: "github", host: "github.com", id },
      },
    });
    await queueSnapshots(directory, [extra("43")]);
    await deliverSnapshots(directory, "/project", new AbortController().signal, () => {});
    const verifies = http.mock.calls.filter(([input]) => String(input).endsWith("api-keys:verify"));
    expect(verifies).toHaveLength(1);
    // Both entries took the identical 403 defer: same error text, same 4xx-hour backoff.
    const entries = Object.values((await readReportingState(directory)).entries);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.lastError).toBe(
        "PR reporting is not allowed for this API key: uploading PR costs needs an Owner or Member role (HTTP 403)",
      );
      expect(entry.retryAt).toBeGreaterThan(Date.now() + 30 * 60_000);
    }
  });
  it("makes no authentication request when the event outbox is empty", async () => {
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(http).not.toHaveBeenCalled();
  });
  it("preserves cooperative journal-prefix verification during capture", async () => {
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(importWorkRecordsAsync).toHaveBeenCalledWith(
      directory,
      expect.any(Function),
      expect.any(Function),
      true,
    );
  });
  it("stamps the gate from delivery-only status instead of historical aggregation", async () => {
    await seedCoverageEvents(accountKey(content.account), 1);
    acceptEventBatches();
    readOutboxStatus.mockImplementation(() => {
      throw new Error("historical aggregation must not gate delivery");
    });
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(1);
    expect(readOutboxStatus).not.toHaveBeenCalled();
  });
  it("delivers from the projection rather than aggregating the full status", async () => {
    await seedCoverageEvents(accountKey(content.account), 1);
    acceptEventBatches();
    readOutboxStatus.mockImplementation(() => {
      throw new Error("full status aggregation must not run during delivery");
    });
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(1);
    expect(readOutboxStatus).not.toHaveBeenCalled();
  });
  each(["backoff", "explicit resume", "another eligible account"])(
    "checks event schedules before authentication: %s",
    async (mode) => {
      const backend = backendFor(directory);
      const accountId = accountKey(content.account);
      const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const batch = {
        id: batchId,
        accountKey: accountId,
        body: new Uint8Array(),
        eventIds: [],
        createdAt: Date.now(),
        orderKey: "",
      };
      backend.insertOutboxBatch(batch);
      backend.putNote(
        "pr-cost-delivery",
        accountId,
        JSON.stringify({
          batchId,
          attempts: 1,
          retryAt: Date.now() + 60_000,
          resume: backend.getNote("agent", "legacy-snapshot-resume"),
        }),
      );
      if (mode === "explicit resume") await setReportingEnabled(directory, true);
      if (mode === "another eligible account")
        backend.insertOutboxBatch({
          ...batch,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          accountKey: "other-account",
        });
      // Only the schedule matters here: no batch is sent after authentication.
      pendingBatch.mockReturnValue(undefined);
      await deliverEvents(directory, "/project", new AbortController().signal, () => {});
      expect(http).toHaveBeenCalledTimes(mode === "backoff" ? 0 : 1);
      if (mode !== "backoff") expect(String(http.mock.calls[0][0])).toContain("api-keys:verify");
    },
  );

  // Lower bounds below the ±20% jitter: 4xx waits about an hour, a transient failure about 30 seconds.
  each([
    [401, 40 * 60_000],
    [503, 20_000],
  ])(
    "backs off an event account after a verification answered HTTP %i instead of verifying every pass",
    async (code, least) => {
      const accountId = accountKey(content.account);
      backendFor(directory).insertOutboxBatch({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        accountKey: accountId,
        body: new Uint8Array(),
        eventIds: [],
        createdAt: Date.now(),
        orderKey: "",
      });
      http.mockResolvedValue(new Response("{}", { status: code }));
      const run = () =>
        deliverEvents(directory, "/project", new AbortController().signal, () => {});
      await run();
      await run();
      expect(http).toHaveBeenCalledTimes(1);
      const retry = JSON.parse(
        backendFor(directory).getNote("pr-cost-delivery", accountId) ?? "null",
      );
      expect(retry).toMatchObject({
        attempts: 1,
        error: `PR cost event upload returned HTTP ${code}`,
      });
      expect(retry.retryAt - Date.now()).toBeGreaterThan(least);
    },
  );

  each(["an opt-out", "an endpoint change"])(
    "ends the pass without a backoff when %s interrupts the verification",
    async (interruption) => {
      const accountId = accountKey(content.account);
      backendFor(directory).insertOutboxBatch({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        accountKey: accountId,
        body: new Uint8Array(),
        eventIds: [],
        createdAt: Date.now(),
        orderKey: "",
      });
      http.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (interruption === "an endpoint change") {
          endpoint = "https://other.example";
          return Response.json({ organizationId: org, userId: user });
        }
        await setReportingEnabled(directory, false);
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      });
      await expect(
        deliverEvents(directory, "/project", new AbortController().signal, () => {}),
      ).rejects.toThrow();
      expect(http).toHaveBeenCalledTimes(1);
      expect(backendFor(directory).getNote("pr-cost-delivery", accountId)).toBeUndefined();
    },
  );

  it("still delivers a snapshot queued under the legacy console platform API base", async () => {
    // Snapshots queued before the platform API moved to the region's API origin
    // hold webAppUrl + "/api" as their account base. The delivery pass must not
    // skip them as another account's reports — with no TTL, that skip would be
    // permanent.
    endpoint = "https://api.cast.ai";
    await queueSnapshots(directory, [
      { ...content, account: { ...content.account, apiUrl: "https://app.kimchi.dev/api" } },
    ]);
    await deliver();
    expect(http.mock.calls.some(([url]) => String(url).endsWith("pr-cost-snapshots"))).toBe(true);
  });

  it("uploads snapshots and events with the SSO credential when no API key is configured", async () => {
    credential = { token: "", apiUrl: "https://api.example" };
    const agentDir = join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: org },
      }),
    );
    ssoAgentDir = agentDir;
    await deliver();
    const batch = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountKey: accountKey(content.account),
      body: new TextEncoder().encode("{}"),
      eventIds: [],
      createdAt: Date.now(),
      orderKey: "",
    };
    backendFor(directory).insertOutboxBatch(batch);
    // Only the request headers matter here, so skip encoding a valid event batch.
    pendingBatch.mockReturnValue(batch);
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    for (const route of ["pr-cost-snapshots", "pr-cost-events:batchIngest"]) {
      const upload = http.mock.calls.find(([url]) => String(url).endsWith(route));
      const headers = new Headers(upload?.[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer oauth-access");
      expect(headers.get("x-castai-organization-id")).toBe(org);
    }
  });

  it("sends events beside a held legacy snapshot that only an older version could release", async () => {
    // The older version held this replacement because earlier evidence went missing; it is never sent.
    const path = join(directory, "pr-cost-reporting", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    for (const entry of Object.values<{ held?: boolean }>(state.entries)) entry.held = true;
    await writeFile(path, `${JSON.stringify(state)}\n`);
    const batch = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountKey: accountKey(content.account),
      body: new TextEncoder().encode("{}"),
      eventIds: [],
      createdAt: Date.now(),
      orderKey: "",
    };
    backendFor(directory).insertOutboxBatch(batch);
    pendingBatch.mockReturnValue(batch);
    await deliver();
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(posts()).toEqual([]);
    expect(
      http.mock.calls.some(([url]) => String(url).endsWith("pr-cost-events:batchIngest")),
    ).toBe(true);
  });

  it("sends events while the account's legacy snapshot keeps failing with HTTP 413", async () => {
    // nginx in front of the API refuses a body above 1 MiB, so this snapshot never drains.
    const batch = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountKey: accountKey(content.account),
      body: new TextEncoder().encode("{}"),
      eventIds: [],
      createdAt: Date.now(),
      orderKey: "",
    };
    http.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("api-keys:verify"))
        return Response.json({ organizationId: org, userId: user });
      if (url.endsWith("/pr-cost-snapshots"))
        return new Response("Request Entity Too Large", { status: 413 });
      return Response.json({ batchId: batch.id, receipts: [] });
    });
    await deliver();
    backendFor(directory).insertOutboxBatch(batch);
    pendingBatch.mockReturnValue(batch);
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(posts()).toHaveLength(1);
    expect(
      http.mock.calls.some(([url]) => String(url).endsWith("pr-cost-events:batchIngest")),
    ).toBe(true);
  });

  it("delivers canonical-equivalent legacy account keys and drains beyond the old attempt cap", async () => {
    const legacyKey = accountKey({ ...content.account, apiUrl: "https://app.kimchi.dev/api" });
    endpoint = "https://api.cast.ai";
    await seedCoverageEvents(legacyKey, 400);
    acceptEventBatches();
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(4);
    expect(outboxDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(http.mock.calls.filter(([url]) => String(url).endsWith("api-keys:verify"))).toHaveLength(
      1,
    );
    expect(
      outboxReal.readOutboxStatus(directory).find((status) => status.accountKey === legacyKey),
    ).toMatchObject({
      pending: 0,
      acknowledged: 400,
      batches: 0,
    });
    expect(
      outboxActual
        .readOutboxStatus(directory)
        .find((status) => status.accountKey === accountKey(content.account)),
    ).toBeUndefined();
  });

  it("does not treat a legacy URL belonging to another organization as the credential", async () => {
    const foreignKey = accountKey({
      ...content.account,
      apiUrl: "https://app.kimchi.dev/api",
      organizationId: user,
    });
    endpoint = "https://api.cast.ai";
    await seedCoverageEvents(foreignKey, 1);
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(0);
    expect(
      JSON.parse(backendFor(directory).getNote("pr-cost-delivery", foreignKey) ?? "{}").error,
    ).toBe("PR reporting is waiting for the original account");
  });

  it("stops draining event batches when the pass's deadline cancels the fourth upload", async () => {
    const storedKey = accountKey(content.account);
    await seedCoverageEvents(storedKey, 500);
    const controller = new AbortController();
    acceptEventBatches((attempt) => {
      if (attempt === 4) controller.abort();
      return undefined;
    });
    await deliverEvents(directory, "/project", controller.signal, () => {});
    expect(eventUploads()).toHaveLength(4);
    expect(
      outboxReal.readOutboxStatus(directory).find((status) => status.accountKey === storedKey),
    ).toMatchObject({
      pending: 200,
      acknowledged: 300,
    });
  });

  it("delivers two canonical-equivalent own keys with one verification and status read", async () => {
    const legacyKey = accountKey({ ...content.account, apiUrl: "https://app.kimchi.dev/api" });
    const currentKey = accountKey({ ...content.account, apiUrl: "https://api.cast.ai" });
    endpoint = "https://api.cast.ai";
    await seedCoverageEvents(currentKey, 400, [legacyKey, currentKey]);
    acceptEventBatches();
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(4);
    expect(outboxDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(http.mock.calls.filter(([url]) => String(url).endsWith("api-keys:verify"))).toHaveLength(
      1,
    );
    for (const key of [legacyKey, currentKey])
      expect(
        outboxReal.readOutboxStatus(directory).find((status) => status.accountKey === key),
      ).toMatchObject({
        pending: 0,
        acknowledged: 200,
        batches: 0,
      });
  });

  each([
    [
      "a different user",
      accountKey({ ...content.account, apiUrl: "https://app.kimchi.dev/api", userId: requestId }),
    ],
    [
      "a non-UUID user",
      accountKey({
        ...content.account,
        apiUrl: "https://app.kimchi.dev/api",
        userId: "not-a-uuid",
      }),
    ],
    ["a malformed stored key", "not-json"],
  ])("defers %s without sending its events", async (_label, key) => {
    endpoint = "https://api.cast.ai";
    await seedCoverageEvents(key, 1);
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(0);
    expect(JSON.parse(backendFor(directory).getNote("pr-cost-delivery", key) ?? "{}").error).toBe(
      "PR reporting is waiting for the original account",
    );
  });

  it("retains pending events and backoff when a later batch is rate limited", async () => {
    const storedKey = accountKey(content.account);
    await seedCoverageEvents(storedKey, 500);
    acceptEventBatches((attempt) =>
      attempt === 4
        ? new Response("rate-limited", { status: 429, headers: { "Retry-After": "120" } })
        : undefined,
    );
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(4);
    expect(
      outboxReal.readOutboxStatus(directory).find((status) => status.accountKey === storedKey),
    ).toMatchObject({
      pending: 200,
      acknowledged: 300,
      batches: 1,
    });
    const retry = JSON.parse(backendFor(directory).getNote("pr-cost-delivery", storedKey) ?? "{}");
    expect(retry).toMatchObject({ attempts: 1, error: "PR cost event upload returned HTTP 429" });
    expect(retry.retryAt - Date.now()).toBeGreaterThan(60_000);
    expect(backendFor(directory).getOutboxBatch(storedKey)).not.toBeUndefined();
  });

  it("stops after consent changes between batches and retains remaining events", async () => {
    const storedKey = accountKey(content.account);
    await seedCoverageEvents(storedKey, 500);
    acceptEventBatches(async (attempt) => {
      if (attempt === 2) await setReportingEnabled(directory, false);
      return undefined;
    });
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    expect(eventUploads()).toHaveLength(2);
    expect(
      outboxReal.readOutboxStatus(directory).find((status) => status.accountKey === storedKey),
    ).toMatchObject({
      pending: 400,
      acknowledged: 100,
      batches: 1,
    });
  });

  it("keeps an event batch without an error when the credential changes during its upload", async () => {
    const batch = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountKey: accountKey(content.account),
      body: new TextEncoder().encode("{}"),
      eventIds: [],
      createdAt: Date.now(),
      orderKey: "",
    };
    backendFor(directory).insertOutboxBatch(batch);
    pendingBatch.mockReturnValue(batch);
    http.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith("api-keys:verify"))
        return Response.json({ organizationId: org, userId: user });
      // An SSO refresh rewrites the credential while the batch is in flight.
      credential = { token: "refreshed-key", apiUrl: "https://api.example" };
      return Response.json({ batchId: batch.id, receipts: [] });
    });
    await expect(
      deliverEvents(directory, "/project", new AbortController().signal, () => {}),
    ).resolves.toBeUndefined();
    expect(
      http.mock.calls.some(([url]) => String(url).endsWith("pr-cost-events:batchIngest")),
    ).toBe(true);
    expect((await readReportingState(directory)).error).toBeUndefined();
    expect(backendFor(directory).getOutboxBatch(batch.accountKey)?.id).toBe(batch.id);
    expect(backendFor(directory).getNote("pr-cost-delivery", batch.accountKey)).toBeUndefined();
  });

  it("sends a batch's events under a new ID after the server answers 409 for its ID", async () => {
    const batch = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountKey: accountKey(content.account),
      body: new TextEncoder().encode("{}"),
      eventIds: [],
      createdAt: Date.now(),
      orderKey: "",
    };
    backendFor(directory).insertOutboxBatch(batch);
    pendingBatch.mockReturnValue(batch);
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response("{}", { status: 409 }),
    );
    await deliverEvents(directory, "/project", new AbortController().signal, () => {});
    // The server holds other content under this ID, so resending the frozen batch could never succeed.
    expect(backendFor(directory).getOutboxBatch(batch.accountKey)).toBeUndefined();
    expect(backendFor(directory).getNote("pr-cost-delivery", batch.accountKey)).toBeUndefined();
  });

  it("queues the producer's facts and original hashes under their original account", async () => {
    await seedLinked(false);
    const group = {
      account: content.account,
      facts: [
        {
          entityId: "work",
          source: "kimchi",
          sourceVersion: "test",
          deviceId: requestId,
          observeTime: "2026-10-04T12:00:00Z",
          work: { reason: "explicit", quality: "confirmed" },
        },
      ],
      recordHashes: ["a".repeat(64)],
    };
    const units = [
      {
        account: accountKey(content.account),
        entities: ["work"],
        recordHashes: group.recordHashes,
      },
    ];
    buildEvents.mockResolvedValueOnce({ accounts: [group], units, unresolved: [] });
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(observeEvents).toHaveBeenCalledWith(
      directory,
      accountKey(content.account),
      group.facts,
      [],
      expect.any(Function),
    );
    // The group's records count as translated once its events commit.
    expect(backendFor(directory).markedRecords()).toEqual([]);
    expect(buildEvents.mock.calls.at(-1)?.[0].map((row) => JSON.parse(row.body))).toEqual(
      readRecords(directory),
    );
  });

  it("delivers frozen legacy bytes when an older writer replaces the queue during verification", async () => {
    const original = JSON.stringify(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    );
    let replaced = false;
    const bodies: string[] = [];
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("api-keys:verify")) {
          if (!replaced) {
            replaced = true;
            await queueSnapshots(directory, [
              {
                ...content,
                content: {
                  ...content.content,
                  requests: content.content.requests.map((request) => ({
                    ...request,
                    allocation: { ...request.allocation, kind: "unknown" },
                  })),
                },
              },
            ]);
          }
          return Response.json({ organizationId: org, userId: user });
        }
        bodies.push(String(init?.body));
        const snapshot = JSON.parse(String(init?.body));
        return Response.json({
          status: "accepted",
          revision: snapshot.revision,
          receivedAt: new Date().toISOString(),
        });
      },
    );
    await deliver();
    expect(bodies).toEqual([original]);
    expect(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    ).toMatchObject({
      revision: "2",
      requests: [{ allocation: { kind: "unknown" } }],
    });
    await deliver();
    expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1", "2"]);
    expect(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    ).toBeUndefined();
  });

  it("retries the original frozen body after a lost ACK even when a newer revision was accepted", async () => {
    const original = JSON.stringify(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    );
    const bodies: string[] = [];
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("api-keys:verify"))
          return Response.json({ organizationId: org, userId: user });
        const body = String(init?.body);
        bodies.push(body);
        if (bodies.length === 1) {
          await queueSnapshots(directory, [inventory([requestId, second])]);
          throw new Error("ACK lost");
        }
        const snapshot: WireSnapshot = JSON.parse(body);
        return Response.json({
          status: snapshot.revision === "1" ? "stale" : "accepted",
          revision: "2",
          receivedAt: new Date().toISOString(),
        });
      },
    );
    await deliver();
    await deliver();
    expect(bodies.map((body) => JSON.parse(body).revision)).toEqual(["1", "2"]);
    expect(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    ).toBeUndefined();
    const clock = spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + UPLOAD_INTERVAL_MS);
    await deliver();
    expect(bodies.map((body) => JSON.parse(body).revision)).toEqual(["1", "2", "1"]);
    expect(bodies[2]).toBe(original);
    expect(Object.values((await readReportingState(directory)).entries)[0].revision).toBe("2");
    await deliver();
    expect(bodies).toHaveLength(3);
  });

  it("freezes an older writer's replacement under the capture lock without publishing a new legacy inventory", async () => {
    await seedLinked();
    const read = summaryReal.importWorkRecordsAsync;
    let replacement: string | undefined;
    importWorkRecordsAsync.mockImplementationOnce(
      async (...args: Parameters<typeof summaryReal.importWorkRecordsAsync>) => {
        const records = await read(...args);
        await queueSnapshots(directory, [
          {
            ...content,
            content: {
              ...content.content,
              requests: content.content.requests.map((request) => ({
                ...request,
                allocation: { ...request.allocation, kind: "unknown" },
              })),
            },
          },
        ]);
        replacement = JSON.stringify(
          readPendingBody(
            directory,
            Object.values((await readReportingState(directory)).entries)[0],
          ),
        );
        return records;
      },
    );
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1", "2"]);
    expect(posts().map((snapshot) => snapshot.requests[0].allocation.kind)).toEqual([
      "unlinked",
      "unknown",
    ]);
    expect(
      http.mock.calls.filter(([input]) => String(input).endsWith("pr-cost-snapshots"))[1]?.[1]
        ?.body,
    ).toBe(replacement);
  });

  it("recovers a durable frozen ACK when legacy file cleanup fails without resending", async () => {
    const path = join(directory, "pr-cost-reporting/state.json");
    const write = durableReal.writeFileDurably;
    writeFileDurably.mockImplementation(
      async (
        target: string,
        body: string,
        check?: Parameters<typeof durableReal.writeFileDurably>[2],
      ): Promise<void> => {
        if (
          target === path &&
          !Object.values(JSON.parse(String(body)).entries).some(
            (entry) => (entry as { pendingId?: unknown }).pendingId,
          )
        )
          throw new Error("legacy cleanup failed");
        return write(target, body, check);
      },
    );
    await deliver();
    expect(posts()).toHaveLength(1);
    // The acknowledgement's cleanup write failed, so the live entry still points at its
    // frozen note; the receipt on that note is what keeps the next pass from resending.
    expect(Object.values((await readReportingState(directory)).entries)[0].pendingId).toBeDefined();
    writeFileDurably.mockImplementation(
      (...args: Parameters<typeof durableReal.writeFileDurably>) =>
        durableReal.writeFileDurably(...args),
    );
    await deliver();
    expect(posts()).toHaveLength(1);
    expect(
      Object.values((await readReportingState(directory)).entries)[0].pendingId,
    ).toBeUndefined();
  });

  it("captures work before a PR exists and captures its later PR without writing legacy inventory", async () => {
    await rm(join(directory, "pr-cost-reporting/state.json"));
    await seedLinked();
    const path = join(directory, "work-attribution/source.jsonl");
    const linked = await readFile(path, "utf8");
    await writeFile(
      path,
      `${linked
        .trim()
        .split("\n")
        .filter((line) => JSON.parse(line).type !== "commit")
        .join("\n")}\n`,
    );
    lookupRepositoryIdentity.mockResolvedValue({
      ...content.content.repository,
      name: "example/repo",
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(capturedReport()?.requests[0]).toMatchObject({ requestId, pullRequestIds: [] });
    const firstProducer = buildEvents.mock.calls.at(-1)?.[3];
    await writeFile(path, linked);
    await run();
    expect(capturedReport()?.requests[0].pullRequestIds).toHaveLength(1);
    expect(capturedReport()?.pullRequests[0].pullRequest).toMatchObject({
      id: "101",
      repositoryId: "42",
    });
    expect(buildEvents.mock.calls.at(-1)?.[3]).toBe(firstProducer);
    expect(posts()).toEqual([]);
    expect((await readReportingState(directory)).entries).toEqual({});
    // Import changes the authority fingerprint; one following pass catches up to that prefix.
    await run();
    const captures = buildEvents.mock.calls.length;
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(captures);
  });
  each(["success", "failed", "canceled"])(
    "records one %s delivery outcome and the remaining queue",
    async (outcome) => {
      const abort = new AbortController();
      http.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).endsWith("api-keys:verify"))
          return Response.json({ organizationId: org, userId: user });
        if (outcome === "canceled") {
          abort.abort();
          throw abort.signal.reason;
        }
        return outcome === "failed"
          ? new Response(null, { status: 503 })
          : Response.json({
              status: "accepted",
              revision: "1",
              receivedAt: new Date().toISOString(),
            });
      });
      await deliverSnapshots(directory, "/project", abort.signal, () => {});
      await readReportingState(directory);
      // The vitest suite spied on telemetry's trackPRCostMetric; the bridge records the same
      // payloads through the metric port.
      expect(recordedMetrics.filter((metric) => metric.kind === "delivery")).toEqual([
        { kind: "delivery", outcome },
      ]);
      expect(recordedMetrics.at(-1)).toEqual({
        kind: "queueDepth",
        value: outcome === "success" ? 0 : 1,
      });
    },
  );
  it("retains every same-repository post-merge candidate for common event construction", async () => {
    await seedLinked();
    const path = join(directory, "work-attribution", "source.jsonl");
    const rows = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    rows.find((row) => row.type === "request").startedAt = "2026-10-04T14:00:00.000Z";
    const commit = rows.find((row) => row.type === "commit");
    commit.pullRequests.push({
      ...commit.pullRequests[0],
      id: "102",
      number: 2,
      url: "https://github.com/example/repo/pull/2",
    });
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(capturedReport()?.requests[0]).toMatchObject({
      allocation: "post-merge",
    });
    expect(capturedReport()?.requests[0].pullRequestIds).toHaveLength(2);
    expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1"]);
    expect((await readReportingState(directory)).error).toBeUndefined();
  });
  it("does not manufacture a legacy withdrawal when source records disappear", async () => {
    await seedLinked();
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    const path = join(directory, "work-attribution/source.jsonl");
    await rm(path);
    const before = posts().length;
    await run();
    expect(posts()).toHaveLength(before);
    expect(
      Object.values((await readReportingState(directory)).entries).map((entry) => entry.revision),
    ).toEqual(["1"]);
    // The removed journal's records stay in the ledger, so later captures still see complete history.
    await run();
    expect((await readReportingState(directory)).error).toBeUndefined();
  });
  it("reports valid scoped work beside unrelated unscoped legacy history with incomplete coverage", async () => {
    await seedLinked();
    const sourcePath = join(directory, "work-attribution", "source.jsonl");
    await writeFile(
      sourcePath,
      // The legacy work has repository evidence, so its unscoped request leaves that history incomplete.
      `${await readFile(sourcePath, "utf8")}${JSON.stringify({ version: 1, type: "request", workId: "66666666-6666-4666-8666-666666666666", sessionId: "legacy-session", requestId: "77777777-7777-4777-8777-777777777777", recordedAt: "2026-10-01T10:00:00Z" })}\n${JSON.stringify({ version: 1, type: "commit", workId: "66666666-6666-4666-8666-666666666666", sessionId: "legacy-session", sha: "c".repeat(40), repository: "/project/.git", worktree: "/project", recordedAt: "2026-10-01T10:00:00Z", pullRequests: [] })}\n`,
    );
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(capturedRequests().find((row) => row.requestId === requestId)?.account).toEqual(
      content.account,
    );
    expect(
      capturedRequests().find((row) => row.requestId === "77777777-7777-4777-8777-777777777777")
        ?.account,
    ).toBeNull();
    expect(
      buildEvents.mock.calls.flatMap(([stored]) => stored.map((row) => JSON.parse(row.body))),
    ).toContainEqual(expect.objectContaining({ sessionId: "legacy-session", type: "request" }));
  });
  it("keeps broken and healthy source evidence separate for the common producer", async () => {
    await seedLinked();
    const sourcePath = join(directory, "work-attribution", "source.jsonl");
    const healthyId = "77777777-7777-4777-8777-777777777777";
    const healthy = (await readFile(sourcePath, "utf8"))
      .replaceAll(requestId, healthyId)
      .replaceAll('"repositoryId":"42"', '"repositoryId":"43"');
    const broken = {
      version: 1,
      type: "request",
      workId: "66666666-6666-4666-8666-666666666666",
      sessionId: "broken",
      requestId,
      recordedAt: "2026-10-01T10:00:00Z",
    };
    await writeFile(sourcePath, `${healthy}${JSON.stringify(broken)}\n`);
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(capturedRequests().find((row) => row.requestId === healthyId)?.account).toEqual(
      content.account,
    );
    expect(capturedRequests().find((row) => row.requestId === requestId)?.account).toBeNull();
    expect(posts().map((snapshot) => snapshot.repository.id)).toEqual(["42"]);
  });
  each([true, false])(
    "passes validated billing evidence to the common producer (priced=%s)",
    async (priced) => {
      await seedLinked(priced);
      await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
      expect(capturedReport()?.requests[0]).toMatchObject({
        requestId,
        billingRecordIds: priced ? ["44444444-4444-4444-8444-444444444444"] : [],
      });
      const stored = buildEvents.mock.calls.at(-1)?.[0];
      // The producer receives each journal line's original hash, not a hash of its reserialized body.
      const lines = (await readFile(join(directory, "work-attribution", "source.jsonl"), "utf8"))
        .trimEnd()
        .split("\n");
      expect(stored?.map((row) => row.recordHash)).toEqual(
        lines.map((line) => createHash("sha256").update(line).digest("hex")),
      );
      expect(posts().map((snapshot) => snapshot.revision)).toEqual(["1"]);
    },
  );
  it("does not look up or send with a different configured endpoint", async () => {
    endpoint = "https://other.example";
    await deliver();
    expect(http).not.toHaveBeenCalled();
  });
  it("does not follow a redirect or delete the durable attempt", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } }),
    );
    await deliver();
    expect(http).toHaveBeenCalledTimes(2);
    expect(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    ).toBeDefined();
  });
  it("retains a newer snapshot when the older in-flight snapshot is acknowledged", async () => {
    http.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith("api-keys:verify"))
        return Response.json({ organizationId: org, userId: user });
      const next = structuredClone(content);
      next.content.requests[0].allocation.kind = "unknown";
      await queueSnapshots(directory, [next]);
      return Response.json({
        status: "accepted",
        revision: "1",
        receivedAt: new Date().toISOString(),
      });
    });
    await deliver();
    expect(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0])
        ?.revision,
    ).toBe("2");
  });
  it("bounds an unfinished response body and keeps the snapshot for retry", async () => {
    // The vitest suite used fake timers scoped to setTimeout/clearTimeout; the same determinism
    // comes from swapping the two globals (the delivery deadline is the only timer in flight)
    // and advancing a virtual clock, so the abort fires without waiting real seconds.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const realSetImmediate = globalThis.setImmediate;
    interface FakeTimer {
      id: number;
      at: number;
      run: () => void;
    }
    let virtualNow = 0;
    let nextTimerId = 1;
    const timers = new Map<number, FakeTimer>();
    const fakeSetTimeout = ((run: () => void, ms?: number) => {
      const entry: FakeTimer = { id: nextTimerId++, at: virtualNow + Math.max(0, ms ?? 0), run };
      timers.set(entry.id, entry);
      return { id: entry.id, unref() {}, ref() {} } as unknown as ReturnType<typeof realSetTimeout>;
    }) as typeof globalThis.setTimeout;
    const fakeClearTimeout = ((timer?: unknown) => {
      timers.delete((timer as { id?: number } | undefined)?.id ?? -1);
    }) as typeof globalThis.clearTimeout;
    const advance = async (ms: number) => {
      virtualNow += ms;
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.at <= virtualNow)
          .sort((a, b) => a.at - b.at);
        if (!due.length) return;
        for (const timer of due) {
          timers.delete(timer.id);
          timer.run();
          await new Promise<void>((resolve) => realSetImmediate(resolve));
        }
      }
    };
    const globals = globalThis as unknown as Record<"setTimeout" | "clearTimeout", unknown>;
    globals.setTimeout = fakeSetTimeout;
    globals.clearTimeout = fakeClearTimeout;
    try {
      http.mockImplementation(
        async (input: RequestInfo | URL): Promise<Response> =>
          String(input).endsWith("api-keys:verify")
            ? Response.json({ organizationId: org, userId: user })
            : new Response(new ReadableStream({ start() {} })),
      );
      const running = deliver();
      // Waiting for the two uploads must survive a loaded machine: the delivery's real chain
      // interleaves fs hops and lock retries with these immediate ticks, so a fixed spin count
      // starves while those waits are still pending. The wait is bounded by wall clock instead.
      const deadline = Date.now() + 8_000;
      while (http.mock.calls.length < 2 && Date.now() < deadline)
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      expect(http.mock.calls.length).toBe(2);
      await advance(5001);
      await running;
      expect(
        readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
      ).toBeDefined();
    } finally {
      globals.setTimeout = realSetTimeout;
      globals.clearTimeout = realClearTimeout;
    }
  }, 15_000);
  it("persists retry timing when the complete reporting pass times out during upload", async () => {
    await seedLinked();
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("api-keys:verify"))
          return Response.json({ organizationId: org, userId: user });
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      },
    );
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    const entry = Object.values((await readReportingState(directory)).entries)[0];
    const frozen = await pendingFrozenSnapshots(directory, () => {}, Date.now() + 5000);
    const timedOut = frozen.find(({ entry }) => entry.revision === "1")?.entry;
    expect(timedOut?.attempts).toBe(1);
    expect(timedOut?.retryAt).toBeGreaterThan(Date.now());
    expect(entry).toMatchObject({ revision: "1", attempts: 1 });
  }, 8000);
  it("persists before dispatch and sends the allowlisted body without user or account fields", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(init?.redirect).toBe("error");
        if (String(input).endsWith("api-keys:verify"))
          return Response.json({ organizationId: org, userId: user });
        const persisted = JSON.parse(
          await readFile(join(directory, "pr-cost-reporting", "state.json"), "utf8"),
        );
        expect(Object.values(persisted.entries)).toHaveLength(1);
        expect(String(input)).toBe(
          `https://api.example/ai-optimizer/v1beta/organizations/${org}/pr-cost-snapshots`,
        );
        const payload = JSON.parse(String(init?.body));
        expect(payload.requests).toHaveLength(1);
        expect(payload.userId).toBeUndefined();
        expect(payload.account).toBeUndefined();
        return Response.json({
          status: "accepted",
          revision: payload.revision,
          receivedAt: new Date().toISOString(),
        });
      },
    );
    await deliver();
    expect(http).toHaveBeenCalledTimes(2);
    expect(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    ).toBeUndefined();
  });
  each(["user", "organization", "key-during-verify", "endpoint-during-verify"])(
    "does not upload after %s changes",
    async (field) => {
      http.mockImplementation(async (): Promise<Response> => {
        if (field === "key-during-verify")
          credential = { token: "new-key", apiUrl: "https://api.example" };
        if (field === "endpoint-during-verify") endpoint = "https://other.example";
        return Response.json({
          organizationId: field === "organization" ? requestId : org,
          userId: field === "user" ? requestId : user,
        });
      });
      await deliver();
      expect(http).toHaveBeenCalledTimes(1);
      expect(
        readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
      ).toBeDefined();
    },
  );
  // The server rejected this body for its size; the queue halves it and retries, down to a floor.
  it("halves a body the server rejects with 413 and retries the trimmed replacement", async () => {
    // The replacement carries the queued snapshot's request, or the queue holds the old body.
    const requests = [
      content.content.requests[0],
      ...Array.from({ length: 39 }, (_, index) => ({
        requestId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        billingRecordIds: [],
        startedAt: "2026-10-04T12:00:00Z",
        allocation: { kind: "unlinked" as const, pullRequestIds: [], method: "native" as const },
      })),
    ];
    await queueSnapshots(directory, [
      {
        account: content.account,
        content: {
          repository: content.content.repository,
          pullRequests: [],
          requests,
          coverage: {
            observedRequests: requests.length,
            unpricedRequests: requests.length,
            historyComplete: true,
          },
        },
      },
    ]);
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status: 413 }),
    );
    const frozenBody = () => {
      const rows = backendFor(directory).readNotePage("legacy-pr-cost-snapshots", "", 100);
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0].body);
      return JSON.parse(parsed.body) as {
        requests: unknown[];
        coverage: { historyComplete: boolean; trimmedRequests?: number };
      };
    };
    await deliver();
    expect(frozenBody().requests.length).toBe(20);
    expect(frozenBody().coverage.historyComplete).toBe(false);
    expect(frozenBody().coverage.trimmedRequests).toBe(20);
    await deliver();
    expect(frozenBody().requests.length).toBe(16);
    // Trimmed requests accumulate across halvings, so the server sees the total omissions.
    expect(frozenBody().coverage.trimmedRequests).toBe(24);
    // At the floor the body cannot shrink further: the 413 is a settled refusal — the entry is
    // dead-lettered instead of deferred onto an ever-stretching retry clock.
    await deliver();
    const entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(entry.dead).toMatchObject({ status: 413, reason: "PR reporting returned HTTP 413" });
    expect(frozenBody().requests.length).toBe(16);
    // A settled body is never selected again: the next pass uploads nothing at all.
    http.mockClear();
    await deliver();
    expect(http).not.toHaveBeenCalled();
  });

  it("does not trim a queued body when the verify call itself rejects with 413", async () => {
    const requests = [
      content.content.requests[0],
      ...Array.from({ length: 39 }, (_, index) => ({
        requestId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        billingRecordIds: [],
        startedAt: "2026-10-04T12:00:00Z",
        allocation: { kind: "unlinked" as const, pullRequestIds: [], method: "native" as const },
      })),
    ];
    await queueSnapshots(directory, [
      {
        account: content.account,
        content: {
          repository: content.content.repository,
          pullRequests: [],
          requests,
          coverage: {
            observedRequests: requests.length,
            unpricedRequests: requests.length,
            historyComplete: true,
          },
        },
      },
    ]);
    // A misbehaving proxy rejects the verification itself; the upload was never attempted.
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? new Response(null, { status: 413 })
          : new Response(null, { status: 200 }),
    );
    await deliver();
    const rows = backendFor(directory).readNotePage("legacy-pr-cost-snapshots", "", 100);
    expect(rows).toHaveLength(1);
    const frozen = JSON.parse(rows[0].body) as { body: string };
    const parsed = JSON.parse(frozen.body) as {
      requests: unknown[];
      coverage: { historyComplete: boolean };
    };
    // Trimming is the remedy for a rejected body, so the verify rejection leaves it intact.
    expect(parsed.requests.length).toBe(40);
    expect(parsed.coverage.historyComplete).toBe(true);
    const entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(entry.lastError).toContain("413");
    expect(entry.retryAt).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("delivers the trimmed replacement after a 413 once the server accepts it", async () => {
    // The replacement carries the queued snapshot's request, or the queue holds the old body.
    const requests = [
      content.content.requests[0],
      ...Array.from({ length: 39 }, (_, index) => ({
        requestId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        billingRecordIds: [],
        startedAt: "2026-10-04T12:00:00Z",
        allocation: { kind: "unlinked" as const, pullRequestIds: [], method: "native" as const },
      })),
    ];
    await queueSnapshots(directory, [
      {
        account: content.account,
        content: {
          repository: content.content.repository,
          pullRequests: [],
          requests,
          coverage: {
            observedRequests: requests.length,
            unpricedRequests: requests.length,
            historyComplete: true,
          },
        },
      },
    ]);
    let rejected = true;
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : rejected
            ? new Response(null, { status: 413 })
            : Response.json({
                status: "accepted",
                revision: JSON.parse(String(init?.body)).revision,
                receivedAt: new Date().toISOString(),
              }),
    );
    await deliver();
    const trimmed = JSON.parse(
      backendFor(directory).readNotePage("legacy-pr-cost-snapshots", "", 100)[0].body,
    );
    const parsed = JSON.parse(trimmed.body);
    expect(parsed.requests.length).toBe(20);
    rejected = false;
    await deliver();
    const backend = backendFor(directory);
    expect(backend.readNotePage("legacy-pr-cost-snapshots", "", 100)).toHaveLength(0);
    expect(backend.readNotePage("legacy-pr-cost-snapshot-receipts", "", 100)).toHaveLength(1);
    const entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(readPendingBody(directory, entry)).toBeUndefined();
    // The trimmed ack keeps membership for the requests it left out, which the server retains.
    expect(entry.requestHashes).toHaveLength(40);
  });

  it("trims a body the server rejects with a snapshot byte limit and delivers the smaller one", async () => {
    const requests = [
      content.content.requests[0],
      ...Array.from({ length: 39 }, (_, index) => ({
        requestId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        billingRecordIds: [],
        startedAt: "2026-10-04T12:00:00Z",
        allocation: { kind: "unlinked" as const, pullRequestIds: [], method: "native" as const },
      })),
    ];
    await queueSnapshots(directory, [
      {
        account: content.account,
        content: {
          repository: content.content.repository,
          pullRequests: [],
          requests,
          coverage: {
            observedRequests: requests.length,
            unpricedRequests: 0,
            historyComplete: true,
          },
        },
      },
    ]);
    let rejected = true;
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("api-keys:verify"))
          return Response.json({ organizationId: org, userId: user });
        if (rejected)
          return Response.json(
            {
              code: 8,
              message: "PR cost reporting resource limit exceeded",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "PR_COST_LIMIT",
                  domain: "ai-optimizer",
                  metadata: {
                    scope: "snapshot",
                    limit: "bytes",
                    current: "16000",
                    maximum: "2048",
                  },
                },
              ],
            },
            { status: 429 },
          );
        return Response.json({
          status: "accepted",
          revision: JSON.parse(String(init?.body)).revision,
          receivedAt: new Date().toISOString(),
        });
      },
    );
    await deliver();
    // The learned cap replaced the body with one that fits the server's stated maximum.
    const rows = () => backendFor(directory).readNotePage("legacy-pr-cost-snapshots", "", 100);
    expect(rows()).toHaveLength(1);
    const envelope = JSON.parse(rows()[0].body);
    expect(Buffer.byteLength(envelope.body)).toBeLessThanOrEqual(2048);
    expect(JSON.parse(envelope.body).coverage.historyComplete).toBe(false);
    // The upload window settles, then the smaller body is accepted.
    const settled = Date.now() + 6 * 60_000;
    const clock = spyOn(Date, "now");
    clock.mockReturnValue(settled);
    rejected = false;
    await deliver();
    expect(backendFor(directory).readNotePage("legacy-pr-cost-snapshots", "", 100)).toHaveLength(0);
    expect(
      backendFor(directory).readNotePage("legacy-pr-cost-snapshot-receipts", "", 100),
    ).toHaveLength(1);
  });

  it("carries an account pause learned mid-pass into the pass-gate stamp input", async () => {
    // The pause is learned DURING delivery: the pass-start state snapshot the gate stamp reads
    // cannot contain it, so the delivery result must carry it back — otherwise sibling rows of
    // the paused account re-open the full pass on every tick until the pause thaws.
    await queueSnapshots(directory, [content]);
    http.mockImplementation(
      async (_input: RequestInfo | URL): Promise<Response> =>
        String(_input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : Response.json(
              {
                code: 8,
                message: "PR cost reporting resource limit exceeded",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason: "PR_COST_LIMIT",
                    domain: "ai-optimizer",
                    metadata: {
                      scope: "organization",
                      limit: "requests",
                      current: "40",
                      maximum: "20",
                    },
                  },
                ],
              },
              { status: 429 },
            ),
    );
    const result = await deliver();
    const key = accountKey(content.account);
    // The pause landed in the queue's durable map with its thaw deadline...
    await expect(readReportingState(directory)).resolves.toMatchObject({
      paused: { [key]: { retryAt: expect.any(Number) } },
    });
    // ...and the delivery result mirrors it for the stamp, with the same deadline.
    expect(result?.paused).toEqual([{ account: key, retryAt: expect.any(Number) }]);
    expect(result?.paused[0].retryAt).toBeGreaterThan(Date.now());
  });

  it("treats a body deleted mid-delivery as settled and continues the pass", async () => {
    await queueSnapshots(directory, [content]);
    let deleted = false;
    http.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith("api-keys:verify"))
        return Response.json({ organizationId: org, userId: user });
      if (!deleted) {
        // Another process caps this body away while its upload is in flight.
        const backend = backendFor(directory);
        for (const row of backend.readNotePage("legacy-pr-cost-snapshots", "", 100))
          backend.deleteNote("legacy-pr-cost-snapshots", row.name);
        deleted = true;
      }
      return new Response(null, { status: 413 });
    });
    await deliver();
    expect(deleted).toBe(true);
    const entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(entry.attempts).toBe(0);
    expect(entry.lastError).toBeUndefined();
  });

  it("persists Retry-After and does not retry before its deadline", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response("private response text", {
              status: 429,
              headers: { "Retry-After": "120" },
            }),
    );
    await deliver();
    const entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(entry.retryAt).toBeGreaterThan(Date.now() + 119000);
    expect(entry.lastError).not.toContain("private response");
    http.mockClear();
    await deliver();
    expect(http).not.toHaveBeenCalled();
  });
  // Other 4xx responses, such as an endpoint that is not deployed yet, cannot be fixed by retrying.
  each([400, 403])("backs off for hours after a permanent HTTP %s rejection", async (status) => {
    const random = spyOn(Math, "random");
    random.mockReturnValue(0.5);
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status }),
    );
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = Date.now();
      await deliver();
      const entry = Object.values((await readReportingState(directory)).entries)[0];
      delays.push(Math.round((entry.retryAt - before) / 60_000));
      const clock = spyOn(Date, "now");
      clock.mockReturnValue(entry.retryAt + 1);
    }
    expect(delays).toEqual([60, 120, 240, 360]);
  });
  each([
    [0, 48],
    [0.999, 72],
  ])(
    "spreads a rejection's retry by 20%% so rejected clients do not return together (random %s)",
    async (randomValue, minutes) => {
      const random = spyOn(Math, "random");
      random.mockReturnValue(randomValue);
      http.mockImplementation(
        async (input: RequestInfo | URL): Promise<Response> =>
          String(input).endsWith("api-keys:verify")
            ? Response.json({ organizationId: org, userId: user })
            : new Response(null, { status: 400 }),
      );
      const before = Date.now();
      await deliver();
      const entry = Object.values((await readReportingState(directory)).entries)[0];
      expect(Math.round((entry.retryAt - before) / 60_000)).toBe(minutes);
    },
  );
  it("settles a 410 upload rejection on the first refusal and never selects that body again", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status: 410 }),
    );
    await deliver();
    const settled = Object.values((await readReportingState(directory)).entries)[0];
    // The entry keeps its claims for the record, but retry bookkeeping stopped at the mark:
    // retryAt stays at zero, so only the dead-letter flag keeps it out of delivery.
    expect(settled.dead).toMatchObject({ status: 410, reason: "PR reporting returned HTTP 410" });
    expect(settled.retryAt).toBe(0);
    http.mockClear();
    await deliver();
    expect(http).not.toHaveBeenCalled();
  });

  it("defers a lone 404 through a server-skew window, then settles on the third spaced refusal", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status: 404 }),
    );
    await deliver();
    let entry = Object.values((await readReportingState(directory)).entries)[0];
    // One 404 can be an undeployed or rolled-back route while api-keys:verify still answers;
    // that recovers in minutes, so the first refusals defer like any other permanent 4xx.
    expect(entry.dead).toBeUndefined();
    expect(entry.retryAt).toBeGreaterThan(Date.now());
    let clock = spyOn(Date, "now");
    clock.mockReturnValue(entry.retryAt + 1);
    await deliver();
    entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(entry.dead).toBeUndefined();
    expect(entry.retryAt).toBeGreaterThan(Date.now() - 1);
    // The third spaced refusal is durable: the repository or organization is gone, so the body
    // settles instead of stretching its retry clock toward a year.
    clock = spyOn(Date, "now");
    clock.mockReturnValue(entry.retryAt + 1);
    await deliver();
    entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(entry.dead).toMatchObject({ status: 404, reason: "PR reporting returned HTTP 404" });
    // The settle mark replaces retry bookkeeping: the last defer's deadline stays recorded but
    // nothing is due again — the dead flag, not retryAt, keeps the body out of selection.
    expect(entry.dead?.at).toBeGreaterThan(0);
    clock.mockRestore();
    http.mockClear();
    await deliver();
    expect(http).not.toHaveBeenCalled();
  });

  it("never settles a lone 404 on the back of unrelated failures", async () => {
    // Two 500s defer like any transient failure; the 404 that follows is still this body's
    // FIRST spaced refusal. The old attempts-based rule settled it anyway — attempts counts
    // defers of every cause — so only a 404-specific counter may drive settlement.
    let call = 0;
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status: ++call <= 2 ? 500 : 404 }),
    );
    const endState = async () => Object.values((await readReportingState(directory)).entries)[0];
    // Jump past both the retry deadline and the five-minute upload window (a 500's ~30 s
    // backoff alone would still sit inside the window and skip the next attempt).
    const whenDue = (entry: { retryAt: number }) => entry.retryAt + 6 * 60_000;
    await deliver();
    let entry = await endState();
    expect(entry.dead).toBeUndefined();
    expect(entry.attempts).toBe(1);
    expect(entry.defer404s ?? 0).toBe(0);
    let clock = spyOn(Date, "now");
    clock.mockReturnValue(whenDue(entry));
    await deliver();
    entry = await endState();
    expect(entry.dead).toBeUndefined();
    expect(entry.attempts).toBe(2);
    expect(entry.defer404s ?? 0).toBe(0);
    clock = spyOn(Date, "now");
    clock.mockReturnValue(whenDue(entry));
    await deliver();
    // The third attempt answers 404, but it is this body's first spaced one: defer, not settle.
    entry = await endState();
    expect(entry.dead).toBeUndefined();
    expect(entry.defer404s).toBe(1);
    // Two more spaced 404s reach the third refusal and settle the body.
    clock = spyOn(Date, "now");
    clock.mockReturnValue(whenDue(entry));
    await deliver();
    entry = await endState();
    expect(entry.defer404s).toBe(2);
    clock = spyOn(Date, "now");
    clock.mockReturnValue(whenDue(entry));
    await deliver();
    expect((await endState()).dead).toMatchObject({ status: 404 });
    clock.mockRestore();
  });

  it("never counts verify-endpoint 404s toward the spaced-refusal settle rule", async () => {
    // The verify route answering 404 is not the snapshot route refusing this body: only an
    // attempted upload's 404 may push a body toward settlement. Two verify 404s followed by
    // one upload 404 must leave the body alive at defer404s = 1, not settled.
    let verifyFails = 2;
    http.mockImplementation(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith("api-keys:verify")) {
        if (verifyFails > 0) {
          verifyFails--;
          return new Response(null, { status: 404 });
        }
        return Response.json({ organizationId: org, userId: user });
      }
      return new Response(null, { status: 404 });
    });
    const endState = async () => Object.values((await readReportingState(directory)).entries)[0];
    const whenDue = (entry: { retryAt: number }) => entry.retryAt + 6 * 60_000;
    await deliver();
    let entry = await endState();
    expect(entry.dead).toBeUndefined();
    expect(entry.defer404s ?? 0).toBe(0);
    let clock = spyOn(Date, "now");
    clock.mockReturnValue(whenDue(entry));
    await deliver();
    entry = await endState();
    expect(entry.dead).toBeUndefined();
    expect(entry.defer404s ?? 0).toBe(0);
    clock = spyOn(Date, "now");
    clock.mockReturnValue(whenDue(entry));
    await deliver();
    // Verify now succeeds and the upload itself answers 404: the body's FIRST spaced refusal.
    entry = await endState();
    expect(entry.dead).toBeUndefined();
    expect(entry.defer404s).toBe(1);
    clock.mockRestore();
  });

  it("lets a fresh capture of the same repository start clean after its earlier body was settled", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status: 404 }),
    );
    // Settle the seed body first (third spaced 404), then recapture.
    const endState = async () => Object.values((await readReportingState(directory)).entries)[0];
    await deliver();
    let seed = await endState();
    expect(seed.dead).toBeUndefined();
    let clock = spyOn(Date, "now");
    clock.mockReturnValue(seed.retryAt + 1);
    await deliver();
    seed = await endState();
    clock = spyOn(Date, "now");
    clock.mockReturnValue(seed.retryAt + 1);
    await deliver();
    expect((await endState()).dead?.status).toBe(404);
    clock.mockRestore();
    // Fresh evidence for the same key starts a new lifecycle; the settled mark never follows it.
    await queueSnapshots(directory, [
      {
        account: content.account,
        content: {
          ...content.content,
          requests: [
            ...content.content.requests,
            {
              requestId: "44444444-4444-4444-8444-444444444444",
              billingRecordIds: [],
              startedAt: "2026-10-04T12:30:00Z",
              allocation: {
                kind: "unlinked" as const,
                pullRequestIds: [],
                method: "native" as const,
              },
            },
          ],
          coverage: { observedRequests: 2, unpricedRequests: 2, historyComplete: true },
        },
      },
    ]);
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : Response.json({
              status: "accepted",
              revision: JSON.parse(String(init?.body)).revision,
              receivedAt: new Date().toISOString(),
            }),
    );
    http.mockClear();
    await deliver();
    const entry = Object.values((await readReportingState(directory)).entries)[0];
    expect(entry.dead).toBeUndefined();
    expect(readPendingBody(directory, entry)).toBeUndefined();
    expect(entry.lastAcknowledgedAt).toBeDefined();
    // The settled frozen note is still on disk with its claims; its permanently-refused bytes
    // must never be uploaded again — only the fresh body (revision 2) may go out.
    const uploads = http.mock.calls
      .filter(([input]) => String(input).endsWith("/pr-cost-snapshots"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(uploads.map((body) => body.revision)).toEqual(["2"]);
  });

  each([408, 503])("keeps retrying HTTP %s within a minute", async (status) => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status }),
    );
    await deliver();
    expect(
      Object.values((await readReportingState(directory)).entries)[0].retryAt,
    ).toBeLessThanOrEqual(Date.now() + 60_000);
  });
  it("retries a 429 without a PR_COST_LIMIT detail like an outage, backing off with jitter", async () => {
    const random = spyOn(Math, "random");
    random.mockReturnValue(0.5);
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : Response.json({ code: 8, message: "busy" }, { status: 429 }),
    );
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = Date.now();
      await deliver();
      const entry = Object.values((await readReportingState(directory)).entries)[0];
      delays.push(Math.round((entry.retryAt - before) / 1000));
      // Past both the retry deadline and this repository's upload window.
      const clock = spyOn(Date, "now");
      clock.mockReturnValue(
        Math.max(entry.retryAt, (entry.uploadedAt ?? 0) + UPLOAD_INTERVAL_MS) + 1,
      );
    }
    expect(delays).toEqual([30, 60, 120, 240]);
    expect(Object.values((await readReportingState(directory)).entries)[0]).toMatchObject({
      attempts: 4,
      lastError: "PR reporting returned HTTP 429",
    });
    expect(Object.values((await readReportingState(directory)).entries)[0].limit).toBeUndefined();
  });
  it("bounds a Retry-After longer than six hours", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : new Response(null, { status: 503, headers: { "Retry-After": "172800" } }),
    );
    const before = Date.now();
    await deliver();
    const { retryAt } = Object.values((await readReportingState(directory)).entries)[0];
    expect(retryAt - before).toBeGreaterThanOrEqual(LIMIT_RETRY_MS);
    expect(retryAt - Date.now()).toBeLessThanOrEqual(LIMIT_RETRY_MS);
  });
  it("cancels an in-flight upload when another instance opts out and retains its payload", async () => {
    const pending = JSON.stringify(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    );
    let sent: (() => void) | undefined;
    const sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
    http.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("api-keys:verify"))
          return Response.json({ organizationId: org, userId: user });
        sent?.();
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      },
    );
    const running = deliver();
    await sending;
    await setReportingEnabled(directory, false);
    await running;
    const state = await readReportingState(directory);
    expect(JSON.stringify(readPendingBody(directory, Object.values(state.entries)[0]))).toBe(
      pending,
    );
    expect(Object.values(state.entries)[0].requestHashes).toHaveLength(1);
  });
  it("keeps a malformed acknowledgement pending and never records response content", async () => {
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : Response.json({
              status: "accepted",
              revision: "999",
              receivedAt: new Date().toISOString(),
              privateText: "secret",
            }),
    );
    await deliver();
    const state = await readReportingState(directory);
    expect(readPendingBody(directory, Object.values(state.entries)[0])).toBeDefined();
    expect(JSON.stringify(state)).not.toContain("secret");
  });
  it("explains a role that cannot upload and retries it slowly", async () => {
    http.mockImplementation(
      async (): Promise<Response> =>
        Response.json({ message: "permission denied" }, { status: 403 }),
    );
    const before = Date.now();
    await deliverSnapshots(directory, "/project", new AbortController().signal, () => {});
    const state = await readReportingState(directory);
    const [entry] = Object.values(state.entries);
    expect(entry.lastError).toBe(
      "PR reporting is not allowed for this API key: uploading PR costs needs an Owner or Member role (HTTP 403)",
    );
    expect(entry.retryAt - before).toBeGreaterThanOrEqual(0.8 * 60 * 60 * 1000);
  });
  it("still delivers when the opt-out poller cannot start", async () => {
    const watchFile = spyOn(fs, "watchFile");
    watchFile.mockImplementation(() => {
      throw Object.assign(new Error("stat watcher unavailable"), { code: "ENOSPC" });
    });
    respond(accepted);
    await deliverSnapshots(directory, "/project", new AbortController().signal, () => {});
    expect(posts()).toHaveLength(1);
    expect(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    ).toBeUndefined();
  });
  it("does not hold a directory watch during delivery", async () => {
    const watching = spyOn(fs, "watch");
    const polling = spyOn(fs, "watchFile");
    respond(accepted);
    await deliverSnapshots(directory, "/project", new AbortController().signal, () => {});
    expect(watching).not.toHaveBeenCalled();
    expect(polling).toHaveBeenCalledWith(
      expect.stringMatching(/pr-cost-reporting[\\/]state\.json$/),
      { persistent: false, interval: 250 },
      expect.any(Function),
    );
  });
  it("treats a record type this version does not know as incomplete history", async () => {
    await rm(join(directory, "pr-cost-reporting", "state.json"));
    await seedLinked();
    // A newer Kimchi sharing this history may write records this version cannot price or attribute.
    await writeFile(
      join(directory, "work-attribution", "newer.jsonl"),
      `${JSON.stringify({ version: 1, type: "future_record", workId: "55555555-5555-4555-8555-555555555555", sessionId: "newer", recordedAt: "2026-10-04T12:00:00.000Z" })}\n`,
    );
    respond(accepted);
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(posts()).toEqual([]);
    expect((await readReportingState(directory)).error).toContain(
      "could not capture a complete inventory",
    );
  });
  it("delivers the queued report but withdraws nothing when a ledger cannot be read", async () => {
    await mkdir(join(directory, "work-attribution"), { recursive: true });
    await writeFile(join(directory, "work-attribution", "source.jsonl"), "{broken\n");
    respond(accepted);
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    // The report queued from the last complete capture still goes out; the unreadable ledger queues nothing new.
    expect(posts().map((payload) => [payload.revision, payload.requests.length])).toEqual([
      ["1", 1],
    ]);
    expect((await readReportingState(directory)).error).toContain(
      "could not capture a complete inventory",
    );
  });
  it("still delivers queued snapshots whose larger replacements do not fit the local queue", async () => {
    const ids = new Map(
      ["51", "52", "53"].map((id) => [
        id,
        Array.from({ length: 32_000 }, () => crypto.randomUUID()),
      ]),
    );
    const full = (bills: number) =>
      [...ids].map(([repositoryId, requestIds]) => {
        const value = inventory(requestIds, repositoryId);
        for (const request of value.content.requests)
          request.billingRecordIds = Array.from({ length: bills }, () => crypto.randomUUID());
        return value;
      });
    await queueSnapshots(directory, [content, ...full(0)]);
    // Two bills per request make every replacement too large to queue beside the snapshots already waiting.
    expect((await queueSnapshots(directory, [content, ...full(2)])).error).toContain(
      "until queued reports leave room in the local queue",
    );
    respond(accepted);
    // A 24 MiB queue can outlast one 5-second pass on a slow CI runner; this checks for a stall, not speed.
    await deliverSnapshots(
      directory,
      "/project",
      new AbortController().signal,
      () => {},
      Date.now() + 50_000,
    );
    // Delivering what is already queued is what frees the room; nothing may stall it.
    expect(posts().map((payload) => [payload.repository.id, payload.revision])).toEqual([
      ["42", "1"],
      ["51", "1"],
      ["52", "1"],
    ]);
  }, 60_000);
});

const second = "55555555-5555-4555-8555-555555555551";
const third = "55555555-5555-4555-8555-555555555552";
const posts = () =>
  http.mock.calls
    .filter(([url]) => String(url).endsWith("/pr-cost-snapshots"))
    .map(([, init]): WireSnapshot => JSON.parse(String(init?.body)));
const respond = (reply: (payload: WireSnapshot) => Response) =>
  http.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      String(input).endsWith("api-keys:verify")
        ? Response.json({ organizationId: org, userId: user })
        : reply(JSON.parse(String(init?.body))),
  );
const accepted = (payload: WireSnapshot) =>
  Response.json({
    status: "accepted",
    revision: payload.revision,
    receivedAt: new Date().toISOString(),
  });
const inventory = (requestIds: string[], repositoryId = "42"): RepositorySnapshot => ({
  account: content.account,
  content: {
    ...content.content,
    repository: { ...content.content.repository, id: repositoryId },
    requests: requestIds.map((id) => ({ ...content.content.requests[0], requestId: id })),
    coverage: {
      observedRequests: requestIds.length,
      unpricedRequests: requestIds.length,
      historyComplete: true,
    },
  },
});
const entryFor = async (repositoryId: string) =>
  Object.values((await readReportingState(directory)).entries).find(
    (entry) => entry.repository.id === repositoryId,
  );

describe("upload window", () => {
  it("retains observed ordinary revisions during the five-minute window and then drains each", async () => {
    respond(accepted);
    await deliver();
    await queueSnapshots(directory, [inventory([requestId, second])]);
    await deliver();
    await queueSnapshots(directory, [inventory([requestId, second, third])]);
    await deliver();
    expect(posts().map((payload) => payload.revision)).toEqual(["1"]);
    const clock = spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + UPLOAD_INTERVAL_MS);
    await deliver();
    expect(posts().map((payload) => [payload.revision, payload.requests.length])).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 3],
    ]);
  });
  it("sends a PR opening at once inside the window", async () => {
    respond(accepted);
    await deliver();
    const linked = inventory([requestId]);
    linked.content.pullRequests = [
      { id: "101", number: 1, url: "https://github.com/example/repo/pull/1", state: "open" },
    ];
    linked.content.requests[0].allocation = {
      kind: "pull-request",
      pullRequestIds: ["101"],
      method: "native",
    };
    await queueSnapshots(directory, [linked]);
    await deliver();
    expect(posts().map((payload) => payload.revision)).toEqual(["1", "2"]);
  });
  it("sends the next snapshot at once after /pr-reporting on", async () => {
    respond(accepted);
    await deliver();
    await queueSnapshots(directory, [inventory([requestId, second])]);
    await deliver();
    expect(posts()).toHaveLength(1);
    await setReportingEnabled(directory, true);
    await deliver();
    expect(posts().map((payload) => payload.revision)).toEqual(["1", "2"]);
  });
});

const limitDetail = (scope: string, limit: string, current: string, maximum: string) => ({
  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
  reason: "PR_COST_LIMIT",
  domain: "ai-optimizer",
  metadata: { scope, limit, current, maximum },
});
const limited = (scope: string, limit: string, current: string, maximum: string) =>
  Response.json(
    {
      code: 8,
      message: "PR cost reporting resource limit exceeded",
      details: [limitDetail(scope, limit, current, maximum)],
    },
    { status: 429 },
  );

describe("server limits", () => {
  it("treats a producer limit as quota: about six hours on its own counter, while another repository uploads", async () => {
    const random = spyOn(Math, "random");
    random.mockReturnValue(0.5);
    await queueSnapshots(directory, [content, inventory([second], "43")]);
    respond((payload) =>
      payload.repository.id === "42"
        ? limited("producer", "repositories", "101", "100")
        : accepted(payload),
    );
    const before = Date.now();
    await deliver();
    const entry = await entryFor("42");
    expect(entry).toMatchObject({
      attempts: 0,
      limit: { scope: "producer", limit: "repositories", current: 101, maximum: 100 },
    });
    expect((entry?.retryAt ?? 0) - before).toBeGreaterThanOrEqual(LIMIT_RETRY_MS);
    expect((entry?.retryAt ?? 0) - Date.now()).toBeLessThanOrEqual(LIMIT_RETRY_MS);
    expect(readPendingBody(directory, await entryFor("43"))).toBeUndefined();
    const state = await readReportingState(directory);
    expect(JSON.stringify(state)).not.toContain("resource limit exceeded");
    // (The statusText wording of this limit stays asserted by Kimchi's own suite: status.ts is
    // unmoved TUI code. The state it renders is asserted above.)
    http.mockClear();
    await deliver();
    expect(posts()).toEqual([]);
  });
  each([
    ["organization", "this organization"],
    ["contributor", "your account in this organization"],
  ])(
    "pauses the whole account for a %s limit but still sends a withdrawal",
    async (scope, owner) => {
      await queueSnapshots(directory, [content, inventory([second], "43")]);
      respond((payload) =>
        payload.requests.length ? limited(scope, "requests", "50000", "50000") : accepted(payload),
      );
      await deliver();
      expect(posts()).toHaveLength(1);
      const state = await readReportingState(directory);
      expect(Object.values(state.paused ?? {})).toMatchObject([
        { limit: { scope, limit: "requests" } },
      ]);
      // (statusText's wording for the pause stays asserted by Kimchi's suite; the paused map it
      // renders is asserted above. The request moves to repository 43, so repository 42 is withdrawn.)
      void owner;
      http.mockClear();
      await queueSnapshots(directory, [inventory([second, requestId], "43")], true);
      await deliver();
      expect(posts().map((payload) => [payload.repository.id, payload.requests.length])).toEqual([
        ["42", 0],
      ]);
      expect((await readReportingState(directory)).paused).toBeDefined();
    },
  );
  it("does not pause the account for a limit the server reports only on queries", async () => {
    await queueSnapshots(directory, [content, inventory([second], "43")]);
    respond((payload) =>
      payload.repository.id === "42"
        ? limited("frozen", "reports", "250001", "250000")
        : accepted(payload),
    );
    await deliver();
    // Frozen totals never reject an upload; an unknown scope waits on this repository alone.
    const state = await readReportingState(directory);
    expect(state.paused).toBeUndefined();
    expect(await entryFor("42")).toMatchObject({ limit: { current: 250001, maximum: 250000 } });
    expect((await entryFor("42"))?.limit?.scope).toBeUndefined();
    expect(readPendingBody(directory, await entryFor("43"))).toBeUndefined();
  });
  it("retains a rejected legacy body at cutover and retries its exact bytes after the limit wait", async () => {
    await queueSnapshots(directory, [inventory([requestId, second])]);
    const original = JSON.stringify(
      readPendingBody(directory, Object.values((await readReportingState(directory)).entries)[0]),
    );
    let full = true;
    respond((payload) => (full ? limited("snapshot", "requests", "2", "1") : accepted(payload)));
    await deliver();
    const frozen = await pendingFrozenSnapshots(directory, () => {}, Date.now() + 5000);
    const rejected = frozen.find((row) => row.body === original);
    expect(rejected?.entry.limit).toMatchObject({ scope: "snapshot", limit: "requests" });
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(
      (await pendingFrozenSnapshots(directory, () => {}, Date.now() + 5000)).find(
        (row) => row.id === rejected?.id,
      )?.body,
    ).toBe(original);
    full = false;
    const clock = spyOn(Date, "now");
    clock.mockReturnValue((rejected?.entry.retryAt ?? 0) + LIMIT_RETRY_MS);
    await deliver();
    expect(
      http.mock.calls
        .filter(([url]) => String(url).endsWith("pr-cost-snapshots"))
        .some(([, init]) => init?.body === original),
    ).toBe(true);
  });
  it("retries an oversized 429 body as an outage without reading past 64 KiB", async () => {
    respond(
      () =>
        new Response(
          JSON.stringify({
            details: [limitDetail("organization", "bytes", "1", "1")],
            padding: "x".repeat(70 * 1024),
          }),
          { status: 429 },
        ),
    );
    await deliver();
    const entry = await entryFor("42");
    expect(entry).toMatchObject({ attempts: 1, lastError: "PR reporting returned HTTP 429" });
    expect(entry?.limit).toBeUndefined();
    expect((await readReportingState(directory)).paused).toBeUndefined();
    expect(entry?.retryAt).toBeLessThanOrEqual(Date.now() + 36_000);
  });
  it("reads only a PR_COST_LIMIT ErrorInfo from the ai-optimizer domain", () => {
    const detail = limitDetail("producer", "snapshots", "100", "100");
    expect(serverLimit({ details: [detail] }, 5)).toEqual({
      scope: "producer",
      limit: "snapshots",
      current: 100,
      maximum: 100,
      at: 5,
    });
    expect(
      serverLimit(
        { details: [limitDetail("snapshot", "windowedPullRequests", "2001", "2000")] },
        5,
      ),
    ).toEqual({
      scope: "snapshot",
      limit: "windowedPullRequests",
      current: 2001,
      maximum: 2000,
      at: 5,
    });
    expect(serverLimit({ details: [{ ...detail, domain: "elsewhere" }] }, 5)).toBeUndefined();
    expect(serverLimit({ details: [{ ...detail, reason: "QUOTA" }] }, 5)).toBeUndefined();
    expect(serverLimit({ code: 8, message: "busy" }, 5)).toBeUndefined();
    // Unknown values never reach durable state; the rejection still counts as a limit.
    expect(serverLimit({ details: [limitDetail("galaxy", "planets", "1.5", "-1")] }, 5)).toEqual({
      at: 5,
    });
  });
});

describe("repository identity for work without a PR", () => {
  each([
    ["unsupported", "This repository has no supported GitHub or GitLab remote.", true],
    ["retry", "GitHub lookup timed out. Kimchi will retry.", false],
  ])(
    "leaves other repositories complete only when a lookup fails as %s",
    async (kind, message, complete) => {
      await rm(join(directory, "pr-cost-reporting", "state.json"));
      await seedLinked();
      const path = join(directory, "work-attribution", "source.jsonl");
      const startedAt = new Date().toISOString();
      await writeFile(
        path,
        `${await readFile(path, "utf8")}${JSON.stringify({
          version: 1,
          type: "request",
          workId: "77777777-7777-4777-8777-777777777777",
          sessionId: "scratch-session",
          requestId: "66666666-6666-4666-8666-666666666666",
          startedAt,
          recordedAt: startedAt,
          scope: { account: content.account, repository: "/scratch/.git" },
        })}\n`,
      );
      lookupRepositoryIdentity.mockRejectedValue(new LookupError(message, kind));
      respond(accepted);
      await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
      const identities = buildEvents.mock.calls.at(-1)?.[2];
      expect(identities?.get("/scratch/.git")).toBe(complete ? "unsupported" : undefined);
      expect(posts()).toEqual([]);
    },
  );
  it("delivers a known repository while another lookup times out, then retries that lookup after cooldown", async () => {
    await seedLinked();
    const path = join(directory, "work-attribution", "source.jsonl");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      `${source}${JSON.stringify({
        version: 1,
        type: "request",
        workId: "77777777-7777-4777-8777-777777777777",
        sessionId: "other-session",
        requestId: "66666666-6666-4666-8666-666666666666",
        startedAt: "2026-10-04T12:00:00.000Z",
        recordedAt: "2026-10-04T12:00:00.000Z",
        scope: { account: content.account, repository: "/slow/.git" },
      })}\n`,
    );
    const lookup = lookupRepositoryIdentity;
    lookup.mockImplementation((path, signal) =>
      path === "/private/repo/.git"
        ? Promise.resolve({ ...content.content.repository, name: "example/repo" })
        : new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
    );
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(posts()).toHaveLength(1);
    await run();
    expect(lookup).toHaveBeenCalledTimes(2);
    // The group with the unresolved identity waits out its retry window before looking up again.
    const next = Date.now() + 5 * 60_000 + 1_000;
    const clock = spyOn(Date, "now");
    clock.mockReturnValue(next);
    lookup.mockResolvedValue({
      provider: "github",
      host: "github.com",
      name: "team/slow",
      id: "99",
    });
    await run();
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(buildEvents.mock.calls.at(-1)?.[2].get("/slow/.git")).toMatchObject({ id: "99" });
  });
  it("keeps a repository identity for a day, then refreshes it", async () => {
    await seedLinked();
    const path = join(directory, "work-attribution", "source.jsonl");
    const rows = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => JSON.parse(line).type !== "commit");
    await writeFile(path, `${rows.join("\n")}\n`);
    const lookup = lookupRepositoryIdentity;
    lookup.mockResolvedValue({
      provider: "github",
      host: "github.com",
      name: "team/first",
      id: "98",
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    await run();
    expect(lookup).toHaveBeenCalledTimes(1);
    const clock = spyOn(Date, "now");
    const start = Date.now();
    // Passes run every 30 seconds; an hour of them asks the provider nothing.
    clock.mockReturnValue(start + 60 * 60_000);
    await run();
    expect(lookup).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(start + 24 * 60 * 60_000);
    lookup.mockResolvedValue({
      provider: "github",
      host: "github.com",
      name: "team/moved",
      id: "99",
    });
    await run();
    // Unchanged work needs no identity; its next record rebuilds it with a fresh one.
    expect(lookup).toHaveBeenCalledTimes(1);
    const [first] = rows.map((line) => JSON.parse(line));
    await appendFile(
      path,
      `${JSON.stringify({ ...first, type: "work", recordedAt: new Date().toISOString() })}\n`,
    );
    await run();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it("queues pre-PR work from a dozen repositories without re-fetching each repository's identity every pass", async () => {
    await rm(join(directory, "pr-cost-reporting", "state.json"));
    const rows = Array.from({ length: 12 }, (_, index) => ({
      version: 1,
      type: "request",
      workId: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
      sessionId: `session-${index}`,
      requestId: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
      recordedAt: "2026-10-04T12:00:00.000Z",
      startedAt: "2026-10-04T12:00:00.000Z",
      scope: { account: content.account, repository: `/src/repo-${index}/.git` },
    }));
    await mkdir(join(directory, "work-attribution"), { recursive: true });
    await writeFile(
      join(directory, "work-attribution", "source.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    let lookups = 0;
    // A realistic lookup: Git remote read, CLI token lookup and one provider API round-trip.
    lookupRepositoryIdentity.mockImplementation(async (path) => {
      lookups++;
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        provider: "github",
        host: "github.com",
        name: `team/${path.split("/")[2]}`,
        id: String(1000 + Number(path.split("-")[1].split("/")[0])),
      };
    });
    for (let pass = 0; pass < 3; pass++)
      await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    const identities = buildEvents.mock.calls.flatMap(([, , repositories]) => [
      ...repositories.values(),
    ]);
    const queued = new Set(
      identities.flatMap((entry) =>
        entry !== "unsupported" && Number(entry.id) >= 1000 ? [entry.id] : [],
      ),
    );
    expect(queued.size).toBe(12);
    // One lookup per repository, plus at most one abandoned when a pass deadline interrupts it.
    expect(lookups).toBeLessThanOrEqual(13);
  }, 30_000);
});

describe("prelude stretching of a big group", () => {
  it("pages each work's records instead of materializing the whole work at once", async () => {
    await seedLinked();
    buildEvents.mockResolvedValue({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    const backend = backendFor(directory);
    const pagedRead = spyOn(backend, "readWorkRecordPage");
    const wholeRead = spyOn(backend, "readRecords");
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    // A second work with 300 records: the translation prelude must cross a 128-row page
    // boundary reading it, and must never fall back to the whole-work synchronous read.
    const source = join(directory, "work-attribution", "source.jsonl");
    const work = "65656565-6565-4565-8565-656565656565";
    let lines = "";
    for (let index = 0; index < 300; index++) {
      const hex = String(index).padStart(12, "0");
      lines += `${JSON.stringify({
        version: 1,
        type: "request",
        workId: work,
        sessionId: "records-only",
        requestId: `${hex.slice(0, 8)}-${hex.slice(8)}-4777-8777-${hex}`,
        startedAt: "2026-10-04T12:00:00.000Z",
        recordedAt: "2026-10-04T12:00:00.000Z",
        scope: { account: "10101010-1010-4101-8101-101010101010", repository: "/other/.git" },
      })}\n`;
    }
    await appendFile(source, lines);
    await run();
    // The paged per-work read ran, capped at 128 rows a page...
    expect(pagedRead.mock.calls.length).toBeGreaterThan(0);
    for (const call of pagedRead.mock.calls) expect(call[3]).toBe(128);
    // ...and crossed a boundary for the 300-record work (at least 3 pages).
    // (The projection rebuild still reads whole works synchronously inside its
    // transaction — a separate, out-of-scope path.)
    const pagesForBigWork = pagedRead.mock.calls.filter((call) => call[0] === work);
    expect(pagesForBigWork.length).toBeGreaterThanOrEqual(3);
    pagedRead.mockRestore();
    wholeRead.mockRestore();
  });

  it("the cost report shares the prelude's stretcher with the event translation", async () => {
    await seedLinked();
    buildEvents.mockResolvedValue({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    // A second work with records only: its pending translation drives the reporting
    // prelude through the paged read and the cost report call.
    const source = join(directory, "work-attribution", "source.jsonl");
    const work = "75757575-7575-4575-8575-757575757575";
    let lines = "";
    for (let index = 0; index < 3; index++) {
      const hex = String(index).padStart(12, "0");
      lines += `${JSON.stringify({
        version: 1,
        type: "request",
        workId: work,
        sessionId: "records-only",
        requestId: `${hex.slice(0, 8)}-${hex.slice(8)}-4777-8777-${hex}`,
        startedAt: "2026-10-04T12:00:00.000Z",
        recordedAt: "2026-10-04T12:00:00.000Z",
        scope: { account: "10101010-1010-4101-8101-101010101010", repository: "/other/.git" },
      })}\n`;
    }
    await appendFile(source, lines);
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    const reportStretch = readWorkCostReportAsync.mock.calls.at(-1)?.[1] as
      | (() => Promise<void>)
      | undefined;
    // The translation's stretcher is buildEvents' last parameter.
    const eventsStretch = buildEvents.mock.calls.at(-1)?.at(-1) as
      | (() => Promise<void>)
      | undefined;
    expect(typeof reportStretch).toBe("function");
    expect(reportStretch).toBe(eventsStretch);
  });

  it("crossing the row budget yields in the prelude's read and parse loops", async () => {
    await seedLinked();
    buildEvents.mockResolvedValue({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    const calls = () => setImmediateCalls();
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    calls();
    // Two structurally identical passes, each introducing exactly one new marker batch for the same
    // work: a 1-row pass, then a 2,000-row pass. The 2,001 rows total cross the shared row budget
    // and the pass machinery fires the same immediates in both phases: with identical surroundings,
    // at least two extra immediates appear only because the stretcher parked the loop somewhere in
    // the read and parse walks — a directional binding, since the floor can't see WHICH loop each
    // yield came from (loop-level floors live in events.test and links.test).
    const source = join(directory, "work-attribution", "source.jsonl");
    const work = "65656565-6565-4565-8565-656565656565";
    const rows = (count: number, offset: number) => {
      let lines = "";
      for (let index = offset; index < offset + count; index++) {
        const hex = String(index).padStart(12, "0");
        lines += `${JSON.stringify({
          version: 1,
          type: "request",
          workId: work,
          sessionId: "records-only",
          requestId: `${hex.slice(0, 8)}-${hex.slice(8)}-4777-8777-${hex}`,
          startedAt: "2026-10-04T12:00:00.000Z",
          recordedAt: "2026-10-04T12:00:00.000Z",
          scope: { account: content.account, repository: "/other/.git" },
        })}\n`;
      }
      return lines;
    };
    await appendFile(source, rows(1, 0));
    await run();
    const small = calls();
    await appendFile(source, rows(2_000, 1));
    await run();
    expect(calls()).toBeGreaterThanOrEqual(small + 2);
  });
});

describe("prelude stretch", () => {
  /** A stretch call that yields runs every already-scheduled macrotask first; a fast one leaves them parked. */
  const yielded = async (stretch: () => Promise<void>) => {
    let ran = false;
    const timer = setImmediate(() => {
      ran = true;
    });
    try {
      await stretch();
    } finally {
      clearImmediate(timer);
    }
    return ran;
  };

  it("yields after the row budget, and after the time budget even for few rows", async () => {
    const stretch = preludeStretch(2, 60_000);
    expect(await yielded(stretch)).toBe(false);
    expect(await yielded(stretch)).toBe(true);
    expect(await yielded(stretch)).toBe(false);

    const slow = preludeStretch(10_000, 60_000);
    const clock = spyOn(Date, "now");
    try {
      // One row but the stretch has already owned the loop past its time budget.
      clock.mockReturnValue(Date.now() + 60_001);
      expect(await yielded(slow)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("incremental translation", () => {
  it("commits events in chunks, so a pass that runs out of time resumes where it stopped", async () => {
    await seedLinked();
    const account = accountKey(content.account);
    const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`);
    const facts = entities.map((entityId) => ({
      entityId,
      source: "kimchi",
      sourceVersion: "test",
      deviceId: requestId,
      observeTime: "2026-10-04T12:00:00Z",
      coverage: { code: "fixture", count: "1" },
    }));
    buildEvents.mockResolvedValue({
      accounts: [{ account: content.account, facts, recordHashes: [] }],
      units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
      unresolved: [],
    });
    const clock = spyOn(Date, "now");
    const start = Date.now();
    // The first chunk leaves the pass without time for another.
    observeEvents.mockImplementationOnce(() => {
      clock.mockReturnValue(start + 4_800);
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    const observed = () =>
      observeEvents.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId));
    expect(observed()).toEqual(entities.slice(0, 100));
    expect(backendFor(directory).markedRecords()).not.toEqual([]);
    expect((await readReportingState(directory)).error).toBeUndefined();
    clock.mockRestore();
    await run();
    expect(observed()).toEqual(entities);
    expect(backendFor(directory).markedRecords()).toEqual([]);
  });

  it("a pass over an unresolvable group skips its full rebuild while inputs stand still", async () => {
    await seedLinked();
    buildEvents.mockResolvedValue({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    // Identical markers: no retranslation until the retry window passes — the stall the user feels.
    await run();
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    // New evidence flips the signature: the input stands still rule does not hide it.
    const path = join(directory, "work-attribution", "source.jsonl");
    await appendFile(
      path,
      `${JSON.stringify({ version: 1, workId: "55555555-5555-4555-8555-555555555555", sessionId: "private-session", type: "work", recordedAt: new Date().toISOString() })}\n`,
    );
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(2);
  });

  it("a persistently unsettled group retries only after the stalled window passes", async () => {
    await seedLinked();
    // An identity lookup that keeps failing leaves the group's markers in place, so the pass runs again —
    // but the full rebuild waits out the window while the identical inputs produce the identical outcome.
    lookupRepositoryIdentity.mockRejectedValue(new LookupError("offline", "retry"));
    buildEvents.mockResolvedValue({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    expect(backendFor(directory).markedRecords().length).toBeGreaterThan(0);
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000);
      await run();
      expect(buildEvents).toHaveBeenCalledTimes(2);
      // The window restarts from the retry, so the next pass waits again — it does not revert to re-running
      // the identical group on every tick.
      await run();
      expect(buildEvents).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(Date.now() + 10 * 60_000 + 2_000);
      await run();
    } finally {
      clock.mockRestore();
    }
    expect(buildEvents).toHaveBeenCalledTimes(3);
  });

  it("a corrupt stalled note discards the windows rather than freezing every pass", async () => {
    await seedLinked();
    lookupRepositoryIdentity.mockRejectedValue(new LookupError("offline", "retry"));
    buildEvents.mockResolvedValue({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    backendFor(directory).putNote("agent", "translation-stalled", "{corrupt");
    // The note reads as absent: the group retries at the next window and the windows start fresh.
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000);
      await run();
      expect(buildEvents).toHaveBeenCalledTimes(2);
      // The group still reports its own waiting state; a corrupt note never becomes a capture failure.
      expect((await readReportingState(directory)).error).toBe(
        "Some PR cost events are waiting for complete original evidence or a repository identity",
      );
      clock.mockReturnValue(Date.now() + 30_000);
      await run();
    } finally {
      clock.mockRestore();
    }
    expect(buildEvents).toHaveBeenCalledTimes(2);
  });

  it("a stalled window stamped far into the future is pruned, not a lock-out", async () => {
    await seedLinked();
    lookupRepositoryIdentity.mockRejectedValue(new LookupError("offline", "retry"));
    buildEvents.mockResolvedValue({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    const backend = backendFor(directory);
    const body = backend.getNote("agent", "translation-stalled");
    if (!body) throw new Error("the first unresolved attempt stamps a window");
    const windows: Record<string, { at: number }> = JSON.parse(body);
    for (const key of Object.keys(windows))
      windows[key] = { at: Date.now() + 365 * 24 * 3_600_000 };
    backend.putNote("agent", "translation-stalled", JSON.stringify(windows));
    const clock = spyOn(Date, "now");
    try {
      // Still impossibly far ahead after the window: the entry is invalid on its face, not waiting.
      clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000);
      await run();
    } finally {
      clock.mockRestore();
    }
    expect(buildEvents).toHaveBeenCalledTimes(2);
  });

  it("a group whose repository identity stays unknown waits out the retry window instead of rebuilding each pass", async () => {
    await seedLinked();
    lookupRepositoryIdentity.mockRejectedValue(new LookupError("offline", "retry"));
    buildEvents.mockResolvedValue({ accounts: [], units: [], unresolved: [] });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    const clock = spyOn(Date, "now");
    const start = Date.now();
    try {
      // The next 30 s tick, past the lookup cooldown: the unchanged group does not re-pay its prelude.
      clock.mockReturnValue(start + 31_000);
      await run();
      expect(buildEvents).toHaveBeenCalledTimes(1);
      // The group reports that it waits, not a capture failure.
      expect((await readReportingState(directory)).error).toBe(
        "Some PR cost events are waiting for complete original evidence or a repository identity",
      );
      clock.mockReturnValue(start + 5 * 60_000 + 1_000);
      await run();
      expect(buildEvents).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
    // Unsettled identities keep the markers for a later round.
    expect(backendFor(directory).markedRecords()).not.toEqual([]);
  });

  it("a later attempt that resolves the group lifts its stalled window", async () => {
    await seedLinked();
    const lookup = lookupRepositoryIdentity;
    lookup.mockRejectedValue(new LookupError("offline", "retry"));
    buildEvents.mockResolvedValueOnce({
      accounts: [],
      units: [],
      unresolved: [{ requestId, reason: "billing", recordHashes: [] }],
    });
    buildEvents.mockResolvedValue({ accounts: [], units: [], unresolved: [] });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    const backend = backendFor(directory);
    const stamped = backend.getNote("agent", "translation-stalled");
    expect(Object.keys(JSON.parse(stamped ?? "{}"))).toHaveLength(1);
    lookup.mockResolvedValue({
      provider: "github",
      host: "github.com",
      name: "example/repo",
      id: "42",
    });
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(Date.now() + 5 * 60_000 + 1_000);
      await run();
    } finally {
      clock.mockRestore();
    }
    expect(buildEvents).toHaveBeenCalledTimes(2);
    // Resolved groups leave no window behind: the next pass is free to run them again.
    expect(
      Object.keys(JSON.parse(backend.getNote("agent", "translation-stalled") ?? "{}")),
    ).toHaveLength(0);
  });

  each(["damaged elements", "missing facts"])(
    "a plan for a suspended pass with %s falls back to a full rebuild",
    async (kind) => {
      await seedLinked();
      const account = accountKey(content.account);
      const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`);
      const facts = entities.map((entityId) => ({
        entityId,
        source: "kimchi",
        sourceVersion: "test",
        deviceId: requestId,
        observeTime: "2026-10-04T12:00:00Z",
        coverage: { code: "fixture", count: "1" },
      }));
      buildEvents.mockResolvedValue({
        accounts: [{ account: content.account, facts, recordHashes: [] }],
        units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
        unresolved: [],
      });
      const clock = spyOn(Date, "now");
      const start = Date.now();
      // The first chunk leaves the pass without time for another: the notes suspend the group mid-way.
      observeEvents.mockImplementationOnce(() => {
        clock.mockReturnValue(start + 4_800);
      });
      const run = () =>
        reconcileReporting(directory, "/project", new AbortController().signal, () => {});
      await run();
      clock.mockRestore();
      const backend = backendFor(directory);
      const observed = () =>
        observeEvents.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId));
      expect(observed()).toEqual(entities.slice(0, 100));
      // Storage damage that still parses: units of null, or facts emptied so replaying the plan would
      // commit nothing and still clear the markers.
      const plan = JSON.parse(backend.getNote("agent", "translation-plan") ?? "{}") as {
        units?: unknown;
        accounts: { facts: unknown[] }[];
      };
      if (kind === "damaged elements") plan.units = [null];
      else for (const group of plan.accounts) group.facts = [];
      backend.putNote("agent", "translation-plan", JSON.stringify(plan));
      // The corrupt plan rebuilds instead of substituting: the prelude re-runs and every entity commits.
      buildEvents.mockClear();
      await run();
      expect(buildEvents).toHaveBeenCalledTimes(1);
      expect(observed()).toEqual(expect.arrayContaining(entities));
      expect(backend.markedRecords()).toEqual([]);
    },
  );

  it("a progress count beyond its plan's units rebuilds the plan instead of retiring the group", async () => {
    await seedLinked();
    const account = accountKey(content.account);
    const entities = Array.from({ length: 150 }, (_, index) => `entity-${index}`);
    const facts = entities.map((entityId) => ({
      entityId,
      source: "kimchi",
      sourceVersion: "test",
      deviceId: requestId,
      observeTime: "2026-10-04T12:00:00Z",
      coverage: { code: "fixture", count: "1" },
    }));
    buildEvents.mockResolvedValue({
      accounts: [{ account: content.account, facts, recordHashes: [] }],
      units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
      unresolved: [],
    });
    const clock = spyOn(Date, "now");
    const start = Date.now();
    observeEvents.mockImplementationOnce(() => {
      clock.mockReturnValue(start + 4_800);
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    clock.mockRestore();
    const backend = backendFor(directory);
    const progress = JSON.parse(backend.getNote("agent", "translation-progress") ?? "{}") as Record<
      string,
      unknown
    >;
    // A count beyond the plan's units would skip the loop and clear the markers without committing a fact.
    progress.units = 999_999;
    backend.putNote("agent", "translation-progress", JSON.stringify(progress));
    await run();
    const observed = observeEvents.mock.calls.flatMap(([, , list]) =>
      list.map((fact) => fact.entityId),
    );
    expect(buildEvents).toHaveBeenCalledTimes(2);
    expect(observed).toEqual(expect.arrayContaining(entities));
    expect(backend.markedRecords()).toEqual([]);
  });

  it("a pass that runs out of time during a big group resumes after the prelude, without rebuilding it", async () => {
    await seedLinked();
    const account = accountKey(content.account);
    const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`);
    const facts = entities.map((entityId) => ({
      entityId,
      source: "kimchi",
      sourceVersion: "test",
      deviceId: requestId,
      observeTime: "2026-10-04T12:00:00Z",
      coverage: { code: "fixture", count: "1" },
    }));
    buildEvents.mockResolvedValue({
      accounts: [{ account: content.account, facts, recordHashes: [] }],
      units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
      unresolved: [],
    });
    const clock = spyOn(Date, "now");
    const start = Date.now();
    observeEvents.mockImplementationOnce(() => {
      clock.mockReturnValue(start + 4_800);
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    clock.mockRestore();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    await run();
    // The plan carried over: the resume does NOT re-run the prelude — one build across both passes.
    expect(buildEvents).toHaveBeenCalledTimes(1);
    const observed = () =>
      observeEvents.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId));
    expect(observed()).toEqual(entities);
    expect(backendFor(directory).markedRecords()).toEqual([]);
  });

  it("a suspended group resumes its plan when records arrive between passes, and leaves only them marked", async () => {
    await seedLinked();
    const account = accountKey(content.account);
    const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`);
    const facts = entities.map((entityId) => ({
      entityId,
      source: "kimchi",
      sourceVersion: "test",
      deviceId: requestId,
      observeTime: "2026-10-04T12:00:00Z",
      coverage: { code: "fixture", count: "1" },
    }));
    buildEvents.mockResolvedValue({
      accounts: [{ account: content.account, facts, recordHashes: [] }],
      units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
      unresolved: [],
    });
    const clock = spyOn(Date, "now");
    const start = Date.now();
    observeEvents.mockImplementationOnce(() => {
      clock.mockReturnValue(start + 4_800);
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    clock.mockRestore();
    const backend = backendFor(directory);
    const before = new Set(backend.markedRecords().map((row) => row.recordHash));
    // A live session appends to the same work while the group is suspended: a new marker joins the group.
    await appendFile(
      join(directory, "work-attribution", "source.jsonl"),
      `${JSON.stringify({
        version: 1,
        type: "request",
        workId: "55555555-5555-4555-8555-555555555555",
        sessionId: "private-session",
        recordedAt: "2026-10-04T12:05:00.000Z",
        requestId: "66666666-6666-4666-8666-666666666666",
        startedAt: "2026-10-04T12:05:00.000Z",
        scope: { account: content.account, repository: "/private/repo/.git" },
      })}\n`,
    );
    await run();
    // The plan carried over despite the new record: one build, every planned entity committed.
    expect(buildEvents).toHaveBeenCalledTimes(1);
    const observed = () =>
      observeEvents.mock.calls.flatMap(([, , list]) => list.map((fact) => fact.entityId));
    expect(observed()).toEqual(entities);
    // Only the planned markers cleared; the record captured after the plan waits for its own round.
    const left = backend.markedRecords();
    expect(left).toHaveLength(1);
    expect(before.has(left[0].recordHash)).toBe(false);
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(2);
    expect(backend.markedRecords()).toEqual([]);
  });

  it("a suspended plan is rebuilt when a marker it covers is no longer pending", async () => {
    await seedLinked();
    const account = accountKey(content.account);
    const entities = Array.from({ length: 250 }, (_, index) => `entity-${index}`);
    buildEvents.mockResolvedValue({
      accounts: [
        {
          account: content.account,
          facts: entities.map((entityId) => ({
            entityId,
            source: "kimchi",
            sourceVersion: "test",
            deviceId: requestId,
            observeTime: "2026-10-04T12:00:00Z",
            coverage: { code: "fixture", count: "1" },
          })),
          recordHashes: [],
        },
      ],
      units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
      unresolved: [],
    });
    const clock = spyOn(Date, "now");
    const start = Date.now();
    observeEvents.mockImplementationOnce(() => {
      clock.mockReturnValue(start + 4_800);
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    clock.mockRestore();
    const backend = backendFor(directory);
    // Another process finished one of the plan's records in between: the plan no longer describes pending work.
    const [first] = backend.markedRecords();
    backend.tx(() => backend.clearTranslation(first.recordHash));
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(2);
    expect(backend.markedRecords()).toEqual([]);
  });

  it("a plan whose construction outlasts the pass is saved and resumed, not rebuilt every pass", async () => {
    await seedLinked();
    const account = accountKey(content.account);
    const entities = Array.from({ length: 150 }, (_, index) => `entity-${index}`);
    const built = {
      accounts: [
        {
          account: content.account,
          facts: entities.map((entityId) => ({
            entityId,
            source: "kimchi",
            sourceVersion: "test",
            deviceId: requestId,
            observeTime: "2026-10-04T12:00:00Z",
            coverage: { code: "fixture", count: "1" },
          })),
          recordHashes: [],
        },
      ],
      units: entities.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
      unresolved: [],
    };
    const clock = spyOn(Date, "now");
    const start = Date.now();
    // A large group's read, report and event build take longer than one 5 s pass.
    buildEvents.mockImplementation(async () => {
      clock.mockReturnValue(start + 6_000);
      return built;
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    clock.mockRestore();
    const backend = backendFor(directory);
    // The finished prelude is kept even though the pass had no time left to commit a chunk.
    expect(backend.getNote("agent", "translation-plan")).toBeDefined();
    expect((await readReportingState(directory)).error).toBeUndefined();
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    const observed = observeEvents.mock.calls.flatMap(([, , list]) =>
      list.map((fact) => fact.entityId),
    );
    expect(observed).toEqual(entities);
    expect(backend.markedRecords()).toEqual([]);
  });

  it("the suspended group resumes before another changed group can take over the plan slot", async () => {
    await seedLinked();
    const big = "55555555-5555-4555-8555-555555555555";
    const small = "11111111-1111-4111-8111-111111111111";
    const smallRequest = (index: number) => ({
      version: 1,
      type: "request",
      workId: small,
      sessionId: "other-session",
      recordedAt: `2026-10-04T12:0${index}:00.000Z`,
      requestId: `7777777${index}-7777-4777-8777-777777777777`,
      startedAt: `2026-10-04T12:0${index}:00.000Z`,
      scope: { account: content.account, repository: "/private/repo/.git" },
    });
    const journal = join(directory, "work-attribution", "source.jsonl");
    await appendFile(journal, `${JSON.stringify(smallRequest(1))}\n`);
    const account = accountKey(content.account);
    const fixture = (prefix: string, count: number) => {
      const ids = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
      return {
        ids,
        built: {
          accounts: [
            {
              account: content.account,
              facts: ids.map((entityId) => ({
                entityId,
                source: "kimchi",
                sourceVersion: "test",
                deviceId: requestId,
                observeTime: "2026-10-04T12:00:00Z",
                coverage: { code: "fixture", count: "1" },
              })),
              recordHashes: [],
            },
          ],
          units: ids.map((entity) => ({ account, entities: [entity], recordHashes: [] })),
          unresolved: [],
        },
      };
    };
    const bigGroup = fixture("big", 250);
    const smallGroup = fixture("small", 1);
    const ofBig = (stored: readonly { workId: string }[]) =>
      stored.some((row) => row.workId === big);
    buildEvents.mockImplementation(async (stored) =>
      ofBig(stored) ? bigGroup.built : smallGroup.built,
    );
    const clock = spyOn(Date, "now");
    const start = Date.now();
    // The small group (first by work id) completes; the big group's first chunk then exhausts the pass.
    observeEvents.mockImplementation((_dir, _account, list) => {
      if (list[0]?.entityId === "big-0") clock.mockReturnValue(start + 4_800);
    });
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    clock.mockRestore();
    const bigBuilds = () => buildEvents.mock.calls.filter(([stored]) => ofBig(stored)).length;
    expect(bigBuilds()).toBe(1);
    // The small group changes again while the big one is suspended.
    await appendFile(journal, `${JSON.stringify(smallRequest(2))}\n`);
    await run();
    // The big group resumed its plan instead of losing the slot to the small group's rebuild.
    expect(bigBuilds()).toBe(1);
    const observed = observeEvents.mock.calls.flatMap(([, , list]) =>
      list.map((fact) => fact.entityId),
    );
    expect(observed).toEqual(expect.arrayContaining(bigGroup.ids));
    expect(backendFor(directory).markedRecords()).toEqual([]);
  });

  it("drives event translation with the stretcher the prelude uses", async () => {
    await seedLinked();
    respond(accepted);
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    const call = buildEvents.mock.calls.at(-1);
    expect(call?.[7]).toBeTypeOf("function");
    // Identity, not just presence: the captured fn must carry the prelude budget — after 2_000
    // rows it must park the loop for real (a no-op stretch would never let this tick fire).
    const stretch = call?.[7] as () => Promise<void>;
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    for (let index = 0; index < 2_001; index++) await stretch();
    expect(ticked).toBe(true);
  });

  it("rebuilds only the group of works whose records changed", async () => {
    await seedLinked();
    const path = join(directory, "work-attribution", "source.jsonl");
    const other = {
      version: 1,
      workId: "66666666-6666-4666-8666-666666666666",
      sessionId: "other-session",
    };
    await appendFile(
      path,
      `${JSON.stringify({ ...other, type: "request", requestId: "77777777-7777-4777-8777-777777777777", startedAt: "2026-10-04T12:00:00.000Z", recordedAt: "2026-10-04T12:00:00.000Z", scope: { account: content.account, repository: "/other/.git" } })}\n`,
    );
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(2);
    buildEvents.mockClear();
    await appendFile(
      path,
      `${JSON.stringify({ ...other, type: "work", recordedAt: new Date().toISOString() })}\n`,
    );
    await run();
    expect(buildEvents).toHaveBeenCalledTimes(1);
    const [stored] = buildEvents.mock.calls[0];
    expect(new Set(stored.map((row) => JSON.parse(row.body).workId))).toEqual(
      new Set([other.workId]),
    );
  });
});

describe("idle reporting passes", () => {
  it("performs no journal body reads on an unchanged idle pass", async () => {
    await seedLinked();
    const settled = new Date(Date.now() - 60_000);
    fs.utimesSync(join(directory, "work-attribution", "source.jsonl"), settled, settled);
    respond(accepted);
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    await run();
    const reads = spyOn(fs, "readSync");
    await run();
    expect(reads).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
  });

  each(["new", "unknown"])(
    "drains a duplicate-only window before judging %s trailing evidence",
    async (kind) => {
      await seedLinked();
      respond(accepted);
      const run = () =>
        reconcileReporting(directory, "/project", new AbortController().signal, () => {});
      await run();
      await run();
      const path = join(directory, "work-attribution", "source.jsonl");
      const duplicate = `${(await readFile(path, "utf8")).split("\n")[0]}\n`;
      const duplicates = duplicate.repeat(
        Math.ceil((512 * 1024) / Buffer.byteLength(duplicate)) + 2,
      );
      expect(Buffer.byteLength(duplicates)).toBeGreaterThan(512 * 1024);
      const tail = {
        version: 1 as const,
        type: (kind === "new" ? "request" : "future_retraction") as WorkRecord["type"],
        workId: "55555555-5555-4555-8555-555555555555",
        sessionId: "private-session",
        requestId: "66666666-6666-4666-8666-666666666666",
        scope: null,
      };
      await appendFile(path, `${duplicates}${JSON.stringify(tail)}\n`);
      // The vitest suite installed its spy here, after the two settling passes; the port clears
      // the passthrough mock's call log at the same point so the counts mean the same thing.
      calculatePullRequestCostsAsync.mockClear();
      await run();
      if (kind === "new") {
        expect(readRecords(directory)).toContainEqual(tail);
        expect(calculatePullRequestCostsAsync).toHaveBeenCalledTimes(1);
      } else {
        const problems: WorkRecordProblem[] = [];
        reportJournalProblems(directory, (problem) => problems.push(problem));
        expect(problems).toContainEqual(
          expect.objectContaining({ kind: "unknown-type", record: tail }),
        );
        expect(calculatePullRequestCostsAsync).not.toHaveBeenCalled();
        expect((await readReportingState(directory)).error).toContain("complete inventory");
      }
      expect(posts()).toHaveLength(1);
    },
  );

  it("rechecks changed legacy input after a recoverable torn append", async () => {
    await seedLinked();
    respond(accepted);
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    await run();
    const path = join(directory, "work-attribution", "source.jsonl");
    const valid = (await readFile(path, "utf8")).split("\n")[0];
    await appendFile(path, '{"type":"request"\n');
    // The vitest suite installed its spy after the two settling passes.
    calculatePullRequestCostsAsync.mockClear();
    await run();
    expect(calculatePullRequestCostsAsync).not.toHaveBeenCalled();
    expect((await readReportingState(directory)).error).toContain("complete inventory");
    await appendFile(
      path,
      `${JSON.stringify({ ...JSON.parse(valid), recordedAt: new Date().toISOString() })}\n`,
    );
    await run();
    expect(calculatePullRequestCostsAsync).toHaveBeenCalledTimes(1);
    expect((await readReportingState(directory)).error).toBeUndefined();
    const problems: unknown[] = [];
    reportJournalProblems(directory, (problem) => problems.push(problem));
    expect(problems).toEqual([]);
    expect(posts()).toHaveLength(1);
  });

  it("skips unchanged passes, reads journals in the background and translates only new records", async () => {
    await seedLinked();
    respond(accepted);
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    await run();
    // The vitest suite installed both spies here, after the two settling passes.
    calculatePullRequestCostsAsync.mockClear();
    readWorkRecords.mockClear();
    await run();
    expect(calculatePullRequestCostsAsync).not.toHaveBeenCalled();
    // Translated records stay translated: an hour later, without new records, nothing is rebuilt.
    const clock = spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + 60 * 60_000);
    await run();
    expect(calculatePullRequestCostsAsync).not.toHaveBeenCalled();
    await appendFile(
      join(directory, "work-attribution", "source.jsonl"),
      `${JSON.stringify({ version: 1, type: "work", workId: "55555555-5555-4555-8555-555555555555", sessionId: "private-session", recordedAt: new Date().toISOString() })}\n`,
    );
    await run();
    expect(calculatePullRequestCostsAsync).toHaveBeenCalledTimes(1);
    expect(readWorkRecords).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
  });
});

describe("gated quiet passes", () => {
  beforeEach(resetReportingPassGates);

  it("stays quiet between due times, honors opt-outs, and fires the deferred retry at its stamped time", async () => {
    await seedLinked();
    let refuse = true;
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : refuse
            ? new Response(null, { status: 500 })
            : Response.json({
                status: "accepted",
                revision: "1",
                receivedAt: new Date().toISOString(),
              }),
    );
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    expect(posts()).toHaveLength(1);
    const [frozen] = await pendingFrozenSnapshots(directory, () => {}, Date.now() - 1);
    if (!frozen) throw new Error("a deferred snapshot must wait between pass gates");
    // The pass's own deferral bookkeeping is absorbed into the stamp: nothing the pass did not
    // write itself changed on disk, so the very next tick runs no full cycle at all.
    const settled = freezeSnapshots.mock.calls.length;
    await run();
    expect(freezeSnapshots.mock.calls.length).toBe(settled);
    expect(posts()).toHaveLength(1);
    // Opting out is a write from outside the pass: it re-opens one pass and then stays quiet.
    await setReportingEnabled(directory, false);
    const clock = spyOn(Date, "now");
    clock.mockReturnValue(frozen.entry.retryAt + 1000);
    await run();
    expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(settled);
    const disabled = freezeSnapshots.mock.calls.length;
    await run();
    expect(freezeSnapshots.mock.calls.length).toBe(disabled);
    expect(posts()).toHaveLength(1);
    // Re-enabled and past the stamped retry time, the due snapshot goes out.
    await setReportingEnabled(directory, true);
    refuse = false;
    await run();
    expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(disabled);
    expect(posts()).toHaveLength(2);
  });

  it("re-opens for a foreign queue write, not for a content-identical rewrite", async () => {
    await seedLinked();
    let refuse = true;
    http.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> =>
        String(input).endsWith("api-keys:verify")
          ? Response.json({ organizationId: org, userId: user })
          : refuse
            ? new Response(null, { status: 500 })
            : Response.json({
                status: "accepted",
                revision: "1",
                receivedAt: new Date().toISOString(),
              }),
    );
    const run = () =>
      reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    await run();
    const settled = freezeSnapshots.mock.calls.length;
    await run();
    expect(freezeSnapshots.mock.calls.length).toBe(settled);
    expect(posts()).toHaveLength(1);
    // A content-identical rewrite (an editor touch, a sync tool) moves no real state: the tick
    // stays quiet — only real writes move the version the gate reads.
    const path = join(directory, "pr-cost-reporting", "state.json");
    await writeFile(path, await readFile(path));
    await run();
    expect(freezeSnapshots.mock.calls.length).toBe(settled);
    // A foreign write — any session's real queue change — bumps the version the stamp keeps:
    // the next pass runs fully and sees the retry as due at its stamped time.
    const clock = spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + 10 * 60_000);
    refuse = false;
    await recordReportingError(directory, "foreign writer");
    await run();
    expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(settled);
    expect(posts()).toHaveLength(2);
  });
});

it("releases a hold whose evidence stayed incomplete past the expiry horizon", async () => {
  // Directly age the queue file: the hold is a week+ old and no completing evidence ever arrived.
  const file = join(directory, "pr-cost-reporting", "state.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  const [seeded] = Object.values(state.entries) as {
    held?: boolean;
    heldAt?: number;
  }[];
  seeded.held = true;
  seeded.heldAt = Date.now() - HOLD_EXPIRY_MS - 60_000;
  await writeFile(file, `${JSON.stringify(state)}\n`);
  // The same capture passes again: an expired hold releases instead of re-parking the entry.
  await queueSnapshots(directory, [content]);
  let entry = Object.values((await readReportingState(directory)).entries)[0];
  expect(entry.held).toBeUndefined();
  expect(entry.heldAt).toBeUndefined();
  await deliver();
  entry = Object.values((await readReportingState(directory)).entries)[0];
  expect(readPendingBody(directory, entry)).toBeUndefined();
  expect(entry.lastAcknowledgedAt).toBeDefined();
});

it("keeps a fresh hold parked while its evidence looks incomplete", async () => {
  // Same evidence, but the capture admits its inventory is incomplete: the entry is held.
  await queueSnapshots(directory, [
    { account: content.account, content: content.content, incomplete: true },
  ]);
  const entry = Object.values((await readReportingState(directory)).entries)[0];
  expect(entry.held).toBe(true);
  expect(entry.heldAt).toBeDefined();
  http.mockClear();
  await deliver();
  expect(http).not.toHaveBeenCalled();
});

it("sleeps between a failing snapshot's own retry deadlines instead of chasing its bookkeeping", async () => {
  const random = spyOn(Math, "random");
  random.mockReturnValue(0.5);
  http.mockImplementation(
    async (input: RequestInfo | URL): Promise<Response> =>
      String(input).endsWith("api-keys:verify")
        ? Response.json({ organizationId: org, userId: user })
        : new Response(null, { status: 500 }),
  );
  const run = () =>
    reconcileReporting(directory, "/project", new AbortController().signal, () => {});
  await run();
  expect(posts()).toHaveLength(1);
  let entry = Object.values((await readReportingState(directory)).entries)[0];
  const firstRetryAt = entry.retryAt;
  // The pass's own deferral bookkeeping (attempts/retryAt in state.json, ledger commits) moved
  // the version signals the gate reads; its stamp absorbs them: the very next tick is quiet.
  const settled = freezeSnapshots.mock.calls.length;
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(settled);
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(settled);
  expect(posts()).toHaveLength(1);
  // A retry's clock is the later of backoff and the upload window after the last attempt;
  // middling ticks stay quiet both ways.
  let clock = spyOn(Date, "now");
  clock.mockReturnValue(firstRetryAt + 1);
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(settled);
  const wake = Math.max(firstRetryAt, (entry.uploadedAt ?? 0) + UPLOAD_INTERVAL_MS) + 1;
  // At the entry's own schedule exactly one pass runs and retries; its failure re-parks later.
  clock = spyOn(Date, "now");
  clock.mockReturnValue(wake);
  await run();
  expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(settled);
  expect(posts()).toHaveLength(2);
  entry = Object.values((await readReportingState(directory)).entries)[0];
  expect(entry.retryAt).toBeGreaterThan(firstRetryAt);
  const reSettled = freezeSnapshots.mock.calls.length;
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(reSettled);
});

it("a 413-trimmed body is due again on the next pass instead of riding the attempt's own window", async () => {
  // The trim REPLACES the frozen row: attempts/retryAt reset to zero and the upload-window
  // clock clears, so the halved body retries immediately — the stamp must not keep the
  // attempt's own rejected-window picture, or the gate would sit on a body the queue says
  // is due for minutes (and, for a capped-limit trim, for a limit-length backoff).
  const requests = [
    content.content.requests[0],
    ...Array.from({ length: 39 }, (_, index) => ({
      requestId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      billingRecordIds: [],
      startedAt: "2026-10-04T12:00:00Z",
      allocation: { kind: "unlinked" as const, pullRequestIds: [], method: "native" as const },
    })),
  ];
  await queueSnapshots(directory, [
    {
      account: content.account,
      content: {
        repository: content.content.repository,
        pullRequests: [],
        requests,
        coverage: {
          observedRequests: requests.length,
          unpricedRequests: requests.length,
          historyComplete: true,
        },
      },
    },
  ]);
  http.mockImplementation(
    async (input: RequestInfo | URL): Promise<Response> =>
      String(input).endsWith("api-keys:verify")
        ? Response.json({ organizationId: org, userId: user })
        : new Response(null, { status: 413 }),
  );
  const run = () =>
    reconcileReporting(directory, "/project", new AbortController().signal, () => {});
  await run();
  expect(posts()).toHaveLength(1); // original body rejected
  // Next tick: the trimmed row is due NOW — the gate opens even though the attempt itself
  // just happened (its window would otherwise hold a fresh upload shut for five minutes).
  const afterTrim = freezeSnapshots.mock.calls.length;
  await run();
  expect(posts()).toHaveLength(2); // 40 requests halved to 20, retried immediately
  expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(afterTrim);
  // Still above the trim floor: second 413 halves 20 -> 16 and is due immediately again.
  const afterSecond = freezeSnapshots.mock.calls.length;
  await run();
  expect(posts()).toHaveLength(3);
  expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(afterSecond);
  // At the floor the body settles (dead-letter — dead-letter PR on this stack base); the pass
  // after THAT is finally quiet — each immediate reopen up to here traced a due trim, not churn.
  const settled = freezeSnapshots.mock.calls.length;
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(settled);
});

it("stamps an event upload parked on backoff at its deadline instead of ticking until it drains", async () => {
  resetReportingPassGates();
  const batch = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accountKey: accountKey(content.account),
    body: new TextEncoder().encode("{}"),
    eventIds: [],
    createdAt: Date.now(),
    orderKey: "",
  };
  backendFor(directory).insertOutboxBatch(batch);
  // The schedule note every failed upload leaves behind: parked for an hour, bound to the
  // queue's current legacy-snapshot resume marker (the note is dropped for any other).
  const resume = backendFor(directory).getNote("agent", "legacy-snapshot-resume");
  backendFor(directory).putNote(
    "pr-cost-delivery",
    accountKey(content.account),
    JSON.stringify({ batchId: batch.id, attempts: 1, retryAt: Date.now() + 60 * 60_000, resume }),
  );
  respond(accepted);
  const run = () =>
    reconcileReporting(directory, "/project", new AbortController().signal, () => {});
  let quiet = freezeSnapshots.mock.calls.length;
  for (let absorbing = 0; absorbing < 8; absorbing++) {
    await run();
    if (freezeSnapshots.mock.calls.length === quiet) break;
    quiet = freezeSnapshots.mock.calls.length;
  }
  const settled = quiet;
  // Before the parked upload's deadline: ticks run no cycle at all — the outbox's own
  // backoff note, not a full scan, says when to worry about it again.
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(settled);
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(settled);
  // Past its deadline the pass re-opens and the upload goes out.
  const clock = spyOn(Date, "now");
  clock.mockReturnValue(Date.now() + 61 * 60_000);
  await run();
  expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(settled);
});

it("wakes at a hold's expiry deadline, even with no other change to report", async () => {
  // Directly age the queue file: the hold reaches its horizon one minute from now.
  const file = join(directory, "pr-cost-reporting", "state.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  const [seeded] = Object.values(state.entries) as {
    held?: boolean;
    heldAt?: number;
  }[];
  seeded.held = true;
  seeded.heldAt = Date.now() - HOLD_EXPIRY_MS + 60_000;
  await writeFile(file, `${JSON.stringify(state)}\n`);
  const run = () =>
    reconcileReporting(directory, "/project", new AbortController().signal, () => {});
  let quiet = freezeSnapshots.mock.calls.length;
  for (let absorbing = 0; absorbing < 8; absorbing++) {
    await run();
    if (freezeSnapshots.mock.calls.length === quiet) break;
    quiet = freezeSnapshots.mock.calls.length;
  }
  const settled = quiet;
  await run();
  expect(freezeSnapshots.mock.calls.length).toBe(settled);
  // The deadline wakes one pass: it releases the hold and the parked upload finally lands.
  const clock = spyOn(Date, "now");
  clock.mockReturnValue(Date.now() + 2 * 60_000);
  await run();
  expect(freezeSnapshots.mock.calls.length).toBeGreaterThan(settled);
  const entry = Object.values((await readReportingState(directory)).entries)[0];
  expect(entry.held).toBeUndefined();
  expect(entry.lastAcknowledgedAt).toBeDefined();
});

describe("journals with a torn final append", () => {
  it("keeps reporting after the crashed session appends another record", async () => {
    await rm(join(directory, "pr-cost-reporting", "state.json"));
    await seedLinked();
    await writeFile(
      join(directory, "work-attribution", "crashed.jsonl"),
      '{"type":"request","requestId":"0b8f',
    );
    // The vitest suite stubbed PI_CODING_AGENT_DIR and passed a pi context; the bridge's
    // appendWorkRecord takes the WorkContext and reads the agent directory from HostPorts.
    appendWorkRecord(
      { cwd: "/project", sessionManager: { getSessionId: () => "crashed" } },
      { type: "work" },
      "55555555-5555-4555-8555-555555555555",
    );
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(capturedReport()?.requests.map((row) => row.requestId)).toEqual([requestId]);
    expect(posts()).toEqual([]);
    expect((await readReportingState(directory)).error).toBeUndefined();
  });
  it("keeps reporting recorded work when another session's journal ends with a partial line", async () => {
    await rm(join(directory, "pr-cost-reporting", "state.json"));
    await seedLinked();
    // A process died during its final append; that record was never complete or reported.
    await writeFile(
      join(directory, "work-attribution", "crashed.jsonl"),
      '{"type":"request","requestId":"0b8f',
    );
    await reconcileReporting(directory, "/project", new AbortController().signal, () => {});
    expect(capturedReport()?.requests.map((row) => row.requestId)).toEqual([requestId]);
    expect(posts()).toEqual([]);
  });
});
