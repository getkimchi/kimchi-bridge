import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bearerToken,
  deleteCredential,
  storedSignIn,
  buildAuthorizeUrl,
  credentialPath,
  endpointsForCredential,
  ensureFresh,
  generateCodeChallenge,
  generateCodeVerifier,
  isInvalidGrant,
  listOrganizations,
  loadCredential,
  loginSSO,
  oauthEndpoints,
  refreshOAuth,
  saveCredential,
  seedFromKimchi,
  verifyActor,
  type OAuthCredential,
  type OAuthEndpoints,
} from "../src/oauth.ts";

const org = "22222222-2222-4222-8222-222222222222";
const org2 = "33333333-3333-4333-8333-333333333333";
const user = "11111111-1111-4111-8111-111111111111";

let root: string;
let previousRoot: string | undefined;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  previousRoot = process.env.KIMCHI_BRIDGE_HOME;
  root = mkdtempSync(join(tmpdir(), "kimchi-bridge-oauth-"));
  process.env.KIMCHI_BRIDGE_HOME = join(root, "state");
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.KIMCHI_BRIDGE_HOME;
  else process.env.KIMCHI_BRIDGE_HOME = previousRoot;
});
function server(handler: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => running.stop(true));
  return running.url.href.slice(0, -1);
}

/** Mock IdP: token endpoint with per-grant behavior the test controls. */
interface IdpMock {
  url: string;
  codesSeen: string[];
  refreshTokensSeen: string[];
  tokenResponse: (grant: string) => { status: number; body: unknown };
}
function idp(overrides: Partial<IdpMock> = {}): IdpMock {
  const mock: IdpMock = {
    url: "",
    codesSeen: [],
    refreshTokensSeen: [],
    tokenResponse: (grant) =>
      grant === "authorization_code"
        ? {
            status: 200,
            body: {
              access_token: "access-1",
              id_token: "id-1",
              refresh_token: "refresh-1",
              expires_in: 3600,
            },
          }
        : grant === "refresh_token"
          ? {
              status: 200,
              body: {
                access_token: "access-2",
                id_token: "id-2",
                refresh_token: "refresh-2",
                expires_in: 3600,
              },
            }
          : { status: 400, body: { error: "unsupported_grant_type" } },
    ...overrides,
  };
  mock.url = server(async (request) => {
    if (new URL(request.url).pathname.endsWith("/authorize"))
      return new Response(JSON.stringify({}), { status: 200 });
    const body = new URLSearchParams(await request.text());
    if (body.get("grant_type") === "authorization_code")
      mock.codesSeen.push(body.get("code") ?? "");
    if (body.get("grant_type") === "refresh_token")
      mock.refreshTokensSeen.push(body.get("refresh_token") ?? "");
    const response = mock.tokenResponse(body.get("grant_type") ?? "");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
  return mock;
}

function api(organizations = [{ id: org, name: "Primary" }]): string {
  return server((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/organizations") return Response.json({ organizations });
    if (path === "/v1/me")
      return Response.json({ id: user, username: "oauth-actor", name: "Actor" });
    return new Response("not found", { status: 404 });
  });
}

function endpoints(idpUrl: string, apiUrl: string): OAuthEndpoints {
  return {
    region: "us",
    authorizeUrl: `${idpUrl}/authorize`,
    tokenUrl: `${idpUrl}/oauth/token`,
    clientId: "test-client",
    audience: "https://app.kimchi.dev",
    castApiUrl: apiUrl,
    llmBaseUrl: "https://llm.kimchi.dev",
    useIdToken: true,
  };
}

/** Complete the browser leg: hit the redirect URI carried by the authorize URL. */
async function browserSignIn(url: string, code = "auth-code", extra: Record<string, string> = {}) {
  const authorize = new URL(url);
  const callback = new URL(authorize.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", authorize.searchParams.get("state")!);
  for (const [key, value] of Object.entries(extra)) callback.searchParams.set(key, value);
  return await fetch(callback);
}

const quiet = () => ({
  onMessage: (_: string) => {},
});

test("PKCE authorize URL carries S256 challenge, scope, audience and state", () => {
  const verifier = generateCodeVerifier();
  const url = buildAuthorizeUrl(
    {
      authorizeUrl: "https://login.kimchi.dev/authorize",
      clientId: "c",
      audience: "https://app.kimchi.dev",
    },
    {
      codeChallenge: generateCodeChallenge(verifier),
      state: "state-1",
      redirectUri: "http://localhost:8765/callback",
    },
  );
  const parsed = new URL(url);
  expect(parsed.pathname).toBe("/authorize");
  expect(parsed.searchParams.get("code_challenge")).toBe(generateCodeChallenge(verifier));
  expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  expect(parsed.searchParams.get("scope")).toBe("openid profile email offline_access");
  expect(parsed.searchParams.get("audience")).toBe("https://app.kimchi.dev");
  expect(parsed.searchParams.get("state")).toBe("state-1");
});

test("region metadata and env overrides resolve endpoints", () => {
  const us = oauthEndpoints("us", {});
  expect(us.tokenUrl).toBe("https://login.kimchi.dev/oauth/token");
  expect(us.llmBaseUrl).toBe("https://llm.kimchi.dev");
  expect(us.useIdToken).toBe(true);
  const overridden = oauthEndpoints("eu", {
    KIMCHI_OAUTH_TOKEN_URL: "http://127.0.0.1:9/token",
    KIMCHI_OAUTH_USE_ID_TOKEN: "0",
    KIMCHI_BASE_URL: "http://127.0.0.1:8",
  });
  expect(overridden.tokenUrl).toBe("http://127.0.0.1:9/token");
  expect(overridden.llmBaseUrl).toBe("http://127.0.0.1:8");
  expect(overridden.useIdToken).toBe(false);
  expect(() =>
    oauthEndpoints("us", { KIMCHI_OAUTH_TOKEN_URL: "http://example.com/token" }),
  ).toThrow("token URL requires HTTPS");
});

test("SSO login exchanges the code, verifies the actor, selects the single organization, and stores the credential", async () => {
  const provider = idp();
  const apiUrl = api();
  const result = await loginSSO("us", {
    ...quiet(),
    _endpoints: endpoints(provider.url, apiUrl),
    _callbackPort: 0,
    _timeoutMs: 4000,
    _open: async (url) => {
      const response = await browserSignIn(url);
      expect(response.status).toBe(200);
    },
  });
  expect(provider.codesSeen).toEqual(["auth-code"]);
  expect(result.organization).toEqual({ id: org, name: "Primary" });
  expect(result.actorId).toBe(user);
  const stored = loadCredential();
  expect(stored?.orgId).toBe(org);
  expect(stored?.actorUsername).toBe("oauth-actor");
  expect(bearerToken(stored!)).toBe("id-1");
  expect(stored?.refreshToken).toBe("refresh-1");
  expect(stored?.expires).toBeLessThanOrEqual(Date.now() + 3600_000);
  expect(stored?.expires).toBeGreaterThan(Date.now() + 3000_000);
});

test("multi-organization accounts without --org list the choices and store nothing", async () => {
  const provider = idp();
  const apiUrl = api([
    { id: org, name: "Primary" },
    { id: org2, name: "Second" },
  ]);
  await expect(
    loginSSO("us", {
      ...quiet(),
      _endpoints: endpoints(provider.url, apiUrl),
      _callbackPort: 0,
      _timeoutMs: 4000,
      _open: (url) => browserSignIn(url),
    }),
  ).rejects.toThrow("multiple organizations");
  expect(loadCredential()).toBeUndefined();
  await expect(
    loginSSO("us", {
      ...quiet(),
      org: "Second",
      _endpoints: endpoints(provider.url, apiUrl),
      _callbackPort: 0,
      _timeoutMs: 4000,
      _open: (url) => browserSignIn(url, "auth-code-2"),
    }),
  ).resolves.toMatchObject({ organization: { id: org2, name: "Second" } });
  expect(loadCredential()?.orgId).toBe(org2);
});

test("callback state mismatches and IdP error params are rejected without storing a credential", async () => {
  const provider = idp();
  const endpointsSet = endpoints(provider.url, api());
  await expect(
    loginSSO("us", {
      ...quiet(),
      _endpoints: endpointsSet,
      _callbackPort: 0,
      _timeoutMs: 4000,
      _open: async (url) => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "code");
        callback.searchParams.set("state", "not-the-state");
        await fetch(callback);
      },
    }),
  ).rejects.toThrow("state mismatch");
  expect(loadCredential()).toBeUndefined();
  await expect(
    loginSSO("us", {
      ...quiet(),
      _endpoints: endpointsSet,
      _callbackPort: 0,
      _timeoutMs: 4000,
      _open: (url) => browserSignIn(url, "", { error: "access_denied", error_description: "nope" }),
    }),
  ).rejects.toThrow("access_denied");
  expect(loadCredential()).toBeUndefined();
});

test("token endpoint errors map RFC 6749 codes", async () => {
  const provider = idp({
    tokenResponse: (grant) =>
      grant === "authorization_code"
        ? { status: 400, body: { error: "invalid_request", error_description: "missing verifier" } }
        : { status: 200, body: {} },
  });
  await expect(
    loginSSO("us", {
      ...quiet(),
      _endpoints: endpoints(provider.url, api()),
      _callbackPort: 0,
      _timeoutMs: 4000,
      _open: (url) => browserSignIn(url),
    }),
  ).rejects.toThrow("missing verifier");
});

test("refresh rotates the stored token and keeps the old one when the server omits it", async () => {
  const provider = idp();
  const base = await loginSSO("us", {
    ...quiet(),
    _endpoints: endpoints(provider.url, api()),
    _callbackPort: 0,
    _timeoutMs: 4000,
    _open: (url) => browserSignIn(url),
  });
  const rotated = await refreshOAuth(base.credential);
  expect(rotated.refreshToken).toBe("refresh-2");
  expect(bearerToken(rotated)).toBe("id-2");
  expect(rotated.orgId).toBe(org);

  const keepOld = idp({
    tokenResponse: (grant) =>
      grant === "refresh_token"
        ? { status: 200, body: { access_token: "access-3", id_token: "id-3", expires_in: 3600 } }
        : { status: 200, body: {} },
  });
  const kept = await refreshOAuth({ ...rotated, tokenUrl: `${keepOld.url}/oauth/token` });
  expect(kept.refreshToken).toBe("refresh-2");
});

test("invalid_grant marks the credential dead for re-login", async () => {
  const provider = idp({
    tokenResponse: (grant) =>
      grant === "refresh_token"
        ? { status: 400, body: { error: "invalid_grant" } }
        : {
            status: 200,
            body: {
              access_token: "access-1",
              id_token: "id-1",
              refresh_token: "refresh-1",
              expires_in: 3600,
            },
          },
  });
  const result = await loginSSO("us", {
    ...quiet(),
    _endpoints: endpoints(provider.url, api()),
    _callbackPort: 0,
    _timeoutMs: 4000,
    _open: (url) => browserSignIn(url),
  });
  const error = await refreshOAuth({ ...result.credential, expires: Date.now() - 1000 }).catch(
    (e) => e,
  );
  expect(isInvalidGrant(error)).toBe(true);
  expect((error as Error).message).toContain("invalid_grant");
});

test("ensureFresh refreshes a stale credential under the lock and keeps fresh ones untouched", async () => {
  const provider = idp();
  const result = await loginSSO("us", {
    ...quiet(),
    _endpoints: endpoints(provider.url, api()),
    _callbackPort: 0,
    _timeoutMs: 4000,
    _open: (url) => browserSignIn(url),
  });
  // Fresh: no refresh call.
  const fresh = await ensureFresh();
  expect(provider.refreshTokensSeen).toEqual([]);
  expect(bearerToken(fresh!)).toBe("id-1");
  // Stale on disk: one refresh, persisted, org and actor preserved.
  saveCredential({ ...result.credential, expires: Date.now() - 1000 });
  const renewed = await ensureFresh();
  expect(provider.refreshTokensSeen).toEqual(["refresh-1"]);
  expect(bearerToken(renewed)).toBe("id-2");
  expect(renewed.orgId).toBe(org);
  expect(loadCredential()?.refreshToken).toBe("refresh-2");
  await expect(ensureFresh(undefined, join(root, "missing"))).rejects.toThrow("no saved sign-in");
});

test("credential store round-trips and rejects malformed shapes", () => {
  expect(loadCredential()).toBeUndefined();
  const credential: OAuthCredential = {
    region: "eu",
    tokenUrl: "https://login.eu.kimchi.dev/oauth/token",
    clientId: "c",
    audience: "https://app.kimchi.dev",
    useIdToken: true,
    accessToken: "a",
    idToken: "i",
    refreshToken: "r",
    expires: Date.now() + 1000,
    orgId: org,
    orgName: "Org",
    actorId: user,
    actorUsername: "u",
  };
  saveCredential(credential);
  expect(loadCredential()).toEqual({ ...credential, orgId: org });
  writeFileSync(credentialPath(), "{not json");
  expect(() => loadCredential()).toThrow("stored sign-in is invalid");
});

test("seedFromKimchi maps the CLI credential shape and ignores non-OAuth entries", () => {
  const path = join(root, "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      "kimchi-dev": {
        type: "oauth",
        access: "bearer-choice",
        accessToken: "access",
        idToken: "id",
        refresh: "refresh",
        expires: Date.now() + 1000,
        region: "us",
        tokenUrl: "https://login.kimchi.dev/oauth/token",
        clientId: "c",
        audience: "https://app.kimchi.dev",
        useIdToken: true,
        orgId: org,
        orgName: "Org",
      },
    }),
  );
  const seed = seedFromKimchi(path);
  expect(seed?.refreshToken).toBe("refresh");
  expect(seed?.accessToken).toBe("access");
  expect(seed?.idToken).toBe("id");
  expect(seed?.orgId).toBe(org);
  expect(bearerToken(seed!)).toBe("id");
  writeFileSync(path, JSON.stringify({ "kimchi-dev": { type: "api_key", key: "k" } }));
  expect(seedFromKimchi(path)).toBeUndefined();
  expect(seedFromKimchi(join(root, "absent.json"))).toBeUndefined();
});

test("the stored credential surfaces as a Kimchi sign-in with its organization", () => {
  saveCredential({
    region: "us",
    tokenUrl: "https://login.kimchi.dev/oauth/token",
    clientId: "c",
    useIdToken: true,
    accessToken: "access",
    idToken: "id-token",
    refreshToken: "refresh",
    expires: Date.now() + 3600_000,
    orgId: org,
    orgName: "Org",
  });
  expect(storedSignIn()).toEqual({
    apiUrl: "https://api.cast.ai",
    token: "id-token",
    organizationId: org,
  });
  expect(storedSignIn({ KIMCHI_REMOTE_ENDPOINT: "http://127.0.0.1:9" })!.apiUrl).toBe(
    "http://127.0.0.1:9",
  );
  deleteCredential();
  expect(storedSignIn()).toBeNull();
});

test("organization listing and actor verification send the org routing header where due", async () => {
  const seen: Array<{ path: string; auth: string; org: string | null }> = [];
  const apiUrl = server((request) => {
    seen.push({
      path: new URL(request.url).pathname,
      auth: request.headers.get("authorization") ?? "",
      org: request.headers.get("x-castai-organization-id"),
    });
    const path = seen.at(-1)!.path;
    if (path === "/v1/organizations")
      return Response.json({ organizations: [{ id: org, name: "O" }] });
    if (path === "/v1/me") return Response.json({ id: user, username: "u" });
    return new Response("no", { status: 404 });
  });
  const organizations = await listOrganizations(apiUrl, "token-1");
  expect(organizations).toEqual([{ id: org, name: "O" }]);
  expect(seen[0]).toMatchObject({ auth: "Bearer token-1", org: null });
  const actor = await verifyActor(apiUrl, "token-1", org);
  expect(actor).toEqual({ id: user, username: "u" });
  expect(seen[1]).toMatchObject({ auth: "Bearer token-1", org });
  expect(endpointsForCredential({ region: "eu" }).castApiUrl).toBe("https://api.eu.cast.ai");
});
