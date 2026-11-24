/**
 * The journal-write model the reconcile passes need, extracted from Kimchi's
 * work-attribution.ts extension entry. Only the pieces reconciliation uses moved:
 * the segment shape, the work context, the continuation receipt shape, the session
 * journal path, the resource gate and the durable append. The session-side
 * machinery — identity caching (getWorkId), tool-request tracking (getToolRequest),
 * context pinning (pinWorkContext), the in-memory workOutputs cache that Kimchi's
 * hasWorkOutput reads, and every pi/extension hook — stays in Kimchi and wraps
 * this module (chunk K1).
 *
 * appendWorkRecord drops Kimchi's session-local workOutputs map: it existed only as
 * a warm cache for Kimchi's hasWorkOutput check, whose durable authority is
 * ledgerHasWorkOutput. Kimchi's session wrapper keeps maintaining its own map, so
 * session behavior is unchanged. The work id is required here: only the session
 * process can resolve a missing one (getWorkId), and every reconcile call site
 * already passes it explicitly.
 */
import { join } from "node:path";
import { capture } from "../ledger/records.js";
import { hostPorts } from "./host-ports.js";
import { debugWorkAttribution } from "./work-attribution/diagnostics.js";
import { COST_PER_PR_RESOURCE_ID } from "./work-attribution/resource.js";
import { object, type WorkRecord } from "./work-attribution/summary.js";
import type { WorkAccount } from "./work-attribution/scope.js";

export interface WorkSegment {
  id: string;
  attribution: "explicit" | "inferred" | "session" | "unknown";
  reason: string;
}
export function isWorkSegment(value: unknown): value is WorkSegment {
  return (
    object(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.reason === "string" &&
    !!value.reason &&
    (value.attribution === "explicit" ||
      value.attribution === "inferred" ||
      value.attribution === "session" ||
      value.attribution === "unknown")
  );
}
export interface WorkContext {
  cwd: string;
  sessionManager: Pick<{ getSessionId: () => string }, "getSessionId">;
  /** Queued local children retain the work selected at spawn. */
  workId?: string;
  /** Null pins the absence of a segment before a later input creates one. */
  segment?: WorkSegment | null;
}

/** A continuation receipt's durable shape, extracted from Kimchi's work-attribution/continuation.ts. */
export interface WorkContinuation {
  workId: string;
  source: "saved-plan" | "pasted-plan" | "named-artifact" | "semantic";
  evidence: {
    path: string;
    contentHash?: string;
    requestId?: string;
    transitionId?: string;
    repository?: string;
    worktree?: string;
    branch?: string;
    recordedAt?: string;
    model?: string;
    decision?: "same" | "continue" | "new" | "unknown";
    inputHash?: string;
    segmentId?: string;
    promptVersion?: number;
    candidateWorkIds?: string[];
    account?: WorkAccount;
  };
}

export function workLedgerPath(ctx: WorkContext): string {
  // Session IDs also come from imported sessions; never interpret them as paths.
  return join(
    getAgentDir(),
    "work-attribution",
    `${encodeURIComponent(ctx.sessionManager.getSessionId())}.jsonl`,
  );
}

/** Kimchi's agent directory: HostPorts.agentDir, kept as a helper for the extracted code. */
export function getAgentDir(): string {
  return hostPorts().agentDir;
}

/** Attribution is observational: callers may continue without IDs after a persistence failure. */
export function tryWorkAttribution<T>(record: () => T): T | undefined {
  // With Cost per PR disabled, no work is recorded through this wrapper.
  if (!hostPorts().orgPolicy().resourceEnabled(COST_PER_PR_RESOURCE_ID)) return undefined;
  try {
    return record();
  } catch (error) {
    debugWorkAttribution("Attribution unavailable:", error);
    return undefined;
  }
}
export async function tryWorkAttributionAsync<T>(record: () => Promise<T>): Promise<T | undefined> {
  if (!hostPorts().orgPolicy().resourceEnabled(COST_PER_PR_RESOURCE_ID)) return undefined;
  try {
    return await record();
  } catch (error) {
    debugWorkAttribution("Attribution unavailable:", error);
    return undefined;
  }
}
export function appendWorkRecord(
  ctx: WorkContext,
  fields: { type: string; [key: string]: unknown },
  workId: string,
  workLedger?: string,
): void {
  const record = {
    ...fields,
    version: 1,
    sessionId: ctx.sessionManager.getSessionId(),
    workId,
    cwd: ctx.cwd,
    recordedAt: new Date().toISOString(),
  };
  // The journal path stays a provenance pointer for the C3 importer; the durable write is the ledger.
  capture(getAgentDir(), record as WorkRecord, workLedger ?? workLedgerPath(ctx));
}
