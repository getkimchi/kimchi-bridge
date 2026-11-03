import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("native mod caches its version and avoids helper calls for irrelevant telemetry", async () => {
  const { register } = await import(
    new URL("../plugins/kimchi-work/claude/hooks/register.js", import.meta.url).href
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  register((event: string, ...args: any[]) => handlers.set(event, args.at(-1)));
  let versionReads = 0;
  const calls: { args: string[]; input: Record<string, any> }[] = [];
  const scheduled: number[] = [];
  const api = {
    clock: { after: (ms: number) => scheduled.push(ms) },
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
  const turn = { turnId: "turn" };
  expect(await handlers.get("turn.start")!(api, turn, next)).toBe(turn);
  expect(calls).toHaveLength(3);
  expect(versionReads).toBe(1);
  expect(calls[0]!.args).toEqual(["/plugin/bin/kimchi-bridge", "hook", "claude-code"]);
  expect(calls.every((c) => c.input.version === "2.1.309")).toBe(true);
  // Claude Code's built-in guard skips these in an installed mod; hooks.json's command hooks carry them.
  expect([...handlers.keys()].filter((name) => name.startsWith("classic."))).toEqual([]);
  await handlers.get("turn.complete")!(api, { agentId: "agent" }, next);
  expect(scheduled).toHaveLength(0);
  await handlers.get("turn.complete")!(api, {}, next);
  expect(scheduled).toEqual([0]);
});

test("hooks.json syncs the queue on the same events as Codex, so uploads do not depend on the mod loading", () => {
  const read = (agent: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../plugins/kimchi-work/${agent}/hooks/hooks.json`, import.meta.url),
        "utf8",
      ),
    ).hooks as Record<string, { hooks: { command: string; timeout: number; async?: boolean }[] }[]>;
  const syncs = (hooks: ReturnType<typeof read>) =>
    Object.entries(hooks)
      .filter(([, groups]) => groups.some((g) => g.hooks.some((h) => h.command.endsWith('" sync'))))
      .map(([name]) => name)
      .sort();
  const claude = read("claude");
  expect(syncs(claude)).toEqual(syncs(read("codex")));
  for (const name of syncs(claude)) {
    const handler = claude[name]!.flatMap((g) => g.hooks).find((h) =>
      h.command.endsWith('" sync'),
    )!;
    expect(handler.command).toBe('"${CLAUDE_PLUGIN_ROOT}/bin/kimchi-bridge" sync');
    // A background upload must never hold up the prompt or the end of the turn.
    expect(handler.async).toBe(true);
    expect(handler.timeout).toBe(10);
  }
});
