import { expect, test } from "bun:test";
import { buildEvents } from "../src/work/kimchi/events.ts";
import type { SameAccount } from "../src/work/kimchi/records.ts";
// Inputs and the events the Kimchi harness built from them before this code moved here. The
// harness's uploads must not change, so neither may these.
import golden from "./fixtures/kimchi-events-golden.json" with { type: "json" };

const sameAccount: SameAccount = (left, right) =>
  left.apiUrl === right.apiUrl &&
  left.organizationId === right.organizationId &&
  left.userId === right.userId;

for (const scenario of golden.scenarios)
  test(`builds the harness's events: ${scenario.name}`, () => {
    const claims = scenario.claims as Record<string, any>;
    const built = buildEvents({
      stored: scenario.stored,
      report: scenario.report as any,
      repositories: new Map(scenario.repositories as [string, any][]),
      producerId: scenario.producerId,
      sameAccount,
      existingClaim: (account, entity) => claims[`${account}\u0000${entity}`],
      touched: scenario.touched && {
        requests: new Set(scenario.touched.requests),
        records: new Set(
          scenario.touched.records.map((index) => scenario.stored[index]!.recordHash),
        ),
      },
    });
    expect(JSON.parse(JSON.stringify(built))).toEqual(scenario.expected as any);
  });

test("the harness's own rule decides whether two accounts are the same", () => {
  const scenario = golden.scenarios[0]!;
  const input = {
    stored: scenario.stored,
    report: scenario.report as any,
    repositories: new Map(scenario.repositories as [string, any][]),
    producerId: scenario.producerId,
    existingClaim: () => undefined,
  };
  // An account that no longer matches the report's leaves every request unresolved.
  const strangers = buildEvents({ ...input, sameAccount: () => false });
  expect(strangers.accounts.flatMap((group) => group.facts.filter((fact) => fact.usage))).toEqual(
    [],
  );
  expect(strangers.unresolved.map((entry) => entry.reason)).toContain(
    "conflicting_request_account",
  );
});

test("a pass that is told to stop builds nothing", () => {
  const scenario = golden.scenarios[0]!;
  expect(() =>
    buildEvents({
      stored: scenario.stored,
      report: scenario.report as any,
      repositories: new Map(scenario.repositories as [string, any][]),
      producerId: scenario.producerId,
      sameAccount,
      existingClaim: () => undefined,
      check: () => {
        throw new Error("lease lost");
      },
    }),
  ).toThrow("lease lost");
});
