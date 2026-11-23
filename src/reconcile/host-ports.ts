import { AsyncLocalStorage } from "node:async_hooks"
import type { HostPorts } from "./host.js"

/**
 * Host-port access for the reconcile passes. The passes' entry points (runReconciliationPass,
 * the individual channel functions) bind their host for the whole async context, so deep call
 * sites keep reading credentials, consent, policy and metrics through `hostPorts()` at their
 * original call sites — only the function behind them changes.
 *
 * AsyncLocalStorage scopes concurrent passes correctly: each async chain started inside
 * `withHostPorts` sees its own host even while another pass is in flight. Code that runs
 * outside any pass (an embedding process's command handlers in Kimchi chunk K1) can install a
 * process-wide default with `setDefaultHostPorts`.
 */
const context = new AsyncLocalStorage<HostPorts>()

let fallback: HostPorts | undefined

/** Binds `host` for the whole synchronous and asynchronous extent of `run`. */
export function withHostPorts<T>(host: HostPorts, run: () => T): T {
	return context.run(host, run)
}

/** A process-wide host for call sites outside any pass context (the embedding process's own wiring). */
export function setDefaultHostPorts(host: HostPorts | undefined): void {
	fallback = host
}

/** The bound host; throws when reconcile code runs without one, so no call site silently guesses. */
export function hostPorts(): HostPorts {
	const current = context.getStore() ?? fallback
	if (!current)
		throw new Error(
			"kimchi-bridge reconcile code requires HostPorts: bind one with withHostPorts or setDefaultHostPorts first",
		)
	return current
}
