import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Money: how an app earns — the owner-approved strategy, the store products
 * and prices it turned into, paywalls and ad placements (served through Live
 * config), tests of offers, and day2's settings. Kept in the app's
 * `day2-money.json` (both modes, like day2-retention.json). Verified
 * purchases themselves live in the ledger (ledger.ts), per hashed user.
 */

export const MONEY_FILENAME = "day2-money.json";

export type Platform = "ios" | "android";
export type Money = { amount: number; currency: string };

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export type EarningModel = "subscription" | "one_time" | "consumables" | "rewarded_ads" | "interstitial_ads" | "banner_ads";
export const EARNING_MODELS: EarningModel[] = ["subscription", "one_time", "consumables", "rewarded_ads", "interstitial_ads", "banner_ads"];
export const MODEL_LABEL: Record<EarningModel, string> = {
  subscription: "Subscription",
  one_time: "One-time unlock",
  consumables: "Consumables (credits, packs)",
  rewarded_ads: "Rewarded ads",
  interstitial_ads: "Full-screen ads between screens",
  banner_ads: "Banner ads",
};

export type ProductKind = "subscription" | "one_time" | "consumable";
/** ISO 8601 durations both stores understand. */
export type Period = "P1W" | "P1M" | "P2M" | "P3M" | "P6M" | "P1Y";
export const PERIODS: Period[] = ["P1W", "P1M", "P2M", "P3M", "P6M", "P1Y"];
export const PERIOD_LABEL: Record<Period, string> = { P1W: "week", P1M: "month", P2M: "2 months", P3M: "3 months", P6M: "6 months", P1Y: "year" };

/** A price in one region: ISO 3166-1 alpha-2 (DE, US…), the region's currency. */
export type RegionalPrice = { region: string; amount: number; currency: string };

export type ProductPlan = {
  /** Stable key within the app, e.g. "pro_monthly". */
  key: string;
  kind: ProductKind;
  name: string;
  description: string;
  period?: Period;
  /** Free trial length for new subscribers (subscriptions only). */
  trialDays?: number | null;
  /** The price in the base region; other regions follow the stores' equalized prices unless listed in `regional`. */
  base: RegionalPrice;
  regional: RegionalPrice[];
  /** Subscriptions in one group: higher = more features (Apple's group level is 1 = highest). */
  tier?: number;
  why: string;
};

export type PaywallPlan = {
  /** Live config key suffix: `paywall.<placement>`. */
  placement: string;
  /** When it shows, in plain words (e.g. "after the 3rd finished drawing"). */
  trigger: string;
  title: string;
  subtitle: string;
  bullets: string[];
  products: string[];
  highlight: string | null;
  cta: string;
  why: string;
};

export type AdFormat = "banner" | "interstitial" | "rewarded" | "native";
export type AdCap = { perSession?: number; perDay?: number; minSecondsBetween?: number };

export type AdPlacementPlan = {
  id: string;
  format: AdFormat;
  where: string;
  cap: AdCap;
  /** Not in a user's first session (never interstitials on day one). */
  notInFirstSession: boolean;
  why: string;
};

export type Leader = { app: string; model: string; example: string; source: string };

export type Strategy = {
  id: string;
  at: string;
  credits: number;
  status: "proposed" | "approved" | "declined" | "superseded";
  decidedBy: string | null;
  decidedAt: string | null;
  /** "not_yet": too few users (or no fit) — day2 waits instead of guessing. */
  verdict: "monetize" | "not_yet";
  summary: string;
  category: string;
  models: EarningModel[];
  products: ProductPlan[];
  paywalls: PaywallPlan[];
  ads: AdPlacementPlan[];
  /** What not to do, e.g. "No full-screen ads in the first session". */
  avoid: string[];
  leaders: Leader[];
  /** What the recommendation was based on. */
  basis: { users: number; rhythm: string | null; minors: boolean };
};

// ---------------------------------------------------------------------------
// Products in the stores
// ---------------------------------------------------------------------------

export type StoreSide = {
  state: "waiting" | "creating" | "created" | "failed" | "skipped";
  /** The store's own id (App Store Connect resource id / Play product id). */
  ref?: string | null;
  /** Apple: subscription group id. Google: base plan id. */
  group?: string | null;
  /** Google: the trial offer id. Apple: the intro offer created. */
  offer?: string | null;
  /** The store's status of the product, as last read (e.g. MISSING_METADATA, READY_TO_SUBMIT, ACTIVE). */
  status?: string | null;
  error?: string | null;
  /** Steps only the owner can do (e.g. "add it to the next app version"). */
  todo?: string[];
  at?: string;
};

export type Approval = { state: "waiting" | "approved" | "declined" | "auto"; by: string | null; at: string | null };

export type Product = ProductPlan & {
  /** The store product id, the same on both stores: `<app>.<key>.v<version>` (lowercase, dots). */
  productId: string;
  version: number;
  /** Price tests make new products (stores allow one price per product for all users of a region). */
  test?: { experimentId: string; variant: string } | null;
  approval: Approval;
  ios: StoreSide;
  android: StoreSide;
  createdAt: string;
  retiredAt?: string | null;
};

// ---------------------------------------------------------------------------
// Placements, tests, connections
// ---------------------------------------------------------------------------

export type Paywall = PaywallPlan & { enabled: boolean };
export type AdPlacement = AdPlacementPlan & { enabled: boolean; unitId: { ios?: string; android?: string } };

export type MoneyTestKind = "paywall_copy" | "paywall_layout" | "trial_length" | "price" | "ad_on_off" | "ad_frequency";
export const TEST_LABEL: Record<MoneyTestKind, string> = {
  paywall_copy: "Paywall wording",
  paywall_layout: "Paywall layout",
  trial_length: "Trial length",
  price: "Price",
  ad_on_off: "Ad on or off",
  ad_frequency: "How often ads show",
};

export type MoneyTest = {
  id: string;
  kind: MoneyTestKind;
  title: string;
  hypothesis: string;
  /** Live config keys the test overrides. */
  keys: string[];
  variants: Array<{ name: string; weight: number; values: Record<string, unknown> }>;
  primary: "revenue_per_user";
  guardrails: Array<"d7_retention" | "crash_rate">;
  state: "waiting_approval" | "proposed" | "running" | "decided" | "stopped";
  /** The Live experiment id once Live runs it. */
  liveId: string | null;
  /** Who approved it on the Money page (null: day2's own). */
  approvedBy?: string | null;
  createdAt: string;
  result?: { winner: string | null; note: string; at: string } | null;
};

export type Connection = "iap_key" | "rtdn" | "apple_notifications" | "paid_apps" | "payments_profile" | "admob";
export type ConnectionState = { ok: boolean; at: string; note: string };

export type MoneySettings = {
  /** Money is on for this app (the pass runs). */
  enabled: boolean;
  /** New products and price changes: "ask" (default) or "auto". */
  prices: "ask" | "auto";
  /** Config-only tests (paywall copy, ad frequency): "auto" (default) or "ask". */
  tests: "auto" | "ask";
  /** The currency money is shown in (the app's own). */
  currency: string;
  /** The region prices are set from (ISO alpha-2). */
  baseRegion: string;
  /** The language of store listings (e.g. "de-DE"), when app.json doesn't say. */
  locale: string;
  admob: { appId: { ios?: string; android?: string } };
  /** The app already uses RevenueCat: day2 reads its webhooks instead of verifying itself. */
  revenueCat: boolean;
  /** Confirmations the owner gave in walkthroughs. */
  confirmed: Partial<Record<Connection, { at: string; by: string | null }>>;
};

export type KpiSnapshot = {
  at: string;
  currency: string;
  days: number;
  revenue: { total: number; subscriptions: number; purchases: number; ads: number; refunds: number };
  users: number;
  payers: number;
  revenuePerUser: number | null;
  arppu: number | null;
  conversionToPaid: number | null;
  trialConversion: number | null;
  refundRate: number | null;
  activeSubscriptions: number;
  byVariant: Array<{ experiment: string; variant: string; users: number; revenuePerUser: number | null }>;
  bySource: Array<{ source: string; users: number; revenue: number; revenuePerUser: number | null }>;
};

export type MoneyFile = {
  settings: MoneySettings;
  strategies: Strategy[];
  products: Product[];
  paywalls: Paywall[];
  ads: AdPlacement[];
  tests: MoneyTest[];
  connections: Partial<Record<Connection, ConnectionState>>;
  /** Ticket keys → ticket ids day2 created for the app's code. */
  tickets: Record<string, string>;
  kpis: KpiSnapshot | null;
  /** Users when the last strategy was made (a 5× growth refreshes it). */
  log: Array<{ at: string; text: string }>;
};

export const DEFAULT_SETTINGS: MoneySettings = {
  enabled: true,
  prices: "ask",
  tests: "auto",
  currency: "EUR",
  baseRegion: "DE",
  locale: "de-DE",
  admob: { appId: {} },
  revenueCat: false,
  confirmed: {},
};

export function emptyMoney(): MoneyFile {
  return { settings: { ...DEFAULT_SETTINGS, admob: { appId: {} }, confirmed: {} }, strategies: [], products: [], paywalls: [], ads: [], tests: [], connections: {}, tickets: {}, kpis: null, log: [] };
}

export function loadMoney(path: string): MoneyFile {
  const empty = emptyMoney();
  if (!existsSync(path)) return empty;
  try {
    const p = JSON.parse(readFileSync(path, "utf-8")) as Partial<MoneyFile>;
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
      settings: { ...empty.settings, ...(p.settings ?? {}), admob: { appId: { ...(p.settings?.admob?.appId ?? {}) } }, confirmed: { ...(p.settings?.confirmed ?? {}) } },
      strategies: arr(p.strategies),
      products: arr(p.products),
      paywalls: arr(p.paywalls),
      ads: arr(p.ads),
      tests: arr(p.tests),
      connections: p.connections ?? {},
      tickets: p.tickets ?? {},
      kpis: p.kpis ?? null,
      log: arr(p.log),
    };
  } catch {
    return empty;
  }
}

const KEEP_LOG = 200;

export function saveMoney(path: string, f: MoneyFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...f, strategies: f.strategies.slice(0, 6), log: f.log.slice(0, KEEP_LOG) }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function addLog(f: MoneyFile, text: string, now: Date): MoneyFile {
  return { ...f, log: [{ at: now.toISOString(), text }, ...f.log].slice(0, KEEP_LOG) };
}

export const currentStrategy = (f: MoneyFile): Strategy | null => f.strategies.find((s) => s.status === "approved") ?? null;
export const proposedStrategy = (f: MoneyFile): Strategy | null => f.strategies.find((s) => s.status === "proposed") ?? null;
