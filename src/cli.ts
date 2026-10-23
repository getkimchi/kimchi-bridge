import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Recorder, type Native } from "./capture.ts";
import { Authenticate, Flush, FlushOTLP } from "./delivery.ts";
import { Open } from "./ledger.ts";
import { EncodeEvent, Kind, NewID, Parse, Stringify } from "./protocol.ts";
import { Decode, Load, Save, SessionStateDir, StateDir } from "./settings.ts";
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
  if (!args.length)
    throw new Error(
      "usage: kimchi-adapters status | login | configure | enable | disable | flush | export jsonl|csv | version",
    );
  const command = args[0];
  if (command === "version") {
    output(version + "\n");
    return;
  }
  if (command === "login") {
    const { Login } = await import("./login.ts");
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        "from-kimchi": { type: "boolean" },
        "if-present": { type: "boolean" },
        "no-browser": { type: "boolean" },
        region: { type: "string" },
      },
    });
    if (positionals.length > 1)
      throw new Error("login accepts at most one self-hosted console URL");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    try {
      await Login({
        fromKimchi: values["from-kimchi"],
        ifPresent: values["if-present"],
        noBrowser: values["no-browser"],
        region: values.region,
        consoleUrl: positionals[0],
        environmentKey,
        signal: controller.signal,
        onMessage: (message) => output(message + "\n"),
      });
    } finally {
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
    }
    return;
  }
  if (command === "update" || command === "uninstall") {
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
    const bytes = await stdin(32 << 10);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(bytes.toString("utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    } catch {
      throw new Error("invalid configuration JSON");
    }
    if (environmentKey) {
      config.apiKey = environmentKey;
      delete config.accessToken;
    }
    const c = await Authenticate(Decode(Buffer.from(JSON.stringify(config))));
    const previous = Load();
    Save({
      ...c,
      enabled: true,
      runtimeExecutable: previous.runtimeExecutable,
      runtimeRevision: previous.runtimeRevision,
      disabled: previous.disabled,
    });
    output("Reporting configured. Inference settings are unchanged.\n");
    return;
  }
  const c = Load();
  if (command === "activate") {
    c.runtimeExecutable = realpathSync(process.execPath);
    c.runtimeRevision = NewID();
    Save(c);
    return;
  }
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
      await Sync(c, controller.signal);
    } finally {
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
    }
    return;
  }
  if (command === "hook" && c.disabled) return;
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
        let dir: string;
        try {
          dir = SessionStateDir(c, args[1], typeof session === "string" ? session : "");
        } catch {
          s.Diagnostic("session_account_binding_failed");
          return;
        }
        if (dir !== s.Dir) {
          s.Close();
          s = Open(dir);
        }
        try {
          await new Recorder(s, args[1], s.DeviceID()).Record(native);
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
            reportingConfigured: c.enabled ?? false,
            organizationId: c.organizationId ?? "",
            ledger: StateDir(c),
            accounting: s.Status(),
          }) + "\n",
        );
        return;
      case "recover":
      case "flush": {
        for (const source of ["claude-code", "codex"])
          await new Recorder(s, source, s.DeviceID()).RecoverContext();
        if (command === "recover") return;
        if (!c.enabled) throw new Error("reporting login required; local records retained");
        while (await Flush(s, c)) {
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
