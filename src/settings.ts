import { randomUUID } from "node:crypto";
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
import {
  IdentityError,
  authenticate,
  credentialHash,
  hasControl,
  object,
  secureEndpoint,
  validId,
  type SignIn,
} from "./kimchi.ts";
import { openDatabase } from "./platform.ts";
// Account folders and session pins are named with the work protocol's stable IDs.
import { stableId } from "./work/protocol.ts";

/** The account Kimchi's sign-in was verified as, OTLP export, and whether capture is paused. */
export interface Config {
  apiUrl?: string;
  organizationId?: string;
  actorId?: string;
  credentialHash?: string;
  otlpUrl?: string;
  otlpHeaders?: Record<string, string>;
  disabled?: boolean;
  /** A sign-in that failed to verify, and when it may be tried again (milliseconds since epoch). */
  verifyRetry?: { credentialHash: string; at: number; failures: number; rejected: boolean };
}
export function stateRoot(): string {
  const path = process.env.KIMCHI_BRIDGE_HOME;
  return path && isAbsolute(path) ? path : join(homedir(), ".local", "state", "kimchi-bridge");
}
export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(join(stateRoot(), "config.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
export function stateDir(c: Config): string {
  let account = "local";
  try {
    validateConfig(c);
    account = stableId(c.apiUrl!, c.organizationId!, c.actorId!);
  } catch {}
  return join(stateRoot(), "accounts", account);
}
export function saveConfig(config: Config): void {
  // Earlier releases kept their own reporting key and runtime here; Kimchi provides both.
  const { apiKey, accessToken, enabled, runtimeExecutable, runtimeRevision, ...c } =
    config as Config & Record<string, unknown>;
  validateOtlp(c);
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  const tmp = join(stateRoot(), ".config-" + randomUUID());
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(c, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(stateRoot(), "config.json"));
    const dir = openSync(stateRoot(), "r");
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

/** Verify Kimchi's sign-in when it changed. A different account drops the old account's exporter. */
const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
export async function verifySignIn(k: SignIn, signal?: AbortSignal): Promise<Config> {
  const before = loadConfig();
  const hash = credentialHash(k);
  if (!k.token || before.credentialHash === hash) return before;
  // A sign-in that failed waits before it is checked again, as Kimchi's uploader waits: 1 h
  // doubling to 6 h after the API rejected it, 30 s doubling to 30 min while it is unreachable.
  // A changed sign-in is checked at once.
  const retry = before.verifyRetry?.credentialHash === hash ? before.verifyRetry : undefined;
  if (retry && Date.now() < retry.at) {
    if (retry.rejected) throw new IdentityError("Kimchi sign-in was rejected; retrying later");
    throw new Error("Kimchi API unreachable; retrying later");
  }
  let identity: Awaited<ReturnType<typeof authenticate>>;
  try {
    identity = await authenticate(k, signal);
  } catch (error) {
    const rejected = error instanceof IdentityError,
      failures = (retry?.failures ?? 0) + 1;
    const wait = rejected
      ? Math.min(6 * HOUR, HOUR * 2 ** (failures - 1))
      : Math.min(30 * MINUTE, 30_000 * 2 ** (failures - 1));
    saveConfig({
      ...loadConfig(),
      verifyRetry: { credentialHash: hash, at: Date.now() + wait, failures, rejected },
    });
    throw error;
  }
  // Read again, keeping what changed during the request, such as disable or configure.
  const latest = loadConfig();
  const next: Config = { ...latest, ...identity };
  delete next.verifyRetry;
  if (latest.actorId && stateDir(next) !== stateDir(latest)) {
    delete next.otlpUrl;
    delete next.otlpHeaders;
  }
  saveConfig(next);
  return next;
}

/** configure sets OTLP export only; reporting uses Kimchi's sign-in. */
export function decodeOtlp(data: string | Uint8Array): Pick<Config, "otlpUrl" | "otlpHeaders"> {
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
  validateOtlp(otlp);
  return otlp;
}

function validateOtlp(c: Config): void {
  if (c.otlpUrl) secureEndpoint(c.otlpUrl);
  const headers = c.otlpHeaders ?? {};
  if (typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 16)
    throw new Error("invalid OTLP headers");
  for (const [key, value] of Object.entries(headers)) {
    if (
      !key ||
      key.length > 64 ||
      typeof value !== "string" ||
      value.length > 2048 ||
      hasControl(key + value)
    )
      throw new Error("invalid OTLP header");
    if (["host", "content-length", "transfer-encoding"].includes(key.toLowerCase()))
      throw new Error("reserved OTLP header");
  }
}

export function validateConfig(c: Config): void {
  secureEndpoint(c.apiUrl);
  validateOtlp(c);
  if (!validId(c.organizationId) || !validId(c.actorId)) throw new Error("invalid account");
}

const validAccount = (s: unknown) => s === "local" || validId(s);
export function sessionStateDir(c: Config, source: string, session: string): string {
  if (
    !["codex", "claude-code"].includes(source) ||
    !session ||
    Buffer.byteLength(session) > 512 ||
    hasControl(session)
  )
    throw new Error("invalid native session");
  const db = openDatabase(join(stateRoot(), "session-accounts.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,account TEXT NOT NULL)");
    const id = stableId(source, session);
    let row = db.query("SELECT account FROM sessions WHERE id=?").get(id) as any;
    if (!row) {
      let account: unknown = basename(stateDir(c));
      try {
        const body = readFileSync(join(stateRoot(), "session-accounts", id + ".json"));
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
    return join(stateRoot(), "accounts", row.account);
  } finally {
    db.close();
  }
}
