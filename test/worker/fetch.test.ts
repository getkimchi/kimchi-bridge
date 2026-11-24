import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKER_USER_AGENT,
  makeWorkerFetch,
  STREAM_IDLE_TIMEOUT_ENV,
  StreamIdleTimeoutError,
} from "../../src/worker/fetch.js";

/**
 * The worker's fetch wrapper (reconcile-out-of-process plan, chunk B3), tested
 * against a real HTTP server: the parent-side Kimchi wrapper it mirrors is
 * itself only observable through what the server sees. The user-agent and
 * idle-timeout semantics are the ones Kimchi's entry installs on global fetch,
 * so worker requests behave like the embedding process's requests.
 */

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  while (servers.length) servers.pop()?.stop(true);
  delete process.env[STREAM_IDLE_TIMEOUT_ENV];
});

interface Observed {
  userAgent: string | null;
  authorization: string | null;
}

/** A server that records the headers of one route and stalls on another. */
function serve(handlers: {
  echo?: (request: Request) => Response;
  stall?: () => Response | Promise<Response>;
}): {
  url: (path: string) => string;
  observed: () => Observed;
} {
  let observed: Observed = { userAgent: null, authorization: null };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      observed = {
        userAgent: request.headers.get("user-agent"),
        authorization: request.headers.get("authorization"),
      };
      if (request.url.endsWith("/stall") && handlers.stall) return handlers.stall();
      return handlers.echo ? handlers.echo(request) : new Response("ok");
    },
  });
  servers.push(server);
  return {
    url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
    observed: () => observed,
  };
}

describe("the worker's fetch wrapper", () => {
  test("sends the parent's user agent, and a caller-supplied one wins", async () => {
    const site = serve({});
    const fetchWithAgent = makeWorkerFetch("kimchi/9.9.9-test");
    const response = await fetchWithAgent(site.url("/"));
    expect(await response.text()).toBe("ok");
    expect(site.observed().userAgent).toBe("kimchi/9.9.9-test");

    await fetchWithAgent(site.url("/"), { headers: { "user-agent": "caller/1" } });
    expect(site.observed().userAgent).toBe("caller/1");

    const fallback = makeWorkerFetch(DEFAULT_WORKER_USER_AGENT);
    await fallback(site.url("/"));
    expect(site.observed().userAgent).toBe(DEFAULT_WORKER_USER_AGENT);
  });

  test("a Request object's own headers survive the default user agent", async () => {
    const site = serve({});
    const fetchWithAgent = makeWorkerFetch("kimchi/9.9.9-test");
    const request = new Request(site.url("/"), { headers: { authorization: "Bearer abc" } });
    await fetchWithAgent(request);
    expect(site.observed().userAgent).toBe("kimchi/9.9.9-test");
    expect(site.observed().authorization).toBe("Bearer abc");
  });

  test("a request whose headers never arrive fails at the idle timeout", async () => {
    const site = serve({ stall: () => new Promise<Response>(() => {}) });
    process.env[STREAM_IDLE_TIMEOUT_ENV] = "200";
    const fetchWithAgent = makeWorkerFetch("kimchi/9.9.9-test");
    const started = Date.now();
    let error: unknown;
    try {
      await fetchWithAgent(site.url("/stall"));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    if (error instanceof StreamIdleTimeoutError) {
      expect(error.message).toContain("headers");
      expect(error.message).toContain("200ms");
    }
  });

  test("a body that stalls mid-stream fails at the idle timeout, not as a clean end", async () => {
    // Headers arrive; one chunk is delivered; then the socket goes quiet.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first "));
        // The second chunk never comes.
      },
    });
    const site = serve({ stall: () => new Response(body) });
    process.env[STREAM_IDLE_TIMEOUT_ENV] = "200";
    const fetchWithAgent = makeWorkerFetch("kimchi/9.9.9-test");
    const response = await fetchWithAgent(site.url("/stall"));
    const started = Date.now();
    let error: unknown;
    try {
      await response.text();
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    if (error instanceof StreamIdleTimeoutError) expect(error.message).toContain("body");
  });

  test("a trickling body resets the idle clock and completes", async () => {
    const chunks = ["one ", "two ", "three"];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          await Bun.sleep(120);
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const site = serve({ stall: () => new Response(body) });
    process.env[STREAM_IDLE_TIMEOUT_ENV] = "300";
    const fetchWithAgent = makeWorkerFetch("kimchi/9.9.9-test");
    const response = await fetchWithAgent(site.url("/stall"));
    expect(await response.text()).toBe("one two three");
  });

  test("zero disables the idle timeout", async () => {
    const site = serve({ stall: () => new Promise<Response>(() => {}) });
    process.env[STREAM_IDLE_TIMEOUT_ENV] = "0";
    const fetchWithAgent = makeWorkerFetch("kimchi/9.9.9-test");
    const pending = fetchWithAgent(site.url("/stall"));
    // Still pending (not rejected) well past a would-be short timeout.
    const result = await Promise.race([
      pending.then(() => "settled"),
      Bun.sleep(400).then(() => "pending"),
    ]);
    expect(result).toBe("pending");
    // Leave the request to the server's teardown.
    pending.catch(() => {});
  });
});
