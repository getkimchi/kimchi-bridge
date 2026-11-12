import { expect, test } from "bun:test";
import { allocationFor, requestAttributions } from "../src/work/kimchi/attribution.ts";
import { requestWorkLinks } from "../src/work/kimchi/links.ts";
import {
  isSha256Hex,
  isWorkId,
  time,
  validTime,
  type RequestAllocation,
  type SameAccount,
  type WorkRecord,
} from "../src/work/kimchi/records.ts";

// The harness wrote these three rules as regular expressions. The source here may not use any, so
// the tests check the hand-written forms against the originals.
const WORK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f\d]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Each text, and each with one character removed, doubled or replaced, so near misses are covered. */
function variants(texts: string[]): string[] {
  const swaps = [
    "0",
    "9",
    "a",
    "f",
    "g",
    "A",
    "F",
    "Z",
    "z",
    "T",
    "t",
    "-",
    "+",
    ":",
    ".",
    " ",
    "\n",
  ];
  const out = new Set(texts);
  for (const text of texts)
    for (let index = 0; index <= text.length; index++) {
      out.add(text.slice(0, index) + text.slice(index + 1));
      out.add(text.slice(0, index) + (text[index] ?? "0") + text.slice(index));
      for (const swap of swaps) out.add(text.slice(0, index) + swap + text.slice(index + 1));
    }
  return [...out];
}

test("a work ID is a UUID of versions 1 to 8, in either case", () => {
  const cases = variants([
    "11111111-1111-4111-8111-111111111111",
    "ABCDEF01-2345-1789-9ABC-DEF012345678",
    "00000000-0000-8000-b000-000000000000",
    "00000000-0000-0000-0000-000000000000",
    "11111111-1111-9111-8111-111111111111",
    "11111111-1111-4111-c111-111111111111",
  ]);
  expect(cases.length).toBeGreaterThan(2000);
  for (const text of cases) expect([text, isWorkId(text)]).toEqual([text, WORK_ID.test(text)]);
  for (const value of [undefined, null, 1, {}, ["11111111-1111-4111-8111-111111111111"]])
    expect(isWorkId(value)).toBe(false);
});

test("a hash is 64 lowercase hex characters", () => {
  const cases = variants([
    "0123456789abcdef".repeat(4),
    "c".repeat(64),
    "C".repeat(64),
    "c".repeat(63),
  ]);
  for (const text of cases)
    expect([text, isSha256Hex(text)]).toEqual([text, SHA256_HEX.test(text)]);
});

test("a timestamp has a date, a time, an optional fraction of up to nine digits and a zone", () => {
  const cases = variants([
    "2026-10-23T12:30:40Z",
    "2026-10-23T12:30:40.1Z",
    "2026-10-23T12:30:40.123456789Z",
    "2026-10-23T12:30:40.1234567891Z",
    "2026-10-23T12:30:40+02:30",
    "2026-10-23T12:30:40.5-08:00",
    "2026-10-23T12:30:40.Z",
    "2026-10-23 12:30:40Z",
    "2026-10-23T12:30:40",
  ]);
  expect(cases.length).toBeGreaterThan(3000);
  // The harness's original: the shape as a regular expression, then the same calendar checks.
  const original = (value: string) => {
    if (!TIMESTAMP.test(value)) return undefined;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return undefined;
    const day = value.slice(0, 10);
    return new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) ? parsed : undefined;
  };
  for (const text of cases) expect([text, time(text)]).toEqual([text, original(text)]);
  expect(cases.filter((text) => time(text) !== undefined).length).toBeGreaterThan(100);
  expect(time("2026-10-23T12:30:40.5+02:30")).toBe(Date.parse("2026-10-23T10:00:40.500Z"));
  // An impossible date is not rolled into the next month.
  expect(time("2026-02-30T00:00:00Z")).toBeUndefined();
  expect(time("2026-13-01T00:00:00Z")).toBeUndefined();
  expect(time(20261023)).toBeUndefined();
  expect(validTime("0000-01-01T00:00:00Z")).toBe(false);
  expect(validTime("0001-01-01T00:00:00Z")).toBe(true);
});

const id = (kind: number, n: number) =>
  `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { apiUrl: "https://api.example.test", organizationId: id(1, 1), userId: id(1, 2) };
const scope = { account, repository: "/work/repo/.git" };
const exact: SameAccount = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const [PLANNING, IMPLEMENTING, REQUEST, LINK, SEGMENT] = [1, 2, 3, 4, 5].map((n) => id(2, n));
const request = (workId: string, requestId: string, extra: object = {}): WorkRecord => ({
  version: 1,
  type: "request",
  workId,
  sessionId: "session",
  requestId,
  scope,
  startedAt: "2026-10-20T10:00:00Z",
  ...extra,
});
const link = (extra: object = {}): WorkRecord => ({
  version: 1,
  type: "work_link",
  workId: IMPLEMENTING,
  sessionId: "session",
  linkId: LINK,
  revision: 1,
  status: "active",
  sourceWorkId: PLANNING,
  targetWorkId: IMPLEMENTING,
  requestIds: [REQUEST],
  scope,
  evidence: { source: "work-command" },
  recordedAt: "2026-10-20T11:00:00Z",
  ...extra,
});
const history = [request(PLANNING, REQUEST), request(IMPLEMENTING, id(3, 9))];

test("a /work link moves exactly the requests it names to the linking work", () => {
  const links = requestWorkLinks([...history, link()], exact);
  expect([...links.keys()]).toEqual([REQUEST]);
  expect(links.get(REQUEST)).toEqual({
    workIds: new Set([IMPLEMENTING]),
    linkIds: new Set([LINK]),
    unresolved: false,
  });
});

test("a link that is revoked, contradictory, out of scope or unproven leaves its requests unresolved", () => {
  const unresolved = (records: WorkRecord[], same = exact) =>
    requestWorkLinks(records, same).get(REQUEST)?.unresolved;
  expect(unresolved([...history, link(), link({ revision: 2, status: "revoked" })])).toBe(true);
  // Two records of the latest revision that disagree.
  expect(unresolved([...history, link(), link({ requestIds: [REQUEST, id(3, 9)] })])).toBe(true);
  // The request was recorded under another repository than the link.
  expect(
    unresolved([
      request(PLANNING, REQUEST, { scope: { ...scope, repository: "/other/.git" } }),
      history[1]!,
      link(),
    ]),
  ).toBe(true);
  // The harness says the accounts differ.
  expect(unresolved([...history, link()], () => false)).toBe(true);
  // The request belongs to another work than the link's source.
  expect(unresolved([request(id(2, 8), REQUEST), history[1]!, link()])).toBe(true);
  // The target work has no scoped request of its own yet.
  expect(unresolved([history[0]!, link()])).toBe(true);
  // An unknown kind of evidence.
  expect(unresolved([...history, link({ evidence: { source: "guess" } })])).toBe(true);
});

test("the harness confirms a continued plan's producing input only with its request and segment", () => {
  const produced = request(IMPLEMENTING, REQUEST, {
    segment: { id: SEGMENT, attribution: "session", reason: "session" },
  });
  const confirmation = (evidence: object) =>
    link({ sourceWorkId: IMPLEMENTING, evidence: { source: "saved-plan", ...evidence } });
  const unresolved = (evidence: object) =>
    requestWorkLinks([produced, confirmation(evidence)], exact).get(REQUEST)?.unresolved;
  expect(unresolved({ requestId: REQUEST, segmentId: SEGMENT })).toBe(false);
  expect(unresolved({ requestId: REQUEST, segmentId: id(2, 7) })).toBe(true);
  expect(unresolved({ requestId: id(3, 8), segmentId: SEGMENT })).toBe(true);
  expect(unresolved({ segmentId: SEGMENT })).toBe(true);
});

const allocation = (extra: Partial<RequestAllocation> = {}): RequestAllocation => ({
  requestId: REQUEST,
  account,
  pullRequestIds: ["github:github.com/acme/repo#7"],
  allocation: "pull-request",
  billingRecordIds: [],
  ...extra,
});
const pullRequest = (number: number, extra: object = {}) => ({
  key: `github:github.com/acme/repo#${number}`,
  account,
  pullRequest: {
    provider: "github" as const,
    id: String(2_000_000_000 + number),
    repositoryId: "42",
    url: `https://github.com/acme/repo/pull/${number}`,
    number,
    state: "merged" as const,
    repository: "acme/repo",
    host: "github.com",
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    checkedAt: "2026-10-20T12:00:00Z",
    ...extra,
  },
});
const attribute = (requests: RequestAllocation[], records: WorkRecord[] = history, same = exact) =>
  requestAttributions(
    records,
    { requests, pullRequests: [pullRequest(7), pullRequest(8)] },
    new Map([["/work/repo/.git", { provider: "github", host: "github.com", id: "42" }]]),
    same,
  ).get(REQUEST)!;

test("how sure a request's place is decides the method that is uploaded", () => {
  const segment = (attribution: "explicit" | "inferred" | "session") => ({
    id: SEGMENT,
    attribution,
    reason: "reason",
  });
  expect(attribute([allocation()]).method).toBe("native");
  expect(attribute([allocation({ segment: segment("explicit") })]).method).toBe("explicit");
  expect(attribute([allocation({ allocation: "inferred" })]).method).toBe("session");
  expect(
    attribute([allocation({ allocation: "inferred", segment: segment("inferred") })]).method,
  ).toBe("model");
  expect(attribute([allocation({ allocation: "unlinked", pullRequestIds: [] })]).method).toBe(
    "session",
  );
  const linked = attribute([allocation({ linkIds: [LINK] })], [...history, link()]);
  expect(linked.method).toBe("user-correction");
  expect(linked.correction).toEqual({
    id: LINK,
    revision: 1,
    recordedAt: "2026-10-20T11:00:00Z",
    source: "work-command",
  });
});

test("a request names the PRs of its own account, and its repository when it has none", () => {
  const found = attribute([allocation()]);
  expect(found.candidates.map((candidate) => candidate.key)).toEqual([
    "github:github.com/acme/repo#7",
  ]);
  expect(found.destinations).toEqual([
    { provider: "github", host: "github.com", id: "42", name: "acme/repo" },
  ]);
  expect(found.missing).toBe(false);
  // No PR: the request's own repository is where an unlinked claim goes.
  const unlinked = attribute([allocation({ allocation: "unlinked", pullRequestIds: [] })]);
  expect([unlinked.candidates, unlinked.destinations, unlinked.missing]).toEqual([
    [],
    [{ provider: "github", host: "github.com", id: "42" }],
    false,
  ]);
  // Another account's PRs are not this request's.
  const stranger = attribute([allocation()], history, () => false);
  expect([stranger.candidates, stranger.missing]).toEqual([[], true]);
  expect(attribute([allocation({ account: null })]).missing).toBe(true);
});

test("issue keys come from the request's own records, and bills only from a verified account", () => {
  const records = [
    request(PLANNING, REQUEST, { issue: { key: "PAY-412", revision: 1 } }),
    history[1]!,
  ];
  expect(attribute([allocation()], records).workIssueKeys).toEqual(["PAY-412"]);
  expect(
    attribute(
      [allocation()],
      [request(PLANNING, REQUEST, { issue: { key: "pay-412" } }), history[1]!],
    ).workIssueKeys,
  ).toEqual([]);
  const bills = ["a", "b"];
  expect(attribute([allocation({ billingRecordIds: bills })]).billingRecordIds).toEqual(bills);
  const unverified = attribute([
    allocation({ billingRecordIds: bills, reason: "work-account-mismatch" }),
  ]);
  expect([unverified.billingAccountVerified, unverified.billingRecordIds]).toEqual([false, []]);
  // More bills than an event carries are found by the server through the request's tag.
  const many = Array.from({ length: 9 }, (_, index) => String(index));
  expect(attribute([allocation({ billingRecordIds: many })]).billingRecordIds).toEqual([]);
});

test("the uploaded allocation is unknown whenever the PRs it names are not all identified", () => {
  const two = ["github:github.com/acme/repo#7", "github:github.com/acme/repo#8"];
  const kind = (request: RequestAllocation, ids: string[]) =>
    allocationFor(attribute([request]), ids).kind;
  expect(allocationFor(attribute([allocation()]), ["2000000007"])).toEqual({
    kind: "pull-request",
    pullRequestIds: ["2000000007"],
    method: "native",
  });
  expect(kind(allocation({ allocation: "inferred", pullRequestIds: two }), ["b", "a"])).toBe(
    "shared",
  );
  expect(kind(allocation({ allocation: "post-merge", pullRequestIds: two }), ["a", "b"])).toBe(
    "shared",
  );
  expect(kind(allocation({ allocation: "unmerged" }), ["a"])).toBe("unmerged");
  expect(kind(allocation({ allocation: "unlinked", pullRequestIds: [] }), [])).toBe("unlinked");
  // One of the two PRs has no provider ID.
  expect(kind(allocation({ allocation: "shared", pullRequestIds: two }), ["a"])).toBe("unknown");
  expect(kind(allocation(), [])).toBe("unknown");
  expect(kind(allocation({ account: null }), ["a"])).toBe("unknown");
  expect(
    allocationFor(attribute([allocation({ allocation: "shared", pullRequestIds: two })]), [
      "b",
      "a",
    ]).pullRequestIds,
  ).toEqual(["a", "b"]);
});
