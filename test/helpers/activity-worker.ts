import { ActivityStore } from "../../src/work/activity-store.ts";

const dir = process.argv[2];
if (!dir) throw new Error("activity worker state is required");
const store = new ActivityStore(dir, { databaseBytes: 8 << 20 });
try {
  for (let index = 0; index < 3; index++) {
    const event = {
      session_id: "concurrency-review",
      cwd: "/workspace/repo",
      tool_use_id: `concurrent-call-${index}`,
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    };
    store.observe({ stage: "PreToolUse", event, version: "2.1.326" }, "claude-code", {
      includeSensitive: true,
    });
    store.observe(
      {
        stage: "PostToolUse",
        event: {
          ...event,
          tool_response: { stdout: "/workspace/repo", stderr: "" },
          duration_ms: 5,
        },
      },
      "claude-code",
      { includeSensitive: true },
    );
  }
  console.log(JSON.stringify(store.status()));
} finally {
  store.close();
}
