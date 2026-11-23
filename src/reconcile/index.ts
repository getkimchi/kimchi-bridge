/**
 * The reconcile pass library moved from Kimchi (reconcile-out-of-process plan, chunk B2).
 * The public entry is runReconciliationPass; the channel modules it drives are exported
 * for Kimchi's in-process wiring (status commands, session hooks) until chunk K1 replaces
 * those imports with this barrel.
 */
export type { HostCredentials, HostEndpoints, HostFetch, HostMetric, HostOrgPolicy, HostPorts } from "./host.js"
export { setDefaultHostPorts, hostPorts, withHostPorts } from "./host-ports.js"
export { runReconciliationPass, type PassInput, type PassResult } from "./pass.js"
export type { ContinuationProgress } from "./work-attribution/links.js"
export type { WorkPullRequestUpdate, WorkPullRequestLookup, WorkPullRequest } from "./pull-request-status/pull-requests.js"
export { readWorkPullRequestUpdates } from "./pull-request-status/pull-requests.js"
export { reconcileWorkCosts, readWorkCostReport, readWorkCostReportAsync } from "./work-attribution/cost-sync.js"
export { reconcileReporting, deliverEvents, deliverSnapshots } from "./pr-cost-reporting/worker.js"
