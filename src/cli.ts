import { homedir } from "node:os";
import { join } from "node:path";
import { Recorder, type Native } from "./capture.ts";
import { CredentialHash, Flush, FlushOTLP, type SignIn } from "./delivery.ts";
import { Open } from "./ledger.ts";
import { EncodeEvent, Kind, Parse, Stringify } from "./protocol.ts";
import {
  DecodeOTLP,
  KimchiSignIn,
  Load,
  Save,
  SessionStateDir,
  StateDir,
  Verify,
} from "./settings.ts";
import { Run as Sync } from "./sync.ts";

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

export async function Run(
  args: string[],
  stdin = input,
  output: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): Promise<void> {
  const environmentKey = process.env.KIMCHI_API_KEY;
  delete process.env.KIMCHI_API_KEY;
  // Unreadable Kimchi settings mean no sign-in: local recording continues, uploads wait.
  const signIn = (): SignIn => {
    try {
      return KimchiSignIn(environmentKey);
    } catch {
      return { apiUrl: "" };
    }
  };
  if (!args.length)
    throw new Error(
      "usage: kimchi-adapters status | enable | disable | flush | export jsonl|csv | version",
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
      process.env.KIMCHI_ADAPTERS_PREFIX || join(homedir(), ".local", "share", "kimchi-adapters");
    const proc = Bun.spawn(["bash", join(prefix, "install.sh"), ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) throw new Error("installer command failed");
    return;
  }
  if (command === "configure") {
    Save({ ...Load(), ...DecodeOTLP(await stdin(32 << 10)) });
    output("OTLP export configured.\n");
    return;
  }
  let c = Load();
  if (command === "enable" || command === "disable") {
    c.disabled = command === "disable";
    Save(c);
    output(`Capture ${command}d. Local records retained.\n`);
    return;
  }
  if (command === "sync" || command === "worker") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    try {
      await Sync(signIn(), controller.signal);
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
    // Verify before opening the ledger, so records go only to the account this sign-in owns.
    c = await Verify(k);
  }
  let s = Open(StateDir(c));
  try {
    switch (command) {
      case "hook": {
        if (args.length !== 2 || !["claude-code", "codex"].includes(args[1]))
          throw new Error("missing hook source");
        let data: Buffer;
        try {
          data = await stdin(4 << 20);
        } catch {
          s.Diagnostic("hook_input_too_large");
          return;
        }
        let native: Native;
        try {
          const parsed = Parse(data.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          native = (args[1] === "codex" ? { event: parsed } : parsed) as Native;
        } catch {
          s.Diagnostic("hook_invalid_json");
          return;
        }
        const session = native.sessionId || native.event?.session_id;
        // A session reports to the account Kimchi was signed in to when it started.
        let account = c;
        const stage = native.stage || native.event?.hook_event_name;
        if (stage === "session.start" || stage === "SessionStart") {
          const current = signIn();
          account = {};
          if (current.token)
            account = await Verify(current, AbortSignal.timeout(1000)).catch(() => c);
        }
        let dir: string;
        try {
          dir = SessionStateDir(account, args[1], typeof session === "string" ? session : "");
        } catch {
          s.Diagnostic("session_account_binding_failed");
          return;
        }
        if (dir !== s.Dir) {
          s.Close();
          s = Open(dir);
        }
        try {
          new Recorder(s, args[1], s.DeviceID()).Record(native);
        } catch {
          s.Diagnostic("hook_capture_failed");
        }
        return;
      }
      case "status":
        output(
          JSON.stringify({
            version,
            disabled: c.disabled ?? false,
            kimchiSignedIn: Boolean(k.token),
            reportingVerified: Boolean(k.token) && c.credentialHash === CredentialHash(k),
            organizationId: c.organizationId ?? "",
            ledger: StateDir(c),
            accounting: s.Status(),
          }) + "\n",
        );
        return;
      case "recover":
      case "flush": {
        for (const source of ["claude-code", "codex"])
          new Recorder(s, source, s.DeviceID()).RecoverContext();
        if (command === "recover") return;
        while (await Flush(s, c, k)) {
          /* durable queue advances only on receipts */
        }
        while (await FlushOTLP(s, c)) {
          /* independent destination receipts */
        }
        output("All pending records acknowledged.\n");
        return;
      }
      case "export": {
        if (args.length !== 2 || !["jsonl", "csv"].includes(args[1]))
          throw new Error("export requires jsonl or csv");
        const events = s.Events();
        if (args[1] === "jsonl") {
          for (const event of events) output(EncodeEvent(event) + "\n");
          return;
        }
        output("event_id,kind,source,work_id,session_id,turn_id,observed_at,usage_json\n");
        for (const event of events)
          output(
            [
              event.id ?? "",
              Kind(event),
              event.source,
              event.workId ?? "",
              event.sessionId ?? "",
              event.turnId ?? "",
              event.observeTime,
              event.usage ? Stringify(event.usage) : "",
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
    s.Close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const passive = ["hook", "sync", "worker"].includes(args[0]);
  void Run(args).catch((error) => {
    if (!passive) {
      console.error(error instanceof Error ? error.message : "command failed");
      process.exitCode = 1;
    }
  });
}
