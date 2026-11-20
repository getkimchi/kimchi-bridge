import { expect, test } from "bun:test";
import {
  canonicalTime,
  encodeBatch,
  encodeEvent,
  eventHash,
  stableId,
  validateBatch,
  validateEvent,
} from "../src/work/protocol.ts";
// The Kimchi harness's frozen wire bytes: native payloads and the claim extensions only the kimchi
// source sends. The same file pins the harness; an event's bytes are its identity, so neither side
// may change them.
import golden from "./fixtures/kimchi-claims-golden.json" with { type: "json" };

const inputs = golden.events.map(({ input }) => input) as any[];
const [work, usage, , , , pr, , coverage, native, claim] = inputs;
const rejects = (operation: () => void) => {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
};
const errorName = (operation: () => void) => {
  try {
    operation();
    return "accepted";
  } catch (error) {
    return (error as Error).name;
  }
};

test("keeps the frozen bytes and local hashes of native payloads and Kimchi claim extensions", () => {
  expect(inputs.map((input) => ({ body: encodeEvent(input), hash: eventHash(input) }))).toEqual(
    golden.events.map(({ body, hash }) => ({ body, hash })),
  );
  expect(golden.batches.map(({ input }) => encodeBatch(input as any))).toEqual(
    golden.batches.map(({ body }) => body),
  );
  expect(stableId(...golden.stableParts)).toBe(golden.stableId);
  for (const input of inputs) validateEvent(input);
  for (const { input } of golden.batches) validateBatch(input as any);
});

test("rejects wrong scalar and collection types or overflowing integer values", () => {
  const unknown = structuredClone(usage);
  delete unknown.usage.raw.cacheReadTokens;
  const correction = (revision: number) => ({
    ...unknown,
    correction: { id: "correction", revision, recordedAt: unknown.observeTime, source: "explicit" },
  });
  const invalid = [
    { ...unknown, revision: 1 },
    { ...unknown, revision: "9223372036854775808" },
    { ...unknown, usage: { ...unknown.usage, raw: { inputTokens: "1e3" } } },
    { ...unknown, usage: { ...unknown.usage, attemptsComplete: "true" } },
    { ...unknown, usage: { ...unknown.usage, raw: { cacheWrites: "invalid" } } },
    { ...unknown, sourceVersion: 3 },
    { ...unknown, repository: "invalid" },
    { ...unknown, observeTime: [] },
    correction(1.5),
    correction(2147483648),
    correction(-2147483649),
    {
      ...unknown,
      usage: { ...unknown.usage, raw: { cacheWrites: [{ ttlSeconds: 2147483648, tokens: "0" }] } },
    },
    {
      ...unknown,
      usage: undefined,
      pullRequest: { id: "pr", number: 2147483648, uri: "https://example.com/pr/1", state: "open" },
    },
    { ...unknown, observeTime: "+010000-01-01T00:00:00Z" },
    { ...unknown, observeTime: "-000001-01-01T00:00:00Z" },
  ];
  expect(invalid.map((event) => errorName(() => encodeEvent(event)))).toEqual(
    Array(invalid.length).fill("TypeError"),
  );
});

test("keeps unknown counters distinct from reported zero and omits absent claim extensions", () => {
  const unknown = structuredClone(usage);
  delete unknown.usage.raw.cacheReadTokens;
  expect(eventHash(unknown)).not.toBe(golden.events[1]!.hash);
  expect(JSON.parse(encodeEvent(unknown)).usage.raw).not.toHaveProperty("cacheReadTokens");
  expect(JSON.parse(golden.events[1]!.body).usage.raw.cacheReadTokens).toBe("0");
  for (const key of ["allocation", "claimState", "correction", "startedAt"])
    expect(JSON.parse(encodeEvent(native))).not.toHaveProperty(key);
  const encoded = JSON.parse(encodeEvent(claim));
  expect(encoded.revision).toBe("1");
  expect(encoded.correction.revision).toBe(3);
  expect(Object.keys(encoded).slice(-4)).toEqual([
    "allocation",
    "claimState",
    "correction",
    "startedAt",
  ]);
});

test("appends and validates an independent allocation target without changing the old claim bytes", () => {
  const withTarget = (targetRepository: unknown) => ({
    ...claim,
    allocation: { ...claim.allocation, targetRepository },
  });
  const target = withTarget({
    provider: "github",
    host: "github.com",
    id: "42",
    name: "parent/repo",
  });
  const allocation = JSON.parse(encodeEvent(target)).allocation;
  expect(allocation.targetRepository).toEqual({
    provider: "github",
    host: "github.com",
    id: "42",
    name: "parent/repo",
  });
  expect(Object.keys(allocation).at(-1)).toBe("targetRepository");
  expect(eventHash(target)).not.toBe(golden.events[9]!.hash);
  expect(
    [
      "invalid",
      {},
      { provider: "other", host: "github.com", id: "42" },
      { provider: "github", host: "secret@github.com", id: "42" },
      { provider: "github", host: "github.com", id: "42", name: "repo?secret" },
    ].map((targetRepository) => rejects(() => validateEvent(withTarget(targetRepository)))),
  ).toEqual(Array(5).fill(true));
});

test("accepts a repository host with a port from 1 to 65535, no leading zero and nothing else after one colon", () => {
  const hosts: Record<string, boolean> = {
    "gitlab.example.com": true,
    "gitlab.example.com:8443": true,
    "gitlab.example.com:1": true,
    "gitlab.example.com:65535": true,
    "gitlab.example.com:00080": false,
    "gitlab.example.com:08443": false,
    ":8443": false,
    "gitlab.example.com:": false,
    "gitlab.example.com:0": false,
    "gitlab.example.com:65536": false,
    "gitlab.example.com:123456": false,
    "gitlab.example.com:80:1": false,
    "gitlab.example.com:8a": false,
    "gitlab.example.com:+80": false,
    "gitlab example.com": false,
    "gitlab.example.com/x": false,
    "user@gitlab.example.com": false,
    "gitlab.example.com:80#": false,
  };
  for (const [host, valid] of Object.entries(hosts))
    expect([
      host,
      !rejects(() =>
        validateEvent({
          ...claim,
          allocation: {
            ...claim.allocation,
            targetRepository: { provider: "gitlab", host, id: "42" },
          },
        }),
      ),
    ]).toEqual([host, valid]);
});

test("accepts a PR link only on its repository's host and port, in any case", () => {
  const links: [string, string, boolean][] = [
    [
      "gitlab.example.com:8443",
      "https://gitlab.example.com:8443/team/repo/-/merge_requests/3",
      true,
    ],
    [
      "GitLab.example.com:8443",
      "https://gitlab.EXAMPLE.com:8443/team/repo/-/merge_requests/3",
      true,
    ],
    ["gitlab.example.com:8443", "https://gitlab.example.com/team/repo/-/merge_requests/3", false],
    ["gitlab.example.com", "https://gitlab.example.com:8443/team/repo/-/merge_requests/3", false],
    [
      "gitlab.example.com:8443",
      "https://gitlab.example.com:9443/team/repo/-/merge_requests/3",
      false,
    ],
  ];
  for (const [host, uri, valid] of links)
    expect([
      host,
      uri,
      !rejects(() =>
        validateEvent({
          ...pr,
          repository: { ...pr.repository, host },
          pullRequest: { ...pr.pullRequest, uri },
        }),
      ),
    ]).toEqual([host, uri, valid]);
});

test("uses Go-compatible UTF8 replacement and HTML escaping", () => {
  const unicode = structuredClone(work);
  unicode.work.title = "\ud800 <>& ";
  const body = encodeEvent(unicode);
  expect(JSON.parse(body).work.title).toBe("� <>& ");
  expect(body).toContain("\\u003c\\u003e\\u0026\\u2028");
});

test("rejects invalid usage, claim receipts, identity, CAS and batch bounds", () => {
  const raw = (value: object) => ({ ...usage, usage: { ...usage.usage, raw: value } });
  const badEvidence = [
    { ...usage, sourceVersion: "" },
    { ...usage, baseRevision: "0" },
    { ...usage, baseEventId: "" },
    raw({ inputTokens: "-1" }),
    raw({ inputTokens: "1000000000001" }),
    raw({ cacheWriteTokens: "9", cacheWrites: [{ ttlSeconds: 300, tokens: "10" }] }),
    raw({ outputTokens: "9", reasoningTokens: "10" }),
    { ...usage, usage: { ...usage.usage, durationMs: "-1" } },
    { ...usage, usage: { ...usage.usage, durationMs: "86400001" } },
    { ...usage, work: work.work },
    { ...claim, usage: { ...claim.usage, requestId: "not-a-uuid" } },
    { ...claim, correction: { ...claim.correction, recordedAt: "1969-12-31T23:59:59.999999999Z" } },
    { ...claim, correction: { ...claim.correction, recordedAt: "2200-01-01T00:00:00Z" } },
    { ...claim, correction: { ...claim.correction, id: "00000000-0000-0000-0000-000000000000" } },
    { ...claim, correction: { ...claim.correction, source: "explicit" } },
    { ...claim, allocation: { ...claim.allocation, kind: "shared" } },
    { ...claim, allocation: { ...claim.allocation, pullRequestIds: ["pr", "pr"] } },
    { ...claim, allocation: { ...claim.allocation, kind: "unlinked" } },
    { ...claim, allocation: { ...claim.allocation, method: "guess" } },
    { ...claim, startedAt: "2026-10-23T13:44:23.715559001Z" },
    { ...claim, claimState: "withdrawn" },
    { ...usage, observeTime: "0001-01-01T00:00:00.000Z" },
    {
      ...coverage,
      coverage: {
        ...coverage.coverage,
        windowStartTime: "2026-10-01T00:00:00.000000002Z",
        windowEndTime: "2026-10-01T00:00:00.000000001Z",
      },
    },
    { ...pr, pullRequest: { ...pr.pullRequest, uri: "https://gitlab.com/team/repo/\npull/1" } },
  ];
  expect(badEvidence.map((event) => rejects(() => validateEvent(event)))).toEqual(
    Array(badEvidence.length).fill(true),
  );
  const batch = golden.batches[0]!.input as any;
  expect(rejects(() => validateBatch({ ...batch, events: [claim, claim] }))).toBe(true);
  expect(rejects(() => validateBatch({ ...batch, events: Array(501).fill(claim) }))).toBe(true);
});

test("preserves nanoseconds and offsets while canonicalizing zero offsets and trailing zeros", () => {
  expect(JSON.parse(golden.events[0]!.body).observeTime).toBe("2026-10-23T12:30:40.123456789Z");
  expect(
    [
      "2026-10-23T12:30:40.123400000+00:00",
      "2026-10-23T12:30:40.123400000+02:30",
      "2026-10-23T12:30:40.000Z",
    ].map(canonicalTime),
  ).toEqual([
    "2026-10-23T12:30:40.1234Z",
    "2026-10-23T12:30:40.1234+02:30",
    "2026-10-23T12:30:40Z",
  ]);
});

test("appends provider author with Go-compatible bytes and omits it when unknown", () => {
  const authored = { ...pr, pullRequest: { ...pr.pullRequest, author: "provider-user" } };
  expect(encodeEvent(authored)).toBe(
    `${golden.events[5]!.body.slice(0, -2)},"author":"provider-user"}}`,
  );
  expect(eventHash(authored)).toBe(
    "1cf5ca11687791f75411668c102a695b9526c2fbaca3f2df102f2b5a321239f6",
  );
  expect(encodeEvent({ ...pr, pullRequest: { ...pr.pullRequest, author: "" } })).toBe(
    golden.events[5]!.body,
  );
});

test("uses the provider's Unicode display bounds while rejecting controls and invalid author types", () => {
  const display: [object, boolean][] = [
    [{ title: "Title", author: "" }, true],
    [{ title: "Title", author: "a".repeat(255) }, true],
    [{ title: "Title", author: "界".repeat(255) }, true],
    [{ title: "Title", author: "👩".repeat(255) }, true],
    [{ title: "Title", author: "a".repeat(256) }, false],
    [{ title: "Title", author: "界".repeat(256) }, false],
    [{ title: "Title", author: "provider\nuser" }, false],
    [{ title: "a".repeat(1024) }, true],
    [{ title: "界".repeat(1024) }, true],
    [{ title: "👩".repeat(1024) }, true],
    [{ title: "a".repeat(1025) }, false],
    [{ title: "界".repeat(1025) }, false],
    [{ title: "Title\nbody" }, false],
    [{ title: "Title", author: 123 }, false],
  ];
  expect(
    display.map(
      ([fields]) =>
        !rejects(() => validateEvent({ ...pr, pullRequest: { ...pr.pullRequest, ...fields } })),
    ),
  ).toEqual(display.map(([, valid]) => valid));
});
