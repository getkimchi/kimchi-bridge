import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "../src/work/capture.ts";
import {
  claudeTraceEnv,
  codexTraceConfig,
  pruneTraces,
  traceDir,
  tracedCommits,
} from "../src/work/commits.ts";
import { reconcileGit, saveMeta } from "../src/work/git.ts";
import { Store } from "../src/work/ledger.ts";
import { stableId } from "../src/work/protocol.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
function temp() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-commits-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function setEnv(name: string, value: string) {
  const prior = process.env[name];
  process.env[name] = value;
  cleanups.push(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}
function latest(store: Store, kind: string) {
  const row = store.db
    .query("SELECT body FROM events WHERE kind=? ORDER BY rowid DESC LIMIT 1")
    .get(kind) as any;
  return row && JSON.parse(Buffer.from(row.body).toString());
}
const count = (store: Store, kind: string) =>
  (store.db.query("SELECT count(*) AS n FROM events WHERE kind=?").get(kind) as any).n;

// Git runs as an agent's shell would run it: traced into `trace`, with the call in its environment.
function repo(trace = join(temp(), "trace")) {
  const root = join(temp(), "repo");
  mkdirSync(root);
  mkdirSync(trace, { recursive: true });
  const run = (env: Record<string, string>, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Lab",
        "-c",
        "user.email=lab@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        // Ref traces print Git's local time; bun test runs JavaScript in UTC.
        env: { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  const traced = (call: string, ...args: string[]) =>
    run(
      {
        GIT_TRACE2_EVENT: join(trace, "events"),
        GIT_TRACE_REFS: join(trace, "refs"),
        GIT_TRACE2_ENV_VARS: "CODEX_TOOL_CALL_ID",
        ...(call ? { CODEX_TOOL_CALL_ID: call } : {}),
      },
      ...args,
    );
  const plain = (...args: string[]) => run({}, ...args);
  plain("init", "-q", "-b", "main");
  writeFileSync(join(root, "f"), "1\n");
  plain("add", "f");
  plain("commit", "-q", "-m", "init");
  const commits = () => tracedCommits(join(trace, "events"), join(trace, "refs"));
  return { root, trace, traced, plain, commits };
}

test("agent shell commits, amends, reverts and new merges count; other ref moves do not", () => {
  const g = repo();
  writeFileSync(join(g.root, "f"), "2\n");
  g.traced("call-1", "commit", "-q", "-am", "two");
  const two = g.plain("rev-parse", "HEAD");
  g.traced("call-1", "commit", "-q", "--amend", "-m", "two amended");
  const amended = g.plain("rev-parse", "HEAD");
  g.traced("call-1", "revert", "--no-edit", "HEAD");
  const reverted = g.plain("rev-parse", "HEAD");
  expect(() => g.traced("call-1", "commit", "-q", "-m", "nothing staged")).toThrow();
  g.traced("call-1", "checkout", "-q", "-b", "side");
  writeFileSync(join(g.root, "g"), "side\n");
  g.plain("add", "g");
  // A person's commit outside the agent shell is never in its trace.
  g.plain("commit", "-q", "-m", "side");
  g.traced("call-1", "checkout", "-q", "main");
  g.traced("call-1", "merge", "-q", "--no-ff", "-m", "merge side", "side");
  const merged = g.plain("rev-parse", "HEAD");
  g.traced("call-1", "reset", "-q", "--hard", "HEAD~1");
  g.traced("call-1", "merge", "-q", "--ff-only", "side");
  expect(g.commits().map(({ sha, worktree, call }) => ({ sha, worktree, call }))).toEqual(
    [two, amended, reverted, merged].map((sha) => ({ sha, worktree: g.root, call: "call-1" })),
  );
});

test("a cherry-pick of this agent's commit names the commit it replays", () => {
  const g = repo();
  g.plain("checkout", "-q", "-b", "side");
  writeFileSync(join(g.root, "g"), "pick\n");
  g.plain("add", "g");
  g.traced("call-1", "commit", "-q", "-m", "pick me");
  const original = g.plain("rev-parse", "HEAD");
  g.plain("checkout", "-q", "main");
  g.traced("call-1", "cherry-pick", original);
  const copy = g.plain("rev-parse", "HEAD");
  expect(g.commits().map((c) => [c.sha, c.rewrittenFrom])).toEqual([
    [original, undefined],
    [copy, original],
  ]);
});

function session(source: string) {
  const home = temp();
  setEnv("KIMCHI_BRIDGE_HOME", home);
  const g = repo(traceDir(source, "s"));
  g.plain("remote", "add", "origin", "https://github.com/lumbrook/widgets.git");
  const store = new Store(join(home, "ledger"));
  cleanups.push(() => store.close());
  const r = new Recorder(store, source, store.deviceId());
  const hook = (stage: string, extra: Record<string, unknown> = {}) =>
    r.record({ stage, event: { session_id: "s", turn_id: "t", cwd: g.root, ...extra } });
  hook("UserPromptSubmit", { prompt: "ship it" });
  const shell = (id: string) => ({
    tool_use_id: id,
    tool_name: source === "codex" ? "exec_command" : "Bash",
    tool_input: { command: "git commit" },
  });
  return { g, store, r, hook, shell };
}

test("a Codex shell call records only its own commit, for PR lookup", () => {
  const { g, store, r, hook, shell } = session("codex");
  hook("PreToolUse", shell("call-1"));
  expect(existsSync(traceDir("codex", "s"))).toBe(true);
  writeFileSync(join(g.root, "f"), "other\n");
  g.traced("call-other", "commit", "-q", "-am", "another session's commit");
  writeFileSync(join(g.root, "f"), "mine\n");
  g.traced("call-1", "commit", "-q", "-am", "mine");
  const sha = g.plain("rev-parse", "HEAD"),
    work = r.work({ Session: "s", Turn: "t", Agent: "", CWD: g.root, Root: g.root, Repo: "" });
  hook("PostToolUse", shell("call-1"));
  expect(count(store, "commit")).toBe(1);
  expect(latest(store, "commit")).toMatchObject({
    workId: work,
    commit: { id: sha, quality: "observed" },
  });
  expect(latest(store, "link").link).toEqual({
    fromKind: "work",
    fromId: work,
    toKind: "commit",
    toId: sha,
    quality: "observed",
    reason: "agent_commit",
  });
  const repo = latest(store, "commit").repository;
  expect(repo).toMatchObject({ provider: "github", host: "github.com", name: "lumbrook/widgets" });
  expect(
    store.db.query("SELECT key FROM meta WHERE key LIKE 'tracked-commit:%'").all(),
  ).toHaveLength(1);
});

test("a commit made after its call returned is recorded for that call's work", () => {
  const { g, store, r, hook, shell } = session("codex");
  hook("PreToolUse", shell("call-1"));
  hook("PostToolUse", shell("call-1"));
  // Unified exec: the command commits later, while another call polls it.
  hook("PreToolUse", shell("call-2"));
  writeFileSync(join(g.root, "f"), "2\n");
  g.traced("call-1", "commit", "-q", "-am", "two");
  hook("PostToolUse", shell("call-2"));
  expect(latest(store, "commit").commit.id).toBe(g.plain("rev-parse", "HEAD"));
  expect(latest(store, "link").workId).toBe(
    r.work({ Session: "s", Turn: "t", Agent: "", CWD: g.root, Root: g.root, Repo: "" }),
  );
});

test("quiet or oversized traces are dropped; a session's directory goes after a quiet day", () => {
  setEnv("KIMCHI_BRIDGE_HOME", temp());
  const codex = traceDir("codex", ""),
    claude = traceDir("claude-code", "s");
  for (const dir of [codex, claude]) {
    mkdirSync(dir, { recursive: true });
    for (const name of ["events", "refs"]) writeFileSync(join(dir, name), "x\n");
  }
  const now = Date.now();
  pruneTraces(now + 60_000);
  expect(existsSync(join(codex, "refs"))).toBe(true);
  pruneTraces(now + 11 * 60_000);
  expect(existsSync(join(codex, "refs"))).toBe(false);
  expect(existsSync(join(claude, "refs"))).toBe(false);
  expect(existsSync(claude)).toBe(true);
  pruneTraces(now + 2 * 86400_000);
  expect(existsSync(claude)).toBe(false);
  expect(existsSync(codex)).toBe(true);
});

test("a Claude Code session's lone shell call owns its trace even without a logged call ID", () => {
  const { g, store, hook, shell } = session("claude-code");
  hook("PreToolUse", shell("toolu_1"));
  writeFileSync(join(g.root, "f"), "2\n");
  g.traced("", "commit", "-q", "-am", "two");
  hook("PostToolUse", shell("toolu_1"));
  expect(latest(store, "commit").commit.id).toBe(g.plain("rev-parse", "HEAD"));
});

test("an overlapping shell call claims nothing it cannot identify", () => {
  const { g, store, hook, shell } = session("claude-code");
  hook("PreToolUse", shell("toolu_1"));
  hook("PreToolUse", shell("toolu_2"));
  writeFileSync(join(g.root, "f"), "2\n");
  g.traced("", "commit", "-q", "-am", "two");
  hook("PostToolUse", shell("toolu_1"));
  expect(count(store, "commit")).toBe(0);
  hook("PostToolUse", shell("toolu_2"));
  expect(count(store, "commit")).toBe(1);
});

test("PR lookups follow Kimchi's schedule and stop when done", () => {
  const home = temp(),
    bin = join(home, "bin"),
    calls = join(home, "calls");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho x >> "${calls}"\ncase "$*" in\n *repos/lumbrook/widgets/commits/*) /bin/cat "${home}/pulls.json" ;;\n *repos/lumbrook/widgets*) /bin/cat "${home}/repo.json" ;;\n *) exit 1 ;;\nesac\n`,
    { mode: 0o700 },
  );
  setEnv("PATH", `${bin}:${process.env.PATH}`);
  writeFileSync(
    join(home, "repo.json"),
    JSON.stringify({
      id: 5,
      full_name: "lumbrook/widgets",
      html_url: "https://github.com/lumbrook/widgets",
    }),
  );
  writeFileSync(join(home, "pulls.json"), "[]");
  const store = new Store(join(home, "ledger"));
  cleanups.push(() => store.close());
  const r = new Recorder(store, "codex", store.deviceId());
  const Scope = {
    Session: "s",
    Turn: "t",
    Agent: "",
    CWD: home,
    Root: home,
    Repo: "local:x",
    Repository: { provider: "github", host: "github.com", id: "name:x", name: "lumbrook/widgets" },
  };
  const sha = "b".repeat(40),
    key = `tracked-commit:${stableId(Scope.Repo, sha)}`;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const pass = (createdAgo: number, checkedAgo: number, found = false) => {
    saveMeta(r, key, {
      Scope,
      Source: "codex",
      SHA: sha,
      CreatedAt: ago(createdAgo),
      CheckedAt: ago(checkedAgo),
      Found: found,
    });
    store.db.query("DELETE FROM meta WHERE key IN ('git-last-pass','git-pass-after')").run();
    rmSync(calls, { force: true });
    reconcileGit(r);
    return existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
  };
  const day = 86400_000;
  // Ten days old: due after 15 hours (age/16).
  expect(pass(10 * day, 3600_000)).toBe(0);
  expect(pass(10 * day, 16 * 3600_000)).toBeGreaterThan(0);
  // A month old with no PR: dropped without a lookup; one with a PR keeps refreshing.
  expect(pass(33 * day, 2 * day)).toBe(0);
  expect(store.db.query("SELECT 1 FROM meta WHERE key=?").get(key)).toBeNull();
  expect(pass(33 * day, 2 * day, true)).toBeGreaterThan(0);
  // Every PR merged: no more lookups.
  writeFileSync(
    join(home, "pulls.json"),
    JSON.stringify([
      {
        id: 42,
        number: 7,
        html_url: "https://github.com/lumbrook/widgets/pull/7",
        state: "closed",
        merged_at: "2026-10-29T08:00:00Z",
        title: "Widgets",
        base: { repo: { id: 5, full_name: "lumbrook/widgets" } },
      },
    ]),
  );
  expect(pass(day, day)).toBeGreaterThan(0);
  const merged = JSON.parse(
    (store.db.query("SELECT value FROM meta WHERE key=?").get(key) as any).value,
  );
  expect(merged).toMatchObject({ Found: true, Merged: true });
  store.db.query("DELETE FROM meta WHERE key IN ('git-last-pass','git-pass-after')").run();
  rmSync(calls, { force: true });
  reconcileGit(r);
  expect(existsSync(calls)).toBe(false);
});

test("a due commit is looked up right after another pass; nothing due waits for the gate", () => {
  const home = temp(),
    bin = join(home, "bin"),
    calls = join(home, "calls");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho x >> "${calls}"\ncase "$*" in\n *commits/*) echo "[]" ;;\n *) echo '{"id":5,"full_name":"lumbrook/widgets","html_url":"https://github.com/lumbrook/widgets"}' ;;\nesac\n`,
    { mode: 0o700 },
  );
  setEnv("PATH", `${bin}:${process.env.PATH}`);
  const store = new Store(join(home, "ledger"));
  cleanups.push(() => store.close());
  const r = new Recorder(store, "codex", store.deviceId());
  const Scope = {
    Session: "s",
    Turn: "t",
    Agent: "",
    CWD: home,
    Root: home,
    Repo: "local:x",
    Repository: { provider: "github", host: "github.com", id: "name:x", name: "lumbrook/widgets" },
  };
  const key = `tracked-commit:${stableId(Scope.Repo, "c".repeat(40))}`;
  const looked = (checkedAgo: number | null) => {
    saveMeta(r, key, {
      Scope,
      Source: "codex",
      SHA: "c".repeat(40),
      CreatedAt: new Date(Date.now() - 3600_000).toISOString(),
      CheckedAt:
        checkedAgo === null
          ? "0001-01-01T00:00:00Z"
          : new Date(Date.now() - checkedAgo).toISOString(),
    });
    // A Codex Stop a few seconds after the prompt's pass.
    store.setMeta("git-last-pass", String(Math.floor(Date.now() / 1000)));
    rmSync(calls, { force: true });
    reconcileGit(r);
    return existsSync(calls);
  };
  expect(looked(null)).toBe(true);
  // An hour old: due every 225 s (age/16).
  expect(looked(1000)).toBe(false);
  expect(looked(300_000)).toBe(true);
});

test("Codex's trace environment joins its user config safely and leaves cleanly", () => {
  setEnv("KIMCHI_BRIDGE_HOME", temp());
  const home = temp(),
    path = join(home, "config.toml");
  const read = () => Bun.TOML.parse(readFileSync(path, "utf8")) as any;
  writeFileSync(path, 'model = "lab"\n\n[shell_environment_policy]\ninherit = "core"\n');
  expect(codexTraceConfig(true, home)).toBe(true);
  expect(codexTraceConfig(true, home)).toBe(true);
  expect(read().model).toBe("lab");
  expect(read().shell_environment_policy).toEqual({
    inherit: "core",
    set: {
      GIT_TRACE2_EVENT: join(traceDir("codex", ""), "events"),
      GIT_TRACE_REFS: join(traceDir("codex", ""), "refs"),
      GIT_TRACE2_ENV_VARS: "CODEX_TOOL_CALL_ID",
    },
  });
  expect(existsSync(traceDir("codex", ""))).toBe(true);
  expect(codexTraceConfig(false, home)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(
    'model = "lab"\n\n[shell_environment_policy]\ninherit = "core"\n',
  );
  for (const own of [
    '[shell_environment_policy.set]\nFOO = "1"\n',
    'shell_environment_policy = { inherit = "all" }\n',
    'shell_environment_policy.inherit = "all"\n',
  ]) {
    writeFileSync(path, own);
    expect(codexTraceConfig(true, home)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(own);
  }
  rmSync(path);
  expect(codexTraceConfig(true, home)).toBe(true);
  expect(read().shell_environment_policy.set.GIT_TRACE2_ENV_VARS).toBe("CODEX_TOOL_CALL_ID");
});

test("settings Codex appends inside the trace block survive a reinstall and its removal", () => {
  setEnv("KIMCHI_BRIDGE_HOME", temp());
  const home = temp(),
    path = join(home, "config.toml");
  const read = () => Bun.TOML.parse(readFileSync(path, "utf8")) as any;
  writeFileSync(path, 'model = "lab"\n');
  expect(codexTraceConfig(true, home)).toBe(true);
  // Codex appends new tables at the end of the file, before the block's last line, as it saves trust.
  const hook = "kimchi-work@kimchi-bridge:hooks/hooks.json:stop:0:0";
  const codex = `[projects."/work"]\ntrust_level = "trusted"\n\n[hooks.state."${hook}"]\ntrusted_hash = "sha256:1"\n\n`;
  const text = readFileSync(path, "utf8"),
    end = text.indexOf("# kimchi-bridge: end");
  writeFileSync(path, text.slice(0, end) + codex + text.slice(end));
  const kept = {
    projects: { "/work": { trust_level: "trusted" } },
    hooks: { state: { [hook]: { trusted_hash: "sha256:1" } } },
  };
  expect(codexTraceConfig(true, home)).toBe(true);
  expect(read()).toMatchObject(kept);
  expect(read().shell_environment_policy.set.GIT_TRACE2_ENV_VARS).toBe("CODEX_TOOL_CALL_ID");
  expect(codexTraceConfig(false, home)).toBe(true);
  expect(read()).toEqual({ model: "lab", ...kept });
  // A setting someone adds under the bridge's table keeps the table when the bridge leaves.
  expect(codexTraceConfig(true, home)).toBe(true);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "[shell_environment_policy.set]\n",
      '[shell_environment_policy.set]\nFOO = "1"\n',
    ),
  );
  expect(codexTraceConfig(false, home)).toBe(true);
  expect(read().shell_environment_policy).toEqual({ set: { FOO: "1" } });
});

test("Claude Code's session environment names its own trace directory", () => {
  setEnv("KIMCHI_BRIDGE_HOME", temp());
  const dir = traceDir("claude-code", "s");
  expect(claudeTraceEnv("s")).toBe(
    `export GIT_TRACE2_EVENT='${dir}/events'\nexport GIT_TRACE_REFS='${dir}/refs'\nexport GIT_TRACE2_ENV_VARS='CLAUDE_CODE_TOOL_USE_ID'\n`,
  );
  expect(existsSync(dir)).toBe(true);
});
