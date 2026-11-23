/**
 * Host services the bridge's ledger and reconcile code needs from the embedding Kimchi
 * process. Chunk B1 only moves the ledger library, which takes the agent directory as an
 * explicit parameter everywhere; the credentials, policy, telemetry and consent ports
 * (see the reconcile-out-of-process plan) are added by later chunks. Nothing in this
 * file may import Kimchi-only modules — the bridge library must load everywhere Kimchi
 * runs, Windows included.
 */
export interface HostPorts {
	/** Kimchi's agent directory (`KIMCHI_CODING_AGENT_DIR`); ledger paths derive from it. */
	readonly agentDir: string
	/**
	 * Kimchi's e2e seam: reads a `KIMCHI_E2E_*` variable only inside a test harness and
	 * returns undefined in any other process, so a stray variable cannot misroute the user.
	 */
	readonly e2eSeam: (name: string) => string | undefined
	/** Wall clock, injectable for deterministic tests. */
	readonly now: () => number
}
