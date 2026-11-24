import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { backendFor } from "../../src/ledger/records.js";
import type { HostMetric, HostPorts } from "../../src/reconcile/host.js";
import { hostPorts, setDefaultHostPorts, withHostPorts } from "../../src/reconcile/host-ports.js";
import { reconcileWorkCosts } from "../../src/reconcile/work-attribution/cost-sync.js";
import { deliverEvents } from "../../src/reconcile/pr-cost-reporting/worker.js";
import { reportingStatePath } from "../../src/reconcile/pr-cost-reporting/queue.js";
import {
  credential,
  repositoryIdentity,
} from "../../src/reconcile/pull-request-status/provider-api.js";
import golden from "../ledger/protocol-golden.json";
import { ReconcileLeaseLostError, runReconciliationPass } from "../../src/reconcile/pass.js";

/**
 * Contract test for the HostPorts seam: a fake host counts every call, and the
 * passes must route every credential, endpoint, policy, consent and metric read
 * through it — at the original call sites, including the mid-pass credential
 * re-check (F7) and the per-record cwd of billing lookups (F11).
 */

const ORG = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";
const ENDPOINT = "https://account.example";

interface FakeHost {
  host: HostPorts;
  counts: Record<string, number>;
  cwds: string[];
  /** Saved git host tokens the host answers PR discovery with. */
  gitTokens: Record<string, string | undefined>;
  metrics: HostMetric[];
  endpointCwds: string[];
  fetches: string[];
  setCredentials(credential: { token: string; organizationId?: string; apiUrl: string }): void;
}

function fakeHost(agentDir: string, fetchImpl?: HostPorts["fetch"]): FakeHost {
  const counts: Record<string, number> = {};
  const cwds: string[] = [];
  const endpointCwds: string[] = [];
  const metrics: HostMetric[] = [];
  const fetches: string[] = [];
  const gitTokens: Record<string, string | undefined> = {};
  let credential: { token: string; organizationId?: string; apiUrl: string } = {
    token: "api-key",
    organizationId: undefined,
    apiUrl: ENDPOINT,
  };
  const host: HostPorts = {
    agentDir,
    e2eSeam(name) {
      counts.e2eSeam = (counts.e2eSeam ?? 0) + 1;
      return process.env[name];
    },
    now: () => Date.now(),
    credentials(cwd) {
      counts.credentials = (counts.credentials ?? 0) + 1;
      cwds.push(cwd);
      return credential;
    },
    gitToken(host) {
      counts.gitToken = (counts.gitToken ?? 0) + 1;
      return gitTokens[host];
    },
    endpoints(cwd) {
      counts.endpoints = (counts.endpoints ?? 0) + 1;
      endpointCwds.push(cwd);
      return {
        llmEndpoint: "https://llm.example",
        openAiBaseUrl: "https://llm.example/openai/v1",
        anthropicBaseUrl: "https://llm.example/anthropic",
        experimentalOpenAiBaseUrl: "https://llm.example/experimental/openai/v1",
        platformApiUrl: ENDPOINT,
      };
    },
    orgPolicy() {
      counts.orgPolicy = (counts.orgPolicy ?? 0) + 1;
      return { resourceEnabled: (id: string) => id === "extensions.cost-per-pr" };
    },
    telemetryConsent() {
      counts.telemetryConsent = (counts.telemetryConsent ?? 0) + 1;
      return true;
    },
    metric(metric) {
      counts.metric = (counts.metric ?? 0) + 1;
      metrics.push(metric);
    },
    async fetch(input, init) {
      counts.fetch = (counts.fetch ?? 0) + 1;
      fetches.push(String(input));
      if (fetchImpl) return fetchImpl(input, init);
      return Response.json({ organizationId: ORG, userId: USER });
    },
  };
  return {
    host,
    counts,
    cwds,
    gitTokens,
    metrics,
    endpointCwds,
    fetches,
    setCredentials(next) {
      credential = next;
    },
  };
}

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-host-ports-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  setDefaultHostPorts(undefined);
});

test("hostPorts throws when no host is bound, so no call site silently guesses", () => {
  setDefaultHostPorts(undefined);
  expect(() => hostPorts()).toThrow("requires HostPorts");
});

test("withHostPorts scopes a host to its async context", async () => {
  const dir = agentDir();
  const first = fakeHost(dir);
  const second = fakeHost(dir);
  await withHostPorts(first.host, async () => {
    await Promise.resolve();
    expect(hostPorts()).toBe(first.host);
    await withHostPorts(second.host, async () => {
      expect(hostPorts()).toBe(second.host);
    });
    expect(hostPorts()).toBe(first.host);
  });
});

test("a full pass reaches every port: reconciliation metric, consent, policy, seam and paths", async () => {
  const dir = agentDir();
  const fake = fakeHost(dir);
  const result = await runReconciliationPass(
    { files: true, pullRequests: {}, costs: true, reporting: { cwd: "/project" } },
    fake.host,
    { signal: new AbortController().signal, assertLease: () => {} },
  );
  // The pass announced itself through the metric port, exactly once, first.
  expect(fake.metrics[0]).toEqual({ kind: "reconciliation" });
  expect(fake.metrics.filter((metric) => metric.kind === "reconciliation")).toHaveLength(1);
  // The reporting channel consulted consent (state reads and the consent fence).
  expect(fake.counts.telemetryConsent).toBeGreaterThan(0);
  // The agent directory's work-attribution folder exists with private mode.
  const stat = statSync(join(dir, "work-attribution"));
  expect(stat.isDirectory()).toBe(true);
  expect(stat.mode & 0o700).toBe(0o700);
  // An empty ledger leaves the repository rotation unset.
  expect(result.nextRepository).toBeUndefined();
  // Every enabled channel completed; the disabled ones are recorded as skipped.
  expect(result.channels).toEqual({
    files: { outcome: "ok" },
    "pull-requests": { outcome: "ok" },
    costs: { outcome: "ok" },
    continuations: { outcome: "ok" },
    reporting: { outcome: "ok" },
  });
});

test("event delivery resolves credentials through the host and re-checks them mid-pass", async () => {
  const dir = agentDir();
  const fake = fakeHost(dir);
  setDefaultHostPorts(fake.host);
  const account = { apiUrl: ENDPOINT, organizationId: ORG, userId: USER };
  backendFor(dir).insertOutboxBatch({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accountKey: JSON.stringify([ENDPOINT, ORG, USER]),
    body: new Uint8Array(),
    eventIds: [],
    createdAt: Date.now(),
    orderKey: "",
  });
  // After the account verifies, the credential changes: the mid-pass re-check
  // (assertOwnership in deliverEvents) must stop the upload before it is sent.
  let verified = false;
  fake.setCredentials({ token: "api-key", apiUrl: ENDPOINT });
  const fetchImpl: HostPorts["fetch"] = async (input) => {
    if (String(input).endsWith("/api-keys:verify")) {
      verified = true;
      fake.setCredentials({ token: "rotated-key", apiUrl: ENDPOINT });
      return Response.json({ organizationId: ORG, userId: USER });
    }
    throw new Error("the upload must not be dispatched after the credential changed");
  };
  const host: HostPorts = { ...fake.host, fetch: fetchImpl };
  // The re-check ends the pass with the credentials-changed error, before any upload.
  await expect(
    withHostPorts(host, () =>
      deliverEvents(dir, "/project", new AbortController().signal, () => {}),
    ),
  ).rejects.toThrow("PR reporting credentials changed");
  expect(verified).toBe(true);
  // The upload route was never reached.
  expect(fake.fetches.some((url) => url.endsWith("/pr-cost-events:batchIngest"))).toBe(false);
  // The pass read the credential at its original call sites: the initial
  // resolution and the ownership re-checks around the network call, all with
  // the reporting session's exact cwd.
  expect(fake.counts.credentials ?? 0).toBeGreaterThanOrEqual(3);
  expect(fake.cwds.every((cwd) => cwd === "/project")).toBe(true);
});

test("billing lookups resolve credentials with each stored record's own cwd", async () => {
  const dir = agentDir();
  const fake = fakeHost(dir);
  setDefaultHostPorts(fake.host);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const workId = "22222222-2222-4222-8222-222222222222";
  const startedAt = "2026-10-24T08:00:00.000Z";
  const dispatchedAt = "2026-10-24T08:00:01.000Z";
  const recordCwd = "/the/records/own/cwd";
  // A request whose scope was captured in one account, dispatched through the
  // configured gateway, with its billing source and selector recorded.
  backendFor(dir).insertRecord({
    recordHash: "a".repeat(64),
    type: "request",
    workId,
    sessionId: "session",
    body: JSON.stringify({
      version: 1,
      type: "request",
      workId,
      sessionId: "session",
      requestId,
      cwd: recordCwd,
      startedAt,
      scope: {
        account: { apiUrl: ENDPOINT, organizationId: ORG, userId: USER },
        repository: "/repo/.git",
      },
    }),
    sourcePath: join(dir, "work-attribution", "session.jsonl"),
    sourceGeneration: 0,
    sourceOffset: 0,
    importedAt: Date.now(),
  });
  backendFor(dir).insertRecord({
    recordHash: "b".repeat(64),
    type: "request_dispatch",
    workId,
    sessionId: "session",
    body: JSON.stringify({
      version: 1,
      type: "request_dispatch",
      workId,
      sessionId: "session",
      requestId,
      cwd: recordCwd,
      startedAt,
      dispatchedAt,
      billingSource: {
        apiUrl: ENDPOINT,
        gatewayUrl: "https://llm.example/openai/v1/chat/completions",
        credentialHash: "c".repeat(64),
      },
      billingSelector: {
        type: "tag",
        tag: `kimchi-request:${requestId}`,
        startTime: "2026-10-23T20:00:01.000Z",
        endTime: "2026-11-25T08:00:01.000Z",
      },
    }),
    sourcePath: join(dir, "work-attribution", "session.jsonl"),
    sourceGeneration: 0,
    sourceOffset: 0,
    importedAt: Date.now(),
  });
  await reconcileWorkCosts(dir, new AbortController().signal, () => {});
  // The lookup read the credential with the stored record's cwd (F11), not the
  // pass cwd or the agent directory.
  expect(fake.cwds).toContain(recordCwd);
  expect(fake.cwds.every((cwd) => cwd === recordCwd)).toBe(true);
  // The billing source's endpoint derivation also ran through the host.
  expect(fake.endpointCwds).toContain(recordCwd);
});

test("the resource gate consults the org policy port", async () => {
  const dir = agentDir();
  const enabled = fakeHost(dir);
  setDefaultHostPorts(enabled.host);
  const { tryWorkAttribution } = await import("../../src/reconcile/work-attribution.js");
  expect(tryWorkAttribution(() => "ran")).toBe("ran");
  expect(enabled.counts.orgPolicy).toBe(1);
  const disabled = fakeHost(dir);
  setDefaultHostPorts({
    ...disabled.host,
    orgPolicy: () => {
      disabled.counts.orgPolicy = (disabled.counts.orgPolicy ?? 0) + 1;
      return { resourceEnabled: () => false };
    },
  });
  const writes: number[] = [];
  // With the resource disabled, attribution records nothing through the wrapper.
  expect(tryWorkAttribution(() => writes.push(1))).toBeUndefined();
  expect(writes).toHaveLength(0);
});

/** A request and its dispatch, so the costs channel runs a billing lookup for it. */
function seedBillingRequest(dir: string): void {
  const workId = "22222222-2222-4222-8222-222222222222";
  const requestId = "11111111-1111-4111-8111-111111111111";
  const startedAt = "2026-10-24T08:00:00.000Z";
  const dispatchedAt = "2026-10-24T08:00:01.000Z";
  backendFor(dir).insertRecord({
    recordHash: "a".repeat(64),
    type: "request",
    workId,
    sessionId: "session",
    body: JSON.stringify({
      version: 1,
      type: "request",
      workId,
      sessionId: "session",
      requestId,
      cwd: "/project",
      startedAt,
      scope: { account: { apiUrl: ENDPOINT, organizationId: ORG, userId: USER } },
    }),
    sourcePath: join(dir, "work-attribution", "session.jsonl"),
    sourceGeneration: 0,
    sourceOffset: 0,
    importedAt: Date.now(),
  });
  backendFor(dir).insertRecord({
    recordHash: "b".repeat(64),
    type: "request_dispatch",
    workId,
    sessionId: "session",
    body: JSON.stringify({
      version: 1,
      type: "request_dispatch",
      workId,
      sessionId: "session",
      requestId,
      cwd: "/project",
      startedAt,
      dispatchedAt,
      billingSource: {
        apiUrl: ENDPOINT,
        gatewayUrl: "https://llm.example/openai/v1/chat/completions",
        // The dispatch-time fingerprint of the fake host's configured key, so the costs
        // channel's lookup runs for this request instead of reporting an account change.
        credentialHash: createHash("sha256").update("api-key").digest("hex"),
      },
      billingSelector: {
        type: "tag",
        tag: `kimchi-request:${requestId}`,
        startTime: "2026-10-23T20:00:01.000Z",
        endTime: "2026-11-25T08:00:01.000Z",
      },
    }),
    sourcePath: join(dir, "work-attribution", "session.jsonl"),
    sourceGeneration: 0,
    sourceOffset: 0,
    importedAt: Date.now(),
  });
}

test("a lease assertion failure mid-pass aborts the pass with a typed error and writes nothing after the loss", async () => {
  const dir = agentDir();
  const backend = backendFor(dir);
  // The own-commit counter plus the row watermark sees every ledger write this process makes.
  const ledgerState = () =>
    [
      backend.dataVersion(),
      backend.recordWatermark(),
      backend.dirtyWorks().length,
      backend.outboxDeliveryStatus().length,
    ].join(":");
  const workId = "22222222-2222-4222-8222-222222222222";
  let lost = false;
  let stateAtLoss: string | undefined;
  let verifies = 0;
  const fake = fakeHost(dir, async (input) => {
    const url = String(input);
    if (url.endsWith("/api-keys:verify")) {
      verifies += 1;
      // The lease is lost while the costs channel's account verification is in flight.
      lost = true;
      stateAtLoss = ledgerState();
      return Response.json({ organizationId: ORG, userId: USER });
    }
    if (lost) throw new Error("no network work may run after the lease was lost");
    return Response.json({
      items: [{ id: workId, totalPrice: "0.123456789", castaiApiKeyOwnerId: USER }],
      totalCount: 1,
    });
  });
  seedBillingRequest(dir);
  const failure = await runReconciliationPass(
    { costs: true, reporting: { cwd: "/project" } },
    fake.host,
    {
      signal: new AbortController().signal,
      assertLease: () => {
        if (lost) throw new Error("lease lost mid-pass");
      },
    },
  ).then(
    () => {
      throw new Error("the pass must reject when the lease is lost mid-pass");
    },
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ReconcileLeaseLostError);
  expect(String((failure as ReconcileLeaseLostError).cause)).toContain("lease lost mid-pass");
  // The costs channel's own verification ran; the reporting channel never started.
  expect(verifies).toBe(1);
  expect(fake.fetches.filter((url) => url.includes("/pr-cost"))).toHaveLength(0);
  // Nothing was committed after the loss: the ledger is exactly as it was at that moment.
  if (stateAtLoss === undefined) throw new Error("the loss moment must be recorded");
  expect(ledgerState()).toBe(stateAtLoss);
});

/** A due outbox event for the reporting account, so the reporting channel delivers it. */
function seedOutboxEvent(dir: string): void {
  // A complete wire event (adapted from the protocol golden fixture): delivery validates the
  // full identity, revision chain and typed payload, so a hand-rolled shape cannot pass.
  const seeded = {
    ...(golden.events[0].input as Record<string, unknown>),
    id: "88888888-8888-4888-8888-888888888888",
    entityId: "99999999-9999-4999-8999-999999999999",
    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const body = Buffer.from(JSON.stringify(seeded));
  backendFor(dir).insertOutboxEvent({
    id: seeded.id as string,
    accountKey: JSON.stringify([ENDPOINT, ORG, USER]),
    entityId: seeded.entityId as string,
    kind: "work",
    body,
    hash: createHash("sha256").update(body).digest("hex"),
    createdAt: 0,
    ackedAt: null,
    blocked: "",
  });
}

test("a failed channel records its outcome while the pass continues", async () => {
  const dir = agentDir();
  // A reporting state file that fails validation: the reporting channel rejects before
  // its delivery, and the pass still resolves with the outcome recorded.
  const statePath = reportingStatePath(dir);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, "{");
  const fake = fakeHost(dir);
  const result = await runReconciliationPass(
    { costs: true, reporting: { cwd: "/project" } },
    fake.host,
    { signal: new AbortController().signal, assertLease: () => {} },
  );
  expect(result.nextRepository).toBeUndefined();
  expect(result.channels).toEqual({
    files: { outcome: "skipped" },
    "pull-requests": { outcome: "skipped" },
    costs: { outcome: "ok" },
    continuations: { outcome: "skipped" },
    reporting: { outcome: "failed", error: expect.any(String) },
  });
  // No reporting network work ran.
  expect(fake.fetches).toHaveLength(0);
});

test("a channel's own signal cancels only that channel", async () => {
  const dir = agentDir();
  seedBillingRequest(dir);
  seedOutboxEvent(dir);
  const costs = new AbortController();
  let verifies = 0;
  const fake = fakeHost(dir, async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api-keys:verify")) {
      verifies += 1;
      // The costs channel's verification is in flight when its own signal aborts; the
      // reporting channel's work afterwards must still run to completion.
      if (verifies === 1) costs.abort();
      return Response.json({ organizationId: ORG, userId: USER });
    }
    if (url.includes("/llm-requests")) {
      return Response.json({
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            totalPrice: "0.123456789",
            castaiApiKeyOwnerId: USER,
          },
        ],
        totalCount: 1,
      });
    }
    // The event batch upload: answer with the acknowledgement the sent batch describes.
    const wire = JSON.parse(String(init?.body ?? "{}")) as {
      batch?: { id: string; events: Array<{ id: string; revision: string }> };
    };
    const batch = wire.batch ?? { id: "", events: [] };
    return Response.json({
      batchId: batch.id,
      receipts: batch.events.map((event) => ({
        id: event.id,
        revision: event.revision,
        status: "accepted",
      })),
    });
  });
  const result = await runReconciliationPass(
    { costs: { signal: costs.signal }, reporting: { cwd: "/project" } },
    fake.host,
    { signal: new AbortController().signal, assertLease: () => {} },
  );
  expect(result.channels.costs).toEqual({ outcome: "canceled" });
  // The reporting channel delivered despite the costs cancellation; the pass signal was
  // never aborted, so the channels stayed independent.
  expect(result.channels.reporting).toEqual({ outcome: "ok" });
  expect(result.channels.files).toEqual({ outcome: "skipped" });
  expect(fake.fetches.some((url) => url.includes("pr-cost-events:batchIngest"))).toBe(true);
  // The delivered event was acknowledged, not deferred.
  expect(backendFor(dir).outboxDeliveryStatus()[0]?.sendable).toBe(false);
});

test("git provider tokens resolve through the host port at both discovery call sites", async () => {
  const dir = agentDir();
  const fake = fakeHost(dir);
  fake.gitTokens["git.example"] = "glpat-saved";
  fake.gitTokens["github.com"] = "ghp-saved";
  setDefaultHostPorts(fake.host);
  const repository = { provider: "gitlab" as const, host: "git.example" };
  // The credential() call site: no environment token, the gh/gitlab command helpers fail, and
  // the saved token from the host port is the answer.
  const tokens = new Map<string, Promise<string | undefined>>();
  const token = await credential(
    repository,
    new AbortController().signal,
    Date.now() + 1000,
    tokens,
  );
  expect(token).toBe("glpat-saved");
  expect(fake.counts.gitToken).toBeGreaterThanOrEqual(1);
  // The repositoryIdentity() call site: an unrecognized host's remote reads the saved token
  // instead of resolving credentials again.
  const work = mkdtempSync(join(tmpdir(), "kimchi-git-identity-"));
  dirs.push(work);
  execFileSync("git", ["init", "-q"], { cwd: work });
  execFileSync("git", ["remote", "add", "origin", "https://git.example/team/repo.git"], {
    cwd: work,
  });
  const resolved = await withHostPorts(
    {
      ...fake.host,
      fetch: async (input) =>
        Response.json({
          id: 42,
          path_with_namespace: "team/repo",
          web_url: "https://git.example/team/repo",
        }),
    },
    () =>
      repositoryIdentity(
        join(work, ".git"),
        new AbortController().signal,
        Date.now() + 1000,
        new Map(),
      ),
  );
  expect(resolved.token).toBe("glpat-saved");
  expect(resolved.host).toBe("git.example");
});
