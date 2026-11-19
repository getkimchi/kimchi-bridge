import type { Native } from "./capture.ts";
import { ActivityStore } from "./activity-store.ts";
import { loadConfig } from "../settings.ts";
import { drainActivities, flushAllActivities } from "./activity-delivery.ts";
import { parseJson, stringifyJson } from "./protocol.ts";
import { workspaceActivityState, workspaceActivityURL } from "./workspace.ts";

export interface WorkspaceIO {
  readHookInput(): Promise<Buffer>;
  output(text: string): void;
}

function csvCell(value: string): string {
  const safe = ["=", "+", "-", "@", "\t", "\r"].includes(value[0]) ? "'" + value : value;
  return ['"', ",", "\r", "\n"].some((char) => value.includes(char))
    ? `"${safe.replaceAll('"', '""')}"`
    : safe;
}

/** No account discovery, OAuth refresh, PR Git work, or public HTTP request lives here. */
export async function workspaceCommand(
  command: string,
  args: string[],
  io: WorkspaceIO,
  signal?: AbortSignal,
): Promise<void> {
  const store = new ActivityStore(workspaceActivityState());
  try {
    switch (command) {
      case "hook": {
        store.pruneIfDue();
        if (args.length !== 2 || !["claude-code", "codex"].includes(args[1]))
          throw new Error("missing hook source");
        let data: Buffer;
        try {
          data = await io.readHookInput();
        } catch {
          store.diagnostic("activity_hook_too_large");
          return;
        }
        try {
          const parsed = parseJson(data.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          const native: Native =
            args[1] === "codex"
              ? { event: parsed }
              : typeof parsed.hook_event_name === "string"
                ? { stage: `classic.${parsed.hook_event_name}`, event: parsed }
                : parsed;
          store.observe(native, args[1] as "claude-code" | "codex");
        } catch {
          store.diagnostic("activity_capture_failed");
          return;
        }
        try {
          await flushAllActivities(
            store,
            workspaceActivityURL(),
            signal
              ? AbortSignal.any([signal, AbortSignal.timeout(1500)])
              : AbortSignal.timeout(1500),
          );
        } catch {
          store.diagnostic("activity_delivery_pending");
        }
        return;
      }
      case "flush": {
        store.pruneIfDue();
        await drainActivities(store, workspaceActivityURL(), signal);
        io.output("All pending activity records acknowledged.\n");
        return;
      }
      case "sync": {
        store.pruneIfDue();
        if (loadConfig().disabled) return;
        try {
          await flushAllActivities(store, workspaceActivityURL(), signal);
        } catch {
          store.diagnostic("activity_delivery_pending");
        }
        return;
      }
      case "status": {
        io.output(
          JSON.stringify({ profile: "workspace", ledger: store.dir, ...store.status() }) + "\n",
        );
        return;
      }
      case "export": {
        if (args.length !== 2 || !["jsonl", "csv"].includes(args[1]))
          throw new Error("export requires jsonl or csv");
        const events = store.allEvents();
        if (args[1] === "jsonl") {
          for (const event of events) io.output(stringifyJson(event) + "\n");
          return;
        }
        io.output("event_id,variant,source,trajectory_id,turn_id,occurred_at,event_json\n");
        for (const event of events)
          io.output(
            [
              event.eventId,
              event.action ? "action" : "observation",
              event.agent?.platform ?? "",
              event.trajectoryId ?? "",
              event.turnId ?? "",
              event.occurredAt,
              stringifyJson(event),
            ]
              .map(csvCell)
              .join(",") + "\n",
          );
        return;
      }
      default:
        throw new Error(`workspace mode does not run ${JSON.stringify(command)}`);
    }
  } finally {
    store.close();
  }
}
