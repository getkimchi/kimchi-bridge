import type { Native } from "./capture.ts";
import { ActivityStore } from "./activity-store.ts";
import { flushAllActivities } from "./activity-delivery.ts";
import { parseJson } from "./protocol.ts";
import { workspaceActivityState, workspaceActivityURL } from "./workspace.ts";

export interface WorkspaceIO {
  readHookInput(): Promise<Buffer>;
  output(text: string): void;
}

/** No account discovery, OAuth refresh, PR Git work, or public HTTP request lives here. */
export async function workspaceCommand(
  command: string,
  args: string[],
  io: WorkspaceIO,
): Promise<void> {
  const store = new ActivityStore(workspaceActivityState());
  try {
    switch (command) {
      case "hook": {
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
          await flushAllActivities(store, workspaceActivityURL(), AbortSignal.timeout(1500));
        } catch {
          store.diagnostic("activity_delivery_pending");
        }
        return;
      }
      case "flush": {
        await flushAllActivities(store, workspaceActivityURL());
        io.output("All pending activity records acknowledged.\n");
        return;
      }
      case "status": {
        io.output(
          JSON.stringify({ profile: "workspace", ledger: store.dir, ...store.status() }) + "\n",
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
