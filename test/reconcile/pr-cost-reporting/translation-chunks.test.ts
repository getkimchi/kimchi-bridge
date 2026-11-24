import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "bun:test";
import type { WorkRecord } from "../../../src/reconcile/work-attribution/summary.js";
import {
  backendFor,
  capture,
  closeBackends,
  readWorkSummary,
} from "../../../src/ledger/records.js";
import { openStore, useTxClock } from "../../../src/ledger/store.js";
import { runReconciliationPass } from "../../../src/reconcile/pass.js";
import { withHostPorts } from "../../../src/reconcile/host-ports.js";
import type { HostPorts } from "../../../src/reconcile/host.js";

/**
 * Behavioral adaptive-chunk proof for the PR-cost translation groups: the real pass (a fake
 * host, real SQLite) translates a whole work group of request triples under a slow transaction
 * clock, so the translation chunk sizer shrinks its chunks far below the historic fixed size,
 * and the observed end state — every event id, hash and body, the claim/revision units that
 * landed, including the non-initial revision a re-claimed work entity carries after a second
 * pass translates a changed fact, the translation markers and the work projection — is
 * identical to a fixed-size
 * control run over the same records. Claim/revision units are never split by the shrinking:
 * every event keeps a valid revision chain, and the final claim event of both runs is the same
 * bytes.
 */

const WORK = "22222222-2222-4222-8222-222222222222";
const PRODUCER = "55555555-5555-4555-8555-555555555555";
const SESSION = "session-one";
const STARTED_AT = "2026-10-24T08:00:00Z";
const DISPATCHED_AT = "2026-10-24T08:00:01Z";
const RECORDED_AT = "2026-10-24T08:00:02Z";
const SCOPE = {
  account: {
    apiUrl: "https://api.cast.ai",
    organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  },
  repository: "/repo/.git",
};
const NATIVE_USAGE = {
  harness: "kimchi",
  sourceVersion: "1.2.3",
  api: "anthropic-messages",
  schema: "anthropic-messages-v1",
  provider: "anthropic",
  reportedModel: "requested-model",
  actualModel: "responding-model",
  responseId: "msg-one",
  serviceTier: "standard",
  region: "global",
  dispatchObserved: true,
  finalized: true,
  raw: {
    inputTokens: 12,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: 9,
    reasoningTokens: 2,
    cacheWrites: [
      { ttlSeconds: 3600, tokens: 5 },
      { ttlSeconds: 300, tokens: 4 },
    ],
  },
};

/** One translation unit: a request, its dispatch and its priced response. */
function requestTriple(index: number): WorkRecord[] {
  const owner = {
    version: 1 as const,
    requestId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    workId: WORK,
    sessionId: SESSION,
  };
  return [
    {
      ...owner,
      type: "request",
      startedAt: STARTED_AT,
      scope: SCOPE,
      provider: "context-provider",
      model: "context-model",
    },
    { ...owner, type: "request_dispatch", startedAt: STARTED_AT, dispatchedAt: DISPATCHED_AT },
    {
      ...owner,
      type: "request_response",
      recordedAt: RECORDED_AT,
      nativeUsage: structuredClone(NATIVE_USAGE),
    },
  ];
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-translation-chunk-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  useTxClock(null);
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function host(agentDir: string): HostPorts {
  return {
    agentDir,
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
  };
}

interface OutboxRow {
  id: string;
  entity_id: string;
  kind: string;
  hash: string;
  body: string;
  acked_at: number | null;
  blocked: string;
}

/** Everything the translation committed, in a comparable snapshot. */
function observedEndState(dir: string): {
  events: (OutboxRow & { bodyJson: unknown })[];
  markers: number;
  summary: unknown;
} {
  const store = openStore(dir);
  try {
    const events = store.db
      .query<OutboxRow, []>(
        "SELECT id, entity_id, kind, hash, body, acked_at, blocked FROM outbox_events ORDER BY id",
      )
      .all()
      .map((row) => ({ ...row, bodyJson: JSON.parse(Buffer.from(row.body).toString("utf8")) }));
    return {
      events,
      markers: backendFor(dir).markedRecords().length,
      summary: readWorkSummary(dir, WORK) ?? null,
    };
  } finally {
    store.close();
  }
}

it("translation chunks shrink under slow transactions and the observed units stay identical", async () => {
  const UNITS = 250;
  const run = async (slow: boolean) => {
    const dir = agentDir();
    for (let index = 0; index < UNITS; index++)
      for (const row of requestTriple(index)) capture(dir, row, "summary-native");
    // Reporting must be enabled for the pass to translate and observe the group's events, and
    // the producer id must be pinned so both runs derive the same stable event identities.
    const { setReportingEnabled } = await import(
      "../../../src/reconcile/pr-cost-reporting/queue.js"
    );
    await withHostPorts(host(dir), () => setReportingEnabled(dir, true));
    backendFor(dir).putNote(
      "agent",
      "reporting-producer",
      JSON.stringify({ version: 1, producerId: PRODUCER }),
    );
    if (slow) {
      // Every transaction the pass issues measures above the ceiling, so the translation
      // chunk sizer keeps halving its chunks while the units still translate in order.
      let now = 0;
      useTxClock(() => (now += 300));
    }
    let transactions = 0;
    const pass = async () => {
      const result = await withHostPorts(host(dir), () =>
        runReconciliationPass({ reporting: { cwd: dir } }, host(dir), {
          signal: new AbortController().signal,
          assertLease: () => {},
        }),
      );
      transactions += result.txDurations?.count ?? 0;
    };
    await pass();
    // A changed fact after the first translation: the work gains an issue key, captured as a
    // second request record for an already-translated request (same identity, plus the issue
    // chosen for the work behind it). The next pass re-translates that request's unit, whose
    // shared work fact now names the issue, so the work entity is re-claimed on top of the
    // revision-1 event the first pass stored — a real revision chain under the same chunking.
    capture(
      dir,
      {
        ...requestTriple(0)[0],
        issue: { key: "ABC-123" },
      },
      "summary-native",
    );
    await pass();
    useTxClock(null);
    return { transactions, ...observedEndState(dir) };
  };
  const control = await run(false);
  const adaptive = await run(true);
  // The adaptive run split the same translation into many more, smaller transactions.
  expect(adaptive.transactions).toBeGreaterThan(control.transactions * 2);
  // The end state is the fixed-size run's exactly: every event id, hash and body, the
  // translation markers that remain, and the work's projection.
  expect(adaptive.events).toEqual(control.events);
  expect(adaptive.markers).toBe(control.markers);
  expect(adaptive.summary).toEqual(control.summary);
  expect(control.events.length).toBeGreaterThan(0);
  // Claim/revision units were never split into invalid states: every event body carries a
  // positive revision, and every entity's revisions chain exactly — each revision above the
  // first names the entity's previous event id in baseEventId and its revision in baseRevision,
  // and a first revision carries no base at all.
  const chains = new Map<string, typeof adaptive.events>();
  for (const event of adaptive.events) {
    const body = event.bodyJson as {
      revision?: string;
      baseRevision?: string;
      baseEventId?: string;
    };
    expect(Number(body.revision)).toBeGreaterThan(0);
    const list = chains.get(event.entity_id) ?? [];
    list.push(event);
    chains.set(event.entity_id, list);
  }
  for (const events of chains.values()) {
    events.sort(
      (a, b) =>
        Number((a.bodyJson as { revision?: string }).revision) -
        Number((b.bodyJson as { revision?: string }).revision),
    );
    const first = events[0].bodyJson as {
      revision?: string;
      baseRevision?: string;
      baseEventId?: string;
    };
    expect(first.revision).toBe("1");
    // The encoding omits an empty base revision and base event id on a first revision.
    expect(first.baseRevision ?? "0").toBe("0");
    expect(first.baseEventId ?? "").toBe("");
    for (let index = 1; index < events.length; index++) {
      const body = events[index].bodyJson as {
        revision?: string;
        baseRevision?: string;
        baseEventId?: string;
      };
      expect(body.baseEventId).toBe(events[index - 1].id);
      expect(body.baseRevision).toBe(
        (events[index - 1].bodyJson as { revision?: string }).revision,
      );
    }
  }
  // The second pass really re-claimed an already-translated entity: at least one chain grew
  // past its first revision under the same adaptive chunking.
  const reclaims = [...chains.values()].filter((events) => events.length > 1);
  expect(reclaims.length).toBeGreaterThan(0);
  for (const events of reclaims)
    expect((events[1].bodyJson as { revision?: string }).revision).toBe("2");
}, 60_000);
