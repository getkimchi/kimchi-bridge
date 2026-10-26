// Browser key handoff follows Kimchi's src/cli-auth (CAST AI, Apache-2.0).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Authenticate, Ready, ValidateConfig, type Config } from "./delivery.ts";
import { Load, Save, StateDir } from "./settings.ts";

type Environment = Record<string, string | undefined>;
type Region = "us" | "eu" | "self-hosted";
const regions = {
  us: { webAppUrl: "https://app.kimchi.dev", apiUrl: "https://api.cast.ai" },
  eu: { webAppUrl: "https://app.eu.kimchi.dev", apiUrl: "https://api.eu.cast.ai" },
};

export interface LoginOptions {
  fromKimchi?: boolean;
  ifPresent?: boolean;
  region?: string;
  consoleUrl?: string;
  noBrowser?: boolean;
  signal?: AbortSignal;
  environmentKey?: string;
  onMessage?: (message: string) => void;
  _kimchiConfigPath?: string;
  _environment?: Environment;
  _open?: (url: string) => Promise<unknown>;
}
export interface BrowserLoginOptions {
  webAppUrl: string;
  noBrowser?: boolean;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
  _open?: (url: string) => Promise<unknown>;
  _timeoutMs?: number;
}

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" ? v : "");
function endpoint(value: string): string {
  // Reuse reporting's transport policy without accepting or storing a credential.
  ValidateConfig({ apiUrl: value, apiKey: "endpoint-validation" }, true);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}
function readKimchi(path: string): Record<string, unknown> {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 1 << 20) throw new Error();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Kimchi login settings could not be read");
  }
}

async function discovered(consoleUrl: string, signal?: AbortSignal) {
  const base = endpoint(consoleUrl.trim());
  let response: Response;
  try {
    response = await fetch(`${base}/env/endpoints.json`, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    const body = object(await response.json());
    // This is the existing self-hosted discovery contract, including its third origin.
    const webAppUrl = endpoint(text(body.console)),
      apiUrl = endpoint(text(body.api));
    endpoint(text(body.llm));
    return { webAppUrl, apiUrl };
  } catch {
    throw new Error("Endpoint discovery failed: the console must serve /env/endpoints.json");
  }
}

async function endpoints(options: LoginOptions, raw: Record<string, unknown>, env: Environment) {
  if (options.region && options.region !== "us" && options.region !== "eu")
    throw new Error("choose region us or eu, or provide a self-hosted console URL");
  const validRegion = (value: unknown): value is Region =>
    ["us", "eu", "self-hosted"].includes(text(value));
  const region: Region =
    (options.region as Region) ||
    (validRegion(env.KIMCHI_REGION) ? env.KIMCHI_REGION : undefined) ||
    (validRegion(raw.region) ? raw.region : "us");
  let target: { webAppUrl: string; apiUrl: string };
  if (options.consoleUrl) target = await discovered(options.consoleUrl, options.signal);
  else if (region === "self-hosted") {
    const stored = object(raw.selfHostedEndpoints),
      legacy = env.KIMCHI_SELF_HOSTED_URL || text(raw.selfHostedUrl);
    if (text(stored.api) && text(stored.console)) {
      target = { apiUrl: endpoint(text(stored.api)), webAppUrl: endpoint(text(stored.console)) };
    } else if (legacy) {
      // Pre-discovery Kimchi stores one base; its API lives under /api.
      const base = endpoint(legacy);
      target = { apiUrl: `${base}/api`, webAppUrl: base };
    } else throw new Error("Self-hosted Kimchi endpoints are missing; provide the console URL");
  } else target = { ...regions[region] };
  if (!options.consoleUrl && env.KIMCHI_WEB_APP_URL)
    target.webAppUrl = endpoint(env.KIMCHI_WEB_APP_URL);
  if (env.KIMCHI_REMOTE_ENDPOINT) target.apiUrl = endpoint(env.KIMCHI_REMOTE_ENDPOINT);
  return target;
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = Bun.spawn([command, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
}

export async function browserLogin(options: BrowserLoginOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const webAppUrl = endpoint(options.webAppUrl),
    state = randomBytes(32).toString("hex");
  const log = options.onMessage ?? console.log;
  let settled = false;
  let resolveResult!: (key: string) => void, rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Install a rejection handler before opening the browser, which may itself be slow.
  result.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (key?: string, error?: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (error) rejectResult(new Error(error));
    else resolveResult(key!);
    server.close();
    setTimeout(() => server.closeAllConnections(), 100).unref();
  };
  const server = createServer((request, response) => {
    const reply = (status: number, message: string) => {
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        Connection: "close",
      });
      response.end(message);
    };
    const peer = request.socket.remoteAddress ?? "";
    if (!(peer.startsWith("127.") || peer === "::1" || peer === "::ffff:127.0.0.1")) {
      reply(403, "Only localhost connections are allowed.");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      reply(400, "Invalid callback.");
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/callback") {
      reply(404, "Not found");
      return;
    }
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    if (received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) {
      reply(400, "This login request is not valid. Try again from your terminal.");
      finish(undefined, "Browser login failed: invalid callback state");
      return;
    }
    if (url.searchParams.has("error")) {
      reply(200, "Login was not completed. Return to your terminal.");
      finish(undefined, "Browser login cancelled or rejected");
      return;
    }
    const key = url.searchParams.get("token");
    if (!key) {
      reply(400, "No API key was returned.");
      finish(undefined, "Browser login completed without an API key");
      return;
    }
    reply(200, "Login received. Return to your terminal to finish verifying reporting.");
    finish(key);
  });
  const abort = () => finish(undefined, "Browser login cancelled");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(
      () => finish(undefined, "Browser login timed out after five minutes; try again"),
      options._timeoutMs ?? 300_000,
    );
    if (settled) {
      clearTimeout(timer);
      return await result;
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not start the local login callback");
    const url = new URL(`${webAppUrl}/cli-auth`);
    url.searchParams.set("callback", `http://127.0.0.1:${address.port}/callback`);
    url.searchParams.set("state", state);
    log(`Kimchi login: ${url.href}`);
    if (!options.noBrowser) {
      try {
        await (options._open ?? openBrowser)(url.href);
      } catch {
        log("Couldn't open the browser. Open the login URL above manually.");
      }
    }
    return await result;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    server.close();
  }
}

export async function Login(options: LoginOptions = {}): Promise<boolean> {
  if (options.ifPresent && !options.fromKimchi)
    throw new Error("--if-present requires --from-kimchi");
  if (options.fromKimchi && options.consoleUrl)
    throw new Error("--from-kimchi reads the saved Kimchi account; omit the console URL");
  if (options.ifPresent) {
    const existing = Load();
    let ready = true;
    try {
      Ready(existing);
    } catch {
      ready = false;
    }
    if (ready) {
      options.onMessage?.("Reporting already configured for the selected account.");
      return true;
    }
  }
  const env = options._environment ?? process.env;
  const raw = readKimchi(
    options._kimchiConfigPath ?? join(homedir(), ".config", "kimchi", "config.json"),
  );
  const key = options.environmentKey || env.KIMCHI_API_KEY || text(raw.apiKey) || text(raw.api_key);
  if (options.fromKimchi && !key) {
    if (options.ifPresent) return false;
    throw new Error("No saved Kimchi API key; run kimchi-adapters login to create one");
  }
  const target = await endpoints(options, raw, env);
  const apiKey = options.fromKimchi
    ? key
    : await browserLogin({ ...options, webAppUrl: target.webAppUrl });
  const verified = await Authenticate({ apiUrl: target.apiUrl, apiKey }, options.signal);
  const previous = Load();
  const config: Config = { ...previous, ...verified, accessToken: undefined, enabled: true };
  if (StateDir(config) !== StateDir(previous)) {
    delete config.otlpUrl;
    delete config.otlpHeaders;
  }
  Save(config);
  options.onMessage?.(
    "Reporting configured with your Kimchi API key. Inference settings are unchanged.",
  );
  return true;
}
