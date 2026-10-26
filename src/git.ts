import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CanonicalTime,
  Integer,
  NumberText,
  Parse,
  StableID,
  Stringify,
  obj,
  str,
  type IssueKey,
  type PullRequest,
  type Repository,
} from "./protocol.ts";
import { CheckSignal, RemainingTime, WithDeadline, within } from "./platform.ts";
import type { Recorder, Scope } from "./capture.ts";

type Object = Record<string, any>;
export function git(cwd: string, ...args: string[]): string {
  return gitContext(undefined, cwd, ...args);
}
export function gitContext(
  signal: AbortSignal | undefined,
  cwd: string,
  ...args: string[]
): string {
  CheckSignal(signal);
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
    timeout: RemainingTime(signal, 2000),
    maxBuffer: 8 << 20,
    stdio: ["ignore", "pipe", "ignore"],
  });
  CheckSignal(signal);
  let text = out.toString();
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  return text;
}

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
}
const gitHash = (s: string) =>
  [40, 64].includes(s.length) && Buffer.from(s, "hex").toString("hex") === s;
const fields = (s: string) =>
  s
    .split("\n")
    .flatMap((line) => line.split(" "))
    .filter(Boolean);
const seconds = () => Math.floor(Date.now() / 1000);
const rootOf = (s: Scope) => s.Root || s.CWD;
export function saveMeta(r: Recorder, key: string, data: unknown) {
  r.Store.SetMeta(key, Stringify(data));
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

export function ReconcileGit(r: Recorder, signal?: AbortSignal) {
  signal = WithDeadline(8000, signal);
  CheckSignal(signal);
  if (seconds() - Number(r.Store.Meta("git-last-pass")) < 60) return;
  r.Store.SetMeta("git-last-pass", String(seconds()));
  const items = r.Store.DB.query(
    "SELECT key,value FROM meta WHERE (key LIKE 'git-change:%' OR key LIKE 'tracked-commit:%') AND key>? ORDER BY key LIMIT 32",
  ).all(r.Store.Meta("git-pass-after")) as { key: string; value: string }[];
  if (!items.length) {
    r.Store.DB.query("DELETE FROM meta WHERE key='git-pass-after'").run();
    return;
  }
  const deadline = Date.now() + 8000,
    failures: unknown[] = [];
  for (const item of items) {
    CheckSignal(signal);
    if (Date.now() > deadline) {
      r.Store.Diagnostic("git_reconciliation_budget_exceeded");
      break;
    }
    r.Store.SetMeta("git-pass-after", item.key);
    if (item.key.startsWith("tracked-commit:")) {
      const c: TrackedCommit = JSON.parse(item.value);
      if (Date.now() - Date.parse(c.CreatedAt) > 90 * 86400_000) {
        r.Store.DB.query("DELETE FROM meta WHERE key=?").run(item.key);
        continue;
      }
      if (c.CheckedAt && Date.now() - Date.parse(c.CheckedAt) < 300_000) continue;
      c.CheckedAt = new Date().toISOString();
      saveMeta(r, item.key, c);
      try {
        discoverPRs(r, c, signal);
      } catch (e) {
        r.Store.Diagnostic("scm_lookup_incomplete");
        failures.push(e);
      }
    } else {
      const c: GitChange = JSON.parse(item.value);
      if (Date.now() - Date.parse(c.CreatedAt) > 7 * 86400_000) {
        r.Store.Diagnostic("git_evidence_expired");
        r.Store.DB.query("DELETE FROM meta WHERE key=?").run(item.key);
        continue;
      }
      try {
        matchCommits(r, c, deadline, signal);
      } catch (e) {
        r.Store.Diagnostic("git_match_incomplete");
        failures.push(e);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "git reconciliation incomplete");
}

function fileObject(r: Recorder, hash: string, format: string): string {
  if (!hash) return "";
  if (!["sha1", "sha256"].includes(format)) throw new Error("unsupported git object format");
  const bytes = r.Store.Blob(hash);
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
  if (parts.length !== 3 || parts[1] !== "blob" || !gitHash(parts[2]!))
    throw new Error("not an ordinary file blob");
  return parts[2]!;
}
function matchCommits(r: Recorder, c: GitChange, deadline: number, signal?: AbortSignal) {
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
    r.Store.Diagnostic("git_history_bound");
    commits = commits.slice(0, 128);
  }
  for (const sha of commits) {
    CheckSignal(signal);
    if (Date.now() > deadline) throw new Error("git matching budget exceeded");
    if (!gitHash(sha)) throw new Error("invalid commit identity");
    if (treeObject(signal, root, sha, path) !== after) continue;
    const parents = fields(gitContext(signal, root, "show", "--format=%P", "--no-patch", sha));
    let matched = parents.length === 0 && before === "";
    for (const parent of parents)
      if (treeObject(signal, root, parent, path) === before) matched = true;
    if (!matched) continue;
    const event = r.event(c.Scope, `commit:${sha}`, c.Work, c.Source);
    event.commit = { id: sha, parents, quality: "inferred" };
    r.Store.Observe(event);
    if (c.Work) {
      const link = r.event(c.Scope, `work-commit:${c.Work}:${sha}`, c.Work, c.Source);
      link.link = {
        fromKind: "work",
        fromId: c.Work,
        toKind: "commit",
        toId: sha,
        quality: "inferred",
        reason: "file_revision",
      };
      r.Store.Observe(link);
    }
    const key = `tracked-commit:${StableID(c.Scope.Repo, sha)}`;
    if (!r.Store.Meta(key))
      saveMeta(r, key, {
        Scope: c.Scope,
        Source: c.Source,
        SHA: sha,
        CheckedAt: "0001-01-01T00:00:00Z",
        CreatedAt: new Date().toISOString(),
      });
  }
}

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
function scmAPI(root: string, repo: Repository, path: string, signal?: AbortSignal): any {
  CheckSignal(signal);
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
      timeout: RemainingTime(signal, 5000),
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      signal,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) throw new Error("host-bound SCM lookup unavailable");
  try {
    return Parse(result.stdout);
  } catch {
    throw new Error("invalid SCM response");
  }
}
export function providerID(v: unknown): string {
  const n = NumberText(v);
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
    return CanonicalTime(v);
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
export function pullRequest(source: Repository, v: Object): [Repository, PullRequest] {
  const repo: Repository = { provider: source.provider, host: source.host, id: "" };
  const p: PullRequest = {
    id: providerID(v.id),
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
    number = Integer(v.number);
    const base = obj(obj(v.base).repo);
    repo.id = providerID(base.id);
    repo.name = str(base, "full_name");
    p.uri = str(v, "html_url");
    p.state = p.mergeTime ? "merged" : str(v, "state");
  } else if (source.provider === "gitlab") {
    number = Integer(v.iid);
    repo.id = providerID(v.target_project_id);
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
  p.title = metadataTitle(p.title || "");
  p.issueKeys = issueKeys(p.title, "title");
  const branch = source.provider === "gitlab" ? str(v, "source_branch") : str(obj(v.head), "ref");
  for (const key of issueKeys(branch, "branch")) {
    if (p.issueKeys.length >= 20) break;
    if (!p.issueKeys.some((old) => old.key === key.key)) p.issueKeys.push(key);
  }
  return [repo, p];
}
function discoverPRs(r: Recorder, c: TrackedCommit, signal?: AbortSignal) {
  const repo = c.Scope.Repository;
  if (!repo) throw new Error("SCM repository is unknown");
  const path =
    repo.provider === "gitlab"
      ? `projects/${encodeURIComponent(repo.name || "")}`
      : `repos/${repo.name}`;
  const identity = scmAPI(c.Scope.CWD, repo, path, signal),
    id = providerID(identity.id);
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
  for (let page = 1; page <= 5; page++) {
    const prs = scmAPI(c.Scope.CWD, repo, `${endpoint}?per_page=100&page=${page}`, signal);
    if (!Array.isArray(prs)) throw new Error("invalid SCM response");
    for (const raw of prs) {
      const [target, p] = pullRequest(repo, obj(raw)),
        s = { ...c.Scope, Repository: target };
      const event = r.event(s, `pull-request:${target.id}:${p.id}`, "", c.Source);
      event.pullRequest = p;
      r.Store.Observe(event);
      const link = r.event(s, `commit-pr:${c.SHA}:${target.id}:${p.id}`, "", c.Source);
      link.link = {
        fromKind: "commit",
        fromId: c.SHA,
        toKind: "pull_request",
        toId: p.id,
        quality: "observed",
        reason: "provider_commit_membership",
      };
      r.Store.Observe(link);
    }
    if (prs.length < 100) return;
  }
  throw new Error("SCM pagination exceeds capture bound");
}

export function PruneEvidence(r: Recorder, now: Date) {
  const cutoff = Math.floor(now.getTime() / 1000) - 7 * 86400;
  r.Store.DB.query(
    "DELETE FROM tool_state WHERE unixepoch(json_extract(body,'$.started')) < ?",
  ).run(cutoff);
  r.Store.DB.query("DELETE FROM file_changes WHERE created_at < ?").run(cutoff);
  r.Store.DB.query("DELETE FROM blobs WHERE observed_at < ?").run(cutoff);
  const dir = join(r.Store.Dir, "blobs");
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
