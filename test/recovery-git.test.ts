import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder, repository, type Scope } from "../src/work/capture.ts";
import {
  git,
  issueKeys,
  providerId,
  pullRequest,
  reconcileGit,
  saveMeta,
  scmEnvironment,
} from "../src/work/git.ts";
import { recordTag } from "../src/request-tags.ts";
import { Store } from "../src/work/ledger.ts";
import { parseJson, stableId } from "../src/work/protocol.ts";
import {
  claudeUsage,
  openAiUsage,
  recoverContext,
  registerTranscript,
  route,
  saveSourceVersion,
  telemetry,
} from "../src/work/recovery.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
function fixture(source = "codex") {
  const base = mkdtempSync(join(tmpdir(), "pr-cost-recovery-"));
  const root = join(base, "project");
  mkdirSync(root);
  const store = new Store(join(base, "state"));
  const r = new Recorder(store, source, store.deviceId());
  cleanups.push(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  const scope: Scope = {
    Session: "s",
    Turn: "turn",
    Agent: "",
    CWD: root,
    Root: root,
    Repo: `local:${root}`,
  };
  return { base, root, store, r, scope };
}
function latest(store: Store, kind: string) {
  return JSON.parse(
    Buffer.from(
      (
        store.db
          .query("SELECT body FROM events WHERE kind=? ORDER BY rowid DESC LIMIT 1")
          .get(kind) as any
      ).body,
    ).toString(),
  );
}
function gitFixture(source: string) {
  const f = fixture(source),
    path = join(f.root, "file.txt");
  git(f.root, "init", "--initial-branch=main");
  git(f.root, "config", "user.email", "fixture@example.invalid");
  git(f.root, "config", "user.name", "Fixture");
  git(f.root, "config", "commit.gpgsign", "false");
  git(f.root, "config", "core.hooksPath", "/dev/null");
  const commit = () => {
    git(f.root, "add", ".");
    git(f.root, "commit", "-m", "fixture");
    return git(f.root, "rev-parse", "HEAD");
  };
  writeFileSync(path, "before\n");
  commit();
  f.r.record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "turn", cwd: f.root, prompt: "implement" },
  });
  let call = 0;
  const edit = (
    before: string,
    after: string,
    { recorder = f.r, session = "s", turn = "turn", agent = "", actual = after } = {},
  ) => {
    const event = {
      session_id: session,
      turn_id: turn,
      agent_id: agent,
      cwd: f.root,
      tool_use_id: `edit-${++call}`,
      ...(recorder.source === "codex"
        ? {
            tool_name: "apply_patch",
            tool_input: {
              command: `*** Begin Patch\n*** Update File: file.txt\n@@\n-${before}\n+${after}\n*** End Patch`,
            },
          }
        : {
            tool_name: "Edit",
            tool_input: { file_path: path, old_string: before, new_string: after },
          }),
    };
    recorder.record({ stage: "PreToolUse", event });
    writeFileSync(path, actual + "\n");
    recorder.record({ stage: "PostToolUse", event });
  };
  return { ...f, path, commit, edit };
}
const at = "2026-10-23T12:00:00.123456789Z";

test("Codex recovery preserves absent usage, lossless counter identity, duplicate and partial-line replay", () => {
  const { root, store, r, scope } = fixture();
  r.record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "turn", cwd: root, prompt: "implement" },
  });
  const [canonical, repo, ref] = repository(root);
  Object.assign(scope, { Root: canonical, Repo: repo, Repository: ref });
  const path = join(root, "rollout.jsonl");
  registerTranscript(r, scope, path, "custom-gateway", "unknown");
  const context = {
    timestamp: at,
    type: "turn_context",
    payload: { turn_id: "turn", model: "observed-model" },
  };
  const usage = {
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 3 },
        total_token_usage: { input_tokens: 100, output_tokens: 3 },
      },
    },
  };
  writeFileSync(
    path,
    JSON.stringify(context) + "\n" + JSON.stringify(usage) + "\n" + JSON.stringify(usage),
  );
  recoverContext(r);
  const event = latest(store, "usage");
  expect(event.usage.raw).toEqual({ inputTokens: "100", outputTokens: "3", cacheReadTokens: "10" });
  expect(event.usage.reportedModel).toBe("observed-model");
  expect(event.observeTime).toBe(at);
  expect(event.workId).toBeTruthy();
  appendFileSync(path, "\n");
  recoverContext(r);
  recoverContext(r);
  expect(
    (store.db.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
  ).toBe(1);
  appendFileSync(
    path,
    JSON.stringify({
      ...usage,
      payload: {
        ...usage.payload,
        info: { ...usage.payload.info, total_token_usage: { input_tokens: 200, output_tokens: 6 } },
      },
    }) + "\n",
  );
  recoverContext(r);
  expect(
    (store.db.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
  ).toBe(2);
});

test("Claude telemetry and transcript revise one request and attach its exact tool identity", () => {
  const { root, store, r, scope } = fixture("claude-code");
  r.record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "turn", cwd: root, prompt: "implement" },
  });
  const [canonical, repo, ref] = repository(root);
  Object.assign(scope, { Root: canonical, Repo: repo, Repository: ref });
  store.db.query("INSERT INTO meta(key,value) VALUES(?,?)").run("prompt-turn:s:prompt", "turn");
  const request = "00000000-0000-0000-0000-000000000001";
  const e = parseJson(
    JSON.stringify({
      event: "api_request",
      attributes: {
        request_id: request,
        "event.timestamp": at,
        "prompt.id": "prompt",
        model: "model",
        input_tokens: 11,
        output_tokens: 5,
        cache_read_tokens: 13,
        cache_creation_tokens: 7,
        cache_creation_5m_tokens: 3,
        cache_creation_1h_tokens: 4,
      },
    }),
  );
  telemetry(r, scope, e, "castai", "unknown");
  const path = join(root, "claude.jsonl");
  registerTranscript(r, scope, path, "castai", "unknown");
  writeFileSync(
    path,
    JSON.stringify({ type: "atis-latch" }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        timestamp: at,
        requestId: request,
        message: {
          id: "message",
          model: "model",
          usage: {
            input_tokens: 11,
            output_tokens: 5,
            cache_read_input_tokens: 13,
            cache_creation_input_tokens: 7,
            cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
          },
        },
      }) +
      "\n",
  );
  recoverContext(r);
  telemetry(r, scope, e, "castai", "unknown");
  recoverContext(r);
  expect(
    store.db
      .query(
        "SELECT count(DISTINCT entity_id) AS entities,count(*) AS revisions FROM events WHERE kind='usage'",
      )
      .get(),
  ).toEqual({ entities: 1, revisions: 2 });
  const event = latest(store, "usage");
  expect(event.usage.channel).toBe("transcript");
  expect(event.usage.raw.cacheWrites).toEqual([
    { ttlSeconds: 300, tokens: "3" },
    { ttlSeconds: 3600, tokens: "4" },
  ]);
  // The backend reads castai-request-id as a bill ID, which a gateway request ID is not; tagged calls name their bill instead.
  expect(event.usage.aliases).toBeUndefined();
  expect(event.workId).toBeTruthy();
  appendFileSync(
    path,
    JSON.stringify({ type: "assistant", message: { id: "bad", usage: { input_tokens: 1 } } }) +
      "\n",
  );
  expect(() => recoverContext(r)).toThrow("transcript recovery incomplete");
});

test.each(["flat", "nested", "mixed", "zero-flat", "invalid-flat"])(
  "Claude %s iteration counters survive transcript recovery",
  (shape) => {
    const { root, store, r, scope } = fixture("claude-code");
    const path = join(root, "claude.jsonl");
    registerTranscript(r, scope, path, "customer-gateway", "unknown");
    const raw = {
      input_tokens: 101,
      output_tokens: 11,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
    };
    const iteration = shape === "nested" ? { usage: raw } : { ...raw };
    if (shape === "mixed")
      Object.assign(iteration, { usage: { input_tokens: 999, output_tokens: 999 } });
    const first =
      shape === "zero-flat" || shape === "invalid-flat"
        ? { input_tokens: shape === "zero-flat" ? 0 : "invalid", usage: raw }
        : iteration;
    writeFileSync(
      path,
      JSON.stringify({
        type: "assistant",
        timestamp: at,
        message: {
          id: "flat-iterations",
          model: "returned",
          usage: {
            input_tokens: 202,
            output_tokens: 22,
            iterations: [
              { type: "message", model: "primary", ...first },
              { type: "fallback_message", model: "returned", input_tokens: 202, output_tokens: 22 },
            ],
          },
        },
      }) + "\n",
    );
    recoverContext(r);
    const event = latest(store, "usage");
    expect(event.usage.raw).toEqual({ inputTokens: "202", outputTokens: "22" });
    expect(event.usage.iterations.map((item: any) => [item.model, item.raw])).toEqual([
      [
        "primary",
        shape === "zero-flat"
          ? { inputTokens: "0" }
          : shape === "invalid-flat"
            ? {}
            : {
                inputTokens: "101",
                outputTokens: "11",
                cacheReadTokens: "0",
                cacheWriteTokens: "7",
                cacheWrites: [
                  { ttlSeconds: 300, tokens: "3" },
                  { ttlSeconds: 3600, tokens: "4" },
                ],
              },
      ],
      ["returned", { inputTokens: "202", outputTokens: "22" }],
    ]);
    recoverContext(r);
    expect(
      (store.db.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
    ).toBe(1);
  },
);

test("GitHub PRs carry Kimchi's lowercase repository path; GitLab keeps its case", () => {
  const github = parseJson(
    '{"id":11,"number":34,"html_url":"https://github.com/Lumbrook/Widgets/pull/34","state":"open","title":"t","base":{"repo":{"id":12,"full_name":"Lumbrook/Widgets"}}}',
  );
  const [repo, pr] = pullRequest({ provider: "github", host: "github.com", id: "name:x" }, github);
  expect([repo.name, pr.uri]).toEqual([
    "lumbrook/widgets",
    "https://github.com/lumbrook/widgets/pull/34",
  ]);
  const gitlab = parseJson(
    '{"id":21,"iid":5,"web_url":"https://gitlab.com/Lumbrook/Widgets/-/merge_requests/5","state":"opened","title":"t","target_project_id":22}',
  );
  const [glRepo, mr] = pullRequest(
    { provider: "gitlab", host: "gitlab.com", id: "name:x" },
    gitlab,
  );
  expect([glRepo.name, mr.uri]).toEqual([
    "Lumbrook/Widgets",
    "https://gitlab.com/Lumbrook/Widgets/-/merge_requests/5",
  ]);
});

test("SCM IDs remain exact, target repository owns fork PRs and credentials stay host-bound", () => {
  const source = { provider: "github", host: "github.com", name: "fork/repo", id: "name:fixture" };
  const raw = parseJson(
    '{"id":9007199254740993,"number":7,"html_url":"https://github.com/target/repo/pull/7","state":"open","title":"WID-12: feature","base":{"repo":{"id":9007199254740995,"full_name":"target/repo"}}}',
  );
  const [repo, pr] = pullRequest(source, raw);
  expect(repo.id).toBe("9007199254740995");
  expect(pr.id).toBe("9007199254740993");
  expect(pr.issueKeys).toEqual([{ key: "WID-12", source: "title" }]);
  expect(providerId(parseJson("9223372036854775808"))).toBe("");
  expect(providerId(parseJson("1e3"))).toBe("");
  expect(() => pullRequest({ ...source, host: "untrusted.example" }, raw)).toThrow();
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "synthetic-secret";
  try {
    expect(scmEnvironment({ ...source, host: "untrusted.example" }).GH_TOKEN).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
  expect(issueKeys("ABC-1 ABC-1 DEF-2", "title")).toHaveLength(2);
  for (const text of ["ABC-123.4", "éABC-123", "ABC-123é", "😀ABC-123"])
    expect(issueKeys(text, "title")).toEqual([{ key: "ABC-123", source: "title" }]);
  for (const text of ["_ABC-123", "ABC-123_", "ABC-123abc", "123ABC-1"])
    expect(issueKeys(text, "title")).toEqual([]);
  expect(issueKeys("A-1", "title")).toEqual([{ key: "A-1", source: "title" }]);
});

test.if(process.platform === "darwin")(
  "gh and glab are found where Homebrew installs them when a session starts without the shell's PATH",
  () => {
    const repo = { provider: "github", host: "github.com", name: "testOrg/widgets", id: "name:x" };
    const previous = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      expect(scmEnvironment(repo).PATH).toBe("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
      process.env.PATH = "/opt/homebrew/bin:/usr/bin";
      expect(scmEnvironment(repo).PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin");
    } finally {
      process.env.PATH = previous;
    }
  },
);

test("native int64 usage readers preserve decimal identity before bounded event validation", () => {
  const raw = parseJson(
    '{"input_tokens":9007199254740993,"output_tokens":1e3,"cache_read_input_tokens":-0}',
  );
  expect(openAiUsage(raw).inputTokens).toBe("9007199254740993");
  expect(claudeUsage(raw).inputTokens).toBe("9007199254740993");
  expect(claudeUsage(raw).cacheReadTokens).toBe("0");
  expect(claudeUsage(raw).outputTokens).toBeUndefined();
});

test("a lone message iteration takes the reply's model; other unnamed iterations stay unknown", () => {
  const { root, store, r, scope } = fixture("claude-code");
  const path = join(root, "iterations.jsonl");
  registerTranscript(r, scope, path, "provider-api", "unknown");
  const reply = (id: string, iterations: object[]) =>
    JSON.stringify({
      type: "assistant",
      timestamp: at,
      message: {
        id,
        model: "claude-opus-5-5",
        usage: { input_tokens: 2, output_tokens: 395, iterations },
      },
    }) + "\n";
  const counts = { input_tokens: 2, output_tokens: 395 };
  writeFileSync(path, reply("lone", [{ type: "message", ...counts }]));
  recoverContext(r);
  expect(latest(store, "usage").usage.iterations.map((item: any) => item.model)).toEqual([
    "claude-opus-5-5",
  ]);
  appendFileSync(
    path,
    reply("several", [
      { type: "message", ...counts },
      { type: "compaction", ...counts },
    ]),
  );
  recoverContext(r);
  expect(latest(store, "usage").usage.iterations.map((item: any) => item.model ?? "")).toEqual([
    "",
    "",
  ]);
});

test("Codex usage carries the service tier its thread settings ask for", () => {
  const { root, store, r, scope } = fixture();
  const path = join(root, "tier.jsonl");
  registerTranscript(r, scope, path, "unknown", "unknown");
  const line = (payload: object) =>
    JSON.stringify({ timestamp: at, type: "event_msg", payload }) + "\n";
  const usage = (total: number) =>
    line({
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 1, output_tokens: 1 },
        total_token_usage: { input_tokens: total, output_tokens: total },
      },
    });
  const tier = () => latest(store, "usage").usage.serviceTier;
  writeFileSync(path, usage(1));
  recoverContext(r);
  expect(tier()).toBeUndefined();
  appendFileSync(path, line({ type: "thread_settings_applied", thread_settings: {} }) + usage(2));
  recoverContext(r);
  expect(tier()).toBe("default");
  appendFileSync(
    path,
    line({ type: "thread_settings_applied", thread_settings: { service_tier: "priority" } }) +
      usage(3),
  );
  recoverContext(r);
  expect(tier()).toBe("priority");
});

test("batched recovery commits the valid prefix and resumes without another charge", () => {
  const { root, store, r, scope } = fixture();
  const path = join(root, "batch.jsonl");
  registerTranscript(r, scope, path, "provider-api", "unknown");
  const lines = Array.from(
    { length: 240 },
    (_, i) =>
      JSON.stringify({
        timestamp: at,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 1, output_tokens: 1 },
            total_token_usage: { input_tokens: i + 1, output_tokens: i + 1 },
          },
        },
      }) + "\n",
  );
  const prefix = lines.slice(0, 123).join("");
  writeFileSync(
    path,
    prefix +
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }) +
      "\n" +
      lines.slice(123).join(""),
  );
  expect(() => recoverContext(r)).toThrow();
  expect(
    (store.db.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
  ).toBe(123);
  expect((store.db.query("SELECT offset FROM cursors WHERE path=?").get(path) as any).offset).toBe(
    Buffer.byteLength(prefix),
  );
  writeFileSync(path, lines.join(""));
  recoverContext(r);
  recoverContext(r);
  expect(
    (store.db.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
  ).toBe(240);
  expect((store.db.query("PRAGMA synchronous").get() as any).synchronous).toBe(2);
});

test("Git revisits a late commit and excludes the old identical revision", () => {
  const { root, store, r } = fixture();
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "core.hooksPath", "/dev/null");
  const path = join(root, "file.txt");
  const commit = (text: string, message: string) => {
    writeFileSync(path, text);
    git(root, "add", "file.txt");
    git(root, "commit", "-m", message);
    return git(root, "rev-parse", "HEAD");
  };
  const old = commit("after\n", "old");
  commit("before\n", "baseline");
  r.record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "turn", cwd: root, prompt: "edit" },
  });
  const e = {
    session_id: "s",
    turn_id: "turn",
    cwd: root,
    tool_use_id: "call",
    tool_name: "Edit",
    tool_input: { file_path: path, old_string: "before", new_string: "after" },
  };
  r.record({ stage: "PreToolUse", event: e });
  writeFileSync(path, "after\n");
  r.record({ stage: "PostToolUse", event: e });
  reconcileGit(r);
  git(root, "add", "file.txt");
  git(root, "commit", "-m", "later");
  const sha = git(root, "rev-parse", "HEAD");
  for (let i = 0; i < 2; i++) {
    store.db.query("DELETE FROM meta WHERE key='git-last-pass'").run();
    reconcileGit(r);
  }
  expect(
    (store.db.query("SELECT count(*) AS n FROM events WHERE kind='commit'").get() as any).n,
    JSON.stringify({
      changes: store.db.query("SELECT * FROM file_changes").all(),
      meta: store.db.query("SELECT * FROM meta WHERE key LIKE 'git-%'").all(),
      diagnostics: store.db.query("SELECT * FROM diagnostics").all(),
    }),
  ).toBe(1);
  expect(latest(store, "commit").commit.id).toBe(sha);
  expect(sha).not.toBe(old);
});

for (const source of ["claude-code", "codex"]) {
  test(`${source} retains commit attribution after successive native edits`, () => {
    const { store, r, edit, commit } = gitFixture(source);
    saveSourceVersion(r, "s", "native-test-version");
    edit("before", "middle");
    edit("middle", "after");
    const sha = commit(),
      work = latest(store, "file").workId;
    expect(store.db.query("SELECT quality FROM file_changes").all()).toEqual([
      { quality: "tool_observed" },
      { quality: "tool_observed" },
    ]);
    const collector = new Recorder(store, "collector", r.device);
    for (let i = 0; i < 2; i++) {
      store.db.query("DELETE FROM meta WHERE key IN ('git-last-pass','git-pass-after')").run();
      // This local-only fixture tests commit replay without a provider lookup.
      store.db
        .query(
          "UPDATE meta SET value=json_set(value,'$.CheckedAt',?) WHERE key LIKE 'tracked-commit:%'",
        )
        .run(new Date().toISOString());
      reconcileGit(collector);
      expect(store.db.query("SELECT id FROM events WHERE kind='commit'").all()).toHaveLength(1);
      expect(store.db.query("SELECT id FROM events WHERE kind='link'").all()).toHaveLength(1);
      expect(latest(store, "commit")).toMatchObject({
        source,
        sourceVersion: "native-test-version",
        workId: work,
        commit: { id: sha },
      });
      expect(latest(store, "link")).toMatchObject({
        source,
        sourceVersion: "native-test-version",
        workId: work,
        link: {
          fromKind: "work",
          fromId: work,
          toKind: "commit",
          toId: sha,
          reason: "file_revision",
        },
      });
    }
  });
}

test("a person's commit of native edits is matched in a repository with more than 512 refs", () => {
  const { root, store, r, edit, commit } = gitFixture("claude-code");
  // Company repositories have hundreds to thousands of branches and tags (getkimchi/kimchi about 1,000).
  const head = git(root, "rev-parse", "HEAD");
  execFileSync("git", ["-C", root, "update-ref", "--stdin"], {
    input: Array.from({ length: 600 }, (_, i) => `create refs/tags/t${i} ${head}\n`).join(""),
  });
  edit("before", "after");
  const sha = commit();
  reconcileGit(r);
  expect(latest(store, "link").link).toMatchObject({
    toKind: "commit",
    toId: sha,
    reason: "file_revision",
  });
});

test("Git composes native edits across turns and intervening reads", () => {
  const { root, path, store, r, edit, commit } = gitFixture("claude-code");
  edit("before", "middle");
  const read = {
    session_id: "s",
    turn_id: "turn",
    cwd: root,
    tool_use_id: "read",
    tool_name: "Read",
    tool_input: { file_path: path },
  };
  r.record({ stage: "PreToolUse", event: read });
  r.record({ stage: "PostToolUse", event: read });
  r.record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "next-turn", cwd: root, prompt: "continue" },
  });
  edit("middle", "after", { turn: "next-turn" });
  const sha = commit();
  reconcileGit(r);
  expect(latest(store, "commit").commit.id).toBe(sha);
});

for (const boundary of [
  "work",
  "session",
  "source",
  "agent",
  "unobserved edit",
  "unverified edit",
]) {
  test(`Git leaves ${boundary} boundaries unlinked`, () => {
    const { root, path, store, r, edit, commit } = gitFixture("claude-code");
    edit("before", "middle");
    let session = "s",
      turn = "turn",
      agent = "",
      recorder = r,
      before = "middle";
    if (boundary === "work") {
      turn = "other-work-turn";
      r.record({
        stage: "UserPromptSubmit",
        event: { session_id: session, turn_id: turn, cwd: root, prompt: "New work: another task" },
      });
    }
    if (boundary === "session") session = "other-session";
    if (boundary === "source") recorder = new Recorder(store, "codex", r.device);
    if (boundary === "agent") {
      agent = "child";
      r.record({
        stage: "SubagentStart",
        event: { session_id: session, turn_id: turn, cwd: root, agent_id: agent },
      });
    }
    if (boundary === "unobserved edit" || boundary === "unverified edit") {
      before = "external";
      if (boundary === "unobserved edit") writeFileSync(path, before + "\n");
      else edit("middle", "expected", { actual: before });
    }
    edit(before, "after", { session, turn, agent, recorder });
    if (boundary === "work" || boundary === "agent")
      expect(
        new Set(
          store.db
            .query("SELECT work_id FROM file_changes")
            .all()
            .map((row: any) => row.work_id),
        ).size,
      ).toBe(boundary === "work" ? 2 : 1);
    commit();
    reconcileGit(r);
    expect(store.db.query("SELECT id FROM events WHERE kind IN ('commit','link')").all()).toEqual(
      [],
    );
  });
}

test("Git does not attribute an unchanged file after native edits revert it", () => {
  const { root, store, r, edit, commit } = gitFixture("codex");
  edit("before", "middle");
  edit("middle", "before");
  writeFileSync(join(root, "unrelated.txt"), "human change\n");
  commit();
  reconcileGit(r);
  expect(store.db.query("SELECT id FROM events WHERE kind IN ('commit','link')").all()).toEqual([]);
});

test("Git excludes a composed revision already reachable before an earlier edit", () => {
  const { root, path, store, r, edit, commit } = gitFixture("claude-code");
  const baseline = git(root, "rev-parse", "HEAD");
  writeFileSync(path, "after\n");
  const old = commit();
  git(root, "branch", "old-result", old);
  git(root, "reset", "--hard", baseline);
  edit("before", "middle");
  git(root, "branch", "-D", "old-result");
  edit("middle", "after");
  git(root, "branch", "old-result", old);
  reconcileGit(r);
  expect(store.db.query("SELECT id FROM events WHERE kind IN ('commit','link')").all()).toEqual([]);
});

test("collector Git reconciliation preserves the originating source, version and event identities", () => {
  const { root, store, r, scope } = fixture();
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "core.hooksPath", "/dev/null");
  const path = join(root, "file.txt");
  writeFileSync(path, "before\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-m", "baseline");
  saveSourceVersion(r, scope.Session, "native-test-version");
  const collector = new Recorder(store, "collector", r.device);
  saveSourceVersion(collector, scope.Session, "collector-test-version");
  expect(r.event(scope, "native-default", "")).toMatchObject({
    source: r.source,
    sourceVersion: "native-test-version",
    entityId: stableId(r.source, scope.Session, "native-default"),
  });
  r.record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "turn", cwd: root, prompt: "edit" },
  });
  const event = {
    session_id: "s",
    turn_id: "turn",
    cwd: root,
    tool_use_id: "call",
    tool_name: "Edit",
    tool_input: { file_path: path, old_string: "before", new_string: "after" },
  };
  r.record({ stage: "PreToolUse", event });
  writeFileSync(path, "after\n");
  r.record({ stage: "PostToolUse", event });
  git(root, "add", "file.txt");
  git(root, "commit", "-m", "implementation");
  const sha = git(root, "rev-parse", "HEAD"),
    work = r.work(scope);
  expect(work).not.toBe("");
  reconcileGit(collector);
  for (const [kind, entity] of [
    ["commit", `commit:${sha}`],
    ["link", `work-commit:${work}:${sha}`],
  ]) {
    expect(latest(store, kind!)).toMatchObject({
      source: r.source,
      sourceVersion: "native-test-version",
      entityId: stableId(r.source, scope.Session, entity!),
      workId: work,
    });
  }
});

test("PR refresh revises lifecycle while retaining one exact commit membership link", () => {
  const { root, store, r, scope } = fixture();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/sh\ncase "$*" in\n *repos/fork/repo/commits/*) /bin/cat "$SCM_FIXTURE_ROOT/pulls.json" ;;\n *repos/fork/repo) /bin/cat "$SCM_FIXTURE_ROOT/repo.json" ;;\n *) exit 1 ;;\nesac\n',
    { mode: 0o700 },
  );
  const priorPath = process.env.PATH,
    priorFixture = process.env.SCM_FIXTURE_ROOT;
  process.env.PATH = `${bin}:${priorPath}`;
  process.env.SCM_FIXTURE_ROOT = root;
  cleanups.push(() => {
    process.env.PATH = priorPath;
    if (priorFixture === undefined) delete process.env.SCM_FIXTURE_ROOT;
    else process.env.SCM_FIXTURE_ROOT = priorFixture;
  });
  writeFileSync(
    join(root, "repo.json"),
    JSON.stringify({ id: 55, full_name: "fork/repo", html_url: "https://github.com/fork/repo" }),
  );
  scope.Repository = {
    provider: "github",
    host: "github.com",
    id: "name:provisional",
    name: "fork/repo",
  };
  const sha = "a".repeat(40),
    key = `tracked-commit:${stableId(scope.Repo, sha)}`;
  const tracked = { Scope: scope, Source: "codex", SHA: sha, CreatedAt: new Date().toISOString() };
  saveSourceVersion(r, scope.Session, "native-test-version");
  const collector = new Recorder(store, "collector", r.device);
  saveSourceVersion(collector, scope.Session, "collector-test-version");
  const raw = {
    id: 42,
    number: 7,
    html_url: "https://github.com/target/repo/pull/7",
    state: "open",
    title: "WID-12: feature",
    base: { repo: { id: 99, full_name: "target/repo" } },
  };
  for (const merged of [false, true]) {
    writeFileSync(
      join(root, "pulls.json"),
      JSON.stringify([{ ...raw, ...(merged ? { state: "closed", merged_at: at } : {}) }]),
    );
    saveMeta(r, key, tracked);
    store.db.query("DELETE FROM meta WHERE key IN ('git-last-pass','git-pass-after')").run();
    reconcileGit(collector);
  }
  expect(latest(store, "pull_request").revision).toBe("2");
  expect(latest(store, "pull_request").repository.id).toBe("99");
  for (const [kind, entity] of [
    ["pull_request", "pull-request:99:42"],
    ["link", `commit-pr:${sha}:99:42`],
  ]) {
    expect(latest(store, kind!)).toMatchObject({
      source: r.source,
      sourceVersion: "native-test-version",
      entityId: stableId(r.source, scope.Session, entity!),
    });
  }
  expect(
    (store.db.query("SELECT count(*) AS n FROM events WHERE kind='link'").get() as any).n,
  ).toBe(1);
});

// Claude Desktop runs a session in a worktree under <repo>/.claude/worktrees and removes it when the session is
// archived, often before the session's PR is opened.
test("a commit still finds its PR after its session's worktree is removed", () => {
  const { base, root, store, r, scope } = fixture();
  writeFileSync(
    join(root, "gh"),
    '#!/bin/sh\ncase "$*" in\n *commits/*) /bin/cat "$SCM_FIXTURE_ROOT/pulls.json" ;;\n *) /bin/cat "$SCM_FIXTURE_ROOT/repo.json" ;;\nesac\n',
    { mode: 0o700 },
  );
  const priorPath = process.env.PATH,
    priorFixture = process.env.SCM_FIXTURE_ROOT;
  process.env.PATH = `${root}:${priorPath}`;
  process.env.SCM_FIXTURE_ROOT = root;
  cleanups.push(() => {
    process.env.PATH = priorPath;
    if (priorFixture === undefined) delete process.env.SCM_FIXTURE_ROOT;
    else process.env.SCM_FIXTURE_ROOT = priorFixture;
  });
  const repo = {
    id: 55,
    full_name: "testOrg/widgets",
    html_url: "https://github.com/testOrg/widgets",
  };
  writeFileSync(join(root, "repo.json"), JSON.stringify(repo));
  writeFileSync(
    join(root, "pulls.json"),
    JSON.stringify([
      {
        id: 42,
        number: 7,
        html_url: "https://github.com/testOrg/widgets/pull/7",
        state: "open",
        title: "Widgets",
        base: { repo },
      },
    ]),
  );
  const worktree = join(base, "removed-worktree"),
    sha = "a".repeat(40);
  saveMeta(r, `tracked-commit:${stableId(scope.Repo, sha)}`, {
    Scope: {
      ...scope,
      CWD: worktree,
      Root: worktree,
      Repository: { provider: "github", host: "github.com", id: "name:x", name: "testOrg/widgets" },
    },
    Source: "claude-code",
    SHA: sha,
    CreatedAt: new Date().toISOString(),
  });
  reconcileGit(new Recorder(store, "collector", r.device));
  expect(latest(store, "pull_request").pullRequest).toMatchObject({ number: 7, state: "open" });
  expect(latest(store, "link").link).toMatchObject({
    fromId: sha,
    reason: "provider_commit_membership",
  });
});

test("native edits in a removed worktree still match the commit made from them", () => {
  const { base, store, r } = fixture("claude-code");
  const main = join(base, "repo"),
    worktree = join(main, ".claude", "worktrees", "w"),
    path = join(worktree, "file.txt");
  mkdirSync(main);
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"],
    ["config", "commit.gpgsign", "false"],
    ["config", "core.hooksPath", "/dev/null"],
  ])
    git(main, ...args);
  writeFileSync(join(main, "file.txt"), "before\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "baseline");
  git(main, "worktree", "add", "-b", "w", worktree);
  r.record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "turn", cwd: worktree, prompt: "edit" },
  });
  const e = {
    session_id: "s",
    turn_id: "turn",
    cwd: worktree,
    tool_use_id: "call",
    tool_name: "Edit",
    tool_input: { file_path: path, old_string: "before", new_string: "after" },
  };
  r.record({ stage: "PreToolUse", event: e });
  writeFileSync(path, "after\n");
  r.record({ stage: "PostToolUse", event: e });
  // A person commits the edit and the session is archived before the next pass.
  git(worktree, "commit", "-am", "edit");
  const sha = git(worktree, "rev-parse", "HEAD");
  git(main, "worktree", "remove", worktree);
  reconcileGit(r);
  expect(latest(store, "link").link).toMatchObject({
    toKind: "commit",
    toId: sha,
    reason: "file_revision",
  });
});

test("route matching respects DNS boundaries", () => {
  const before = process.env.ANTHROPIC_BASE_URL;
  try {
    for (const [url, want] of [
      ["https://llm.cast.ai", "castai"],
      ["https://evilcast.ai", "customer-gateway"],
      ["https://api.anthropic.com", "provider-api"],
    ]) {
      process.env.ANTHROPIC_BASE_URL = url;
      expect(route("claude-code")).toBe(want!);
    }
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = before;
  }
});

test("an HTTPS remote keeps its port; an SSH remote's port is not the web host's", () => {
  const { root } = fixture();
  git(root, "init", "--initial-branch=main");
  const host = (remote: string) => {
    git(root, "remote", "remove", "origin").toString();
    git(root, "remote", "add", "origin", remote);
    return repository(root)[2]?.host;
  };
  git(root, "remote", "add", "origin", "https://example.invalid/x.git");
  expect(host("https://ghe.example.com:8443/team/repo.git")).toBe("ghe.example.com:8443");
  expect(host("https://ghe.example.com:443/team/repo.git")).toBe("ghe.example.com");
  expect(host("ssh://git@ghe.example.com:2222/team/repo.git")).toBe("ghe.example.com");
  expect(host("git@github.com:team/repo.git")).toBe("github.com");
});

test("an SSH host alias names its provider through ssh's own config, as Kimchi resolves it", () => {
  const { base, root } = fixture();
  git(root, "init", "--initial-branch=main");
  // ~/.ssh/config: Host github-work, HostName github.com. The fake answers `ssh -G` as OpenSSH prints it.
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ssh"),
    '#!/bin/sh\n[ "$*" = "-G github-work" ] && printf "user git\\nhostname github.com\\nport 22\\n"\n',
    { mode: 0o700 },
  );
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior}`;
  cleanups.push(() => {
    process.env.PATH = prior;
  });
  git(root, "remote", "add", "origin", "git@github-work:testOrg/widgets.git");
  expect(repository(root)[2]).toMatchObject({
    provider: "github",
    host: "github.com",
    name: "testOrg/widgets",
  });
});

function withBridgeHome<T>(base: string, run: () => T): T {
  const previous = process.env.KIMCHI_BRIDGE_HOME;
  process.env.KIMCHI_BRIDGE_HOME = join(base, "bridge");
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.KIMCHI_BRIDGE_HOME;
    else process.env.KIMCHI_BRIDGE_HOME = previous;
  }
}
function usages(store: Store) {
  return (
    store.db.query("SELECT body FROM events WHERE kind='usage' ORDER BY rowid").all() as any[]
  ).map((row) => JSON.parse(Buffer.from(row.body).toString()));
}
const tag = "11111111-2222-4333-8444-555555555555";

test("a Claude call the proxy tagged uploads its billing tag as requestId on the gateway route", () => {
  const { base, root, store, r, scope } = fixture("claude-code");
  withBridgeHome(base, () => {
    recordTag("msg_tagged", tag);
    const path = join(root, "claude.jsonl");
    registerTranscript(r, scope, path, "customer-gateway", "unknown");
    const message = (id: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: at,
        message: {
          id,
          model: "model",
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
    writeFileSync(path, message("msg_tagged") + "\n" + message("msg_plain") + "\n");
    recoverContext(r);
    const [tagged, plain] = usages(store);
    expect(tagged.usage).toMatchObject({
      responseId: "msg_tagged",
      requestId: tag,
      observedRoute: "castai",
    });
    expect(plain.usage.requestId).toBeUndefined();
    expect(plain.usage.observedRoute).toBe("customer-gateway");
    // Reading the same response again after its tag is gone keeps one entity and keeps its tag.
    rmSync(join(base, "bridge", "gateway-request-tags.sqlite"), { force: true });
    appendFileSync(path, message("msg_tagged") + "\n");
    recoverContext(r);
    const again = usages(store).filter((event) => event.usage.responseId === "msg_tagged");
    expect(new Set(again.map((event) => event.entityId)).size).toBe(1);
    expect(again.at(-1).usage.requestId).toBe(tag);
  });
});

test("a Codex token_count takes its response ID only from the record with the same usage", () => {
  const { base, root, store, r, scope } = fixture();
  withBridgeHome(base, () => {
    recordTag("resp_tagged", tag);
    const path = join(root, "rollout.jsonl");
    registerTranscript(r, scope, path, "unknown", "unknown");
    const usage = {
      input_tokens: 4281,
      cached_input_tokens: 1792,
      output_tokens: 27,
      reasoning_output_tokens: 24,
      total_tokens: 4308,
    };
    const record = (response: string, counts: object) =>
      JSON.stringify({
        timestamp: at,
        type: "token_usage_record",
        payload: { turn_id: "turn", response_id: response, usage: counts },
      });
    const count = (last: object, total: object) =>
      JSON.stringify({
        timestamp: at,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: last, total_token_usage: total },
        },
      });
    writeFileSync(
      path,
      [
        JSON.stringify({
          timestamp: at,
          type: "turn_context",
          payload: { turn_id: "turn", model: "m" },
        }),
        record("resp_tagged", usage),
        count(usage, { ...usage }),
        // A record whose counts differ from the next event never lends that event its response ID.
        record("resp_other", { ...usage, output_tokens: 25, total_tokens: 4306 }),
        count(
          { ...usage, output_tokens: 30, total_tokens: 4311 },
          { ...usage, output_tokens: 57, total_tokens: 8619 },
        ),
      ].join("\n") + "\n",
    );
    recoverContext(r);
    const [tagged, unmatched] = usages(store);
    expect(tagged.usage).toMatchObject({
      responseId: "resp_tagged",
      requestId: tag,
      observedRoute: "castai",
    });
    expect(unmatched.usage.responseId).toBeUndefined();
    expect(unmatched.usage.requestId).toBeUndefined();
    expect(unmatched.usage.observedRoute).toBe("unknown");
  });
});

test("a Codex response ID too long for an event still names its billing tag", () => {
  const { base, root, store, r, scope } = fixture();
  withBridgeHome(base, () => {
    // Kimchi's gateway encodes LiteLLM's route into response IDs, as it did for glm-5.3-flash.
    const route = `litellm:custom_llm_provider:hosted_vllm;model_id:None;response_id:${"0".repeat(32)}`;
    const response = `resp_${Buffer.from(route).toString("base64")}`;
    expect(response.length).toBe(137);
    recordTag(response, tag);
    const path = join(root, "rollout.jsonl");
    registerTranscript(r, scope, path, "unknown", "unknown");
    const usage = {
      input_tokens: 13062,
      cached_input_tokens: 0,
      output_tokens: 11,
      reasoning_output_tokens: 9,
      total_tokens: 13073,
    };
    writeFileSync(
      path,
      [
        { type: "turn_context", payload: { turn_id: "turn", model: "m" } },
        { type: "token_usage_record", payload: { response_id: response, usage } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: usage, total_token_usage: usage },
          },
        },
      ]
        .map((line) => JSON.stringify({ timestamp: at, ...line }))
        .join("\n") + "\n",
    );
    recoverContext(r);
    const [call] = usages(store);
    expect(call.usage).toMatchObject({ requestId: tag, observedRoute: "castai" });
    expect(call.usage.responseId).toBeUndefined();
  });
});
