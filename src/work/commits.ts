import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateRoot } from "../settings.ts";
import { stableId } from "./protocol.ts";

// Kimchi's agent-commit tracer (work-attribution/commits.ts): each agent shell command runs with
// GIT_TRACE2_EVENT and GIT_TRACE_REFS, and a HEAD update counts only when exactly one traced Git
// process owns its moment. Hooks, configuration and reflogs stay untouched.
export interface TracedCommit {
  sha: string;
  worktree: string;
  /** The tool call named by the owning process's environment (GIT_TRACE2_ENV_VARS). */
  call: string;
  /** When the owning Git process started, in milliseconds. */
  time: number;
  /** Original commit replayed by a rebase or cherry-pick; the copy is what gets pushed. */
  rewrittenFrom?: string;
}
interface GitProcess {
  /** trace2 session ID; a child Git process's ID is prefixed by its parent's. */
  sid: string;
  start: number;
  end?: number;
  command?: string;
  worktree?: string;
  call?: string;
}
// Environment variables carrying a tool call's identity into its shell commands.
export const CALL_VARIABLES = ["CODEX_TOOL_CALL_ID", "CLAUDE_CODE_TOOL_USE_ID"];
const TRACE_BOUND = 64 << 20;

const digits = (s: string) => s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");
const hexId = (s: string) =>
  (s.length === 40 || s.length === 64) && [...s].every((c) => "0123456789abcdef".includes(c));

// Date parses milliseconds; keep Git's remaining microseconds.
function instant(value: string): number {
  const dot = value.lastIndexOf("."),
    fraction = value.endsWith("Z") && dot > 0 ? value.slice(dot + 1, -1) : "";
  return Date.parse(value) * 1000 + (fraction.length === 6 ? Number(fraction.slice(3)) : 0);
}

function lines(path: string): string[] {
  let size;
  try {
    size = statSync(path).size;
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  // ponytail: whole-file read; stream like Kimchi if one command's trace outgrows this bound.
  if (size > TRACE_BOUND) throw new Error("git trace exceeds its bound");
  return readFileSync(path, "utf8").split("\n");
}

function processes(trace: string): GitProcess[] {
  const byId = new Map<string, GitProcess>();
  for (const line of lines(trace)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event?.sid !== "string" || typeof event.time !== "string") continue;
    if (event.event === "start")
      byId.set(event.sid, { sid: event.sid, start: instant(event.time) });
    const p = byId.get(event.sid);
    if (!p) continue;
    if (event.event === "cmd_name") p.command = event.name;
    if (event.event === "def_repo") p.worktree = event.worktree;
    if (event.event === "def_param" && CALL_VARIABLES.includes(event.param)) p.call = event.value;
    if (event.event === "exit") p.end = instant(event.time);
  }
  return [...byId.values()];
}

// Ref traces print the Git process's local time (HH:MM:SS.ffffff), which the hook shares as
// Kimchi's harness does; place it within the process's run.
function localTimeInProcess(time: string, p: GitProcess): number | undefined {
  const day = new Date(p.start / 1000);
  day.setHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), Number(time.slice(6, 8)), 0);
  let timestamp = day.getTime() * 1000 + Number(time.slice(9));
  // A command may cross local midnight.
  if (timestamp < p.start) {
    day.setDate(day.getDate() + 1);
    timestamp = day.getTime() * 1000 + Number(time.slice(9));
  }
  return p.end !== undefined && timestamp >= p.start && timestamp <= p.end ? timestamp : undefined;
}

const within = (p: GitProcess, ancestor: GitProcess) =>
  p === ancestor || p.sid.startsWith(`${ancestor.sid}/`);

// Of the processes running at a ref move whose command could make it, nested ones (hooks, sequencer
// commits) own the moment; unrelated ones make it ambiguous. Codex sessions share one trace, so
// another session's status, fetch or push is often running too; it cannot move this HEAD.
function ownerAt(
  time: string,
  running: GitProcess[],
  could: (p: GitProcess) => boolean,
): GitProcess | undefined {
  const candidates = running.filter((p) => could(p) && localTimeInProcess(time, p) !== undefined);
  return candidates.find((p) => candidates.every((other) => within(p, other)));
}

function rewriteMessage(message: string): boolean {
  if (message.startsWith("cherry-pick:")) return true;
  for (const prefix of ["rebase (", "rebase -i ("])
    if (message.startsWith(prefix))
      return ["pick", "reword", "edit", "squash", "fixup", "continue"].some((action) =>
        message.startsWith(`${prefix}${action}):`),
      );
  return false;
}

interface RefLine {
  time: string;
  content: string;
}
// `07:20:26.981342 refs/debug.c:88         0: HEAD <old> -> <new> (F=0xd, T=0x1) "commit: add f"`
function refLine(line: string): RefLine | undefined {
  const time = line.slice(0, 15);
  if (line[15] !== " " || time[2] !== ":" || time[5] !== ":" || time[8] !== ".") return;
  if (![time.slice(0, 2), time.slice(3, 5), time.slice(6, 8), time.slice(9)].every(digits)) return;
  const rest = line.slice(16).trimStart(),
    space = rest.indexOf(" ");
  return space < 0 ? undefined : { time, content: rest.slice(space).trimStart() };
}
// `<n>: <ref> <old> -> <new> (...) "<message>"`
function refUpdate(content: string): { ref: string; sha: string; message: string } | undefined {
  const colon = content.indexOf(": ");
  if (colon < 0 || !digits(content.slice(0, colon))) return;
  const [ref, , arrow, sha, flags] = content.slice(colon + 2).split(" ");
  if (!ref || arrow !== "->" || !sha || !hexId(sha) || !flags?.startsWith("(")) return;
  const open = content.indexOf(') "');
  const message = open >= 0 && content.endsWith('"') ? content.slice(open + 3, -1) : "";
  return { ref, sha, message };
}

/** HEAD moves made by a traced command that create or replay a commit. */
function headCommit(
  sha: string,
  message: string,
  owner: GitProcess | undefined,
  replayed: string | undefined,
): { sha: string; rewrittenFrom?: string } | undefined {
  if (!owner?.worktree) return;
  // Checked first: the sequencer may hand a replayed pick to a nested `git commit`.
  if (rewriteMessage(message)) {
    if (!["rebase", "cherry-pick", "commit"].includes(owner.command ?? "")) return;
    return replayed ? { sha, rewrittenFrom: replayed } : undefined;
  }
  if (owner.command === "commit" || (owner.command === "revert" && message.startsWith("revert:")))
    return { sha };
  if (
    owner.command === "merge" &&
    message.startsWith("merge ") &&
    !message.includes("Fast-forward")
  )
    return { sha };
}

/** Commits whose ref transaction one traced Git process owned and finished successfully. */
export function tracedCommits(trace: string, refs: string): TracedCommit[] {
  const running = processes(trace);
  const commits: TracedCommit[] = [];
  let pending: { sha: string; rewrittenFrom?: string; owner: GitProcess } | undefined;
  let replayed: { sha: string; owner: GitProcess } | undefined;
  for (const line of lines(refs)) {
    const parsed = refLine(line);
    if (!parsed) continue;
    const { time, content } = parsed;
    if (content === "transaction {") pending = undefined;
    const update = refUpdate(content);
    if (update && (update.ref === "CHERRY_PICK_HEAD" || update.ref === "REBASE_HEAD")) {
      const owner = ownerAt(time, running, (p) =>
        ["rebase", "cherry-pick"].includes(p.command ?? ""),
      );
      replayed =
        owner && [...update.sha].some((c) => c !== "0") ? { sha: update.sha, owner } : undefined;
    }
    if (update?.ref === "HEAD") {
      const commitBy = (p: GitProcess | undefined) =>
        headCommit(
          update.sha,
          update.message,
          p,
          replayed && p && within(p, replayed.owner) ? replayed.sha : undefined,
        );
      const owner = ownerAt(time, running, (p) => commitBy(p) !== undefined);
      const commit = commitBy(owner);
      pending = commit && owner ? { ...commit, owner } : undefined;
      if (commit?.rewrittenFrom) replayed = undefined;
    }
    if (!content.startsWith("finish: ")) continue;
    if (pending && content === "finish: 0" && localTimeInProcess(time, pending.owner) !== undefined)
      commits.push({
        sha: pending.sha,
        worktree: pending.owner.worktree!,
        call: pending.owner.call ?? "",
        time: Math.floor(pending.owner.start / 1000),
        ...(pending.rewrittenFrom ? { rewrittenFrom: pending.rewrittenFrom } : {}),
      });
    pending = undefined;
  }
  return commits;
}

// Where an agent shell's Git trace goes. Claude Code sets it per session through CLAUDE_ENV_FILE;
// Codex has no per-session environment, so its sessions share one trace and tell calls apart by
// CODEX_TOOL_CALL_ID. Git warns on every command when the directory is missing, so callers create it
// before each shell call.
export function traceDir(source: string, session: string): string {
  const root = join(stateRoot(), "git-trace");
  return source === "codex" ? join(root, "codex") : join(root, source, stableId(source, session));
}
const traceVariables = (dir: string, call: string) => ({
  GIT_TRACE2_EVENT: join(dir, "events"),
  GIT_TRACE_REFS: join(dir, "refs"),
  GIT_TRACE2_ENV_VARS: call,
});
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Lines for Claude Code's CLAUDE_ENV_FILE: plain assignments, which PowerShell accepts too. */
export function claudeTraceEnv(session: string): string {
  const dir = traceDir("claude-code", session);
  mkdirSync(dir, { recursive: true });
  return Object.entries(traceVariables(dir, "CLAUDE_CODE_TOOL_USE_ID"))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");
}

const BEGIN = "# kimchi-bridge: begin (traces agent commits for PR attribution)";
const END = "# kimchi-bridge: end";
function withoutBlock(text: string): string {
  const start = text.indexOf(BEGIN),
    end = start < 0 ? -1 : text.indexOf(END, start);
  if (end < 0) return text;
  const before = text.slice(0, start).trimEnd(),
    after = text.slice(end + END.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n") + (before || after ? "\n" : "");
}

/**
 * Add (or remove) the Codex shell environment that traces agent commits, in Codex's user config.
 * Returns false and leaves the file alone when the user already sets shell_environment_policy in a
 * form a separate [shell_environment_policy.set] table would conflict with.
 */
export function codexTraceConfig(
  enable: boolean,
  home = process.env.CODEX_HOME || join(homedir(), ".codex"),
): boolean {
  const path = join(home, "config.toml");
  let text = "",
    mode = 0o600;
  try {
    text = readFileSync(path, "utf8");
    mode = statSync(path).mode & 0o777;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const base = withoutBlock(text);
  let next = base;
  if (enable) {
    const policy = (Bun.TOML.parse(base) as Record<string, unknown>).shell_environment_policy;
    if (
      policy !== undefined &&
      (!policy ||
        typeof policy !== "object" ||
        "set" in policy ||
        !base.split("\n").some((line) => line.trim() === "[shell_environment_policy]"))
    )
      return false;
    const dir = traceDir("codex", "");
    mkdirSync(dir, { recursive: true });
    const assignments = Object.entries(traceVariables(dir, "CODEX_TOOL_CALL_ID")).map(
      ([name, value]) => `${name} = ${JSON.stringify(value)}`,
    );
    next =
      (base.trimEnd() ? base.trimEnd() + "\n\n" : "") +
      [BEGIN, "[shell_environment_policy.set]", ...assignments, END].join("\n") +
      "\n";
  }
  if (next === text) return true;
  // Never write a config Codex cannot read.
  Bun.TOML.parse(next);
  mkdirSync(home, { recursive: true });
  const temp = `${path}.kimchi-bridge-${process.pid}`;
  writeFileSync(temp, next, { mode });
  renameSync(temp, path);
  return true;
}

/**
 * Drop traces no shell call still needs: quiet for ten minutes, or past the size bound. Git keeps an
 * open trace file until it exits, so a running command's trace is never removed at once.
 */
export function pruneTraces(now = Date.now()) {
  const root = join(stateRoot(), "git-trace");
  const dirs = [join(root, "codex")];
  try {
    for (const session of readdirSync(join(root, "claude-code")))
      dirs.push(join(root, "claude-code", session));
  } catch {
    /* No Claude Code traces. */
  }
  for (const dir of dirs) {
    let latest = 0,
      size = 0;
    for (const name of ["events", "refs"])
      try {
        const info = statSync(join(dir, name));
        latest = Math.max(latest, info.mtimeMs);
        size += info.size;
      } catch {
        /* Missing trace. */
      }
    if (latest && (now - latest > 600_000 || size > TRACE_BOUND))
      for (const name of ["events", "refs"]) rmSync(join(dir, name), { force: true });
    // A Claude Code session quiet for a day has ended; its directory goes too.
    if (dir !== dirs[0] && now - (latest || statSync(dir).mtimeMs) > 86400_000)
      rmSync(dir, { recursive: true, force: true });
  }
}
