import { CALL_VARIABLES } from "../src/work/commits.ts";
import { TRACE_VARIABLES } from "../src/work/git.ts";

// Tests must not depend on the developer's Git environment: trace variables the Kimchi harness or a
// shell may export would reach the bridge's own Git and the fixtures, and global or system Git
// configuration (such as an url.*.insteadOf rewrite) changes what a fixture's repository looks like.
for (const name of [...TRACE_VARIABLES, ...CALL_VARIABLES]) delete process.env[name];
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Bun.spawn and Bun.spawnSync without env still get the environment the runner started with, not
// this preloaded one; pass env: process.env. node:child_process sees these changes.
