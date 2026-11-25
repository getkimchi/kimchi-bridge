import { expect, test } from "bun:test";
// Imports the barrel through the package's own name, exercising the `exports` map exactly
// as an embedding process (Kimchi) resolves it, not the source path a co-located import
// would take.
import {
  accountKey,
  buildEvents,
  buildSnapshots,
  calculatePullRequestCosts,
  calculatePullRequestCostsAsync,
  queueSnapshots,
  requestWorkLinks,
} from "@getkimchi/kimchi-bridge/reconcile";

test("the reconcile barrel exports the functions Kimchi's imports need", () => {
  expect(typeof accountKey).toBe("function");
  expect(typeof buildEvents).toBe("function");
  expect(typeof buildSnapshots).toBe("function");
  expect(typeof calculatePullRequestCosts).toBe("function");
  expect(typeof calculatePullRequestCostsAsync).toBe("function");
  expect(typeof queueSnapshots).toBe("function");
  expect(typeof requestWorkLinks).toBe("function");
});
