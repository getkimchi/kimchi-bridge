import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as asyncFs from "node:fs/promises";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { ledgerDbPath } from "../../src/ledger/store.js";
import { closeBackends, setNote } from "../../src/ledger/records.js";
import type { HostMetric, HostPorts } from "../../src/reconcile/host.js";
import { hostPorts, setDefaultHostPorts, withHostPorts } from "../../src/reconcile/host-ports.js";
import { runReconciliationPass, type PassResult } from "../../src/reconcile/pass.js";
import { debugWorkAttribution as debug } from "../../src/reconcile/work-attribution/diagnostics.js";
import {
  digest,
  diskState,
  ignored,
  knownTransitionRepositories,
  reflog,
  repositoryFile,
  referenceTips,
  saveHistoryBoundary,
  transitionJournal,
  type SharedTypeReads,
} from "../../src/reconcile/work-attribution/file-transitions.js";
import { reconcileRepositoryTransitions } from "../../src/reconcile/work-attribution/file-transitions.js";
import {
  type ContinuationProgress,
  reconcileWorkContinuations,
} from "../../src/reconcile/work-attribution/links.js";
import { reconcileWorkCosts } from "../../src/reconcile/work-attribution/cost-sync.js";
import {
  captureBillingSource,
  requestTagSelector,
} from "../../src/reconcile/work-attribution/billing-source.js";
import { readWorkScope, saveNewWorkScope } from "../../src/reconcile/work-attribution/scope.js";
import { flushWorkSummaries } from "../../src/reconcile/work-attribution/summary.js";
import {
  appendWorkRecord,
  workLedgerPath,
  type WorkContext,
  type WorkSegment,
} from "../../src/reconcile/work-attribution.js";
import { reconcileReporting } from "../../src/reconcile/pr-cost-reporting/worker.js";
import {
  reconcileWorkPullRequests,
  type WorkPullRequestUpdate,
} from "../../src/reconcile/pull-request-status/pull-requests.js";

/**
 * One lane of the pass/oracle equivalence pair (driven by pass-equivalence.test.ts).
 *
 * The oracle is a faithful, line-commented transcription of Kimchi's supervisor scan()
 * (kimchi-src-1842/src/extensions/work-attribution/reconcile-supervisor.ts), run against the
 * same moved bridge functions the pass calls. Each lane runs in its own child process — the
 * pass lane exactly like the B3 worker will — and both lanes run over a byte-identical
 * fixture built at the SAME filesystem path, so every content- and path-derived identifier
 * (record hashes, event ids, projection byte counts) must match exactly. The lane runs two
 * consecutive passes over a fixture in which every channel does real work:
 *
 *  - files: a real Git repository, a tracked edit captured as a file_transition, and a real
 *    commit that the channel attributes as a native-file-transition commit row;
 *  - pull-requests: the repository has a GitHub-shaped remote; the fake host's fetch answers
 *    the repository-identity, commit/pulls and repository lookups, so the channel records a
 *    linked pull request on the commit row;
 *  - costs: a request and request_dispatch with a real billing source; the fake billing API
 *    returns a priced row, so the channel writes a request_cost row and cost notes;
 *  - continuations: an accepted saved-plan continuation; the channel repairs it into a
 *    work_link row, and cross-pass progress keeps it settled on the second pass;
 *  - reporting: telemetry consent is on, so the channel translates the marked records into
 *    outbox events and delivers a batch to the fake ingestion endpoint, which acknowledges it.
 *
 * Between the two passes a second request is dispatched, so the second pass also does real
 * billing work and a marker-driven event translation. The full end state is dumped for the
 * test to compare: every ledger table in row order, every file under the agent directory,
 * the pull-request updates the subscribers saw, the metrics, and every request the fake
 * server received (method, URL, normalized body).
 *
 * The clock is frozen (and stepped 30 s between passes) so timestamps, retry windows and
 * budgets are deterministic and identical across the two lanes.
 */

// --- Deterministic identifiers, identical in both lanes -----------------------------------

const ORG = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";
const API = "https://account.example/api";
const GATEWAY = "https://gateway.example/openai/v1/chat/completions";
const GH = "https://api.github.com";
const GH_REPO = "example/repo";
const GH_REPO_ID = 999999;
const WRITER = "10000000-0000-4000-8000-000000000001";
const PLANNER = "10000000-0000-4000-8000-000000000002";
const SEGMENT = "11000000-0000-4000-8000-00000000000a";
const REQUEST1 = "20000000-0000-4000-8000-000000000001";
const REQUEST2 = "20000000-0000-4000-8000-000000000002";
const PLANNER_REQUESTS = [
  "21000000-0000-4000-8000-000000000001",
  "21000000-0000-4000-8000-000000000002",
  "21000000-0000-4000-8000-000000000003",
] as const;
const BILLING_ROW = "50000000-0000-4000-8000-000000000001";
const PRODUCER = "60000000-0000-4000-8000-000000000001";
const PR_ID = 4242;
const MERGE_SHA = `${"b".repeat(39)}1`;
const PR_MERGED_AT = "2026-11-05T00:00:00Z";
const DISPATCHED_AT = "2026-10-01T08:00:00.000Z";
const DISPATCHED_AT_2 = "2026-10-02T08:00:00.000Z";
const T0 = Date.parse("2026-12-01T00:00:00.000Z");
const T1 = T0 + 30_000;

// --- A frozen clock, so both lanes see identical times -------------------------------------

const RealDate = Date;
let clockAt: number | undefined;
// biome-ignore lint/suspicious/noExplicitAny: test-only Date stand-in
class ClockDate extends RealDate {
  // biome-ignore lint/suspicious/noExplicitAny: test-only Date stand-in
  constructor(...args: any[]) {
    super(args.length ? (args[0] as number | string | Date) : (clockAt as number));
  }
  static now(): number {
    return clockAt as number;
  }
}
function freezeClock(at: number): void {
  if ((globalThis as { Date: DateConstructor }).Date === RealDate)
    (globalThis as { Date: DateConstructor }).Date = ClockDate as unknown as DateConstructor;
  clockAt = at;
}
function restoreClock(): void {
  clockAt = undefined;
  (globalThis as { Date: DateConstructor }).Date = RealDate;
}

// --- The fake server: routing fetch plus recorded receipts --------------------------------

interface Receipt {
  method: string;
  url: string;
  body: string | null;
}

function githubPullRequest(sha: string): Record<string, unknown> {
  return {
    number: 1,
    state: "closed",
    id: PR_ID,
    head: { sha, ref: "feature" },
    base: { repo: { id: GH_REPO_ID } },
    merge_commit_sha: MERGE_SHA,
    merged_at: PR_MERGED_AT,
    closed_at: PR_MERGED_AT,
    html_url: `https://github.com/${GH_REPO}/pull/1`,
    title: "Add the feature",
    user: { login: "example" },
  };
}

function makeServer() {
  const receipts: Receipt[] = [];
  const fetch: HostPorts["fetch"] = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    receipts.push({ method, url: url.toString(), body });
    const path = url.pathname;
    if (method === "POST" && path.endsWith("/api-keys:verify"))
      return Response.json({ organizationId: ORG, userId: USER });
    if (method === "GET" && url.origin === GH && path === `/repos/${GH_REPO}`)
      return Response.json({
        id: GH_REPO_ID,
        full_name: GH_REPO,
        html_url: `https://github.com/${GH_REPO}`,
      });
    if (
      method === "GET" &&
      url.origin === GH &&
      path === `/repos/${GH_REPO}/commits/${shaOf(path)}/pulls`
    )
      return Response.json([githubPullRequest(shaOf(path))]);
    if (method === "GET" && path.includes("/llm-requests")) {
      const tag = url.searchParams.get("tags") ?? "";
      return Response.json({
        totalCount: 1,
        items: [
          {
            id: tag.endsWith(REQUEST1) ? BILLING_ROW : `${BILLING_ROW.slice(0, -1)}2`,
            castaiApiKeyOwnerId: USER,
            totalPrice: "1.25",
          },
        ],
      });
    }
    if (method === "POST" && path.endsWith("/pr-cost-snapshots"))
      return Response.json({
        status: "accepted",
        revision: `sha256:${"a".repeat(40)}`,
        receivedAt: new Date().toISOString(),
      });
    if (method === "POST" && path.endsWith("/pr-cost-events:batchIngest")) {
      const parsed =
        body === null
          ? undefined
          : (JSON.parse(body) as {
              batch?: { id?: string; events?: { id: string; revision: string }[] };
            });
      const events = parsed?.batch?.events ?? [];
      return Response.json({
        batchId: parsed?.batch?.id,
        receiveTime: new Date().toISOString(),
        receipts: events.map((event) => ({
          id: event.id,
          status: "accepted",
          revision: event.revision,
        })),
      });
    }
    return new Response("no route", { status: 404 });
  };
  return { receipts, fetch };
}

/** The commit SHA from a `/repos/<name>/commits/<sha>/pulls` path. */
function shaOf(path: string): string {
  const marker = "/commits/";
  const from = path.indexOf(marker) + marker.length;
  return path.slice(from, path.indexOf("/pulls"));
}

// --- One lane: fixture, host, driver state -------------------------------------------------

interface Lane {
  name: string;
  root: string;
  agentDir: string;
  repo: string;
  gitDir: string;
  receipts: Receipt[];
  metrics: HostMetric[];
  updates: WorkPullRequestUpdate[];
  host: HostPorts;
}

function makeHost(lane: Lane, fetch: HostPorts["fetch"]): HostPorts {
  return {
    get agentDir() {
      return lane.agentDir;
    },
    e2eSeam: () => undefined,
    now: () => Date.now(),
    credentials: () => ({ token: "test-key", apiUrl: API }),
    gitToken: (host) => (host === "github.com" ? "gh-token" : undefined),
    endpoints: () => ({
      llmEndpoint: "https://gateway.example/openai/v1",
      openAiBaseUrl: "https://gateway.example/openai/v1",
      anthropicBaseUrl: "https://gateway.example/anthropic",
      experimentalOpenAiBaseUrl: "https://gateway.example/experimental/openai/v1",
      platformApiUrl: API,
    }),
    orgPolicy: () => ({ resourceEnabled: () => true }),
    telemetryConsent: () => true,
    metric: (metric) => {
      lane.metrics.push(metric);
    },
    fetch,
  };
}

function git(lane: Lane, ...args: string[]): string {
  return execFileSync("git", ["-C", lane.repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: lane.root,
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z",
    },
  }).trim();
}

function context(lane: Lane, session: string, cwd = lane.repo): WorkContext {
  return { cwd, sessionManager: { getSessionId: () => session } };
}

/** Kimchi's capture-side tracked writeFile (file-transitions.ts operations()), on bridge primitives. */
function trackedOperations(lane: Lane, ctx: WorkContext, toolCallId: string, workId: string) {
  let readDigest: string | undefined;
  return {
    async readFile(path: string) {
      const data = await asyncFs.readFile(path);
      readDigest = digest(data);
      return data;
    },
    access: (path: string) => asyncFs.access(path, constants.R_OK | constants.W_OK),
    async writeFile(path: string, content: string) {
      const repoFile = await repositoryFile(path);
      const before =
        repoFile === undefined
          ? undefined
          : await diskState(
              path,
              undefined,
              repoFile.baselineFile !== null ? repoFile.repository : undefined,
              repoFile.baselineFile?.blob,
            );
      if (before === undefined || repoFile === undefined) {
        await asyncFs.writeFile(path, content, "utf8");
        return;
      }
      if (readDigest !== undefined && readDigest !== digest(readFileSync(path))) {
        await asyncFs.writeFile(path, content, "utf8");
        return;
      }
      await asyncFs.writeFile(path, content, "utf8");
      const written = existsSync(path) ? readFileSync(path) : undefined;
      if (!written?.equals(Buffer.from(content))) return;
      const retain =
        repoFile.baselineFile === null
          ? !(await ignored(repoFile.worktree, repoFile.path))
          : before !== null;
      const after = await diskState(path, written, retain ? repoFile.repository : undefined);
      if (!after || (before?.blob === after.blob && before?.mode === after.mode)) return;
      const log = await reflog(repoFile.worktree);
      if (log.length && log[log.length - 1] !== 10) return;
      const historyBoundaryId = await saveHistoryBoundary(
        await referenceTips(repoFile.repository, repoFile.baseline),
      );
      appendWorkRecord(
        ctx,
        {
          type: "file_transition",
          transitionId: createHash("sha256").update(`${toolCallId}:file.txt`).digest("hex"),
          toolCallId,
          ...repoFile,
          before,
          after,
          cursor: { bytes: log.length, digest: digest(log) },
          historyBoundaryId,
        },
        workId,
        transitionJournal(repoFile.repository, repoFile.worktree),
      );
    },
  };
}

async function trackedEdit(
  lane: Lane,
  ctx: WorkContext,
  toolCallId: string,
  workId: string,
  path: string,
  from: string,
  to: string,
) {
  const ops = trackedOperations(lane, ctx, toolCallId, workId);
  const absolute = resolve(lane.repo, path);
  await ops.access(absolute);
  await ops.readFile(absolute);
  const content = readFileSync(absolute, "utf8");
  if (!content.includes(from)) throw new Error(`edit anchor missing: ${from}`);
  await ops.writeFile(absolute, content.replace(from, to));
}

/** The writer session's request, dispatched through the gateway the billing source captured. */
function dispatchRequest(
  lane: Lane,
  session: string,
  workId: string,
  requestId: string,
  dispatchedAt: string,
) {
  const ctx = context(lane, session);
  appendWorkRecord(
    ctx,
    {
      type: "request",
      requestId,
      startedAt: dispatchedAt,
      scope: {
        account: { apiUrl: API, organizationId: ORG, userId: USER },
        repository: lane.gitDir,
      },
    },
    workId,
  );
  const source = captureBillingSource(
    new Headers({ Authorization: "Bearer test-key" }),
    GATEWAY,
    lane.repo,
  );
  if (!source) throw new Error("billing source capture failed");
  const selector = requestTagSelector(requestId, dispatchedAt);
  if (!selector) throw new Error("billing selector build failed");
  appendWorkRecord(
    ctx,
    {
      type: "request_dispatch",
      requestId,
      dispatchedAt,
      billingSource: source,
      billingSelector: selector,
    },
    workId,
  );
}

/** Kimchi's plan markdown (shared/planning/plan-markdown.ts), as links.test.ts rebuilds it. */
function savePlanMarkdown(
  lane: Lane,
  workId: string,
): { snapshotPath: string; contentHash: string } {
  const content = `<!-- kimchi-work-id: ${workId} -->\n# Implement export\n`;
  mkdirSync(join(lane.repo, ".kimchi", "plans"), { recursive: true });
  writeFileSync(join(lane.repo, ".kimchi", "plans", "planner.md"), content, "utf8");
  const plans = join(lane.repo, "work", workId, "plans");
  mkdirSync(plans, { recursive: true, mode: 0o700 });
  const contentHash = createHash("sha256").update(content).digest("hex");
  const snapshotPath = join(plans, `planner-${contentHash}.md`);
  writeFileSync(snapshotPath, content);
  return { snapshotPath, contentHash };
}

/** links.test.ts acceptedContinuation("plan"): producer requests, plan origin, consumer work row. */
function acceptedContinuation(lane: Lane) {
  const producer = context(lane, "planner");
  saveNewWorkScope(PLANNER, {
    account: { apiUrl: API, organizationId: ORG, userId: USER },
    repository: lane.gitDir,
  });
  const segment: WorkSegment = {
    id: SEGMENT,
    attribution: "unknown",
    reason: "unresolved-reference",
  };
  for (const requestId of PLANNER_REQUESTS)
    appendWorkRecord(
      producer,
      {
        type: "request",
        requestId,
        startedAt: DISPATCHED_AT,
        segment,
        scope: readWorkScope(PLANNER) ?? null,
      },
      PLANNER,
    );
  const saved = savePlanMarkdown(lane, PLANNER);
  appendWorkRecord(
    producer,
    {
      type: "plan",
      path: join(lane.repo, ".kimchi", "plans", "planner.md"),
      snapshotPath: saved.snapshotPath,
      contentHash: saved.contentHash,
      requestId: PLANNER_REQUESTS[2],
    },
    PLANNER,
  );
  const consumer = context(lane, "planner-consumer");
  appendWorkRecord(
    consumer,
    {
      type: "work",
      continuation: {
        source: "saved-plan",
        evidence: {
          path: saved.snapshotPath,
          account: { apiUrl: API, organizationId: ORG, userId: USER },
          repository: lane.gitDir,
          segmentId: SEGMENT,
          requestId: PLANNER_REQUESTS[2],
          contentHash: saved.contentHash,
        },
      },
    },
    PLANNER,
  );
}

function buildLane(root: string, name: string): Lane {
  const lane: Lane = {
    name,
    root,
    agentDir: join(root, "agent"),
    repo: join(root, "repo"),
    gitDir: "",
    receipts: [],
    metrics: [],
    updates: [],
    host: undefined as unknown as HostPorts,
  };
  const server = makeServer();
  lane.host = makeHost(lane, server.fetch);
  lane.receipts = server.receipts;
  mkdirSync(lane.repo, { recursive: true });
  mkdirSync(lane.agentDir, { recursive: true });
  git(lane, "init", "-q", "-b", "main");
  git(lane, "config", "user.name", "Test");
  git(lane, "config", "user.email", "test@example.test");
  git(lane, "remote", "add", "origin", `https://github.com/${GH_REPO}.git`);
  return lane;
}

/** Everything the fixtures capture before the first pass (identical in both lanes). */
async function seedFixture(lane: Lane): Promise<void> {
  setDefaultHostPorts(lane.host);
  // An established install: a fixed reporting producer, so event identities are deterministic.
  lane.gitDir = realpathSync(join(lane.repo, ".git"));
  mkdirSync(join(lane.agentDir, "pr-cost-reporting"), { recursive: true });
  writeFileSync(
    join(lane.agentDir, "pr-cost-reporting", "state.json"),
    `${JSON.stringify({ version: 1, enabled: true, followsTelemetry: true, producerId: PRODUCER, entries: {} })}\n`,
    "utf8",
  );
  setNote(
    lane.agentDir,
    "agent",
    "reporting-producer",
    `${JSON.stringify({ version: 1, producerId: PRODUCER })}\n`,
  );
  // A baseline commit, a tracked edit in the writer session, and the commit it becomes.
  writeFileSync(join(lane.repo, "file.txt"), "one\ntwo\n");
  git(lane, "add", ".");
  git(lane, "commit", "-qm", "baseline");
  await trackedEdit(
    lane,
    context(lane, "writer"),
    "write-call",
    WRITER,
    "file.txt",
    "one",
    "first",
  );
  git(lane, "add", ".");
  git(lane, "commit", "-qm", "feature");
  dispatchRequest(lane, "writer", WRITER, REQUEST1, DISPATCHED_AT);
  acceptedContinuation(lane);
}

/** The second request, dispatched between the two passes (identical in both lanes). */
function dispatchSecondRequest(lane: Lane): void {
  setDefaultHostPorts(lane.host);
  dispatchRequest(lane, "writer", WRITER, REQUEST2, DISPATCHED_AT_2);
}

// --- The oracle: Kimchi's scan(), transcribed ----------------------------------------------

/**
 * Kimchi's supervisor state (reconcile-supervisor.ts:56-72): the subscribers, the
 * supervisor-wide controller, the optional per-channel controllers, and — as the Supervisor
 * interface extends ContinuationProgress — the continuation progress that persists on the
 * live supervisor across passes.
 */
interface Channel {
  controller: AbortController;
  running?: Promise<void>;
}
type ChannelKind = "pull-requests" | "costs" | "reporting";
interface ReconciliationSubscriber {
  kind: "files" | ChannelKind;
  onReport?: (agentDir: string, signal: AbortSignal, assertLease: () => void) => Promise<void>;
  onPullRequest?: (update: WorkPullRequestUpdate) => void;
  onError?: (error: unknown) => void;
}
interface Supervisor extends ContinuationProgress {
  subscribers: Set<ReconciliationSubscriber>;
  controller: AbortController;
  nextRepository?: string;
  channels: Map<ChannelKind, Channel>;
}

/** Kimchi's runChannel (reconcile-supervisor.ts:75-98), unchanged. */
async function runChannel(
  owner: Supervisor,
  kind: ChannelKind,
  leaseSignal: AbortSignal,
  assertLease: () => void,
  run: (signal: AbortSignal, assertLease: () => void) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const channel = owner.channels.get(kind);
  if (!channel || channel.controller.signal.aborted) return;
  const signal = AbortSignal.any([leaseSignal, channel.controller.signal]);
  const pending = run(signal, () => {
    assertLease();
    signal.throwIfAborted();
  }).catch((error) => {
    if (!signal.aborted) onError(error);
  });
  channel.running = pending;
  try {
    await pending;
  } finally {
    if (channel.running === pending) channel.running = undefined;
  }
}

/** Kimchi's reportError (reconcile-supervisor.ts:199-207), unchanged. */
function reportError(owner: Supervisor, error: unknown): void {
  let reported = false;
  for (const subscriber of owner.subscribers) {
    if (!subscriber.onError) continue;
    subscriber.onError(error);
    reported = true;
  }
  if (!reported) debug("Reconciliation unavailable:", error);
}

/**
 * Kimchi's scan() (reconcile-supervisor.ts:100-197), line by line, with the Kimchi imports
 * replaced by the bridge's moved functions and HostPorts. The reporting subscriber's onReport
 * is the moved reconcileReporting bound to the session cwd, exactly as Kimchi's
 * pr-cost-reporting extension supplied it.
 */
async function oracleScan(agentDir: string, owner: Supervisor, cwd: string): Promise<void> {
  const directory = join(agentDir, "work-attribution"); // :101
  await mkdir(directory, { recursive: true, mode: 0o700 }); // :102
  let compromised: Error | undefined; // :103
  const leaseLost = new AbortController(); // :104
  const signal = AbortSignal.any([owner.controller.signal, leaseLost.signal]); // :105
  let release: () => Promise<void>; // :106
  try {
    release = await lock(directory, {
      retries: 0,
      stale: 5000,
      update: 1000,
      onCompromised: (error) => {
        compromised = error;
        leaseLost.abort();
      },
    }); // :108-116
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "ELOCKED"
    )
      return; // :118
    throw error; // :119
  }
  const assertLease = () => {
    signal.throwIfAborted();
    if (compromised) throw compromised;
  }; // :121-124
  const deadline = Date.now() + 3000; // :125 (PASS_BUDGET_MS)
  hostPorts().metric({ kind: "reconciliation" }); // :126 (trackPRCostMetric through HostPorts)
  const exhausted = new Error("Work attribution reconciliation time limit exceeded"); // :127
  const checkBudget = () => {
    assertLease();
    if (Date.now() > deadline) throw exhausted;
  }; // :128-131
  try {
    if ([...owner.subscribers].some((subscriber) => subscriber.kind === "files")) {
      // :133
      try {
        const shared: SharedTypeReads = {}; // :136
        const repositories = await knownTransitionRepositories(checkBudget); // :137 (moved file-transitions.ts:503)
        const start = Math.max(0, repositories.indexOf(owner.nextRepository ?? "")); // :138
        for (let offset = 0; offset < repositories.length; offset++) {
          checkBudget(); // :140
          const index = (start + offset) % repositories.length; // :141
          owner.nextRepository = repositories[(index + 1) % repositories.length]; // :143
          try {
            await reconcileRepositoryTransitions(
              repositories[index],
              signal,
              checkBudget,
              assertLease,
              shared,
            ); // :145 (moved file-transitions.ts:1184)
          } catch (error) {
            if (error === exhausted || signal.aborted) throw error; // :147
            debug("Could not reconcile repository %s: %o", repositories[index], error); // :148
          }
        }
      } catch (error) {
        if (error !== exhausted && !signal.aborted)
          debug("Could not discover repositories: %o", error); // :152
      }
    }
    await runChannel(
      owner,
      "pull-requests",
      signal,
      assertLease,
      (channelSignal, assertChannel) =>
        reconcileWorkPullRequests(agentDir, channelSignal, assertChannel, (update) => {
          for (const subscriber of owner.subscribers) subscriber.onPullRequest?.(update); // :163-165 (moved pull-requests.ts:454)
        }),
      (error) => reportError(owner, error), // :166
    ); // :157-167
    await runChannel(
      owner,
      "costs",
      signal,
      assertLease,
      (channelSignal, assertChannel) => reconcileWorkCosts(agentDir, channelSignal, assertChannel), // :173 (moved cost-sync.ts:370)
      (error) => debug("Could not reconcile costs: %o", error), // :174
    ); // :168-175
    if ([...owner.subscribers].some((subscriber) => subscriber.kind === "files")) {
      // :177
      try {
        await reconcileWorkContinuations(agentDir, signal, assertLease, owner); // :179 (moved links.ts:622; the Supervisor itself is the ContinuationProgress)
      } catch (error) {
        if (!signal.aborted) debug("Could not reconcile work continuations: %o", error); // :181
      }
    }
    const report = [...owner.subscribers].find(
      (subscriber) => subscriber.kind === "reporting",
    )?.onReport; // :184
    if (report)
      await runChannel(
        owner,
        "reporting",
        signal,
        assertLease,
        (channelSignal, assertChannel) => report(agentDir, channelSignal, assertChannel), // :191 (the moved reconcileReporting, bound to the session cwd)
        (error) => debug("Could not report PR costs: %o", error), // :192
      ); // :186-193
  } finally {
    if (!compromised) await release(); // :195
  }
}

function oracleOwner(lane: Lane): Supervisor {
  const owner: Supervisor = {
    subscribers: new Set(),
    controller: new AbortController(),
    channels: new Map(),
    nextRepository: undefined,
  };
  // Kimchi's subscriber registry: files (subscribeFileReconciliation :293), pull-requests
  // (:300), costs (:305) and reporting (:309), each registered once per process.
  owner.subscribers.add({ kind: "files" });
  owner.subscribers.add({
    kind: "pull-requests",
    onPullRequest: (update) => {
      lane.updates.push(update);
    },
  });
  owner.subscribers.add({ kind: "costs" });
  owner.subscribers.add({
    kind: "reporting",
    onReport: (agentDir, signal, assertLease) =>
      reconcileReporting(agentDir, lane.repo, signal, assertLease),
  });
  for (const kind of ["pull-requests", "costs", "reporting"] as const)
    owner.channels.set(kind, { controller: new AbortController() });
  return owner;
}

// --- The pass lane: the B3 worker harness around runReconciliationPass ----------------------

/** What the worker keeps between passes; exactly what PassResult hands back. */
interface WorkerState {
  nextRepository?: string;
  progress?: ContinuationProgress;
}

async function workerPass(lane: Lane, state: WorkerState): Promise<PassResult> {
  const controller = new AbortController();
  const leaseLost = new AbortController();
  let compromised: Error | undefined;
  const signal = AbortSignal.any([controller.signal, leaseLost.signal]);
  const directory = join(lane.agentDir, "work-attribution");
  let release: () => Promise<void>;
  try {
    release = await lock(directory, {
      retries: 0,
      stale: 5000,
      update: 1000,
      onCompromised: (error) => {
        compromised = error;
        leaseLost.abort();
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "ELOCKED"
    )
      throw new Error("unexpected lease contention inside a lane");
    throw error;
  }
  const assertLease = () => {
    signal.throwIfAborted();
    if (compromised) throw compromised;
  };
  try {
    return await runReconciliationPass(
      {
        files: true,
        pullRequests: {
          onUpdate: (update) => {
            lane.updates.push(update);
          },
        },
        costs: true,
        reporting: { cwd: lane.repo },
        nextRepository: state.nextRepository,
        progress: state.progress,
      },
      lane.host,
      { signal, assertLease },
    );
  } finally {
    if (!compromised) await release();
  }
}

// --- End-state dump ------------------------------------------------------------------------

const TABLES = [
  "meta",
  "journal_cursor",
  "work_records",
  "pending_translation",
  "work_projection_head",
  "work_projection_rows",
  "outbox_events",
  "outbox_batches",
  "delivery_state",
  "diagnostics",
  "bookkeeping",
  "work_dirty",
  "transition_repositories",
] as const;

function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value;
}

function walkFiles(agentDir: string, base: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (
      entry.name.endsWith(".lock") ||
      entry.name === "ledger.db" ||
      entry.name.startsWith("ledger.db-")
    )
      continue;
    const path = join(base, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walkFiles(agentDir, path, rel));
    else out[rel] = readFileSync(path, "utf8");
  }
  return out;
}

/** The batch id is the one random UUID on the delivery path; normalize it for comparison. */
function normalizeBody(body: string | null): string | null {
  if (body === null) return null;
  try {
    const parsed = JSON.parse(body) as { batch?: { id?: string } };
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.batch &&
      typeof parsed.batch.id === "string"
    ) {
      parsed.batch.id = "<batch>";
      return JSON.stringify(parsed);
    }
  } catch {
    // Not JSON: return as-is.
  }
  return body;
}

function dumpLane(lane: Lane): unknown {
  const db = new Database(ledgerDbPath(lane.agentDir), { readonly: true });
  const tables: Record<string, unknown> = {};
  for (const table of TABLES) {
    try {
      const rows = db.query(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all() as Record<
        string,
        unknown
      >[];
      tables[table] = rows.map((row) => {
        // journal_cursor's dev/ino are file-system identities of per-lane journal files.
        if (table === "journal_cursor") {
          delete row.dev;
          delete row.ino;
        }
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) out[key] = plain(value);
        return out;
      });
    } catch {
      tables[table] = "missing";
    }
  }
  db.close();
  return {
    tables,
    files: walkFiles(lane.agentDir, lane.agentDir),
    updates: lane.updates.map((update) => JSON.parse(JSON.stringify(update))),
    metrics: lane.metrics,
    receipts: lane.receipts.map((receipt) => ({
      method: receipt.method,
      url: receipt.url,
      body: normalizeBody(receipt.body),
    })),
  };
}

/** Rewrite the values a fixture cannot pin: random UUIDs Kimchi itself generates. */

// --- The driver entry: one lane, two passes, the end state on stdout -------------------------

async function main(): Promise<void> {
  const [root, mode] = process.argv.slice(2);
  if (!root || (mode !== "oracle" && mode !== "pass"))
    throw new Error("usage: driver <root> <oracle|pass>");
  freezeClock(T0);
  const lane = buildLane(root, mode);
  await seedFixture(lane);
  let nextRepository: string | undefined;
  let progressRetained = false;
  let settledJournals = false;
  let workerFirst: PassResult | undefined;
  let workerSecond: PassResult | undefined;
  if (mode === "oracle") {
    const owner = oracleOwner(lane);
    await withHostPorts(lane.host, () => oracleScan(lane.agentDir, owner, lane.repo));
    dispatchSecondRequest(lane);
    freezeClock(T1);
    await withHostPorts(lane.host, () => oracleScan(lane.agentDir, owner, lane.repo));
    nextRepository = owner.nextRepository;
    settledJournals = owner.settledJournals !== undefined;
  } else {
    const worker: WorkerState = {};
    const first = await workerPass(lane, worker);
    worker.nextRepository = first.nextRepository;
    worker.progress = first.progress;
    workerFirst = first;
    dispatchSecondRequest(lane);
    freezeClock(T1);
    const second = await workerPass(lane, worker);
    worker.nextRepository = second.nextRepository;
    worker.progress = second.progress;
    workerSecond = second;
    nextRepository = second.nextRepository;
    progressRetained = worker.progress !== undefined;
    settledJournals = worker.progress?.settledJournals !== undefined;
  }
  await flushWorkSummaries();
  closeBackends();
  process.stdout.write(
    `${JSON.stringify({
      dump: dumpLane(lane),
      worker: workerFirst === undefined ? undefined : { first: workerFirst, second: workerSecond },
      state: { nextRepository, progressRetained, settledJournals },
    })}\n`,
  );
}

await main();
