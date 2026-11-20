import { isAbsolute, join } from "node:path";
import { stateRoot } from "../settings.ts";

export const workspaceActivityPath = "/imds/tool-calls:batchRecord";

/** Keep workspace records local without requiring or contacting a receiver. */
export function workspaceActivityDryRun(): boolean {
  return process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN === "1";
}

/** Rich tool payloads are an explicit per-launch exception to private capture. */
export function workspaceActivityIncludeSensitive(): boolean {
  return process.env.KIMCHI_BRIDGE_ACTIVITY_INCLUDE_SENSITIVE === "1";
}

/** Workspace capture never selects an account or reads Kimchi credentials. */
export function workspaceActivityEnabled(): boolean {
  const profile = process.env.KIMCHI_BRIDGE_PROFILE ?? "";
  if (profile && profile !== "workspace") throw new Error("unknown bridge profile");
  return profile === "workspace";
}

/** Allow a loopback replay receiver or the sandbox sidekick's exact IMDS destination. */
export function workspaceActivityURL(): string {
  const value = process.env.KIMCHI_BRIDGE_ACTIVITY_URL ?? "";
  if (!value || value.includes("\r") || value.includes("\n") || value.includes("\0"))
    throw new Error("an explicit local or sidekick activity endpoint is required");
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const sidekick = url.origin === "http://__imds.kimchi.internal";
  if (
    (!loopback && !sidekick) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== workspaceActivityPath
  )
    throw new Error(
      "activity endpoint must be a loopback receiver or http://__imds.kimchi.internal/imds/tool-calls:batchRecord",
    );
  return value;
}

export function workspaceActivityState(): string {
  const root = stateRoot();
  if (!isAbsolute(root)) throw new Error("absolute bridge state is required");
  return join(root, "workspace-activity");
}
