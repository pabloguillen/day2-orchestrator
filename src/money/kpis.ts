import { createHash } from "node:crypto";
import type { PaymentIngestRow } from "../external-ingest";
import { fromUsd, toUsd } from "../ads/fx";
import { computeArppu, computeRefundRate } from "../metrics/monetization-kpis";
import type { EventLike } from "../metrics/types";
import type { MoneyRecord } from "./ledger";
import type { KpiSnapshot } from "./types";

/**
 * Money KPIs from revenue truth (ledger.ts — what Apple and Google
 * confirmed, plus ad revenue the apps report): revenue by source, revenue
 * per user, ARPPU, conversion to paid, trial conversion, refunds, active
 * subscriptions — by experiment variant and by where users came from.
 * Shown in the app's currency (ads/fx.ts). Sandbox purchases never count.
 * ARPPU and the refund rate come from metrics/monetization-kpis.ts, so
 * Money and the metric layer agree.
 */

export const PAYMENTS = new Set(["purchase_verified", "renewal"]);

/** Pure. Ledger records → the metric layer's payment rows (USD). */
export function paymentRows(records: MoneyRecord[]): PaymentIngestRow[] {
  return records
    .filter((r) => !r.sandbox && r.kind !== "ad" && (PAYMENTS.has(r.type) || r.type === "refund"))
    .map((r) => ({
      date: r.at.slice(0, 10),
      revenueUsd: PAYMENTS.has(r.type) ? toUsd(r.amount, r.currency) : 0,
      refundsUsd: r.type === "refund" ? toUsd(r.amount, r.currency) : 0,
      chargebacksUsd: 0,
      ...(r.user ? { deviceOrUserId: r.user } : {}),
    }));
}

/**
 * Pure. Device-reported ad revenue (`revenue` events with `value` and
 * `props.kind: "ad"`, from react-native-google-mobile-ads' paid event) as
 * records. Reads the fields structurally: they exist once Live's event
 * fields are in (props/value), until then there are none.
 */
export function adRevenueRecords(events: EventLike[]): MoneyRecord[] {
  const out: MoneyRecord[] = [];
  for (const e of events) {
    const x = e as EventLike & { value?: { amount?: number; currency?: string }; props?: Record<string, unknown> };
    if (e.type !== "revenue" || x.props?.kind !== "ad" || !x.value || !(Number(x.value.amount) >= 0) || typeof x.value.currency !== "string") continue;
    const placement = typeof x.props.placement === "string" ? x.props.placement : null;
    const id = createHash("sha256").update(`${e.deviceId}|${e.userId ?? ""}|${e.at}|${placement ?? ""}|${x.value.amount}`).digest("hex").slice(0, 24);
    out.push({
      id: `device:${id}`,
      store: "device",
      type: "ad_revenue",
      kind: "ad",
      productId: placement,
      at: e.at,
      amount: Number(x.value.amount),
      currency: x.value.currency,
      user: e.userId ?? null,
      variants: e.variants ?? {},
      source: e.acquisition?.channel ?? null,
      chain: null,
      sandbox: false,
      expiresAt: null,
    });
  }
  return out;
}

const round = (x: number) => Math.round(x * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export type KpiUser = { user: string; variants: Record<string, string>; source: string | null };

/** Pure. */
export function computeKpis(input: { records: MoneyRecord[]; users: KpiUser[]; currency: string; days: number; now: Date }): KpiSnapshot {
  const { currency, now } = input;
  const since = now.getTime() - input.days * 86_400_000;
  const all = input.records.filter((r) => !r.sandbox);
  const inWindow = all.filter((r) => Date.parse(r.at) >= since && Date.parse(r.at) <= now.getTime());
  const money = (r: MoneyRecord) => fromUsd(toUsd(r.amount, r.currency), currency);
  const sum = (rs: MoneyRecord[]) => round(rs.reduce((a, r) => a + money(r), 0));
  const pays = inWindow.filter((r) => PAYMENTS.has(r.type));
  const subscriptions = sum(pays.filter((r) => r.kind === "subscription"));
  const purchases = sum(pays.filter((r) => r.kind === "purchase"));
  const ads = sum(inWindow.filter((r) => r.type === "ad_revenue"));
  const refunds = sum(inWindow.filter((r) => r.type === "refund"));
  const total = round(subscriptions + purchases + ads);
  const net = (rs: MoneyRecord[]) => rs.reduce((a, r) => a + (r.type === "refund" ? -money(r) : PAYMENTS.has(r.type) || r.type === "ad_revenue" ? money(r) : 0), 0);

  const userSet = new Set(input.users.map((u) => u.user));
  for (const r of inWindow) if (r.user) userSet.add(r.user);
  const users = userSet.size;
  const payers = new Set(pays.filter((r) => r.user && r.amount > 0).map((r) => r.user!)).size;

  const rows = paymentRows(inWindow);
  const arppuUsd = computeArppu(rows).value;
  const refundRate = computeRefundRate(rows).value;

  // Trials that had time to convert: started at least 3 days before now, in the window or before.
  const chains = new Map<string, MoneyRecord[]>();
  for (const r of all) if (r.chain) chains.set(r.chain, [...(chains.get(r.chain) ?? []), r]);
  let trials = 0;
  let converted = 0;
  let active = 0;
  for (const rs of chains.values()) {
    rs.sort((a, b) => a.at.localeCompare(b.at));
    const t = rs.find((r) => r.type === "trial_started");
    if (t && Date.parse(t.at) >= since && Date.parse(t.at) <= now.getTime() - 3 * 86_400_000) {
      trials++;
      if (rs.some((r) => PAYMENTS.has(r.type) && r.at > t.at)) converted++;
    }
    const lastPay = [...rs].reverse().find((r) => PAYMENTS.has(r.type) || r.type === "trial_started");
    const ended = lastPay && rs.some((r) => r.at >= lastPay.at && (r.type === "expired" || (r.type === "refund" && r.amount > 0)));
    if (lastPay?.expiresAt && Date.parse(lastPay.expiresAt) > now.getTime() && !ended) active++;
  }

  const variantOf = new Map(input.users.map((u) => [u.user, u.variants]));
  const sourceOf = new Map(input.users.map((u) => [u.user, u.source]));
  const groups = new Map<string, { experiment: string; variant: string; users: Set<string>; revenue: number }>();
  for (const u of input.users)
    for (const [exp, variant] of Object.entries(u.variants)) {
      const k = `${exp}|${variant}`;
      const g = groups.get(k) ?? { experiment: exp, variant, users: new Set<string>(), revenue: 0 };
      g.users.add(u.user);
      groups.set(k, g);
    }
  for (const r of inWindow) {
    const vs = r.user ? (variantOf.get(r.user) ?? r.variants) : r.variants;
    for (const [exp, variant] of Object.entries(vs)) {
      const g = groups.get(`${exp}|${variant}`) ?? { experiment: exp, variant, users: new Set<string>(), revenue: 0 };
      if (r.user) g.users.add(r.user);
      g.revenue += net([r]);
      groups.set(`${exp}|${variant}`, g);
    }
  }
  const sources = new Map<string, { users: Set<string>; revenue: number }>();
  const src = (s: string | null | undefined) => s || "other";
  for (const u of input.users) {
    const s = sources.get(src(u.source)) ?? { users: new Set<string>(), revenue: 0 };
    s.users.add(u.user);
    sources.set(src(u.source), s);
  }
  for (const r of inWindow) {
    const k = src(r.user ? (sourceOf.get(r.user) ?? r.source) : r.source);
    const s = sources.get(k) ?? { users: new Set<string>(), revenue: 0 };
    if (r.user) s.users.add(r.user);
    s.revenue += net([r]);
    sources.set(k, s);
  }

  const netTotal = round(total - refunds);
  return {
    at: now.toISOString(),
    currency,
    days: input.days,
    revenue: { total, subscriptions, purchases, ads, refunds },
    users,
    payers,
    revenuePerUser: users ? round(netTotal / users) : null,
    arppu: arppuUsd === null ? null : round(fromUsd(arppuUsd, currency)),
    conversionToPaid: ratio(payers, users),
    trialConversion: ratio(converted, trials),
    refundRate,
    activeSubscriptions: active,
    byVariant: [...groups.values()].map((g) => ({ experiment: g.experiment, variant: g.variant, users: g.users.size, revenuePerUser: g.users.size ? round(g.revenue / g.users.size) : null })).sort((a, b) => a.experiment.localeCompare(b.experiment) || a.variant.localeCompare(b.variant)),
    bySource: [...sources.entries()].map(([source, s]) => ({ source, users: s.users.size, revenue: round(s.revenue), revenuePerUser: s.users.size ? round(s.revenue / s.users.size) : null })).sort((a, b) => b.revenue - a.revenue),
  };
}
