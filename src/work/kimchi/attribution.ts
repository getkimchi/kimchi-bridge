import { isIssueKey } from "../issue-keys.ts";
import { requestWorkLinks } from "./links.ts";
import {
  isObject,
  isWorkId,
  isWorkScope,
  validTime,
  type PullRequestAllocation,
  type RequestAllocation,
  type SameAccount,
  type WorkAccount,
  type WorkRecord,
} from "./records.ts";

/** A repository as its provider identifies it. */
export interface ReportingRepository {
  provider: "github" | "gitlab";
  host: string;
  id: string;
  name?: string;
}

/** A local repository's provider identity, or `unsupported` when it has none (no GitHub or GitLab remote, or gone). */
export type RepositoryIdentity = ReportingRepository | "unsupported";

/** The receipt of the correction that decided a request's work. */
export interface CorrectionReceipt {
  id: string;
  revision: number;
  recordedAt: string;
  source: "work-command" | "producer-confirmation";
}

/** Where a request's cost goes, as it is uploaded. */
export interface ClaimAllocation {
  kind: "pull-request" | "shared" | "unlinked" | "unmerged" | "post-merge" | "unknown";
  pullRequestIds: string[];
  method: "native" | "explicit" | "user-correction" | "model" | "session";
}

const MAX_BILLING_IDS = 8;

export function repositoryKey(repository: ReportingRepository): string {
  return JSON.stringify([repository.provider, repository.host, repository.id]);
}

export function accountKey(account: WorkAccount): string {
  // Deliberately the address as captured, not a canonical form: these keys persist in the harness's
  // state files and name its queues, and one written before the platform API moved to its region's
  // API origin must stay valid. Accounts are compared through the harness's own rule instead.
  return JSON.stringify([account.apiUrl, account.organizationId, account.userId]);
}

function method(
  request: RequestAllocation,
  links: Map<string, WorkRecord>,
): ClaimAllocation["method"] {
  // An inferred local assignment stays inferred on the server, whatever evidence its segment or a link carries.
  if (request.allocation === "inferred")
    return request.segment?.attribution === "inferred" ? "model" : "session";
  if (request.linkIds?.length)
    return request.linkIds.some((id) => {
      const evidence = links.get(id)?.evidence;
      return isObject(evidence) && evidence.source === "work-command";
    })
      ? "user-correction"
      : "explicit";
  if (request.segment?.attribution === "explicit") return "explicit";
  // Only a confirmed PR allocation rests on recorded evidence; anything else is a model guess or session grouping.
  if (request.allocation === "pull-request") return "native";
  return request.segment?.attribution === "inferred" ? "model" : "session";
}

/** Everything known about where one request's cost goes, before any upload bound. */
export interface RequestAttribution<
  Request extends RequestAllocation = RequestAllocation,
  PullRequest extends PullRequestAllocation = PullRequestAllocation,
> {
  request: Request;
  candidates: PullRequest[];
  destinations: ReportingRepository[];
  missing: boolean;
  method: ClaimAllocation["method"];
  correction?: CorrectionReceipt;
  workIssueKeys: string[];
  billingAccountVerified: boolean;
  billingRecordIds: string[];
}

/** Full local attribution of each request of the report: its candidate PRs, their repositories and its correction. */
export function requestAttributions<
  Request extends RequestAllocation,
  PullRequest extends PullRequestAllocation,
>(
  records: WorkRecord[],
  report: { requests: Request[]; pullRequests: PullRequest[] },
  repositories: Map<string, RepositoryIdentity>,
  sameAccount: SameAccount,
): Map<string, RequestAttribution<Request, PullRequest>> {
  const original = new Map<string, WorkRecord[]>();
  const links = new Map<string, WorkRecord>();
  const conflictingLinkStatus = new Set<string>();
  for (const row of records) {
    if (row.type === "request" && typeof row.requestId === "string")
      original.set(row.requestId, [...(original.get(row.requestId) ?? []), row]);
    if (
      row.type === "work_link" &&
      typeof row.linkId === "string" &&
      typeof row.revision === "number"
    ) {
      const previous = links.get(row.linkId);
      if (!previous || Number(previous.revision) < row.revision) {
        links.set(row.linkId, row);
        conflictingLinkStatus.delete(row.linkId);
      } else if (previous.revision === row.revision && previous.status !== row.status) {
        conflictingLinkStatus.add(row.linkId);
      }
    }
  }

  // Reuse the native proof validator. Revocations are explicit user decisions;
  // validate their original scope and evidence before sending the receipt.
  const verified = requestWorkLinks(
    records.map((row) =>
      row.type === "work_link" && row.status === "revoked" ? { ...row, status: "active" } : row,
    ),
    sameAccount,
  );

  const attributions = new Map<string, RequestAttribution<Request, PullRequest>>();
  for (const request of report.requests) {
    const account = request.account;
    const candidates = report.pullRequests.filter(
      (pr) =>
        account &&
        pr.account &&
        sameAccount(pr.account, account) &&
        request.pullRequestIds.includes(pr.key),
    );
    const destinations = new Map<string, ReportingRepository>();
    let missing = !account;
    for (const candidate of candidates) {
      const pr = candidate.pullRequest;
      if (!pr) continue;
      if (!pr.id || !pr.repositoryId) {
        missing = true;
        continue;
      }
      const repo: ReportingRepository = {
        provider: pr.provider ?? "github",
        host: pr.host,
        id: pr.repositoryId,
        name: pr.repository,
      };
      destinations.set(repositoryKey(repo), repo);
    }
    if (!destinations.size || missing)
      for (const row of original.get(request.requestId) ?? []) {
        if (!account || !isWorkScope(row.scope) || !sameAccount(row.scope.account, account)) {
          missing = true;
          continue;
        }
        const repo = repositories.get(row.scope.repository);
        if (repo === "unsupported") continue;
        if (repo) destinations.set(repositoryKey(repo), repo);
        else missing = true;
      }

    let correction: CorrectionReceipt | undefined;
    const proof = verified.get(request.requestId);
    if (
      proof &&
      !proof.unresolved &&
      ![...proof.linkIds].some((id) => conflictingLinkStatus.has(id))
    ) {
      const rows = [...proof.linkIds]
        .flatMap((id) => {
          const row = links.get(id);
          return row ? [row] : [];
        })
        .filter(
          (row) =>
            isWorkId(row.linkId) && Number.isSafeInteger(row.revision) && validTime(row.recordedAt),
        )
        .sort(
          (a, b) =>
            Date.parse(String(b.recordedAt)) - Date.parse(String(a.recordedAt)) ||
            Number(b.revision) - Number(a.revision),
        );
      const row = rows[0];
      if (row && validTime(row.recordedAt)) {
        const evidence = row.evidence;
        const manual =
          row.status === "revoked" || (isObject(evidence) && evidence.source === "work-command");
        correction = {
          id: String(row.linkId),
          revision: Number(row.revision),
          recordedAt: row.recordedAt,
          source: manual ? "work-command" : "producer-confirmation",
        };
      }
    }
    const workIssueKeys = new Set<string>();
    for (const row of original.get(request.requestId) ?? [])
      if (isObject(row.issue) && typeof row.issue.key === "string" && isIssueKey(row.issue.key))
        workIssueKeys.add(row.issue.key);
    const billingAccountVerified =
      request.reason !== "work-account-mismatch" && request.reason !== "work-account-unverified";
    attributions.set(request.requestId, {
      request,
      candidates,
      destinations: [...destinations.values()],
      missing,
      method: method(request, links),
      correction,
      workIssueKeys: [...workIssueKeys],
      billingAccountVerified,
      // Larger bill sets are resolved by the server through the request's exact billing tag.
      billingRecordIds:
        billingAccountVerified && request.billingRecordIds.length <= MAX_BILLING_IDS
          ? [...request.billingRecordIds]
          : [],
    });
  }
  return attributions;
}

/** The allocation to upload for a request, given the provider IDs of the PRs it names in one repository. */
export function allocationFor(
  attribution: RequestAttribution,
  pullRequestIds: string[],
): ClaimAllocation {
  const { request, missing, destinations } = attribution;
  let kind: ClaimAllocation["kind"] =
    request.allocation === "inferred"
      ? pullRequestIds.length > 1
        ? "shared"
        : "pull-request"
      : request.allocation;
  // The backend applies each candidate's merge cutoff to a shared claim.
  if (kind === "post-merge" && pullRequestIds.length > 1) kind = "shared";
  if (
    missing ||
    destinations.length > 1 ||
    (kind !== "unlinked" && pullRequestIds.length !== request.pullRequestIds.length) ||
    (!pullRequestIds.length && kind !== "unlinked")
  )
    kind = "unknown";
  return {
    kind,
    pullRequestIds: kind === "unlinked" ? [] : [...new Set(pullRequestIds)].sort(),
    method: attribution.method,
  };
}
