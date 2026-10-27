import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildHelper, ReleaseVersion } from "../scripts/package.ts";

test("packager only accepts the installer release formats", () => {
  for (const version of ["v0.1.0", "v0.1.0-rc.9"]) expect(ReleaseVersion(version)).toBe(version);
  for (const version of [
    "v0.1.0-beta.1",
    "v0.1.0+metadata",
    "v01.2.3",
    "v1.2.3 || >0",
    "v0.1.0-rc.-1",
  ])
    expect(() => ReleaseVersion(version)).toThrow();
});

test("compiled helper ignores project dotenv and bunfig configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cost-compiled-"));
  try {
    const project = join(root, "project"),
      home = join(root, "home"),
      state = join(root, "state"),
      redirect = join(root, "redirect");
    mkdirSync(project);
    mkdirSync(home);
    const helper = join(root, "helper"),
      canary = join(root, "preload-executed");
    writeFileSync(
      join(project, ".env"),
      `KIMCHI_ADAPTERS_HOME=${redirect}\nKIMCHI_API_KEY=untrusted-project-key\n`,
    );
    writeFileSync(
      join(project, "preload.js"),
      `require('node:fs').writeFileSync(${JSON.stringify(canary)},'executed');\n`,
    );
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    await BuildHelper("compiled-test", helper);
    const result = Bun.spawnSync([helper, "status"], {
      cwd: project,
      env: { HOME: home, PATH: process.env.PATH!, KIMCHI_ADAPTERS_HOME: state },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ledger: join(state, "accounts/local"),
      kimchiSignedIn: false,
    });
    expect(existsSync(redirect)).toBe(false);
    expect(existsSync(canary)).toBe(false);
    const withoutOverride = Bun.spawnSync([helper, "status"], {
      cwd: project,
      env: { HOME: home, PATH: process.env.PATH! },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(withoutOverride.exitCode).toBe(0);
    expect(JSON.parse(withoutOverride.stdout.toString()).ledger).toBe(
      join(home, ".local/state/kimchi-adapters/accounts/local"),
    );
    expect(existsSync(redirect)).toBe(false);
    expect(existsSync(canary)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("compiled helper reports with Kimchi's sign-in and leaves Kimchi's settings unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cost-sign-in-compiled-"));
  const key = "synthetic-key-not-a-credential";
  const user = "11111111-1111-4111-8111-111111111111";
  const org = "22222222-2222-4222-8222-222222222222";
  const requests: string[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      if (path.endsWith("api-keys:verify"))
        return Response.json({ organizationId: org, userId: user });
      const batch = JSON.parse(await request.text()).batch;
      return Response.json({
        batchId: batch.id,
        receipts: batch.events.map((e: { id: string; revision: string }) => ({
          id: e.id,
          revision: e.revision,
          status: "accepted",
        })),
      });
    },
  });
  try {
    const home = join(root, "home"),
      state = join(root, "state"),
      project = join(root, "project");
    mkdirSync(join(home, ".config", "kimchi"), { recursive: true });
    mkdirSync(project);
    const settings = join(home, ".config", "kimchi", "config.json"),
      original = JSON.stringify({ apiKey: key, llmEndpoint: "https://inference.invalid/keep" });
    writeFileSync(settings, original);
    const helper = join(root, "helper");
    await BuildHelper("sign-in-test", helper);
    const env = {
      HOME: home,
      PATH: process.env.PATH!,
      KIMCHI_ADAPTERS_HOME: state,
      KIMCHI_REMOTE_ENDPOINT: api.url.origin,
    };
    // Spawn asynchronously so this process keeps serving the fake API.
    const run = async (args: string[], input?: object) => {
      const child = Bun.spawn([helper, ...args], {
        cwd: project,
        env,
        stdin: input ? Buffer.from(JSON.stringify(input)) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      return new Response(child.stdout).text();
    };
    const event = { session_id: "session", turn_id: "turn", cwd: project };
    await run(["hook", "codex"], { ...event, hook_event_name: "SessionStart", source: "startup" });
    await run(["hook", "codex"], {
      ...event,
      hook_event_name: "UserPromptSubmit",
      prompt: "New work: x",
    });
    expect(await run(["flush"])).toBe("All pending records acknowledged.\n");
    expect(requests).toEqual([
      "/ai-optimizer/v1beta/api-keys:verify",
      `/ai-optimizer/v1beta/organizations/${org}/pr-cost-events:batchIngest`,
    ]);
    const status = JSON.parse(await run(["status"]));
    expect(status).toMatchObject({
      kimchiSignedIn: true,
      reportingVerified: true,
      organizationId: org,
    });
    expect(status.accounting.pending).toBe(0);
    expect(readFileSync(join(state, "config.json"), "utf8")).not.toContain(key);
    expect(readFileSync(settings, "utf8")).toBe(original);
  } finally {
    api.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
