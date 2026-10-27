import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Authenticate,
  CredentialHash,
  Flush,
  FlushOTLP,
  Ready,
  ValidateConfig,
  type Config,
  type SignIn,
} from "../src/delivery.ts";
import { Open, type Store } from "../src/ledger.ts";
import { Hash, NewID, Parse, type Batch, type Event } from "../src/protocol.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function store(): Store {
  const path = mkdtempSync(join(tmpdir(), "kimchi-delivery-"));
  const s = Open(path);
  cleanups.push(() => {
    s.Close();
    rmSync(path, { recursive: true, force: true });
  });
  return s;
}
function event(): Event {
  return {
    id: NewID(),
    entityId: NewID(),
    revision: "1",
    source: "codex",
    sourceVersion: "test",
    deviceId: NewID(),
    observeTime: "2026-10-23T12:30:45.123456789Z",
    coverage: { code: "fixture", count: "1" },
  };
}
function server(handler: (request: Request) => Response | Promise<Response>): string {
  const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => running.stop(true));
  return running.url.href.slice(0, -1);
}
// A verified account and the Kimchi sign-in it was verified with.
function configured(apiUrl: string): [Config, SignIn] {
  const k = { apiUrl, token: "synthetic-kimchi-key" };
  return [
    { apiUrl, organizationId: NewID(), actorId: NewID(), credentialHash: CredentialHash(k) },
    k,
  ];
}
function acknowledgement(batch: Batch) {
  return Response.json({
    batchId: batch.id,
    receipts: batch.events.map((e) => ({ id: e.id, revision: e.revision, status: "accepted" })),
  });
}

test("a Kimchi API key or SSO login verifies like Kimchi's uploader and keeps only stable identity", async () => {
  for (const sso of [false, true]) {
    const actor = NewID(),
      org = NewID(),
      calls: string[] = [];
    const apiUrl = server((req) => {
      expect(req.headers.get("authorization")).toBe("Bearer synthetic-kimchi-token");
      expect(req.headers.get("x-castai-organization-id")).toBe(sso ? org : null);
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({
        organizationId: org,
        userId: actor,
        email: "discard@example.invalid",
      });
    });
    const k = {
      apiUrl: apiUrl + "/",
      token: "synthetic-kimchi-token",
      ...(sso ? { organizationId: org } : {}),
    };
    const c = await Authenticate(k);
    expect(c).toEqual({
      apiUrl,
      organizationId: org,
      actorId: actor,
      credentialHash: CredentialHash(k),
    });
    expect(() => Ready(c, k)).not.toThrow();
    expect(calls).toEqual(["POST /ai-optimizer/v1beta/api-keys:verify"]);
    expect(() => Ready(c, { ...k, token: "replacement-token" })).toThrow("not verified");
    expect(() => Ready(c, { apiUrl })).toThrow("sign in to Kimchi");
  }
});

test("verification rejects another SSO organization and a missing user", async () => {
  for (const mode of ["org", "missing-owner"]) {
    const org = NewID();
    const apiUrl = server(() =>
      Response.json({
        organizationId: org,
        ...(mode === "missing-owner" ? {} : { userId: NewID() }),
      }),
    );
    await expect(
      Authenticate({
        apiUrl,
        token: "synthetic-token",
        ...(mode === "org" ? { organizationId: NewID() } : {}),
      }),
    ).rejects.toThrow();
  }
});

test("reporting refuses unsafe URLs and credentials do not follow redirects", async () => {
  for (const apiUrl of [
    "http://example.com",
    "https://secret@example.com",
    "https://example.com?token=secret",
  ]) {
    expect(() => ValidateConfig({ apiUrl, organizationId: NewID(), actorId: NewID() })).toThrow();
  }
  let reached = false;
  const destination = server(() => {
    reached = true;
    return Response.json({});
  });
  const apiUrl = server(
    () =>
      new Response("synthetic-key leaked by upstream", {
        status: 302,
        headers: { Location: destination },
      }),
  );
  await expect(Authenticate({ apiUrl, token: "synthetic-key" })).rejects.toThrow("HTTP 302");
  expect(reached).toBe(false);
});

test("lost response retries the identical durable batch and uses only Bearer auth", async () => {
  const s = store(),
    e = event();
  s.Put(e);
  const bodies: string[] = [];
  const apiUrl = server(async (req) => {
    expect(req.headers.get("authorization")).toBe("Bearer synthetic-kimchi-key");
    expect(req.headers.get("x-api-key")).toBeNull();
    expect(req.headers.get("x-castai-organization-id")).toBeNull();
    expect(new URL(req.url).pathname).toContain("/pr-cost-events:batchIngest");
    bodies.push(await req.text());
    if (bodies.length === 1)
      return new Response("synthetic-kimchi-key upstream response", { status: 503 });
    return acknowledgement(Parse(bodies.at(-1)!).batch);
  });
  const [c, k] = configured(apiUrl);
  expect(await Flush(s, c, { apiUrl })).toBe(false);
  await expect(Flush(s, c, k)).rejects.toThrow("HTTP 503; batch retained");
  expect(await Flush(s, c, k)).toBe(true);
  expect(bodies[0]).toBe(bodies[1]);
  expect(bodies[0]).not.toContain("synthetic-kimchi-key");
  expect(s.Status().pending).toBe(0);
  expect(await Flush(s, c, k)).toBe(false);
});

test("partial and invalid acknowledgements retain the identical pending batch", async () => {
  const s = store();
  s.Put(event());
  const bodies: string[] = [];
  const apiUrl = server(async (req) => {
    bodies.push(await req.text());
    const batch = Parse(bodies.at(-1)!).batch;
    if (bodies.length === 1) return Response.json({ batchId: batch.id, receipts: [] });
    if (bodies.length === 2) return new Response("not JSON");
    return acknowledgement(batch);
  });
  const [c, k] = configured(apiUrl);
  await expect(Flush(s, c, k)).rejects.toThrow();
  await expect(Flush(s, c, k)).rejects.toThrow("invalid reporting acknowledgement");
  expect(s.Status().pending).toBe(1);
  expect(await Flush(s, c, k)).toBe(true);
  expect(new Set(bodies).size).toBe(1);
});

test("nested 413 splits keep event revisions and survive accepted-but-lost responses", async () => {
  for (const acceptedLarge of [false, true]) {
    const s = store(),
      base = event();
    delete base.id;
    delete base.revision;
    for (let i = 1; i <= 8; i++)
      s.Observe({ ...base, coverage: { code: "counter", count: String(i) } });
    const seen = new Map<string, string>();
    let last = "0",
      lost = false;
    const apiUrl = server(async (req) => {
      const batch = Parse(await req.text()).batch as Batch;
      if (batch.events.length <= 2 || acceptedLarge) {
        for (const item of batch.events) {
          if (seen.has(item.id!)) expect(seen.get(item.id!)).toBe(Hash(item));
          else {
            expect(item.baseRevision ?? "0").toBe(last);
            seen.set(item.id!, Hash(item));
            last = item.revision!;
          }
        }
      }
      if (batch.events.length > 2) return new Response(null, { status: 413 });
      if (!lost) {
        lost = true;
        return new Response(null, { status: 503 });
      }
      return acknowledgement(batch);
    });
    const [c, k] = configured(apiUrl);
    for (let i = 0; i < 64; i++) {
      try {
        if (!(await Flush(s, c, k))) break;
      } catch {
        /* simulate the next native sync retry */
      }
    }
    expect(seen.size).toBe(8);
    expect(last).toBe("8");
    expect(s.Status().pending).toBe(0);
  }
});

test("OTLP partial failure retries independently without Cast credentials", async () => {
  const s = store();
  s.Put(event());
  const bodies: string[] = [];
  const apiUrl = server(async (req) => {
    expect(req.headers.get("authorization")).toBe("Bearer customer-only");
    expect(req.headers.get("x-api-key")).toBeNull();
    bodies.push(await req.text());
    expect(bodies.at(-1)).not.toContain("cast-only-secret");
    expect(JSON.parse(bodies.at(-1)!).resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano).toBe(
      "1792758645123456789",
    );
    return Response.json(
      bodies.length === 1 ? { partialSuccess: { rejectedLogRecords: "1" } } : {},
    );
  });
  const c: Config = {
    apiUrl,
    organizationId: NewID(),
    actorId: NewID(),
    credentialHash: CredentialHash({ apiUrl, token: "cast-only-secret" }),
    otlpUrl: apiUrl + "/v1/logs",
    otlpHeaders: { Authorization: "Bearer customer-only" },
  };
  await expect(FlushOTLP(s, c)).rejects.toThrow("partially rejected");
  expect(await FlushOTLP(s, c)).toBe(true);
  expect(await FlushOTLP(s, c)).toBe(false);
  expect(bodies[0]).toBe(bodies[1]);
  expect(s.Status().pending).toBe(1);
});
