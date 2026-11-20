export interface InspectedRequest {
  /** The bytes to forward, exactly as they arrived. */
  body?: ArrayBuffer;
  /** The parsed body, when the caller asked for one and it parsed. */
  json?: unknown;
}

/**
 * Buffers a request body once for forwarding, and separately decodes it for inspection. The inspected copy never
 * changes what is forwarded, so a compressed request reaches the gateway byte-identical.
 */
export async function inspectRequest(
  request: Request,
  parseBody: boolean,
): Promise<InspectedRequest> {
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  if (!parseBody || body === undefined) return { body };
  const inspected = await decodeForInspection(body, request.headers.get("content-encoding"));
  try {
    return { body, json: JSON.parse(new TextDecoder().decode(inspected)) };
  } catch {
    // An unreadable body goes untagged, as in Kimchi.
    return { body };
  }
}

/** The slug a model request names, when its body carried one. */
export function requestModel(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  return (json as { model?: unknown }).model;
}

async function decodeForInspection(
  body: ArrayBuffer,
  contentEncoding: string | null,
): Promise<ArrayBuffer | Uint8Array> {
  if (contentEncoding?.toLowerCase() !== "zstd") return body;
  try {
    return await Bun.zstdDecompress(body);
  } catch {
    return body;
  }
}
