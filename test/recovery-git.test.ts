import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder, repository, type Scope } from "../src/capture.ts";
import { Open } from "../src/ledger.ts";
import { Parse, StableID } from "../src/protocol.ts";
import {
  claudeUsage,
  openAIUsage,
  RecoverContext,
  registerTranscript,
  telemetry,
  route,
} from "../src/recovery.ts";
import {
  issueKeys,
  git,
  providerID,
  pullRequest,
  ReconcileGit,
  saveMeta,
  scmEnvironment,
} from "../src/git.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
function fixture(source = "codex") {
  const base = mkdtempSync(join(tmpdir(), "pr-cost-recovery-"));
  const root = join(base, "project");
  mkdirSync(root);
  const store = Open(join(base, "state"));
  const r = new Recorder(store, source, store.DeviceID());
  cleanups.push(() => {
    store.Close();
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
function latest(store: ReturnType<typeof Open>, kind: string) {
  return JSON.parse(
    Buffer.from(
      (
        store.DB.query("SELECT body FROM events WHERE kind=? ORDER BY rowid DESC LIMIT 1").get(
          kind,
        ) as any
      ).body,
    ).toString(),
  );
}
const at = "2026-10-23T12:00:00.123456789Z";

test("Codex recovery preserves absent usage, lossless counter identity, duplicate and partial-line replay", () => {
  const { root, store, r, scope } = fixture();
  r.Record({
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
  RecoverContext(r);
  const event = latest(store, "usage");
  expect(event.usage.raw).toEqual({ inputTokens: "100", outputTokens: "3", cacheReadTokens: "10" });
  expect(event.usage.reportedModel).toBe("observed-model");
  expect(event.observeTime).toBe(at);
  expect(event.workId).toBeTruthy();
  appendFileSync(path, "\n");
  RecoverContext(r);
  RecoverContext(r);
  expect(
    (store.DB.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
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
  RecoverContext(r);
  expect(
    (store.DB.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
  ).toBe(2);
});

test("Claude telemetry and transcript revise one request and attach its exact tool identity", () => {
  const { root, store, r, scope } = fixture("claude-code");
  r.Record({
    stage: "UserPromptSubmit",
    event: { session_id: "s", turn_id: "turn", cwd: root, prompt: "implement" },
  });
  const [canonical, repo, ref] = repository(root);
  Object.assign(scope, { Root: canonical, Repo: repo, Repository: ref });
  store.DB.query("INSERT INTO meta(key,value) VALUES(?,?)").run("prompt-turn:s:prompt", "turn");
  const request = "00000000-0000-0000-0000-000000000001";
  const e = Parse(
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
  RecoverContext(r);
  telemetry(r, scope, e, "castai", "unknown");
  RecoverContext(r);
  expect(
    store.DB.query(
      "SELECT count(DISTINCT entity_id) AS entities,count(*) AS revisions FROM events WHERE kind='usage'",
    ).get(),
  ).toEqual({ entities: 1, revisions: 2 });
  const event = latest(store, "usage");
  expect(event.usage.channel).toBe("transcript");
  expect(event.usage.raw.cacheWrites).toEqual([
    { ttlSeconds: 300, tokens: "3" },
    { ttlSeconds: 3600, tokens: "4" },
  ]);
  expect(event.usage.aliases).toHaveLength(1);
  expect(event.workId).toBeTruthy();
  appendFileSync(
    path,
    JSON.stringify({ type: "assistant", message: { id: "bad", usage: { input_tokens: 1 } } }) +
      "\n",
  );
  expect(() => RecoverContext(r)).toThrow("transcript recovery incomplete");
});

test("SCM IDs remain exact, target repository owns fork PRs and credentials stay host-bound", () => {
  const source = { provider: "github", host: "github.com", name: "fork/repo", id: "name:fixture" };
  const raw = Parse(
    '{"id":9007199254740993,"number":7,"html_url":"https://github.com/target/repo/pull/7","state":"open","title":"WID-12: feature","base":{"repo":{"id":9007199254740995,"full_name":"target/repo"}}}',
  );
  const [repo, pr] = pullRequest(source, raw);
  expect(repo.id).toBe("9007199254740995");
  expect(pr.id).toBe("9007199254740993");
  expect(pr.issueKeys).toEqual([{ key: "WID-12", source: "title" }]);
  expect(providerID(Parse("9223372036854775808"))).toBe("");
  expect(providerID(Parse("1e3"))).toBe("");
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

test("native int64 usage readers preserve decimal identity before bounded event validation", () => {
  const raw = Parse(
    '{"input_tokens":9007199254740993,"output_tokens":1e3,"cache_read_input_tokens":-0}',
  );
  expect(openAIUsage(raw).inputTokens).toBe("9007199254740993");
  expect(claudeUsage(raw).inputTokens).toBe("9007199254740993");
  expect(claudeUsage(raw).cacheReadTokens).toBe("0");
  expect(claudeUsage(raw).outputTokens).toBeUndefined();
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
  expect(() => RecoverContext(r)).toThrow();
  expect(
    (store.DB.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
  ).toBe(123);
  expect((store.DB.query("SELECT offset FROM cursors WHERE path=?").get(path) as any).offset).toBe(
    Buffer.byteLength(prefix),
  );
  writeFileSync(path, lines.join(""));
  RecoverContext(r);
  RecoverContext(r);
  expect(
    (store.DB.query("SELECT count(*) AS n FROM events WHERE kind='usage'").get() as any).n,
  ).toBe(240);
  expect((store.DB.query("PRAGMA synchronous").get() as any).synchronous).toBe(2);
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
  r.Record({
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
  r.Record({ stage: "PreToolUse", event: e });
  writeFileSync(path, "after\n");
  r.Record({ stage: "PostToolUse", event: e });
  ReconcileGit(r);
  git(root, "add", "file.txt");
  git(root, "commit", "-m", "later");
  const sha = git(root, "rev-parse", "HEAD");
  for (let i = 0; i < 2; i++) {
    store.DB.query("DELETE FROM meta WHERE key='git-last-pass'").run();
    ReconcileGit(r);
  }
  expect(
    (store.DB.query("SELECT count(*) AS n FROM events WHERE kind='commit'").get() as any).n,
    JSON.stringify({
      changes: store.DB.query("SELECT * FROM file_changes").all(),
      meta: store.DB.query("SELECT * FROM meta WHERE key LIKE 'git-%'").all(),
      diagnostics: store.DB.query("SELECT * FROM diagnostics").all(),
    }),
  ).toBe(1);
  expect(latest(store, "commit").commit.id).toBe(sha);
  expect(sha).not.toBe(old);
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
  r.version(scope.Session, "native-test-version");
  const collector = new Recorder(store, "collector", r.Device);
  collector.version(scope.Session, "collector-test-version");
  expect(r.event(scope, "native-default", "")).toMatchObject({
    source: r.Source,
    sourceVersion: "native-test-version",
    entityId: StableID(r.Source, scope.Session, "native-default"),
  });
  r.Record({
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
  r.Record({ stage: "PreToolUse", event });
  writeFileSync(path, "after\n");
  r.Record({ stage: "PostToolUse", event });
  git(root, "add", "file.txt");
  git(root, "commit", "-m", "implementation");
  const sha = git(root, "rev-parse", "HEAD"),
    work = r.work(scope);
  expect(work).not.toBe("");
  ReconcileGit(collector);
  for (const [kind, entity] of [
    ["commit", `commit:${sha}`],
    ["link", `work-commit:${work}:${sha}`],
  ]) {
    expect(latest(store, kind!)).toMatchObject({
      source: r.Source,
      sourceVersion: "native-test-version",
      entityId: StableID(r.Source, scope.Session, entity!),
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
    key = `tracked-commit:${StableID(scope.Repo, sha)}`;
  const tracked = { Scope: scope, Source: "codex", SHA: sha, CreatedAt: new Date().toISOString() };
  r.version(scope.Session, "native-test-version");
  const collector = new Recorder(store, "collector", r.Device);
  collector.version(scope.Session, "collector-test-version");
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
    store.DB.query("DELETE FROM meta WHERE key IN ('git-last-pass','git-pass-after')").run();
    ReconcileGit(collector);
  }
  expect(latest(store, "pull_request").revision).toBe("2");
  expect(latest(store, "pull_request").repository.id).toBe("99");
  for (const [kind, entity] of [
    ["pull_request", "pull-request:99:42"],
    ["link", `commit-pr:${sha}:99:42`],
  ]) {
    expect(latest(store, kind!)).toMatchObject({
      source: r.Source,
      sourceVersion: "native-test-version",
      entityId: StableID(r.Source, scope.Session, entity!),
    });
  }
  expect(
    (store.DB.query("SELECT count(*) AS n FROM events WHERE kind='link'").get() as any).n,
  ).toBe(1);
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
