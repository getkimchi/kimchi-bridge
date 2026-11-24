/**
 * Host services the bridge's ledger and reconcile code needs from the embedding Kimchi
 * process. The ledger library (B1) takes the agent directory as an explicit parameter
 * everywhere; the reconcile passes (B2) also resolve credentials, endpoints, org policy,
 * telemetry consent and metrics through these ports, so the bridge never holds a second
 * copy of Kimchi's config, trust or policy logic (reconcile-out-of-process plan).
 *
 * Two access shapes exist:
 *  - entry points that receive a `host` (runReconciliationPass) bind it for their whole
 *    async context (see host-ports.ts);
 *  - deep call sites read it through `hostPorts()`, so credential, consent and metric reads
 *    keep their exact call sites and timing — only the function behind them changes.
 *
 * Nothing in src/reconcile may import Kimchi-only modules, `@earendil-works/*` or
 * src/platform.ts — this library must load everywhere Kimchi runs, Windows included.
 */

/** The credential the embedding process resolves for a working directory. */
export interface HostCredentials {
  /** Bearer token (API key, or the SSO access token from auth.json); "" when none resolved. */
  token: string;
  /** SSO organization routing header for OAuth credentials; absent for API keys. */
  organizationId?: string;
  /** The platform API base without a trailing slash, as accounts and reports compare it. */
  apiUrl: string;
}

/** The gateway and platform endpoints the embedding process derives for a working directory. */
export interface HostEndpoints {
  llmEndpoint: string;
  openAiBaseUrl: string;
  anthropicBaseUrl: string;
  experimentalOpenAiBaseUrl: string;
  platformApiUrl: string;
}

/** The effective org policy answers the embedding process holds for this session. */
export interface HostOrgPolicy {
  /** Whether a resource/extension id is enabled under the effective org policy and settings. */
  resourceEnabled(resourceId: string): boolean;
}

/** The PR-cost metrics the passes count. Counts and fixed outcomes only; identifiers never enter labels. */
export type HostMetric =
  | { kind: "delivery"; outcome: "success" | "failed" | "canceled" }
  /** snapshotRequests and snapshotBytes describe the largest snapshot queued in a reporting pass. */
  | { kind: "unpriced" | "queueDepth" | "snapshotRequests" | "snapshotBytes"; value: number }
  | { kind: "reconciliation" };

/** The embedding process's fetch — structural, so test doubles and hosts need not copy Bun's fetch extensions. */
export type HostFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HostPorts {
  /** Kimchi's agent directory (`KIMCHI_CODING_AGENT_DIR`); ledger paths derive from it. */
  readonly agentDir: string;
  /**
   * Kimchi's e2e seam: reads a `KIMCHI_E2E_*` variable only inside a test harness and
   * returns undefined in any other process, so a stray variable cannot misroute the user.
   */
  readonly e2eSeam: (name: string) => string | undefined;
  /** Wall clock, injectable for deterministic tests. */
  readonly now: () => number;
  /**
   * The configured credential (API key or SSO) and platform API for a working directory,
   * from one read of the configuration. Called at every original credential call site,
   * including mid-pass re-checks and per-record lookups.
   */
  readonly credentials: (cwd: string) => HostCredentials;
  /**
   * The saved Git host token (gitTokens.<host> in the embedding process's global config),
   * or undefined when none is saved. PR discovery reads it at its original call sites;
   * only the function behind them changes, so there is no second credential resolver here.
   */
  readonly gitToken: (host: string) => string | undefined;
  /** The gateway and platform endpoints configured for a working directory. */
  readonly endpoints: (cwd: string) => HostEndpoints;
  /** The session's effective org policy, fetched once per process by the embedding host. */
  readonly orgPolicy: () => HostOrgPolicy;
  /** Whether telemetry (and telemetry-following PR reporting) is currently consented to. */
  readonly telemetryConsent: () => boolean;
  /** Replays a PR-cost metric into the embedding process's telemetry context. */
  readonly metric: (metric: HostMetric) => void;
  /** The embedding process's fetch (instrumented, proxied) — replaces bare global fetch. */
  readonly fetch: HostFetch;
}
