/**
 * The reconciliation worker's entry point (reconcile-out-of-process plan,
 * chunk B3), bundled to lib/worker.mjs and run by Kimchi's own binary. The
 * parent owns the lease, the timer and the host answers; this process runs one
 * reconciliation pass at a time over the shared ledger library.
 *
 * Startup contract: the parent sends `hello` with its protocol version, its
 * bridge build and the agent directory it expects. The worker refuses (error,
 * non-zero exit) on any mismatch — no mixed versions ever touch one ledger —
 * and refuses an agent directory other than the one it inherited through
 * KIMCHI_CODING_AGENT_DIR. It exits on stdin EOF (parent death), within 2 s,
 * and after 10 idle minutes. Nothing here may import src/platform.ts or
 * bun:ffi: the worker must run on Windows too.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { HostPorts } from "../reconcile/host.js";
import { runReconciliationPass } from "../reconcile/pass.js";
import { setDiagnosticsRedactor } from "../reconcile/work-attribution/diagnostics.js";
import type { ContinuationProgress } from "../reconcile/work-attribution/links.js";
import {
  HostRequestError,
  StdioHostClient,
  StdioTransport,
  type TransportEvent,
} from "./host-client.js";
import {
  PROTOCOL_VERSION,
  type ChannelResult,
  type DoneMessage,
  type HelloMessage,
  type ParentMessage,
  type PassMessage,
  type PassResult,
} from "./protocol.js";

/** The bridge commit, embedded at bundle time; "dev" only outside a git checkout. */
declare const BRIDGE_BUILD: string | undefined;

/** Idle exit: a worker nobody needs for 10 minutes shuts itself down. */
export const IDLE_EXIT_MS = 10 * 60 * 1000;
/** Parent death must end the worker well within 2 s of stdin EOF. */
const PARENT_GONE_EXIT_MS = 1900;

/** Why the pass in flight was aborted. */
type AbortCause = "cancel" | "deadline" | "parent-gone";

/** A pass message with the moment the worker received it; the budget runs from receipt. */
interface QueuedPass {
  message: PassMessage;
  receivedAt: number;
}

/** The state of the pass in flight; the pump and the cancel path share it. */
interface ActivePass {
  id: number;
  controller: AbortController;
  /** The parent controls lease validity: cancel invalidates it for the pass. */
  leaseValid: boolean;
  reason?: AbortCause;
  /** The request kinds whose RPCs failed during this pass. */
  hostFailures: Set<string>;
  pullRequestErrors: unknown[];
  /** Resolves when the pass has reported done. */
  done: Promise<void>;
}

export function resolveWorkerBuild(): string {
  const defined = typeof BRIDGE_BUILD === "undefined" ? undefined : BRIDGE_BUILD;
  if (defined && defined.trim() !== "") return defined;
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (commit) return commit;
  } catch {
    // No git checkout: the release bundle always embeds its commit instead.
  }
  return "dev";
}

/** Keeps a diagnostic on one line: control characters cannot forge log lines. */
function singleLine(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : char;
  }
  return out;
}

/** Expands a leading ~ the way pi-coding-agent's getAgentDir does. */
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * The agent directory this worker inherited, resolved like Kimchi's
 * getAgentDir: KIMCHI_CODING_AGENT_DIR (tilde-expanded), or the SDK default.
 */
export function inheritedAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KIMCHI_CODING_AGENT_DIR;
  if (raw && raw.trim() !== "") return resolve(expandTilde(raw.trim()));
  return resolve(homedir(), ".pi", "agent");
}

/** The refusal reason for a hello the worker must not accept, or undefined. */
export function helloRefusal(
  hello: HelloMessage,
  own: { v: number; build: string; agentDir: string },
): string | undefined {
  if (hello.v !== own.v)
    return "protocol version mismatch: the worker and the parent speak different versions";
  if (hello.build !== own.build)
    return "build mismatch: the worker and the parent were built from different commits";
  // Paths are normalized before comparing, so an equivalent spelling is fine.
  if (resolve(hello.agentDir) !== own.agentDir)
    return `agent directory mismatch: the worker inherits ${own.agentDir}`;
  return undefined;
}

function main(): void {
  const build = resolveWorkerBuild();
  const agentDir = inheritedAgentDir();
  const events: TransportEvent[] = [];
  let wake: (() => void) | undefined;
  const fire = (): void => {
    const listener = wake;
    wake = undefined;
    listener?.();
  };
  let closed = false;
  const exit: (code: number) => never = (code) => {
    if (!closed) {
      closed = true;
      transport.close();
    }
    process.exit(code);
  };
  /** Reports a fatal worker condition to the parent and dies; never carries a token. */
  const refuse: (message: string, id?: number) => never = (message, id) => {
    const redacted = singleLine(transport.redact(message));
    transport.send({ type: "error", message: redacted, ...(id === undefined ? {} : { id }) });
    process.stderr.write(`${redacted}\n`);
    exit(1);
  };
  const transport = new StdioTransport((event) => {
    events.push(event);
    fire();
  });
  // Worker diagnostics flow through the same live secret registry as every
  // other reported line, so a credential in a logged error never persists.
  setDiagnosticsRedactor((text) => transport.redact(text));

  let host: StdioHostClient | undefined;
  const queued: QueuedPass[] = [];
  let active: ActivePass | undefined;
  let parentGone = false;
  let invalidLine: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdleTimer = (): void => {
    stopIdleTimer();
    idleTimer = setTimeout(() => {
      // Ten minutes without a pass: nobody needs this worker any more.
      if (active) active.controller.abort();
      exit(0);
    }, IDLE_EXIT_MS);
  };

  const abortActive = (reason: AbortCause): void => {
    if (!active) return;
    active.leaseValid = false;
    active.reason = active.reason ?? reason;
    active.controller.abort();
  };

  const handleParentMessage = (message: ParentMessage, receivedAt: number): void => {
    switch (message.type) {
      case "hello":
        refuse("the parent sent a second hello; the worker already accepted one");
        break;
      case "pass": {
        if (message.channels.reporting && message.reportingCwd === undefined) {
          refuse("a pass with the reporting channel needs reportingCwd", message.id);
          break;
        }
        queued.push({ message, receivedAt });
        break;
      }
      case "cancel": {
        // A cancel for a finished or unknown pass is ignored; the parent may
        // not know which pass was in flight when it sent it. A cancel for a
        // pass still waiting in the queue drops it before it ever starts: it
        // is answered with a canceled done and never touches the host or the
        // ledger. The pump drains parent messages before starting a queued
        // pass, so no window exists where a canceled pass could begin.
        if (active?.id === message.id) {
          abortActive("cancel");
          break;
        }
        const index = queued.findIndex((entry) => entry.message.id === message.id);
        if (index !== -1) {
          const [entry] = queued.splice(index, 1);
          transport.send(canceledDone(entry.message));
        }
        break;
      }
      case "reply":
        // A late or duplicate reply: the request it belonged to already
        // timed out or was answered. Never guessed from, never answered twice.
        break;
    }
  };

  /** The continuation repair state the supervisor used to hold in memory. */
  const continuation: ContinuationProgress = {};

  /** The done message for a pass that was canceled before it ever started. */
  const canceledDone = (message: PassMessage): DoneMessage => ({
    type: "done",
    id: message.id,
    result: {
      outcome: "canceled",
      channels: Object.fromEntries(
        Object.entries(message.channels)
          .filter(([, requested]) => requested)
          .map(([name]) => [name, { outcome: "canceled" }]),
      ) as PassResult["channels"],
    },
  });

  const startPass = (entry: QueuedPass): void => {
    const { message } = entry;
    // A pass whose budget ran out while it was queued is reported without
    // running: no pass-started progress, no host request, no ledger write.
    if (entry.receivedAt + message.deadlineMs - Date.now() <= 0) {
      transport.send(expiredDone(message));
      armIdleTimer();
      fire();
      return;
    }
    stopIdleTimer();
    let finished: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const state: ActivePass = {
      id: message.id,
      controller: new AbortController(),
      leaseValid: true,
      hostFailures: new Set<string>(),
      pullRequestErrors: [],
      done,
    };
    active = state;
    transport.activePassId = message.id;
    transport.send({ type: "progress", id: message.id, note: "pass-started" });
    void runPass(message, state, entry.receivedAt + message.deadlineMs)
      .catch(() => {})
      .finally(() => {
        if (active === state) {
          active = undefined;
          transport.activePassId = 0;
        }
        armIdleTimer();
        finished();
        fire();
      });
  };

  /**
   * Records a failed host request against the pass and cancels it when the
   * failure was a cancel that arrived while the request was blocked.
   */
  const noteHostFailure = (state: ActivePass, error: unknown): void => {
    if (error instanceof HostRequestError) {
      state.hostFailures.add(error.requestKind);
      if (error.cause === "canceled") abortActive("cancel");
      if (error.cause === "deadline") abortActive("deadline");
    }
  };

  const runPass = async (
    message: PassMessage,
    state: ActivePass,
    deadlineAt: number,
  ): Promise<void> => {
    // The budget is measured from receipt: a pass queued behind another one
    // starts with whatever remained. startPass already refused one that ran
    // out in the queue; this guards the window between that check and the
    // first host read.
    transport.deadlineAt = deadlineAt;
    const deadline = setTimeout(() => abortActive("deadline"), deadlineAt - Date.now());
    const base = host as StdioHostClient;
    // Every host read is observed, so a failed request reaches the done
    // message even where the pass swallows the channel error into its debug log.
    const observingHost: HostPorts = {
      agentDir: base.agentDir,
      // Bound like metric below: an unbound method reads the decorator's
      // fields, not the client's seams.
      e2eSeam: (name: string) => base.e2eSeam(name),
      now: base.now,
      metric: base.metric.bind(base),
      fetch: base.fetch,
      credentials(cwd) {
        try {
          return base.credentials(cwd);
        } catch (error) {
          noteHostFailure(state, error);
          throw error;
        }
      },
      endpoints(cwd) {
        try {
          return base.endpoints(cwd);
        } catch (error) {
          noteHostFailure(state, error);
          throw error;
        }
      },
      orgPolicy() {
        try {
          return base.orgPolicy();
        } catch (error) {
          noteHostFailure(state, error);
          throw error;
        }
      },
      telemetryConsent() {
        try {
          return base.telemetryConsent();
        } catch (error) {
          noteHostFailure(state, error);
          throw error;
        }
      },
    };
    let nextRepository: string | undefined;
    let observedChannels: Record<string, ObservedChannel> | undefined;
    let passError: unknown;
    try {
      const result = await runReconciliationPass(
        {
          ...(message.channels.files ? { files: true } : {}),
          ...(message.channels.pullRequests
            ? {
                pullRequests: {
                  onError: (error) => state.pullRequestErrors.push(error),
                },
              }
            : {}),
          ...(message.channels.costs ? { costs: true } : {}),
          ...(message.channels.reporting
            ? { reporting: { cwd: message.reportingCwd as string } }
            : {}),
          ...(message.nextRepository === undefined
            ? {}
            : { nextRepository: message.nextRepository }),
          progress: continuation,
        },
        observingHost,
        {
          signal: state.controller.signal,
          assertLease: () => {
            if (!state.leaseValid) throw new Error("the reconciliation lease was lost");
            state.controller.signal.throwIfAborted();
          },
        },
      );
      nextRepository = result.nextRepository;
      observedChannels = channelObservations(result);
    } catch (error) {
      passError = error;
    }
    transport.deadlineAt = 0;
    clearTimeout(deadline);
    transport.send(buildDoneMessage(message, state, nextRepository, passError, observedChannels));
  };

  /** The done message for a pass whose budget ran out while it was queued. */
  const expiredDone = (message: PassMessage): DoneMessage => ({
    type: "done",
    id: message.id,
    result: {
      outcome: "failed",
      channels: Object.fromEntries(
        Object.entries(message.channels)
          .filter(([, requested]) => requested)
          .map(([name]) => [name, { outcome: "failed", error: "the pass exceeded its deadline" }]),
      ) as PassResult["channels"],
    },
  });

  /** Which request kinds a channel's code can ask the parent for. */
  const CHANNEL_REQUESTS: Record<string, string[]> = {
    files: [],
    pullRequests: [],
    costs: ["credentials", "endpoints"],
    reporting: ["credentials", "endpoints", "consent"],
  };

  /** A channel outcome the pass itself reported for its own result. */
  interface ObservedChannel {
    outcome: "ok" | "failed" | "canceled" | "skipped";
    error?: unknown;
  }

  /** The pass result's per-channel outcomes, when the result carries them. */
  function channelObservations(result: {
    nextRepository?: string;
  }): Record<string, ObservedChannel> | undefined {
    const channels = (result as { channels?: unknown }).channels;
    if (typeof channels !== "object" || channels === null) return undefined;
    return channels as Record<string, ObservedChannel>;
  }

  /** Translates a channel outcome the pass reported into the wire shape. */
  const channelResultFrom = (
    observed: ObservedChannel,
    errorText: (error: unknown) => string,
  ): ChannelResult =>
    observed.outcome === "ok"
      ? { outcome: "ok" }
      : observed.outcome === "skipped"
        ? { outcome: "canceled" }
        : observed.outcome === "canceled"
          ? { outcome: "canceled" }
          : {
              outcome: "failed",
              ...(observed.error === undefined ? {} : { error: errorText(observed.error) }),
            };

  const buildDoneMessage = (
    message: PassMessage,
    state: ActivePass,
    nextRepository: string | undefined,
    passError: unknown,
    observed?: Record<string, ObservedChannel>,
  ): DoneMessage => {
    const aborted = state.controller.signal.aborted;
    const canceled = aborted && state.reason !== "deadline";
    const errorText = (error: unknown): string => transport.redact(describe(error));
    const channels: PassResult["channels"] = {};
    for (const [name, requested] of Object.entries(message.channels) as [string, boolean][]) {
      if (!requested) continue;
      if (canceled) {
        channels[name as keyof PassResult["channels"]] = { outcome: "canceled" };
        continue;
      }
      if (aborted) {
        channels[name as keyof PassResult["channels"]] = {
          outcome: "failed",
          error: "the pass exceeded its deadline",
        };
        continue;
      }
      // A channel outcome the pass itself reported wins over inference.
      const reported = observed?.[name];
      if (reported !== undefined) {
        channels[name as keyof PassResult["channels"]] = channelResultFrom(reported, errorText);
        continue;
      }
      // A failure that escaped the pass fails every requested channel: the
      // pass never reached the point where a channel could report for itself.
      if (passError !== undefined) {
        channels[name as keyof PassResult["channels"]] = {
          outcome: "failed",
          error: errorText(passError),
        };
        continue;
      }
      const kinds = CHANNEL_REQUESTS[name] ?? [];
      if (state.hostFailures.size > 0 && kinds.some((kind) => state.hostFailures.has(kind))) {
        channels[name as keyof PassResult["channels"]] = {
          outcome: "failed",
          error: "a host request failed",
        };
        continue;
      }
      if (name === "pullRequests" && state.pullRequestErrors.length > 0) {
        channels[name as keyof PassResult["channels"]] = {
          outcome: "failed",
          error: errorText(state.pullRequestErrors[0]),
        };
        continue;
      }
      channels[name as keyof PassResult["channels"]] = { outcome: "ok" };
    }
    const channelFailed = Object.values(channels).some((channel) => channel?.outcome === "failed");
    const outcome = aborted
      ? canceled
        ? "canceled"
        : "failed"
      : passError !== undefined || channelFailed
        ? "failed"
        : "ok";
    return {
      type: "done",
      id: message.id,
      result: {
        outcome,
        channels,
        ...(nextRepository === undefined ? {} : { nextRepository }),
        // txDurations is filled by chunk B4's transaction budget.
      },
    };
  };

  const describe = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const awaitFirstEvent = async (): Promise<TransportEvent> => {
    for (;;) {
      const event = events.shift();
      if (event) return event;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  const pump = async (): Promise<void> => {
    for (;;) {
      // Drain everything that is already ready: parent messages first, so a
      // cancel reaches the pass in flight before the next pass is started.
      for (;;) {
        if (parentGone) {
          // stdin EOF is parent death: stop the pass, let it unwind, and leave.
          if (active) abortActive("parent-gone");
          const hardExit = setTimeout(() => exit(0), PARENT_GONE_EXIT_MS);
          if (active) await active.done;
          clearTimeout(hardExit);
          exit(0);
        }
        if (invalidLine !== undefined) {
          refuse(`the parent sent an invalid protocol line: ${invalidLine}`);
        }
        const event = events.shift();
        if (event) {
          if (event.kind === "message") handleParentMessage(event.message, event.receivedAt);
          else if (event.kind === "invalid-line") invalidLine = event.reason;
          else if (event.kind === "parent-gone") parentGone = true;
          else refuse(`worker transport failed: ${event.reason}`);
          continue;
        }
        if (!active && queued.length > 0) {
          // A cancel sent right behind the pass (a lease lost just after its
          // tick) can still be queued behind this microtask; give it one
          // macrotask to land before the pass is allowed to begin. If it
          // lands, the drain above drops the pass instead of starting it.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (events.length > 0 || parentGone || invalidLine !== undefined) continue;
          startPass(queued.shift() as QueuedPass);
          continue;
        }
        break;
      }
      // A new event, the end of the pass in flight, or nothing pending at all.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  const first = awaitFirstEvent();
  void first.then(async (event) => {
    if (event.kind !== "message" || event.message.type !== "hello")
      refuse("the first message must be hello");
    const refusal = helloRefusal(event.message, { v: PROTOCOL_VERSION, build, agentDir });
    if (refusal) refuse(refusal);
    host = new StdioHostClient(transport, event.message);
    transport.send({ type: "ready", v: PROTOCOL_VERSION, build });
    armIdleTimer();
    // A crash outside the pass must not take the ledger silently: report and die.
    process.on("uncaughtException", (error) => {
      refuse(`uncaught worker error: ${describe(error)}`);
    });
    process.on("unhandledRejection", (reason) => {
      refuse(`unhandled worker rejection: ${describe(reason)}`);
    });
    await pump();
  });
}

void (async () => {
  main();
})();
