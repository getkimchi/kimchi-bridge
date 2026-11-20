import { expect, test } from "bun:test";
import { inspectRequest, requestModel } from "../src/request-body.ts";
import { planProxyAuth } from "../src/proxy-auth.ts";
import { CODEX_ORDINARY_ROUTE, CODEX_SUBSCRIPTION_ROUTE } from "../src/codex.ts";

const responses = "http://127.0.0.1:8766/openai/v1/responses";
const apiKey = { apiUrl: "https://api.cast.ai", token: "castai_v1_key" };
const subscription = () => CODEX_SUBSCRIPTION_ROUTE;
const ordinary = () => CODEX_ORDINARY_ROUTE;

function subscriptionRequest(headers: Record<string, string> = {}) {
  return new Request(responses, { method: "POST", headers, body: "{}" });
}

test("planProxyAuth rejects a request with no sign-in at all", () => {
  const plan = planProxyAuth({
    request: subscriptionRequest(),
    pathname: "/openai/v1/responses",
    model: "gpt-6.1-sol",
    routeFor: subscription,
  });
  expect(plan.kind).toBe("unauthenticated");
});

test("planProxyAuth gives an ordinary model the saved Kimchi key alone", async () => {
  const plan = planProxyAuth({
    request: subscriptionRequest({ authorization: "Bearer header.payload.signature" }),
    pathname: "/openai/v1/responses",
    model: "deepseek-v4",
    routeFor: ordinary,
    signIn: apiKey,
  });
  expect(plan.kind).toBe("authenticated");
  if (plan.kind !== "authenticated") return;
  expect(plan.subscription).toBe(false);
  expect(await plan.headers()).toEqual({ Authorization: "Bearer castai_v1_key" });
});

test("planProxyAuth keeps the ChatGPT login and adds the Kimchi key for a subscription", async () => {
  const plan = planProxyAuth({
    request: subscriptionRequest({
      authorization: "Bearer header.payload.signature",
      "x-api-key": "client-placeholder",
    }),
    pathname: "/openai/v1/responses",
    model: "gpt-6.1-sol",
    routeFor: subscription,
    signIn: apiKey,
  });
  expect(plan.kind).toBe("authenticated");
  if (plan.kind !== "authenticated") return;
  expect(plan.subscription).toBe(true);
  expect(await plan.headers()).toEqual({
    Authorization: "Bearer header.payload.signature",
    "X-API-Key": "castai_v1_key",
  });
});

test("planProxyAuth refuses a subscription without a ChatGPT login or a usable Kimchi key", () => {
  const noLogin = planProxyAuth({
    request: subscriptionRequest({ authorization: "Bearer kimchi-gateway" }),
    pathname: "/openai/v1/responses",
    model: "gpt-6.1-sol",
    routeFor: subscription,
    signIn: apiKey,
  });
  expect(noLogin.kind).toBe("missing-subscription-credentials");
  const ssoWithoutOrg = planProxyAuth({
    request: subscriptionRequest({ authorization: "Bearer header.payload.signature" }),
    pathname: "/openai/v1/responses",
    model: "gpt-6.1-sol",
    routeFor: subscription,
    credential: {
      region: "us",
      tokenUrl: "https://login.kimchi.dev/oauth/token",
      clientId: "c",
      useIdToken: true,
      accessToken: "access",
      idToken: "id-token",
      refreshToken: "refresh",
      expires: Date.now() + 3600_000,
      orgId: "",
      orgName: "",
    },
  });
  expect(ssoWithoutOrg.kind).toBe("missing-subscription-credentials");
});

test("planProxyAuth treats a subscription model on another path as an ordinary call", async () => {
  const plan = planProxyAuth({
    request: new Request("http://127.0.0.1:8766/anthropic/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer header.payload.signature" },
      body: "{}",
    }),
    pathname: "/anthropic/v1/messages",
    model: "gpt-6.1-sol",
    routeFor: subscription,
    signIn: apiKey,
  });
  expect(plan.kind).toBe("authenticated");
  if (plan.kind !== "authenticated") return;
  expect(plan.subscription).toBe(false);
  expect(await plan.headers()).toEqual({ Authorization: "Bearer castai_v1_key" });
});

test("inspectRequest parses only when asked and never alters the forwarded bytes", async () => {
  const plain = new TextEncoder().encode(JSON.stringify({ model: "m", input: "hi" })).buffer;
  const parsed = await inspectRequest(
    new Request(responses, { method: "POST", body: plain }),
    true,
  );
  expect(requestModel(parsed.json)).toBe("m");
  expect(Buffer.from(parsed.body!)).toEqual(Buffer.from(plain));

  const skipped = await inspectRequest(
    new Request(responses, { method: "POST", body: plain }),
    false,
  );
  expect(skipped.json).toBeUndefined();
  expect(Buffer.from(skipped.body!)).toEqual(Buffer.from(plain));

  const compressed = Buffer.from(await Bun.zstdCompress(Buffer.from(plain)));
  const zstd = await inspectRequest(
    new Request(responses, {
      method: "POST",
      headers: { "content-encoding": "zstd" },
      body: compressed,
    }),
    true,
  );
  expect(requestModel(zstd.json)).toBe("m");
  expect(Buffer.from(zstd.body!)).toEqual(compressed);

  const read = await inspectRequest(new Request(responses, { method: "GET" }), true);
  expect(read).toEqual({ body: undefined });
});
