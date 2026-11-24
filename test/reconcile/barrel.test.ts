import { expect, test } from "bun:test";
import * as reconcile from "../../src/reconcile/index.js";
import type {
  BillingSource,
  PassInput,
  PassResult,
  PassRun,
  FileState,
  FileTransition,
  LimitNotices,
  PendingRepository,
  Repository,
  ReportingRepository,
  ReportingState,
  ServerLimit,
  SharedTypeReads,
  StatPoller,
  WorkAccount,
  WorkAccountSnapshot,
  WorkRecord,
  WorkScope,
  WorkScopeSnapshot,
} from "../../src/reconcile/index.js";

/**
 * The symbols Kimchi's non-moved modules import from the moved files. K1 deletes the moved
 * Kimchi files and imports these from @getkimchi/kimchi-bridge/reconcile (the package export
 * map has no deep paths), so the barrel must carry every one of them; a missing export fails
 * K1's compile. Session-side wrappers that stayed in Kimchi (createTrackedEditTool,
 * confirmWorkContinuation, recoverWorkSummaries, ...) are intentionally absent.
 */

/** Compile-only presence of the required types. */
const types:
  | [
      BillingSource,
      FileState,
      FileTransition,
      LimitNotices,
      PassInput,
      PassResult,
      PassRun,
      PendingRepository,
      Repository,
      ReportingRepository,
      ReportingState,
      ServerLimit,
      SharedTypeReads,
      StatPoller,
      WorkAccount,
      WorkAccountSnapshot,
      WorkRecord,
      WorkScope,
      WorkScopeSnapshot,
    ]
  | undefined = undefined;

const required: Record<string, unknown> = {
  // pass entry and host ports
  runReconciliationPass: reconcile.runReconciliationPass,
  setDefaultHostPorts: reconcile.setDefaultHostPorts,
  withHostPorts: reconcile.withHostPorts,
  hostPorts: reconcile.hostPorts,
  // pr-cost-reporting
  reconcileReporting: reconcile.reconcileReporting,
  deliverEvents: reconcile.deliverEvents,
  deliverSnapshots: reconcile.deliverSnapshots,
  USAGE_SCHEMAS: reconcile.USAGE_SCHEMAS,
  dueLimitNotices: reconcile.dueLimitNotices,
  inUploadWindow: reconcile.inUploadWindow,
  readReportingState: reconcile.readReportingState,
  setReportingEnabled: reconcile.setReportingEnabled,
  takeLimitNotices: reconcile.takeLimitNotices,
  takeReportingNotice: reconcile.takeReportingNotice,
  // pull-request-status
  LOOKUP_WINDOW_MS: reconcile.LOOKUP_WINDOW_MS,
  PASS_BUDGET_MS: reconcile.PASS_BUDGET_MS,
  readWorkPullRequestUpdates: reconcile.readWorkPullRequestUpdates,
  reconcileWorkPullRequests: reconcile.reconcileWorkPullRequests,
  api: reconcile.api,
  command: reconcile.command,
  configuredHost: reconcile.configuredHost,
  credential: reconcile.credential,
  defaultHost: reconcile.defaultHost,
  githubAPI: reconcile.githubAPI,
  githubGraphQL: reconcile.githubGraphQL,
  pages: reconcile.pages,
  repositoryIdentity: reconcile.repositoryIdentity,
  requestJSON: reconcile.requestJSON,
  LookupError: reconcile.LookupError,
  SHA: reconcile.SHA,
  label: reconcile.label,
  lookupFailureReason: reconcile.lookupFailureReason,
  pullRequest: reconcile.pullRequest,
  repositoryPath: reconcile.repositoryPath,
  storedPullRequests: reconcile.storedPullRequests,
  // work-attribution
  reconcileWorkCosts: reconcile.reconcileWorkCosts,
  readWorkCostReport: reconcile.readWorkCostReport,
  readWorkCostReportAsync: reconcile.readWorkCostReportAsync,
  captureBillingSource: reconcile.captureBillingSource,
  requestTagSelector: reconcile.requestTagSelector,
  costDetailLines: reconcile.costDetailLines,
  costReportSource: reconcile.costReportSource,
  knownSpend: reconcile.knownSpend,
  workCostDetails: reconcile.workCostDetails,
  decimalNanos: reconcile.decimalNanos,
  roundedUsd: reconcile.roundedUsd,
  time: reconcile.time,
  usd: reconcile.usd,
  debugWorkAttribution: reconcile.debugWorkAttribution,
  knownTransitionRepositories: reconcile.knownTransitionRepositories,
  readAttributedFileState: reconcile.readAttributedFileState,
  readAttributedFileStates: reconcile.readAttributedFileStates,
  readRepositoryTransitions: reconcile.readRepositoryTransitions,
  reconcileRepositoryTransitions: reconcile.reconcileRepositoryTransitions,
  pinWorkContinuation: reconcile.pinWorkContinuation,
  readContinuationHistory: reconcile.readContinuationHistory,
  reconcileWorkContinuations: reconcile.reconcileWorkContinuations,
  GATEWAY_TAG_LIMIT: reconcile.GATEWAY_TAG_LIMIT,
  PRICED_TAG_LIMIT: reconcile.PRICED_TAG_LIMIT,
  prepareBillingTag: reconcile.prepareBillingTag,
  COST_PER_PR_RESOURCE_ID: reconcile.COST_PER_PR_RESOURCE_ID,
  captureWorkAccount: reconcile.captureWorkAccount,
  captureWorkScope: reconcile.captureWorkScope,
  isWorkAccount: reconcile.isWorkAccount,
  readWorkScope: reconcile.readWorkScope,
  sameWorkAccount: reconcile.sameWorkAccount,
  sameWorkScope: reconcile.sameWorkScope,
  saveNewWorkScope: reconcile.saveNewWorkScope,
  workCredential: reconcile.workCredential,
  workRepository: reconcile.workRepository,
  object: reconcile.object,
  readWorkRecordsOfType: reconcile.readWorkRecordsOfType,
  // shared
  branchIssueKeys: reconcile.branchIssueKeys,
  isIssueKey: reconcile.isIssueKey,
  startStatPoller: reconcile.startStatPoller,
  fetchWithRetry: reconcile.fetchWithRetry,
  isRetryableStatus: reconcile.isRetryableStatus,
  plainURL: reconcile.plainURL,
};

test("the reconcile barrel exports every symbol Kimchi's remaining modules import", () => {
  for (const [name, value] of Object.entries(required)) expect(value, name).toBeDefined();
});

test("the barrel re-exports the pass entry point", () => {
  expect(typeof reconcile.runReconciliationPass).toBe("function");
  expect(reconcile.ReconcileLeaseLostError).toBeDefined();
});
