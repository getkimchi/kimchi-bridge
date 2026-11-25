import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { hostPorts } from "../host-ports.js";
import { pinAgentDir } from "../../ledger/store.js";

/** Redacts a diagnostics line before it is persisted; set by the worker process. */
let redactLine: ((text: string) => string) | undefined;

/**
 * Registers the redactor for diagnostics lines. The worker process sets this
 * so its live secret registry scrubs credentials from every logged error;
 * unset, lines are persisted as formatted.
 */
export function setDiagnosticsRedactor(redactor: ((text: string) => string) | undefined): void {
  redactLine = redactor;
}

/** Opt-in diagnostics must never write through the live TUI or ACP transport. */
export function debugWorkAttribution(message: string, ...details: unknown[]): void {
  // Bun's debuglog lacks Node's enabled getter. Match NODE_DEBUG without calling its stderr logger.
  const namespaces = (process.env.NODE_DEBUG ?? "")
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/,/g, "$|^");
  if (!new RegExp(`^${namespaces}$`, "i").test("kimchi:work-attribution")) return;
  try {
    const directory = join(pinAgentDir(hostPorts().agentDir), "logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const line = format(message, ...details);
    appendFileSync(
      join(directory, "work-attribution.log"),
      `${new Date().toISOString()} ${process.pid} ${redactLine === undefined ? line : redactLine(line)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics cannot interrupt a request or fall back to terminal output.
  }
}
