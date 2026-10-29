import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingTags, readResponseId, recordTag, responseId, tagFor } from "../src/request-tags.ts";

let root = "";
let previousRoot: string | undefined;
beforeEach(() => {
  previousRoot = process.env.KIMCHI_BRIDGE_HOME;
  root = mkdtempSync(join(tmpdir(), "kimchi-bridge-tags-"));
  process.env.KIMCHI_BRIDGE_HOME = root;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.KIMCHI_BRIDGE_HOME;
  else process.env.KIMCHI_BRIDGE_HOME = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

const id = "11111111-2222-4333-8444-555555555555";

test("the billing tag follows Kimchi's rules and keeps the user's own tags", () => {
  expect(billingTags(new Headers(), {}, id)).toBe(`kimchi-request:${id}`);
  expect(billingTags(new Headers({ "X-Tags": "team:web" }), { model: "m" }, id)).toBe(
    `team:web,kimchi-request:${id}`,
  );
  const five = ["a:1", "b:2", "c:3", "d:4", "e:5"];
  expect(
    billingTags(
      new Headers({ "X-Tags": five.join(",") }),
      { tags: ["f:6", "g:7", "h:8", "i:9"] },
      id,
    ),
  ).toBe(`${five.join(",")},kimchi-request:${id}`);
});

test("a reserved tag, an unreadable body or the gateway's tag limit leaves the request untagged", () => {
  expect(billingTags(new Headers({ "X-Tags": "kimchi-request:other" }), {}, id)).toBeUndefined();
  expect(billingTags(new Headers(), undefined, id)).toBeUndefined();
  expect(billingTags(new Headers(), [], id)).toBeUndefined();
  expect(billingTags(new Headers(), { tags: "a:1" }, id)).toBeUndefined();
  const nine = Array.from({ length: 9 }, (_, i) => `t${i}:v`).join(",");
  expect(
    billingTags(new Headers({ "X-Tags": nine, "X-LiteLLM-Tags": "x:y" }), {}, id),
  ).toBeUndefined();
});

test("the response ID comes from the first event of a stream or from a JSON reply", () => {
  expect(
    responseId(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{}}}\n\n',
    ),
  ).toBe("msg_1");
  expect(
    responseId(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    ),
  ).toBe("resp_1");
  expect(responseId('data: {"id":"chatcmpl-1","choices":[]}\n\n')).toBe("chatcmpl-1");
  expect(responseId('{"id":"msg_2","type":"message"}')).toBe("msg_2");
  expect(responseId("data: [DONE]\n\n")).toBeUndefined();
  expect(responseId('{"id":"msg_3"')).toBeUndefined();
});

test("a teed stream gives its ID from the first event and is released without reading the rest", async () => {
  const encoder = new TextEncoder();
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(
        encoder.encode(
          pulled === 1
            ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_9"}}\n\n'
            : 'event: ping\ndata: {"type":"ping"}\n\n',
        ),
      );
    },
  });
  expect(await readResponseId(stream)).toBe("msg_9");
  expect(pulled).toBeLessThan(5);
});

test("tags are recorded per response, expire, and lookups never create the store", () => {
  expect(tagFor("msg_1")).toBeUndefined();
  expect(existsSync(join(root, "gateway-request-tags.sqlite"))).toBe(false);
  recordTag("msg_1", id);
  expect(tagFor("msg_1")).toBe(id);
  expect(tagFor("msg_2")).toBeUndefined();
  recordTag("msg_old", "old", Date.now() - 15 * 24 * 3600_000);
  recordTag("msg_new", "new");
  expect(tagFor("msg_old")).toBeUndefined();
  expect(tagFor("msg_new")).toBe("new");
});
