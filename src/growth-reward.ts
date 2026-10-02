/**
 * Staged allocator reward (docs/closed-loop-spec.md §7). Turns "did this
 * device eventually count as a win" into a real number in [0,1] that
 * matures over a device's real lifetime, feeding
 * `growth-allocator.ts::recordWeightedOutcome`/`selectArmWeighted` (M3,
 * COORDINATION.md — additive extension, see that file's own header).
 */

import type { AppStage } from "./growth-strategy";

export type StagedRewardWeights = { r0: number; r1: number; r2: number };

/** Spec §7.1's own default table. */
export const DEFAULT_STAGED_REWARD_WEIGHTS: StagedRewardWeights = { r0: 0.2, r1: 0.3, r2: 0.5 };

export type StagedRewardInputs = {
  /** R0, available day 1. */
  activated: boolean;
  /** R1, available day 7 — `null` when not yet observable (device is
   * younger than 7 days as of the computation's `asOfIso`), never guessed
   * at as `false`. */
  d7Retained: boolean | null;
  /** R2's retention component, available day 30 — same null-until-
   * observable discipline as `d7Retained`. */
  d30Retained: boolean | null;
  /** R2's revenue component: revenue-to-date for launch/traction, or
   * projected LTV for growth/scale (spec §7.1: "in Growth and Scale, R2
   * uses projected LTV instead of revenue to date") — the caller resolves
   * which one this is, based on `stage`; this function only needs the
   * resulting number. `null` when no data exists yet. */
  revenueOrLtvUsd: number | null;
  /** The arm's own CAC — the natural reference point for "did this device
   * pay back its acquisition cost," which is exactly the signal an
   * allocator should reward (v1 design decision, not literally specified
   * by the spec's own R2 formula — disclosed here rather than assumed).
   * `null` when CAC isn't computable yet (no spend data). */
  cacUsd: number | null;
};

export type StagedReward = {
  /** The reward accumulated so far, out of `maturedWeight` (not out of 1 —
   * see `normalizedReward` for that). */
  reward: number;
  /** How much of the total weight (r0+r1+r2) has actually matured/been
   * observed — spec §7.1: "posteriors update as each stage matures. Early
   * stages act as a proxy." At day 1, only r0 has matured. */
  maturedWeight: number;
  /** `reward / maturedWeight`, clamped to [0,1] — the value
   * `recordWeightedOutcome` actually wants. `null` when nothing has
   * matured at all (shouldn't happen in practice, since r0 always matures
   * from day 1, but handled honestly rather than dividing by zero). */
  normalizedReward: number | null;
};

const REVENUE_RETENTION_BLEND = 0.5; // v1 design decision, disclosed below

/**
 * Pure. Computes the staged reward for one device's current state.
 *
 * R2's "D30 retained + revenue to date" (spec §7.1) isn't given an exact
 * combining formula by the spec — this is a real, disclosed v1 design
 * decision: R2's own weight splits evenly between "did they come back on
 * day 30" and "did their revenue/LTV clear their own acquisition cost,"
 * since both are genuine signals an allocator should care about and
 * neither alone tells the whole story (a device can retain without ever
 * paying, or convert once and churn immediately).
 */
export function computeStagedReward(
  inputs: StagedRewardInputs,
  weights: StagedRewardWeights = DEFAULT_STAGED_REWARD_WEIGHTS,
): StagedReward {
  let reward = 0;
  let maturedWeight = 0;

  // R0 — always observable from day 1.
  reward += weights.r0 * (inputs.activated ? 1 : 0);
  maturedWeight += weights.r0;

  // R1 — matures day 7.
  if (inputs.d7Retained !== null) {
    reward += weights.r1 * (inputs.d7Retained ? 1 : 0);
    maturedWeight += weights.r1;
  }

  // R2 — matures day 30, blends retention and revenue payback.
  if (inputs.d30Retained !== null) {
    const revenueFraction =
      inputs.revenueOrLtvUsd !== null && inputs.cacUsd !== null && inputs.cacUsd > 0
        ? Math.min(1, inputs.revenueOrLtvUsd / inputs.cacUsd)
        : 0;
    const retentionFraction = inputs.d30Retained ? 1 : 0;
    const r2Score = REVENUE_RETENTION_BLEND * retentionFraction + (1 - REVENUE_RETENTION_BLEND) * revenueFraction;
    reward += weights.r2 * r2Score;
    maturedWeight += weights.r2;
  }

  return {
    reward,
    maturedWeight,
    normalizedReward: maturedWeight > 0 ? Math.min(1, Math.max(0, reward / maturedWeight)) : null,
  };
}

/** Picks whether R2 should use revenue-to-date or projected LTV, per spec
 * §7.1's stage-dependent rule. Pure, trivial, but named so callers never
 * have to re-derive this decision inline. */
export function r2RevenueSourceForStage(stage: AppStage): "revenue_to_date" | "projected_ltv" {
  return stage === "growth" || stage === "scale" ? "projected_ltv" : "revenue_to_date";
}

export type RewardHistoryPoint = { r0: number; r1: number; r2: number };

/**
 * Pure. Real ordinary-least-squares regression of R2 on R0 and R1 across
 * the app's real history — spec §7.1: "the proxy's weights are
 * recalibrated monthly by regressing R2 on R0 and R1 across the app's
 * history." Solves `r2 = a*r0 + b*r1 + c` via the normal equations, then
 * renormalizes `{a, b}` (plus a fixed r2 weight of the original 0.5, since
 * this regression only re-weights the *proxy* signals against the *real*
 * outcome, not r2's own weight) into a real `StagedRewardWeights`. Returns
 * `null` when there's too little history to fit meaningfully (fewer than
 * 10 points) or the regression is degenerate (e.g. every r0/r1 identical),
 * rather than returning a fabricated confident answer.
 */
export function recalibrateStagedRewardWeights(history: RewardHistoryPoint[]): StagedRewardWeights | null {
  const n = history.length;
  if (n < 10) return null;

  // Design matrix columns: [r0, r1, 1] (intercept), target: r2.
  let sumR0 = 0;
  let sumR1 = 0;
  let sumR0R0 = 0;
  let sumR1R1 = 0;
  let sumR0R1 = 0;
  let sumR0R2 = 0;
  let sumR1R2 = 0;
  let sumR2 = 0;
  for (const p of history) {
    sumR0 += p.r0;
    sumR1 += p.r1;
    sumR0R0 += p.r0 * p.r0;
    sumR1R1 += p.r1 * p.r1;
    sumR0R1 += p.r0 * p.r1;
    sumR0R2 += p.r0 * p.r2;
    sumR1R2 += p.r1 * p.r2;
    sumR2 += p.r2;
  }

  // Normal equations for [a, b, c] minimizing sum((a*r0+b*r1+c - r2)^2):
  //   [ sumR0R0  sumR0R1  sumR0 ] [a]   [sumR0R2]
  //   [ sumR0R1  sumR1R1  sumR1 ] [b] = [sumR1R2]
  //   [ sumR0    sumR1    n     ] [c]   [sumR2  ]
  const A = [
    [sumR0R0, sumR0R1, sumR0],
    [sumR0R1, sumR1R1, sumR1],
    [sumR0, sumR1, n],
  ];
  const b = [sumR0R2, sumR1R2, sumR2];
  const solved = solve3x3(A, b);
  if (!solved) return null;
  const [a, bCoef] = solved;

  // Renormalize the two proxy weights (a, bCoef) to sum to the original
  // r0+r1 total (0.5), keeping r2's own weight fixed at 0.5 — this
  // recalibration answers "how should r0 vs r1 be weighted relative to
  // each other," not "how much should r2 matter overall."
  const proxyTotal = DEFAULT_STAGED_REWARD_WEIGHTS.r0 + DEFAULT_STAGED_REWARD_WEIGHTS.r1;
  const absSum = Math.abs(a) + Math.abs(bCoef);
  if (absSum === 0 || !Number.isFinite(absSum)) return null;
  return {
    r0: (Math.abs(a) / absSum) * proxyTotal,
    r1: (Math.abs(bCoef) / absSum) * proxyTotal,
    r2: DEFAULT_STAGED_REWARD_WEIGHTS.r2,
  };
}

/** Solves a 3x3 linear system via Cramer's rule. Returns `null` on a
 * (near-)singular matrix rather than returning `Infinity`/`NaN` — a
 * degenerate regression (e.g. every r0 identical) has no meaningful
 * solution and must be reported as such, not guessed at. */
function solve3x3(A: number[][], b: number[]): [number, number, number] | null {
  const det = determinant3x3(A);
  if (Math.abs(det) < 1e-10) return null;
  const Ax = [
    [b[0]!, A[0]![1]!, A[0]![2]!],
    [b[1]!, A[1]![1]!, A[1]![2]!],
    [b[2]!, A[2]![1]!, A[2]![2]!],
  ];
  const Ay = [
    [A[0]![0]!, b[0]!, A[0]![2]!],
    [A[1]![0]!, b[1]!, A[1]![2]!],
    [A[2]![0]!, b[2]!, A[2]![2]!],
  ];
  const Az = [
    [A[0]![0]!, A[0]![1]!, b[0]!],
    [A[1]![0]!, A[1]![1]!, b[1]!],
    [A[2]![0]!, A[2]![1]!, b[2]!],
  ];
  return [determinant3x3(Ax) / det, determinant3x3(Ay) / det, determinant3x3(Az) / det];
}

function determinant3x3(m: number[][]): number {
  const [a, b, c] = m[0]!;
  const [d, e, f] = m[1]!;
  const [g, h, i] = m[2]!;
  return a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
}
