import { homedir } from "node:os";
import { join } from "node:path";
import {
  IdentityError,
  baseUrl,
  credentialHash,
  kimchiReportingEnabled,
  kimchiSignIn,
  type SignIn,
} from "./kimchi.ts";
import {
  decodeOtlp,
  loadConfig,
  saveConfig,
  sessionStateDir,
  stateDir,
  verifySignIn,
  type Config,
} from "./settings.ts";
import { Recorder, type Native } from "./work/capture.ts";
import { flush, flushOtlp } from "./work/delivery.ts";
import { Store } from "./work/ledger.ts";
import { encodeEvent, eventKind, parseJson, stringifyJson } from "./work/protocol.ts";
import { sync } from "./work/sync.ts";

declare const BUILD_VERSION: string | undefined;
const version = typeof BUILD_VERSION === "string" ? BUILD_VERSION : "dev";

async function input(limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.from(chunk);
    length += part.length;
    if (length > limit) throw new Error("input exceeds size bound");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export function csvText(value: string): string {
  return ["=", "+", "-", "@", "\t", "\r"].includes(value[0]) ? "'" + value : value;
}
function csvCell(value: string): string {
  const text = csvText(value);
  return ['"', ",", "\r", "\n"].some((char) => text.includes(char))
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

// A starting session reports to the account Kimchi's sign-in verifies as. A sign-in that cannot be
// read (Kimchi rewriting auth.json) keeps the verified account, and so does an unreachable API for
// an SSO token of that same organization, as after a token refresh. Otherwise the account is
// unknown, and the session stays on this machine. So does a session that starts while Kimchi's PR
// reporting is off.
async function sessionAccount(c: Config, environmentKey?: string): Promise<Config> {
  if (!kimchiReportingEnabled(c.organizationId)) return {};
  let k: SignIn;
  try {
    k = kimchiSignIn(environmentKey);
  } catch {
    return c;
  }
  if (!k.token) return {};
  try {
    return await verifySignIn(k, AbortSignal.timeout(1000));
  } catch (error) {
    const refreshed =
      !(error instanceof IdentityError) &&
      k.organizationId !== undefined &&
      k.organizationId.toLowerCase() === c.organizationId &&
      baseUrl(k.apiUrl) === c.apiUrl;
    return refreshed ? c : {};
  }
}

export async function run(
  args: string[],
  stdin = input,
  output: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): Promise<void> {
  const environmentKey = process.env.KIMCHI_API_KEY;
  delete process.env.KIMCHI_API_KEY;
  // Kimchi's runtime switch must not reach the git, gh and glab this starts.
  delete process.env.BUN_BE_BUN;
  // Unreadable Kimchi settings mean no sign-in: local recording continues, uploads wait.
  const signIn = (): SignIn => {
    try {
      return kimchiSignIn(environmentKey);
    } catch {
      return { apiUrl: "" };
    }
  };
  if (!args.length)
    throw new Error(
      "usage: kimchi-bridge status | enable | disable | flush | export jsonl|csv | version",
    );
  const command = args[0];
  if (command === "version") {
    output(version + "\n");
    return;
  }
  if (command === "uninstall") {
    if (!["claude", "codex", "both"].includes(args[1]))
      throw new Error("choose claude, codex or both");
    const prefix =
      process.env.KIMCHI_BRIDGE_PREFIX || join(homedir(), ".local", "share", "kimchi-bridge");
    const proc = Bun.spawn(["bash", join(prefix, "install.sh"), ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) throw new Error("installer command failed");
    return;
  }
  if (command === "configure") {
    saveConfig({ ...loadConfig(), ...decodeOtlp(await stdin(32 << 10)) });
    output("OTLP export configured.\n");
    return;
  }
  let c = loadConfig();
  if (command === "activate") {
    saveConfig(c);
    return;
  }
  if (command === "enable" || command === "disable") {
    c.disabled = command === "disable";
    saveConfig(c);
    output(`Capture ${command}d. Local records retained.\n`);
    return;
  }
  // worker is the command earlier releases ran for background sync.
  if (command === "sync" || command === "worker") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    try {
      await sync(signIn(), controller.signal);
    } finally {
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
    }
    return;
  }
  if (command === "hook" && c.disabled) return;
  const k = command === "flush" || command === "status" ? signIn() : { apiUrl: "" };
  if (command === "flush") {
    if (!k.token) throw new Error("sign in to Kimchi to report; local records retained");
    if (!kimchiReportingEnabled(c.organizationId))
      throw new Error("Kimchi's PR reporting is off; local records retained");
    // Verify before opening the ledger, so records go only to the account this sign-in owns.
    c = await verifySignIn(k);
  }
  let s = new Store(stateDir(c));
  try {
    switch (command) {
      case "hook": {
        if (args.length !== 2 || !["claude-code", "codex"].includes(args[1]))
          throw new Error("missing hook source");
        let data: Buffer;
        try {
          data = await stdin(4 << 20);
        } catch {
          s.diagnostic("hook_input_too_large");
          return;
        }
        let native: Native;
        try {
          const parsed = parseJson(data.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          native = (args[1] === "codex" ? { event: parsed } : parsed) as Native;
        } catch {
          s.diagnostic("hook_invalid_json");
          return;
        }
        const session = native.sessionId || native.event?.session_id;
        const stage = native.stage || native.event?.hook_event_name;
        const account =
          stage === "session.start" || stage === "SessionStart"
            ? await sessionAccount(c, environmentKey)
            : c;
        let dir: string;
        try {
          dir = sessionStateDir(account, args[1], typeof session === "string" ? session : "");
        } catch {
          s.diagnostic("session_account_binding_failed");
          return;
        }
        if (dir !== s.dir) {
          s.close();
          s = new Store(dir);
        }
        try {
          new Recorder(s, args[1], s.deviceId()).record(native);
        } catch {
          s.diagnostic("hook_capture_failed");
        }
        return;
      }
      case "status":
        output(
          JSON.stringify({
            version,
            disabled: c.disabled ?? false,
            kimchiSignedIn: Boolean(k.token),
            kimchiReporting: kimchiReportingEnabled(c.organizationId),
            reportingVerified: Boolean(k.token) && c.credentialHash === credentialHash(k),
            organizationId: c.organizationId ?? "",
            ledger: stateDir(c),
            accounting: s.status(),
          }) + "\n",
        );
        return;
      case "recover":
      case "flush": {
        for (const source of ["claude-code", "codex"])
          new Recorder(s, source, s.deviceId()).recoverContext();
        if (command === "recover") return;
        while (await flush(s, c, k)) {
          /* durable queue advances only on receipts */
        }
        while (await flushOtlp(s, c)) {
          /* independent destination receipts */
        }
        output("All pending records acknowledged.\n");
        return;
      }
      case "export": {
        if (args.length !== 2 || !["jsonl", "csv"].includes(args[1]))
          throw new Error("export requires jsonl or csv");
        const events = s.events();
        if (args[1] === "jsonl") {
          for (const event of events) output(encodeEvent(event) + "\n");
          return;
        }
        output("event_id,kind,source,work_id,session_id,turn_id,observed_at,usage_json\n");
        for (const event of events)
          output(
            [
              event.id ?? "",
              eventKind(event),
              event.source,
              event.workId ?? "",
              event.sessionId ?? "",
              event.turnId ?? "",
              event.observeTime,
              event.usage ? stringifyJson(event.usage) : "",
            ]
              .map(csvCell)
              .join(",") + "\n",
          );
        return;
      }
      default:
        throw new Error(`unknown command ${JSON.stringify(command)}`);
    }
  } finally {
    s.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  // Hooks and syncs fail silently: Codex shows their output in the session.
  const passive = ["hook", "sync", "worker"].includes(args[0]);
  void run(args).catch((error) => {
    if (!passive) {
      console.error(error instanceof Error ? error.message : "command failed");
      process.exitCode = 1;
    }
  });
}
