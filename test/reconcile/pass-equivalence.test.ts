import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Pass/oracle equivalence for the B2 reconciliation pass (runReconciliationPass vs the
 * supervisor's scan()).
 *
 * The oracle — a faithful, line-commented transcription of Kimchi's scan()
 * (kimchi-src-1842/src/extensions/work-attribution/reconcile-supervisor.ts) — and the pass
 * each run in their own child process (pass-equivalence.driver.ts) over a byte-identical
 * fixture at the SAME filesystem path, so every generated identifier (record hashes, outbox
 * event ids, projection byte counts — all derived from the content and the path) must match
 * exactly. Running each lane in a fresh process also mirrors the B3 worker's process
 * boundary: no in-process channel state can leak from one lane into the other.
 *
 * The fixture makes every channel do real work (see the driver's header): a real Git
 * repository with a GitHub-shaped remote and a tracked edit that becomes a real commit; a
 * billing-tagged request the costs channel prices through the fake billing API; an accepted
 * saved-plan continuation the continuations channel repairs into a work_link row; and a
 * reporting session whose translated events are delivered to the fake ingestion endpoint.
 * A second repository with its own tracked edit makes the files channel rotate: the first
 * pass runs out of budget after one repository, so the second pass must start from the
 * carried nextRepository — the driver records each pass's repository visit order, the working
 * directory of every git command the moved code ran, and the cwd/host of every credentials,
 * endpoints and gitToken read the host answered (the reporting session's credential cwd and
 * the costs channel's per-record cwd included). Two consecutive passes run on each side, with
 * a second request dispatched in between, so cross-pass state (repository rotation,
 * continuation progress, the reporting pass gate, billing rechecks) is exercised. The driver
 * freezes the clock (stepped 30 s between passes), so timestamps, retry windows and budgets
 * are deterministic.
 *
 * The full end state is compared: every ledger table in row order, every file under the
 * agent directory, the pull-request updates the subscribers saw, the metrics, and every
 * request the fake server received. The only normalized values are the two identifiers
 * Kimchi itself generates randomly per run — the repaired work_link's linkId and the
 * outbox batch id — which are replaced by placeholders everywhere they appear.
 */

const DRIVER = join(import.meta.dir, "pass-equivalence.driver.ts");

interface DriverResult {
  dump: {
    tables: Record<string, Array<Record<string, unknown>>>;
    files: Record<string, string>;
    updates: unknown[];
    metrics: unknown[];
    receipts: { method: string; url: string; body: string | null }[];
  };
  worker?: {
    first?: { channels?: Record<string, { outcome: string }> };
    second?: { channels?: Record<string, { outcome: string }> };
  };
  state: {
    nextRepository?: string;
    progressRetained: boolean;
    settledJournals: boolean;
    repositories: string[];
    gitOrders: string[][];
    filesOrders: string[][];
    hostCalls: { kind: string; cwd?: string; host?: string; pass: number }[];
    reportingCwd: string;
    costRecordCwd: string;
  };
}

function runLane(root: string, mode: "oracle" | "pass"): DriverResult {
  const run = spawnSync(process.execPath, [DRIVER, root, mode], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0)
    throw new Error(`${mode} lane failed (${run.status}):\n${run.stderr}${run.stdout}`);
  return JSON.parse(run.stdout) as DriverResult;
}

/** Replace the random ids Kimchi generates per run, everywhere they appear. */
function normalize(result: DriverResult): string {
  // The work_link linkId is a random UUID the repair generates; every record hash and
  // projection key that embeds it is recomputed or replaced, so the lanes compare by content.
  const linkIds: string[] = [];
  for (const row of result.dump.tables.work_records ?? []) {
    const body = typeof row.body === "string" ? row.body : "";
    if (body.includes('"type":"work_link"')) {
      const linkId = body.split('"linkId":"')[1]?.slice(0, 36);
      if (linkId && linkId.length === 36) linkIds.push(linkId);
    }
  }
  const rewritten: Record<string, string> = {};
  const records = (result.dump.tables.work_records ?? []).map((row) => {
    const body = typeof row.body === "string" ? row.body : "";
    const normalized = linkIds.reduce((text, id) => text.split(id).join("<link-id>"), body);
    const hash = createHash("sha256").update(normalized).digest("hex");
    if (typeof row.record_hash === "string") rewritten[row.record_hash] = hash;
    return { ...row, body: normalized, record_hash: hash };
  });
  const pending = (result.dump.tables.pending_translation ?? []).map((row) => ({
    ...row,
    record_hash:
      typeof row.record_hash === "string"
        ? (rewritten[row.record_hash] ?? row.record_hash)
        : row.record_hash,
  }));
  const dump = {
    ...result.dump,
    tables: { ...result.dump.tables, work_records: records, pending_translation: pending },
  };
  // The worker field is pass-lane telemetry (its two PassResults); its channels and the
  // cross-pass state they carry are asserted directly, and the end-state comparison below
  // covers the data both lanes produced.
  // ...and progressRetained is pass-lane mechanics (asserted directly below).
  let text = JSON.stringify({
    ...result,
    dump,
    worker: undefined,
    state: { ...result.state, progressRetained: undefined },
  });
  for (const id of linkIds) text = text.split(id).join("<link-id>");
  for (const match of text.split('"id":"').slice(1)) {
    const id = match.slice(0, 36);
    if (
      id.length === 36 &&
      // Outbox batch ids are random UUIDs generated at batch build time; event ids are
      // content-derived and must survive comparison.
      text.includes(`"batch":{"version":1,"id":"${id}"`)
    )
      text = text.split(id).join("<batch-id>");
  }
  return text;
}

describe("runReconciliationPass matches the supervisor's scan()", () => {
  it("produces the same end state over two consecutive passes", () => {
    const root = mkdtempSync(join(tmpdir(), "kimchi-pass-eq-"));
    try {
      const oracle = runLane(root, "oracle");
      rmSync(root, { recursive: true, force: true });
      const pass = runLane(root, "pass");

      // Sanity: every channel did real work in both lanes, so equivalence is not vacuous.
      for (const lane of [oracle, pass]) {
        const rows = lane.dump.tables.work_records.map((row) => String(row.type));
        expect(rows.filter((type) => type === "file_transition")).toHaveLength(2);
        expect(rows.filter((type) => type === "work_link")).toHaveLength(1);
        expect(rows.filter((type) => type === "request_cost")).toHaveLength(2);
        const commits = lane.dump.tables.work_records.filter((row) => row.type === "commit");
        expect(commits.some((row) => String(row.body).includes('"native-file-transition"'))).toBe(
          true,
        );
        expect(commits.some((row) => String(row.body).includes('"state":"merged"'))).toBe(true);
        const urls = lane.dump.receipts.map((receipt) => receipt.url);
        expect(urls.some((url) => url.includes("/llm-requests"))).toBe(true);
        expect(urls.some((url) => url.includes("/pulls?"))).toBe(true);
        expect(urls.filter((url) => url.endsWith("pr-cost-events:batchIngest"))).toHaveLength(2);
        expect(urls.some((url) => url.endsWith("api-keys:verify"))).toBe(true);
        expect(lane.dump.updates.length).toBeGreaterThan(0);
        expect(
          lane.dump.tables.outbox_events.every((row) => typeof row.acked_at === "number"),
        ).toBe(true);
      }

      // The pass lane's channels all completed, except the first pass's files channel: its
      // 3 s budget expired mid-rotation (the driver steps the clock past it), which the pass
      // records as "canceled" — the supervisor silently swallowed the same exhaustion — and
      // still runs the later channels.
      const ok = {
        files: { outcome: "ok" },
        "pull-requests": { outcome: "ok" },
        costs: { outcome: "ok" },
        continuations: { outcome: "ok" },
        reporting: { outcome: "ok" },
      };
      expect(pass.worker?.first?.channels).toEqual({ ...ok, files: { outcome: "canceled" } });
      expect(pass.worker?.second?.channels).toEqual(ok);

      // Cross-pass state agrees: the rotation and the retained continuation progress.
      expect(pass.state.nextRepository).toBe(oracle.state.nextRepository);
      expect(pass.state.settledJournals).toBe(oracle.state.settledJournals);
      // The worker kept the continuation progress the pass returned (the supervisor kept its own).
      expect(pass.state.progressRetained).toBe(true);

      // Rotation across passes: the first pass ran out of budget after its first repository
      // and the second pass started exactly where the first one left off — the carried
      // nextRepository — then rotated through the other repository.
      const [first, second] = oracle.state.repositories;
      for (const lane of [oracle, pass]) {
        expect(lane.state.filesOrders).toEqual([[first], [second, first]]);
        const secondPassStart = lane.state.filesOrders[1][0];
        expect(lane.state.nextRepository).toBe(secondPassStart);
        // The reporting channel resolved its credential at the reporting session's own cwd, in
        // both passes, and the costs channel resolved the record's credential at the record's
        // own cwd (its per-record lookup).
        for (const index of [0, 1]) {
          expect(lane.state.hostCalls).toContainEqual({
            kind: "credentials",
            cwd: lane.state.reportingCwd,
            pass: index,
          });
          expect(lane.state.hostCalls).toContainEqual({
            kind: "credentials",
            cwd: lane.state.costRecordCwd,
            pass: index,
          });
        }
      }
      // The full git-command and host-read sequences agree, cwd for cwd, in order.
      expect(pass.state.gitOrders).toEqual(oracle.state.gitOrders);
      expect(pass.state.hostCalls).toEqual(oracle.state.hostCalls);

      // The equivalence itself: the full end state at the identical path.
      const oracleText = normalize(oracle);
      const passText = normalize(pass);
      if (oracleText !== passText && process.env.EQ_DUMP) {
        writeFileSync(
          "/tmp/eq-oracle.json",
          `${JSON.stringify(JSON.parse(oracleText), null, 1)}\n`,
        );
        writeFileSync("/tmp/eq-pass.json", `${JSON.stringify(JSON.parse(passText), null, 1)}\n`);
      }
      expect(passText).toEqual(oracleText);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
