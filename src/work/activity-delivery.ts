import { readBody, request } from "../kimchi.ts";
import {
	type ActivityAcknowledgement,
	type ActivityStore,
} from "./activity-store.ts";
import { parseJson, stringifyJson } from "./protocol.ts";

/** Delivers the already-frozen batch body, not a regenerated event variant. */
export async function flushActivity(
	store: ActivityStore,
	endpoint: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const batch = store.pendingBatch();
	if (!batch) return false;
	const body = stringifyJson(batch);
	let response: Response;
	try {
		response = await request(
			endpoint,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body,
			},
			signal,
		);
	} catch (error) {
		store.diagnostic("activity_delivery_unavailable");
		throw error;
	}
	if (response.status === 413) {
		await response.body?.cancel().catch(() => {});
		store.diagnostic("activity_delivery_split");
		store.splitBatch(batch);
		return true;
	}
	if (response.status === 409) {
		await response.body?.cancel().catch(() => {});
		store.diagnostic("activity_delivery_batch_conflict");
		store.dropBatch(batch);
		return true;
	}
	if (response.status === 400) {
		const reasonCode = await permanentBadRequestReason(response);
		if (reasonCode) {
			// KCP's explicit deterministic rejection is local terminal evidence. Do
			// not keep replaying the same malformed batch forever.
			store.acknowledge(batch, {
				batchId: batch.batchId,
				receipts: batch.events.map((event) => ({
					eventId: event.eventId,
					status: "RECEIPT_STATUS_REJECTED",
					reasonCode,
				})),
			});
			store.diagnostic("activity_delivery_rejected");
			return true;
		}
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => {});
		store.diagnostic(`activity_http_${response.status}`);
		throw new Error(
			`activity recorder returned HTTP ${response.status}; batch retained`,
		);
	}
	let ack: ActivityAcknowledgement;
	try {
		ack = parseJson(
			await readBody(response, 1 << 20),
		) as ActivityAcknowledgement;
	} catch {
		throw new Error(
			"invalid activity recorder acknowledgement; batch retained",
		);
	}
	store.acknowledge(batch, ack);
	return true;
}

/** Returns only structured KCP errors known to require correction, never arbitrary client/proxy text. */
async function permanentBadRequestReason(
	response: Response,
): Promise<string | undefined> {
	try {
		const error = parseJson(await readBody(response, 4 << 10)) as {
			message?: unknown;
		};
		if (
			error.message === "invalid_activity_batch" ||
			error.message === "control_not_recording"
		) {
			return error.message;
		}
	} catch {
		// An unknown HTML/text body is not proof of KCP's terminal rejection.
	}
	return undefined;
}

export async function flushAllActivities(
	store: ActivityStore,
	endpoint: string,
	signal?: AbortSignal,
): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		if (!(await flushActivity(store, endpoint, signal))) return;
	}
	if (store.pendingBatch())
		throw new Error("activity delivery work remains for the next pass");
}

/** Explicit flush drains until empty; a network, HTTP, or receipt failure stops at the retained batch. */
export async function drainActivities(
	store: ActivityStore,
	endpoint: string,
	signal?: AbortSignal,
): Promise<void> {
	while (await flushActivity(store, endpoint, signal)) {
		/* Each receipt frees the next durable batch. */
	}
}
