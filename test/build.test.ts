import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, releaseVersion, shim } from "../scripts/package.ts";

// What the installer leaves: the shim, the current code and a runtime link. Bun stands in
// for Kimchi's binary, which runs the code as Bun does when BUN_BE_BUN=1 is set.
async function installed(root: string, version: string) {
  const prefix = join(root, "prefix"),
    helper = join(root, "bin", "kimchi-bridge");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(join(root, "bin"));
  await buildBundle(version, join(prefix, "current.mjs"));
  symlinkSync(process.execPath, join(prefix, "runtime"));
  writeFileSync(helper, shim, { mode: 0o755 });
  return { prefix, helper };
}

test("packager only accepts the installer release formats", () => {
  for (const version of ["v0.1.0", "v0.1.0-rc.9"]) expect(releaseVersion(version)).toBe(version);
  for (const version of [
    "v0.1.0-beta.1",
    "v0.1.0+metadata",
    "v01.2.3",
    "v1.2.3 || >0",
    "v0.1.0-rc.-1",
  ])
    expect(() => releaseVersion(version)).toThrow();
});

test("the shim runs the code on Kimchi's runtime without the project's .env or bunfig.toml", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cost-shim-"));
  try {
    const project = join(root, "project"),
      home = join(root, "home"),
      state = join(root, "state"),
      redirect = join(root, "redirect"),
      canary = join(root, "preload-executed");
    mkdirSync(project);
    mkdirSync(home);
    writeFileSync(
      join(project, ".env"),
      `KIMCHI_BRIDGE_HOME=${redirect}\nKIMCHI_API_KEY=untrusted-project-key\n`,
    );
    writeFileSync(
      join(project, "preload.js"),
      `require('node:fs').writeFileSync(${JSON.stringify(canary)},'executed');\n`,
    );
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    const { prefix, helper } = await installed(root, "bundle-test");
    const run = (args: string[]) =>
      Bun.spawnSync([helper, ...args], {
        cwd: project,
        env: {
          HOME: home,
          PATH: process.env.PATH!,
          KIMCHI_BRIDGE_PREFIX: prefix,
          KIMCHI_BRIDGE_HOME: state,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    expect(run(["version"]).stdout.toString()).toBe("bundle-test\n");
    const result = run(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ledger: join(state, "accounts/local"),
      kimchiSignedIn: false,
    });
    expect(existsSync(redirect)).toBe(false);
    expect(existsSync(canary)).toBe(false);
    // Without Kimchi, hooks succeed silently: Codex shows hook output in the session, and a
    // real Codex run showed the hint after every hook. Hooks have no terminal.
    rmSync(join(prefix, "runtime"));
    const missing = run(["hook", "codex"]);
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout.toString()).toBe("");
    expect(missing.stderr.toString()).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("the shipped helper reports with Kimchi's sign-in and leaves Kimchi's settings unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cost-sign-in-"));
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
    const { prefix, helper } = await installed(root, "sign-in-test");
    const env = {
      HOME: home,
      PATH: process.env.PATH!,
      KIMCHI_BRIDGE_PREFIX: prefix,
      KIMCHI_BRIDGE_HOME: state,
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
