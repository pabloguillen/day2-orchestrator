import { describe, expect, test } from "bun:test";
import {
  assignVariant,
  evaluateExperiment,
  MIN_SAMPLE_SIZE_PER_ARM,
  type ExperimentConfig,
} from "./experiments";

describe("assignVariant", () => {
  const experiment: ExperimentConfig = {
    name: "table-density",
    variants: [
      { name: "cards", weight: 1 },
      { name: "table", weight: 1 },
    ],
  };

  test("is deterministic: the same device always gets the same variant", () => {
    const first = assignVariant("device-abc123", experiment);
    for (let i = 0; i < 20; i++) {
      expect(assignVariant("device-abc123", experiment)).toBe(first);
    }
  });

  test("different devices are not all assigned the same variant", () => {
    const assignments = new Set(
      Array.from({ length: 50 }, (_, i) => assignVariant(`device-${i}`, experiment)),
    );
    // With 50 devices and 2 real variants, seeing only one variant at all
    // would mean the hash isn't actually varying by device.
    expect(assignments.size).toBeGreaterThan(1);
  });

  test("roughly respects declared weights over a large sample (statistical, generous tolerance)", () => {
    const weighted: ExperimentConfig = {
      name: "weighted-test",
      variants: [
        { name: "minority", weight: 1 },
        { name: "majority", weight: 3 },
      ],
    };
    const N = 4000;
    let majorityCount = 0;
    for (let i = 0; i < N; i++) {
      if (assignVariant(`device-${i}`, weighted) === "majority") majorityCount++;
    }
    const fraction = majorityCount / N;
    // Expected 0.75; a generous +/-0.05 band comfortably absorbs hash
    // distribution noise at this sample size without being a no-op check.
    expect(fraction).toBeGreaterThan(0.7);
    expect(fraction).toBeLessThan(0.8);
  });

  test("the same device can get different variants across different experiments", () => {
    const expA: ExperimentConfig = { name: "exp-a", variants: [{ name: "x", weight: 1 }, { name: "y", weight: 1 }] };
    const expB: ExperimentConfig = { name: "exp-b", variants: [{ name: "x", weight: 1 }, { name: "y", weight: 1 }] };
    // Not asserting they *must* differ (that would be flaky — a 50/50 coin
    // flip can coincide) — asserting instead that across many devices, the
    // two experiments' assignments aren't perfectly correlated, which would
    // indicate the experiment name isn't actually part of the hash input.
    let sameCount = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const deviceId = `device-${i}`;
      if (assignVariant(deviceId, expA) === assignVariant(deviceId, expB)) sameCount++;
    }
    expect(sameCount).toBeGreaterThan(0);
    expect(sameCount).toBeLessThan(N); // not perfectly correlated either
  });

  test("throws on an experiment with no variants", () => {
    expect(() => assignVariant("device-1", { name: "empty", variants: [] })).toThrow();
  });

  test("throws on an experiment where all weights are zero", () => {
    expect(() =>
      assignVariant("device-1", { name: "zero-weight", variants: [{ name: "a", weight: 0 }] }),
    ).toThrow();
  });

  test("a single 100%-weight variant always wins", () => {
    const single: ExperimentConfig = { name: "single", variants: [{ name: "only", weight: 1 }] };
    for (let i = 0; i < 10; i++) {
      expect(assignVariant(`device-${i}`, single)).toBe("only");
    }
  });
});

describe("evaluateExperiment", () => {
  test("identical data in both arms: p-value is 1, never significant", () => {
    const data = Array.from({ length: 50 }, () => 10);
    const result = evaluateExperiment(data, data);
    expect(result.pValue).toBeCloseTo(1, 5);
    expect(result.significant).toBe(false);
  });

  test("a real, obvious difference with enough samples is reported as significant", () => {
    // Two clearly separated, low-variance distributions with N well above
    // the minimum — the textbook case a t-test should catch easily.
    const control = Array.from({ length: 50 }, (_, i) => 10 + (i % 3) * 0.1);
    const treatment = Array.from({ length: 50 }, (_, i) => 20 + (i % 3) * 0.1);
    const result = evaluateExperiment(control, treatment);
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.significant).toBe(true);
    expect(result.sufficientPower).toBe(true);
  });

  test("never claims significance below the minimum sample size, even with a tiny p-value's worth of separation", () => {
    // Same clean separation as above, but only a handful of samples —
    // exactly the W16d shape ("47.0 vs 48.0... untested at larger N").
    // Real (non-zero) variance within each arm, so this exercises the
    // actual t-test path rather than the separate zero-variance case.
    const control = [9, 10, 11, 10, 10];
    const treatment = [19, 20, 21, 20, 20];
    const result = evaluateExperiment(control, treatment);
    expect(result.controlN).toBeLessThan(MIN_SAMPLE_SIZE_PER_ARM);
    expect(result.sufficientPower).toBe(false);
    expect(result.significant).toBe(false);
    expect(result.note).toContain("below the minimum");
  });

  test("reports honest N/means even when underpowered, doesn't hide the numbers", () => {
    const result = evaluateExperiment([1, 2, 3], [4, 5, 6]);
    expect(result.controlN).toBe(3);
    expect(result.treatmentN).toBe(3);
    expect(result.controlMean).toBeCloseTo(2, 5);
    expect(result.treatmentMean).toBeCloseTo(5, 5);
  });

  test("fewer than 2 samples in either arm: fails closed with pValue 1, not a crash", () => {
    expect(evaluateExperiment([], [1, 2, 3]).significant).toBe(false);
    expect(evaluateExperiment([1], [1, 2, 3]).significant).toBe(false);
    expect(() => evaluateExperiment([], [])).not.toThrow();
  });

  test("noisy but genuinely overlapping data with enough samples is correctly NOT significant", () => {
    // Two arms drawn from the same distribution shape (just offset by
    // nothing) with real per-sample noise — should not spuriously trip
    // significant despite N being large.
    const seed = (n: number) => ((n * 9301 + 49297) % 233280) / 233280;
    const control = Array.from({ length: 60 }, (_, i) => 10 + (seed(i) - 0.5) * 4);
    const treatment = Array.from({ length: 60 }, (_, i) => 10 + (seed(i + 1000) - 0.5) * 4);
    const result = evaluateExperiment(control, treatment);
    expect(result.significant).toBe(false);
  });
});

// Reference values below are standard, independently-verifiable facts
// about the Student's t-distribution (t-tables / known closed forms), not
// numbers this project invented — validates the incomplete-beta-based
// p-value computation against ground truth rather than only testing it
// against itself.
describe("evaluateExperiment's underlying t-distribution p-value (verified against known reference values)", () => {
  /**
   * Exercises the real p-value path via two synthetic, equal-size,
   * equal-variance samples engineered to produce an exact known (t, df)
   * pair — the p-value function itself is intentionally not exported
   * (only the meaningful evaluateExperiment surface is public API), so
   * validation goes through real sample arrays instead of a private hook.
   *
   * When both arms have the same n and the same sample variance, Welch's
   * df collapses to the standard pooled value df = 2(n-1) regardless of
   * what that shared variance actually is — so picking n = df/2 + 1 (with
   * df chosen so n is a whole, even number) and giving both arms identical
   * +1/-1 alternating deviations (equal variance by construction) makes
   * the resulting t-statistic solvable in closed form.
   */
  function pValueFromRawStats(t: number, df: number): number {
    const n = df / 2 + 1;
    if (!Number.isInteger(n) || n % 2 !== 0) {
      throw new Error(`test helper requires df/2+1 to be a whole, even number; got n=${n}`);
    }
    // Each arm's sample variance (alternating +/-1 around its own mean,
    // half of each): n/(n-1). Standard error of the difference in means:
    // sqrt(2 * variance / n). Solve meanGap = t * standardError.
    const armVariance = n / (n - 1);
    const standardError = Math.sqrt((2 * armVariance) / n);
    const meanGap = t * standardError;
    const deviations = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const control = deviations.map((d) => d);
    const treatment = deviations.map((d) => meanGap + d);
    return evaluateExperiment(control, treatment).pValue;
  }

  test("t=0 always gives p=1, regardless of degrees of freedom", () => {
    expect(evaluateExperiment([5, 5, 5], [5, 5, 5]).pValue).toBeCloseTo(1, 5);
  });

  test("df=10, t=2.228 matches the standard two-tailed 0.05 critical value from published t-tables", () => {
    const p = pValueFromRawStats(2.228, 10);
    expect(p).toBeCloseTo(0.05, 2);
  });

  test("df=30, t=2.042 matches the standard two-tailed 0.05 critical value from published t-tables", () => {
    const p = pValueFromRawStats(2.042, 30);
    expect(p).toBeCloseTo(0.05, 2);
  });

  test("large df approximates the normal distribution's 1.96 -> ~0.05 two-tailed critical value", () => {
    const p = pValueFromRawStats(1.96, 100002);
    expect(p).toBeCloseTo(0.05, 2);
  });

  test("a larger t at fixed df always yields a smaller p-value (monotonicity sanity check)", () => {
    const smallerT = pValueFromRawStats(1.0, 30);
    const largerT = pValueFromRawStats(3.0, 30);
    expect(largerT).toBeLessThan(smallerT);
  });
});
