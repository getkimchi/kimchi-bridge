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
function configured(apiUrl: string): Config {
  const c: Config = {
    apiUrl,
    organizationId: NewID(),
    actorId: NewID(),
    apiKey: "synthetic-kimchi-key",
    enabled: true,
  };
  c.credentialHash = CredentialHash(c);
  return c;
}
function acknowledgement(batch: Batch) {
  return Response.json({
    batchId: batch.id,
    receipts: batch.events.map((e) => ({ id: e.id, revision: e.revision, status: "accepted" })),
  });
}

test("Kimchi key discovers its org, verifies user ownership, and keeps only stable identity", async () => {
  const actor = NewID(),
    org = NewID(),
    calls: string[] = [];
  const apiUrl = server((req) => {
    expect(req.headers.get("authorization")).toBe("Bearer synthetic-kimchi-key");
    expect(req.headers.get("x-api-key")).toBeNull();
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (path.endsWith("api-keys:verify")) {
      expect(req.method).toBe("POST");
      return Response.json({ organizationId: org, userId: actor });
    }
    expect(req.method).toBe("GET");
    return Response.json({
      id: actor,
      username: "auth0|fixture",
      email: "discard@example.invalid",
      readmeIoJwt: "never-persist",
    });
  });
  const c = await Authenticate({ apiUrl: apiUrl + "/", apiKey: "synthetic-kimchi-key" });
  expect(c.organizationId).toBe(org);
  expect(c.actorId).toBe(actor);
  expect(c.apiUrl).toBe(apiUrl);
  expect(() => Ready(c)).not.toThrow();
  expect(JSON.stringify(c)).not.toContain("never-persist");
  expect(JSON.stringify(c)).not.toContain("discard@example.invalid");
  expect(calls).toEqual(["/ai-optimizer/v1beta/api-keys:verify", "/v1/me"]);
  expect(() => Ready({ ...c, apiKey: "replacement-key" })).toThrow("run configure");
});

test("onboarding rejects mismatched org, mismatched owner, and service-account profiles", async () => {
  for (const mode of ["org", "owner", "service", "missing-owner"]) {
    const org = NewID(),
      actor = NewID();
    const apiUrl = server((req) =>
      new URL(req.url).pathname.endsWith("api-keys:verify")
        ? Response.json({
            organizationId: org,
            ...(mode === "missing-owner" ? {} : { userId: actor }),
          })
        : Response.json({
            id: mode === "owner" ? NewID() : actor,
            ...(mode === "service" ? {} : { username: "auth0|fixture" }),
          }),
    );
    await expect(
      Authenticate({
        apiUrl,
        apiKey: "synthetic-key",
        ...(mode === "org" ? { organizationId: NewID() } : {}),
      }),
    ).rejects.toThrow();
  }
});

test("new configure requires a Kimchi API key while existing bearer config remains readable", async () => {
  const c = configured("https://api.cast.ai");
  delete c.apiKey;
  c.accessToken = "legacy-bearer";
  c.credentialHash = CredentialHash(c);
  expect(() => Ready(c)).not.toThrow();
  await expect(Authenticate(c)).rejects.toThrow("Kimchi API key");
});

test("reporting refuses unsafe URLs and credentials do not follow redirects", async () => {
  for (const apiUrl of [
    "http://example.com",
    "https://secret@example.com",
    "https://example.com?token=secret",
  ]) {
    expect(() => ValidateConfig({ apiUrl, organizationId: NewID(), apiKey: "key" })).toThrow();
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
  await expect(Authenticate({ apiUrl, apiKey: "synthetic-key" })).rejects.toThrow("HTTP 302");
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
    expect(new URL(req.url).pathname).toContain("/pr-cost-events:batchIngest");
    bodies.push(await req.text());
    if (bodies.length === 1)
      return new Response("synthetic-kimchi-key upstream response", { status: 503 });
    return acknowledgement(Parse(bodies.at(-1)!).batch);
  });
  const c = configured(apiUrl);
  await expect(Flush(s, c)).rejects.toThrow("HTTP 503; batch retained");
  expect(await Flush(s, c)).toBe(true);
  expect(bodies[0]).toBe(bodies[1]);
  expect(bodies[0]).not.toContain("synthetic-kimchi-key");
  expect(s.Status().pending).toBe(0);
  expect(await Flush(s, c)).toBe(false);
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
  const c = configured(apiUrl);
  await expect(Flush(s, c)).rejects.toThrow();
  await expect(Flush(s, c)).rejects.toThrow("invalid reporting acknowledgement");
  expect(s.Status().pending).toBe(1);
  expect(await Flush(s, c)).toBe(true);
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
    const c = configured(apiUrl);
    for (let i = 0; i < 64; i++) {
      try {
        if (!(await Flush(s, c))) break;
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
    apiKey: "cast-only-secret",
    otlpUrl: apiUrl + "/v1/logs",
    otlpHeaders: { Authorization: "Bearer customer-only" },
  };
  await expect(FlushOTLP(s, c)).rejects.toThrow("partially rejected");
  expect(await FlushOTLP(s, c)).toBe(true);
  expect(await FlushOTLP(s, c)).toBe(false);
  expect(bodies[0]).toBe(bodies[1]);
  expect(s.Status().pending).toBe(1);
});
