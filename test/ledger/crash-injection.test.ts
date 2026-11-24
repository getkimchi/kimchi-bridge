import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  closeBackends,
  readRecords,
  rebuildWork,
  readWorkSummary,
  setNote,
} from "../../src/ledger/records.js";
import { acquireWriterEpoch, ledgerDbPath, openStore } from "../../src/ledger/store.js";
import { setDefaultHostPorts } from "../../src/reconcile/host-ports.js";
import type { HostPorts } from "../../src/reconcile/host.js";
import {
  captureBillingSource,
  requestTagSelector,
} from "../../src/reconcile/work-attribution/billing-source.js";
import { spoolDirectory } from "../../src/ledger/records.js";
import { transitionJournal } from "../../src/reconcile/work-attribution/file-transitions.js";
import {
  digest,
  diskState,
  ignored,
  reflog,
  repositoryFile,
  referenceTips,
  saveHistoryBoundary,
} from "../../src/reconcile/work-attribution/file-transitions.js";
import { appendWorkRecord } from "../../src/reconcile/work-attribution.js";
import * as asyncFs from "node:fs/promises";

/**
 * Crash injection for the out-of-process reconciliation worker (reconcile-out-of-process plan,
 * chunk B4): randomized SIGKILLs of a REAL worker during REAL passes over a fixture in which
 * every channel writes — file-transition journals, billing cost sync and PR-cost event delivery
 * to a fake ingestion server — while a REAL capture-writer process keeps capturing records
 * through the contention, so the capture spool and the writer-lock paths are exercised too.
 *
 * After every kill, all of the plan's data-safety invariants are asserted:
 *   - `PRAGMA integrity_check` is ok;
 *   - every record captured before the kill is present (database or spool), never duplicated in
 *     the database, and — once the run's final passes drain the spool — present exactly once;
 *   - each projection equals a rebuild from authority;
 *   - no existing outbox event's body hash or ID changed;
 *   - no event is ACKed without a receipt in the fake server's log;
 *   - no event id is ever accepted by the fake server twice.
 *
 * The run count comes from CRASH_RUNS (CI uses 20); the pre-release full run uses 200. The
 * random seed comes from CRASH_SEED for reproducibility and is printed with the summary.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKER = join(ROOT, "src/worker/main.ts");
const BUILD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
const RUNS = Number(process.env.CRASH_RUNS ?? 20);
const SEED = Number(process.env.CRASH_SEED ?? Date.now() % 2147483647);

/** Deterministic identifiers for the fixture's accounts and work. */
const ORG = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";
const WRITER = "10000000-0000-4000-8000-000000000001";
const CAPTURE_WORK = "10000000-0000-4000-8000-000000000009";
const REQUEST1 = "20000000-0000-4000-8000-000000000001";
const BILLING_ROW = "50000000-0000-4000-8000-000000000001";
const PRODUCER = "60000000-0000-4000-8000-000000000001";
const DISPATCHED_AT = "2026-10-01T08:00:00.000Z";

/** One small PRNG so a failing run can be replayed exactly with CRASH_SEED. */
let randomState = SEED;
function random(): number {
  randomState = (randomState * 48271) % 2147483647;
  return randomState / 2147483647;
}

// --- The fake delivery server ----------------------------------------------------------------

interface ServerState {
  /** Every batchIngest request: the event ids it carried. */
  receipts: string[][];
  /** Event ids the server accepted, in order (a retry re-receipts, it does not re-accept). */
  accepted: string[];
  /** Events re-sent after acceptance with a different body or revision: the true duplicate. */
  conflicts: { id: string; reason: string }[];
  /** The revision each event id first arrived with. */
  revisions: Map<string, string>;
}

function startServer(): { state: ServerState; url: string; stop: () => Promise<void> } {
  const state: ServerState = { receipts: [], accepted: [], conflicts: [], revisions: new Map() };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const method = request.method;
      const path = url.pathname;
      if (method === "POST" && path.endsWith("/api-keys:verify"))
        return Response.json({ organizationId: ORG, userId: USER });
      if (method === "GET" && path.includes("/llm-requests"))
        return Response.json({
          totalCount: 1,
          items: [{ id: BILLING_ROW, castaiApiKeyOwnerId: USER, totalPrice: "1.25" }],
        });
      if (method === "POST" && path.endsWith("/pr-cost-snapshots"))
        return Response.json({
          status: "accepted",
          revision: `sha256:${"a".repeat(40)}`,
          receivedAt: new Date().toISOString(),
        });
      if (method === "POST" && path.endsWith("/pr-cost-events:batchIngest")) {
        const body = request.text();
        return body.then((text) => {
          const parsed = JSON.parse(text) as {
            batch?: {
              id?: string;
              events?: { id: string; revision: string; [key: string]: unknown }[];
            };
          };
          const events = parsed.batch?.events ?? [];
          state.receipts.push(events.map((event) => event.id));
          // The ingestion endpoint is idempotent by event id: a retry after a lost
          // acknowledgement re-receipts the same events. What it must never see is one
          // event id returning with a different body or revision — that is the duplicate
          // upload the crash test is hunting.
          for (const event of events) {
            if (!state.accepted.includes(event.id)) continue;
            if (event.revision !== (state.revisions.get(event.id) ?? ""))
              state.conflicts.push({ id: event.id, reason: "revision changed on a retry" });
          }
          for (const event of events) state.revisions.set(event.id, event.revision);
          for (const event of events)
            if (!state.accepted.includes(event.id)) state.accepted.push(event.id);
          return Response.json({
            batchId: parsed.batch?.id,
            receiveTime: new Date().toISOString(),
            receipts: events.map((event) => ({
              id: event.id,
              status: "accepted",
              revision: event.revision,
            })),
          });
        });
      }
      return new Response("no route", { status: 404 });
    },
  });
  return { state, url: `http://127.0.0.1:${server.port}/api`, stop: () => server.stop(true) };
}

// --- The fixture: one repository whose every channel writes ----------------------------------

function git(repo: string, root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: root,
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z",
    },
  }).trim();
}

/** The tracked edit the pass-equivalence driver captures: a real file_transition journal row. */
async function trackedEdit(
  repo: string,
  session: string,
  workId: string,
  from: string,
  to: string,
): Promise<void> {
  const toolCallId = "crash-write-call";
  const path = join(repo, "file.txt");
  let readDigest: string | undefined;
  const content = readFileSync(path, "utf8");
  readDigest = digest(readFileSync(path));
  void readDigest;
  const repoFile = await repositoryFile(path);
  const before =
    repoFile === undefined
      ? undefined
      : await diskState(path, undefined, repoFile.repository);
  if (before === undefined || repoFile === undefined)
    throw new Error("fixture edit left the repository");
  await asyncFs.writeFile(path, content.replace(from, to), "utf8");
  const written = readFileSync(path);
  const retain = !(await ignored(repoFile.worktree, repoFile.path));
  const after = await diskState(path, written, retain ? repoFile.repository : undefined);
  if (!after) throw new Error("fixture edit produced no disk state");
  const log = await reflog(repoFile.worktree);
  if (log.length && log[log.length - 1] !== 10) throw new Error("fixture edit raced a reflog");
  const historyBoundaryId = await saveHistoryBoundary(
    await referenceTips(repoFile.repository, repoFile.baseline),
  );
  appendWorkRecord(
    { cwd: repo, sessionManager: { getSessionId: () => session } },
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
}

interface Fixture {
  root: string;
  agentDir: string;
  repo: string;
  api: string;
}

function seedFixture(api: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "kimchi-crash-"));
  const agentDir = join(root, "agent");
  const repo = join(root, "repo");
  mkdirSync(join(repo, "agent"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "session"), { recursive: true });
  git(repo, root, "init", "-q", "-b", "main");
  git(repo, root, "config", "user.name", "Test");
  git(repo, root, "config", "user.email", "test@example.test");
  // An established reporting producer, so event identities are deterministic.
  mkdirSync(join(agentDir, "pr-cost-reporting"), { recursive: true });
  writeFileSync(
    join(agentDir, "pr-cost-reporting", "state.json"),
    `${JSON.stringify({
      version: 1,
      enabled: true,
      followsTelemetry: true,
      producerId: PRODUCER,
      entries: {},
    })}\n`,
    "utf8",
  );
  setNote(
    agentDir,
    "agent",
    "reporting-producer",
    `${JSON.stringify({ version: 1, producerId: PRODUCER })}\n`,
  );
  // A baseline commit, a tracked edit in the writer session, and the commit it becomes.
  writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
  git(repo, root, "add", ".");
  git(repo, root, "commit", "-qm", "baseline");
  return { root, agentDir, repo, api };
}

/** The fake server's origin, without its /api path suffix (no regex: a plain endsWith). */
function apiOrigin(api: string): string {
  return api.endsWith("/api") ? api.slice(0, api.length - "/api".length) : api;
}

/** The fixture's host answers, used both for the in-process seeding and the wire replies. */
function seedHost(fixture: Fixture): HostPorts {
  const origin = apiOrigin(fixture.api);
  return {
    get agentDir() {
      return fixture.agentDir;
    },
    e2eSeam: () => undefined,
    now: () => Date.now(),
    credentials: () => ({ token: "crash-test-token", apiUrl: fixture.api }),
    gitToken: () => undefined,
    endpoints: () => ({
      llmEndpoint: `${origin}/gateway`,
      openAiBaseUrl: `${origin}/gateway/openai/v1`,
      anthropicBaseUrl: `${origin}/gateway/anthropic`,
      experimentalOpenAiBaseUrl: `${origin}/gateway/experimental`,
      platformApiUrl: fixture.api,
    }),
    orgPolicy: () => ({ resourceEnabled: () => true }),
    telemetryConsent: () => true,
    metric: () => {},
    fetch: () => Promise.reject(new Error("the seeding host never fetches")),
  };
}

// --- The capture-writer child ------------------------------------------------------------------

const CAPTURE_WRITER = `
const { capture, closeBackends } = await import(process.argv[2]);
const dir = process.argv[3];
const log = process.argv[4];
let n = 0;
const tick = () => {
  for (let i = 0; i < 2; i++) {
    n += 1;
    const requestId = "70000000-0000-4000-8000-" + String(n).padStart(12, "0");
    capture(
      dir,
      {
        version: 1,
        type: "request",
        workId: "10000000-0000-4000-8000-000000000009",
        sessionId: "capture-writer",
        requestId,
        scope: null,
        recordedAt: new Date().toISOString(),
      },
      "crash-writer",
    );
    require("node:fs").appendFileSync(log, requestId + "\\n");
  }
};
setInterval(tick, 25);
process.on("SIGTERM", () => {
  closeBackends();
  process.exit(0);
});
`;

// --- The worker driver -------------------------------------------------------------------------

interface DoneResult {
  outcome: string;
}

interface WorkerHandle {
  send(message: unknown): void;
  /** Answers every unanswered host request once; returns the pass's done result when it lands. */
  poll(replies: Record<string, unknown>, id: number): DoneResult | undefined;
  killNow(): void;
  stop(): Promise<void>;
}

function spawnWorker(dir: string): WorkerHandle {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER],
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const lines: string[] = [];
  let waiter: (() => void) | undefined;
  const read = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") {
          lines.push(line);
          const listener = waiter;
          waiter = undefined;
          listener?.();
        }
      }
    }
  })();
  const heartbeats = setInterval(() => {
    if (proc.exitCode !== null) return;
    proc.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    proc.stdin.flush();
  }, 300);
  const send = (message: unknown): void => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  const parsed = (): { type: string; [key: string]: unknown }[] =>
    lines.map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
  const replied = new Set<number>();
  return {
    send,
    poll(replies, id) {
      for (const message of parsed()) {
        if (message.type !== "request") continue;
        if (replied.has(message.rid as number)) continue;
        replied.add(message.rid as number);
        send({
          type: "reply",
          rid: message.rid,
          result: replies[String(message.kind)],
        });
      }
      return parsed().find(
        (message) => message.type === "done" && message.id === id,
      ) as unknown as DoneResult | undefined;
    },
    killNow() {
      proc.kill("SIGKILL");
    },
    async stop() {
      clearInterval(heartbeats);
      if (proc.exitCode === null) {
        proc.stdin.end();
        const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
        await proc.exited;
        clearTimeout(timer);
      }
      await read;
    },
  };
}

const REPLIES = (api: string): Record<string, unknown> => ({
  credentials: { token: "crash-test-token", apiUrl: api },
  gitToken: {},
  endpoints: {
    llmEndpoint: "http://127.0.0.1:1",
    openAiBaseUrl: "http://127.0.0.1:1/openai/v1",
    anthropicBaseUrl: "http://127.0.0.1:1/anthropic",
    experimentalOpenAiBaseUrl: "http://127.0.0.1:1/experimental",
    platformApiUrl: api,
  },
  policy: { resources: { "extensions.cost-per-pr": true } },
  consent: { consent: true },
});

/** Sends one pass with a freshly acquired epoch, and answers its host requests until done. */
async function runPass(
  worker: WorkerHandle,
  fixture: Fixture,
  id: number,
  timeoutMs: number,
): Promise<boolean> {
  const replies = REPLIES(fixture.api);
  const store = openStore(fixture.agentDir);
  let epoch: number;
  try {
    epoch = acquireWriterEpoch(store);
  } finally {
    store.close();
  }
  worker.send({
    type: "pass",
    id,
    channels: { files: true, costs: true, reporting: true },
    reportingCwd: join(fixture.root, "session"),
    deadlineMs: 30000,
    epoch,
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const done = worker.poll(replies, id);
    if (done !== undefined) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// --- The invariants ---------------------------------------------------------------------------

interface OutboxRow {
  id: string;
  hash: string;
  acked_at: number | null;
}

function outboxRows(dir: string): OutboxRow[] {
  const db = new Database(ledgerDbPath(dir), { create: false });
  try {
    return db
      .query<OutboxRow, []>("SELECT id, hash, acked_at FROM outbox_events ORDER BY id")
      .all();
  } finally {
    db.close();
  }
}

/** Request ids of the capture writer's records in the ledger. */
function storedCaptureIds(dir: string): string[] {
  return readRecords(dir)
    .filter((row) => row.type === "request" && row.sessionId === "capture-writer")
    .map((row) => (row as { requestId?: string }).requestId ?? "");
}

/** Request ids still parked in capture spool files. */
function spooledCaptureIds(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(spoolDirectory(dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(spoolDirectory(dir), name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"requestId"')) continue;
      try {
        const parsed = JSON.parse(line) as { requestId?: string; sessionId?: string };
        if (parsed.sessionId === "capture-writer" && parsed.requestId) out.push(parsed.requestId);
      } catch {
        // A torn tail line: the importer's self-delimiting format re-reads it whole later.
      }
    }
  }
  return out;
}

function assertInvariants(dir: string, before: OutboxRow[], server: ServerState): void {
  // The database is intact.
  const db = new Database(ledgerDbPath(dir), { create: false });
  try {
    const check = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    expect(check.map((row) => row.integrity_check)).toEqual(["ok"]);
  } finally {
    db.close();
  }
  // No existing outbox event's id or body hash changed, and no row disappeared.
  const after = outboxRows(dir);
  const afterById = new Map(after.map((row) => [row.id, row]));
  for (const row of before) {
    const now = afterById.get(row.id);
    expect(now, `event ${row.id} disappeared after a kill`).toBeDefined();
    expect(now?.hash).toBe(row.hash);
  }
  // No event is ACKed without the server having received it, and no event twice.
  for (const row of after) {
    if (row.acked_at === null) continue;
    expect(server.receipts.flat(), `acked event ${row.id} has no server receipt`).toContain(
      row.id,
    );
  }
  expect(server.conflicts).toEqual([]);
  // Every projection equals a rebuild from authority. The capture writer's own work keeps
  // growing while the check runs (its process survives the kill), so its projection is proven
  // as an exact prefix of the authority instead — the same invariant without freezing the
  // writer mid-transaction.
  const store = openStore(dir);
  let works: { workId: string }[];
  try {
    works = store.db.query<{ workId: string }, []>(
      "SELECT DISTINCT work_id AS workId FROM work_records",
    ).all();
  } finally {
    store.close();
  }
  for (const { workId } of works) {
    const stored = readWorkSummary(dir, workId);
    if (workId === CAPTURE_WORK) {
      const requests = (stored?.requests ?? []) as unknown as { requestId?: string }[];
      // The authority is read after the stored summary: the live capture writer can only have
      // added to it, so a projection that is an exact prefix now proves no torn or reordered
      // fold, whatever else lands afterwards.
      const expected = readRecords(dir)
        .filter((row) => row.workId === workId)
        .map((row) => (row as { requestId?: string }).requestId);
      expect(requests.length).toBeLessThanOrEqual(expected.length);
      expect(requests.map((row) => row.requestId)).toEqual(
        expected.slice(0, requests.length),
      );
      continue;
    }
    const rebuilt = readWorkSummary(dir, workId);
    rebuildWork(dir, workId);
    const after = readWorkSummary(dir, workId);
    expect(JSON.stringify(after)).toBe(JSON.stringify(rebuilt));
  }
}

// --- The run ------------------------------------------------------------------------------------

test("randomized SIGKILLs of the worker during passes keep the ledger safe", async () => {
  const server = startServer();
  const fixture = seedFixture(server.url);
  const serverState = server.state;
  const captureLog = join(fixture.root, "capture-writer.log");
  const children: ReturnType<typeof spawn>[] = [];
  try {
    setDefaultHostPorts(seedHost(fixture));
    const gitDir = realpathSync(join(fixture.repo, ".git"));
    // The writer session's request, dispatched through the gateway the billing source captured.
    appendWorkRecord(
      { cwd: fixture.repo, sessionManager: { getSessionId: () => "writer" } },
      {
        type: "request",
        requestId: REQUEST1,
        startedAt: DISPATCHED_AT,
        scope: {
          account: { apiUrl: server.url, organizationId: ORG, userId: USER },
          repository: gitDir,
        },
      },
      WRITER,
    );
    const origin = apiOrigin(server.url);
    const source = captureBillingSource(
      new Headers({ Authorization: "Bearer crash-test-token" }),
      `${origin}/gateway/openai/v1/chat/completions`,
      fixture.repo,
    );
    if (!source) throw new Error("fixture billing source capture failed");
    const selector = requestTagSelector(REQUEST1, DISPATCHED_AT);
    if (!selector) throw new Error("fixture billing selector build failed");
    appendWorkRecord(
      { cwd: fixture.repo, sessionManager: { getSessionId: () => "writer" } },
      {
        type: "request_dispatch",
        requestId: REQUEST1,
        dispatchedAt: DISPATCHED_AT,
        billingSource: source,
        billingSelector: selector,
      },
      WRITER,
    );
    await trackedEdit(fixture.repo, "writer", WRITER, "one", "first");
    git(fixture.repo, fixture.root, "add", ".");
    git(fixture.repo, fixture.root, "commit", "-qm", "feature");
    // The parallel capture writer: a real process capturing through the worker's writes.
    const writerScript = join(fixture.root, "capture-writer.ts");
    writeFileSync(writerScript, CAPTURE_WRITER, "utf8");
    const writerChild = spawn(
      process.execPath,
      [writerScript, join(ROOT, "src/ledger/records.ts"), fixture.agentDir, captureLog],
      { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
    );
    children.push(writerChild);
    await new Promise((resolve) => setTimeout(resolve, 300));

    let passId = 0;
    const summary = { kills: 0, passes: 0, records: 0, events: 0, spooled: 0 };
    for (let run = 0; run < RUNS; run++) {
      const worker = spawnWorker(fixture.agentDir);
      try {
        worker.send({
          type: "hello",
          v: 1,
          build: BUILD,
          agentDir: fixture.agentDir,
        });
        const before = outboxRows(fixture.agentDir);
        const killAfter = 150 + Math.floor(random() * 2350);
        const startedAt = Date.now();
        for (;;) {
          const left = killAfter - (Date.now() - startedAt);
          if (left <= 0) {
            worker.killNow();
            summary.kills += 1;
            break;
          }
          passId += 1;
          const finished = await runPass(worker, fixture, passId, Math.min(left + 40, 4000));
          if (finished) summary.passes += 1;
        }
        // The kill's invariants: intact, no loss, no rewrite, no unreceipted ACK.
        const logged = existsSync(captureLog)
          ? readFileSync(captureLog, "utf8").split("\n").filter((line) => line !== "")
          : [];
        summary.records = Math.max(summary.records, logged.length);
        const stored = storedCaptureIds(fixture.agentDir);
        const spooled = spooledCaptureIds(fixture.agentDir);
        for (const requestId of logged) {
          const inDb = stored.filter((id) => id === requestId).length;
          expect(inDb, `captured record ${requestId} duplicated in the database`).toBeLessThan(2);
          expect(
            inDb + spooled.filter((id) => id === requestId).length,
            `captured record ${requestId} was lost by the kill`,
          ).toBeGreaterThan(0);
        }
        assertInvariants(fixture.agentDir, before, serverState);
        summary.events = outboxRows(fixture.agentDir).length;
      } finally {
        await worker.stop();
      }
    }

    // The final drain: fresh worker, passes until the spool is empty and two passes in a row
    // change nothing, then the run's closing assertions.
    const worker = spawnWorker(fixture.agentDir);
    try {
      worker.send({ type: "hello", v: 1, build: BUILD, agentDir: fixture.agentDir });
      let lastSignature = "";
      for (let attempt = 0; attempt < 12; attempt++) {
        passId += 1;
        const finished = await runPass(worker, fixture, passId, 10_000);
        if (!finished) continue;
        summary.passes += 1;
        const signature = JSON.stringify([
          outboxRows(fixture.agentDir).map((row) => [row.id, row.hash, row.acked_at]),
          storedCaptureIds(fixture.agentDir).length,
          spooledCaptureIds(fixture.agentDir).length,
        ]);
        if (signature === lastSignature) break;
        lastSignature = signature;
      }
    } finally {
      await worker.stop();
    }
    const logged = readFileSync(captureLog, "utf8").split("\n").filter((line) => line !== "");
    const stored = storedCaptureIds(fixture.agentDir);
    for (const requestId of logged)
      expect(stored.filter((id) => id === requestId)).toHaveLength(1);
    expect(spooledCaptureIds(fixture.agentDir)).toEqual([]);
    const finalOutbox = outboxRows(fixture.agentDir);
    for (const row of finalOutbox)
      expect(
        serverState.receipts.flat(),
        `acked event ${row.id} has no server receipt`,
      ).toContain(row.id);
    expect(serverState.conflicts).toEqual([]);
    summary.events = finalOutbox.length;
    summary.records = logged.length;
    console.log(
      `crash-injection summary: seed=${SEED} runs=${RUNS} kills=${summary.kills} passes=${summary.passes} captureRecords=${summary.records} outboxEvents=${summary.events} spooledLeft=${summary.spooled} conflicts=${serverState.conflicts.length}`,
    );
    expect(summary.kills).toBe(RUNS);
    expect(finalOutbox.length).toBeGreaterThan(0);
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await server.stop();
    closeBackends();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 1000 * (Number(process.env.CRASH_TIMEOUT_S ?? 240)));