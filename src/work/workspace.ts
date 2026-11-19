import { isAbsolute, join } from "node:path";
import { stateRoot } from "../settings.ts";

export const workspaceActivityPath = "/imds/tool-calls:batchRecord";

/** Keep workspace records local without requiring or contacting a receiver. */
export function workspaceActivityDryRun(): boolean {
  return process.env.KIMCHI_BRIDGE_ACTIVITY_DRY_RUN === "1";
}

/** Workspace capture never selects an account or reads Kimchi credentials. */
export function workspaceActivityEnabled(): boolean {
  const profile = process.env.KIMCHI_BRIDGE_PROFILE ?? "";
  if (profile && profile !== "workspace") throw new Error("unknown bridge profile");
  return profile === "workspace";
}

/** An explicit loopback route is required during this development increment. */
export function workspaceActivityURL(): string {
  const value = process.env.KIMCHI_BRIDGE_ACTIVITY_URL ?? "";
  if (!value || value.includes("\r") || value.includes("\n") || value.includes("\0"))
    throw new Error("an explicit local activity endpoint is required");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== workspaceActivityPath
  )
    throw new Error("activity development replay requires a loopback record endpoint");
  return value;
}

export function workspaceActivityState(): string {
  const root = stateRoot();
  if (!isAbsolute(root)) throw new Error("absolute bridge state is required");
  return join(root, "workspace-activity");
}
