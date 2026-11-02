// Tests must not depend on the developer's Git environment: trace variables the Kimchi harness or a
// shell may export would reach the bridge's own Git and the fixtures, and global or system Git
// configuration (such as an url.*.insteadOf rewrite) changes what a fixture's repository looks like.
for (const name of [
  "GIT_TRACE_REFS",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_ENV_VARS",
  "GIT_TRACE2",
  "GIT_TRACE2_PERF",
  "GIT_TRACE",
  "CODEX_TOOL_CALL_ID",
  "CLAUDE_CODE_TOOL_USE_ID",
])
  delete process.env[name];
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
