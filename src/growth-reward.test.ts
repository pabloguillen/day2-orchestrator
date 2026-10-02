import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STAGED_REWARD_WEIGHTS,
  computeStagedReward,
  r2RevenueSourceForStage,
  recalibrateStagedRewardWeights,
} from "./growth-reward";

describe("computeStagedReward", () => {
  test("day 1: only R0 has matured — activated device scores exactly r0's weight, normalized to 1", () => {
    const result = computeStagedReward({ activated: true, d7Retained: null, d30Retained: null, revenueOrLtvUsd: null, cacUsd: null });
    expect(result.maturedWeight).toBeCloseTo(0.2, 10);
    expect(result.reward).toBeCloseTo(0.2, 10);
    expect(result.normalizedReward).toBeCloseTo(1, 10); // r0/r0 = 1, since only r0 has matured
  });

  test("non-activated device at day 1 scores 0, not null", () => {
    const result = computeStagedReward({ activated: false, d7Retained: null, d30Retained: null, revenueOrLtvUsd: null, cacUsd: null });
    expect(result.normalizedReward).toBe(0);
  });

  test("day 7: R1 matures — activated + retained scores the full matured weight", () => {
    const result = computeStagedReward({ activated: true, d7Retained: true, d30Retained: null, revenueOrLtvUsd: null, cacUsd: null });
    expect(result.maturedWeight).toBeCloseTo(0.5, 10); // r0 + r1
    expect(result.normalizedReward).toBeCloseTo(1, 10);
  });

  test("day 7: activated but NOT D7-retained pulls the normalized score down, doesn't zero it out", () => {
    const result = computeStagedReward({ activated: true, d7Retained: false, d30Retained: null, revenueOrLtvUsd: null, cacUsd: null });
    // reward = 0.2 (r0, activated) + 0 (r1, not retained) = 0.2, matured = 0.5
    expect(result.normalizedReward).toBeCloseTo(0.2 / 0.5, 10);
  });

  test("day 30: full payback (revenue >= CAC) and retained scores the maximum", () => {
    const result = computeStagedReward({
      activated: true,
      d7Retained: true,
      d30Retained: true,
      revenueOrLtvUsd: 50,
      cacUsd: 20, // fully paid back, capped at 1.0
    });
    expect(result.maturedWeight).toBeCloseTo(1, 10);
    expect(result.normalizedReward).toBeCloseTo(1, 10);
  });

  test("day 30: retained but zero revenue still scores partial credit from the retention half of R2", () => {
    const result = computeStagedReward({
      activated: true,
      d7Retained: true,
      d30Retained: true,
      revenueOrLtvUsd: 0,
      cacUsd: 20,
    });
    // r2Score = 0.5*1 (retained) + 0.5*0 (no revenue) = 0.5; reward = 0.2+0.3+0.5*0.5 = 0.75; matured = 1
    expect(result.normalizedReward).toBeCloseTo(0.75, 10);
  });

  test("day 30: partial revenue payback is a real fraction, not all-or-nothing", () => {
    const result = computeStagedReward({
      activated: true,
      d7Retained: true,
      d30Retained: false,
      revenueOrLtvUsd: 10,
      cacUsd: 20, // 50% paid back
    });
    // r2Score = 0.5*0 (not retained) + 0.5*0.5 (half paid back) = 0.25; reward = 0.2+0.3+0.5*0.25 = 0.625
    expect(result.normalizedReward).toBeCloseTo(0.625, 10);
  });

  test("a custom weights table is honored instead of the default", () => {
    const customWeights = { r0: 1, r1: 0, r2: 0 };
    const result = computeStagedReward({ activated: true, d7Retained: null, d30Retained: null, revenueOrLtvUsd: null, cacUsd: null }, customWeights);
    expect(result.maturedWeight).toBe(1);
    expect(result.normalizedReward).toBe(1);
  });
});

describe("r2RevenueSourceForStage", () => {
  test("launch/traction use revenue to date", () => {
    expect(r2RevenueSourceForStage("launch")).toBe("revenue_to_date");
    expect(r2RevenueSourceForStage("traction")).toBe("revenue_to_date");
  });

  test("growth/scale use projected LTV", () => {
    expect(r2RevenueSourceForStage("growth")).toBe("projected_ltv");
    expect(r2RevenueSourceForStage("scale")).toBe("projected_ltv");
  });
});

describe("recalibrateStagedRewardWeights", () => {
  test("too little history (n < 10) returns null, not an overfit guess", () => {
    expect(recalibrateStagedRewardWeights([{ r0: 1, r1: 1, r2: 1 }])).toBeNull();
  });

  test("a real, known-solution dataset (r2 = r0, r1 irrelevant) recovers r0 as the dominant weight", () => {
    // Real reference case: r2 tracks r0 exactly; r1 oscillates with real
    // variance but is uncorrelated with the r0/r2 trend — the regression
    // should attribute essentially all predictive weight to r0. (r1 must
    // genuinely vary, not sit at one constant value, or the design matrix
    // is singular — a literal constant column is collinear with the
    // intercept column, which is a real property of least-squares, not a
    // bug in the solver.) This is also the test that would have caught the
    // transposed-cofactor determinant bug found and fixed while building
    // this: a wrong determinant produces a wildly wrong coefficient split,
    // not a subtly-off one.
    const history = Array.from({ length: 20 }, (_, i) => ({
      r0: i / 20,
      r1: (i % 4) * 0.1 + 0.1,
      r2: i / 20,
    }));
    const result = recalibrateStagedRewardWeights(history)!;
    expect(result).not.toBeNull();
    expect(result.r0).toBeGreaterThan(result.r1);
    // r2's own weight is held fixed by design, not re-derived.
    expect(result.r2).toBe(DEFAULT_STAGED_REWARD_WEIGHTS.r2);
    // The two proxy weights still sum to the original r0+r1 total.
    expect(result.r0 + result.r1).toBeCloseTo(DEFAULT_STAGED_REWARD_WEIGHTS.r0 + DEFAULT_STAGED_REWARD_WEIGHTS.r1, 5);
  });

  test("a dataset where r1 is the real driver recovers r1 as dominant instead", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      r0: (i % 4) * 0.1 + 0.1,
      r1: i / 20,
      r2: i / 20,
    }));
    const result = recalibrateStagedRewardWeights(history)!;
    expect(result.r1).toBeGreaterThan(result.r0);
  });

  test("a degenerate dataset (identical r0/r1 everywhere) returns null rather than a fabricated split", () => {
    const history = Array.from({ length: 15 }, () => ({ r0: 0.5, r1: 0.5, r2: 0.5 }));
    expect(recalibrateStagedRewardWeights(history)).toBeNull();
  });
});
