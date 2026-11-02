import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/work/git.ts";

test("the bridge's own Git ignores an inherited GIT_TRACE_REFS", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-")));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Lab");
    git(root, "config", "user.email", "lab@example.invalid");
    writeFileSync(join(root, "f"), "1\n");
    git(root, "add", "f");
    git(root, "commit", "-q", "-m", "init");
    const sha = git(root, "rev-parse", "HEAD");
    // Without the fix, `git branch <name> <sha>` fails under GIT_TRACE_REFS and creates the file.
    const trace = join(root, "refs-trace");
    process.env.GIT_TRACE_REFS = trace;
    git(root, "branch", "b", sha);
    expect(existsSync(trace)).toBe(false);
    expect(git(root, "rev-parse", "--verify", "refs/heads/b")).toBe(sha);
  } finally {
    delete process.env.GIT_TRACE_REFS;
    rmSync(root, { recursive: true, force: true });
  }
});
