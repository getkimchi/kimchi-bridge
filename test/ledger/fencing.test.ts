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
