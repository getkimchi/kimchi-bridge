import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { HostPorts } from "../../../src/reconcile/host.js";
import { setDefaultHostPorts } from "../../../src/reconcile/host-ports.js";
import { appendWorkRecord, type WorkContext } from "../../../src/reconcile/work-attribution.js";
import {
  flushWorkSummaries,
  journalParser,
  readWorkRecords,
  readWorkRecordsAsync,
  type WorkRecord,
  type WorkRecordProblem,
} from "../../../src/reconcile/work-attribution/summary.js";
import { pinAgentDir } from "../../../src/ledger/store.js";

/**
 * Ported from Kimchi's src/extensions/work-attribution/summary.test.ts, keeping only the
 * suites whose subject is code that moved to the bridge: the legacy journal parser and the
 * strict/async readers (summary.ts over ledger import.ts/records.ts). The Kimchi suite ran
 * on the in-memory records backend; the port runs on the real SQLite backend.
 *
 * The rest of Kimchi's suite stays in Kimchi's vitest, each with its reason:
 *  - "keeps one PR after provider IDs are added...", "retains PR links and their newest
 *    state...", "keeps newer billing status (%s) through delayed recovery", "lists each
 *    billing ID once...", "recovers %s from a malformed observation timestamp", "retains hunk
 *    matches...", "shows why a session continued another work...", "keeps every retained
 *    version when the local plan path is reused", "automatically separates work while
 *    merging...", "retains request-to-file links...", "merges commit file evidence...",
 *    "imports unchanged transition journals...", "replays unchanged version-4 ledgers...",
 *    "keeps a durable request header...", "does not scan unrelated histories...",
 *    "discovers legacy roots once...", "resumes a legacy session's work at once...",
 *    "relaunches without reimporting...", "does not checkpoint a failed %s ledger scan...",
 *    "retains an append committed after lock release...", "does one legacy discovery per
 *    agent directory..." — every one drives Kimchi's session-side wrappers (getWorkId,
 *    recordProviderRequest, setWorkId, recoverWorkSummaries) and the recoverProjection
 *    helper built on the unmoved recoverWorkSummaries hydration wrapper.
 *  - "commits a pending native capture before shutdown flush completes", "rolls back a
 *    cancelled native publisher...", "recovers a killed native owner...", "keeps a responding
 *    reader beyond its cumulative watchdog deadline", "serializes three native writers..." —
 *    native-process races ported with the driver's summary-writer/summary-reader commands in
 *    test/ledger/summary-writer.test.ts.
 *  - The it.each blocks over damaged legacy state and restart modes share the same
 *    recoverWorkSummaries/getWorkId machinery.
 */

/** Bun's it.each types reject the vitest-style tables below (plain and object rows). */
const each = (
  rows: readonly unknown[],
): ((name: string, fn: (...args: any[]) => void, timeout?: number) => void) =>
  (
    it.each as unknown as (
      this: unknown,
      rows: readonly unknown[],
    ) => (name: string, fn: (...args: any[]) => void, timeout?: number) => void
  ).call(it, rows);

let dir: string;
beforeEach(() => {
  dir = pinAgentDir(mkdtempSync(join(tmpdir(), "kimchi-work-summary-")));
  setDefaultHostPorts(host);
});
afterEach(async () => {
  await flushWorkSummaries();
  setDefaultHostPorts(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** The fake HostPorts replaces Kimchi's PI_CODING_AGENT_DIR for appendWorkRecord. */
const host: HostPorts = {
  get agentDir() {
    return dir;
  },
  e2eSeam: () => undefined,
  now: () => Date.now(),
  credentials: () => ({ token: "", apiUrl: "https://account.example" }),
  gitToken: () => undefined,
  endpoints: () => ({
    llmEndpoint: "https://llm.example",
    openAiBaseUrl: "https://llm.example/openai/v1",
    anthropicBaseUrl: "https://llm.example/anthropic",
    experimentalOpenAiBaseUrl: "https://llm.example/experimental/openai/v1",
    platformApiUrl: "https://account.example",
  }),
  orgPolicy: () => ({ resourceEnabled: () => true }),
  telemetryConsent: () => false,
  metric: () => {},
  fetch: () => Promise.reject(new Error("the summary suite never reaches the network")),
};

/** Kimchi's context() mock: only the cwd and session matter to the bridge's capture. */
function context(sessionId = "parent"): WorkContext {
  return { cwd: "/project", sessionManager: { getSessionId: () => sessionId } };
}

function parseLegacyJournal(
  ledger: string,
  text: string,
  onProblem?: (problem: WorkRecordProblem) => void,
): WorkRecord[] {
  const records: WorkRecord[] = [];
  const parse = journalParser(ledger, records, onProblem);
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) parse(line, index === lines.length - 1);
  return records;
}

describe("readable work summaries", () => {
  it("reports malformed nonblank ledger rows without treating a trailing newline as lost history", () => {
    // Kimchi seeded through recordProviderRequest; the journal only needs one valid capture.
    const ctx = context();
    appendWorkRecord(
      ctx,
      {
        type: "request",
        requestId: randomUUID(),
        startedAt: new Date().toISOString(),
      },
      randomUUID(),
    );
    const invalid = () => {};
    const ledger = join(dir, "work-attribution", "parent.jsonl");
    expect(readWorkRecords(dir, undefined, () => {}, invalid)).toHaveLength(1);
    fs.mkdirSync(dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, '\n{broken\n{"type":"request"}\n');
    const problems: WorkRecordProblem[] = [];
    readWorkRecords(
      dir,
      undefined,
      () => {},
      (problem) => problems.push(problem),
    );
    expect(problems).toHaveLength(2);
  });
  each(["", "transitions"])(
    "skips only interrupted appends in %s journals",
    async (source: string) => {
      const row: WorkRecord = {
        version: 1,
        type: "work",
        workId: randomUUID(),
        sessionId: "writer",
      };
      const complete = JSON.stringify(row);
      // Keep the legacy parser matrix; the importer consumes only LF-terminated lines and dedups authority.
      const cases = [
        ['{"type":"request"', 0, [row], 0, 1],
        ['{"type":"request"\n', 1, [row], 1, 1],
        // Released writers start a new line after a cut-off record and append the next one.
        ['{"type":"request"}', 1, [row], 0, 1],
        [`{"type":"request"\n${complete}`, 0, [row, row], 1, 0],
        [`{"type":"request","workId":"12\n${complete}`, 0, [row, row], 1, 0],
        [`{"type":"request"}x\n${complete}`, 1, [row, row], 1, 1],
        [complete, 0, [row, row], 0, 0],
      ] as const;
      for (const [index, [suffix, invalidCount, rows, beforeLf, afterLf]] of cases.entries()) {
        const agentDir = join(dir, `${source || "sessions"}-${index}`);
        const directory = join(agentDir, "work-attribution", source);
        fs.mkdirSync(directory, { recursive: true });
        const ledger = join(directory, "interrupted.jsonl");
        const text = `${complete}\n${suffix}`;
        fs.writeFileSync(ledger, text);
        const legacyProblems: WorkRecordProblem[] = [];
        expect(parseLegacyJournal(ledger, text, (problem) => legacyProblems.push(problem))).toEqual(
          [...rows],
        );
        expect(legacyProblems).toHaveLength(invalidCount);
        const invalid: WorkRecordProblem[] = [];
        expect(
          readWorkRecords(
            agentDir,
            undefined,
            () => {},
            (problem) => invalid.push(problem),
          ),
        ).toEqual([row]);
        expect(invalid).toHaveLength(beforeLf);
        // The background reader sees the same durable coverage, without importing duplicate rows.
        const background: WorkRecordProblem[] = [];
        expect(
          await readWorkRecordsAsync(agentDir, new AbortController().signal, (problem) =>
            background.push(problem),
          ),
        ).toEqual([row]);
        expect(background).toEqual(invalid);
        if (!text.endsWith("\n")) fs.appendFileSync(ledger, "\n");
        const completed: WorkRecordProblem[] = [];
        expect(
          readWorkRecords(
            agentDir,
            undefined,
            () => {},
            (problem) => completed.push(problem),
          ),
        ).toEqual([row]);
        expect(completed).toHaveLength(afterLf);
      }
    },
  );
  it("reports damage and complete records of unknown types as separate problems", async () => {
    const row: WorkRecord = { version: 1, type: "work", workId: randomUUID(), sessionId: "writer" };
    // A newer Kimchi sharing this history can add record types that this version cannot interpret.
    const newer = {
      ...row,
      type: "work_checkpoint",
      sessionId: "newer",
      requestIds: [randomUUID()],
    };
    const ledger = join(dir, "work-attribution", "mixed.jsonl");
    fs.mkdirSync(dirname(ledger), { recursive: true });
    const lines = [
      row,
      newer,
      { ...newer, workId: "not-a-work-id" },
      { ...row, type: "request" },
    ].map((value) => JSON.stringify(value));
    const text = `${lines.join("\n")}\n{broken\n${JSON.stringify(row)}\n`;
    fs.writeFileSync(ledger, text);
    const legacyProblems: WorkRecordProblem[] = [];
    expect(parseLegacyJournal(ledger, text, (problem) => legacyProblems.push(problem))).toEqual([
      row,
      row,
    ]);
    const problems: WorkRecordProblem[] = [];
    expect(
      readWorkRecords(
        dir,
        undefined,
        () => {},
        (problem) => problems.push(problem),
      ),
    ).toEqual([row]);
    // Both kinds reach the callback, so readers that need complete history still see an unknown type.
    expect(problems).toEqual([
      { kind: "unknown-type", path: ledger, line: 2, record: newer },
      { kind: "invalid", path: ledger, line: 3 },
      { kind: "invalid", path: ledger, line: 4 },
      { kind: "invalid", path: ledger, line: 5 },
    ]);
    expect(legacyProblems).toEqual(problems);
    const background: WorkRecordProblem[] = [];
    expect(
      await readWorkRecordsAsync(dir, new AbortController().signal, (problem) =>
        background.push(problem),
      ),
    ).toEqual([row]);
    expect(background).toEqual(problems);
  });
  it("skips a record cut at any position, including inside a \\u escape", () => {
    const row: WorkRecord = { version: 1, type: "work", workId: randomUUID(), sessionId: "writer" };
    const complete = JSON.stringify(row);
    // Provider and Git errors keep terminal colours, which JSON writes as \u001b escapes.
    const cut = JSON.stringify({
      ...row,
      type: "commit",
      sha: "a".repeat(40),
      prLookup: {
        status: "error",
        error: '[31mGitHub said "no"[0m\tC:\\repo\n',
        attempts: [1, -1.5e3],
      },
      complete: false,
    });
    const escapes = [...cut.matchAll(/\\u001b/g)].map((match) => match.index);
    expect(escapes).toHaveLength(2);
    for (let end = 1; end < cut.length; end++) {
      const agentDir = join(dir, `cut-${end}`);
      const ledger = join(agentDir, "work-attribution", "interrupted.jsonl");
      fs.mkdirSync(dirname(ledger), { recursive: true });
      const text = `${complete}\n${cut.slice(0, end)}\n${complete}\n`;
      fs.writeFileSync(ledger, text);
      const legacyProblems: WorkRecordProblem[] = [];
      expect(parseLegacyJournal(ledger, text, (problem) => legacyProblems.push(problem))).toEqual([
        row,
        row,
      ]);
      expect({ end, invalid: legacyProblems.length }).toEqual({ end, invalid: 0 });
      const invalid: WorkRecordProblem[] = [];
      expect(
        readWorkRecords(
          agentDir,
          undefined,
          () => {},
          (problem) => invalid.push(problem),
        ),
      ).toEqual([row]);
      expect({ end, invalid: invalid.length }).toEqual({ end, invalid: 0 });
    }
  }, 120_000);

  it("reads large journals in the background without blocking the event loop", async () => {
    const ledgers = join(dir, "work-attribution");
    fs.mkdirSync(join(ledgers, "transitions"), { recursive: true });
    const workId = randomUUID();
    const row = (requestId: string, note = "") =>
      JSON.stringify({ version: 1, type: "request", workId, sessionId: "large", requestId, note });
    // About 6 MiB in several files; one multi-byte note crosses a read chunk boundary.
    const lines = Array.from({ length: 20_000 }, () => row(randomUUID(), "x".repeat(200)));
    const primary = `${row(randomUUID(), "é".repeat(700_000))}\n${lines.join("\n")}\n`;
    const transitions = `${lines.slice(0, 1000).join("\n")}\ninterrupted`;
    const primaryPath = join(ledgers, "large.jsonl");
    const transitionsPath = join(ledgers, "transitions", "edits.jsonl");
    fs.writeFileSync(primaryPath, primary);
    fs.writeFileSync(transitionsPath, transitions);
    // The legacy parser sees all 21,001 observations; the authority dedups the repeated 1,000 exact lines.
    expect([
      ...parseLegacyJournal(primaryPath, primary),
      ...parseLegacyJournal(transitionsPath, transitions),
    ]).toHaveLength(21_001);
    let turns = 0;
    let reading = true;
    const spin = () => {
      turns++;
      if (reading) setImmediate(spin);
    };
    setImmediate(spin);
    const records = await readWorkRecordsAsync(dir, new AbortController().signal);
    reading = false;
    expect(records).toHaveLength(20_001);
    expect(records).toEqual(readWorkRecords(dir));
    expect(fs.readFileSync(primaryPath, "utf8")).toBe(primary);
    expect(fs.readFileSync(transitionsPath, "utf8")).toBe(transitions);
    // The synchronous reader would let no other callback run until it finished.
    expect(turns).toBeGreaterThanOrEqual(6);
  }, 60_000);
});
