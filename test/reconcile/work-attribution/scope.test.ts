import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { fakeClock } from "../clock.js";
import type { HostPorts } from "../../../src/reconcile/host.js";
import { setDefaultHostPorts } from "../../../src/reconcile/host-ports.js";
import {
  captureWorkAccount,
  sameWorkAccount,
  workRepository,
} from "../../../src/reconcile/work-attribution/scope.js";

const ORG = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";
const OTHER_USER = "50000000-0000-4000-8000-000000000005";
const ENDPOINT = "https://account.example/api";
let root: string;
let key: string;

/**
 * The vitest suite spied on Kimchi's config, api/organizations and fake timers.
 * In the bridge those seams are HostPorts: credentials/endpoints answer what
 * loadConfig + resolveGatewayCredentials + resolveEndpoints answered, and the
 * verify call is observable through the host's fetch (the vendored
 * api-keys:verify client posts the bearer and the SSO routing header there).
 */
type VerifyCall = { url: string; token: string; organizationId?: string };
const verifyCalls: VerifyCall[] = [];
const verifyResponses: (Response | Error)[] = [];
function verifyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const organizationId = headers.get("X-CastAi-Organization-Id") ?? undefined;
  verifyCalls.push({
    url,
    token: headers.get("Authorization")?.slice("Bearer ".length) ?? "",
    organizationId,
  });
  const next = verifyResponses.shift();
  if (next instanceof Error) return Promise.reject(next);
  if (next) return Promise.resolve(next);
  // No test reaches the network: an unexpected check fails like an offline one.
  return Promise.reject(new Error("offline"));
}

function verifyResponse(organizationId: string, userId?: string): Response {
  return new Response(JSON.stringify({ organizationId, ...(userId ? { userId } : {}) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const host: HostPorts = {
  get agentDir() {
    return process.env.KIMCHI_CODING_AGENT_DIR ?? root;
  },
  e2eSeam: () => undefined,
  now: () => Date.now(),
  credentials(cwd) {
    // The startup mock configures an API key; an SSO user's config key is
    // empty and the credential comes from auth.json instead.
    if (key) return { token: key, apiUrl: ENDPOINT };
    try {
      const auth = JSON.parse(readFileSync(join(host.agentDir, "auth.json"), "utf8")) as {
        "kimchi-dev"?: { type?: string; access?: string; orgId?: string };
      };
      const credential = auth["kimchi-dev"];
      if (credential?.type === "oauth" && credential.access)
        return { token: credential.access, organizationId: credential.orgId, apiUrl: ENDPOINT };
    } catch {
      // no auth.json: no credential
    }
    return { token: "", apiUrl: ENDPOINT };
  },
  endpoints: () => ({
    llmEndpoint: "https://llm.example",
    openAiBaseUrl: "https://llm.example/openai/v1",
    anthropicBaseUrl: "https://llm.example/anthropic",
    experimentalOpenAiBaseUrl: "https://llm.example/experimental/openai/v1",
    platformApiUrl: ENDPOINT,
  }),
  orgPolicy: () => ({ resourceEnabled: () => true }),
  telemetryConsent: () => false,
  metric: () => {},
  fetch: verifyFetch,
};

let restoreClock = fakeClock("2026-10-07T12:00:00Z");
/** The vitest suite advanced fake timers; the bridge suite advances the faked clock. */
function advance(ms: number): void {
  const at = new Date(Date.now() + ms).toISOString();
  restoreClock();
  restoreClock = fakeClock(at);
}

beforeEach(() => {
  restoreClock();
  restoreClock = fakeClock("2026-10-07T12:00:00Z");
  root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-work-scope-cache-")));
  key = randomUUID();
  verifyCalls.length = 0;
  verifyResponses.length = 0;
  setDefaultHostPorts(host);
});
afterEach(() => {
  setDefaultHostPorts(undefined);
  restoreClock();
  rmSync(root, { recursive: true, force: true });
});

function verifyCallsOf(token: string): VerifyCall[] {
  return verifyCalls.filter((call) => call.token === token);
}

it("asks Git once per working folder for a while", async () => {
  const cwd = join(root, "repo");
  execFileSync("git", ["init", "-q", cwd]);
  const repository = await workRepository(cwd);
  rmSync(join(cwd, ".git"), { recursive: true, force: true });
  // Within the window the folder keeps its repository without another Git process.
  expect(await workRepository(cwd)).toBe(repository);
  advance(30_050);
  await expect(workRepository(cwd)).rejects.toThrow();
});

it("matches accounts captured with the legacy console platform API base", async () => {
  // Before platformApiUrl moved to the region's API origin, accounts captured
  // webAppUrl + "/api" as their base. Comparisons must keep matching those
  // stored accounts against the freshly derived base, in both the upgrade and
  // rollback direction.
  expect(
    sameWorkAccount(
      { apiUrl: "https://app.kimchi.dev/api", organizationId: ORG, userId: USER },
      { apiUrl: "https://api.cast.ai", organizationId: ORG, userId: USER },
    ),
  ).toBe(true);
  expect(
    sameWorkAccount(
      { apiUrl: "https://app.eu.kimchi.dev/api", organizationId: ORG, userId: USER },
      { apiUrl: "https://api.eu.cast.ai", organizationId: ORG, userId: USER },
    ),
  ).toBe(true);
  // A legacy base never matches another region's API origin.
  expect(
    sameWorkAccount(
      { apiUrl: "https://app.kimchi.dev/api", organizationId: ORG, userId: USER },
      { apiUrl: "https://api.eu.cast.ai", organizationId: ORG, userId: USER },
    ),
  ).toBe(false);
});

it("resolves the account from an SSO login (auth.json) and routes verify by its organization", async () => {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: ORG },
    }),
  );
  process.env.KIMCHI_CODING_AGENT_DIR = agentDir;
  // An SSO user's config key is empty; the credential comes from auth.json.
  key = "";
  verifyResponses.push(verifyResponse(ORG, USER));

  expect((await captureWorkAccount(root))?.account).toMatchObject({
    apiUrl: ENDPOINT,
    organizationId: ORG,
    userId: USER,
  });
  const call = verifyCallsOf("oauth-access").at(-1);
  expect(call).toMatchObject({ organizationId: ORG });
  expect(call?.url).toBe(`${ENDPOINT}/ai-optimizer/v1beta/api-keys:verify`);
  delete process.env.KIMCHI_CODING_AGENT_DIR;
});

it("keeps answering with the verified identity while a refresh runs after a minute", async () => {
  verifyResponses.push(verifyResponse(ORG, USER));
  expect((await captureWorkAccount(root))?.account.userId).toBe(USER);
  advance(60_050);
  verifyResponses.push(
    new Promise<Response>((resolve) =>
      setTimeout(() => resolve(verifyResponse(ORG, OTHER_USER)), 50),
    ) as unknown as Response,
  );
  // The expired identity answers at once; the refresh runs in the background.
  expect((await captureWorkAccount(root))?.account.userId).toBe(USER);
  expect(verifyCallsOf(key)).toHaveLength(2);
  for (
    let attempt = 0;
    attempt < 100 && (await captureWorkAccount(root))?.account.userId !== OTHER_USER;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await captureWorkAccount(root))?.account.userId).toBe(OTHER_USER);
  expect(verifyCallsOf(key)).toHaveLength(2);
});

it("forgets the identity when its refresh fails", async () => {
  verifyResponses.push(verifyResponse(ORG, USER));
  expect((await captureWorkAccount(root))?.account.userId).toBe(USER);
  advance(60_050);
  verifyResponses.push(new Error("key revoked"));
  expect((await captureWorkAccount(root))?.account.userId).toBe(USER);
  let account: Awaited<ReturnType<typeof captureWorkAccount>> = { account: undefined } as never;
  for (let attempt = 0; attempt < 100; attempt++) {
    account = await captureWorkAccount(root);
    if (account === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(account).toBeUndefined();
  expect(verifyCallsOf(key)).toHaveLength(3);
});

it("never answers another key with a verified identity", async () => {
  verifyResponses.push(verifyResponse(ORG, USER), verifyResponse(ORG, OTHER_USER));
  expect((await captureWorkAccount(root))?.account.userId).toBe(USER);
  key = randomUUID();
  expect((await captureWorkAccount(root))?.account.userId).toBe(OTHER_USER);
  const last = verifyCalls.at(-1);
  expect(last?.token).toBe(key);
  expect(last?.url).toBe(`${ENDPOINT}/ai-optimizer/v1beta/api-keys:verify`);
});
