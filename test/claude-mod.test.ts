import { expect, test } from "bun:test";

test("native mod caches its version and avoids helper calls for irrelevant telemetry", async () => {
  const { register } = await import(
    new URL("../plugins/kimchi-work/claude/hooks/register.js", import.meta.url).href
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  register((event: string, ...args: any[]) => handlers.set(event, args.at(-1)));
  let versionReads = 0;
  const calls: { args: string[]; input: Record<string, any> }[] = [];
  const api = {
    plugin: { root: "/plugin" },
    session: {
      id: async () => "session",
      cwd: async () => "/repo",
      version: async () => {
        versionReads++;
        return { version: "2.1.309" };
      },
    },
    process: {
      run: async (args: string[], options: { stdin: string }) => {
        calls.push({ args, input: JSON.parse(options.stdin) });
      },
    },
  };
  const next = (e: any) => e;
  const ignored = { event: "tool_result", attributes: {} };
  expect(await handlers.get("telemetry.log")!(api, ignored, next)).toBe(ignored);
  expect(calls).toHaveLength(0);
  expect(versionReads).toBe(0);
  for (const event of [{ event: "api_request" }, { attributes: { "event.name": "api_request" } }]) {
    expect(await handlers.get("telemetry.log")!(api, event, next)).toBe(event);
  }
  const prompt = { prompt_id: "prompt" };
  expect(await handlers.get("classic.UserPromptSubmit")!(api, prompt, next)).toBe(prompt);
  expect(calls).toHaveLength(3);
  expect(versionReads).toBe(1);
  expect(calls[0]!.args).toEqual(["/plugin/bin/kimchi-bridge", "hook", "claude-code"]);
  expect(calls.every((c) => c.input.version === "2.1.309")).toBe(true);
});
