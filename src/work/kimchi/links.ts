import {
  isWorkId,
  isWorkScope,
  isWorkSegment,
  sameScope,
  type SameAccount,
  type WorkRecord,
} from "./records.ts";

/** The works a request was moved to by its link records, and whether that move can be trusted. */
export interface RequestLink {
  workIds: Set<string>;
  linkIds: Set<string>;
  unresolved: boolean;
}

/**
 * The corrections that name each request: a `/work link` command, or the harness confirming the
 * input that produced a continued plan or artifact. Direct request corrections only: sessions are
 * never merged and work links are never followed transitively. A link whose latest revision is
 * contradictory, revoked, out of scope or unproven leaves its requests unresolved.
 */
export function requestWorkLinks(
  records: readonly WorkRecord[],
  sameAccount: SameAccount,
): Map<string, RequestLink> {
  const groups = new Map<string, WorkRecord[]>();
  const requests = new Map<string, WorkRecord[]>();
  const workRequests = new Map<string, WorkRecord[]>();
  for (const row of records) {
    if (row.type === "request" && typeof row.requestId === "string") {
      const copies = requests.get(row.requestId) ?? [];
      copies.push(row);
      requests.set(row.requestId, copies);
      const work = workRequests.get(row.workId) ?? [];
      work.push(row);
      workRequests.set(row.workId, work);
    }
    if (row.type === "work_link" && typeof row.linkId === "string") {
      const history = groups.get(row.linkId) ?? [];
      history.push(row);
      groups.set(row.linkId, history);
    }
  }
  const result = new Map<string, RequestLink>();
  for (const [linkId, rows] of groups) {
    const revision = Math.max(
      ...rows.map((row) => (typeof row.revision === "number" ? row.revision : 0)),
    );
    const latest = rows.filter((row) => row.revision === revision);
    const selected = latest[0];
    const fingerprints = new Set(
      latest.map((row) =>
        JSON.stringify([
          row.workId,
          row.sourceWorkId,
          row.targetWorkId,
          row.status,
          isWorkScope(row.scope)
            ? [
                row.scope.repository,
                row.scope.account.apiUrl,
                row.scope.account.organizationId,
                row.scope.account.userId,
              ]
            : null,
          Array.isArray(row.requestIds) ? [...row.requestIds].sort() : null,
          row.evidence,
        ]),
      ),
    );
    const ids = new Set(
      rows.flatMap((row) =>
        Array.isArray(row.requestIds)
          ? row.requestIds.filter((id): id is string => typeof id === "string")
          : [],
      ),
    );
    const scope = selected && isWorkScope(selected.scope) ? selected.scope : undefined;
    const target =
      selected && typeof selected.targetWorkId === "string" ? selected.targetWorkId : "";
    const targetRequests = workRequests.get(target) ?? [];
    const selectedIds: unknown[] = Array.isArray(selected?.requestIds) ? selected.requestIds : [];
    const evidence =
      selected?.evidence && typeof selected.evidence === "object" ? selected.evidence : undefined;
    const automatic =
      evidence &&
      "source" in evidence &&
      (evidence.source === "saved-plan" ||
        evidence.source === "pasted-plan" ||
        evidence.source === "named-artifact");
    const valid =
      selected &&
      scope &&
      isWorkId(linkId) &&
      Number.isSafeInteger(revision) &&
      revision > 0 &&
      fingerprints.size === 1 &&
      selected.status === "active" &&
      isWorkId(selected.sourceWorkId) &&
      isWorkId(target) &&
      selected.workId === target &&
      selectedIds.length > 0 &&
      selectedIds.every(isWorkId) &&
      evidence &&
      "source" in evidence &&
      (evidence.source === "work-command" ||
        (automatic &&
          selected.sourceWorkId === target &&
          "requestId" in evidence &&
          isWorkId(evidence.requestId) &&
          selectedIds.includes(evidence.requestId) &&
          "segmentId" in evidence &&
          isWorkId(evidence.segmentId))) &&
      // Requests before a new work's delayed first scope stay unscoped; only another scope conflicts.
      targetRequests.some((row) => isWorkScope(row.scope)) &&
      targetRequests.every(
        (row) => !isWorkScope(row.scope) || sameScope(row.scope, scope, sameAccount),
      );
    for (const requestId of ids) {
      const value = result.get(requestId) ?? {
        workIds: new Set(),
        linkIds: new Set(),
        unresolved: false,
      };
      for (const row of valid ? latest : rows)
        if (typeof row.targetWorkId === "string") value.workIds.add(row.targetWorkId);
      value.linkIds.add(linkId);
      const originals = requests.get(requestId) ?? [];
      value.unresolved ||=
        !valid ||
        !selectedIds.includes(requestId) ||
        !originals.length ||
        !originals.every(
          (row) =>
            row.workId === selected.sourceWorkId &&
            isWorkScope(row.scope) &&
            sameScope(row.scope, scope, sameAccount) &&
            (!automatic ||
              (isWorkSegment(row.segment) &&
                "segmentId" in evidence &&
                row.segment.id === evidence.segmentId)),
        );
      result.set(requestId, value);
    }
  }
  for (const value of result.values()) value.unresolved ||= value.workIds.size !== 1;
  return result;
}
