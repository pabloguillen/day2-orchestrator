import { normCdf, type Outcome } from "./library";
import { CHANGE_KINDS, METRIC_LABEL, similarApps, similarity, type Category, type ChangeKind, type Metric } from "./taxonomy";

/**
 * What the outcome library says about one kind of change for one kind of
 * app: a partial-pooling (random-effects) estimate on the log scale.
 *
 *   each app's result  y_a ~ N(θ_a, se_a²)          (one per app: its own results pooled first)
 *   each app's effect  θ_a ~ N(μ, τ²)                (apps differ by τ, DerSimonian–Laird)
 *
 * Results from other categories count with a weight from how similar the
 * category is (taxonomy.ts `similarity`, after pattern-transferability.ts'
 * idea that a pattern only transfers as far as its mechanism allows), so a
 * category's own apps dominate once it has some, and the global data fills
 * in before that. For a new app the predictive spread adds τ² — the honest
 * "how much apps differ".
 *
 * Shown only from MIN_APPS distinct apps with a measured effect in MIN_APPS
 * distinct accounts, so no single app's (or account's) result can be
 * read back out of it.
 */

export const MIN_APPS = 3;

export type Prior = {
  kind: ChangeKind;
  category: Category | "any";
  metric: Metric;
  /** Distinct apps behind it (weighted ones included). */
  apps: number;
  /** Of the similar apps (same family), how many saw it help — { 0, 0 } when fewer than MIN_APPS accounts are behind them. */
  similar: { better: number; of: number };
  /** Of all apps behind it, how many saw it help. */
  overall: { better: number; of: number };
  /** Posterior mean and variance of the log effect for this kind of app. */
  mean: number;
  variance: number;
  /** Between-app variance (τ²). */
  tau2: number;
  /** Chance it helps a new app like this one (predictive). */
  pHelps: number;
  /** The middle half of apps: relative effects. */
  typical: { low: number; high: number };
};

type Obs = { app: string; account: string; y: number; v: number; s: number; category: Category; better: boolean };
type VerdictOf = { better: boolean; category: Category; account: string };

const Z90 = 1.6449;

/** One observation per app: its results pooled (inverse variance). Apps and accounts in `exclude` are left out. */
function perApp(outcomes: Outcome[], category: Category | "any", kind: ChangeKind, exclude: { app?: string; account?: string }): { obs: Obs[]; verdicts: Map<string, VerdictOf> } {
  const byApp = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    if (o.kind !== kind || o.appHash === exclude.app || (exclude.account !== undefined && o.accountHash === exclude.account)) continue;
    (byApp.get(o.appHash) ?? byApp.set(o.appHash, []).get(o.appHash)!).push(o);
  }
  const obs: Obs[] = [];
  const verdicts = new Map<string, VerdictOf>();
  for (const [app, list] of byApp) {
    const cat = list[0]!.category;
    const account = list[0]!.accountHash;
    verdicts.set(app, { better: list.filter((o) => o.verdict === "better").length > list.filter((o) => o.verdict === "worse").length, category: cat, account });
    let sw = 0;
    let sy = 0;
    for (const o of list) {
      if (o.effect === null || o.low === null || o.high === null) continue;
      const y = Math.log(1 + o.effect);
      const se = Math.max(0.005, (Math.log(1 + o.high) - Math.log(1 + o.low)) / (2 * Z90));
      sw += 1 / (se * se);
      sy += y / (se * se);
    }
    if (!sw) continue;
    obs.push({ app, account, y: sy / sw, v: 1 / sw, s: category === "any" ? 1 : similarity(category, cat, kind), category: cat, better: verdicts.get(app)!.better });
  }
  return { obs, verdicts };
}

const accounts = (xs: Array<{ account: string }>) => new Set(xs.map((x) => x.account)).size;

/** DerSimonian–Laird between-app variance, with the similarity weights. */
export function tauSquared(obs: Array<{ y: number; v: number; s: number }>): number {
  if (obs.length < 2) return 0;
  const w = obs.map((o) => o.s / o.v);
  const sw = w.reduce((a, b) => a + b, 0);
  const mean = obs.reduce((a, o, i) => a + w[i]! * o.y, 0) / sw;
  const q = obs.reduce((a, o, i) => a + w[i]! * (o.y - mean) ** 2, 0);
  const sw2 = w.reduce((a, b) => a + b * b, 0);
  const c = sw - sw2 / sw;
  const df = obs.reduce((a, o) => a + o.s, 0) - 1;
  return c > 0 ? Math.max(0, (q - df) / c) : 0;
}

/** Pure. The prior for (category or "any", kind); null below MIN_APPS distinct apps or without effects. */
export function priorFor(outcomes: Outcome[], q: { category: Category | "any"; kind: ChangeKind; metric?: Metric; excludeApp?: string; excludeAccount?: string }): Prior | null {
  const scoped = q.metric ? outcomes.filter((o) => o.metric === q.metric) : outcomes;
  const { obs, verdicts } = perApp(scoped, q.category, q.kind, { app: q.excludeApp, account: q.excludeAccount });
  // Every number shown comes from at least MIN_APPS apps with a measured effect, in at least MIN_APPS different accounts —
  // so neither one app nor one account (with several apps) can read another app's result back out of it.
  if (obs.length < MIN_APPS || accounts(obs) < MIN_APPS) return null;
  const tau2 = tauSquared(obs);
  // Random-effects pooling with similarity weights: w = s / (v + τ²).
  let sw = 0;
  let sy = 0;
  for (const o of obs) {
    const w = o.s / (o.v + tau2);
    sw += w;
    sy += w * o.y;
  }
  const mean = sy / sw;
  const variance = 1 / sw;
  const predictive = Math.sqrt(variance + tau2);
  const all = [...verdicts.values()];
  const similarList = all.filter((x) => q.category === "any" || similarApps(q.category, x.category));
  // Verdict counts follow the same rule: shown for similar apps only from MIN_APPS accounts, else over all apps (which include the ones above).
  const counted = similarList.length >= MIN_APPS && accounts(similarList) >= MIN_APPS ? similarList : null;
  const metric = q.metric ?? mostCommonMetric(scoped.filter((o) => o.kind === q.kind));
  return {
    kind: q.kind,
    category: q.category,
    metric,
    apps: all.length,
    similar: counted ? { better: counted.filter((x) => x.better).length, of: counted.length } : { better: 0, of: 0 },
    overall: { better: all.filter((x) => x.better).length, of: all.length },
    mean,
    variance,
    tau2,
    pHelps: normCdf(mean / Math.max(predictive, 1e-9)),
    typical: { low: Math.exp(mean - 0.6745 * predictive) - 1, high: Math.exp(mean + 0.6745 * predictive) - 1 },
  };
}

function mostCommonMetric(list: Outcome[]): Metric {
  const counts = new Map<Metric, number>();
  for (const o of list) counts.set(o.metric, (counts.get(o.metric) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "conversion";
}

const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`;

/** Plain words: "Worked in 7 of 9 similar apps, typical +4% to +9% D7 retention". */
export function describePrior(p: Prior): string {
  const who = p.similar.of >= MIN_APPS ? `${p.similar.better} of ${p.similar.of} similar apps` : `${p.overall.better} of ${p.overall.of} apps`;
  const range = Math.round(p.typical.low * 100) === Math.round(p.typical.high * 100) ? pct(p.typical.low) : `${pct(p.typical.low)} to ${pct(p.typical.high)}`;
  return `${CHANGE_KINDS[p.kind].label}: worked in ${who}, typical ${range} ${METRIC_LABEL[p.metric]}`;
}

/**
 * The prior as an informative prior for this app's own Bayesian test, on
 * the log of (treatment / control), capped so it can never outweigh the
 * experiment: its precision is at most half of what the experiment's
 * minimum sample gives. One app's own data still overrides it.
 */
export function experimentPrior(p: Prior, o: { minPerArm: number; baseRate: number | null }): { mean: number; sd: number } {
  const base = Math.min(0.95, Math.max(0.02, o.baseRate ?? 0.2));
  const dataVar = (2 * (1 - base)) / (Math.max(10, o.minPerArm) * base);
  const sd = Math.sqrt(Math.max(p.variance + p.tau2, 2 * dataVar));
  return { mean: p.mean, sd };
}

/** A prior strong enough to shorten an experiment: most similar apps saw it help, clearly. */
export const isStrong = (p: Prior) => p.pHelps >= 0.85 && p.apps >= 5;
