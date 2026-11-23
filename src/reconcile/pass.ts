/**
 * One reconciliation pass: the body of Kimchi's supervisor scan()
 * (work-attribution/reconcile-supervisor.ts), moved behind HostPorts. The lease
 * (proper-lockfile on <agentDir>/work-attribution), the timer, the subscriber
 * registry and the delayed first tick stay in Kimchi; the pass receives the
 * combined cancellation signal and an assertLease that throws once the lease
 * is lost or compromised.
 *
 * The channel order and budgets are the supervisor's, unchanged:
 * files → pull-requests → costs → continuations → reporting, with a 3 s pass
 * budget (PASS_BUDGET_MS), the pull-request channel's own 10 s network budget
 * and each reporting delivery's 5 s window.
 */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { HostPorts } from "./host.js"
import { withHostPorts } from "./host-ports.js"
import { reconcileWorkCosts } from "./work-attribution/cost-sync.js"
import { debugWorkAttribution as debug } from "./work-attribution/diagnostics.js"
import {
	knownTransitionRepositories,
	reconcileRepositoryTransitions,
	type SharedTypeReads,
} from "./work-attribution/file-transitions.js"
import { type ContinuationProgress, reconcileWorkContinuations } from "./work-attribution/links.js"
import { reconcileReporting } from "./pr-cost-reporting/worker.js"
import {
	reconcileWorkPullRequests,
	type WorkPullRequestUpdate,
} from "./pull-request-status/pull-requests.js"

const PASS_BUDGET_MS = 3000

export interface PassInput {
	/** The files channel: transition reconciliation, followed by continuation repair. */
	files?: boolean
	/** The pull-requests channel; durable updates stream to onUpdate. */
	pullRequests?: {
		onUpdate?: (update: WorkPullRequestUpdate) => void
		/** Replaces the supervisor's subscriber onError hooks; defaults to the debug log. */
		onError?: (error: unknown) => void
	}
	/** The billing cost channel. */
	costs?: boolean
	/** PR-cost translation and delivery, with the reporting session's cwd. */
	reporting?: { cwd: string }
	/** Where the files channel left off last pass; the new position is returned. */
	nextRepository?: string
	/** Continuation repair progress, carried across passes (the supervisor's ContinuationProgress). */
	progress?: ContinuationProgress
}

export interface PassResult {
	/** The repository the next files channel starts from. */
	nextRepository?: string
}

/** Runs one pass. Never resolves while the lease is compromised: assertLease throws first. */
export function runReconciliationPass(
	input: PassInput,
	host: HostPorts,
	io: { signal: AbortSignal; assertLease: () => void },
): Promise<PassResult> {
	return withHostPorts(host, async () => {
		const agentDir = host.agentDir
		const signal = io.signal
		const assertLease = io.assertLease
		const directory = join(agentDir, "work-attribution")
		await mkdir(directory, { recursive: true, mode: 0o700 })
		const deadline = Date.now() + PASS_BUDGET_MS
		host.metric({ kind: "reconciliation" })
		const exhausted = new Error("Work attribution reconciliation time limit exceeded")
		const checkBudget = () => {
			assertLease()
			if (Date.now() > deadline) throw exhausted
		}
		/** A channel's guard: the pass's lease and cancellation, as runChannel composed them. */
		const assertChannel = () => {
			assertLease()
			signal.throwIfAborted()
		}
		/** A channel error reaches its handlers; without one it reaches the debug log. */
		const channelError = (error: unknown, handlers: ((error: unknown) => void)[] | undefined, label: string) => {
			if (signal.aborted) return
			if (handlers?.length) for (const handler of handlers) handler(error)
			else debug(label, error)
		}
		let nextRepository = input.nextRepository
		if (input.files) {
			try {
				// One whole-type read serves every repository of the pass, not one full table scan each.
				const shared: SharedTypeReads = {}
				const repositories = await knownTransitionRepositories(checkBudget)
				const start = Math.max(0, repositories.indexOf(nextRepository ?? ""))
				for (let offset = 0; offset < repositories.length; offset++) {
					checkBudget()
					const index = (start + offset) % repositories.length
					// Move on after a slow/broken repository; its own checkpoints preserve partial progress.
					nextRepository = repositories[(index + 1) % repositories.length]
					try {
						await reconcileRepositoryTransitions(repositories[index], signal, checkBudget, assertLease, shared)
					} catch (error) {
						if (error === exhausted || signal.aborted) throw error
						debug("Could not reconcile repository %s: %o", repositories[index], error)
					}
				}
			} catch (error) {
				if (error !== exhausted && !signal.aborted) debug("Could not discover repositories: %o", error)
			}
		}
		// Network lookup has its own deadline. A slow local repository must not starve it,
		// and Bash-only commits have no transition repository to visit above.
		if (input.pullRequests) {
			const channel = input.pullRequests
			try {
				await reconcileWorkPullRequests(agentDir, signal, assertChannel, (update) =>
					channel.onUpdate?.(update),
				)
			} catch (error) {
				channelError(error, channel.onError ? [channel.onError] : undefined, "Reconciliation unavailable:")
			}
		}
		if (input.costs) {
			try {
				await reconcileWorkCosts(agentDir, signal, assertChannel)
			} catch (error) {
				channelError(error, undefined, "Could not reconcile costs: %o")
			}
		}
		// Historical repair is local and has its own budget; PR and billing work run first.
		if (input.files) {
			try {
				await reconcileWorkContinuations(agentDir, signal, assertLease, input.progress)
			} catch (error) {
				if (!signal.aborted) debug("Could not reconcile work continuations: %o", error)
			}
		}
		if (input.reporting) {
			try {
				await reconcileReporting(agentDir, input.reporting.cwd, signal, assertChannel)
			} catch (error) {
				channelError(error, undefined, "Could not report PR costs: %o")
			}
		}
		return { nextRepository }
	})
}
