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
  Authenticate,
  CredentialHash,
  ValidID,
  hasControl,
  object,
  secureEndpoint,
  type SignIn,
} from "./kimchi.ts";
import { OpenDatabase } from "./platform.ts";
import { NewID, StableID } from "./work/protocol.ts";

/** The account Kimchi's sign-in was verified as, OTLP export, and whether capture is paused. */
export interface Config {
  apiUrl?: string;
  organizationId?: string;
  actorId?: string;
  credentialHash?: string;
  otlpUrl?: string;
  otlpHeaders?: Record<string, string>;
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

export function ValidateOTLP(c: Config): void {
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

export function ValidateConfig(c: Config): void {
  secureEndpoint(c.apiUrl);
  ValidateOTLP(c);
  if (!ValidID(c.organizationId) || !ValidID(c.actorId)) throw new Error("invalid account");
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
