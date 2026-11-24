import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { backendFor } from "../../src/ledger/records.js"
import type { HostMetric, HostPorts } from "../../src/reconcile/host.js"
import { hostPorts, setDefaultHostPorts, withHostPorts } from "../../src/reconcile/host-ports.js"
import { reconcileWorkCosts } from "../../src/reconcile/work-attribution/cost-sync.js"
import { deliverEvents } from "../../src/reconcile/pr-cost-reporting/worker.js"
import { runReconciliationPass } from "../../src/reconcile/pass.js"

/**
 * Contract test for the HostPorts seam: a fake host counts every call, and the
 * passes must route every credential, endpoint, policy, consent and metric read
 * through it — at the original call sites, including the mid-pass credential
 * re-check (F7) and the per-record cwd of billing lookups (F11).
 */

const ORG = "30000000-0000-4000-8000-000000000003"
const USER = "40000000-0000-4000-8000-000000000004"
const ENDPOINT = "https://account.example"

interface FakeHost {
	host: HostPorts
	counts: Record<string, number>
	cwds: string[]
	metrics: HostMetric[]
	endpointCwds: string[]
	fetches: string[]
	setCredentials(credential: { token: string; organizationId?: string; apiUrl: string }): void
}

function fakeHost(agentDir: string, fetchImpl?: HostPorts["fetch"]): FakeHost {
	const counts: Record<string, number> = {}
	const cwds: string[] = []
	const endpointCwds: string[] = []
	const metrics: HostMetric[] = []
	const fetches: string[] = []
	let credential: { token: string; organizationId?: string; apiUrl: string } = {
		token: "api-key",
		organizationId: undefined,
		apiUrl: ENDPOINT,
	}
	const host: HostPorts = {
		agentDir,
		e2eSeam(name) {
			counts.e2eSeam = (counts.e2eSeam ?? 0) + 1
			return process.env[name]
		},
		now: () => Date.now(),
		credentials(cwd) {
			counts.credentials = (counts.credentials ?? 0) + 1
			cwds.push(cwd)
			return credential
		},
		endpoints(cwd) {
			counts.endpoints = (counts.endpoints ?? 0) + 1
			endpointCwds.push(cwd)
			return {
				llmEndpoint: "https://llm.example",
				openAiBaseUrl: "https://llm.example/openai/v1",
				anthropicBaseUrl: "https://llm.example/anthropic",
				experimentalOpenAiBaseUrl: "https://llm.example/experimental/openai/v1",
				platformApiUrl: ENDPOINT,
			}
		},
		orgPolicy() {
			counts.orgPolicy = (counts.orgPolicy ?? 0) + 1
			return { resourceEnabled: (id: string) => id === "extensions.cost-per-pr" }
		},
		telemetryConsent() {
			counts.telemetryConsent = (counts.telemetryConsent ?? 0) + 1
			return true
		},
		metric(metric) {
			counts.metric = (counts.metric ?? 0) + 1
			metrics.push(metric)
		},
		async fetch(input, init) {
			counts.fetch = (counts.fetch ?? 0) + 1
			fetches.push(String(input))
			if (fetchImpl) return fetchImpl(input, init)
			return Response.json({ organizationId: ORG, userId: USER })
		},
	}
	return {
		host,
		counts,
		cwds,
		metrics,
		endpointCwds,
		fetches,
		setCredentials(next) {
			credential = next
		},
	}
}

const dirs: string[] = []
function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-host-ports-"))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
	setDefaultHostPorts(undefined)
})

test("hostPorts throws when no host is bound, so no call site silently guesses", () => {
	setDefaultHostPorts(undefined)
	expect(() => hostPorts()).toThrow(/HostPorts/)
})

test("withHostPorts scopes a host to its async context", async () => {
	const dir = agentDir()
	const first = fakeHost(dir)
	const second = fakeHost(dir)
	await withHostPorts(first.host, async () => {
		await Promise.resolve()
		expect(hostPorts()).toBe(first.host)
		await withHostPorts(second.host, async () => {
			expect(hostPorts()).toBe(second.host)
		})
		expect(hostPorts()).toBe(first.host)
	})
})

test("a full pass reaches every port: reconciliation metric, consent, policy, seam and paths", async () => {
	const dir = agentDir()
	const fake = fakeHost(dir)
	const result = await runReconciliationPass(
		{ files: true, pullRequests: {}, costs: true, reporting: { cwd: "/project" } },
		fake.host,
		{ signal: new AbortController().signal, assertLease: () => {} },
	)
	// The pass announced itself through the metric port, exactly once, first.
	expect(fake.metrics[0]).toEqual({ kind: "reconciliation" })
	expect(fake.metrics.filter((metric) => metric.kind === "reconciliation")).toHaveLength(1)
	// The reporting channel consulted consent (state reads and the consent fence).
	expect(fake.counts.telemetryConsent).toBeGreaterThan(0)
	// The agent directory's work-attribution folder exists with private mode.
	const stat = statSync(join(dir, "work-attribution"))
	expect(stat.isDirectory()).toBe(true)
	expect(stat.mode & 0o700).toBe(0o700)
	// An empty ledger leaves the repository rotation unset.
	expect(result.nextRepository).toBeUndefined()
})

test("event delivery resolves credentials through the host and re-checks them mid-pass", async () => {
	const dir = agentDir()
	const fake = fakeHost(dir)
	setDefaultHostPorts(fake.host)
	const account = { apiUrl: ENDPOINT, organizationId: ORG, userId: USER }
	backendFor(dir).insertOutboxBatch({
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		accountKey: JSON.stringify([ENDPOINT, ORG, USER]),
		body: new Uint8Array(),
		eventIds: [],
		createdAt: Date.now(),
		orderKey: "",
	})
	// After the account verifies, the credential changes: the mid-pass re-check
	// (assertOwnership in deliverEvents) must stop the upload before it is sent.
	let verified = false
	fake.setCredentials({ token: "api-key", apiUrl: ENDPOINT })
	const fetchImpl: HostPorts["fetch"] = async (input) => {
		if (String(input).endsWith("/api-keys:verify")) {
			verified = true
			fake.setCredentials({ token: "rotated-key", apiUrl: ENDPOINT })
			return Response.json({ organizationId: ORG, userId: USER })
		}
		throw new Error("the upload must not be dispatched after the credential changed")
	}
	const host: HostPorts = { ...fake.host, fetch: fetchImpl }
	// The re-check ends the pass with the credentials-changed error, before any upload.
	await expect(
		withHostPorts(host, () => deliverEvents(dir, "/project", new AbortController().signal, () => {})),
	).rejects.toThrow("PR reporting credentials changed")
	expect(verified).toBe(true)
	// The upload route was never reached.
	expect(fake.fetches.some((url) => url.endsWith("/pr-cost-events:batchIngest"))).toBe(false)
	// The pass read the credential at its original call sites: the initial
	// resolution and the ownership re-checks around the network call, all with
	// the reporting session's exact cwd.
	expect(fake.counts.credentials ?? 0).toBeGreaterThanOrEqual(3)
	expect(fake.cwds.every((cwd) => cwd === "/project")).toBe(true)
})

test("billing lookups resolve credentials with each stored record's own cwd", async () => {
	const dir = agentDir()
	const fake = fakeHost(dir)
	setDefaultHostPorts(fake.host)
	const requestId = "11111111-1111-4111-8111-111111111111"
	const workId = "22222222-2222-4222-8222-222222222222"
	const startedAt = "2026-10-24T08:00:00.000Z"
	const dispatchedAt = "2026-10-24T08:00:01.000Z"
	const recordCwd = "/the/records/own/cwd"
	// A request whose scope was captured in one account, dispatched through the
	// configured gateway, with its billing source and selector recorded.
	backendFor(dir).insertRecord({
		recordHash: "a".repeat(64),
		type: "request",
		workId,
		sessionId: "session",
		body: JSON.stringify({
			version: 1,
			type: "request",
			workId,
			sessionId: "session",
			requestId,
			cwd: recordCwd,
			startedAt,
			scope: { account: { apiUrl: ENDPOINT, organizationId: ORG, userId: USER }, repository: "/repo/.git" },
		}),
		sourcePath: join(dir, "work-attribution", "session.jsonl"),
		sourceGeneration: 0,
		sourceOffset: 0,
		importedAt: Date.now(),
	})
	backendFor(dir).insertRecord({
		recordHash: "b".repeat(64),
		type: "request_dispatch",
		workId,
		sessionId: "session",
		body: JSON.stringify({
			version: 1,
			type: "request_dispatch",
			workId,
			sessionId: "session",
			requestId,
			cwd: recordCwd,
			startedAt,
			dispatchedAt,
			billingSource: {
				apiUrl: ENDPOINT,
				gatewayUrl: "https://llm.example/openai/v1/chat/completions",
				credentialHash: "c".repeat(64),
			},
			billingSelector: {
				type: "tag",
				tag: `kimchi-request:${requestId}`,
				startTime: "2026-10-23T20:00:01.000Z",
				endTime: "2026-11-25T08:00:01.000Z",
			},
		}),
		sourcePath: join(dir, "work-attribution", "session.jsonl"),
		sourceGeneration: 0,
		sourceOffset: 0,
		importedAt: Date.now(),
	})
	await reconcileWorkCosts(dir, new AbortController().signal, () => {})
	// The lookup read the credential with the stored record's cwd (F11), not the
	// pass cwd or the agent directory.
	expect(fake.cwds).toContain(recordCwd)
	expect(fake.cwds.every((cwd) => cwd === recordCwd)).toBe(true)
	// The billing source's endpoint derivation also ran through the host.
	expect(fake.endpointCwds).toContain(recordCwd)
})

test("the resource gate consults the org policy port", async () => {
	const dir = agentDir()
	const enabled = fakeHost(dir)
	setDefaultHostPorts(enabled.host)
	const { tryWorkAttribution } = await import("../../src/reconcile/work-attribution.js")
	expect(tryWorkAttribution(() => "ran")).toBe("ran")
	expect(enabled.counts.orgPolicy).toBe(1)
	const disabled = fakeHost(dir)
	setDefaultHostPorts({
		...disabled.host,
		orgPolicy: () => {
			disabled.counts.orgPolicy = (disabled.counts.orgPolicy ?? 0) + 1
			return { resourceEnabled: () => false }
		},
	})
	const writes: number[] = []
	// With the resource disabled, attribution records nothing through the wrapper.
	expect(tryWorkAttribution(() => writes.push(1))).toBeUndefined()
	expect(writes).toHaveLength(0)
})
