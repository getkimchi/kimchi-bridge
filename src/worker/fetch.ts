/**
 * The worker's fetch wrapper (reconcile-out-of-process plan, chunk B3).
 *
 * In the embedding process, Kimchi's entry installs a global fetch
 * instrumentation (kimchi's src/http/instrument-fetch.ts over
 * src/http/stream-idle-timeout.ts): a default user-agent and an idle timeout
 * on every outbound request, because under Bun the undici dispatcher timeouts
 * are inert and a stalled socket otherwise hangs until the OS gives up. The
 * worker runs under the same Bun runtime, so its host fetch wraps the same
 * two behaviors with the same semantics: the user-agent is set when the caller
 * supplied none (a caller-supplied header wins, and a Request object's own
 * headers are preserved), and the idle timeout bounds the wait for response
 * headers and every body read, resetting on each delivered chunk. The
 * instrumentation's model-request hooks are parent-side concerns that do not
 * apply to a child process.
 *
 * Proxying needs no code here: under Bun, fetch honors HTTP_PROXY,
 * HTTPS_PROXY and NO_PROXY natively — the same layer the kimchi binary itself
 * relies on. KIMCHI_PROXY/KIMCHI_NO_PROXY are Node-only overrides in Kimchi
 * too (kimchi's src/http/proxy.ts), and the parent can forward the effective
 * choice through the standard variables when it spawns the worker.
 *
 * The idle timeout resolves per request: KIMCHI_STREAM_IDLE_TIMEOUT_MS (the
 * same variable Kimchi's wrapper reads) wins, `0` disables it, and the default
 * is Kimchi's 300 s. A settings-file override lives in the parent process;
 * the parent forwards it through the environment when it spawns the worker.
 */
import type { HostFetch } from "../reconcile/host.js";

/** The env variable Kimchi's stream idle timeout reads; the worker reads the same one. */
export const STREAM_IDLE_TIMEOUT_ENV = "KIMCHI_STREAM_IDLE_TIMEOUT_MS";

/** Kimchi's fallback when no setting is readable. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** The user-agent the worker falls back to when the parent sends none. */
export const DEFAULT_WORKER_USER_AGENT = "kimchi";

function resolveStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STREAM_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  // Number(), not parseInt(): a unit-suffixed value must not truncate into a
  // lethal sub-second timeout; malformed values fall through to the default.
  const parsed = Number(raw.trim());
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/** The error a stalled request surfaces; the wording mirrors Kimchi's so transport classification matches. */
export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number;
  constructor(idleMs: number, host: string, phase: "headers" | "body") {
    super(
      `Stream idle timeout: socket connection closed — no bytes received from ${host} ` +
        `during ${phase} for ${idleMs}ms (read timed out)`,
    );
    this.idleMs = idleMs;
    this.name = "StreamIdleTimeoutError";
  }
}

function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof (input as Request).url === "string") return (input as Request).url;
  return undefined;
}

function hostOf(input: RequestInfo | URL): string {
  const url = requestUrl(input);
  if (!url) return "provider";
  try {
    return new URL(url).host;
  } catch {
    return "provider";
  }
}

/** Rebuilds a response around a replacement body, delegating url/redirected reads to the original. */
function rewrapResponseWithBody(original: Response, body: ReadableStream<Uint8Array>): Response {
  const wrapped = new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
  Object.defineProperties(wrapped, {
    url: { get: () => original.url },
    redirected: { get: () => original.redirected },
  });
  return wrapped;
}

const IDLE = Symbol("idle");

/**
 * Wraps a response body so a pull waiting longer than `idleMs` for a chunk
 * aborts the request and errors the stream — never a silent truncation. Every
 * delivered chunk resets the clock, so a slow-but-alive stream never trips.
 */
function wrapBodyWithIdleTimeout(
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  host: string,
  abort: (error: unknown) => void,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleMs);
      });
      const read = reader.read();
      read.catch(() => {});
      try {
        const result = await Promise.race([read, idle]);
        if (result === IDLE) {
          const error = new StreamIdleTimeoutError(idleMs, host, "body");
          abort(error);
          await reader.cancel(error).catch(() => {});
          controller.error(error);
          onSettled();
          return;
        }
        if (result.done) {
          controller.close();
          onSettled();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        abort(error);
        await reader.cancel(error).catch(() => {});
        controller.error(error);
        onSettled();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    cancel(reason) {
      abort(reason);
      onSettled();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * The worker's host fetch: Kimchi's user-agent and idle-timeout wrapper over
 * the process's own fetch. The user agent is set when the caller supplied
 * none — from `init.headers`, or the Request object's own headers when the
 * input is one and the init carries none, so forwarding the default never
 * strips an authorization header.
 */
export function makeWorkerFetch(userAgent: string): HostFetch {
  return async function workerFetch(input, init) {
    // Header handling comes first, in every mode: Kimchi applies its outer
    // user-agent wrapper even when the idle-timeout wrapper is disabled, so
    // turning the timeout off must never also drop the parent's identity.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);

    const idleMs = resolveStreamIdleTimeoutMs();
    if (idleMs <= 0) return fetch(input, { ...init, headers });

    const host = hostOf(input);
    const controller = new AbortController();
    let idleError: StreamIdleTimeoutError | undefined;

    // Bridge a caller-supplied signal, from the init or carried on a Request
    // input, into the controller that owns this request's timeout.
    const userSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let removeAbortBridge: (() => void) | undefined;
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else {
        const onUserAbort = () => controller.abort(userSignal.reason);
        userSignal.addEventListener("abort", onUserAbort, { once: true });
        removeAbortBridge = () => userSignal.removeEventListener("abort", onUserAbort);
      }
    }

    const headersTimer = setTimeout(() => {
      idleError = new StreamIdleTimeoutError(idleMs, host, "headers");
      controller.abort(idleError);
    }, idleMs);

    let response: Response;
    try {
      response = await fetch(input, { ...init, headers, signal: controller.signal });
    } catch (error) {
      removeAbortBridge?.();
      if (idleError) throw idleError;
      throw error;
    } finally {
      clearTimeout(headersTimer);
    }

    if (!response.body) {
      removeAbortBridge?.();
      return response;
    }

    const wrappedBody = wrapBodyWithIdleTimeout(
      response.body,
      idleMs,
      host,
      (error) => controller.abort(error),
      () => removeAbortBridge?.(),
    );
    return rewrapResponseWithBody(response, wrappedBody);
  };
}
