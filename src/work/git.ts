import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import {
  canonicalTime,
  gitId,
  integer,
  numberText,
  obj,
  parseJson,
  stableId,
  str,
  stringifyJson,
  zeroTime,
  type IssueKey,
  type JsonObject,
  type PullRequest,
  type Repository,
} from "./protocol.ts";
import { checkSignal, remainingTime, withDeadline, within } from "../platform.ts";
import type { Recorder, Scope } from "./capture.ts";

export function git(cwd: string, ...args: string[]): string {
  return gitContext(undefined, cwd, ...args);
}
function gitContext(signal: AbortSignal | undefined, cwd: string, ...args: string[]): string {
  checkSignal(signal);
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[key];
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
  });
  const out = execFileSync("git", ["-C", cwd, ...args], {
    env,
    timeout: remainingTime(signal, 2000),
    maxBuffer: 8 << 20,
    stdio: ["ignore", "pipe", "ignore"],
  });
  checkSignal(signal);
  let text = out.toString();
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  return text;
}

// Stored in ledger metadata like Scope; keep the field names.
interface GitChange {
  Scope: Scope;
  Source: string;
  Work: string;
  Path: string;
  Before: string;
  After: string;
  Refs: string[];
  CreatedAt: string;
}
interface TrackedCommit {
  Scope: Scope;
  Source: string;
  SHA: string;
  CheckedAt?: string;
  CreatedAt: string;
  Found?: boolean;
  Merged?: boolean;
  // API paths of the PRs or MRs last seen open, looked up by number when the commit no longer lists them.
  Open?: string[];
}
const fields = (s: string) =>
  s
    .split("\n")
    .flatMap((line) => line.split(" "))
    .filter(Boolean);
const seconds = () => Math.floor(Date.now() / 1000);
export const rootOf = (s: Scope) => s.Root || s.CWD;
export function saveMeta(r: Recorder, key: string, data: unknown) {
  r.store.setMeta(key, stringifyJson(data));
}
export function refTips(root: string): string[] | null {
  try {
    const refs = fields(git(root, "for-each-ref", "--format=%(objectname)", "--count=513"));
    if (refs.length > 512) return null;
    try {
      refs.push(git(root, "rev-parse", "--verify", "HEAD"));
    } catch {
      /* Empty repository. */
    }
    return [...new Set(refs)].sort();
  } catch {
    return null;
  }
}

export function reconcileGit(r: Recorder, signal?: AbortSignal) {
  signal = withDeadline(8000, signal);
  checkSignal(signal);
  seedOpen(r);
  // Kimchi looks up due commits at every agent end. Due lookups go first and skip the gate, which only
  // paces native-edit matching: Codex syncs only on hooks, and its Stop can follow the prompt's sync
  // by a few seconds.
  const fresh = r.store.db
    .query(
      `SELECT key,value FROM meta WHERE key LIKE 'tracked-commit:%'
         AND coalesce(json_extract(value,'$.Merged'),0)=0
         AND unixepoch()-unixepoch(coalesce(json_extract(value,'$.CheckedAt'),?)) >=
             min(86400,(unixepoch()-unixepoch(json_extract(value,'$.CreatedAt')))/16.0)
       ORDER BY coalesce(json_extract(value,'$.CheckedAt'),?) LIMIT 8`,
    )
    .all(zeroTime, zeroTime) as { key: string; value: string }[];
  if (!fresh.length && seconds() - Number(r.store.meta("git-last-pass")) < 60) return;
  r.store.setMeta("git-last-pass", String(seconds()));
  const items = r.store.db
    .query(
      "SELECT key,value FROM meta WHERE (key LIKE 'git-change:%' OR key LIKE 'tracked-commit:%') AND key>? ORDER BY key LIMIT 32",
    )
    .all(r.store.meta("git-pass-after")) as { key: string; value: string }[];
  if (!items.length) r.store.db.query("DELETE FROM meta WHERE key='git-pass-after'").run();
  const failures: unknown[] = [],
    seen = new Set<string>(),
    // Like Kimchi, a pass asks for a repository's identity or a PR by number once.
    answers = new Map<string, unknown>();
  for (const item of [...fresh, ...items]) {
    checkSignal(signal);
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    if (!fresh.includes(item)) r.store.setMeta("git-pass-after", item.key);
    if (item.key.startsWith("tracked-commit:")) {
      const c: TrackedCommit = JSON.parse(item.value);
      // Kimchi's schedule: check a new commit at once, then after min(1 day, age/16); give up on
      // one without a PR after 32 days, and stop once every PR it belongs to is merged.
      const age = Date.now() - Date.parse(c.CreatedAt);
      if (age > 90 * 86400_000 || (!c.Found && age > 32 * 86400_000)) {
        r.store.db.query("DELETE FROM meta WHERE key=?").run(item.key);
        continue;
      }
      // A merged commit keeps its key, so native-edit matching cannot track it again.
      if (
        c.Merged ||
        (c.CheckedAt && Date.now() - Date.parse(c.CheckedAt) < Math.min(86400_000, age / 16))
      )
        continue;
      c.CheckedAt = new Date().toISOString();
      saveMeta(r, item.key, c);
      try {
        const [states, open] = discoverPullRequests(r, c, answers, signal);
        if (states.length)
          saveMeta(r, item.key, {
            ...c,
            Found: true,
            Merged: states.every((state) => state === "merged") && !open.length,
            Open: open,
          });
      } catch (e) {
        r.store.diagnostic("scm_lookup_incomplete");
        failures.push(e);
      }
    } else {
      const c: GitChange = JSON.parse(item.value);
      if (Date.now() - Date.parse(c.CreatedAt) > 7 * 86400_000) {
        r.store.diagnostic("git_evidence_expired");
        r.store.db.query("DELETE FROM meta WHERE key=?").run(item.key);
        continue;
      }
      try {
        matchCommits(r, c, item.key.slice("git-change:".length), signal);
      } catch (e) {
        r.store.diagnostic("git_match_incomplete");
        failures.push(e);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "git reconciliation incomplete");
}

function fileObject(r: Recorder, hash: string, format: string): string {
  if (!hash) return "";
  if (!["sha1", "sha256"].includes(format)) throw new Error("unsupported git object format");
  const bytes = r.store.blob(hash);
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
function treeObject(
  signal: AbortSignal | undefined,
  root: string,
  commit: string,
  path: string,
): string {
  const out = gitContext(signal, root, "ls-tree", "-z", commit, "--", path);
  if (!out) return "";
  const parts = fields(out.split("\t", 1)[0]!);
  if (parts.length !== 3 || parts[1] !== "blob" || !gitId(parts[2]!))
    throw new Error("not an ordinary file blob");
  return parts[2]!;
}
function matchCommits(r: Recorder, c: GitChange, change: string, signal?: AbortSignal) {
  const root = rootOf(c.Scope),
    format = gitContext(signal, root, "rev-parse", "--show-object-format");
  const before = fileObject(r, c.Before, format),
    after = fileObject(r, c.After, format);
  if (!within(root, c.Path)) throw new Error("file is outside its captured repository");
  const path = relative(root, c.Path);
  let commits = fields(
    gitContext(signal, root, "rev-list", "--all", "--max-count=129", "--not", ...(c.Refs || [])),
  );
  if (commits.length > 128) {
    r.store.diagnostic("git_history_bound");
    commits = commits.slice(0, 128);
  }
  if (!commits.length) return;
  const befores = new Set([before]),
    refs = new Set(c.Refs || []);
  // shortcut: inspect 128 prior file observations; raise the bound if longer chains must match.
  const previous = r.store.db
    .query(
      `SELECT f.before_hash,f.after_hash,m.value FROM file_changes f
       LEFT JOIN meta m ON m.key='git-change:'||f.id
       WHERE f.repository=? AND f.path=? AND f.rowid<(SELECT rowid FROM file_changes WHERE id=?)
       ORDER BY f.rowid DESC LIMIT 128`,
    )
    .all(c.Scope.Repo, c.Path, change) as {
    before_hash: string;
    after_hash: string;
    value: string | null;
  }[];
  let hash = c.Before;
  // Compose only consecutive verified edits by the same work and native writer.
  for (const row of previous) {
    checkSignal(signal);
    if (row.before_hash === row.after_hash) continue;
    if (!row.value) break;
    const p: GitChange = JSON.parse(row.value);
    if (
      p.After !== hash ||
      p.Work !== c.Work ||
      p.Source !== c.Source ||
      p.Scope.Session !== c.Scope.Session ||
      p.Scope.Agent !== c.Scope.Agent ||
      p.Scope.Repo !== c.Scope.Repo ||
      rootOf(p.Scope) !== root ||
      p.Path !== c.Path ||
      Date.now() - Date.parse(p.CreatedAt) > 7 * 86400_000
    )
      break;
    hash = p.Before;
    befores.add(fileObject(r, hash, format));
    for (const ref of p.Refs || []) refs.add(ref);
  }
  befores.delete(after);
  for (const sha of commits) {
    checkSignal(signal);
    if (!gitId(sha)) throw new Error("invalid commit identity");
    if (treeObject(signal, root, sha, path) !== after) continue;
    const parents = fields(gitContext(signal, root, "show", "--format=%P", "--no-patch", sha));
    let matched = parents.length === 0 && befores.has(""),
      direct = parents.length === 0 && before === "";
    for (const parent of parents) {
      const object = treeObject(signal, root, parent, path);
      if (befores.has(object)) matched = true;
      if (object === before) direct = true;
    }
    if (!matched) continue;
    if (
      !direct &&
      gitContext(signal, root, "rev-list", "--max-count=1", sha, "--not", ...refs) !== sha
    )
      continue;
    // A traced agent commit already has stronger evidence; recording it again would flip revisions.
    if (r.store.meta(`agent-commit:${stableId(c.Scope.Repo, sha)}`)) continue;
    recordCommit(r, c.Scope, c.Work, c.Source, sha, parents, "inferred", "file_revision");
  }
}

/** A commit, its work link and the provider lookup that finds its PRs or MRs. */
export function recordCommit(
  r: Recorder,
  scope: Scope,
  work: string,
  source: string,
  sha: string,
  parents: string[],
  quality: string,
  reason: string,
) {
  const event = r.event(scope, `commit:${sha}`, work, source);
  event.commit = { id: sha, parents, quality };
  r.store.observe(event);
  if (work) {
    const link = r.event(scope, `work-commit:${work}:${sha}`, work, source);
    link.link = { fromKind: "work", fromId: work, toKind: "commit", toId: sha, quality, reason };
    r.store.observe(link);
  }
  // A repository without a GitHub or GitLab identity has no PRs to find (Kimchi ends it quietly).
  const key = `tracked-commit:${stableId(scope.Repo, sha)}`;
  if (scope.Repository && !r.store.meta(key))
    saveMeta(r, key, {
      Scope: scope,
      Source: source,
      SHA: sha,
      CheckedAt: zeroTime,
      CreatedAt: new Date().toISOString(),
    });
}
export const commitParents = (root: string, sha: string) =>
  fields(git(root, "show", "--format=%P", "--no-patch", sha));

export function scmEnvironment(repo: Repository): NodeJS.ProcessEnv {
  const blocked = new Set([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GH_REPO",
    "GH_HOST",
    "GLAB_REPO",
    "GITLAB_HOST",
    "GL_HOST",
    "GITLAB_URI",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITLAB_TOKEN",
    "GLAB_TOKEN",
    "GITLAB_ACCESS_TOKEN",
    "OAUTH_TOKEN",
    "NO_PROMPT",
  ]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !blocked.has(k)));
  if (repo.provider === "github") {
    if (repo.host === "github.com")
      for (const key of ["GH_TOKEN", "GITHUB_TOKEN"])
        if (process.env[key]) {
          env.GH_TOKEN = process.env[key];
          break;
        }
    if (repo.host !== "github.com" && repo.host === process.env.GH_HOST)
      for (const key of ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
        if (process.env[key]) {
          env.GH_ENTERPRISE_TOKEN = process.env[key];
          break;
        }
  } else if (repo.host === (process.env.GITLAB_HOST || "gitlab.com")) {
    for (const key of ["GITLAB_TOKEN", "GLAB_TOKEN", "GITLAB_ACCESS_TOKEN"])
      if (process.env[key]) {
        env.GITLAB_TOKEN = process.env[key];
        break;
      }
  }
  return {
    ...env,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "false",
    GLAB_NO_PROMPT: "true",
    GLAB_SEND_TELEMETRY: "false",
    GLAB_ENABLE_CI_AUTOLOGIN: "false",
    GLAB_CHECK_UPDATE: "false",
    GLAB_SHOW_WHATS_NEW: "false",
  };
}
function scmApi(
  root: string,
  repo: Repository,
  path: string,
  signal?: AbortSignal,
  answers?: Map<string, unknown>,
): any {
  checkSignal(signal);
  const key = `${repo.provider} ${repo.host} ${path}`;
  if (answers?.has(key)) return answers.get(key);
  if (
    (repo.provider === "github" &&
      repo.host !== "github.com" &&
      repo.host !== process.env.GH_HOST) ||
    (repo.provider === "gitlab" &&
      repo.host !== "gitlab.com" &&
      repo.host !== process.env.GITLAB_HOST)
  )
    throw new Error("SCM host requires explicit configuration");
  const result = spawnSync(
    repo.provider === "github" ? "gh" : "glab",
    ["api", "--hostname", repo.host, "--method", "GET", path],
    {
      cwd: root,
      env: scmEnvironment(repo),
      timeout: remainingTime(signal, 5000),
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      signal,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) throw new Error("host-bound SCM lookup unavailable");
  let value;
  try {
    value = parseJson(result.stdout);
  } catch {
    throw new Error("invalid SCM response");
  }
  answers?.set(key, value);
  return value;
}
export function providerId(v: unknown): string {
  const n = numberText(v);
  if (!n) return "";
  try {
    const id = BigInt(n);
    return id > 0n && id < 1n << 63n && id.toString() === n ? n : "";
  } catch {
    return "";
  }
}
export function issueKeys(text: string, source: string): IssueKey[] {
  const word = (c: string) =>
    c === "_" || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
  const digit = (c: string) => c >= "0" && c <= "9";
  const parts = text.split("-"),
    seen = new Set<string>();
  let matches = 0;
  for (let i = 1; i < parts.length && matches < 20; i++) {
    const left = parts[i - 1]!,
      right = parts[i]!;
    const prefix = left.slice(left.split("").findLastIndex((c) => !word(c)) + 1);
    const end = Array.from(right).findIndex((c) => !digit(c));
    const number = end < 0 ? right : right.slice(0, end);
    if (
      !prefix ||
      prefix.length > 32 ||
      prefix[0]! < "A" ||
      prefix[0]! > "Z" ||
      !Array.from(prefix).every((c) => (c >= "A" && c <= "Z") || digit(c)) ||
      !number ||
      number.length > 20 ||
      (end >= 0 && word(right[end]!))
    )
      continue;
    matches++;
    seen.add(`${prefix}-${number}`);
  }
  return [...seen].map((key) => ({ key, source }));
}
function time(v: unknown): string | undefined {
  if (typeof v !== "string") return;
  try {
    return canonicalTime(v);
  } catch {
    return;
  }
}
export function metadataTitle(title: string): string {
  const chars = Array.from(title, (c) => {
    const n = c.codePointAt(0)!;
    return n <= 31 || (n >= 127 && n <= 159) ? " " : c;
  }).join("");
  const text = Array.from(new Intl.Segmenter("en", { granularity: "word" }).segment(chars), (s) =>
    s.segment.trim() ? s.segment : " ",
  )
    .join("")
    .split(" ")
    .filter(Boolean)
    .join(" ");
  let out = "",
    size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > 512) break;
    out += char;
  }
  return out;
}
export function pullRequest(source: Repository, v: JsonObject): [Repository, PullRequest] {
  const repo: Repository = { provider: source.provider, host: source.host, id: "" };
  const p: PullRequest = {
    id: providerId(v.id),
    title: str(v, "title"),
    createTime: time(v.created_at),
    closeTime: time(v.closed_at),
    mergeTime: time(v.merged_at),
    mergeCommitId: str(v, "merge_commit_sha"),
    number: 0,
    uri: "",
    state: "",
  };
  let number: number | undefined;
  if (source.provider === "github") {
    number = integer(v.number);
    const base = obj(obj(v.base).repo);
    repo.id = providerId(base.id);
    repo.name = str(base, "full_name");
    p.uri = str(v, "html_url");
    p.state = p.mergeTime ? "merged" : str(v, "state");
  } else if (source.provider === "gitlab") {
    number = integer(v.iid);
    repo.id = providerId(v.target_project_id);
    p.uri = str(v, "web_url");
    p.state = str(v, "state");
    if (["opened", "locked"].includes(p.state)) p.state = "open";
  }
  let url: URL;
  try {
    url = new URL(p.uri);
  } catch {
    throw new Error("invalid provider pull request");
  }
  if (
    url.protocol !== "https:" ||
    url.host !== source.host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    number === undefined ||
    number <= 0 ||
    number > 2147483647 ||
    !p.id ||
    !repo.id
  )
    throw new Error("invalid provider pull request");
  p.number = number;
  const suffix = source.provider === "gitlab" ? `/-/merge_requests/${number}` : `/pull/${number}`;
  if (!url.pathname.endsWith(suffix)) throw new Error("invalid provider pull request");
  const path = url.pathname.slice(1, -suffix.length);
  if (source.provider === "gitlab") repo.name = path;
  if (
    repo.name !== path ||
    path.split("/").length < 2 ||
    !["open", "closed", "merged"].includes(p.state) ||
    (p.state === "merged" && !p.mergeTime)
  )
    throw new Error("invalid provider pull request");
  // Kimchi writes GitHub paths in lowercase (work-attribution/costs.ts). The backend compares URLs exactly, so a PR
  // that both report with different case shows as conflicting and, once merged, loses its cost.
  if (source.provider === "github") {
    repo.name = path.toLowerCase();
    p.uri = `https://${source.host}/${repo.name}/pull/${number}`;
  }
  p.title = metadataTitle(p.title || "");
  p.issueKeys = issueKeys(p.title, "title");
  const branch = source.provider === "gitlab" ? str(v, "source_branch") : str(obj(v.head), "ref");
  for (const key of issueKeys(branch, "branch")) {
    if (p.issueKeys.length >= 20) break;
    if (!p.issueKeys.some((old) => old.key === key.key)) p.issueKeys.push(key);
  }
  return [repo, p];
}
/** Once: commits tracked before open PRs were kept get those their own links reached and the ledger last saw open. */
function seedOpen(r: Recorder) {
  if (r.store.meta("open-prs-seeded")) return;
  const links = new Map<string, { repo: string; pr: string }[]>();
  for (const l of r.store.db
    .query(
      `SELECT json_extract(CAST(body AS TEXT),'$.link.fromId') AS sha,json_extract(CAST(body AS TEXT),'$.sessionId') AS session,
              json_extract(CAST(body AS TEXT),'$.repository.id') AS repo,json_extract(CAST(body AS TEXT),'$.link.toId') AS pr
         FROM events WHERE kind='link' AND json_extract(CAST(body AS TEXT),'$.link.reason')='provider_commit_membership'`,
    )
    .all() as { sha: string; session: string; repo: string; pr: string }[]) {
    const key = `${l.sha} ${l.session}`;
    links.set(key, [...(links.get(key) ?? []), l]);
  }
  for (const item of r.store.db
    .query(
      "SELECT key,value FROM meta WHERE key LIKE 'tracked-commit:%' AND json_extract(value,'$.Open') IS NULL",
    )
    .all() as { key: string; value: string }[]) {
    const c: TrackedCommit = JSON.parse(item.value),
      open = new Set<string>();
    for (const { repo, pr } of links.get(`${c.SHA} ${c.Scope.Session}`) ?? []) {
      const e = r.store.latest(
        r.event(c.Scope, `pull-request:${repo}:${pr}`, "", c.Source).entityId,
      );
      if (e?.pullRequest?.state === "open" && e.repository)
        open.add(
          e.repository.provider === "gitlab"
            ? `projects/${e.repository.id}/merge_requests/${e.pullRequest.number}`
            : `repos/${e.repository.name}/pulls/${e.pullRequest.number}`,
        );
    }
    saveMeta(r, item.key, { ...c, Open: [...open] });
  }
  r.store.setMeta("open-prs-seeded", "1");
}
/** The states of the PRs or MRs that contain the commit, and the API paths of the open ones. */
function discoverPullRequests(
  r: Recorder,
  c: TrackedCommit,
  answers: Map<string, unknown>,
  signal?: AbortSignal,
): [string[], string[]] {
  const repo = c.Scope.Repository;
  if (!repo) throw new Error("SCM repository is unknown");
  const path =
    repo.provider === "gitlab"
      ? `projects/${encodeURIComponent(repo.name || "")}`
      : `repos/${repo.name}`;
  const identity = scmApi(c.Scope.CWD, repo, path, signal, answers),
    id = providerId(identity.id);
  if (!id) throw new Error("SCM repository identity is missing");
  const name = str(identity, repo.provider === "gitlab" ? "path_with_namespace" : "full_name");
  const urlText = str(identity, repo.provider === "gitlab" ? "web_url" : "html_url");
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("SCM repository identity did not match its host");
  }
  if (
    url.protocol !== "https:" ||
    url.host !== repo.host ||
    url.pathname !== `/${name}` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("SCM repository identity did not match its host");
  const endpoint =
    repo.provider === "gitlab"
      ? `projects/${id}/repository/commits/${c.SHA}/merge_requests`
      : `${path}/commits/${c.SHA}/pulls`;
  const states: string[] = [],
    listed = new Set<string>(),
    open = new Set<string>();
  const report = (raw: unknown) => {
    const [target, p] = pullRequest(repo, obj(raw)),
      s = { ...c.Scope, Repository: target },
      byNumber =
        repo.provider === "gitlab"
          ? `projects/${target.id}/merge_requests/${p.number}`
          : `repos/${target.name}/pulls/${p.number}`;
    states.push(p.state);
    listed.add(byNumber);
    if (p.state === "open") open.add(byNumber);
    // Every commit of a PR reports it; without their turns, an unchanged PR is not uploaded again.
    const event = r.event(
      { ...s, Turn: "", Agent: "" },
      `pull-request:${target.id}:${p.id}`,
      "",
      c.Source,
    );
    event.pullRequest = p;
    r.store.observe(event);
    const link = r.event(s, `commit-pr:${c.SHA}:${target.id}:${p.id}`, "", c.Source);
    link.link = {
      fromKind: "commit",
      fromId: c.SHA,
      toKind: "pull_request",
      toId: p.id,
      quality: "observed",
      reason: "provider_commit_membership",
    };
    r.store.observe(link);
  };
  for (let page = 1; page <= 5; page++) {
    const prs = scmApi(c.Scope.CWD, repo, `${endpoint}?per_page=100&page=${page}`, signal, answers);
    if (!Array.isArray(prs)) throw new Error("invalid SCM response");
    for (const raw of prs) report(raw);
    if (prs.length < 100) {
      // GitHub lists only open PRs for a commit outside the default branch, so, as Kimchi does, a PR the
      // commit no longer lists is looked up by number until it is seen closed or merged.
      for (const known of c.Open ?? [])
        if (!listed.has(known))
          try {
            report(scmApi(c.Scope.CWD, repo, known, signal, answers));
          } catch (e) {
            if (signal?.aborted) throw e;
            // Asked again on the commit's schedule; one PR that cannot be read must not hold up the others.
            r.store.diagnostic("scm_lookup_incomplete");
            open.add(known);
          }
      return [states, [...open]];
    }
  }
  throw new Error("SCM pagination exceeds capture bound");
}

export function pruneEvidence(r: Recorder, now: Date) {
  const cutoff = Math.floor(now.getTime() / 1000) - 7 * 86400;
  r.store.db
    .query("DELETE FROM tool_state WHERE unixepoch(json_extract(body,'$.started')) < ?")
    .run(cutoff);
  r.store.db.query("DELETE FROM file_changes WHERE created_at < ?").run(cutoff);
  r.store.db.query("DELETE FROM blobs WHERE observed_at < ?").run(cutoff);
  const dir = join(r.store.dir, "blobs");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e: any) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (lstatSync(path).mtimeMs < cutoff * 1000) unlinkSync(path);
  }
}
