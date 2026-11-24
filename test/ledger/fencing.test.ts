import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "bun:test";
import type { WorkRecord } from "../../src/ledger/work-record.js";
import {
  backendFor,
  capture,
  closeBackends,
  diagnostic,
  readRecords,
  setNote,
} from "../../src/ledger/records.js";
import {
  acquireWriterEpoch,
  LedgerFencedError,
  openStore,
  readWriterEpoch,
  withLedgerWriteFence,
} from "../../src/ledger/store.js";
import { runReconciliationPass } from "../../src/reconcile/pass.js";
import { withHostPorts } from "../../src/reconcile/host-ports.js";
import {
  recordReportingError,
  setReportingEnabled,
} from "../../src/reconcile/pr-cost-reporting/queue.js";
import type { HostPorts } from "../../src/reconcile/host.js";

/**
 * Writer-epoch fencing against the real SQLite backend: a lease holder bumps meta.writer_epoch in
 * one IMMEDIATE transaction, and a connection fenced to the old epoch aborts its next write
 * transaction whole (nothing written) once the epoch moved — including when the new holder is a
 * real second process. Unfenced connections (session-side capture) are never affected, and the
 * reconciliation pass plumbs its input epoch onto its own connection before any channel runs.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-fence-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function record(workId: string, requestId: string): WorkRecord {
  return {
    version: 1,
    type: "request",
    workId,
    sessionId: "session",
    requestId,
    scope: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
  };
}

/** Two rows the fenced tx below tries to write; the test proves neither lands. */
const PROBE_ROWS = [
  "INSERT INTO work_records (record_hash, type, work_id, session_id, body, source_path, source_generation, imported_at) VALUES ('fence-a', 'request', 'w', 's', '{}', '', 0, 0)",
  "INSERT INTO pending_translation (record_hash, work_id, type, created_at) VALUES ('fence-a', 'w', 'request', 0)",
];

it("acquireWriterEpoch counts up from a missing row, which reads as 0", () => {
  const dir = agentDir();
  const store = openStore(dir);
  try {
    expect(readWriterEpoch(store.db)).toBe(0);
    expect(acquireWriterEpoch(store)).toBe(1);
    expect(acquireWriterEpoch(store)).toBe(2);
    expect(readWriterEpoch(store.db)).toBe(2);
  } finally {
    store.close();
  }
});

it("a fenced store's next tx aborts whole after another connection bumps the epoch", () => {
  const dir = agentDir();
  const stale = openStore(dir);
  const fresh = openStore(dir);
  try {
    const mine = acquireWriterEpoch(fresh);
    stale.fence(mine);
    // Another holder acquires the lease and bumps the epoch.
    const next = acquireWriterEpoch(fresh);
    expect(next).toBe(mine + 1);
    expect(() =>
      stale.tx(() => {
        for (const sql of PROBE_ROWS) stale.db.run(sql);
      }),
    ).toThrow(LedgerFencedError);
    // Nothing was written: the transaction rolled back before any statement of fn ran.
    expect(fresh.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({ n: 0 });
    expect(fresh.db.query("SELECT COUNT(*) AS n FROM pending_translation").get()).toEqual({
      n: 0,
    });
    // Reads stay unfenced, and a re-fenced store with the current epoch writes again.
    expect(readWriterEpoch(stale.db)).toBe(next);
    stale.fence(next);
    stale.tx(() => stale.db.run(PROBE_ROWS[0]));
    expect(fresh.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({ n: 1 });
  } finally {
    stale.close();
    fresh.close();
  }
});

it("unfenced capture still works while another, fenced connection is stale", () => {
  const dir = agentDir();
  // The capture path's own connection (backendFor), never fenced by the pass.
  expect(readRecords(dir)).toHaveLength(0);
  const stale = openStore(dir);
  const holder = openStore(dir);
  try {
    stale.fence(acquireWriterEpoch(holder));
    acquireWriterEpoch(holder);
    // stale is fenced out, but capture writes through its own unfenced connection.
    capture(dir, record("00000000-0000-4000-8000-000000000001", "req-1"), "summary-native");
    expect(readRecords(dir)).toHaveLength(1);
  } finally {
    stale.close();
    holder.close();
  }
});

/** Runs script in a real second Bun process, returning its parsed last stdout line. */
function bunEval(script: string): Record<string, unknown> {
  const run = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, timeout: 60_000 });
  if (run.exitCode !== 0)
    throw new Error(`bun -e child failed (${run.exitCode}): ${run.stderr.toString()}`);
  const line = run.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((value) => value.startsWith("{"))
    .at(-1);
  if (!line) throw new Error("bun -e child produced no JSON line");
  return JSON.parse(line) as Record<string, unknown>;
}

it("a real second process bumping the epoch fences the first connection out", () => {
  const dir = agentDir();
  const mine = openStore(dir);
  try {
    mine.fence(acquireWriterEpoch(mine));
    // A real child process (another Kimchi release taking the lease) bumps the epoch.
    const result = bunEval(
      `const { openStore, acquireWriterEpoch } = await import(${JSON.stringify(`${ROOT}src/ledger/store.js`)});
const store = openStore(${JSON.stringify(dir)});
const epoch = acquireWriterEpoch(store);
store.close();
console.log(JSON.stringify({ epoch }));`,
    );
    expect(result.epoch).toBe(2);
    expect(() =>
      mine.tx(() => {
        for (const sql of PROBE_ROWS) mine.db.run(sql);
      }),
    ).toThrow(LedgerFencedError);
    const after = openStore(dir);
    try {
      expect(after.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({ n: 0 });
      expect(readWriterEpoch(after.db)).toBe(2);
    } finally {
      after.close();
    }
  } finally {
    mine.close();
  }
});

/** The minimal host the pass needs; nothing here touches the network because only files runs. */
function passHost(agentDirectory: string): HostPorts {
  return {
    agentDir: agentDirectory,
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

/** One journal with one record, so the files channel's hydration import is the pass's write. */
function seedJournal(dir: string): void {
  mkdirSync(join(dir, "work-attribution"), { recursive: true });
  writeFileSync(
    join(dir, "work-attribution", "legacy.jsonl"),
    `${JSON.stringify(record("00000000-0000-4000-8000-000000000001", "req-1"))}\n`,
  );
}

it("a pass granted the live epoch imports; a stale epoch writes nothing", async () => {
  const live = agentDir();
  seedJournal(live);
  const holder = openStore(live);
  try {
    const epoch = acquireWriterEpoch(holder);
    await runReconciliationPass({ files: true, epoch }, passHost(live), {
      signal: new AbortController().signal,
      assertLease: () => {},
    });
    expect(readRecords(live)).toHaveLength(1);
  } finally {
    holder.close();
  }

  const stale = agentDir();
  seedJournal(stale);
  const writer = openStore(stale);
  try {
    const epoch = acquireWriterEpoch(writer);
    // Another holder takes the lease after this pass was granted its epoch.
    const other = openStore(stale);
    try {
      acquireWriterEpoch(other);
    } finally {
      other.close();
    }
    await runReconciliationPass({ files: true, epoch }, passHost(stale), {
      signal: new AbortController().signal,
      assertLease: () => {},
    });
    // Fenced out: the journal import wrote nothing, and the ledger is exactly as it was.
    expect(readRecords(stale)).toHaveLength(0);
    expect(readWriterEpoch(writer.db)).toBe(epoch + 1);
  } finally {
    writer.close();
  }
}, 30_000);

it("an inline pass fenced out by a later handover does not fence the session's capture", async () => {
  const dir = agentDir();
  seedJournal(dir);
  const writer = openStore(dir);
  try {
    const epoch = acquireWriterEpoch(writer);
    const other = openStore(dir);
    try {
      acquireWriterEpoch(other);
    } finally {
      other.close();
    }
    await runReconciliationPass({ files: true, epoch }, passHost(dir), {
      signal: new AbortController().signal,
      assertLease: () => {},
    });
    // The stale pass wrote nothing...
    expect(readRecords(dir)).toHaveLength(0);
    // ...and the same process's session capture still commits after the handover: the pass's
    // fence is scoped to the pass, never to the process's cached capture connection.
    capture(dir, record("00000000-0000-4000-8000-000000000002", "req-2"), "summary-native");
    expect(readRecords(dir)).toHaveLength(1);
  } finally {
    writer.close();
  }
}, 30_000);

it("a fence whose writable hook throws writes nothing even when the epoch never moved", async () => {
  const dir = agentDir();
  seedJournal(dir);
  const holder = openStore(dir);
  try {
    // An old release acquires the lease next without ever bumping the epoch, so the epoch check
    // alone cannot stop this stale pass: only the fence's writable hook can (the parent-heartbeat
    // check the worker wires to it).
    const epoch = acquireWriterEpoch(holder);
    // The hook aborts every fenced write: the pass fails its channel (loudly, so the worker can
    // report and exit) or completes having written nothing — either way the ledger is untouched.
    await runReconciliationPass(
      {
        files: true,
        epoch,
        assertWritable: () => {
          throw new Error("parent heartbeat lost");
        },
      },
      passHost(dir),
      { signal: new AbortController().signal, assertLease: () => {} },
    ).catch(() => {});
    expect(readRecords(dir)).toHaveLength(0);
  } finally {
    holder.close();
  }
}, 30_000);

it("a stale pass's notes, diagnostics and cursor bookkeeping write nothing", () => {
  const dir = agentDir();
  // Open the backend outside the fence, as the session process long since did.
  expect(backendFor(dir).getNote("w", "note")).toBeUndefined();
  const holder = openStore(dir);
  try {
    const epoch = acquireWriterEpoch(holder);
    const other = openStore(dir);
    try {
      acquireWriterEpoch(other);
    } finally {
      other.close();
    }
    withLedgerWriteFence({ agentDir: dir, epoch, assertWritable: () => {} }, () => {
      expect(() => setNote(dir, "w", "note", "body")).toThrow(LedgerFencedError);
      expect(() => diagnostic(dir, "fence-probe")).toThrow(LedgerFencedError);
    });
    expect(backendFor(dir).getNote("w", "note")).toBeUndefined();
    const probe = openStore(dir);
    try {
      expect(
        probe.db.query("SELECT COUNT(*) AS n FROM diagnostics WHERE code = 'fence-probe'").get(),
      ).toEqual({ n: 0 });
    } finally {
      probe.close();
    }
  } finally {
    holder.close();
  }
});

it("backend-open projection maintenance reached from a stale fenced pass writes nothing", () => {
  const dir = agentDir();
  const seeder = openStore(dir);
  try {
    // A stale projection version forces the next backend construction to clear and restamp it.
    seeder.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('projectionVersion', '0')");
    seeder.db.run(
      "INSERT INTO work_projection_rows (work_id, log, key, pos, body) VALUES ('w', 'sessions', 'k', 1, '{}')",
    );
    seeder.close();
  } catch (error) {
    seeder.close();
    throw error;
  }
  const holder = openStore(dir);
  try {
    const epoch = acquireWriterEpoch(holder);
    const other = openStore(dir);
    try {
      acquireWriterEpoch(other);
    } finally {
      other.close();
    }
    withLedgerWriteFence({ agentDir: dir, epoch, assertWritable: () => {} }, () => {
      expect(() => backendFor(dir)).toThrow(LedgerFencedError);
    });
    closeBackends();
    const check = openStore(dir);
    try {
      expect(
        check.db.query("SELECT value FROM meta WHERE key = 'projectionVersion'").get(),
      ).toEqual({ value: "0" });
      expect(check.db.query("SELECT COUNT(*) AS n FROM work_projection_rows").get()).toEqual({
        n: 1,
      });
    } finally {
      check.close();
    }
  } finally {
    holder.close();
  }
});

it("a stale pass's reporting-queue error note writes no queue state", async () => {
  const dir = agentDir();
  await withHostPorts(passHost(dir), () => setReportingEnabled(dir, true));
  const statePath = join(dir, "pr-cost-reporting", "state.json");
  const before = readFileSync(statePath, "utf8");
  const holder = openStore(dir);
  try {
    const epoch = acquireWriterEpoch(holder);
    const other = openStore(dir);
    try {
      acquireWriterEpoch(other);
    } finally {
      other.close();
    }
    await withHostPorts(passHost(dir), () =>
      withLedgerWriteFence({ agentDir: dir, epoch, assertWritable: () => {} }, async () => {
        await expect(recordReportingError(dir, "capture failed")).rejects.toThrow(
          LedgerFencedError,
        );
      }),
    );
    expect(readFileSync(statePath, "utf8")).toBe(before);
  } finally {
    holder.close();
  }
}, 30_000);

// --- The worker across a lease handover: two real processes, SIGSTOP ------------------------

/** The worker entry, driven as the real child the bridge release ships. */
const WORKER_ENTRY = join(ROOT, "src/worker/main.ts");

/** A real worker process with the fake parent's pipe, plus heartbeats while it lives. */
interface WorkerChild {
  send(message: unknown): void;
  next(): Promise<{ type: string; [key: string]: unknown }>;
  stop(): void;
  exitCode(): Promise<number>;
  /** Freezes the whole process, reader thread included. */
  pause(): void;
  resume(): void;
  /** Sends the lease heartbeat every 500 ms; pause() stops it, like a parent that lost its lease. */
  startHeartbeats(): void;
}

function spawnWorkerChild(dir: string): WorkerChild {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER_ENTRY],
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const lines: string[] = [];
  const read = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== "") lines.push(line);
      }
    }
  })();
  let heartbeats: ReturnType<typeof setInterval> | undefined;
  const child: WorkerChild = {
    send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    },
    async next() {
      for (;;) {
        const line = lines.shift();
        if (line) return JSON.parse(line) as { type: string; [key: string]: unknown };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    stop() {
      if (heartbeats !== undefined) clearInterval(heartbeats);
      if (proc.exitCode === null) proc.kill();
    },
    async exitCode() {
      await read;
      await proc.exited;
      return proc.exitCode ?? 0;
    },
    pause() {
      if (heartbeats !== undefined) clearInterval(heartbeats);
      heartbeats = undefined;
      process.kill(proc.pid as number, "SIGSTOP");
    },
    resume() {
      process.kill(proc.pid as number, "SIGCONT");
    },
    startHeartbeats() {
      if (heartbeats !== undefined) return;
      heartbeats = setInterval(() => {
        if (proc.exitCode !== null) return;
        proc.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
        proc.stdin.flush();
      }, 500);
    },
  };
  void proc.exited.then(() => {
    if (heartbeats !== undefined) clearInterval(heartbeats);
  });
  return child;
}

/** Reads one done message for the given pass id, answering host requests with fake replies. */
async function answerUntilDone(
  worker: WorkerChild,
  id: number,
): Promise<{ outcome: string; channels: Record<string, { outcome: string; error?: string }> }> {
  const replies: Record<string, unknown> = {
    credentials: { token: "fence-test-token", apiUrl: "http://127.0.0.1:1" },
    gitToken: {},
    endpoints: {
      llmEndpoint: "http://127.0.0.1:1",
      openAiBaseUrl: "http://127.0.0.1:1/openai/v1",
      anthropicBaseUrl: "http://127.0.0.1:1/anthropic",
      experimentalOpenAiBaseUrl: "http://127.0.0.1:1/experimental",
      platformApiUrl: "http://127.0.0.1:1",
    },
    policy: { resources: { "extensions.cost-per-pr": true } },
    consent: { consent: false },
  };
  for (;;) {
    const message = await worker.next();
    if (message.type === "request")
      worker.send({ type: "reply", rid: message.rid, result: replies[String(message.kind)] });
    if (message.type === "done" && message.id === id) return message.result as never;
  }
}

it("a worker paused across an epoch handover cannot commit after resuming", async () => {
  const dir = agentDir();
  seedJournal(dir);
  // The first parent acquires the lease and its epoch, then grants a pass to its worker.
  const first = openStore(dir);
  let epoch: number;
  try {
    epoch = acquireWriterEpoch(first);
  } finally {
    first.close();
  }
  const worker = spawnWorkerChild(dir);
  try {
    worker.send({
      type: "hello",
      v: 1,
      build: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim(),
      agentDir: dir,
    });
    const ready = await worker.next();
    expect(ready.type).toBe("ready");
    // The parent heartbeats while the worker holds the granted pass, so only the epoch can
    // fence the resumed worker.
    worker.startHeartbeats();
    worker.send({ type: "pass", id: 7, channels: { files: true }, deadlineMs: 30000, epoch });
    // Paused mid-flight: the whole process freezes, so the lease's cancellation cannot
    // reach it either — the exact window the epoch exists for.
    worker.pause();
    // The lease goes stale and a REAL second process takes it over, bumping the epoch.
    const takeover = bunEval(
      `const { openStore, acquireWriterEpoch } = await import(${JSON.stringify(
        join(ROOT, "src/ledger/store.ts"),
      )});
const store = openStore(${JSON.stringify(dir)});
const epoch = acquireWriterEpoch(store);
store.close();
console.log(JSON.stringify({ epoch }));`,
    );
    expect(takeover.epoch).toBe(epoch + 1);
    worker.resume();
    const done = await answerUntilDone(worker, 7);
    expect(done.channels.files?.outcome).toBe("failed");
    expect(done.channels.files?.error).toContain("fenced out");
    // The journal import wrote nothing, and the ledger carries the new holder's epoch.
    expect(readRecords(dir)).toHaveLength(0);
    const after = openStore(dir);
    try {
      expect(readWriterEpoch(after.db)).toBe(epoch + 1);
    } finally {
      after.close();
    }
    worker.send({ type: "cancel", id: 7 });
  } finally {
    worker.stop();
    await worker.exitCode();
  }
}, 30_000);

it("a worker whose parent heartbeat went silent cannot commit after resuming", async () => {
  const dir = agentDir();
  seedJournal(dir);
  const parent = openStore(dir);
  let epoch: number;
  try {
    epoch = acquireWriterEpoch(parent);
  } finally {
    parent.close();
  }
  const worker = spawnWorkerChild(dir);
  try {
    worker.send({
      type: "hello",
      v: 1,
      build: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim(),
      agentDir: dir,
    });
    const ready = await worker.next();
    expect(ready.type).toBe("ready");
    worker.startHeartbeats();
    worker.send({ type: "pass", id: 8, channels: { files: true }, deadlineMs: 60000, epoch });
    // The parent loses the lease and stops heartbeating while the worker is paused; the epoch
    // never moves (an old release took the lease over), so only the heartbeat can fence.
    worker.pause();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    worker.resume();
    const done = await answerUntilDone(worker, 8);
    expect(done.channels.files?.outcome).toBe("failed");
    expect(done.channels.files?.error).toContain("heartbeat was last seen");
    expect(readRecords(dir)).toHaveLength(0);
    const after = openStore(dir);
    try {
      expect(readWriterEpoch(after.db)).toBe(epoch);
    } finally {
      after.close();
    }
    worker.send({ type: "cancel", id: 8 });
  } finally {
    worker.stop();
    await worker.exitCode();
  }
}, 30_000);
