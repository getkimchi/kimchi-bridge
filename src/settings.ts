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
import { Ready, ValidateConfig, ValidID, type Config as DeliveryConfig } from "./delivery";

export interface Config extends DeliveryConfig {
  disabled?: boolean;
  runtimeExecutable?: string;
  runtimeRevision?: string;
}
export function Root(): string {
  const path = process.env.KIMCHI_ADAPTERS_HOME;
  return path && isAbsolute(path) ? path : join(homedir(), ".local", "state", "kimchi-adapters");
}
export function Load(): Config {
  try {
    return JSON.parse(readFileSync(join(Root(), "config.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { apiUrl: "", organizationId: "", enabled: false } as Config;
    throw e;
  }
}
export function StateDir(c: Config): string {
  let account = "local";
  try {
    Ready(c);
    account = StableID(c.apiUrl!, c.organizationId!, c.actorId!);
  } catch {}
  return join(Root(), "accounts", account);
}
export function Save(c: Config): void {
  if (c.enabled) Ready(c);
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
export function Decode(data: string | Uint8Array): Config {
  if (Buffer.byteLength(data) > 32 << 10) throw new Error("configuration too large");
  let c: Config;
  try {
    c = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString());
  } catch {
    throw new Error("invalid configuration JSON");
  }
  delete c.runtimeExecutable;
  delete c.runtimeRevision;
  ValidateConfig(c, true);
  return c;
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
