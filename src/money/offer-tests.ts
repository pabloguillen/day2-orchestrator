import { randomUUID } from "node:crypto";
import type { AppEntry } from "../apps-registry";
import { liveConfigPart } from "./config";
import { planProducts } from "./products";
import { addLog, type AdPlacement, type MoneyFile, type MoneyTest, type Paywall, type Product, type ProductPlan } from "./types";

/**
 * Tests of offers and placements, run by Live's experiments engine:
 * paywall wording and layout, trial length, price, ads on/off and how
 * often. Each one: a control and one variant, the primary metric revenue
 * per user, and D7 retention + crash rate as guardrails (a harder paywall or
 * more ads must not buy revenue with users).
 *
 * Config-only tests (wording, layout, ad frequency, ad on/off) follow the
 * "tests" setting (day2 decides by default). Trial length and price need
 * other products — the stores give everyone in a region the same price and
 * trial for one product — so they create new products and follow the
 * "prices" setting (ask me first by default).
 */

export type LiveExperimentSpec = {
  module: "money";
  name: string;
  hypothesis: string;
  /** "owner": approved on the Money page; "day2": Money's own (Live's autonomy setting applies). */
  by: "owner" | "day2";
  keys: string[];
  variants: MoneyTest["variants"];
  primary: "revenue_per_user";
  guardrails: MoneyTest["guardrails"];
};

/**
 * The part of Live's experiments engine Money uses. Until Live provides it
 * (src/live/), tests wait in "proposed" and the Money page says so.
 */
export type LiveExperimentsPort = {
  start(app: AppEntry, spec: LiveExperimentSpec): Promise<{ id: string }>;
  result(app: AppEntry, id: string): Promise<{ state: "running" | "decided" | "stopped"; winner: string | null; note: string } | null>;
};

export const MAX_RUNNING_TESTS = 1;

const id = () => `mt-${randomUUID().slice(0, 8)}`;
const base = (now: Date) => ({ primary: "revenue_per_user" as const, guardrails: ["d7_retention", "crash_rate"] as MoneyTest["guardrails"], liveId: null, createdAt: now.toISOString(), result: null });

/** The paywall's current config value (what control keeps). */
function paywallValue(file: MoneyFile, placement: string): Record<string, unknown> | null {
  return ((liveConfigPart(file).values ?? {})[`paywall.${placement}`] as Record<string, unknown> | undefined) ?? null;
}

export function layoutTest(file: MoneyFile, w: Paywall, now: Date): MoneyTest | null {
  const v = paywallValue(file, w.placement);
  if (!v) return null;
  return {
    ...base(now),
    id: id(),
    kind: "paywall_layout",
    title: `Paywall “${w.placement}”: products side by side`,
    hypothesis: "Comparing plans side by side makes the highlighted plan's value clearer.",
    keys: [`paywall.${w.placement}`],
    variants: [
      { name: "control", weight: 50, values: { [`paywall.${w.placement}`]: v } },
      { name: "cards", weight: 50, values: { [`paywall.${w.placement}`]: { ...v, layout: "cards" } } },
    ],
    state: file.settings.tests === "auto" ? "proposed" : "waiting_approval",
  };
}

export function copyTest(file: MoneyFile, w: Paywall, alt: { title: string; subtitle?: string; cta?: string; bullets?: string[] }, now: Date): MoneyTest | null {
  const v = paywallValue(file, w.placement);
  if (!v || !alt.title.trim()) return null;
  return {
    ...base(now),
    id: id(),
    kind: "paywall_copy",
    title: `Paywall “${w.placement}”: “${alt.title.trim().slice(0, 60)}”`,
    hypothesis: "Different words for the same offer.",
    keys: [`paywall.${w.placement}`],
    variants: [
      { name: "control", weight: 50, values: { [`paywall.${w.placement}`]: v } },
      { name: "new_copy", weight: 50, values: { [`paywall.${w.placement}`]: { ...v, title: alt.title.trim(), ...(alt.subtitle ? { subtitle: alt.subtitle } : {}), ...(alt.cta ? { cta: alt.cta } : {}), ...(alt.bullets?.length ? { bullets: alt.bullets } : {}) } } },
    ],
    state: file.settings.tests === "auto" ? "proposed" : "waiting_approval",
  };
}

/** Rounds to the usual store price ending (…,99). */
export const storePrice = (x: number) => (x < 1 ? 0.99 : Math.max(0.99, Math.round(x) - 0.01));

/**
 * A price test (or trial-length test): new products for the variant, the
 * variant's paywall pointing at them. Returns the file with the products
 * added (waiting for approval unless prices are "auto").
 */
export function productTest(
  file: MoneyFile,
  w: Paywall,
  kind: "price" | "trial_length",
  o: { idBase: string; stores: { ios: boolean; android: boolean }; now: Date },
): { file: MoneyFile; test: MoneyTest; products: Product[] } | null {
  const v = paywallValue(file, w.placement);
  const highlighted = file.products.find((p) => p.productId === v?.highlight);
  if (!v || !highlighted) return null;
  if (kind === "trial_length" && highlighted.kind !== "subscription") return null;
  const testId = id();
  const variant = kind === "price" ? "higher_price" : highlighted.trialDays ? "shorter_trial" : "with_trial";
  const plan: ProductPlan = {
    ...highlighted,
    key: highlighted.key,
    ...(kind === "price"
      ? { base: { ...highlighted.base, amount: storePrice(highlighted.base.amount * 1.3) }, regional: highlighted.regional.map((r) => ({ ...r, amount: storePrice(r.amount * 1.3) })) }
      : { trialDays: highlighted.trialDays ? Math.max(3, Math.floor(highlighted.trialDays / 2)) : 7 }),
  };
  const ask = file.settings.prices === "ask";
  const r = planProducts(file, [plan], { ...o, approval: ask ? { state: "waiting", by: null, at: null } : { state: "auto", by: "day2", at: o.now.toISOString() }, test: { experimentId: testId, variant } });
  const made = r.added[0] ?? r.kept[0]!;
  const products = (v.products as Array<{ id: string }>).map((p) => (p.id === highlighted.productId ? { ...p, id: made.productId, trialDays: made.trialDays ?? 0 } : p));
  const test: MoneyTest = {
    ...base(o.now),
    id: testId,
    kind,
    title:
      kind === "price"
        ? `${highlighted.name}: ${made.base.amount} instead of ${highlighted.base.amount} ${highlighted.base.currency}`
        : `${highlighted.name}: ${made.trialDays}-day trial instead of ${highlighted.trialDays ? `${highlighted.trialDays} days` : "none"}`,
    hypothesis: kind === "price" ? "A higher price earns more per user without losing many buyers." : "A different trial length changes how many try it and how many stay.",
    keys: [`paywall.${w.placement}`],
    variants: [
      { name: "control", weight: 50, values: { [`paywall.${w.placement}`]: v } },
      { name: variant, weight: 50, values: { [`paywall.${w.placement}`]: { ...v, products, highlight: made.productId, trialDays: made.trialDays ?? 0 } } },
    ],
    state: ask ? "waiting_approval" : "proposed",
  };
  return { file: r.file, test, products: r.added };
}

/** Ads on/off or less often. Overrides `ads.<id>` (Live applies a values override of an ad placement: { enabled, cap }). */
export function adTest(file: MoneyFile, a: AdPlacement, kind: "ad_on_off" | "ad_frequency", now: Date): MoneyTest {
  const key = `ads.${a.id}`;
  const control = { enabled: true, cap: a.cap };
  const variant =
    kind === "ad_on_off"
      ? { name: "no_ad", values: { [key]: { enabled: false, cap: a.cap } } }
      : { name: "fewer", values: { [key]: { enabled: true, cap: { perSession: Math.max(1, Math.floor((a.cap.perSession ?? 2) / 2)), perDay: Math.max(1, Math.floor((a.cap.perDay ?? 4) / 2)), minSecondsBetween: (a.cap.minSecondsBetween ?? 120) * 2 } } } };
  return {
    ...base(now),
    id: id(),
    kind,
    title: kind === "ad_on_off" ? `Ad “${a.id}” on or off` : `Ad “${a.id}” half as often`,
    hypothesis: kind === "ad_on_off" ? "Does this ad earn more than it costs in users who leave?" : "Fewer ads keep more users and may earn the same.",
    keys: [key],
    variants: [{ name: "control", weight: 50, values: { [key]: control } }, { ...variant, weight: 50 }],
    state: file.settings.tests === "auto" ? "proposed" : "waiting_approval",
  };
}

/** Pure. The next test worth running when nothing runs: layout → trial → price → ad frequency → ad on/off. Null when all were tried. */
export function nextTest(file: MoneyFile, o: { idBase: string; stores: { ios: boolean; android: boolean }; now: Date }): { file: MoneyFile; test: MoneyTest } | null {
  const open = file.tests.filter((t) => t.state === "running" || t.state === "proposed" || t.state === "waiting_approval");
  if (open.length >= MAX_RUNNING_TESTS) return null;
  const tried = (kind: MoneyTest["kind"], key: string) => file.tests.some((t) => t.kind === kind && t.keys.includes(key));
  for (const w of file.paywalls.filter((x) => x.enabled)) {
    const k = `paywall.${w.placement}`;
    if (!tried("paywall_layout", k)) {
      const t = layoutTest(file, w, o.now);
      if (t) return { file, test: t };
    }
    for (const kind of ["trial_length", "price"] as const) {
      if (tried(kind, k)) continue;
      const r = productTest(file, w, kind, o);
      if (r) return { file: r.file, test: r.test };
    }
  }
  for (const a of file.ads.filter((x) => x.enabled && (x.unitId.ios || x.unitId.android))) {
    for (const kind of ["ad_frequency", "ad_on_off"] as const) if (!tried(kind, `ads.${a.id}`)) return { file, test: adTest(file, a, kind, o.now) };
  }
  return null;
}

/** Pure. Adds a test (and logs it). */
export function addTest(file: MoneyFile, t: MoneyTest, now: Date): MoneyFile {
  return addLog({ ...file, tests: [t, ...file.tests] }, t.state === "waiting_approval" ? `Proposed a test: ${t.title}. Waiting for your approval.` : `Planned a test: ${t.title}.`, now);
}

/** Products a test needs must exist in the stores before Live may start it. */
const productsReady = (file: MoneyFile, t: MoneyTest) => file.products.filter((p) => p.test?.experimentId === t.id).every((p) => (p.ios.state === "created" || p.ios.state === "skipped") && (p.android.state === "created" || p.android.state === "skipped"));

/** Starts proposed tests in Live and reads results of running ones. */
export async function syncTests(app: AppEntry, file: MoneyFile, port: LiveExperimentsPort | null, now: Date): Promise<{ file: MoneyFile; started: string[]; decided: string[] }> {
  const started: string[] = [];
  const decided: string[] = [];
  if (!port) return { file, started, decided };
  let f = file;
  const set = (id: string, patch: Partial<MoneyTest>) => {
    f = { ...f, tests: f.tests.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
  };
  for (const t of file.tests) {
    if (t.state === "proposed" && productsReady(f, t)) {
      const r = await port.start(app, { module: "money", name: t.title, hypothesis: t.hypothesis, by: t.approvedBy ? "owner" : "day2", keys: t.keys, variants: t.variants, primary: t.primary, guardrails: t.guardrails });
      set(t.id, { state: "running", liveId: r.id });
      started.push(t.id);
      f = addLog(f, `Started the test “${t.title}” (${r.id}).`, now);
    } else if (t.state === "running" && t.liveId) {
      const r = await port.result(app, t.liveId);
      if (r && r.state !== "running") {
        set(t.id, { state: r.state === "decided" ? "decided" : "stopped", result: { winner: r.winner, note: r.note, at: now.toISOString() } });
        decided.push(t.id);
        f = addLog(f, `Test “${t.title}”: ${r.note}`, now);
        // A losing price/trial variant's products are retired (existing buyers keep theirs).
        if (r.winner === "control") f = { ...f, products: f.products.map((p) => (p.test?.experimentId === t.id ? { ...p, retiredAt: now.toISOString() } : p)) };
      }
    }
  }
  return { file: f, started, decided };
}

export function decideTest(file: MoneyFile, testId: string, approve: boolean, by: string | null, now: Date): MoneyFile {
  const t = file.tests.find((x) => x.id === testId);
  if (!t || t.state !== "waiting_approval") return file;
  const products = file.products.map((p) => (p.test?.experimentId === testId && p.approval.state === "waiting" ? { ...p, approval: { state: approve ? ("approved" as const) : ("declined" as const), by, at: now.toISOString() }, ...(approve ? {} : { retiredAt: now.toISOString() }) } : p));
  return addLog({ ...file, products, tests: file.tests.map((x) => (x.id === testId ? { ...x, state: approve ? "proposed" : "stopped", ...(approve ? { approvedBy: by ?? "owner" } : {}) } : x)) }, `${by ?? "The owner"} ${approve ? "approved" : "declined"} the test “${t.title}”.`, now);
}
