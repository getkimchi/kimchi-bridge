import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkSignal, lockSync, remainingTime, safeRead, withDeadline } from "../src/platform.ts";
import {
  Recorder,
  filePaths,
  patchInput,
  referencedPaths,
  repository,
  type Scope,
} from "../src/work/capture.ts";
import { git } from "../src/work/git.ts";
import { Store } from "../src/work/ledger.ts";
import { digest, stableId } from "../src/work/protocol.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
function fixture(source = "codex") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pr-cost-capture-")));
  const root = join(base, "project"),
    state = join(base, "state");
  mkdirSync(root);
  const store = new Store(state),
    r = new Recorder(store, source, store.deviceId());
  cleanups.push(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, state, store, r };
}
function scope(root: string, session = "s", turn = "t", agent = ""): Scope {
  const [Root, Repo, Repository] = repository(root);
  return { Session: session, Turn: turn, Agent: agent, CWD: root, Root, Repo, Repository };
}
function prompt(r: Recorder, root: string, session: string, turn: string, text: string) {
  r.record({
    stage: "UserPromptSubmit",
    event: { session_id: session, turn_id: turn, cwd: root, prompt: text },
  });
}
function edit(root: string, path: string, call = "edit", old = "before", replacement = "after") {
  return {
    session_id: "s",
    turn_id: "t",
    cwd: root,
    tool_use_id: call,
    tool_name: "Edit",
    tool_input: { file_path: path, old_string: old, new_string: replacement },
  };
}
function events(store: Store, kind: string) {
  return (
    store.db.query("SELECT body FROM events WHERE kind=? ORDER BY rowid").all(kind) as {
      body: Uint8Array;
    }[]
  ).map((row) => JSON.parse(Buffer.from(row.body).toString()));
}

test("repository discovery preserves native Git roots and common identities for unusual paths", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pr-cost-repository-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const init = (name: string, bare = false) => {
    const path = join(base, name);
    mkdirSync(path);
    git(path, "init", ...(bare ? ["--bare"] : ["--initial-branch=main"]));
    return path;
  };
  const root = init("repo with spaces"),
    subdir = join(root, "sub directory");
  mkdirSync(subdir);
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, "file"), "fixture\n");
  git(root, "add", "file");
  git(root, "commit", "-m", "fixture");
  const linked = join(base, "linked worktree\nline"),
    linkedSubdir = join(linked, "sub directory");
  git(root, "worktree", "add", "--detach", linked);
  mkdirSync(linkedSubdir);
  const unborn = init("unborn\nrepository"),
    trailing = init("trailing newline\n");
  for (const cwd of [root, subdir, linked, linkedSubdir, unborn, trailing]) {
    const expectedRoot = git(cwd, "rev-parse", "--show-toplevel"),
      common = git(expectedRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(repository(cwd)).toEqual([expectedRoot, stableId("git-common-dir", common), undefined]);
  }
  expect(repository(linked)[1]).toBe(repository(root)[1]);
  const nonGit = join(base, "not a repository"),
    bare = init("bare repository", true);
  mkdirSync(nonGit);
  for (const cwd of [nonGit, bare])
    expect(repository(cwd)).toEqual([cwd, `local:${digest(cwd)}`, undefined]);
});

test("safeRead bounds regular files and rejects final, parent and escaping symlinks", () => {
  const { base, root } = fixture(),
    file = join(root, "file");
  writeFileSync(file, "allowed");
  writeFileSync(join(base, "secret"), "secret");
  symlinkSync(file, join(root, "same-root-link"));
  symlinkSync(join(base, "secret"), join(root, "secret-link"));
  symlinkSync(base, join(root, "parent-link"));
  expect(safeRead(root, file).bytes.toString()).toBe("allowed");
  expect(() => safeRead(root, file, 3)).toThrow();
  expect(() => safeRead(root, join(root, "same-root-link"))).toThrow();
  expect(() => safeRead(root, join(root, "secret-link"))).toThrow();
  expect(() => safeRead(root, join(root, "parent-link", "secret"))).toThrow();
  expect(() => safeRead(root, join(base, "secret"))).toThrow();
  expect(() => safeRead(root, root)).toThrow();
  try {
    safeRead(root, join(root, "missing"));
    throw new Error("missing accepted");
  } catch (error: any) {
    expect(error.code).toBe("ENOENT");
  }
});

test("platform defers libc binding until native work and caches the real library", () => {
  const { root, state } = fixture();
  const path = join(root, "file");
  writeFileSync(path, "allowed");
  const module = new URL("../src/platform.ts", import.meta.url).pathname;
  const script = `const ffi=require('bun:ffi');const original=ffi.dlopen;let opened=0;ffi.dlopen=(...args)=>{opened++;return original(...args)};const p=await import(${JSON.stringify(module)});p.checkSignal();p.remainingTime(undefined,1000);const afterImport=opened;const bytes=p.safeRead(${JSON.stringify(root)},${JSON.stringify(path)}).bytes.toString();const afterRead=opened;const guard=p.lockSync(${JSON.stringify(state)});if(!guard)throw Error('unexpected lock contention');guard.close();try{p.safeRead(${JSON.stringify(root)},'missing')}catch(error){if(error.code!=='ENOENT')throw error}process.stdout.write(JSON.stringify({afterImport,afterRead,afterLockAndError:opened,bytes}))`;
  const result = execFileSync(process.execPath, ["-e", script], { stdio: "pipe" });
  expect(JSON.parse(result.toString())).toEqual({
    afterImport: 0,
    afterRead: 1,
    afterLockAndError: 1,
    bytes: "allowed",
  });
});

test.skipIf(process.platform !== "darwin")(
  "compiled capture reads its allowed root without opening denied home ancestors",
  async () => {
    const base = mkdtempSync(join(homedir(), ".local", "state", "kimchi-ts-sandbox-"));
    try {
      const root = join(base, "project"),
        entry = join(base, "probe.ts"),
        executable = join(base, "probe");
      mkdirSync(root);
      writeFileSync(join(root, "file"), "allowed");
      const module = new URL("../src/platform.ts", import.meta.url).pathname;
      writeFileSync(
        entry,
        `import {safeRead} from ${JSON.stringify(module)};process.stdout.write(safeRead(process.argv[2],process.argv[3]).bytes)`,
      );
      const build = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        minify: true,
        compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
      });
      expect(build.success).toBe(true);
      const policy = `(version 1)(allow default)(deny file-read* file-write* (subpath ${JSON.stringify(homedir())}))(allow file-read* (subpath ${JSON.stringify(base)}))`;
      expect(
        execFileSync(
          "/usr/bin/sandbox-exec",
          ["-p", policy, executable, root, join(root, "file")],
          { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: base } },
        ).toString(),
      ).toBe("allowed");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("safeRead never follows a parent exchanged with an outside symlink", async () => {
  const { base, root } = fixture(),
    dir = join(root, "dir"),
    held = join(root, "held"),
    outside = join(base, "outside");
  mkdirSync(dir);
  mkdirSync(outside);
  writeFileSync(join(dir, "file"), "allowed");
  writeFileSync(join(outside, "file"), "secret");
  const script = `const f=require('node:fs');process.stdout.write('ready');for(let i=0;i<2000;i++){try{f.renameSync(${JSON.stringify(dir)},${JSON.stringify(held)});f.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(dir)});f.unlinkSync(${JSON.stringify(dir)});f.renameSync(${JSON.stringify(held)},${JSON.stringify(dir)})}catch{}}`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("error", reject);
  });
  try {
    for (let i = 0; i < 300; i++) {
      let bytes: Buffer;
      try {
        bytes = safeRead(root, join(dir, "file")).bytes;
      } catch {
        continue;
      }
      expect(bytes.toString()).toBe("allowed");
    }
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  }
});

test("kernel flock excludes a second process and releases when closed", () => {
  const { state } = fixture(),
    guard = lockSync(state);
  expect(guard).not.toBeNull();
  expect(lockSync(state)).toBeNull();
  const module = new URL("../src/platform.ts", import.meta.url).pathname;
  const script = `const {lockSync}=await import(${JSON.stringify(module)});const g=lockSync(${JSON.stringify(state)});if(g){g.close();process.exit(7)}`;
  expect(() => execFileSync(process.execPath, ["-e", script], { stdio: "pipe" })).not.toThrow();
  guard!.close();
  guard!.close();
  const next = lockSync(state);
  expect(next).not.toBeNull();
  next!.close();
});

test("wall clock deadlines survive a blocked event loop and inherit a parent budget", () => {
  const parent = withDeadline(10),
    child = withDeadline(1000, parent);
  expect(remainingTime(child, 1000)).toBeLessThanOrEqual(10);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  expect(() => checkSignal(child)).toThrow();
  expect(() => remainingTime(parent, 2000)).toThrow();
});

test("saved plan revisions continue across harnesses and ambiguity creates separate work", () => {
  const { root, store, r } = fixture(),
    plan = join(root, "plan with spaces.md");
  writeFileSync(plan, "implement authentication\n");
  prompt(r, root, "s", "t", "plan authentication");
  const original = r.work(scope(root)),
    other = new Recorder(store, "claude-code", r.device);
  r.registerPlan(root, plan, original, scope(root));
  other.record({
    stage: "turn.start",
    sessionId: "claude",
    cwd: root,
    event: { turnId: "new-turn", text: `implement @\`${plan}\`` },
  });
  expect(other.work(scope(root, "claude", "new-turn"))).toBe(original);
  writeFileSync(plan, "changed plan\n");
  prompt(r, root, "changed", "t", `implement \`${plan}\``);
  expect(r.work(scope(root, "changed"))).not.toBe(original);
  writeFileSync(plan, "implement authentication\n");
  r.registerPlan(root, plan, randomUUID(), scope(root));
  prompt(r, root, "ambiguous", "t", `implement \`${plan}\``);
  expect(r.work(scope(root, "ambiguous"))).not.toBe(original);
  expect(events(store, "work").at(-1).work.reason).toBe("ambiguous_plan_reference");
});

test("explicit new work exports its title and issue keys without the remaining prompt", () => {
  const { root, store, r } = fixture();
  prompt(r, root, "s", "t", "existing");
  const before = r.work(scope(root));
  prompt(
    r,
    root,
    "s",
    "next",
    "New work: WID-42 Refresh authentication\nprivate implementation details",
  );
  expect(r.work(scope(root, "s", "next"))).not.toBe(before);
  const body = events(store, "work").at(-1);
  expect(body.work.title).toBe("WID-42 Refresh authentication");
  expect(body.work.issueKeys).toEqual([{ key: "WID-42", source: "work" }]);
  expect(JSON.stringify(body).includes("private implementation")).toBe(false);
});

test("subagents inherit launch work after the parent changes tasks", () => {
  const { root, r } = fixture();
  prompt(r, root, "s", "t", "parent");
  const before = r.work(scope(root));
  r.record({
    stage: "SubagentStart",
    event: { session_id: "s", turn_id: "t", agent_id: "child", cwd: root },
  });
  prompt(r, root, "s", "next", "New work: other task");
  expect(r.work(scope(root, "s", "next"))).not.toBe(before);
  expect(r.work(scope(root, "s", "unseen-turn", "child"))).toBe(before);
});

test("two native processes racing the same turn keep one work ID and session default", async () => {
  const { base, root, state, store } = fixture(),
    start = join(base, "start"),
    s = scope(root, "race", "turn");
  const captureModule = new URL("../src/work/capture.ts", import.meta.url).pathname;
  const ledgerModule = new URL("../src/work/ledger.ts", import.meta.url).pathname;
  const children = [0, 1].map((index) => {
    const ready = join(base, `ready-${index}`);
    const script = `const f=require('node:fs');const{Recorder}=await import(${JSON.stringify(captureModule)});const{Store}=await import(${JSON.stringify(ledgerModule)});const store=new Store(${JSON.stringify(state)});const r=new Recorder(store,'codex',store.deviceId());const original=r.workExact.bind(r);let first=true;r.workExact=(s)=>{const work=original(s);if(first){first=false;f.writeFileSync(${JSON.stringify(ready)},'ready');const until=Date.now()+3000;while(!f.existsSync(${JSON.stringify(start)})){if(Date.now()>until)throw Error('barrier expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2)}}return work};try{r.bind(${JSON.stringify(s)},'New work: same turn')}finally{store.close()}`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (bytes) => {
      stderr += bytes.toString();
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)),
      );
    });
    return { child, ready, exited };
  });
  try {
    const until = Date.now() + 3000;
    while (!children.every((child) => existsSync(child.ready))) {
      if (Date.now() > until) throw new Error("native race setup expired");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    writeFileSync(start, "start");
    await Promise.all(children.map((child) => child.exited));
    const binding = store.db
      .query("SELECT work_id FROM bindings WHERE session_id='race'")
      .get() as { work_id: string };
    const current = store.db.query("SELECT value FROM meta WHERE key='codex:race:work'").get() as {
      value: string;
    };
    expect((store.db.query("SELECT count(*) AS n FROM work").get() as { n: number }).n).toBe(1);
    expect(current.value).toBe(binding.work_id);
    expect(events(store, "work")).toHaveLength(1);
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill("SIGKILL");
  }
});

test("before capture persists bytes before editing and replay cannot change the original evidence", () => {
  const { root, store, r } = fixture(),
    path = join(root, "file");
  writeFileSync(path, "before\n");
  prompt(r, root, "s", "t", "edit");
  const e = edit(root, path);
  r.record({ stage: "PreToolUse", event: e });
  expect(store.blob(digest("before\n")).toString()).toBe("before\n");
  const beforeBody = store.db.query("SELECT body FROM tool_state").get();
  writeFileSync(path, "after\n");
  r.record({ stage: "PreToolUse", event: e });
  expect(store.db.query("SELECT body FROM tool_state").get()).toEqual(beforeBody);
  r.record({ stage: "PostToolUse", event: e });
  const captured = events(store, "file");
  expect(captured).toHaveLength(1);
  expect(captured[0].file.quality).toBe("tool_observed");
  expect(store.blob(digest("after\n")).toString()).toBe("after\n");
  r.record({ stage: "PostToolUse", event: e });
  expect(events(store, "file")).toEqual(captured);
  expect(events(store, "tool")).toHaveLength(1);
});

test("Claude mod flat Read and Edit payloads retain their exact native file evidence", () => {
  const { root, store, r } = fixture("claude-code"),
    path = join(root, "file");
  writeFileSync(path, "before\n");
  const record = (stage: string, event: Record<string, unknown>, result = {}) =>
    r.record({ stage, sessionId: "s", cwd: root, event, result });
  record("turn.start", { turnId: "t", text: "edit the file" });
  const read = { tool: "Read", toolCallId: "read", file_path: path };
  record("tool.before", read);
  record("tool.after", read);
  const edit = {
    tool: "Edit",
    toolCallId: "edit",
    file_path: path,
    old_string: "before",
    new_string: "after",
  };
  record("tool.before", edit);
  writeFileSync(path, "after\n");
  record("tool.after", edit);
  const files = events(store, "file");
  expect(files).toHaveLength(2);
  expect(files[0].file.operation).toBe("read");
  expect(files[1].file.quality).toBe("tool_observed");
  expect(store.blob(digest("before\n")).toString()).toBe("before\n");
  expect(store.blob(digest("after\n")).toString()).toBe("after\n");
});

test("concurrent edits retain observed transitions without claiming the native edit", () => {
  const { root, store, r } = fixture(),
    path = join(root, "file");
  writeFileSync(path, "before\n");
  prompt(r, root, "s", "t", "edit");
  const e = edit(root, path);
  r.record({ stage: "PreToolUse", event: e });
  writeFileSync(path, "human\n");
  r.record({ stage: "PostToolUse", event: e });
  expect(events(store, "file")[0].file.quality).toBe("observed");
  expect(store.db.query("SELECT key FROM meta WHERE key LIKE 'git-change:%'").all()).toHaveLength(
    0,
  );
});

test("failed native tools and missing preimages remain unconfirmed", () => {
  const { root, store, r } = fixture(),
    path = join(root, "file");
  writeFileSync(path, "before\n");
  prompt(r, root, "s", "t", "edit");
  const e = edit(root, path);
  r.record({ stage: "PostToolUse", event: e });
  expect(events(store, "tool")).toHaveLength(0);
  r.record({ stage: "PreToolUse", event: e });
  writeFileSync(path, "after\n");
  r.record({ stage: "PostToolUseFailure", event: e });
  expect(events(store, "tool")[0].tool.outcome).toBe("failed");
  expect(events(store, "file")[0].file.quality).toBe("observed");
});

test("native writes register real plans and reads retain their observed revision", () => {
  const { root, store, r } = fixture(),
    path = join(root, "plans", "task.md");
  mkdirSync(join(root, "plans"));
  prompt(r, root, "s", "t", "plan");
  const write = {
    session_id: "s",
    turn_id: "t",
    cwd: root,
    tool_use_id: "write",
    tool_name: "Write",
    tool_input: { file_path: path, content: "plan\n" },
  };
  r.record({ stage: "PreToolUse", event: write });
  writeFileSync(path, "plan\n");
  r.record({ stage: "PostToolUse", event: write });
  expect(store.db.query("SELECT hash FROM plans").all()).toEqual([{ hash: digest("plan\n") }]);
  const read = {
    ...write,
    tool_use_id: "read",
    tool_name: "Read",
    tool_input: { file_path: path },
  };
  r.record({ stage: "PreToolUse", event: read });
  r.record({ stage: "PostToolUse", event: read });
  expect(events(store, "file").at(-1).file.operation).toBe("read");
});

test("file aliases work without allowing symlink contents or tracker self-capture", () => {
  const { base, root, store, r } = fixture(),
    path = join(root, "file");
  writeFileSync(path, "before\n");
  writeFileSync(join(base, "secret"), "secret");
  symlinkSync(join(base, "secret"), join(root, "secret"));
  prompt(r, root, "s", "t", "read");
  const e = { ...edit(root, join(root, "secret")), tool_name: "Read" };
  r.record({ stage: "PreToolUse", event: e });
  r.record({ stage: "PostToolUse", event: e });
  expect(events(store, "file")).toHaveLength(0);
  expect(() => store.blob(digest("secret"))).toThrow();
  const [paths] = filePaths(scope(root), edit(root, join(root, ".git", "config")));
  expect(paths).toHaveLength(0);
  const aliasRoot = root.startsWith("/private/var/") ? root.slice("/private".length) : root;
  const native = edit(aliasRoot, join(aliasRoot, "file"), "alias-edit");
  r.record({ stage: "PreToolUse", event: native });
  writeFileSync(path, "after\n");
  r.record({ stage: "PostToolUse", event: native });
  expect(events(store, "file")).toHaveLength(1);
  expect(events(store, "file")[0].file.quality).toBe("tool_observed");
});

test("tracker state inside a checkout never becomes captured implementation evidence", () => {
  const { root, r } = fixture(),
    nested = new Store(join(root, ".tracker"));
  try {
    r.store = nested;
    const path = join(nested.dir, "config.json");
    writeFileSync(path, "before\n");
    prompt(r, root, "s", "t", "edit");
    const e = edit(root, path);
    r.record({ stage: "PreToolUse", event: e });
    writeFileSync(path, "after\n");
    r.record({ stage: "PostToolUse", event: e });
    expect(events(nested, "file")).toHaveLength(0);
    expect(nested.db.query("SELECT hash FROM blobs").all()).toHaveLength(0);
  } finally {
    nested.close();
  }
});

test("exact patches preserve native attribution while fuzzy or moved files stay observed", () => {
  const { root, r } = fixture(),
    path = join(root, "file");
  const before = { hash: r.store.putBlob(Buffer.from("before\n")), exists: true, complete: true };
  const patch = {
    tool_name: "apply_patch",
    tool_input: "*** Begin Patch\n*** Update File: file\n@@\n-before\n+after\n*** End Patch",
  };
  expect(r.expected(before, patch, root, path)).toBe(digest("after\n"));
  expect(
    r.expected(
      before,
      {
        ...patch,
        tool_input:
          "*** Begin Patch\n*** Update File: file\n*** Move to: other\n@@\n-before\n+after\n*** End Patch",
      },
      root,
      path,
    ),
  ).toBeUndefined();
  const repeated = {
    hash: r.store.putBlob(Buffer.from("before\nbefore\n")),
    exists: true,
    complete: true,
  };
  expect(r.expected(repeated, patch, root, path)).toBeUndefined();
});

test("SDK patches cover add, delete, multiple hunks and reject whitespace fuzz", () => {
  const { root, r } = fixture(),
    path = join(root, "file");
  const absent = { hash: "", exists: false, complete: true };
  const added = {
    tool_name: "apply_patch",
    tool_input: "*** Begin Patch\n*** Add File: file\n+first\n+second\n*** End Patch",
  };
  expect(r.expected(absent, added, root, path)).toBe(digest("first\nsecond\n"));
  const before = {
    hash: r.store.putBlob(Buffer.from("alpha\nbefore\nmiddle\nlater\nomega\n")),
    exists: true,
    complete: true,
  };
  const patch = {
    tool_name: "apply_patch",
    tool_input:
      "*** Begin Patch\n*** Update File: file\n@@\n-before\n+after\n@@\n-later\n+done\n*** End Patch",
  };
  expect(r.expected(before, patch, root, path)).toBe(digest("alpha\nafter\nmiddle\ndone\nomega\n"));
  const fuzzy = {
    hash: r.store.putBlob(Buffer.from("  before  \n")),
    exists: true,
    complete: true,
  };
  expect(
    r.expected(
      fuzzy,
      {
        ...patch,
        tool_input: "*** Begin Patch\n*** Update File: file\n@@\n-before\n+after\n*** End Patch",
      },
      root,
      path,
    ),
  ).toBeUndefined();
  expect(
    r.expected(
      before,
      { ...patch, tool_input: "*** Begin Patch\n*** Delete File: file\n*** End Patch" },
      root,
      path,
    ),
  ).toBe("");
  const anchored = {
    tool_name: "apply_patch",
    tool_input: "*** Begin Patch\n*** Update File: file\n@@ anchor\n-before\n+after\n*** End Patch",
  };
  const skipped = {
    hash: r.store.putBlob(Buffer.from("before\nanchor\n before \n")),
    exists: true,
    complete: true,
  };
  expect(r.expected(skipped, anchored, root, path)).toBeUndefined();
  const exact = {
    hash: r.store.putBlob(Buffer.from("anchor\nbefore\n")),
    exists: true,
    complete: true,
  };
  expect(r.expected(exact, anchored, root, path)).toBe(digest("anchor\nafter\n"));
});

test("maintained Markdown and shell parsers recognize references without variable expansion", () => {
  const { root } = fixture(),
    path = join(root, "plan with spaces.md");
  writeFileSync(path, "plan");
  for (const text of [
    "implement `plan with spaces.md`",
    'implement @"plan with spaces.md"',
    "don't forget [the plan](<plan with spaces.md>)",
  ]) {
    expect(referencedPaths(text, root)).toContain(path);
  }
  expect(referencedPaths("implement $HOME/plan with spaces.md", root)).toHaveLength(0);
  const content = "*** Begin Patch\n*** Add File: file\n+literal $HOME\n*** End Patch";
  expect(patchInput({ tool_input: { cmd: `apply_patch '${content}'` } })).toBe(content);
  expect(patchInput({ tool_input: { cmd: `apply_patch '${content}'; echo side-effect` } })).toBe(
    "",
  );
});
