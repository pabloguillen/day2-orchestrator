import { describe, expect, test } from "bun:test";
import {
  borrowPriorLtv,
  computeLtv,
  computeLtvArpuTimesLifetime,
  computeLtvRetentionCurveProjection,
  fitExponentialRetentionCurve,
  projectRetainedFraction,
} from "./ltv";

describe("computeLtvArpuTimesLifetime", () => {
  test("real ARPPU x conversion x lifetime-from-churn", () => {
    // $20 ARPPU, 10% paid conversion, 5% monthly churn -> 20 months expected lifetime
    const result = computeLtvArpuTimesLifetime(20, 0.1, 0.05, 50);
    expect(result.ltvUsd).toBeCloseTo(20 * 0.1 * 20, 5);
    expect(result.confidence).toBe("low"); // spec: "flag as low confidence"
    expect(result.method).toBe("arpu_x_lifetime");
  });

  test("missing inputs or zero/negative churn reports null, never divides by zero", () => {
    expect(computeLtvArpuTimesLifetime(null, 0.1, 0.05, 10).ltvUsd).toBeNull();
    expect(computeLtvArpuTimesLifetime(20, 0.1, 0, 10).ltvUsd).toBeNull();
    expect(computeLtvArpuTimesLifetime(20, 0.1, -0.01, 10).ltvUsd).toBeNull();
  });
});

describe("fitExponentialRetentionCurve + projectRetainedFraction", () => {
  test("fits a real decay rate through a genuine exponential-decay dataset", () => {
    // Generated from rate = exp(-0.05 * day): day1=0.951, day7=0.705, day30=0.223
    const fit = fitExponentialRetentionCurve([
      { day: 1, rate: 0.951 },
      { day: 7, rate: 0.705 },
      { day: 30, rate: 0.223 },
    ])!;
    expect(fit.decayRatePerDay).toBeCloseTo(0.05, 2);
  });

  test("projectRetainedFraction correctly applies the fitted decay", () => {
    expect(projectRetainedFraction(0.05, 0)).toBeCloseTo(1, 5);
    expect(projectRetainedFraction(0.05, 30)).toBeCloseTo(Math.exp(-1.5), 5);
  });

  test("fewer than 2 usable points returns null, not a fabricated fit", () => {
    expect(fitExponentialRetentionCurve([])).toBeNull();
    expect(fitExponentialRetentionCurve([{ day: 1, rate: 0.9 }])).toBeNull();
  });

  test("a non-positive or out-of-range rate is excluded from the fit rather than corrupting it", () => {
    const fit = fitExponentialRetentionCurve([
      { day: 1, rate: 0.9 },
      { day: 7, rate: 0 }, // excluded — log(0) is -Infinity
      { day: 30, rate: 0.3 },
    ]);
    expect(fit).not.toBeNull();
    expect(Number.isFinite(fit!.decayRatePerDay)).toBe(true);
  });
});

describe("computeLtvRetentionCurveProjection", () => {
  test("projects real cumulative revenue over 12 months from a fitted curve", () => {
    const result = computeLtvRetentionCurveProjection(
      [
        { day: 1, rate: 0.951 },
        { day: 7, rate: 0.705 },
        { day: 30, rate: 0.223 },
      ],
      10, // $10/month ARPU
    );
    expect(result.ltvUsd).not.toBeNull();
    expect(result.ltvUsd!).toBeGreaterThan(0);
    expect(result.ltvUsd!).toBeLessThan(10 * 12); // must be less than "everyone stays forever" upper bound
    expect(result.confidence).toBe("medium");
  });

  test("insufficient data reports null with an honest basis string, not a guessed value", () => {
    const result = computeLtvRetentionCurveProjection([], 10);
    expect(result.ltvUsd).toBeNull();
    expect(result.basis).toContain("insufficient");
  });
});

describe("borrowPriorLtv", () => {
  test("real average across comparable apps when they exist", () => {
    const result = borrowPriorLtv([100, 200, 300]);
    expect(result.ltvUsd).toBeCloseTo(200, 5);
    expect(result.method).toBe("borrowed_prior");
  });

  test("zero comparable apps (day2's real current state — exactly one app) reports null, honestly explained", () => {
    const result = borrowPriorLtv([]);
    expect(result.ltvUsd).toBeNull();
    expect(result.basis).toContain("expense-buddy");
  });
});

describe("computeLtv (stage-based dispatch)", () => {
  test("launch/traction stage with >=90 days of data uses the ARPU x lifetime method", () => {
    const result = computeLtv({
      stage: "launch",
      daysOfData: 120,
      arppuUsd: 20,
      paidConversionRate: 0.1,
      monthlyChurnRate: 0.05,
      n: 50,
      retentionPoints: [],
      arpuPerMonthUsd: null,
      comparableAppLtvsUsd: [],
    });
    expect(result.method).toBe("arpu_x_lifetime");
  });

  test("growth/scale stage with >=90 days of data uses the retention-curve projection", () => {
    const result = computeLtv({
      stage: "growth",
      daysOfData: 120,
      arppuUsd: null,
      paidConversionRate: null,
      monthlyChurnRate: null,
      n: 0,
      retentionPoints: [
        { day: 1, rate: 0.951 },
        { day: 30, rate: 0.223 },
      ],
      arpuPerMonthUsd: 10,
      comparableAppLtvsUsd: [],
    });
    expect(result.method).toBe("retention_curve_projection");
  });

  test("under 90 days of data with a real comparable app prefers the borrowed prior regardless of stage", () => {
    const result = computeLtv({
      stage: "growth",
      daysOfData: 30,
      arppuUsd: null,
      paidConversionRate: null,
      monthlyChurnRate: null,
      n: 0,
      retentionPoints: [],
      arpuPerMonthUsd: null,
      comparableAppLtvsUsd: [150],
    });
    expect(result.method).toBe("borrowed_prior");
    expect(result.ltvUsd).toBe(150);
  });

  test("under 90 days AND no comparable apps (expense-buddy's real state) falls through to the real in-app estimate, not a null dead end", () => {
    const result = computeLtv({
      stage: "launch",
      daysOfData: 10,
      arppuUsd: 20,
      paidConversionRate: 0.1,
      monthlyChurnRate: 0.05,
      n: 5,
      retentionPoints: [],
      arpuPerMonthUsd: null,
      comparableAppLtvsUsd: [],
    });
    expect(result.method).toBe("arpu_x_lifetime");
    expect(result.ltvUsd).not.toBeNull();
  });
});
