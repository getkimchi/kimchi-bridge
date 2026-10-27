import { homedir } from "node:os";
import { join } from "node:path";
import { IdentityError, baseUrl, credentialHash, kimchiSignIn, type SignIn } from "./kimchi.ts";
import {
  decodeOtlp,
  loadConfig,
  saveConfig,
  sessionStateDir,
  stateDir,
  verifySignIn,
  type Config,
} from "./settings.ts";
import {
  loginStatus,
  readLoginProgress,
  signInFlow,
  storedSignIn,
  writeLoginProgress,
  type RegionId,
} from "./oauth.ts";
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

/**
 * The sign-in the plugins report with: an explicit key first, then this
 * helper's own OAuth credential, then Kimchi's saved sign-in (key or SSO).
 */
function resolveSignIn(environmentKey: string | undefined): SignIn {
  if (environmentKey) return kimchiSignIn(environmentKey);
  const stored = storedSignIn();
  if (stored) return stored;
  return kimchiSignIn(environmentKey);
}

// A starting session reports to the account Kimchi's sign-in verifies as. A sign-in that cannot be
// read (Kimchi rewriting auth.json) keeps the verified account, and so does an unreachable API for
// an SSO token of that same organization, as after a token refresh. Otherwise the account is
// unknown, and the session stays on this machine.
async function sessionAccount(c: Config, environmentKey?: string): Promise<Config> {
  let k: SignIn;
  try {
    k = resolveSignIn(environmentKey);
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
      return resolveSignIn(environmentKey);
    } catch {
      return { apiUrl: "" };
    }
  };
  if (!args.length)
    throw new Error(
      "usage: kimchi-bridge status | login | enable | disable | flush | export jsonl|csv | gateway start|run|ensure|stop|status|enable|disable | version",
    );
  const command = args[0];
  if (command === "version") {
    output(version + "\n");
    return;
  }
  if (command === "hint") {
    // One line, and only when the plugin is not set up; silent otherwise.
    const status = await loginStatus();
    if (status.state === "signed-out")
      output(
        "Kimchi is not signed in. Sign in with the /kimchi-login command (or run `kimchi-bridge login` in a terminal) to record work and route model requests through the Kimchi gateway.\n",
      );
    return;
  }
  if (command === "login") {
    const { parseArgs } = await import("node:util");
    if (args[1] === "status") {
      output(JSON.stringify(await loginStatus()) + "\n");
      return;
    }
    const { values } = parseArgs({
      args: args.slice(1),
      allowPositionals: false,
      options: {
        "from-kimchi": { type: "boolean" },
        "no-browser": { type: "boolean" },
        "reporting-only": { type: "boolean" },
        detached: { type: "boolean" },
        foreground: { type: "boolean" },
        region: { type: "string" },
        org: { type: "string" },
      },
    });
    if (values.detached && values.foreground)
      throw new Error("choose --detached or --foreground, not both");
    if (values.region && values.region !== "us" && values.region !== "eu")
      throw new Error("choose region us or eu");
    // The OAuth sign-in waits on a browser callback for up to five minutes;
    // shells driven by agents may not wait that long, so run detached there.
    const detached = values.detached || (!values.foreground && !process.stdout.isTTY);
    if (detached) {
      const child = Bun.spawn(
        [
          process.execPath,
          "login",
          "--foreground",
          ...args.slice(1).filter((arg) => arg !== "--detached"),
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
      );
      child.unref();
      // Give the detached sign-in a moment to record its URL for the message.
      const deadline = Date.now() + 3000;
      let progress;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        progress = readLoginProgress();
        if (progress?.url) break;
      }
      output("CAST AI sign-in started in the background.\n");
      if (progress?.url) output(`If the browser does not open, visit: ${progress.url}\n`);
      output("Watch it finish with: kimchi-bridge login status\n");
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    try {
      writeLoginProgress({ phase: "starting", startedAt: Date.now() });
      const result = await signInFlow({
        fromKimchi: values["from-kimchi"],
        noBrowser: values["no-browser"],
        region: values.region as RegionId | undefined,
        org: values.org,
        signal: controller.signal,
        onMessage: (message) => output(message + "\n"),
        onStarted: (url) => writeLoginProgress({ phase: "waiting", startedAt: Date.now(), url }),
      });
      // Bind the verified account the way every sign-in does, then report it.
      const bound = await verifySignIn(storedSignIn() ?? { apiUrl: "", token: "" });
      output(
        `Reporting configured with your CAST AI sign-in for ${result.credential.orgName}` +
          ` (organization ${bound.organizationId ?? result.credential.orgId}).\n`,
      );
      writeLoginProgress({ phase: "done", startedAt: Date.now(), finishedAt: Date.now() });
      // A successful sign-in turns the gateway on in the matching mode; the
      // opt-out keeps the plugins reporting-only.
      if (!values["reporting-only"]) {
        try {
          const { enable } = await import("./gateway.ts");
          await enable(storedSignIn() ?? { apiUrl: "", token: "" }, (message) =>
            output(message + "\n"),
          );
        } catch (error) {
          output(
            `Gateway not enabled: ${error instanceof Error ? error.message : "unknown error"}\n`,
          );
        }
      } else {
        output("Reporting only; inference settings are unchanged.\n");
      }
    } catch (error) {
      writeLoginProgress({
        phase: "error",
        startedAt: Date.now(),
        error: error instanceof Error ? error.message : "login failed",
        finishedAt: Date.now(),
      });
      throw error;
    } finally {
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
    }
    return;
  }
  if (command === "gateway") {
    const gateway = await import("./gateway.ts");
    const verb = args[1];
    const message = (text: string) => output(text + "\n");
    if (verb === "run") {
      await gateway.runDaemon();
      return;
    }
    if (verb === "start" || verb === "ensure") {
      // --quick is the hook path: spawn and return immediately.
      if (args.includes("--quick")) {
        gateway.ensureQuick();
        return;
      }
      const outcome = await gateway.ensure();
      if (outcome === "unauthenticated") throw new Error("run kimchi-bridge login first");
      output(outcome + "\n");
      return;
    }
    if (verb === "stop") {
      gateway.stop();
      output("Gateway proxy stopped.\n");
      return;
    }
    if (verb === "enable") {
      await gateway.enable(signIn(), message);
      return;
    }
    if (verb === "disable") {
      await gateway.disable(message);
      return;
    }
    if (verb === "status") {
      output(JSON.stringify(await gateway.status()) + "\n");
      return;
    }
    throw new Error("usage: kimchi-bridge gateway start|run|ensure|stop|status|enable|disable");
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
      // An expired OAuth bearer is refreshed before its sign-in is read.
      const { ensureFresh } = await import("./oauth.ts");
      await ensureFresh(controller.signal).catch(() => {});
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
      case "status": {
        const { status: gatewayStatus } = await import("./gateway.ts");
        output(
          JSON.stringify({
            version,
            disabled: c.disabled ?? false,
            kimchiSignedIn: Boolean(k.token),
            reportingVerified: Boolean(k.token) && c.credentialHash === credentialHash(k),
            signInSource: environmentKey
              ? "key"
              : storedSignIn()
                ? "oauth"
                : k.token
                  ? "kimchi"
                  : "none",
            organizationId: c.organizationId ?? "",
            gateway: await gatewayStatus(),
            ledger: stateDir(c),
            accounting: s.status(),
          }) + "\n",
        );
        return;
      }
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
