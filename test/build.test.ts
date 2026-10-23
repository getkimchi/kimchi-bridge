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
    expect(JSON.parse(result.stdout.toString()).ledger).toBe(join(state, "accounts/local"));
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

test("compiled standalone login completes the browser callback without changing inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cost-login-compiled-"));
  const key = "synthetic-key-not-a-credential";
  const user = "11111111-1111-4111-8111-111111111111";
  const org = "22222222-2222-4222-8222-222222222222";
  const requests: string[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      return Response.json(
        new URL(request.url).pathname.endsWith("api-keys:verify")
          ? { organizationId: org, userId: user }
          : { id: user, username: "fixture" },
      );
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const home = join(root, "home"),
      state = join(root, "state"),
      project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    const inference = join(project, "provider-settings.json"),
      original = '{"baseUrl":"https://woven-gateway.invalid"}\n';
    writeFileSync(inference, original);
    const helper = join(root, "helper");
    await BuildHelper("login-test", helper);
    child = Bun.spawn([helper, "login", "--no-browser"], {
      cwd: project,
      env: {
        HOME: home,
        PATH: process.env.PATH!,
        KIMCHI_ADAPTERS_HOME: state,
        KIMCHI_WEB_APP_URL: api.url.origin,
        KIMCHI_REMOTE_ENDPOINT: api.url.origin,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(5000),
    });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let output = "";
    while (!output.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("login exited before opening its callback");
      output += Buffer.from(next.value).toString();
    }
    const launch = new URL(output.split("\n")[0]!.slice("Kimchi login: ".length));
    expect(launch.pathname).toBe("/cli-auth");
    const callback = new URL(launch.searchParams.get("callback")!);
    callback.searchParams.set("state", launch.searchParams.get("state")!);
    callback.searchParams.set("token", key);
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    await response.text();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      output += Buffer.from(next.value).toString();
    }
    expect(await child.exited).toBe(0);
    const error = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
    expect(error).toBe("");
    expect(output).not.toContain(key);
    const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
    expect(config.apiKey).toBe(key);
    expect(config.actorId).toBe(user);
    expect(config.organizationId).toBe(org);
    expect(requests).toEqual(["/ai-optimizer/v1beta/api-keys:verify", "/v1/me"]);
    expect(readFileSync(inference, "utf8")).toBe(original);
  } finally {
    child?.kill();
    api.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
