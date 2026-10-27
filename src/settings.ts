import { basename, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { NewID, StableID } from "./protocol";
import { OpenDatabase } from "./ledger";
import {
  Authenticate,
  BaseUrl,
  CredentialHash,
  ValidateConfig,
  ValidateOTLP,
  ValidID,
  type Config as DeliveryConfig,
  type SignIn,
} from "./delivery";

export interface Config extends DeliveryConfig {
  disabled?: boolean;
}
export function Root(): string {
  const path = process.env.KIMCHI_BRIDGE_HOME;
  return path && isAbsolute(path) ? path : join(homedir(), ".local", "state", "kimchi-bridge");
}
export function Load(): Config {
  try {
    return JSON.parse(readFileSync(join(Root(), "config.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
export function StateDir(c: Config): string {
  let account = "local";
  try {
    ValidateConfig(c);
    account = StableID(c.apiUrl!, c.organizationId!, c.actorId!);
  } catch {}
  return join(Root(), "accounts", account);
}
export function Save(config: Config): void {
  // Earlier releases kept their own reporting key and runtime here; Kimchi provides both.
  const { apiKey, accessToken, enabled, runtimeExecutable, runtimeRevision, ...c } =
    config as Config & Record<string, unknown>;
  ValidateOTLP(c);
  mkdirSync(Root(), { recursive: true, mode: 0o700 });
  const tmp = join(Root(), ".config-" + NewID());
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(c, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(Root(), "config.json"));
    const dir = openSync(Root(), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
// Kimchi's sign-in, in the order of its resolveGatewayCredentials: an API key (KIMCHI_API_KEY,
// then the global config), else its saved login, whose SSO token carries its organization.
// Project .kimchi/config.json keys stay Kimchi's: the plugins can't see its project trust.
export function KimchiSignIn(
  environmentKey = "",
  dir = join(process.env.HOME || homedir(), ".config", "kimchi"),
  env: Record<string, string | undefined> = process.env,
): SignIn {
  let config: Record<string, unknown> = {};
  try {
    config = kimchiFile(join(dir, "config.json"));
  } catch {
    // Kimchi reads a malformed config as empty too, and still uses its saved login.
  }
  const apiUrl = kimchiApiUrl(config, env);
  const key = environmentKey || text(config.apiKey) || text(config.api_key);
  if (key) return { apiUrl, token: key };
  const login = object(kimchiFile(join(dir, "harness", "auth.json"))["kimchi-dev"]);
  if (login.type === "oauth" && text(login.access))
    return { apiUrl, token: text(login.access), organizationId: text(login.orgId) || undefined };
  if (login.type === "api_key" && text(login.key)) return { apiUrl, token: text(login.key) };
  return { apiUrl };
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" ? v : "");
function kimchiFile(path: string): Record<string, unknown> {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 1 << 20) throw new Error();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Kimchi settings could not be read");
  }
}
// Where Kimchi's own PR-cost uploads go (resolveEndpoints().platformApiUrl): KIMCHI_REMOTE_ENDPOINT,
// else the region's console with /api. Self-hosted needs all three stored endpoints, as in Kimchi.
function kimchiApiUrl(config: Record<string, unknown>, env: Record<string, string | undefined>) {
  if (env.KIMCHI_REMOTE_ENDPOINT) return env.KIMCHI_REMOTE_ENDPOINT;
  const region = [env.KIMCHI_REGION, config.region].find((r) =>
    ["us", "eu", "self-hosted"].includes(text(r)),
  );
  if (region === "eu") return "https://app.eu.kimchi.dev/api";
  if (region !== "self-hosted") return "https://app.kimchi.dev/api";
  const stored = object(config.selfHostedEndpoints);
  const [api, console, llm] = ["api", "console", "llm"].map((key) => origin(text(stored[key])));
  return api && console && llm ? console + "/api" : "";
}
// Kimchi's normalizeSelfHostedBaseUrl: an absolute http(s) URL without trailing slashes.
function origin(value: string): string {
  value = BaseUrl(value.trim());
  try {
    return ["http:", "https:"].includes(new URL(value).protocol) ? value : "";
  } catch {
    return "";
  }
}

/** Verify Kimchi's sign-in when it changed. A different account drops the old account's exporter. */
export async function Verify(k: SignIn, signal?: AbortSignal): Promise<Config> {
  const before = Load();
  if (!k.token || before.credentialHash === CredentialHash(k)) return before;
  const identity = await Authenticate(k, signal);
  // Read again, keeping what changed during the request, such as disable or configure.
  const latest = Load();
  const next: Config = { ...latest, ...identity };
  if (latest.actorId && StateDir(next) !== StateDir(latest)) {
    delete next.otlpUrl;
    delete next.otlpHeaders;
  }
  Save(next);
  return next;
}

/** configure sets OTLP export only; reporting uses Kimchi's sign-in. */
export function DecodeOTLP(data: string | Uint8Array): Pick<Config, "otlpUrl" | "otlpHeaders"> {
  if (Buffer.byteLength(data) > 32 << 10) throw new Error("configuration too large");
  let c: Record<string, unknown>;
  try {
    c = object(JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString()));
  } catch {
    throw new Error("invalid configuration JSON");
  }
  if (["apiUrl", "apiKey", "api_key", "accessToken"].some((key) => key in c))
    throw new Error("the plugins report with Kimchi's sign-in; configure sets OTLP export only");
  const otlp = { otlpUrl: c.otlpUrl, otlpHeaders: c.otlpHeaders } as Config;
  ValidateOTLP(otlp);
  return otlp;
}
const validAccount = (s: unknown) => s === "local" || ValidID(s);
export function SessionStateDir(c: Config, source: string, session: string): string {
  if (
    !["codex", "claude-code"].includes(source) ||
    !session ||
    Buffer.byteLength(session) > 512 ||
    Array.from("\0\r\n").some((c) => session.includes(c))
  )
    throw new Error("invalid native session");
  const db = OpenDatabase(join(Root(), "session-accounts.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,account TEXT NOT NULL)");
    const id = StableID(source, session);
    let row = db.query("SELECT account FROM sessions WHERE id=?").get(id) as any;
    if (!row) {
      let account: unknown = basename(StateDir(c));
      try {
        const body = readFileSync(join(Root(), "session-accounts", id + ".json"));
        if (body.length > 256) throw new Error("invalid native account binding");
        account = JSON.parse(body.toString());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (!validAccount(account)) throw new Error("invalid native account binding");
      db.query("INSERT OR IGNORE INTO sessions(id,account) VALUES(?,?)").run(id, account as string);
      row = db.query("SELECT account FROM sessions WHERE id=?").get(id) as any;
    }
    if (!validAccount(row.account)) throw new Error("invalid native account binding");
    return join(Root(), "accounts", row.account);
  } finally {
    db.close();
  }
}
