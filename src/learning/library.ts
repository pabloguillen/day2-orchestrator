import { createHmac, randomUUID } from "node:crypto";
import { tidy, unsafeReason } from "../memory/privacy";
import { CHANGE_KINDS, isCategory, isChangeKind, METRICS, nBucket, PLATFORMS, PRODUCT_TYPES, type Category, type ChangeKind, type Metric, type NBucket, type Platform, type ProductType } from "./taxonomy";

/**
 * The outcome library: one anonymous, normalized record per measured result
 * day2 decided anywhere (Live verdicts, Money tests, Messages against their
 * holdouts, Store tests, retention treatments, ad bets). Shared by all apps
 * of all accounts that didn't opt out, so day2 can start each app from what
 * worked for similar ones.
 *
 * Privacy (checked here, not only promised): no app names, no texts, no user
 * numbers, no revenue amounts, no identifiers. Effects are relative (+6%),
 * sizes are buckets ("1k-10k"), dates are days. The app is kept only as a
 * salted hash so one app can't count twice — never shown, never returned by
 * the API.
 */

export type Verdict = "better" | "worse" | "no_clear_change";
export type OutcomeSource = "live" | "money" | "messages" | "store" | "retention" | "ads" | "social";

export type Outcome = {
  id: string;
  /** Day only (YYYY-MM-DD). */
  at: string;
  /** Salted hash of the app — for counting distinct apps only; never leaves the server. */
  appHash: string;
  /** Salted hash of the app's account — priors need several accounts, and exclude the asking account; never leaves the server. */
  accountHash: string;
  /** Salted hash of the result's own id — the same result is never recorded twice. */
  refHash: string;
  category: Category;
  productType: ProductType;
  platform: Platform;
  kind: ChangeKind;
  /** A few abstract words ("trial 3 → 7 days"), no app content. */
  pattern: string;
  metric: Metric;
  /** Relative effect on the metric (0.06 = +6%) and a 90% interval; null when only the verdict is known. */
  effect: number | null;
  low: number | null;
  high: number | null;
  n: NBucket;
  verdict: Verdict;
  source: OutcomeSource;
};

export type AppContext = { category: Category; productType: ProductType; platform: Platform };

export type OutcomeInput = {
  appId: string;
  /** The app's account (hashed with the salt; only to count accounts and leave the asker's own out). */
  accountId: string;
  /** Used only to make sure the pattern doesn't contain it. */
  appName: string;
  context: AppContext;
  kind: ChangeKind;
  pattern?: string;
  metric: Metric;
  /** Each arm: users and the metric's value (a share, or a mean). */
  control?: { n: number; value: number | null } | null;
  treatment?: { n: number; value: number | null } | null;
  /** Chance the change is better (from the module's own Bayesian test), to derive an interval when the metric isn't a share. */
  probBetter?: number | null;
  /** When the module already has a relative effect and interval. */
  effect?: { lift: number; low: number; high: number } | null;
  /** Users in the test (for the size bucket only). */
  n: number;
  verdict: Verdict;
  source: OutcomeSource;
  /** The result's id in its module (experiment id, campaign id…) — hashed. */
  sourceId: string;
  at: Date;
};

export function hashWith(salt: string, value: string): string {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 24);
}

const SHARE_METRICS: ReadonlySet<Metric> = new Set<Metric>(["d7_retention", "conversion", "store_conversion", "return_rate", "click_rate", "engagement_rate"]);
const Z90 = 1.6449;

/** Inverse of the standard normal CDF (Acklam's approximation). */
export function normInv(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (q < lo) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1);
  }
  if (q > 1 - lo) return -normInv(1 - q);
  const r = q - 0.5;
  const s = r * r;
  return ((((((a[0]! * s + a[1]!) * s + a[2]!) * s + a[3]!) * s + a[4]!) * s + a[5]!) * r) / (((((b[0]! * s + b[1]!) * s + b[2]!) * s + b[3]!) * s + b[4]!) * s + 1);
}

export function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 on erf.
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Relative effect with a 90% interval, on the log scale: for shares from the
 * arms (delta method), else from the module's own P(better) and the point
 * estimate. Null when the arms don't allow it.
 */
export function relativeEffect(metric: Metric, control: { n: number; value: number | null }, treatment: { n: number; value: number | null }, probBetter?: number | null): { lift: number; low: number; high: number } | null {
  const c = control.value;
  const t = treatment.value;
  if (c === null || t === null || !(c > 0) || !(t >= 0) || control.n < 1 || treatment.n < 1) return null;
  const ratio = Math.max(t, 1e-6) / c;
  const y = Math.log(ratio);
  let se: number | null = null;
  if (SHARE_METRICS.has(metric) && c < 1 && t > 0 && t < 1) {
    se = Math.sqrt((1 - t) / (treatment.n * t) + (1 - c) / (control.n * c));
  } else if (typeof probBetter === "number" && probBetter > 0.001 && probBetter < 0.999 && Math.abs(y) > 1e-6) {
    const z = normInv(probBetter);
    if (Math.abs(z) > 0.05 && Math.sign(z) === Math.sign(y)) se = Math.abs(y / z);
  }
  if (se === null || !Number.isFinite(se)) se = Math.max(0.25, Math.abs(y));
  return { lift: ratio - 1, low: Math.exp(y - Z90 * se) - 1, high: Math.exp(y + Z90 * se) - 1 };
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/** Money and texts: what a pattern must never contain. */
const MONEY = /[€$£¥₹]|\b(usd|eur|gbp|chf|jpy)\b|\b\d+[.,]\d{2}\b/i;
const QUOTE = /["“”„«»]/;

/**
 * The pattern in a few abstract words: the caller's words when they pass
 * the privacy checks (no app name or words from it, no money, no quotes,
 * no secrets or personal data, at most 8 words), else the change kind's label.
 */
export function safePattern(kind: ChangeKind, pattern: string | undefined, appName: string): string {
  const fallback = CHANGE_KINDS[kind].label;
  if (!pattern) return fallback;
  const p = tidy(pattern, 60);
  const nameWords = appName.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length >= 3);
  const lower = p.toLowerCase();
  if (nameWords.some((w) => lower.includes(w)) || lower.includes(appName.toLowerCase())) return fallback;
  if (MONEY.test(p) || QUOTE.test(p) || unsafeReason(p) || p.split(/\s+/).length > 8) return fallback;
  return p;
}

export type MakeResult = { ok: true; outcome: Outcome } | { ok: false; why: string };

/** Pure. The anonymous record for a decided result. */
export function makeOutcome(input: OutcomeInput, salt: string): MakeResult {
  if (!isChangeKind(input.kind)) return { ok: false, why: "unknown kind of change" };
  if (!isCategory(input.context.category)) return { ok: false, why: "unknown category" };
  if (!(METRICS as readonly string[]).includes(input.metric)) return { ok: false, why: "unknown metric" };
  const e = input.effect ?? (input.control && input.treatment ? relativeEffect(input.metric, input.control, input.treatment, input.probBetter) : null);
  const ok = (x: number) => Number.isFinite(x) && x > -1 && x < 20;
  const effect = e && ok(e.lift) && ok(e.low) && ok(e.high) ? e : null;
  return {
    ok: true,
    outcome: {
      id: `o-${randomUUID().slice(0, 12)}`,
      at: input.at.toISOString().slice(0, 10),
      appHash: hashWith(salt, `app:${input.appId}`),
      accountHash: hashWith(salt, `account:${input.accountId}`),
      refHash: hashWith(salt, `ref:${input.appId}:${input.source}:${input.sourceId}`),
      category: input.context.category,
      productType: (PRODUCT_TYPES as readonly string[]).includes(input.context.productType) ? input.context.productType : "unknown",
      platform: (PLATFORMS as readonly string[]).includes(input.context.platform) ? input.context.platform : "both",
      kind: input.kind,
      pattern: safePattern(input.kind, input.pattern, input.appName),
      metric: input.metric,
      effect: effect ? round(effect.lift) : null,
      low: effect ? round(Math.min(effect.low, effect.lift)) : null,
      high: effect ? round(Math.max(effect.high, effect.lift)) : null,
      n: nBucket(input.n),
      verdict: input.verdict,
      source: input.source,
    },
  };
}

/** What an operator (or a test) may see: no hashes. */
export function publicOutcome(o: Outcome): Omit<Outcome, "appHash" | "accountHash" | "refHash"> {
  const { appHash: _a, accountHash: _c, refHash: _r, ...rest } = o;
  return rest;
}
