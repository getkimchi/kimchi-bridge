import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import {
  INTEGRITY_CHECK_INTERVAL_MS,
  integrityCheckGate,
  integrityMarkerPath,
} from "../../src/worker/integrity.js";
import { Database } from "bun:sqlite";
import { openStore, SQLITE_OPEN_READWRITE } from "../../src/ledger/store.js";
import { capture, closeBackends } from "../../src/ledger/records.js";

/**
 * The worker's once-a-day quick_check gate (reconcile-out-of-process plan, chunk B4):
 * a passing check is cached by an atomic marker, a failed check reports
 * ledger_integrity_failed on every channel and leaves the ledger untouched, and
 * the gate drives a REAL worker process against a deliberately corrupted copy of
 * a ledger, so the refusal path is proven on the wire, not only in-process.
 */

const ROOT = join(import.meta.dir, "../..");
const WORKER = join(ROOT, "src/worker/main.ts");
const BUILD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
const FAKE_TOKEN = "kchi_integrity_fake_token_0123456789";
const NO_NETWORK_API = "http://127.0.0.1:1";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  closeBackends();
});

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-worker-integrity-"));
  dirs.push(dir);
  return dir;
}

/** One stored record, so the ledger exists with content to corrupt. */
function seedLedger(dir: string): void {
  const store = openStore(dir);
  try {
    capture(
      dir,
      {
        version: 1,
        type: "request",
        workId: "22222222-2222-4222-8222-222222222222",
        requestId: "33333333-3333-4333-8333-333333333333",
        sessionId: "session",
        startedAt: "2026-11-01T00:00:00.000Z",
      },
      "test",
    );
  } finally {
    store.close();
  }
  // Fold the WAL into the main file, so the corruption below lands on the bytes a
  // later open actually reads instead of being masked by a live WAL page.
  const checkpoint = new Database(
    join(dir, "pr-cost-reporting", "ledger.db"),
    SQLITE_OPEN_READWRITE,
  );
  try {
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    checkpoint.close();
  }
}

function childIntegrity(dir: string): { ok: boolean; error?: string } {
  const script = `const { integrityCheckGate } = await import(${JSON.stringify(
    join(ROOT, "src/worker/integrity.ts"),
  )}); const gate = integrityCheckGate(${JSON.stringify(dir)}); console.log(JSON.stringify(gate));`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: ROOT });
  const line = run.stdout.toString().trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as { ok: boolean; error?: string };
}

test("a passing check writes the marker and later gates skip the check", () => {
  const dir = agentDir();
  seedLedger(dir);
  expect(existsSync(integrityMarkerPath(dir))).toBe(false);
  const first = integrityCheckGate(dir);
  expect(first.ok).toBe(true);
  expect(existsSync(integrityMarkerPath(dir))).toBe(true);
  // The marker's body is the atomic write's exact bytes.
  expect(JSON.parse(readFileSync(integrityMarkerPath(dir), "utf8"))).toEqual({
    version: 1,
    checkedAt: expect.any(Number) as number,
  });
  // A fresh marker short-circuits: run again in a child, so not even the same
  // connection is reused.
  expect(childIntegrity(dir).ok).toBe(true);
});

test("a stale marker re-runs the check; a damaged marker counts as absent", () => {
  const dir = agentDir();
  seedLedger(dir);
  const marker = integrityMarkerPath(dir);
  mkdirSync(dirname(marker), { recursive: true });
  const checkedAt = Date.now() - (INTEGRITY_CHECK_INTERVAL_MS + 60_000);
  writeFileSync(marker, `${JSON.stringify({ version: 1, checkedAt })}\n`);
  expect(integrityCheckGate(dir).ok).toBe(true);
  expect(JSON.parse(readFileSync(marker, "utf8")).checkedAt).toBeGreaterThan(checkedAt);
  writeFileSync(marker, "not json at all\n");
  expect(integrityCheckGate(dir).ok).toBe(true);
  expect(JSON.parse(readFileSync(marker, "utf8")).version).toBe(1);
});

test("a ledger with no database yet checks nothing and writes the marker", () => {
  const dir = agentDir();
  expect(integrityCheckGate(dir).ok).toBe(true);
  expect(existsSync(integrityMarkerPath(dir))).toBe(true);
});

test("a deliberately corrupted ledger fails the gate and keeps failing", () => {
  const dir = agentDir();
  seedLedger(dir);
  const ledger = join(dir, "pr-cost-reporting", "ledger.db");
  const bytes = readFileSync(ledger);
  // Flip bytes across page one's b-tree area: page 1 holds the SQLite header and the
  // schema's b-tree root, so garbage there is structural corruption, not free space.
  const corrupted = Buffer.from(bytes);
  for (let offset = 100; offset < 400; offset += 3) corrupted[offset] = 0xff;
  writeFileSync(ledger, corrupted);
  const gate = integrityCheckGate(dir);
  expect(gate.ok).toBe(false);
  if (!gate.ok) expect(gate.error?.length ?? 0).toBeGreaterThan(0);
  // A failed check writes no marker, so the next pass re-checks and fails again.
  expect(existsSync(integrityMarkerPath(dir))).toBe(false);
  const again = integrityCheckGate(dir);
  expect(again.ok).toBe(false);
  // The corrupted file itself is untouched by the failed check.
  expect(readFileSync(ledger).equals(corrupted)).toBe(true);
});

test("a real worker refuses to write a corrupted ledger and leaves it untouched", async () => {
  const dir = agentDir();
  seedLedger(dir);
  const ledger = join(dir, "pr-cost-reporting", "ledger.db");
  const before = readFileSync(ledger);
  const corrupted = Buffer.from(before);
  for (let offset = 100; offset < 400; offset += 3) corrupted[offset] = 0xff;
  writeFileSync(ledger, corrupted);
  // A journal the files channel would import if the pass were allowed to write.
  mkdirSync(join(dir, "work-attribution"), { recursive: true });
  writeFileSync(
    join(dir, "work-attribution", "legacy.jsonl"),
    `${JSON.stringify({
      version: 1,
      type: "request",
      workId: "22222222-2222-4222-8222-222222222222",
      requestId: "44444444-4444-4444-8444-444444444444",
      sessionId: "session",
      startedAt: "2026-11-02T00:00:00.000Z",
    })}\n`,
  );

  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER],
    cwd: ROOT,
    env: { ...process.env, KIMCHI_CODING_AGENT_DIR: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  const heart = setInterval(() => {
    if (proc.exitCode !== null) return;
    proc.stdin.write(`{"type":"heartbeat","at":${Date.now()}}\n`);
    proc.stdin.flush();
  }, 500);
  const read = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== "") lines.push(line.trim());
      }
    }
  })();
  try {
    const send = (message: unknown): void => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    };
    send({ type: "hello", v: 1, build: BUILD, agentDir: dir });
    for (;;) {
      const message = await nextOf(lines);
      if (message.type === "ready") break;
    }
    send({
      type: "pass",
      id: 1,
      channels: { files: true, reporting: true },
      reportingCwd: "/project",
      deadlineMs: 30000,
      epoch: 0,
    });
    for (;;) {
      const message = await nextOf(lines);
      if (message.type === "request") {
        send({
          type: "reply",
          rid: message.rid as number,
          result: replies[message.kind as string],
        });
        continue;
      }
      if (message.type === "done" && message.result) {
        expect(message.result.outcome).toBe("failed");
        for (const channel of Object.values(message.result.channels))
          expect(channel?.outcome).toBe("failed");
        const errors = Object.values(message.result.channels)
          .map((channel) => channel?.error ?? "")
          .join("\n");
        expect(errors).toContain("ledger_integrity_failed");
        break;
      }
    }
    proc.stdin.end();
    await proc.exited;
    // Nothing was written: the corrupted bytes and the journal are exactly as they were.
    expect(readFileSync(ledger).equals(corrupted)).toBe(true);
    expect(
      readFileSync(join(dir, "work-attribution", "legacy.jsonl"), "utf8").includes(
        '"requestId":"44444444-4444-4444-8444-444444444444"',
      ),
    ).toBe(true);
  } finally {
    clearInterval(heart);
    if (proc.exitCode === null) proc.kill();
    await read;
  }
}, 30000);

const replies: Record<string, unknown> = {
  credentials: { token: FAKE_TOKEN, apiUrl: NO_NETWORK_API },
  gitToken: {},
  endpoints: {
    llmEndpoint: "http://127.0.0.1:1",
    openAiBaseUrl: "http://127.0.0.1:1/openai/v1",
    anthropicBaseUrl: "http://127.0.0.1:1/anthropic",
    experimentalOpenAiBaseUrl: "http://127.0.0.1:1/experimental",
    platformApiUrl: NO_NETWORK_API,
  },
  policy: { resources: { "extensions.cost-per-pr": true } },
  consent: { consent: false },
};

/** One parsed worker line, loosely typed: the test reads the fields it asserts by name. */
interface WorkerLine {
  type: string;
  rid?: number;
  kind?: string;
  result?: {
    outcome: string;
    channels: Record<string, { outcome: string; error?: string } | undefined>;
  };
}

/** Waits for the next worker line. */
async function nextOf(lines: string[]): Promise<WorkerLine> {
  for (;;) {
    const line = lines.shift();
    if (line) return JSON.parse(line) as WorkerLine;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
