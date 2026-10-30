import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseShell } from "shell-quote";
import type { fromMarkdown as parseMarkdown } from "mdast-util-from-markdown";
import type { applyDiff as applyPatchDiff } from "@openai/agents-core/utils";
import { safeRead, within } from "../platform.ts";
import { traceDir, tracedCommits } from "./commits.ts";
import {
  commitParents,
  git,
  issueKeys,
  metadataTitle,
  reconcileGit,
  recordCommit,
  refTips,
  rootOf,
  saveMeta,
} from "./git.ts";
import { bodyText, type Store } from "./ledger.ts";
import {
  canonicalHash,
  digest,
  integer,
  obj,
  stableId,
  str,
  type Event,
  type JsonObject,
  type Repository,
} from "./protocol.ts";
import {
  claudeUsage,
  openAiUsage,
  recoverContext,
  registerTranscript,
  route,
  saveSourceVersion,
  saveTranscriptVersion,
  telemetry,
} from "./recovery.ts";

export interface Native {
  stage?: string;
  event: JsonObject;
  result?: JsonObject;
  sessionId?: string;
  cwd?: string;
  version?: string;
  route?: string;
  billingBasis?: string;
}
// Scopes are stored in ledger metadata, as the Go helper wrote them; keep their field names.
export interface Scope {
  Session: string;
  Turn: string;
  Agent: string;
  CWD: string;
  Root: string;
  Repo: string;
  Repository?: Repository;
}
interface FileState {
  hash: string;
  exists: boolean;
  complete: boolean;
}
interface ToolState {
  files: Record<string, FileState>;
  expected: Record<string, string>;
  work: string;
  turn: string;
  agent: string;
  started: string;
  category: string;
  native: boolean;
  /** The blob of the ref tips a native edit saw; older versions saved the list itself. */
  refTips?: string | string[];
  refsKnown: boolean;
}
const emptyFile = (): FileState => ({ hash: "", exists: false, complete: false });

const knownHost = (host: string) =>
  ["github.com", "gitlab.com", process.env.GH_HOST, process.env.GITLAB_HOST].includes(host);
const sshHosts = new Map<string, string>();
/**
 * The provider host an SSH alias stands for (~/.ssh/config: Host github-work, HostName github.com), read without
 * connecting, as Kimchi resolves it (pull-request-status/provider-api.ts sshHostName).
 */
function sshHost(alias: string): string {
  if (knownHost(alias) || alias.startsWith("-")) return alias;
  let host = sshHosts.get(alias);
  if (host === undefined) {
    const config = spawnSync("ssh", ["-G", alias], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).stdout;
    const line = (config ?? "").split("\n").find((l) => l.startsWith("hostname "));
    host = line ? line.slice("hostname ".length).trim() : alias;
    sshHosts.set(alias, host);
  }
  return knownHost(host) ? host : alias;
}

export function repository(cwd: string): [string, string, Repository | undefined] {
  try {
    cwd = realpathSync(cwd);
  } catch {
    /* Keep the explicit native cwd. */
  }
  let root = "",
    common = "";
  try {
    const paths = git(
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ).split("\n");
    if (
      paths.length === 2 &&
      paths.every((path) => !!path && isAbsolute(path) && !path.includes("\r"))
    )
      [root, common] = paths as [string, string];
  } catch {
    // Git option outputs are unquoted; failures and newline paths use the legacy calls below.
  }
  if (!root || !common) {
    try {
      root = git(cwd, "rev-parse", "--show-toplevel");
    } catch {
      return [cwd, `local:${digest(cwd)}`, undefined];
    }
    try {
      common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    } catch {
      return [root, `local:${digest(root)}`, undefined];
    }
  }
  const local = stableId("git-common-dir", common);
  let remote = "";
  try {
    remote = git(root, "remote", "get-url", "origin");
  } catch {
    /* Local repository identity remains usable. */
  }
  let host = "",
    name = "";
  try {
    if (remote.startsWith("git@") && remote.includes(":")) {
      const colon = remote.indexOf(":");
      remote = `ssh://${remote.slice(0, colon)}/${remote.slice(colon + 1)}`;
    }
    const url = new URL(remote);
    if (url.protocol !== "https:" && !(url.protocol === "ssh:" && url.username === "git"))
      return [root, local, undefined];
    if (url.password || url.search || url.hash || (url.protocol === "https:" && url.username))
      return [root, local, undefined];
    // An HTTPS remote's port belongs to the web host; an SSH remote's port does not.
    host = url.protocol === "https:" ? url.host : sshHost(url.hostname);
    name = url.pathname.slice(1);
    if (name.endsWith(".git")) name = name.slice(0, -4);
  } catch {
    return [root, local, undefined];
  }
  if (!host || !name || ["\r", "\n", "@", "?", "#"].some((char) => (host + name).includes(char)))
    return [root, local, undefined];
  return [
    root,
    local,
    {
      provider:
        host === "github.com" || host.includes("ghe.") || host.includes("github")
          ? "github"
          : "gitlab",
      host: host.toLowerCase(),
      id: `name:${digest(name.toLowerCase())}`,
      name,
    },
  ];
}

function toolInput(e: JsonObject): JsonObject {
  const input = e.tool_input;
  return input && typeof input === "object" && !Array.isArray(input) ? input : e;
}
function toolCategory(name: string): string {
  switch (name.toLowerCase()) {
    case "read":
    case "read_file":
      return "read";
    case "edit":
    case "write":
    case "multiedit":
    case "apply_patch":
      return "edit";
    case "bash":
    case "exec_command":
    case "shell_command":
    case "shell":
    case "write_stdin":
      return "shell";
    case "exitplanmode":
      return "plan";
    default:
      return "other";
  }
}
export function patchInput(e: JsonObject): string {
  const input = toolInput(e);
  let patch = str(input, "patch", "input");
  if (typeof e.tool_input === "string") patch = e.tool_input;
  // Codex 0.165's hooks pass apply_patch's raw patch as tool_input.command.
  if (!patch && str(e, "tool_name") === "apply_patch") patch = str(input, "command");
  if (!patch) {
    try {
      const command = parseShell(str(input, "cmd", "command"), () => {
        throw new Error("Shell expansion is not edit evidence");
      });
      if (command.length === 2 && command[0] === "apply_patch" && typeof command[1] === "string")
        patch = command[1];
    } catch {
      /* Arbitrary shell scripts are observed, never confirmed. */
    }
  }
  patch = patch.trim();
  return patch.startsWith("*** Begin Patch\n") && patch.endsWith("\n*** End Patch") ? patch : "";
}

export function filePaths(s: Scope, e: JsonObject): [string[], boolean] {
  const root = rootOf(s),
    input = toolInput(e),
    paths: string[] = [];
  let base = s.CWD;
  for (const key of ["file_path", "path", "filePath"])
    if (str(input, key)) paths.push(str(input, key));
  const patch = patchInput(e);
  if (patch)
    for (const line of patch.split("\n"))
      for (const prefix of [
        "*** Update File: ",
        "*** Add File: ",
        "*** Delete File: ",
        "*** Move to: ",
      ]) {
        if (line.startsWith(prefix)) paths.push(line.slice(prefix.length));
      }
  const native = paths.length > 0;
  if (!native) {
    base = root;
    try {
      paths.push(
        ...git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"),
      );
    } catch {
      /* No complete inventory. */
    }
  }
  const found = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    let p = resolve(base, path);
    if (native) {
      // Resolve parent aliases (for example macOS /var) without following the file itself.
      let parent = dirname(p);
      const pending = [p.slice(parent.length + (parent === sep ? 0 : 1))];
      while (true) {
        try {
          p = join(realpathSync(parent), ...pending);
          break;
        } catch {
          const next = dirname(parent);
          if (next === parent) break;
          pending.unshift(parent.slice(next.length + (next === sep ? 0 : 1)));
          parent = next;
        }
      }
    }
    const rel = relative(root, p);
    if (!within(root, p) || rel.split(sep).includes(".git")) continue;
    found.add(p);
    if (found.size >= 1000) break;
  }
  return [[...found], native];
}

function planKey(root: string, path: string): string {
  try {
    root = realpathSync(root);
  } catch {
    /* Keep the native root. */
  }
  return within(root, path) ? relative(root, path).split(sep).join("/") : path;
}
export function referencedPaths(prompt: string, cwd: string): string[] {
  if (!prompt.includes("/") && !prompt.includes(".md")) return [];
  const {
    fromMarkdown,
  }: { fromMarkdown: typeof parseMarkdown } = require("mdast-util-from-markdown");
  const paths: string[] = [],
    tokens: string[] = [];
  type Node = { type: string; value?: string; url?: string; children?: readonly Node[] };
  const visit = (node: Node) => {
    if (tokens.length >= 128) return;
    if (node.type === "inlineCode") tokens.push(node.value ?? "");
    else if (node.type === "link" || node.type === "definition") tokens.push(node.url ?? "");
    else if (node.type === "text") {
      try {
        for (const token of parseShell(node.value ?? "", () => {
          throw new Error("File references never expand variables");
        })) {
          if (typeof token === "string") tokens.push(token);
          if (tokens.length >= 128) break;
        }
      } catch {
        tokens.push(node.value ?? "");
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(prompt));
  for (const token of tokens.slice(0, 128)) {
    const v = token.startsWith("@") ? token.slice(1) : token;
    if (!v.includes("/") && !v.endsWith(".md")) continue;
    try {
      paths.push(realpathSync(resolve(cwd, v)));
    } catch {
      /* Referenced file does not exist. */
    }
  }
  return paths;
}

export class Recorder {
  constructor(
    public store: Store,
    public source: string,
    public device: string,
  ) {}
  recoverContext(signal?: AbortSignal) {
    return recoverContext(this, signal);
  }
  reconcileGit(signal?: AbortSignal) {
    return reconcileGit(this, signal);
  }

  event(s: Scope, entity: string, work: string, source = this.source): Event {
    return {
      entityId: stableId(source, s.Session, entity),
      source,
      sourceVersion: this.store.meta(`source-version:${source}:${s.Session}`) || "unknown",
      deviceId: this.device,
      observeTime: new Date().toISOString(),
      repository: s.Repository,
      workId: work,
      sessionId: s.Session,
      turnId: s.Turn,
      agentId: s.Agent,
    };
  }
  workExact(s: Scope): string {
    return (
      (
        this.store.db
          .query(
            "SELECT work_id FROM bindings WHERE source=? AND session_id=? AND turn_id=? AND agent_id=?",
          )
          .get(this.source, s.Session, s.Turn, s.Agent) as { work_id: string } | null
      )?.work_id ?? ""
    );
  }
  work(s: Scope): string {
    const exact = this.workExact(s);
    return (
      exact ||
      this.store.meta(
        s.Agent
          ? `agent-work:${this.source}:${s.Session}:${s.Agent}`
          : `${this.source}:${s.Session}:work`,
      )
    );
  }
  bind(s: Scope, prompt: string) {
    if (this.workExact(s)) return;
    const text = prompt.trim(),
      explicit =
        !s.Agent && (text.toLowerCase().startsWith("new work:") || text.startsWith("/work new"));
    const title =
      explicit && text.toLowerCase().startsWith("new work:")
        ? metadataTitle(text.slice(9).split("\n", 1)[0]!)
        : "";
    const owners = new Set<string>();
    if (!explicit)
      for (const path of referencedPaths(prompt, s.CWD)) {
        let bytes: Buffer;
        try {
          bytes = safeRead(dirname(path), path).bytes;
        } catch {
          continue;
        }
        const rows = this.store.db
          .query("SELECT DISTINCT work_id FROM plans WHERE repository=? AND path=? AND hash=?")
          .all(s.Repo, planKey(rootOf(s), path), digest(bytes)) as { work_id: string }[];
        for (const row of rows) owners.add(row.work_id);
      }
    const keys = issueKeys(title, "work");
    // Parsing, Git and file reads finish before taking the short writer lock.
    this.store.db
      .transaction(() => {
        if (this.workExact(s)) return;
        let work = "",
          reason = "new_prompt",
          quality = "observed";
        if (explicit) {
          reason = "explicit_new_work";
          quality = "confirmed";
        } else if (owners.size === 1) {
          work = [...owners][0]!;
          reason = "verified_plan_revision";
          quality = "confirmed";
        } else if (owners.size > 1) {
          reason = "ambiguous_plan_reference";
          this.store.diagnostic(reason);
        } else {
          work = this.work(s);
          reason = "session_continuation";
          quality = "inferred";
        }
        work ||= randomUUID();
        this.store.db
          .query("INSERT OR IGNORE INTO work(id,repository,created_at) VALUES(?,?,?)")
          .run(work, s.Repo, Math.floor(Date.now() / 1000));
        this.store.db
          .query(
            "INSERT INTO bindings(source,session_id,turn_id,agent_id,work_id,repository) VALUES(?,?,?,?,?,?)",
          )
          .run(this.source, s.Session, s.Turn, s.Agent, work, s.Repo);
        if (!s.Agent) {
          this.store.setMeta(`${this.source}:${s.Session}:turn`, s.Turn);
          this.store.setMeta(`${this.source}:${s.Session}:work`, work);
        }
        const e = this.event(s, `binding:${s.Turn}`, work);
        e.work = { reason, quality, title, issueKeys: keys };
        this.store.observe(e);
      })
      .immediate();
  }
  registerPlan(cwd: string, path: string, work: string, s: Scope) {
    if (!work) throw new Error("plan has no work binding");
    path = realpathSync(resolve(cwd, path));
    const hash = digest(safeRead(dirname(path), path).bytes),
      key = planKey(rootOf(s), path);
    const planId = stableId(s.Repo, key, work),
      revision = stableId(planId, hash);
    this.store.db
      .query(
        "INSERT OR IGNORE INTO plans(repository,path,hash,work_id,plan_id,revision_id) VALUES(?,?,?,?,?,?)",
      )
      .run(s.Repo, key, hash, work, planId, revision);
    const e = this.event(s, `plan:${revision}`, work);
    e.work = { planId, planRevision: revision, reason: "saved_plan", quality: "confirmed" };
    this.store.observe(e);
  }
  record(n: Native) {
    if (this.source !== "claude-code" && this.source !== "codex")
      throw new Error("unsupported source");
    if (!n.event || typeof n.event !== "object") throw new Error("missing native event");
    const e = n.event,
      result = n.result ?? {},
      stage = n.stage || str(e, "hook_event_name");
    const observedRoute = n.route || route(this.source),
      basis = n.billingBasis || "unknown";
    const modelRequest = this.source === "codex" && stage === "PostModelRequest";
    const s: Scope = {
      Session: n.sessionId || str(e, "session_id"),
      Turn: str(e, "turn_id", "turnId"),
      Agent: str(e, "agent_id", "agentId"),
      CWD: n.cwd || str(e, "cwd"),
      Root: "",
      Repo: "",
    };
    if (!s.Session || !isAbsolute(s.CWD))
      throw new Error("missing native session or working directory");
    try {
      s.CWD = realpathSync(s.CWD);
    } catch {
      /* Preserve native cwd. */
    }
    [s.Root, s.Repo, s.Repository] = repository(s.CWD);
    if (n.version) saveSourceVersion(this, s.Session, n.version);
    if (str(e, "transcript_path") && this.source === "codex")
      saveTranscriptVersion(this, s.Session, str(e, "transcript_path"));
    if (!modelRequest) s.Turn ||= this.store.meta(`${this.source}:${s.Session}:turn`);
    if (stage === "classic.UserPromptSubmit" && str(e, "prompt_id"))
      this.store.setMeta(`pending-prompt:${s.Session}`, str(e, "prompt_id"));
    if (stage === "turn.start" || stage === "UserPromptSubmit") {
      if (!s.Turn) throw new Error("prompt has no turn identity");
      this.bind(s, str(e, "text", "prompt"));
    }
    if (s.Turn) {
      const prompt =
        str(e, "prompt_id") ||
        (stage === "turn.start" ? this.store.meta(`pending-prompt:${s.Session}`) : "");
      if (prompt)
        this.store.db
          .query("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)")
          .run(`prompt-turn:${s.Session}:${prompt}`, s.Turn);
    }
    let work = this.work(s);
    if (stage === "SessionStart" && this.source === "codex") {
      const coverage = this.event(s, "coverage:native-request-surface", work);
      coverage.coverage = { code: "native_auxiliary_usage_coverage_unknown", count: "1" };
      this.store.observe(coverage);
      this.store.diagnostic("native_auxiliary_usage_coverage_unknown");
    }
    if (stage === "telemetry.log") return telemetry(this, s, e, observedRoute, basis);
    if (stage === "step.after") {
      const usage = obj(result.usage),
        index = integer(e.index);
      if (index !== undefined && s.Turn) {
        const step = this.event(s, `step:${s.Turn}:${s.Agent}:${canonicalHash(index)}`, work);
        step.coverage = {
          code: "mod_step_request_identity_missing",
          count: "1",
          observedUsage: claudeUsage(usage),
          model: str(usage, "model"),
        };
        this.store.observe(step);
      }
      return;
    }
    if (modelRequest) {
      const boundWork =
        (s.Turn ? this.workExact(s) : "") ||
        (s.Agent ? this.store.meta(`agent-work:${this.source}:${s.Session}:${s.Agent}`) : "");
      const status = ["completed", "failed", "cancelled"].includes(str(e, "status"))
        ? str(e, "status")
        : "unknown";
      // No native request ID exists: keep callbacks distinct, and never charge these harness
      // counters (which may contain defaulted zeroes) in addition to transcript usage.
      const observation = this.event(s, `model-request-observation:${randomUUID()}`, boundWork);
      observation.coverage = {
        code: `native_model_request_${status}`,
        count: "1",
        model: str(e, "model"),
        ...(e.token_usage && Object.getPrototypeOf(e.token_usage) === Object.prototype
          ? { observedUsage: openAiUsage(e.token_usage) }
          : {}),
      };
      this.store.observe(observation);
      this.store.diagnostic("native_model_request_identity_missing");
    }
    if (stage === "tool.before" || stage === "PreToolUse") this.before(s, e, work);
    if (["tool.after", "PostToolUse", "PostToolUseFailure"].includes(stage))
      this.after(
        s,
        e,
        work,
        stage === "PostToolUseFailure" || result.isError === true || !!str(result, "deny"),
      );
    if (stage === "SubagentStart" || stage === "classic.SubagentStart") {
      const agent = str(e, "agent_id");
      work = this.work({ ...s, Agent: "" });
      if (agent && work) {
        this.store.db
          .query(
            "INSERT OR IGNORE INTO bindings(source,session_id,turn_id,agent_id,work_id,repository) VALUES(?,?,?,?,?,?)",
          )
          .run(this.source, s.Session, s.Turn, agent, work, s.Repo);
        this.store.db
          .query("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)")
          .run(`agent-work:${this.source}:${s.Session}:${agent}`, work);
      }
    }
    if (str(e, "transcript_path"))
      registerTranscript(
        this,
        { ...s, Agent: "" },
        str(e, "transcript_path"),
        observedRoute,
        basis,
      );
    if (str(e, "agent_transcript_path") && s.Agent)
      registerTranscript(
        this,
        { ...s, Turn: "" },
        str(e, "agent_transcript_path"),
        observedRoute,
        basis,
      );
    if (stage === "tool.after" && str(e, "tool", "tool_name").toLowerCase() === "exitplanmode") {
      const path =
        str(obj(result.result), "filePath", "planFilePath") ||
        str(result, "filePath", "planFilePath");
      if (path) this.registerPlan(s.CWD, path, work, s);
    }
  }
  snapshot(root: string, path: string): FileState {
    try {
      const { bytes } = safeRead(root, path);
      return { hash: this.store.putBlob(bytes), exists: true, complete: true };
    } catch (error: any) {
      if (error.code === "ENOENT") return { hash: "", exists: false, complete: true };
      this.store.diagnostic("file_snapshot_incomplete");
      return emptyFile();
    }
  }
  before(s: Scope, e: JsonObject, work: string) {
    const call = str(e, "tool_use_id", "call_id", "toolCallId");
    if (!call) {
      this.store.diagnostic("tool_identity_missing");
      return;
    }
    const [paths, native] = filePaths(s, e),
      category = toolCategory(str(e, "tool_name", "tool"));
    if (category === "shell")
      try {
        mkdirSync(traceDir(this.source, s.Session), { recursive: true });
      } catch {
        this.store.diagnostic("git_trace_unavailable");
      }
    // Only native edits are matched to commits. A large repository has thousands of tips, so a blob holds each
    // distinct set once.
    let refs: string | undefined;
    if (native && category !== "read")
      try {
        const tips = refTips(s.CWD);
        if (tips) refs = this.store.putBlob(Buffer.from(tips.join("\n")));
      } catch {
        this.store.diagnostic("git_refs_unavailable");
      }
    const state: ToolState = {
      files: {},
      expected: {},
      work,
      turn: s.Turn,
      agent: s.Agent,
      started: new Date().toISOString(),
      category,
      native,
      refTips: refs,
      refsKnown: refs !== undefined,
    };
    const deadline = Date.now() + 800;
    let bytes = 0;
    for (const path of paths) {
      if (Date.now() > deadline || bytes >= 8 << 20) {
        this.store.diagnostic("file_snapshot_budget_exceeded");
        break;
      }
      if (within(this.store.dir, path)) continue;
      const before = this.snapshot(rootOf(s), path);
      state.files[path] = before;
      try {
        bytes += lstatSync(path).size;
      } catch {
        /* Missing file contributes no bytes. */
      }
      const expected = this.expected(before, e, s.CWD, path);
      if (expected !== undefined) state.expected[path] = expected;
    }
    // The FULL SQLite commit completes before the native tool is allowed to run.
    this.store.db
      .query("INSERT OR IGNORE INTO tool_state(source,session_id,call_id,body) VALUES(?,?,?,?)")
      .run(this.source, s.Session, call, JSON.stringify(state));
  }
  after(s: Scope, e: JsonObject, work: string, failed: boolean) {
    const call = str(e, "tool_use_id", "call_id", "toolCallId");
    if (!call) {
      this.store.diagnostic("tool_identity_missing");
      return;
    }
    const row = this.store.db
      .query("SELECT body FROM tool_state WHERE source=? AND session_id=? AND call_id=?")
      .get(this.source, s.Session, call) as { body: string | Uint8Array } | null;
    if (!row) {
      this.store.diagnostic("tool_preimage_missing");
      return;
    }
    const state: ToolState = JSON.parse(bodyText(row.body));
    state.expected ||= {};
    s = { ...s, Turn: state.turn, Agent: state.agent };
    work = state.work;
    const done = `${this.source}:${s.Session}:${call}:done`;
    if (this.store.meta(done)) return;
    const ev = this.event(s, `tool:${call}`, work);
    ev.tool = {
      callId: call,
      name: str(e, "tool", "tool_name"),
      requestEntityId: this.store.meta(`tool-request:${this.source}:${s.Session}:${call}`),
      category: state.category,
      outcome: failed ? "failed" : "completed",
      durationMs: String(Date.now() - new Date(state.started).getTime()),
    };
    this.store.observe(ev);
    if (state.category === "shell")
      try {
        this.traceCommits(s, call, work, state.started);
      } catch {
        this.store.diagnostic("git_trace_incomplete");
      }
    const [paths] = filePaths(s, e);
    for (const path of paths) state.files[path] ||= emptyFile();
    for (const [path, before] of Object.entries(state.files)) {
      if (within(this.store.dir, path)) continue;
      if (!before.complete) {
        this.store.diagnostic("file_snapshot_incomplete");
        continue;
      }
      const after = this.snapshot(rootOf(s), path);
      if (!after.complete) {
        this.store.diagnostic("file_snapshot_incomplete");
        continue;
      }
      if (before.hash === after.hash && before.exists === after.exists && state.category !== "read")
        continue;
      this.store.db
        .query("INSERT OR IGNORE INTO file_identity(repository,path,id) VALUES(?,?,?)")
        .run(s.Repo, path, randomUUID());
      const id = (
        this.store.db
          .query("SELECT id FROM file_identity WHERE repository=? AND path=?")
          .get(s.Repo, path) as { id: string }
      ).id;
      const revisions = ["", ""];
      for (const [index, file] of [before, after].entries())
        if (file.exists) {
          this.store.db
            .query(
              "INSERT OR IGNORE INTO file_revisions(repository,file_id,hash,id) VALUES(?,?,?,?)",
            )
            .run(s.Repo, id, file.hash, randomUUID());
          revisions[index] = (
            this.store.db
              .query("SELECT id FROM file_revisions WHERE repository=? AND file_id=? AND hash=?")
              .get(s.Repo, id, file.hash) as { id: string }
          ).id;
        }
      const operation = !before.exists
        ? "created"
        : !after.exists
          ? "deleted"
          : state.category === "read"
            ? "read"
            : "modified";
      const quality =
        state.native &&
        !failed &&
        Object.hasOwn(state.expected, path) &&
        state.expected[path] === after.hash
          ? "tool_observed"
          : "observed";
      const change = stableId(this.source, s.Session, call, id),
        fe = this.event(s, `file:${change}`, work);
      fe.file = {
        fileId: id,
        toolCallId: call,
        beforeRevision: revisions[0],
        afterRevision: revisions[1],
        operation,
        quality,
      };
      this.store.observe(fe);
      this.store.db
        .query(
          "INSERT OR IGNORE INTO file_changes(id,repository,path,before_hash,after_hash,work_id,quality,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          change,
          s.Repo,
          path,
          before.hash,
          after.hash,
          work,
          quality,
          Math.floor(Date.now() / 1000),
        );
      if (
        state.category !== "read" &&
        before.hash !== after.hash &&
        state.refsKnown &&
        quality === "tool_observed"
      ) {
        saveMeta(this, `git-change:${change}`, {
          Scope: s,
          Source: this.source,
          Work: work,
          Path: path,
          Before: before.hash,
          After: after.hash,
          Refs: state.refTips,
          CreatedAt: new Date().toISOString(),
        });
      }
      const rel = relative(rootOf(s), path);
      if (
        state.category !== "read" &&
        quality === "tool_observed" &&
        after.exists &&
        path.endsWith(".md") &&
        (rel.startsWith("plans/") || rel.startsWith(".plans/"))
      ) {
        try {
          this.registerPlan(s.CWD, path, work, s);
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    this.store.db.query("INSERT OR IGNORE INTO meta(key,value) VALUES(?,'1')").run(done);
  }
  /** Commits made by this session's shell calls' own Git processes, as Kimchi records them. */
  traceCommits(s: Scope, call: string, work: string, started: string) {
    const dir = traceDir(this.source, s.Session);
    for (const c of tracedCommits(join(dir, "events"), join(dir, "refs"))) {
      let owner = work;
      if (c.call && c.call !== call) {
        // A call that returned before its command ended, such as unified exec polled later.
        const row = this.store.db
          .query("SELECT body FROM tool_state WHERE source=? AND session_id=? AND call_id=?")
          .get(this.source, s.Session, c.call) as { body: string | Uint8Array } | null;
        if (!row) continue;
        owner = (JSON.parse(bodyText(row.body)) as ToolState).work;
      } else if (!c.call) {
        // Without a logged call, only a Claude Code session's lone shell call claims a commit,
        // and only one its own command made.
        const busy = this.store.db
          .query(
            `SELECT 1 FROM tool_state t
             LEFT JOIN meta m ON m.key=t.source||':'||t.session_id||':'||t.call_id||':done'
             WHERE t.source=? AND t.session_id=? AND t.call_id<>? AND m.key IS NULL
               AND json_extract(t.body,'$.category')='shell'
               AND unixepoch(json_extract(t.body,'$.started')) > unixepoch()-21600
             LIMIT 1`,
          )
          .get(this.source, s.Session, call);
        if (this.source !== "claude-code" || busy || c.time < Date.parse(started)) continue;
      }
      const [root, repo, identity] = repository(c.worktree);
      const key = `agent-commit:${stableId(repo, c.sha)}`;
      if (this.store.meta(key)) continue;
      // ponytail: a rebased or picked copy follows any commit this ledger traced; Kimchi requires
      // the original to belong to the same work.
      if (c.rewrittenFrom && !this.store.meta(`agent-commit:${stableId(repo, c.rewrittenFrom)}`))
        continue;
      const scope = { ...s, Root: root, Repo: repo, Repository: identity };
      const parents = commitParents(root, c.sha);
      recordCommit(this, scope, owner, this.source, c.sha, parents, "observed", "agent_commit");
      this.store.setMeta(key, "1");
    }
  }
  expected(before: FileState, e: JsonObject, root: string, path: string): string | undefined {
    if (!before.complete) return;
    const patch = patchInput(e);
    if (patch) return this.patchExpected(before, patch, root, path);
    const input = toolInput(e);
    switch (str(e, "tool", "tool_name").toLowerCase()) {
      case "read":
      case "read_file":
        return before.exists ? before.hash : undefined;
      case "write":
        return typeof input.content === "string" && Buffer.byteLength(input.content) <= 4 << 20
          ? digest(input.content)
          : undefined;
      case "edit": {
        const old = input.old_string,
          replacement = input.new_string;
        if (typeof old !== "string" || !old || !before.exists || typeof replacement !== "string")
          return;
        let text: string;
        try {
          text = this.store.blob(before.hash).toString();
        } catch {
          return;
        }
        if (input.replace_all !== true && text.split(old).length !== 2) return;
        return digest(
          input.replace_all === true
            ? text.split(old).join(replacement)
            : text.replace(old, () => replacement),
        );
      }
    }
  }
  patchExpected(before: FileState, patch: string, root: string, path: string): string | undefined {
    let kind = "",
      active = false;
    const block: string[] = [];
    for (const line of patch.split("\n").slice(1)) {
      if (line.startsWith("*** ") && line !== "*** End of File") {
        if (active) {
          if (line.startsWith("*** Move to:")) return;
          break;
        }
        for (const prefix of ["*** Add File: ", "*** Update File: ", "*** Delete File: "])
          if (line.startsWith(prefix) && resolve(root, line.slice(prefix.length)) === path) {
            active = true;
            kind = prefix;
          }
      } else if (active) block.push(line);
    }
    if (!active) return;
    if (kind === "*** Delete File: ") return before.exists ? "" : undefined;
    const {
      applyDiff,
    }: { applyDiff: typeof applyPatchDiff } = require("@openai/agents-core/utils");
    if (kind === "*** Add File: ") {
      if (!block.length || block.some((line) => !line.startsWith("+"))) return;
      try {
        return digest(`${applyDiff("", block.join("\n"), "create")}\n`);
      } catch {
        return;
      }
    }
    if (!before.exists) return;
    let content: string;
    try {
      content = this.store.blob(before.hash).toString();
    } catch {
      return;
    }
    const starts = block.flatMap((line, index) => (line.startsWith("@@") ? [index + 1] : []));
    if (!starts.length || starts[0] !== 1) starts.unshift(0);
    const haystack = `\n${content.endsWith("\n") ? content : `${content}\n`}`;
    let cursor = 0,
      anchorRun = 0;
    for (let i = 0; i < starts.length; i++) {
      const header = starts[i]! > 0 ? block[starts[i]! - 1]! : "";
      if (header && header !== "@@") {
        if (!header.startsWith("@@ ")) return;
        const anchor = header.slice(3);
        if (anchor.trim()) {
          const needle = `\n${anchor}\n`,
            at = haystack.indexOf(needle);
          if (at < 0 || at !== haystack.lastIndexOf(needle) || (anchorRun > 0 && at < cursor))
            return;
          cursor = Math.max(cursor, at + needle.length - 1);
          anchorRun++;
        }
      }
      const section = block.slice(
        starts[i],
        i + 1 < starts.length ? starts[i + 1]! - 1 : block.length,
      );
      if (!section.length) continue;
      if (
        section.some(
          (line) => !line || (![" ", "+", "-"].includes(line[0]!) && line !== "*** End of File"),
        )
      )
        return;
      const old = section
        .filter((line) => line.startsWith(" ") || line.startsWith("-"))
        .map((line) => line.slice(1));
      if (!old.length) return;
      const needle = `\n${old.join("\n")}\n`,
        at = haystack.indexOf(needle);
      if (
        at < cursor ||
        at !== haystack.lastIndexOf(needle) ||
        (section.includes("*** End of File") && !haystack.endsWith(needle))
      )
        return;
      cursor = at + needle.length - 1;
      anchorRun = 0;
    }
    try {
      const output = applyDiff(content, block.join("\n"));
      return digest(output.endsWith("\n") ? output : `${output}\n`);
    } catch {
      return;
    }
  }
}
