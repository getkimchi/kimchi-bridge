import type { HostFetch } from "../host.js"
import { hostPorts } from "../host-ports.js"
import { fetchWithRetry } from "./http.js"

/**
 * api-keys:verify, vendored from Kimchi's api/organizations.ts. The reconcile passes
 * (PR-cost delivery, billing lookups, account capture) verify the configured key; the
 * call is a bounded HTTP POST whose only inputs are the credential, the endpoint and the
 * fetch implementation, so it moves as pure code instead of a host port. Kimchi call sites
 * that relied on the default endpoint resolved from config must pass one; every moved call
 * site already did.
 */

/** Header the gateway routes SSO requests by (vendored from Kimchi's auth/gateway-credentials.ts). */
export const GATEWAY_ORGANIZATION_HEADER = "X-CastAi-Organization-Id"

export interface VerifyApiKeyResponse {
	organizationId: string
	userId?: string
}

/**
 * Verify the organization's API key. Returns the organization the key is
 * scoped to — the authoritative org for this credential (a user may belong
 * to many organizations, but an org-scoped key belongs to exactly one).
 */
export async function verifyApiKey(
	apiKey: string,
	options: {
		endpoint: string
		/** SSO organization routing header — set when the bearer is an OAuth credential. */
		organizationId?: string
		fetch?: HostFetch
		signal?: AbortSignal
		retry?: { maxRetries: number }
	},
): Promise<VerifyApiKeyResponse> {
	const endpoint = options.endpoint
	const fetchImpl: HostFetch = options.fetch ?? hostPorts().fetch

	const url = `${endpoint}/ai-optimizer/v1beta/api-keys:verify`
	const resp = await fetchWithRetry(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				...(options.organizationId ? { [GATEWAY_ORGANIZATION_HEADER]: options.organizationId } : {}),
				Accept: "application/json",
			},
		},
		{ fetchImpl, signal: options.signal, retry: options.retry },
	)

	if (!resp.ok) {
		throw new Error(`POST ${url} failed with HTTP ${resp.status}`)
	}

	const data = await resp.json().catch(() => {
		throw new Error(`Unexpected non-JSON response from ${url}`)
	})

	if (typeof data?.organizationId !== "string" || data.organizationId.length === 0) {
		throw new Error(`Missing organizationId in api-keys:verify response from ${url}`)
	}

	return {
		organizationId: data.organizationId,
		...(typeof data.userId === "string" && data.userId ? { userId: data.userId } : {}),
	}
}
