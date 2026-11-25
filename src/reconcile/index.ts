/**
 * The reconcile pass library moved from Kimchi (reconcile-out-of-process plan, chunk B2).
 * The public entry is runReconciliationPass; the channel modules it drives are exported
 * for Kimchi's in-process wiring (status commands, session hooks) until chunk K1 replaces
 * those imports with this barrel.
 */
export type {
  HostCredentials,
  HostEndpoints,
  HostFetch,
  HostMetric,
  HostOrgPolicy,
  HostPorts,
} from "./host.js";
export { setDefaultHostPorts, hostPorts, withHostPorts } from "./host-ports.js";
export {
  ReconcileLeaseLostError,
  runReconciliationPass,
  type PassInput,
  type PassResult,
  type PassRun,
  type ReconcileChannel,
  type ReconcileChannelOutcome,
} from "./pass.js";
export type { ContinuationProgress } from "./work-attribution/links.js";
export type {
  WorkPullRequestUpdate,
  WorkPullRequestLookup,
  WorkPullRequest,
} from "./pull-request-status/pull-requests.js";
export {
  LOOKUP_WINDOW_MS,
  PASS_BUDGET_MS,
  readWorkPullRequestUpdates,
  reconcileWorkPullRequests,
} from "./pull-request-status/pull-requests.js";
export {
  api,
  command,
  configuredHost,
  credential,
  defaultHost,
  githubAPI,
  githubGraphQL,
  pages,
  repositoryIdentity,
  requestJSON,
} from "./pull-request-status/provider-api.js";
export {
  LookupError,
  SHA,
  label,
  lookupFailureReason,
  pullRequest,
  repositoryPath,
  storedPullRequests,
  type Repository,
} from "./pull-request-status/provider-records.js";
export {
  reconcileWorkCosts,
  readWorkCostReport,
  readWorkCostReportAsync,
} from "./work-attribution/cost-sync.js";
export { reconcileReporting, deliverEvents, deliverSnapshots } from "./pr-cost-reporting/worker.js";
export { buildEvents } from "./pr-cost-reporting/events.js";
export { USAGE_SCHEMAS } from "./pr-cost-reporting/native.js";
export {
  dueLimitNotices,
  inUploadWindow,
  readReportingState,
  setReportingEnabled,
  takeLimitNotices,
  takeReportingNotice,
  type LimitNotices,
  type PendingRepository,
  type ReportingState,
  type ServerLimit,
} from "./pr-cost-reporting/queue.js";
export { queueSnapshots } from "./pr-cost-reporting/queue.js";
export { calculatePullRequestCosts } from "./work-attribution/costs.js";
export type { ReportingRepository } from "./pr-cost-reporting/snapshot.js";
export { accountKey, buildSnapshots } from "./pr-cost-reporting/snapshot.js";
export {
  captureBillingSource,
  requestTagSelector,
  type BillingSource,
} from "./work-attribution/billing-source.js";
export {
  costDetailLines,
  costReportSource,
  knownSpend,
  workCostDetails,
} from "./work-attribution/cost-details.js";
export { decimalNanos, roundedUsd, time, usd } from "./work-attribution/costs.js";
export { requestWorkLinks } from "./work-attribution/links.js";
export { debugWorkAttribution } from "./work-attribution/diagnostics.js";
export {
  knownTransitionRepositories,
  readAttributedFileState,
  readAttributedFileStates,
  readRepositoryTransitions,
  reconcileRepositoryTransitions,
  type FileState,
  type FileTransition,
  type SharedTypeReads,
} from "./work-attribution/file-transitions.js";
export {
  pinWorkContinuation,
  readContinuationHistory,
  reconcileWorkContinuations,
} from "./work-attribution/links.js";
export {
  GATEWAY_TAG_LIMIT,
  PRICED_TAG_LIMIT,
  prepareBillingTag,
} from "./work-attribution/request-tags.js";
export { COST_PER_PR_RESOURCE_ID } from "./work-attribution/resource.js";
export {
  captureWorkAccount,
  captureWorkScope,
  isWorkAccount,
  readWorkScope,
  sameWorkAccount,
  sameWorkScope,
  saveNewWorkScope,
  workCredential,
  workRepository,
  type WorkAccount,
  type WorkAccountSnapshot,
  type WorkScope,
  type WorkScopeSnapshot,
} from "./work-attribution/scope.js";
export { object, readWorkRecordsOfType, type WorkRecord } from "./work-attribution/summary.js";
export { branchIssueKeys, isIssueKey } from "./shared/issue-keys.js";
export { startStatPoller, type StatPoller } from "./shared/stat-poller.js";
export { fetchWithRetry, isRetryableStatus } from "./shared/http.js";
export { plainURL } from "./shared/url.js";
