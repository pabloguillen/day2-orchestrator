/**
 * Numbers (docs/numbers.md): one page per app with its installs, users,
 * retention, engagement, money, acquisition, quality and experiments.
 *
 * Two halves:
 *  - the store cache (NumbersDoc): what App Store Connect and Google Play
 *    reported, per day, fetched by the daily pass (fetch.ts) and kept per app
 *    (file in local mode, Postgres `numbers_cache` in accounts mode). Days
 *    that weren't reported are absent, never 0;
 *  - the view (NumbersView): computed when the page asks, from that cache
 *    and day2's own data (field data, payments, ads, Live, Store).
 */

export const NUMBERS_FILENAME = "day2-numbers.json";
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

/** One day's value; `p` is Apple's processing date (a newer instance overwrites an older one). */
export type DayValue = { v: number; p?: string };
/** Day ("YYYY-MM-DD") → value. */
export type Series = Record<string, DayValue>;

export const SERIES_KEYS = [
  /** App Store first-time downloads (Analytics Reports: App Store Downloads). */
  "ios.downloads",
  /** App Store redownloads (same report). */
  "ios.redownloads",
  /** App Store units of app downloads from Sales and Trends (no redownloads, no updates). */
  "ios.salesUnits",
  /** App Store impressions, product page views (Analytics Reports: Discovery and Engagement). */
  "ios.impressions",
  "ios.pageViews",
  /** App sessions and the devices behind them, from people who share data with developers (Analytics Reports: App Sessions). */
  "ios.sessions",
  "ios.sessionDevices",
  /** Google Play installs by users (installs overview report in the developer's Cloud Storage bucket). */
  "android.installs",
  /** Google Play vitals (Play Developer Reporting API), daily, as shares (0.012 = 1.2%). */
  "android.crashRate",
  "android.anrRate",
  /** Distinct users behind the vitals that day. */
  "android.vitalsUsers",
] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];

export type FetchState = { at: string | null; ok: boolean | null; error: string | null };
const blankState = (): FetchState => ({ at: null, ok: null, error: null });

export type NumbersSettings = {
  /** App Store Connect → Payments and Financial Reports: the vendor number (Sales and Trends). */
  appleVendorNumber: string | null;
  /** Play Console → Download reports → "Copy Cloud Storage URI": pubsite_prod_… */
  playBucket: string | null;
};

export type NumbersDoc = {
  v: 1;
  settings: NumbersSettings;
  apple: {
    /** The app's Apple ID (App Store Connect), looked up by bundle id. */
    appId: string | null;
    /** The ONGOING analytics report request day2 made (or found). */
    analyticsRequestId: string | null;
    sales: FetchState;
    analytics: FetchState;
    /** Analytics report instances already read (newest kept). */
    seenInstances: string[];
  };
  google: {
    installs: FetchState;
    vitals: FetchState;
    /** Months of the installs report already read ("202611") and when (the current and last month are read again). */
    months: Record<string, string>;
  };
  series: Partial<Record<SeriesKey, Series>>;
  /** Day → campaign ("B-4:meta") → lifetime spend in USD at the end of that day, as the ad platform reported it. */
  adSpend: Record<string, Record<string, number>>;
  /** Day → launches (distinct devices with a visit) and how many crashed: kept past the 30 days crash reports live. */
  field: Record<string, { launches: number; crashed: number }>;
  /** The last store pass that ran (ok or not). */
  fetchedAt: string | null;
  /** The owner pressed Refresh (rate-limited). */
  refreshRequestedAt: string | null;
};

export const emptyNumbersDoc = (): NumbersDoc => ({
  v: 1,
  settings: { appleVendorNumber: null, playBucket: null },
  apple: { appId: null, analyticsRequestId: null, sales: blankState(), analytics: blankState(), seenInstances: [] },
  google: { installs: blankState(), vitals: blankState(), months: {} },
  series: {},
  adSpend: {},
  field: {},
  fetchedAt: null,
  refreshRequestedAt: null,
});

/** Pure. A stored document with anything missing filled in (older files keep loading). */
export function normalizeDoc(raw: unknown): NumbersDoc {
  const e = emptyNumbersDoc();
  if (!raw || typeof raw !== "object") return e;
  const p = raw as Partial<NumbersDoc>;
  const st = (x: unknown): FetchState => ({ ...blankState(), ...((x && typeof x === "object" ? x : {}) as Partial<FetchState>) });
  return {
    v: 1,
    settings: { ...e.settings, ...(p.settings ?? {}) },
    apple: {
      appId: p.apple?.appId ?? null,
      analyticsRequestId: p.apple?.analyticsRequestId ?? null,
      sales: st(p.apple?.sales),
      analytics: st(p.apple?.analytics),
      seenInstances: Array.isArray(p.apple?.seenInstances) ? p.apple!.seenInstances : [],
    },
    google: { installs: st(p.google?.installs), vitals: st(p.google?.vitals), months: p.google?.months ?? {} },
    series: p.series && typeof p.series === "object" ? p.series : {},
    adSpend: p.adSpend && typeof p.adSpend === "object" ? p.adSpend : {},
    field: p.field && typeof p.field === "object" ? p.field : {},
    fetchedAt: p.fetchedAt ?? null,
    refreshRequestedAt: p.refreshRequestedAt ?? null,
  };
}

/** Days of store data kept: the longest period and the one before it, plus room. */
export const KEEP_DAYS = 400;

/** Pure. Drops days older than KEEP_DAYS and bounds the instance list. */
export function trimDoc(d: NumbersDoc, now: Date): NumbersDoc {
  const cut = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const keep = <T>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([day]) => day >= cut));
  const series: NumbersDoc["series"] = {};
  for (const [k, s] of Object.entries(d.series)) if (s) series[k as SeriesKey] = keep(s);
  return { ...d, series, adSpend: keep(d.adSpend), field: keep(d.field), apple: { ...d.apple, seenInstances: d.apple.seenInstances.slice(-500) } };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export type SourceId = "app_store" | "google_play" | "field" | "ads" | "payments" | "store_reviews" | "live";
export const SOURCE_LABEL: Record<SourceId, string> = {
  app_store: "App Store Connect",
  google_play: "Google Play Console",
  field: "day2 field data",
  ads: "ad platforms",
  payments: "payments (Apple and Google, checked by day2)",
  store_reviews: "App Store and Google Play reviews",
  live: "day2 Live",
};

export type Unit = "count" | "percent" | "money" | "credits" | "decimal" | "stars";
export type PlatformKey = "ios" | "android" | "web" | "unknown";

/** Why a number isn't there, and what fixes it (`to`: the console page, relative to the app). */
export type Missing = { reason: string; fix: string | null; to: string | null };

export type Compare = {
  /** "too_few": samples too small to say; "none": nothing to compare with. */
  state: "up" | "down" | "same" | "too_few" | "none";
  /** Relative change for counts and money (0.12 = +12%); percentage points for percents (0.03 = +3 points). */
  change: number | null;
  /** The samples behind this period's and the previous period's value. */
  n: number | null;
  prevN: number | null;
};

export type Split = { key: string; label: string; value: number | null; prev: number | null };

export type Num = {
  key: string;
  label: string;
  value: number | null;
  unit: Unit;
  currency?: string;
  source: SourceId;
  /** Small print: how it's counted, delays, coverage. */
  note?: string;
  /** Which direction is good (for the trend's colour). */
  better: "up" | "down" | "neither";
  prev: number | null;
  compare: Compare;
  missing?: Missing;
  byPlatform?: Split[];
  bySource?: Split[];
  estimated?: boolean;
};

export type Chart = { key: string; label: string; unit: Unit; currency?: string; days: string[]; current: Array<number | null>; previous: Array<number | null>; source: SourceId };

export type Section = { key: string; title: string; numbers: Num[]; note?: string };
