import { describe, expect, test } from "bun:test";
import { hasSufficientData, meanConfidenceInterval, wilsonScoreInterval } from "./confidence";

describe("wilsonScoreInterval", () => {
  test("reference value: 1/1 at 95% is approximately [0.206, 1.0]", () => {
    const [lo, hi] = wilsonScoreInterval(1, 1)!;
    expect(lo).toBeCloseTo(0.206, 2);
    expect(hi).toBeCloseTo(1.0, 2);
  });

  test("reference value: 50/100 at 95% is approximately [0.404, 0.596]", () => {
    const [lo, hi] = wilsonScoreInterval(50, 100)!;
    expect(lo).toBeCloseTo(0.404, 2);
    expect(hi).toBeCloseTo(0.596, 2);
  });

  test("0/0 (no trials) returns null, not a fabricated interval", () => {
    expect(wilsonScoreInterval(0, 0)).toBeNull();
  });

  test("never produces an out-of-[0,1] bound, even at extreme proportions", () => {
    const [lo, hi] = wilsonScoreInterval(0, 3)!;
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    const [lo2, hi2] = wilsonScoreInterval(3, 3)!;
    expect(lo2).toBeGreaterThanOrEqual(0);
    expect(hi2).toBeLessThanOrEqual(1);
  });

  test("interval narrows as n grows at a fixed proportion", () => {
    const small = wilsonScoreInterval(5, 10)!;
    const large = wilsonScoreInterval(500, 1000)!;
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
  });
});

describe("meanConfidenceInterval", () => {
  test("returns null for fewer than 2 values (no variance estimate)", () => {
    expect(meanConfidenceInterval([])).toBeNull();
    expect(meanConfidenceInterval([5])).toBeNull();
  });

  test("a tight cluster of values produces a narrow interval around the mean", () => {
    const [lo, hi] = meanConfidenceInterval([10, 10, 10, 10, 10, 10, 10, 10, 10, 10])!;
    expect(lo).toBeCloseTo(10, 5);
    expect(hi).toBeCloseTo(10, 5);
  });

  test("interval widens with more variance, holding n fixed", () => {
    const tight = meanConfidenceInterval([9, 10, 11, 9, 10, 11, 9, 10, 11, 10])!;
    const wide = meanConfidenceInterval([1, 20, 3, 18, 5, 16, 7, 14, 9, 12])!;
    expect(wide[1] - wide[0]).toBeGreaterThan(tight[1] - tight[0]);
  });
});

describe("hasSufficientData", () => {
  test("uses the spec's default n=30 threshold when unspecified", () => {
    expect(hasSufficientData(29)).toBe(false);
    expect(hasSufficientData(30)).toBe(true);
  });

  test("respects a caller-supplied threshold override", () => {
    expect(hasSufficientData(10, 5)).toBe(true);
    expect(hasSufficientData(4, 5)).toBe(false);
  });
});
