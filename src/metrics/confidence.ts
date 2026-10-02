/**
 * Confidence-interval primitives (docs/closed-loop-spec.md §4.1). Pure math,
 * zero event/domain knowledge — same "pure core first" discipline every
 * other component in this project follows (`evaluateSpend`/`selectArm`/
 * `evaluateExperiment` are all pure).
 */

import { MIN_N_FOR_CONFIDENT_BREAKDOWN } from "./types";

/** 95% Wilson score interval for a binomial proportion — the standard,
 * correct choice for rate metrics (CTR, activation rate, crash-free
 * sessions, etc.) at small-to-moderate `n`, where a naive normal
 * approximation can produce an out-of-[0,1] interval. Returns `null` when
 * `total` is 0 (nothing to bound). Reference-checked in the test suite
 * against known values (e.g. 1/1 at 95% ≈ [0.206, 1.0]). */
export function wilsonScoreInterval(successes: number, total: number, z = 1.96): [number, number] | null {
  if (total <= 0) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  const lower = (center - margin) / denominator;
  const upper = (center + margin) / denominator;
  return [Math.max(0, lower), Math.min(1, upper)];
}

/** 95% CI for a sample mean via the normal approximation (sample stdev /
 * sqrt(n)) — appropriate for count/currency-valued metrics (ARPU, sessions
 * per user) where Wilson's binomial assumption doesn't apply. Returns
 * `null` for `n < 2` (no variance estimate possible) or an empty array. */
export function meanConfidenceInterval(values: number[], z = 1.96): [number, number] | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const stderr = Math.sqrt(variance / n);
  const margin = z * stderr;
  return [mean - margin, mean + margin];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Spec §5's uniform gate: every KPI checks this before treating a value as
 * decision-grade, not just checking `value !== null`. */
export function hasSufficientData(n: number, minN: number = MIN_N_FOR_CONFIDENT_BREAKDOWN): boolean {
  return n >= minN;
}
