/**
 * Monetization domain (docs/closed-loop-spec.md §4.3). Revenue/refund
 * figures come from `PaymentIngestRow[]` (external-ingest.ts, M1) — "the
 * payments provider is the source of truth for revenue" (spec §2.3), not
 * app-side `payment_succeeded` events, which are a real signal but not
 * where dollar amounts should be trusted from. Funnel counts (trial ->
 * subscription) are purely event-based.
 */

import type { PaymentIngestRow } from "../external-ingest";
import { hasSufficientData, meanConfidenceInterval, wilsonScoreInterval } from "./confidence";
import { computeRateMetric, groupAllDevices } from "./core";
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

// ---------------------------------------------------------------------------
// Revenue from the app's own events (Live, docs/live.md): `revenue` events
// carry `value: { amount, currency }`; `refund` events subtract. Lets Live
// judge money experiments without depending on the Money module.
// ---------------------------------------------------------------------------

/** Event types that carry money, and their sign. */
export const REVENUE_EVENT_SIGN: Record<string, 1 | -1> = { revenue: 1, refund: -1 };

/** The currency most of the money is in — amounts in other currencies are left out rather than mixed. */
export function mainCurrency(events: EventLike[]): string | null {
  const counts = new Map<string, number>();
  for (const e of events) if (e.value && REVENUE_EVENT_SIGN[e.type]) counts.set(e.value.currency, (counts.get(e.value.currency) ?? 0) + 1);
  let best: string | null = null;
  for (const [c, n] of counts) if (best === null || n > counts.get(best)!) best = c;
  return best;
}

/** Who an event belongs to: the hashed user when known, else the device. */
export const unitOf = (e: EventLike) => e.userId ?? e.deviceId;

/** Money per unit (user, else device), in one currency; units without money count as 0 when listed in `units`. */
export function revenueByUnit(events: EventLike[], currency: string | null = mainCurrency(events)): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const sign = REVENUE_EVENT_SIGN[e.type];
    if (!sign || !e.value || e.value.currency !== currency) continue;
    out.set(unitOf(e), (out.get(unitOf(e)) ?? 0) + sign * e.value.amount);
  }
  return out;
}

/** Revenue per user (all units that sent any event), by a breakdown dimension, with a mean CI. */
export function computeRevenuePerUser(events: EventLike[], dimension: BreakdownDimension = "app"): MetricValue[] {
  const currency = mainCurrency(events);
  const { groups } = groupAllDevices(events, dimension);
  const perDevice = new Map<string, number>();
  for (const e of events) {
    const sign = REVENUE_EVENT_SIGN[e.type];
    if (!sign || !e.value || e.value.currency !== currency) continue;
    perDevice.set(e.deviceId, (perDevice.get(e.deviceId) ?? 0) + sign * e.value.amount);
  }
  const out: MetricValue[] = [];
  for (const [key, devices] of groups) {
    const xs = devices.map((d) => perDevice.get(d) ?? 0);
    const n = xs.length;
    const value = n ? xs.reduce((a, b) => a + b, 0) / n : null;
    out.push({ metric: "revenue_per_user", breakdown: dimension === "app" ? {} : { [dimension]: key }, value, n, ci: n >= 2 ? meanConfidenceInterval(xs) : null, sufficientData: hasSufficientData(n) });
  }
  return out;
}

/** Revenue per exposed unit in each variant of one Live experiment (from its `exposure` events onwards). */
export function revenuePerUserByVariant(events: EventLike[], experimentId: string): Record<string, { n: number; total: number; perUser: number | null; currency: string | null }> {
  const currency = mainCurrency(events);
  const firstSeen = new Map<string, { at: string; variant: string }>();
  for (const e of events) {
    if (e.type !== "exposure" || e.props?.exp !== experimentId || typeof e.props.variant !== "string") continue;
    const u = unitOf(e);
    const have = firstSeen.get(u);
    if (!have || e.at < have.at) firstSeen.set(u, { at: e.at, variant: e.props.variant });
  }
  const money = new Map<string, number>();
  for (const e of events) {
    const sign = REVENUE_EVENT_SIGN[e.type];
    const f = firstSeen.get(unitOf(e));
    if (!sign || !e.value || e.value.currency !== currency || !f || e.at < f.at) continue;
    money.set(unitOf(e), (money.get(unitOf(e)) ?? 0) + sign * e.value.amount);
  }
  const out: Record<string, { n: number; total: number; perUser: number | null; currency: string | null }> = {};
  for (const [u, f] of firstSeen) {
    const v = (out[f.variant] ??= { n: 0, total: 0, perUser: null, currency });
    v.n += 1;
    v.total += money.get(u) ?? 0;
  }
  for (const v of Object.values(out)) v.perUser = v.n ? v.total / v.n : null;
  return out;
}
