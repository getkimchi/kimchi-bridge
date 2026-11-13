import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  calculatePullRequestCosts,
  decimalNanos,
  roundedUsd,
  totalRequestCosts,
  usd,
} from "../src/work/kimchi/costs.ts";
import {
  isGitHash,
  providerId,
  repositoryPath,
  type SameAccount,
} from "../src/work/kimchi/records.ts";

const sameAccount: SameAccount = (left, right) =>
  left.apiUrl === right.apiUrl &&
  left.organizationId === right.organizationId &&
  left.userId === right.userId;

// Every distinct call the Kimchi harness's own tests made to its calculator before it moved here,
// with the report it returned: one JSON object per line, gzipped. The calculator here must return
// the same reports, so what the harness shows and uploads does not change.
const calls: any[] = gunzipSync(
  readFileSync(join(import.meta.dir, "fixtures/kimchi-costs-golden.jsonl.gz")),
)
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

test("returns the reports the harness's calculator returned for its recorded calls", () => {
  expect(calls.length).toBeGreaterThan(200);
  const kinds = new Set<string>();
  for (const [index, call] of calls.entries()) {
    const report = calculatePullRequestCosts({
      records: call.records,
      observations: call.observations,
      sameAccount,
      incompleteRequestIds: new Set(call.incompleteRequestIds),
      noCharge: new Map(call.noCharge),
    });
    expect([index, JSON.parse(JSON.stringify(report))]).toEqual([index, call.result]);
    for (const request of report.requests) kinds.add(request.allocation);
  }
  expect([...kinds].sort()).toEqual([
    "inferred",
    "post-merge",
    "pull-request",
    "shared",
    "unknown",
    "unlinked",
    "unmerged",
  ]);
});

test("the harness's rule for accounts decides whose work and whose bill a request is", () => {
  const reasons = (report: { requests: { reason?: string }[] }) =>
    report.requests.map((request) => request.reason);
  // A request with a bill, attributed without any account doubt.
  const call = calls.find(
    (entry) => entry.observations.length && reasons(entry.result).every((reason) => !reason),
  );
  const strangers = calculatePullRequestCosts({
    records: call.records,
    observations: call.observations,
    sameAccount: () => false,
  });
  // The bill no longer belongs to the work's account, so the request's place is unknown.
  expect(reasons(strangers)).toContain("work-account-mismatch");
  expect(strangers.requests.map((request) => request.allocation)).toContain("unknown");
});

/** Each text, and each with one character removed, doubled or replaced, so near misses are covered. */
function variants(texts: string[], swaps: string[]): string[] {
  const out = new Set(texts);
  for (const text of texts)
    for (let index = 0; index <= text.length; index++) {
      out.add(text.slice(0, index) + text.slice(index + 1));
      out.add(text.slice(0, index) + (text[index] ?? "0") + text.slice(index));
      for (const swap of swaps) out.add(text.slice(0, index) + swap + text.slice(index + 1));
    }
  return [...out];
}

const NANOS = 1_000_000_000n;
const AMOUNT = new RegExp("^(0|[1-9]\\d{0,8})(?:\\.(\\d{1,9}))?$");
const TRAILING_ZEROS = new RegExp("0+$");
const PROVIDER_ID = new RegExp("^[1-9]\\d{0,19}$");
const PATH_SEGMENT = new RegExp("^[\\w.-]+$");
const GIT_HASH = new RegExp("^(?:[a-f\\d]{40}|[a-f\\d]{64})$", "i");

// The harness wrote these checks as regular expressions; the source here may not use any.
test("an amount is up to nine whole digits and up to nine decimals, without a leading zero", () => {
  const original = (value: string) => {
    const match = AMOUNT.exec(value);
    return match ? BigInt(match[1]!) * NANOS + BigInt((match[2] ?? "").padEnd(9, "0")) : undefined;
  };
  const cases = variants(
    ["0", "0.5", "12.340000000", "999999999.999999999", "1000000000", "0.0000000001", "007", "1."],
    ["0", "1", "9", ".", "-", "e", " ", "\n"],
  );
  expect(cases.length).toBeGreaterThan(400);
  for (const text of cases) expect([text, decimalNanos(text)]).toEqual([text, original(text)]);
  expect(decimalNanos(1.5)).toBeUndefined();
  expect(usd(decimalNanos("12.34")!)).toBe("12.340000000");
  expect(usd(-1n)).toBe("-0.000000001");
});

test("amounts people read keep about three significant digits and no trailing zeros past cents", () => {
  const original = (nanos: bigint) => {
    if (!nanos) return "$0.00";
    if (nanos < 1000n) return "<$0.000001";
    const places =
      nanos >= 10n * NANOS ? 2 : nanos >= NANOS ? 3 : Math.min(6, 12 - nanos.toString().length);
    const unit = 10n ** BigInt(places);
    const step = NANOS / unit;
    const rounded = (nanos + step / 2n) / step;
    const fraction = (rounded % unit)
      .toString()
      .padStart(places, "0")
      .replace(TRAILING_ZEROS, "")
      .padEnd(2, "0");
    return "$" + (rounded / unit).toLocaleString("en-US") + "." + fraction;
  };
  const amounts = [0n, 1n, 999n, 1000n, 581_000n, 28_600_000n, 62_300_000n, 100_000_000n];
  for (let nanos = 1n; nanos < 10n ** 15n; nanos *= 7n)
    amounts.push(nanos, nanos + 5n, nanos * 10n);
  for (const nanos of amounts) expect([nanos, roundedUsd(nanos)]).toEqual([nanos, original(nanos)]);
  expect(roundedUsd(581_000n)).toBe("$0.000581");
  expect(roundedUsd(1_234_500_000_000n)).toBe("$1,234.50");
});

test("a subtotal is complete only when every request has a price", () => {
  const row = (knownCostUsd: string, priceStatus: "priced" | "missing") =>
    ({ requestId: knownCostUsd, knownCostUsd, priceStatus }) as any;
  expect(totalRequestCosts([row("0.100000000", "priced"), row("2.5", "priced")])).toEqual({
    requestIds: ["0.100000000", "2.5"],
    knownCostUsd: "2.600000000",
    totalCostUsd: "2.600000000",
  });
  expect(totalRequestCosts([row("1", "priced"), row("0", "missing")]).totalCostUsd).toBeNull();
});

test("provider IDs, repository paths and Git hashes are checked as the harness checked them", () => {
  const swaps = ["0", "9", "a", "f", "g", "A", "_", ".", "-", "/", " ", "\n"];
  for (const text of variants(
    ["1", "42", "12345678901234567890", "123456789012345678901", "007"],
    swaps,
  ))
    expect([text, providerId(text) !== undefined]).toEqual([text, PROVIDER_ID.test(text)]);
  expect([providerId(42), providerId(0), providerId(1.5), providerId(null)]).toEqual([
    "42",
    undefined,
    undefined,
    undefined,
  ]);
  const path = (value: string, provider?: "github" | "gitlab") => {
    const segments = value.split("/");
    return (
      segments.length >= 2 &&
      (provider !== "github" || segments.length === 2) &&
      segments.every((segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..")
    );
  };
  for (const text of variants(["acme/repo", "group/sub/repo.js", "a/..", "a_b/c-d", "acme"], swaps))
    for (const provider of [undefined, "github", "gitlab"] as const)
      expect([text, provider, repositoryPath(text, provider)]).toEqual([
        text,
        provider,
        path(text, provider),
      ]);
  expect(repositoryPath(42)).toBe(false);
  for (const text of variants(
    ["a".repeat(40), "0123456789ABCDEF".repeat(4), "b".repeat(41)],
    swaps,
  ))
    expect([text, isGitHash(text)]).toEqual([text, GIT_HASH.test(text)]);
});
