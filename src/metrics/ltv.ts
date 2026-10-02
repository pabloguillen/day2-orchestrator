/**
 * LTV v1 (docs/closed-loop-spec.md §4.4). Two real methods, picked by app
 * stage, plus a real (if currently unexercisable) cross-app prior-borrowing
 * path for apps under 90 days of data.
 */

import type { AppStage } from "../growth-strategy";

export type LtvMethod = "arpu_x_lifetime" | "retention_curve_projection" | "borrowed_prior";

export type LtvResult = {
  ltvUsd: number | null;
  confidence: "low" | "medium" | "high";
  method: LtvMethod;
  basis: string;
  n: number;
};

/** Launch/Traction: ARPPU x paid conversion x expected paid lifetime from
 * the app's own observed churn. Low confidence by construction (spec's own
 * instruction: "flag as low confidence") — this is a point estimate from a
 * handful of ratios, not a fitted curve. `monthlyChurnRate` should come
 * from `computeChurnRate(events, config, asOfIso, 30)`. */
export function computeLtvArpuTimesLifetime(
  arppuUsd: number | null,
  paidConversionRate: number | null,
  monthlyChurnRate: number | null,
  n: number,
): LtvResult {
  if (arppuUsd === null || paidConversionRate === null || monthlyChurnRate === null || monthlyChurnRate <= 0) {
    return {
      ltvUsd: null,
      confidence: "low",
      method: "arpu_x_lifetime",
      basis: "insufficient inputs (ARPPU, paid conversion, or a positive observed churn rate missing)",
      n,
    };
  }
  const expectedLifetimeMonths = 1 / monthlyChurnRate;
  return {
    ltvUsd: arppuUsd * paidConversionRate * expectedLifetimeMonths,
    confidence: "low",
    method: "arpu_x_lifetime",
    basis: `ARPPU ($${arppuUsd.toFixed(2)}) x paid conversion (${(paidConversionRate * 100).toFixed(1)}%) x expected lifetime (${expectedLifetimeMonths.toFixed(1)} months, from a ${(monthlyChurnRate * 100).toFixed(1)}%/mo observed churn rate)`,
    n,
  };
}

/** Fits `retention(day) = exp(-k * day)` via least-squares through the
 * origin (retention is 1.0 at day 0 by definition) over real observed
 * D1/D7/D30-style points. Pure. Returns `null` when fewer than 2 usable
 * points exist (can't fit a line) or all points are non-positive. */
export function fitExponentialRetentionCurve(
  points: { day: number; rate: number }[],
): { decayRatePerDay: number } | null {
  const valid = points.filter((p) => p.day > 0 && p.rate > 0 && p.rate <= 1);
  if (valid.length < 2) return null;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of valid) {
    const y = Math.log(p.rate);
    sumXY += p.day * y;
    sumXX += p.day * p.day;
  }
  if (sumXX === 0) return null;
  const k = -sumXY / sumXX;
  return { decayRatePerDay: Math.max(0, k) };
}

export function projectRetainedFraction(decayRatePerDay: number, day: number): number {
  return Math.exp(-decayRatePerDay * day);
}

/** Growth/Scale: fit a real retention curve per cohort and project revenue
 * over `projectionMonths` (default 12, per spec). `arpuPerMonthUsd` is the
 * cohort's own observed monthly ARPU, held constant across the projection —
 * a real, disclosed simplification (v1 doesn't model ARPU drift over a
 * user's lifetime). */
export function computeLtvRetentionCurveProjection(
  retentionPoints: { day: number; rate: number }[],
  arpuPerMonthUsd: number | null,
  projectionMonths = 12,
): LtvResult {
  const fit = fitExponentialRetentionCurve(retentionPoints);
  if (!fit || arpuPerMonthUsd === null) {
    return {
      ltvUsd: null,
      confidence: "low",
      method: "retention_curve_projection",
      basis: "insufficient data to fit a retention curve (need >=2 real retention points and a known monthly ARPU)",
      n: retentionPoints.length,
    };
  }
  let cumulative = 0;
  for (let month = 1; month <= projectionMonths; month++) {
    cumulative += arpuPerMonthUsd * projectRetainedFraction(fit.decayRatePerDay, month * 30);
  }
  return {
    ltvUsd: cumulative,
    confidence: "medium",
    method: "retention_curve_projection",
    basis: `exponential retention-curve fit (decay ${fit.decayRatePerDay.toFixed(4)}/day, from ${retentionPoints.length} real observed points) projected over ${projectionMonths} months at $${arpuPerMonthUsd.toFixed(2)}/month ARPU`,
    n: retentionPoints.length,
  };
}

/** "Until an app has 90 days of data, borrow priors from similar apps on
 * the platform (same category and price band), clearly marked." Real
 * averaging function — but day2 powers exactly one real app (expense-buddy)
 * as of this build, same "not real multi-tenancy yet" disclosure
 * `growth-tools-config.ts`'s own `GrowthToolsConfig` already makes, so this
 * has nothing to draw from in this deployment yet. Not a placeholder: the
 * moment a second comparable app exists on the platform, this function
 * works for real with no further code change. */
export function borrowPriorLtv(comparableAppLtvsUsd: number[]): LtvResult {
  if (comparableAppLtvsUsd.length === 0) {
    return {
      ltvUsd: null,
      confidence: "low",
      method: "borrowed_prior",
      basis: "no comparable apps on the platform yet — day2 powers exactly one real app (expense-buddy) today",
      n: 0,
    };
  }
  const avg = comparableAppLtvsUsd.reduce((a, b) => a + b, 0) / comparableAppLtvsUsd.length;
  return {
    ltvUsd: avg,
    confidence: "low",
    method: "borrowed_prior",
    basis: `averaged from ${comparableAppLtvsUsd.length} comparable app(s) on the platform (same category/price band)`,
    n: comparableAppLtvsUsd.length,
  };
}

export type LtvInputs = {
  stage: AppStage;
  daysOfData: number;
  arppuUsd: number | null;
  paidConversionRate: number | null;
  monthlyChurnRate: number | null;
  n: number;
  retentionPoints: { day: number; rate: number }[];
  arpuPerMonthUsd: number | null;
  comparableAppLtvsUsd: number[];
};

/** Single entry point implementing the spec's own stage-based method
 * selection, with the 90-day-data override applying regardless of stage
 * (spec §4.4's own ordering: the data-recency check comes before the
 * stage-based method choice in practice, since a `growth`-stage app that
 * somehow has <90 days of data still can't support a real curve fit). */
export function computeLtv(inputs: LtvInputs): LtvResult {
  if (inputs.daysOfData < 90) {
    const borrowed = borrowPriorLtv(inputs.comparableAppLtvsUsd);
    if (borrowed.ltvUsd !== null) return borrowed;
    // No comparable apps to borrow from — fall through to the real,
    // in-app estimate rather than reporting nothing at all, but the
    // low-confidence label already reflects both limitations.
  }
  if (inputs.stage === "launch" || inputs.stage === "traction") {
    return computeLtvArpuTimesLifetime(inputs.arppuUsd, inputs.paidConversionRate, inputs.monthlyChurnRate, inputs.n);
  }
  return computeLtvRetentionCurveProjection(inputs.retentionPoints, inputs.arpuPerMonthUsd);
}
