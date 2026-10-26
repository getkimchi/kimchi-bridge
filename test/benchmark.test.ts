import { expect, test } from "bun:test";
import { Distribution } from "../scripts/benchmark";

test("benchmark reports median and nearest-rank p95 without mutating samples", () => {
  const values = [30, 10, 40, 20];
  expect(Distribution(values)).toEqual({ samples: 4, median: 25, p95: 40, min: 10, max: 40 });
  expect(values).toEqual([30, 10, 40, 20]);
  expect(Distribution(Array.from({ length: 100 }, (_, i) => i + 1)).p95).toBe(95);
  expect(() => Distribution([])).toThrow();
  expect(() => Distribution([NaN])).toThrow();
});
