/**
 * Monetization domain (docs/closed-loop-spec.md §4.3). Revenue/refund
 * figures come from `PaymentIngestRow[]` (external-ingest.ts, M1) — "the
 * payments provider is the source of truth for revenue" (spec §2.3), not
 * app-side `payment_succeeded` events, which are a real signal but not
 * where dollar amounts should be trusted from. Funnel counts (trial ->
 * subscription) are purely event-based.
 */

import type { PaymentIngestRow } from "../external-ingest";
import { hasSufficientData, wilsonScoreInterval } from "./confidence";
import { computeRateMetric } from "./core";
import { BreakdownDimension, EventLike, MetricValue } from "./types";

/** subscription_started / trial_started. */
export function computeTrialToPaid(events: EventLike[], dimension: BreakdownDimension = "app"): MetricValue[] {
  return computeRateMetric(
    "trial_to_paid",
    events,
    dimension,
    (d) => d.some((e) => e.type === "trial_started"),
    (d) => d.some((e) => e.type === "subscription_started"),
  );
}

function sumRevenue(rows: PaymentIngestRow[]): number {
  return rows.reduce((a, r) => a + r.revenueUsd, 0);
}
function sumRefunds(rows: PaymentIngestRow[]): number {
  return rows.reduce((a, r) => a + r.refundsUsd, 0);
}

/** revenue / active users. `activeUserCount` is computed by the caller
 * (e.g. `computeDauWauMau(...).mau[0].value` for a monthly ARPU) — kept as
 * a plain parameter here rather than re-deriving it, since "active" is a
 * config-driven definition this file shouldn't duplicate. */
export function computeArpu(rows: PaymentIngestRow[], activeUserCount: number): MetricValue {
  const revenue = sumRevenue(rows);
  return {
    metric: "arpu",
    breakdown: {},
    value: activeUserCount > 0 ? revenue / activeUserCount : null,
    n: activeUserCount,
    ci: null, // a mean over a currency total divided by a count from a different source; no principled CI form applied here
    sufficientData: hasSufficientData(activeUserCount),
  };
}

/** revenue / paying users — "paying users" = distinct `deviceOrUserId`
 * values with positive revenue in `rows`. Rows with no `deviceOrUserId`
 * (the payment provider couldn't attribute) still count toward total
 * revenue elsewhere but can't contribute to this specific denominator. */
export function computeArppu(rows: PaymentIngestRow[]): MetricValue {
  const revenue = sumRevenue(rows);
  const payingUsers = new Set(rows.filter((r) => r.revenueUsd > 0 && r.deviceOrUserId).map((r) => r.deviceOrUserId!));
  const n = payingUsers.size;
  return {
    metric: "arppu",
    breakdown: {},
    value: n > 0 ? revenue / n : null,
    n,
    ci: null,
    sufficientData: hasSufficientData(n),
  };
}

/** Recurring revenue normalized to a month. v1 honestly treats all ingested
 * revenue as recurring (`PaymentIngestRow` has no one-time-vs-subscription
 * distinction yet) — `rows` should be pre-filtered by the caller to the
 * relevant month; this function just sums what it's given. */
export function computeMrr(rows: PaymentIngestRow[]): MetricValue {
  const revenue = sumRevenue(rows);
  return {
    metric: "mrr",
    breakdown: {},
    value: rows.length > 0 ? revenue : null,
    n: rows.length,
    ci: null,
    sufficientData: hasSufficientData(rows.length),
  };
}

/** refunds / payments (count of rows with a positive payment vs. rows with
 * a refund — same "count of real transactions" denominator spec's own
 * "refunds / payments" wording implies, not refund dollars / revenue
 * dollars, which would answer a different question). */
export function computeRefundRate(rows: PaymentIngestRow[]): MetricValue {
  const payments = rows.filter((r) => r.revenueUsd > 0).length;
  const refunds = rows.filter((r) => r.refundsUsd > 0).length;
  return {
    metric: "refund_rate",
    breakdown: {},
    value: payments > 0 ? refunds / payments : null,
    n: payments,
    ci: payments > 0 ? wilsonScoreInterval(refunds, payments) : null,
    sufficientData: hasSufficientData(payments),
  };
}

/** LTV / CAC — per arm (caller supplies one LTV/CAC pair per arm) and
 * blended. Thin wrapper; the real work is `ltv.ts::computeLtv` and
 * `acquisition-virality-kpis.ts::computeCacPaid`/`computeCacBlended`. */
export function computeLtvToCac(ltvUsd: number | null, cacUsd: number | null, n: number): MetricValue {
  const value = ltvUsd !== null && cacUsd !== null && cacUsd > 0 ? ltvUsd / cacUsd : null;
  return { metric: "ltv_to_cac", breakdown: {}, value, n, ci: null, sufficientData: hasSufficientData(n) };
}

/** Months until cumulative revenue per user >= CAC — v1 assumes a constant
 * monthly ARPU rate for the cohort (a real, disclosed simplification; a
 * full version would integrate the same retention-curve-weighted revenue
 * `ltv.ts`'s Growth/Scale method already fits, deferred here to keep this
 * function a simple, independently-checkable ratio). */
export function computeCacPaybackMonths(cacUsd: number | null, monthlyArpuUsd: number | null, n: number): MetricValue {
  const value = cacUsd !== null && monthlyArpuUsd !== null && monthlyArpuUsd > 0 ? cacUsd / monthlyArpuUsd : null;
  return { metric: "cac_payback_months", breakdown: {}, value, n, ci: null, sufficientData: hasSufficientData(n) };
}
