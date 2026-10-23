import { Database } from "bun:sqlite";
import { createHash, randomInt } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, loadavg, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function Distribution(values: number[]) {
  if (!values.length) throw new Error("at least one sample is required");
  if (values.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("invalid sample");
  const a = [...values].sort((x, y) => x - y),
    mid = Math.floor(a.length / 2);
  return {
    samples: a.length,
    median: a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2,
    p95: a[Math.ceil(a.length * 0.95) - 1]!,
    min: a[0]!,
    max: a.at(-1)!,
  };
}
function sortedRecord(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}
function increment(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}
export function Evidence(state: string) {
  const ledgers: string[] = [];
  const visit = (path: string) => {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, e.name);
      if (e.isDirectory()) visit(next);
      else if (e.name === "ledger.sqlite") ledgers.push(next);
    }
  };
  if (existsSync(state)) visit(state);
  const evidence = {
    events: {} as Record<string, number>,
    coverage: {} as Record<string, number>,
    usageCorrelation: {} as Record<string, number>,
    usageSchemas: {} as Record<string, number>,
    usageDimensions: {} as Record<string, number>,
    sourceVersions: {} as Record<string, number>,
    usageRequests: 0,
    usageWithWork: 0,
    inputTokens: "0",
    outputTokens: "0",
    cacheReadTokens: "0",
    tools: {} as Record<string, number>,
    files: {} as Record<string, number>,
    blobHashes: [] as string[],
    diagnostics: {} as Record<string, number>,
    pending: 0,
  };
  let input = 0n,
    output = 0n,
    cached = 0n;
  for (const path of ledgers) {
    // A cleanly closed modernc WAL database has no sidecars. Bun's readonly
    // connection cannot initialize their shared-memory index; inspect this
    // owned fixture read/write without issuing any data-changing SQL instead.
    const db = new Database(path);
    try {
      for (const row of db
        .query(
          "SELECT body FROM events WHERE rowid IN (SELECT MAX(rowid) FROM events GROUP BY entity_id) ORDER BY rowid",
        )
        .all() as { body: Uint8Array }[]) {
        const e = JSON.parse(Buffer.from(row.body).toString());
        const kind = [
          "work",
          "usage",
          "tool",
          "file",
          "commit",
          "pullRequest",
          "link",
          "coverage",
        ].find((k) => e[k]);
        if (kind) increment(evidence.events, kind);
        increment(evidence.sourceVersions, e.source + ":" + e.sourceVersion);
        if (e.coverage) increment(evidence.coverage, e.coverage.code);
        if (e.usage) {
          const u = e.usage;
          evidence.usageRequests++;
          if (e.workId) evidence.usageWithWork++;
          increment(evidence.usageCorrelation, u.correlation);
          increment(evidence.usageSchemas, u.schema);
          input += BigInt(u.raw.inputTokens ?? "0");
          output += BigInt(u.raw.outputTokens ?? "0");
          cached += BigInt(u.raw.cacheReadTokens ?? "0");
          increment(
            evidence.usageDimensions,
            JSON.stringify({
              counterScope: u.counterScope,
              billingBasis: u.billingBasis,
              observedRoute: u.observedRoute,
              reportedModel: u.reportedModel ?? null,
              actualModel: u.actualModel ?? null,
              provider: u.provider ?? null,
              attemptsComplete: u.attemptsComplete,
              rawFields: Object.keys(u.raw).sort(),
            }),
          );
        }
        if (e.tool) increment(evidence.tools, e.tool.category + ":" + e.tool.outcome);
        if (e.file) increment(evidence.files, e.file.operation + ":" + e.file.quality);
      }
      evidence.pending += (
        db.query("SELECT count(*) AS n FROM events WHERE acked_at IS NULL").get() as any
      ).n;
      evidence.blobHashes.push(
        ...(db.query("SELECT hash FROM blobs ORDER BY hash").all() as { hash: string }[]).map(
          (r) => r.hash,
        ),
      );
      for (const { code, count } of db.query("SELECT code,count FROM diagnostics").all() as {
        code: string;
        count: number;
      }[])
        evidence.diagnostics[code] = (evidence.diagnostics[code] ?? 0) + count;
    } finally {
      db.close();
    }
  }
  evidence.inputTokens = input.toString();
  evidence.outputTokens = output.toString();
  evidence.cacheReadTokens = cached.toString();
  evidence.blobHashes.sort();
  for (const key of [
    "events",
    "coverage",
    "usageCorrelation",
    "usageSchemas",
    "usageDimensions",
    "sourceVersions",
    "tools",
    "files",
    "diagnostics",
  ] as const)
    evidence[key] = sortedRecord(evidence[key]);
  return evidence;
}
function stateFiles(path: string): number {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? stateFiles(join(path, e.name)) : e.isFile() ? 1 : 0),
    0,
  );
}
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
type Side = "baseline" | "candidate";
type Scenario =
  | "version"
  | "codex_session_start"
  | "codex_prompt"
  | "codex_edit_before_after"
  | "claude_read_before_after"
  | "recover_1000_usage"
  | "sync_loopback_503";
type Sample = {
  side: Side;
  scenario: Scenario;
  iteration: number;
  warmup: boolean;
  wallMs: number;
  rssBytes: number;
  processes: number;
  stateFiles: number;
  evidence: ReturnType<typeof Evidence>;
};
const scenarios: Scenario[] = [
  "version",
  "codex_session_start",
  "codex_prompt",
  "codex_edit_before_after",
  "claude_read_before_after",
  "recover_1000_usage",
  "sync_loopback_503",
];

export async function Main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      out: { type: "string" },
      samples: { type: "string", default: "15" },
      "recovery-samples": { type: "string", default: "5" },
      warmup: { type: "string", default: "2" },
    },
    strict: true,
  });
  if (!values.baseline || !values.candidate || !values.out)
    throw new Error(
      "Usage: bun scripts/benchmark.ts --baseline PATH --candidate PATH --out DIRECTORY [--samples 15 --recovery-samples 5 --warmup 2]",
    );
  const samples = Number(values.samples),
    recoverySamples = Number(values["recovery-samples"]),
    warmup = Number(values.warmup);
  if (
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    !Number.isSafeInteger(recoverySamples) ||
    recoverySamples < 1 ||
    !Number.isSafeInteger(warmup) ||
    warmup < 0
  )
    throw new Error("invalid sample count");
  const out = resolve(values.out),
    base = mkdtempSync(join(tmpdir(), "pr-cost-benchmark-"));
  mkdirSync(out, { recursive: true });
  const project = join(base, "project"),
    home = join(base, "home"),
    frozen = join(base, "executables");
  for (const p of [project, home, frozen]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const binaries = { baseline: join(frozen, "baseline"), candidate: join(frozen, "candidate") };
  for (const side of ["baseline", "candidate"] as const)
    cpSync(resolve(values[side]!), binaries[side]);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const report: any = {
    startedAt: new Date().toISOString(),
    host: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      loadavg: loadavg(),
    },
    method: {
      samples,
      recoverySamples,
      warmup,
      order: "independently shuffled paired processes per scenario and iteration",
      timing:
        "parent wall clock includes native /usr/bin/time wrapper; two-tool scenarios sum both invocations",
      rss: "maximum child RSS from native time, bytes; two-tool scenarios take higher of both",
      dataset:
        "fresh owned state per side/run; identical project and native JSON; 1000 Codex request counters; no external network or auth",
      rssTimeWrapper: true,
    },
    executables: Object.fromEntries(
      (["baseline", "candidate"] as const).map((side) => [
        side,
        {
          path: resolve(values[side]!),
          sha256: sha256(binaries[side]),
          bytes: statSync(binaries[side]).size,
        },
      ]),
    ),
    samples: [] as Sample[],
    parityChecks: [] as any[],
  };
  const save = () =>
    writeFileSync(join(out, "benchmark.json"), JSON.stringify(report, null, 2) + "\n");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("fixture offline", { status: 503 }),
  });
  const apiUrl = server.url.href.slice(0, -1),
    key = "synthetic-benchmark-key",
    credentialHash = createHash("sha256")
      .update("\0" + key)
      .digest("hex");
  const baseEnv: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GLAB_NO_PROMPT: "true",
    LANG: "C",
    LC_ALL: "C",
  };
  const tail = "unchanged payload line\n".repeat(3000),
    before = "before\n" + tail,
    after = "after\n" + tail,
    path = join(project, "file.txt"),
    transcript = join(base, "rollout.jsonl");
  const session = "benchmark-codex-session",
    turn = "benchmark-turn",
    at = "2026-10-23T12:30:40.123456789Z";
  const run = async (side: Side, args: string[], state: string, input?: any, timed = false) => {
    const env = { ...baseEnv, KIMCHI_ADAPTERS_HOME: state };
    const command = timed
      ? [
          "/usr/bin/time",
          ...(platform() === "darwin" ? ["-l"] : ["-f", "KIMCHI_BENCH_RSS_KIB=%M"]),
          binaries[side],
          ...args,
        ]
      : [binaries[side], ...args];
    const start = performance.now(),
      proc = Bun.spawn(command, {
        env,
        stdin: input === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const wallMs = performance.now() - start;
    if (code !== 0) throw new Error(`${side} ${args.join(" ")} failed ${code}: ${stderr}`);
    let rssBytes = 0;
    if (timed)
      for (const line of stderr.split("\n")) {
        if (platform() === "darwin" && line.trim().endsWith("maximum resident set size"))
          rssBytes = Number.parseInt(line.trim(), 10);
        if (line.startsWith("KIMCHI_BENCH_RSS_KIB="))
          rssBytes = Number(line.slice("KIMCHI_BENCH_RSS_KIB=".length)) * 1024;
      }
    if (timed && (!Number.isFinite(rssBytes) || rssBytes <= 0))
      throw new Error("native time did not return RSS");
    if (args[0] === "hook" && stdout !== "") throw new Error(`${side} passive hook wrote stdout`);
    return { wallMs, rssBytes, stdout };
  };
  const codex = (name: string, extra: any = {}) => ({
    hook_event_name: name,
    session_id: session,
    turn_id: turn,
    cwd: project,
    transcript_path: transcript,
    ...extra,
  });
  const claude = (stage: string, event: any = {}) => ({
    stage,
    sessionId: "benchmark-claude-session",
    cwd: project,
    version: "fixture",
    event,
  });
  const sample = async (
    side: Side,
    scenario: Scenario,
    iteration: number,
    isWarmup: boolean,
  ): Promise<Sample> => {
    const state = join(base, "states", `${scenario}-${iteration}-${side}`);
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(path, before);
    const config =
      scenario === "sync_loopback_503"
        ? {
            apiUrl,
            organizationId: "11111111-1111-1111-1111-111111111111",
            actorId: "22222222-2222-2222-2222-222222222222",
            apiKey: key,
            credentialHash,
            enabled: true,
          }
        : { enabled: false };
    writeFileSync(join(state, "config.json"), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: at,
        type: "session_meta",
        payload: { id: session, cli_version: "fixture", cwd: project },
      }) + "\n",
    );
    if (scenario === "recover_1000_usage") {
      const records = [
        {
          timestamp: at,
          type: "session_meta",
          payload: { id: session, cli_version: "fixture", cwd: project },
        },
        {
          timestamp: at,
          type: "turn_context",
          payload: { turn_id: turn, model: "benchmark-model" },
        },
      ];
      for (let i = 1; i <= 1000; i++)
        (records as any[]).push({
          timestamp: at,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 3 },
              total_token_usage: {
                input_tokens: 100 * i,
                cached_input_tokens: 10 * i,
                output_tokens: 3 * i,
              },
            },
          },
        });
      writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    const measured: { wallMs: number; rssBytes: number }[] = [];
    const execute = async (args: string[], input?: any) => {
      const result = await run(side, args, state, input, true);
      measured.push(result);
      return result;
    };
    if (scenario === "version") await execute(["version"]);
    else if (scenario === "codex_session_start")
      await execute(["hook", "codex"], codex("SessionStart"));
    else if (scenario === "claude_read_before_after") {
      await run(side, ["hook", "claude-code"], state, claude("session.start"));
      await run(
        side,
        ["hook", "claude-code"],
        state,
        claude("turn.start", { turnId: turn, text: "benchmark work" }),
      );
      const event = {
        tool: "Read",
        toolCallId: "benchmark-read",
        turnId: turn,
        tool_input: { file_path: path },
      };
      await execute(["hook", "claude-code"], claude("tool.before", event));
      await execute(["hook", "claude-code"], { ...claude("tool.after", event), result: {} });
    } else {
      await run(side, ["hook", "codex"], state, codex("SessionStart"));
      if (scenario === "codex_prompt")
        await execute(["hook", "codex"], codex("UserPromptSubmit", { prompt: "benchmark work" }));
      else {
        await run(
          side,
          ["hook", "codex"],
          state,
          codex("UserPromptSubmit", { prompt: "benchmark work" }),
        );
        if (scenario === "codex_edit_before_after") {
          const patch =
            "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch";
          const tool = {
            tool_use_id: "benchmark-edit",
            tool_name: "apply_patch",
            tool_input: patch,
          };
          await execute(["hook", "codex"], codex("PreToolUse", tool));
          writeFileSync(path, after);
          await execute(["hook", "codex"], codex("PostToolUse", tool));
        } else if (scenario === "recover_1000_usage") await execute(["recover"]);
        else await execute(["sync"]);
      }
    }
    const files = stateFiles(state),
      evidence = Evidence(state);
    if (
      scenario !== "version" &&
      scenario !== "claude_read_before_after" &&
      evidence.coverage.native_auxiliary_usage_coverage_unknown !== 1
    )
      throw new Error(`${side} lost Codex auxiliary-coverage caveat`);
    if (!["version", "codex_session_start"].includes(scenario) && evidence.events.work !== 1)
      throw new Error(`${side} lost work binding`);
    if (
      scenario === "recover_1000_usage" &&
      (evidence.usageRequests !== 1000 ||
        evidence.usageWithWork !== 1000 ||
        evidence.inputTokens !== "100000" ||
        evidence.outputTokens !== "3000" ||
        evidence.cacheReadTokens !== "10000")
    )
      throw new Error(`${side} recovery lost expected usage`);
    if (scenario === "codex_edit_before_after" && evidence.files["modified:tool_observed"] !== 1)
      throw new Error(`${side} edit attribution changed: ${JSON.stringify(evidence)}`);
    if (scenario === "claude_read_before_after" && evidence.files["read:tool_observed"] !== 1)
      throw new Error(`${side} read attribution changed: ${JSON.stringify(evidence)}`);
    if (
      scenario === "sync_loopback_503" &&
      (evidence.pending !== 2 ||
        evidence.diagnostics.upload_http_503 !== 1 ||
        evidence.diagnostics.delivery_pending !== 1)
    )
      throw new Error(`${side} offline sync did not retain the expected queue`);
    return {
      side,
      scenario,
      iteration,
      warmup: isWarmup,
      wallMs: measured.reduce((n, s) => n + s.wallMs, 0),
      rssBytes: Math.max(...measured.map((s) => s.rssBytes)),
      processes: measured.length,
      stateFiles: files,
      evidence,
    };
  };
  try {
    const git = Bun.spawnSync(["git", "-C", project, "init", "--quiet"], {
      env: baseEnv,
      stderr: "pipe",
    });
    if (git.exitCode) throw new Error("fixture Git initialization failed");
    for (const scenario of scenarios) {
      const count = scenario === "recover_1000_usage" ? recoverySamples : samples;
      for (let iteration = -warmup; iteration < count; iteration++) {
        const pair: Sample[] = [];
        const order: Side[] =
          randomInt(2) === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
        for (const side of order) {
          const result = await sample(side, scenario, iteration, iteration < 0);
          pair.push(result);
          report.samples.push(result);
          save();
        }
        const parity = JSON.stringify(pair[0]!.evidence) === JSON.stringify(pair[1]!.evidence);
        report.parityChecks.push({ scenario, iteration, order, parity });
        save();
        if (!parity)
          throw new Error(
            `evidence differs for ${scenario}, iteration ${iteration}; see ${join(out, "benchmark.json")}`,
          );
      }
    }
    report.summary = Object.fromEntries(
      scenarios.map((scenario) => [
        scenario,
        Object.fromEntries(
          (["baseline", "candidate"] as const).map((side) => {
            const selected = (report.samples as Sample[]).filter(
              (s) => s.scenario === scenario && s.side === side && !s.warmup,
            );
            return [
              side,
              {
                wallMs: Distribution(selected.map((s) => s.wallMs)),
                rssBytes: Distribution(selected.map((s) => s.rssBytes)),
                stateFiles: [...new Set(selected.map((s) => s.stateFiles))],
              },
            ];
          }),
        ),
      ]),
    );
    for (const side of ["baseline", "candidate"] as const) {
      const stage = join(base, "archive-" + side);
      mkdirSync(join(stage, "bin"), { recursive: true });
      cpSync(binaries[side], join(stage, "bin", "kimchi-adapters"));
      cpSync(join(root, "plugins"), join(stage, "plugins"), { recursive: true });
      cpSync(join(root, "install.sh"), join(stage, "install.sh"));
      cpSync(join(root, "install.sh"), join(stage, "bootstrap.sh"));
      writeFileSync(join(stage, "VERSION"), "benchmark\n");
      const archive = join(out, `${side}-comparable.tar.gz`),
        tar = Bun.spawnSync(["tar", "-czf", archive, "-C", stage, "."], {
          env: { ...baseEnv, COPYFILE_DISABLE: "1" },
          stderr: "pipe",
        });
      if (tar.exitCode) throw new Error("benchmark archive creation failed");
      report.executables[side].comparableArchiveBytes = statSync(archive).size;
    }
    report.completedAt = new Date().toISOString();
    report.host.loadavgAfter = loadavg();
    save();
    console.log(
      JSON.stringify(
        {
          report: join(out, "benchmark.json"),
          summary: report.summary,
          executables: report.executables,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    report.failure = String(error);
    if (existsSync(join(base, "states")))
      cpSync(join(base, "states"), join(out, "failed-states"), { recursive: true });
    save();
    throw error;
  } finally {
    server.stop(true);
    rmSync(base, { recursive: true, force: true });
  }
}
if (import.meta.main) await Main();
