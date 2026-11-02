import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/work/git.ts";

test("the bridge's own Git ignores an inherited GIT_TRACE_REFS and GIT_TRACE2_EVENT", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-")));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Lab");
    git(root, "config", "user.email", "lab@example.invalid");
    writeFileSync(join(root, "f"), "1\n");
    git(root, "add", "f");
    git(root, "commit", "-q", "-m", "init");
    const sha = git(root, "rev-parse", "HEAD");
    // Without the scrub, `git branch <name> <sha>` fails under GIT_TRACE_REFS (Git 2.50.1, 2.54.0)
    // and both files are written: GIT_TRACE2_EVENT is the variable that writes into an agent's trace.
    const refs = join(root, "refs-trace"),
      events = join(root, "events-trace");
    Object.assign(process.env, { GIT_TRACE_REFS: refs, GIT_TRACE2_EVENT: events });
    git(root, "branch", "b", sha);
    expect([existsSync(refs), existsSync(events)]).toEqual([false, false]);
    expect(git(root, "rev-parse", "--verify", "refs/heads/b")).toBe(sha);
  } finally {
    delete process.env.GIT_TRACE_REFS;
    delete process.env.GIT_TRACE2_EVENT;
    rmSync(root, { recursive: true, force: true });
  }
});
