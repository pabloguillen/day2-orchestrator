import type { UserActivity } from "../field-store";
import { toUsd } from "../ads/fx";
import { parseTag } from "../ads/results";
import { computeActivationRate, computeCoreActionFrequency, computeSessionsPerUser } from "../metrics/activation-engagement-kpis";
import { computeRetention } from "../metrics/retention-kpis";
import { MIN_N_FOR_CONFIDENT_BREAKDOWN, type AppMetricConfig, type EventLike } from "../metrics/types";
import { computeKpis, PAYMENTS, type KpiUser } from "../money/kpis";
import type { MoneyRecord } from "../money/ledger";
import type { RetentionSnapshot } from "../retention";
import type { Chart, Compare, FetchState, Missing, Num, NumbersDoc, Period, PlatformKey, Section, Series, SourceId, Split, Unit } from "./types";

/**
 * Pure. Everything on the Numbers page, from the store cache and day2's own
 * data. Rules (docs/numbers.md):
 *  - a number day2 can't determine is `value: null` with `missing` (reason
 *    and fix) — never a made-up 0;
 *  - every comparison carries the samples behind both periods and says
 *    "too few" below MIN_COUNT (counts) or 30 (rates, money per user);
 *  - store numbers compare the same days of both periods (Apple and Google
 *    report late, so the last days are often still missing).
 */

const DAY = 86_400_000;
/** Below this many in either period, counts aren't compared. */
export const MIN_COUNT = 10;
/** Below this many in either period, rates aren't compared (the metric layer's threshold). */
export const MIN_RATE_N = MIN_N_FOR_CONFIDENT_BREAKDOWN;

export const PLATFORM_LABEL: Record<PlatformKey, string> = { ios: "iOS", android: "Android", web: "Web", unknown: "Not reported" };

/** Events day2 or the stores send; everything else the app tracks is one of its own actions. */
export const SYSTEM_EVENTS = new Set([
  "visit",
  "active",
  "exposure",
  "revenue",
  "refund",
  "purchase_verified",
  "renewal",
  "ad_click",
  "ad_impression",
  "signup",
  "activated",
  "error",
  "screen_view",
  "review_prompt",
  "push_open",
  "message_shown",
  "message_open",
]);

export type CampaignInput = { betId: string; platform: string; billing: "credits" | "own"; currency: string; spendUsd: number; launchedAt: string };
export type ReleaseInput = { release: string; label: string; devices: number; crashed: number };
export type CheckInput = { contract: string; label: string; failures: number; devices: number };
export type RatingInput = { at: string; store: "ios" | "android"; average: number | null; count: number | null };
export type ReviewInput = { store: "ios" | "android"; rating: number; createdAt: string };
export type ExperimentInput = {
  id: string;
  title: string;
  state: string;
  metric: string;
  startedAt: string | null;
  arms: Array<{ name: string; n: number }>;
  decision: { verdict: string; winner: string | null; at: string; by: string; note: string } | null;
};

export type NumbersInput = {
  now: Date;
  days: Period;
  /** "mobile": an Expo / React Native app (stores apply); "web": a web app. */
  kind: "mobile" | "web";
  stores: { ios: boolean; android: boolean };
  connected: { asc: boolean; play: boolean };
  doc: NumbersDoc;
  /** Field events since the start of the previous period. */
  events: EventLike[];
  /** Identified users active since a month before the previous period. */
  users: UserActivity[];
  /** The app keeps a fixed device id (Privacy), so a device is a person, not a launch. */
  fixedDeviceId: boolean;
  retention: RetentionSnapshot | null;
  money: { applies: boolean; records: MoneyRecord[]; currency: string; connected: boolean; users: KpiUser[] };
  ads: { campaigns: CampaignInput[]; names: Record<string, string>; credits: (usd: number) => number; fromUsd: (usd: number, currency: string) => number };
  quality: { crashes: Array<{ deviceId: string; at: string }>; releases: ReleaseInput[]; checks: CheckInput[]; ratings: RatingInput[]; reviews: ReviewInput[] };
  experiments: ExperimentInput[];
};

export type AdPlatformRow = { platform: string; name: string; spend: Num; people: Num; results: Num; costPerResult: Num };
export type StoreConnection = {
  applies: boolean;
  connected: boolean;
  /** Apple: vendor number; Google: reports bucket. */
  setting: string | null;
  states: Array<{ label: string; state: FetchState }>;
};

export type NumbersView = {
  days: Period;
  period: { from: string; to: string; prevFrom: string; prevTo: string };
  kind: "mobile" | "web";
  fetchedAt: string | null;
  refreshRequestedAt: string | null;
  headline: { newUsers: Num; activeUsers: Num; revenue: Num; crashFree: Num };
  sections: Section[];
  charts: Chart[];
  adPlatforms: AdPlatformRow[];
  lifecycle: { status: RetentionSnapshot["status"]; states: Array<{ key: string; label: string; n: number }>; leak: { key: string; label: string; lost: number; rate: number | null } | null; at: string } | null;
  releases: Array<{ release: string; label: string; devices: number; crashFree: number | null; tooFew: boolean }>;
  checks: CheckInput[];
  experiments: { running: ExperimentInput[]; decided: ExperimentInput[] };
  connections: { apple: StoreConnection; google: StoreConnection };
};

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`);

export function periodDays(now: Date, days: number): { cur: string[]; prev: string[]; curStart: number; prevStart: number } {
  const today = dayStart(dayOf(now.getTime()));
  const cur = Array.from({ length: days }, (_, i) => dayOf(today - (days - 1 - i) * DAY));
  const prev = Array.from({ length: days }, (_, i) => dayOf(today - (2 * days - 1 - i) * DAY));
  return { cur, prev, curStart: dayStart(cur[0]!), prevStart: dayStart(prev[0]!) };
}

/** Pure. How this period compares with the one before. */
export function compareValues(value: number | null, prev: number | null, n: number | null, prevN: number | null, unit: Unit, min: number): Compare {
  if (value === null || prev === null) return { state: "none", change: null, n, prevN };
  if ((n ?? 0) < min || (prevN ?? 0) < min) return { state: "too_few", change: null, n, prevN };
  const change = unit === "percent" ? value - prev : prev === 0 ? null : value / prev - 1;
  // Percents: less than 2% of the old value (at least 0.1 points) is the same; else less than 2%.
  const same = change === null ? value === prev : Math.abs(change) < (unit === "percent" ? Math.max(0.001, 0.02 * Math.abs(prev)) : 0.02);
  return { state: same ? "same" : value > prev ? "up" : "down", change, n, prevN };
}

type NumOpts = {
  key: string;
  label: string;
  unit: Unit;
  source: SourceId;
  better?: Num["better"];
  value?: number | null;
  prev?: number | null;
  /** The samples behind value and prev (default: the counts themselves). */
  n?: number | null;
  prevN?: number | null;
  min?: number;
  note?: string;
  missing?: Missing;
  currency?: string;
  byPlatform?: Split[];
  bySource?: Split[];
  estimated?: boolean;
};

export function num(o: NumOpts): Num {
  const unit = o.unit;
  if (o.missing)
    return { key: o.key, label: o.label, unit, source: o.source, better: o.better ?? "up", value: null, prev: null, compare: { state: "none", change: null, n: null, prevN: null }, missing: o.missing, ...(o.note ? { note: o.note } : {}), ...(o.currency ? { currency: o.currency } : {}) };
  const value = o.value ?? null;
  const prev = o.prev ?? null;
  const isCount = unit === "count";
  const n = o.n !== undefined ? o.n : isCount ? value : null;
  const prevN = o.prevN !== undefined ? o.prevN : isCount ? prev : null;
  const min = o.min ?? (isCount ? MIN_COUNT : MIN_RATE_N);
  return {
    key: o.key,
    label: o.label,
    unit,
    source: o.source,
    better: o.better ?? "up",
    value,
    prev,
    compare: compareValues(value, prev, n, prevN, unit, min),
    ...(o.note ? { note: o.note } : {}),
    ...(o.currency ? { currency: o.currency } : {}),
    ...(o.byPlatform?.length ? { byPlatform: o.byPlatform } : {}),
    ...(o.bySource?.length ? { bySource: o.bySource } : {}),
    ...(o.estimated ? { estimated: true } : {}),
  };
}

const missing = (reason: string, fix: string | null, to: string | null = null): Missing => ({ reason, fix, to });
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Pure. A store series over the period, on the days it has, and the same days of the period before. */
export function storeTotals(s: Series | undefined, cur: string[], prev: string[]): { value: number | null; prev: number | null; covered: number; lastDay: string | null; perDay: Array<number | null>; prevPerDay: Array<number | null> } {
  const perDay = cur.map((d) => s?.[d]?.v ?? null);
  const prevPerDay = prev.map((d) => s?.[d]?.v ?? null);
  const idx = perDay.flatMap((v, i) => (v === null ? [] : [i]));
  if (!idx.length) return { value: null, prev: null, covered: 0, lastDay: null, perDay, prevPerDay };
  const value = idx.reduce((a, i) => a + perDay[i]!, 0);
  const prevIdx = idx.filter((i) => prevPerDay[i] !== null);
  // The previous period counts only when it has (nearly) the same days.
  const p = prevIdx.length >= idx.length * 0.9 ? prevIdx.reduce((a, i) => a + prevPerDay[i]!, 0) : null;
  return { value, prev: p, covered: idx.length, lastDay: cur[idx.at(-1)!]!, perDay, prevPerDay };
}

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function lateNote(lastDay: string | null, cur: string[], who: string): string | undefined {
  if (!lastDay || lastDay === cur.at(-1)) return undefined;
  return `${who} reports arrive 1–2 days late — this counts up to ${fmtDay(lastDay)}, compared with the same days before.`;
}

// ---------------------------------------------------------------------------
// Who is who: platform and source per device and per user
// ---------------------------------------------------------------------------

type Who = {
  /** Device → the first time it was seen (in the loaded events). */
  deviceFirst: Map<string, number>;
  devicePlatform: Map<string, PlatformKey>;
  /** Device → the ad platform its first visit came from (day2's ad tag), if any. */
  deviceAd: Map<string, string>;
  userOf: Map<string, string>;
  userPlatform: Map<string, PlatformKey>;
  userAd: Map<string, string>;
};

const asPlatform = (p: string | undefined): PlatformKey => (p === "ios" || p === "android" || p === "web" ? p : "unknown");

export function whoIsWho(events: EventLike[]): Who {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const w: Who = { deviceFirst: new Map(), devicePlatform: new Map(), deviceAd: new Map(), userOf: new Map(), userPlatform: new Map(), userAd: new Map() };
  const firstVisitSeen = new Set<string>();
  for (const e of sorted) {
    const t = Date.parse(e.at);
    if (!w.deviceFirst.has(e.deviceId)) w.deviceFirst.set(e.deviceId, t);
    if (e.platform && !w.devicePlatform.has(e.deviceId)) w.devicePlatform.set(e.deviceId, asPlatform(e.platform));
    if (e.type === "visit" && !firstVisitSeen.has(e.deviceId)) {
      firstVisitSeen.add(e.deviceId);
      const tag = parseTag(e.acquisition?.campaignId);
      if (tag?.platform) w.deviceAd.set(e.deviceId, tag.platform);
    }
    if (e.userId) {
      if (!w.userOf.has(e.deviceId)) w.userOf.set(e.deviceId, e.userId);
      if (e.platform && !w.userPlatform.has(e.userId)) w.userPlatform.set(e.userId, asPlatform(e.platform));
    }
  }
  for (const [device, user] of w.userOf) {
    const ad = w.deviceAd.get(device);
    if (ad && !w.userAd.has(user)) w.userAd.set(user, ad);
    if (!w.userPlatform.has(user) && w.devicePlatform.has(device)) w.userPlatform.set(user, w.devicePlatform.get(device)!);
  }
  return w;
}

function splitBy<K extends string>(keys: K[], label: (k: K) => string, cur: Map<string, number>, prev: Map<string, number>): Split[] {
  return keys.map((k) => ({ key: k, label: label(k), value: cur.get(k) ?? 0, prev: prev.get(k) ?? 0 })).filter((s) => s.value || s.prev);
}
const countBy = <T>(items: T[], key: (t: T) => string) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return m;
};
const PLATFORM_KEYS: PlatformKey[] = ["ios", "android", "web", "unknown"];

// ---------------------------------------------------------------------------
// Ad spend per period
// ---------------------------------------------------------------------------

/** Pure. A campaign's spend between two times, from the daily snapshots (estimated from its lifetime spend where they don't reach). */
export function spendBetween(c: CampaignInput, snapshots: NumbersDoc["adSpend"], from: number, to: number, now: number): { usd: number; estimated: boolean } {
  const key = `${c.betId}:${c.platform}`;
  const launched = Date.parse(c.launchedAt);
  const days = Object.keys(snapshots)
    .filter((d) => snapshots[d]![key] !== undefined)
    .sort();
  let estimated = false;
  const at = (t: number): number => {
    if (t <= launched) return 0;
    if (t >= now) return c.spendUsd;
    const day = dayOf(t - 1);
    const before = days.filter((d) => d <= day).at(-1);
    if (before) return snapshots[before]![key]!;
    // No snapshot this far back: assume even spending since launch.
    estimated = true;
    const first = days[0];
    const until = first ? dayStart(first) + DAY : now;
    const upto = first ? snapshots[first]![key]! : c.spendUsd;
    return until > launched ? upto * Math.min(1, (t - launched) / (until - launched)) : 0;
  };
  const usd = Math.max(0, at(to) - at(from));
  return { usd: Math.round(usd * 100) / 100, estimated };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const FIX_ASC = "Connect App Store Connect on Releases";
const FIX_PLAY = "Connect Google Play on Releases";
const FIX_IDENTIFY = "day2 adds this with the identify ticket (Growth → Retention)";
const FIX_FIELD = "Install day2's field checks in the app (the launch checklist on Home)";

export function computeNumbers(i: NumbersInput): NumbersView {
  const { now, days, doc } = i;
  const nowT = now.getTime();
  const { cur, prev, curStart, prevStart } = periodDays(now, days);
  const inCur = (t: number) => t >= curStart && t <= nowT;
  const inPrev = (t: number) => t >= prevStart && t < curStart;
  const who = whoIsWho(i.events);
  const hasField = i.events.length > 0;
  const identified = i.users.length > 0;
  const mobile = i.kind === "mobile";
  const charts: Chart[] = [];
  const chart = (key: string, label: string, unit: Unit, source: SourceId, current: Array<number | null>, previous: Array<number | null>, currency?: string) =>
    charts.push({ key, label, unit, source, days: cur, current, previous, ...(currency ? { currency } : {}) });

  // ---- Installs and new users ---------------------------------------------------------------
  const installs: Num[] = [];
  let iosInstalls: ReturnType<typeof storeTotals> | null = null;
  let androidInstalls: ReturnType<typeof storeTotals> | null = null;
  if (mobile && i.stores.ios) {
    const fromAnalytics = storeTotals(doc.series["ios.downloads"], cur, prev);
    const fromSales = storeTotals(doc.series["ios.salesUnits"], cur, prev);
    const use = fromAnalytics.covered ? fromAnalytics : fromSales.covered ? fromSales : null;
    const errors = [doc.apple.analytics.error, doc.apple.sales.error].filter(Boolean) as string[];
    let miss: Missing | undefined;
    if (!i.connected.asc) miss = missing("App Store Connect isn't connected.", FIX_ASC, "releases");
    else if (!use)
      miss = errors.length
        ? missing(errors[0]!, doc.settings.appleVendorNumber ? null : "Add the vendor number under “Store reports” below — Sales and Trends work right away", null)
        : missing(doc.fetchedAt ? "Apple hasn't reported installs for this period yet." : "day2 hasn't read Apple's reports yet.", doc.fetchedAt ? null : "Press Refresh, or wait for the daily pass", null);
    if (use) iosInstalls = use;
    installs.push(
      num({
        key: "installs.ios",
        label: "App Store installs",
        unit: "count",
        source: "app_store",
        value: use?.value,
        prev: use?.prev,
        missing: miss,
        note: [use === fromAnalytics ? "First-time downloads (App Analytics)." : "App units from Sales and Trends (no redownloads or updates).", lateNote(use?.lastDay ?? null, cur, "Apple’s")].filter(Boolean).join(" "),
      }),
    );
  }
  if (mobile && i.stores.android) {
    const t = storeTotals(doc.series["android.installs"], cur, prev);
    let miss: Missing | undefined;
    if (!i.connected.play) miss = missing("Google Play isn't connected.", FIX_PLAY, "releases");
    else if (!doc.settings.playBucket) miss = missing("day2 needs the Play Console reports bucket to read installs.", "Add the Cloud Storage URI under “Store reports” below", null);
    else if (!t.covered) miss = missing(doc.google.installs.error ?? (doc.fetchedAt ? "Google hasn't written an installs report for this period yet." : "day2 hasn't read Google's reports yet."), doc.google.installs.error ? null : "Press Refresh, or wait for the daily pass", null);
    if (t.covered) androidInstalls = t;
    installs.push(num({ key: "installs.android", label: "Google Play installs", unit: "count", source: "google_play", value: t.value, prev: t.prev, missing: miss, note: ["Installs by users (Play Console installs report).", lateNote(t.lastDay, cur, "Google’s")].filter(Boolean).join(" ") }));
  }
  const storeParts = [iosInstalls, androidInstalls];
  const storesExpected = (i.stores.ios ? 1 : 0) + (i.stores.android ? 1 : 0);
  if (mobile && storesExpected > 1) {
    const have = storeParts.filter(Boolean) as Array<ReturnType<typeof storeTotals>>;
    const all = have.length === storesExpected;
    installs.unshift(
      num({
        key: "installs.total",
        label: "Store installs",
        unit: "count",
        source: i.stores.ios ? "app_store" : "google_play",
        value: all ? have.reduce((a, t) => a + t.value!, 0) : null,
        prev: all && have.every((t) => t.prev !== null) ? have.reduce((a, t) => a + t.prev!, 0) : null,
        missing: all ? undefined : missing("One of the stores hasn't reported yet (see below).", null),
        byPlatform: all ? [{ key: "ios", label: "iOS", value: iosInstalls!.value, prev: iosInstalls!.prev }, { key: "android", label: "Android", value: androidInstalls!.value, prev: androidInstalls!.prev }] : undefined,
        note: "App Store and Google Play together.",
      }),
    );
  }
  if (iosInstalls || androidInstalls) {
    const sum = (a: Array<number | null>, b: Array<number | null>) => a.map((x, k) => (x === null && b[k] === null ? null : (x ?? 0) + (b[k] ?? 0)));
    const blank = cur.map(() => null);
    chart("installs", "Store installs per day", "count", iosInstalls ? "app_store" : "google_play", sum(iosInstalls?.perDay ?? blank, androidInstalls?.perDay ?? blank), sum(iosInstalls?.prevPerDay ?? blank, androidInstalls?.prevPerDay ?? blank));
  }

  // First opens: devices seen for the first time (only meaningful with a fixed device id).
  const firstOpenDevices = (inP: (t: number) => boolean) => [...who.deviceFirst].filter(([, t]) => inP(t)).map(([d]) => d);
  const fo = firstOpenDevices(inCur);
  const foPrev = firstOpenDevices(inPrev);
  const sourceLabel = (k: string) => (k === "other" ? "Everyone else" : `${i.ads.names[k] ?? k} ads`);
  const sourceKeys = (m1: Map<string, number>, m2: Map<string, number>) => [...new Set([...m1.keys(), ...m2.keys()])].sort((a, b) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)));
  {
    const miss = !hasField ? missing("No field data from the app yet.", FIX_FIELD, "") : !i.fixedDeviceId ? missing("The app gives every launch a new anonymous id, so a first open looks like any other launch.", "Turn on a fixed device id on Privacy (after the user agrees, where the law asks for that)", "privacy") : undefined;
    const pc = countBy(fo, (d) => who.devicePlatform.get(d) ?? "unknown");
    const pp = countBy(foPrev, (d) => who.devicePlatform.get(d) ?? "unknown");
    const sc = countBy(fo, (d) => who.deviceAd.get(d) ?? "other");
    const sp = countBy(foPrev, (d) => who.deviceAd.get(d) ?? "other");
    installs.push(
      num({
        key: "firstOpens",
        label: "First opens",
        unit: "count",
        source: "field",
        value: fo.length,
        prev: foPrev.length,
        missing: miss,
        byPlatform: splitBy(PLATFORM_KEYS, (k) => PLATFORM_LABEL[k], pc, pp),
        bySource: splitBy(sourceKeys(sc, sp), sourceLabel, sc, sp),
        note: "The first launch of a device on a release with day2's field checks.",
      }),
    );
  }
  // New users: identified users seen for the first time.
  const newUsers = (ds: string[]) => {
    const set = new Set(ds);
    return i.users.filter((u) => set.has(u.firstSeen));
  };
  const nu = newUsers(cur);
  const nuPrev = newUsers(prev);
  const noIdentify = missing("The app doesn't tell day2 who its users are yet, so people can't be counted across launches.", FIX_IDENTIFY, "growth/retention");
  const noField = missing("No field data from the app yet.", FIX_FIELD, "");
  const userMiss = !hasField && !identified ? noField : identified ? undefined : noIdentify;
  {
    const pc = countBy(nu, (u) => who.userPlatform.get(u.user) ?? "unknown");
    const pp = countBy(nuPrev, (u) => who.userPlatform.get(u.user) ?? "unknown");
    const sc = countBy(nu, (u) => who.userAd.get(u.user) ?? "other");
    const sp = countBy(nuPrev, (u) => who.userAd.get(u.user) ?? "other");
    installs.push(
      num({
        key: "newUsers",
        label: "New users",
        unit: "count",
        source: "field",
        value: nu.length,
        prev: nuPrev.length,
        missing: userMiss,
        byPlatform: splitBy(PLATFORM_KEYS, (k) => PLATFORM_LABEL[k], pc, pp),
        bySource: splitBy(sourceKeys(sc, sp), sourceLabel, sc, sp),
        note: "Signed-in people day2 saw for the first time.",
      }),
    );
    if (identified) {
      const perDay = (ds: string[]) => ds.map((d) => i.users.filter((u) => u.firstSeen === d).length);
      chart("newUsers", "New users per day", "count", "field", perDay(cur), perDay(prev));
    }
  }

  // ---- Active users -------------------------------------------------------------------------
  const active: Num[] = [];
  const dayIndex = new Map<string, Set<string>>();
  for (const u of i.users) for (const d of u.days) (dayIndex.get(d) ?? dayIndex.set(d, new Set()).get(d)!).add(u.user);
  const activeIn = (ds: string[]) => {
    const s = new Set<string>();
    for (const d of ds) for (const u of dayIndex.get(d) ?? []) s.add(u);
    return s;
  };
  const lastN = (endDays: string[], n: number) => {
    const end = dayStart(endDays.at(-1)!);
    return Array.from({ length: n }, (_, k) => dayOf(end - k * DAY));
  };
  const dauAvg = (ds: string[]) => ds.reduce((a, d) => a + (dayIndex.get(d)?.size ?? 0), 0) / ds.length;
  {
    const miss = userMiss;
    const dau = dauAvg(cur);
    const dauP = dauAvg(prev);
    const wau = activeIn(lastN(cur, 7));
    const wauP = activeIn(lastN(prev, 7));
    const mau = activeIn(lastN(cur, 30));
    const mauP = activeIn(lastN(prev, 30));
    const plat = (s: Set<string>) => countBy([...s], (u) => who.userPlatform.get(u) ?? "unknown");
    active.push(num({ key: "dau", label: "Daily active users", unit: "decimal", source: "field", value: round2(dau), prev: round2(dauP), n: mau.size, prevN: mauP.size, min: MIN_COUNT, missing: miss, note: "Average per day over the period." }));
    active.push(num({ key: "wau", label: "Weekly active users", unit: "count", source: "field", value: wau.size, prev: wauP.size, missing: miss, note: "Active in the period's last 7 days." }));
    active.push(num({ key: "mau", label: "Monthly active users", unit: "count", source: "field", value: mau.size, prev: mauP.size, missing: miss, byPlatform: splitBy(PLATFORM_KEYS, (k) => PLATFORM_LABEL[k], plat(mau), plat(mauP)), note: "Active in the period's last 30 days." }));
    active.push(num({ key: "stickiness", label: "Stickiness (DAU/MAU)", unit: "percent", source: "field", value: ratio(dau, mau.size), prev: ratio(dauP, mauP.size), n: mau.size, prevN: mauP.size, missing: miss, note: "How many of the month's users come on a given day." }));
    if (identified) chart("dau", "Active users per day", "count", "field", cur.map((d) => dayIndex.get(d)?.size ?? 0), prev.map((d) => dayIndex.get(d)?.size ?? 0));
  }
  if (mobile && i.stores.ios) {
    const s = storeTotals(doc.series["ios.sessions"], cur, prev);
    const dv = storeTotals(doc.series["ios.sessionDevices"], cur, prev);
    active.push(
      num({
        key: "ios.sessions",
        label: "App Store sessions (iOS)",
        unit: "count",
        source: "app_store",
        value: s.value,
        prev: s.prev,
        missing: !i.connected.asc ? missing("App Store Connect isn't connected.", FIX_ASC, "releases") : !s.covered ? missing(doc.apple.analytics.error ?? "Apple's App Sessions report hasn't arrived yet.", null) : undefined,
        note: [`From people who share data with developers${dv.value ? `, about ${Math.round(dv.value / Math.max(1, s.covered))} devices a day` : ""}.`, lateNote(s.lastDay, cur, "Apple’s")].filter(Boolean).join(" "),
      }),
    );
  }

  // ---- Activation and retention -------------------------------------------------------------
  const retentionNums: Num[] = [];
  // Units: the signed-in user where known; the device when it's fixed.
  const unitOf = (e: EventLike) => e.userId ?? who.userOf.get(e.deviceId) ?? (i.fixedDeviceId ? `device:${e.deviceId}` : null);
  const rekeyed = i.events.flatMap((e) => {
    const u = unitOf(e);
    return u ? [{ ...e, deviceId: u }] : [];
  });
  const config: AppMetricConfig = { coreActions: [], activation: { event: "activated", count: 1, withinHours: 7 * 24 }, activeUser: { event: "active", minCount: 1 }, retentionWindowsDays: [1, 7, 30], paidEvent: "purchase_verified", currency: i.money.currency };
  {
    const reports = i.events.some((e) => e.type === "activated");
    const unitFirst = new Map<string, number>();
    for (const e of rekeyed) {
      const t = Date.parse(e.at);
      if (!unitFirst.has(e.deviceId) || t < unitFirst.get(e.deviceId)!) unitFirst.set(e.deviceId, t);
    }
    const rate = (inP: (t: number) => boolean) => {
      const cohort = new Set([...unitFirst].filter(([, t]) => inP(t)).map(([u]) => u));
      return computeActivationRate(
        rekeyed.filter((e) => cohort.has(e.deviceId)),
        config,
        "app",
      )[0] ?? { value: null, n: 0 };
    };
    const a = rate(inCur);
    const ap = rate(inPrev);
    retentionNums.push(
      num({
        key: "activation",
        label: "Activation rate",
        unit: "percent",
        source: "field",
        value: a.value,
        prev: ap.value,
        n: a.n,
        prevN: ap.n,
        missing: !hasField ? missing("No field data from the app yet.", FIX_FIELD, "") : !rekeyed.length ? noIdentify : !reports ? missing("The app doesn't report when someone first gets value from it (the “activated” event).", "day2 adds it with the field checks; see Growth → Built in", "growth/built-in") : undefined,
        note: "New people who reached the app's first real value within 7 days.",
      }),
    );
  }
  for (const n of [1, 7, 30]) {
    const cohortRate = (ds: string[]) => {
      const from = dayOf(dayStart(ds[0]!) - n * DAY);
      const to = dayOf(dayStart(ds.at(-1)!) - n * DAY);
      const cohort = i.users.filter((u) => u.firstSeen >= from && u.firstSeen <= to);
      const evs: EventLike[] = cohort.flatMap((u) => [u.firstSeen, ...u.days.filter((d) => d !== u.firstSeen)].map((d) => ({ type: "active", at: `${d}T12:00:00.000Z`, deviceId: u.user })));
      const asOf = new Date(Math.min(nowT, dayStart(ds.at(-1)!) + DAY - 1)).toISOString();
      return computeRetention(evs, { ...config, retentionWindowsDays: [n] }, asOf, "app")[n]?.[0] ?? { value: null, n: 0 };
    };
    const r = cohortRate(cur);
    const rp = cohortRate(prev);
    retentionNums.push(
      num({ key: `d${n}`, label: `Day ${n} retention`, unit: "percent", source: "field", value: r.value, prev: rp.value, n: r.n, prevN: rp.n, missing: userMiss, note: `People who started ${n} day${n === 1 ? "" : "s"} before a day in this period and came back that day.` }),
    );
  }
  const snap = i.retention;
  const lifecycle: NumbersView["lifecycle"] = snap
    ? {
        status: snap.status,
        at: snap.at,
        states: (Object.entries(snap.states) as Array<[string, number]>).map(([key, n]) => ({ key, label: LIFECYCLE_LABEL[key] ?? key, n })),
        leak: snap.leak ? { key: snap.leak, label: LEAK_LABEL[snap.leak] ?? snap.leak, lost: snap.lost[snap.leak], rate: snap.rates[snap.leak] } : null,
      }
    : null;

  // ---- Engagement ---------------------------------------------------------------------------
  const engagement: Num[] = [];
  {
    const inWin = (inP: (t: number) => boolean) => rekeyed.filter((e) => inP(Date.parse(e.at)));
    const cw = inWin(inCur);
    const pw = inWin(inPrev);
    const spu = (evs: EventLike[]) => computeSessionsPerUser(evs.map((e) => (e.type === "visit" ? { ...e, type: "session_start" } : e)), "app")[0] ?? { value: null, n: 0 };
    const s = spu(cw);
    const sp = spu(pw);
    engagement.push(
      num({
        key: "sessionsPerUser",
        label: "Sessions per user",
        unit: "decimal",
        source: "field",
        value: s.value === null ? null : round2(s.value),
        prev: sp.value === null ? null : round2(sp.value),
        n: s.n,
        prevN: sp.n,
        missing: !hasField ? missing("No field data from the app yet.", FIX_FIELD, "") : !rekeyed.length ? missing("The app neither identifies its users nor keeps a fixed device id, so day2 can't tell who opened it again.", FIX_IDENTIFY, "growth/retention") : undefined,
        note: "App opens per person who opened it in the period.",
      }),
    );
    const counts = countBy(
      cw.filter((e) => !SYSTEM_EVENTS.has(e.type)),
      (e) => e.type,
    );
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const actives = new Set(cw.map((e) => e.deviceId)).size;
    const activesP = new Set(pw.map((e) => e.deviceId)).size;
    for (const [type, n] of top) {
      const pn = pw.filter((e) => e.type === type).length;
      const freq = computeCoreActionFrequency(cw, { ...config, coreActions: [type] }, "app")[0];
      engagement.push(
        num({
          key: `action.${type}`,
          label: `“${type.replace(/_/g, " ")}” per active user`,
          unit: "decimal",
          source: "field",
          value: actives ? round2(n / actives) : null,
          prev: activesP ? round2(pn / activesP) : null,
          n: actives,
          prevN: activesP,
          note: freq?.value ? `${freq.n} people did it, ${round2(freq.value)} times each.` : undefined,
        }),
      );
    }
    if (!top.length)
      engagement.push(num({ key: "actions", label: "Core actions", unit: "count", source: "field", missing: missing(hasField ? "The app doesn't report any of its own actions yet." : "No field data from the app yet.", hasField ? "day2 adds day2.track() calls for the main actions with the field checks" : FIX_FIELD, hasField ? "growth/built-in" : "") }));
  }

  // ---- Money --------------------------------------------------------------------------------
  const money: Num[] = [];
  const cur$ = i.money.currency;
  const moneyMissing = !mobile || !i.money.applies ? missing("Money is for apps in the App Store and Google Play.", null) : !i.money.connected && !i.money.records.length ? missing("day2 hasn't seen a payment or ad earning yet, and no payments are connected.", "Set up how the app earns on Money", "money") : undefined;
  const k = computeKpis({ records: i.money.records, users: i.money.users, currency: cur$, days, now });
  const kp = computeKpis({ records: i.money.records, users: i.money.users, currency: cur$, days, now: new Date(curStart - 1) });
  const trials = (from: number, to: number) => i.money.records.filter((r) => r.type === "trial_started" && !r.sandbox && Date.parse(r.at) >= from && Date.parse(r.at) <= to - 3 * DAY).length;
  {
    const byStore = (from: number, to: number) => {
      const m = new Map<string, number>();
      for (const r of i.money.records) {
        const t = Date.parse(r.at);
        if (r.sandbox || t < from || t > to || !(PAYMENTS.has(r.type) || r.type === "ad_revenue")) continue;
        const p = r.store === "apple" ? "ios" : r.store === "google" ? "android" : "unknown";
        m.set(p, (m.get(p) ?? 0) + i.ads.fromUsd(toUsdLike(r), cur$));
      }
      return new Map([...m].map(([a, b]) => [a, round2(b)]));
    };
    const plat = splitBy(PLATFORM_KEYS, (x) => (x === "unknown" ? "Ads and other" : PLATFORM_LABEL[x]), byStore(curStart, nowT), byStore(prevStart, curStart - 1));
    const prevSource = new Map(kp.bySource.map((s) => [s.source, s.revenue]));
    const srcSplit: Split[] = k.bySource.map((s) => ({ key: s.source, label: s.source === "other" ? "Everyone else" : (i.ads.names[s.source] ?? s.source), value: s.revenue, prev: prevSource.get(s.source) ?? 0 }));
    const m = (o: Omit<NumOpts, "source" | "currency">) => num({ ...o, source: "payments", currency: cur$, missing: moneyMissing ?? o.missing });
    money.push(m({ key: "revenue", label: "Revenue", unit: "money", value: k.revenue.total, prev: kp.revenue.total, n: k.users, prevN: kp.users, min: MIN_RATE_N, byPlatform: plat, bySource: srcSplit.length > 1 ? srcSplit : undefined, note: "What users paid, tax included, before the stores' fees. Test purchases never count." }));
    money.push(m({ key: "revenue.subscriptions", label: "Subscriptions", unit: "money", value: k.revenue.subscriptions, prev: kp.revenue.subscriptions, n: k.payers, prevN: kp.payers, min: MIN_COUNT }));
    money.push(m({ key: "revenue.purchases", label: "Purchases", unit: "money", value: k.revenue.purchases, prev: kp.revenue.purchases, n: k.payers, prevN: kp.payers, min: MIN_COUNT }));
    money.push(m({ key: "revenue.ads", label: "Ad earnings", unit: "money", value: k.revenue.ads, prev: kp.revenue.ads, n: k.users, prevN: kp.users, min: MIN_RATE_N, note: "What the app's ads earned, as the app reports it." }));
    money.push(m({ key: "arpu", label: "Revenue per user (ARPU)", unit: "money", value: k.revenuePerUser, prev: kp.revenuePerUser, n: k.users, prevN: kp.users, note: "After refunds." }));
    money.push(m({ key: "arppu", label: "Revenue per paying user (ARPPU)", unit: "money", value: k.arppu, prev: kp.arppu, n: k.payers, prevN: kp.payers }));
    money.push(m({ key: "payers", label: "Paying users", unit: "count", value: k.payers, prev: kp.payers, note: k.conversionToPaid === null ? undefined : `${Math.round(k.conversionToPaid * 1000) / 10}% of users.` }));
    money.push(m({ key: "trialConversion", label: "Trials that became paid", unit: "percent", value: k.trialConversion, prev: kp.trialConversion, n: trials(curStart, nowT), prevN: trials(prevStart, curStart - 1), note: "Trials that started at least 3 days ago." }));
    money.push(m({ key: "refunds", label: "Refunds", unit: "money", better: "down", value: k.revenue.refunds, prev: kp.revenue.refunds, n: k.payers, prevN: kp.payers, min: MIN_COUNT, note: k.refundRate === null ? undefined : `${Math.round(k.refundRate * 1000) / 10}% of payments.` }));
    if (!moneyMissing) {
      const perDay = (ds: string[]) =>
        ds.map((d) =>
          round2(
            i.money.records
              .filter((r) => !r.sandbox && r.at.slice(0, 10) === d && (PAYMENTS.has(r.type) || r.type === "ad_revenue"))
              .reduce((a, r) => a + i.ads.fromUsd(toUsdLike(r), cur$), 0),
          ),
        );
      chart("revenue", "Revenue per day", "money", "payments", perDay(cur), perDay(prev), cur$);
    }
  }

  // ---- Acquisition --------------------------------------------------------------------------
  const acquisition: Num[] = [];
  const adPlatforms: AdPlatformRow[] = [];
  {
    const outcome = i.events.some((e) => e.type === "signup") ? "signup" : "activated";
    const resultLabel = outcome === "signup" ? "Sign-ups" : "People who got value";
    const reached = new Map<string, Set<string>>();
    for (const e of i.events) if (e.type === outcome) (reached.get(e.deviceId) ?? reached.set(e.deviceId, new Set()).get(e.deviceId)!).add(e.at);
    const platforms = [...new Set(i.ads.campaigns.map((c) => c.platform))].sort();
    const noAds = missing("day2 hasn't run ads for this app.", "Ads start from Growth → Ads once the app has an ad budget", "growth/ads");
    let totalCredits = 0;
    let totalCreditsPrev = 0;
    let anyOwn = false;
    let anyEstimated = false;
    let people = 0;
    let peoplePrev = 0;
    let results = 0;
    let resultsPrev = 0;
    for (const p of platforms) {
      const cs = i.ads.campaigns.filter((c) => c.platform === p);
      const own = cs.some((c) => c.billing === "own");
      anyOwn ||= own;
      const currency = own ? cs.find((c) => c.billing === "own")!.currency : undefined;
      const spent = (from: number, to: number) => {
        let usd = 0;
        let est = false;
        for (const c of cs) {
          const s = spendBetween(c, doc.adSpend, from, to, nowT);
          usd += s.usd;
          est ||= s.estimated;
        }
        return { usd, est };
      };
      const sc = spent(curStart, nowT);
      const sp = spent(prevStart, curStart);
      anyEstimated ||= sc.est || sp.est;
      const show = (usd: number) => (own ? i.ads.fromUsd(usd, currency!) : i.ads.credits(usd));
      if (!own) {
        totalCredits += i.ads.credits(sc.usd);
        totalCreditsPrev += i.ads.credits(sp.usd);
      }
      const devs = (inP: (t: number) => boolean) => [...who.deviceAd].filter(([d, ad]) => ad === p && inP(who.deviceFirst.get(d) ?? 0)).map(([d]) => d);
      const pc = devs(inCur);
      const pp = devs(inPrev);
      const rc = pc.filter((d) => reached.has(d)).length;
      const rp = pp.filter((d) => reached.has(d)).length;
      people += pc.length;
      peoplePrev += pp.length;
      results += rc;
      resultsPrev += rp;
      const unit: Unit = own ? "money" : "credits";
      const name = i.ads.names[p] ?? p;
      adPlatforms.push({
        platform: p,
        name,
        spend: num({ key: `ads.${p}.spend`, label: `Spent on ${name}`, unit, currency, source: "ads", better: "neither", value: show(sc.usd), prev: show(sp.usd), n: pc.length, prevN: pp.length, min: MIN_COUNT, estimated: sc.est || sp.est }),
        people: num({ key: `ads.${p}.people`, label: "People who came", unit: "count", source: "field", value: pc.length, prev: pp.length }),
        results: num({ key: `ads.${p}.results`, label: resultLabel, unit: "count", source: "field", value: rc, prev: rp }),
        costPerResult: num({ key: `ads.${p}.cost`, label: `Cost per ${outcome === "signup" ? "sign-up" : "person who got value"}`, unit, currency, source: "ads", better: "down", value: rc ? round2(show(sc.usd) / rc) : null, prev: rp ? round2(show(sp.usd) / rp) : null, n: rc, prevN: rp, min: MIN_COUNT }),
      });
    }
    const none = !platforms.length ? noAds : undefined;
    acquisition.push(
      num({
        key: "ads.spend",
        label: "Ad spend",
        unit: "credits",
        source: "ads",
        better: "neither",
        value: totalCredits,
        prev: totalCreditsPrev,
        n: people,
        prevN: peoplePrev,
        estimated: anyEstimated,
        missing: none ?? (anyOwn && !totalCredits ? missing("These ads run on your own ad accounts — see each platform below.", null) : undefined),
        note: [anyOwn ? "Ads on your own ad accounts are shown per platform, in their currency." : null, anyEstimated ? "Partly estimated: day2 keeps spend per day from when Numbers started, and spreads older spend evenly." : null].filter(Boolean).join(" ") || undefined,
      }),
    );
    acquisition.push(num({ key: "ads.people", label: "People from ads", unit: "count", source: "field", value: people, prev: peoplePrev, missing: none, note: "First visits through a day2 ad link." }));
    acquisition.push(num({ key: "ads.results", label: `${resultLabel} from ads`, unit: "count", source: "field", value: results, prev: resultsPrev, missing: none }));
    acquisition.push(num({ key: "ads.cost", label: `Cost per ${outcome === "signup" ? "sign-up" : "result"}`, unit: "credits", source: "ads", better: "down", value: results && !anyOwn ? Math.round(totalCredits / results) : null, prev: resultsPrev && !anyOwn ? Math.round(totalCreditsPrev / resultsPrev) : null, n: results, prevN: resultsPrev, min: MIN_COUNT, missing: none ?? (anyOwn ? missing("Spend is in different currencies — see each platform below.", null) : !results ? missing("No results from ads in this period yet.", null) : undefined) }));
    if (mobile && i.stores.ios) {
      const imp = storeTotals(doc.series["ios.impressions"], cur, prev);
      const pv = storeTotals(doc.series["ios.pageViews"], cur, prev);
      const dl = storeTotals(doc.series["ios.downloads"], cur, prev);
      const miss = !i.connected.asc ? missing("App Store Connect isn't connected.", FIX_ASC, "releases") : !imp.covered && !pv.covered ? missing(doc.apple.analytics.error ?? "Apple's App Analytics reports haven't arrived yet (1–2 days after day2 asks for them).", null) : undefined;
      acquisition.push(num({ key: "store.impressions", label: "App Store impressions", unit: "count", source: "app_store", value: imp.value, prev: imp.prev, missing: miss, note: ["Times the app's icon was seen in the App Store.", lateNote(imp.lastDay, cur, "Apple’s")].filter(Boolean).join(" ") }));
      acquisition.push(num({ key: "store.pageViews", label: "Product page views", unit: "count", source: "app_store", value: pv.value, prev: pv.prev, missing: miss }));
      acquisition.push(
        num({
          key: "store.conversion",
          label: "Product page conversion",
          unit: "percent",
          source: "app_store",
          value: pv.value && dl.value !== null ? dl.value / pv.value : null,
          prev: pv.prev && dl.prev !== null ? dl.prev / pv.prev : null,
          n: pv.value,
          prevN: pv.prev,
          missing: miss ?? (!dl.covered ? missing("Apple's downloads report hasn't arrived yet.", null) : undefined),
          note: "First-time downloads per product page view.",
        }),
      );
    }
  }

  // ---- Quality ------------------------------------------------------------------------------
  const quality: Num[] = [];
  const crashCut = nowT - 30 * DAY;
  const perDay = crashPerDay(i.events, i.quality.crashes);
  // Live counts while crash reports are kept (30 days); the kept daily counts before that.
  const crashDay = (d: string) => (dayStart(d) + DAY > crashCut ? (perDay[d] ?? doc.field[d]) : (doc.field[d] ?? perDay[d])) ?? null;
  {
    const sum = (ds: string[]) => {
      let launches = 0;
      let crashed = 0;
      for (const d of ds) {
        const v = crashDay(d);
        if (v) {
          launches += v.launches;
          crashed += v.crashed;
        }
      }
      return { launches, crashed, rate: launches ? 1 - crashed / launches : null };
    };
    const c = sum(cur);
    const cp = sum(prev);
    const label = i.fixedDeviceId ? "Crash-free users" : "Crash-free sessions";
    const plat = crashFreeByPlatform(i.events, i.quality.crashes, Math.max(curStart, crashCut), nowT);
    quality.push(
      num({
        key: "crashFree",
        label,
        unit: "percent",
        source: "field",
        value: c.rate,
        prev: cp.rate,
        n: c.launches,
        prevN: cp.launches,
        missing: !hasField ? missing("No field data from the app yet.", FIX_FIELD, "") : !c.launches ? missing("No launches reported in this period.", null) : undefined,
        byPlatform: plat,
        note: i.fixedDeviceId ? "Users without a crash, counted per day." : "Launches without a crash.",
      }),
    );
    chart(
      "crashFree",
      `${label} per day`,
      "percent",
      "field",
      cur.map((d) => {
        const v = crashDay(d);
        return v?.launches ? 1 - v.crashed / v.launches : null;
      }),
      prev.map((d) => {
        const v = crashDay(d);
        return v?.launches ? 1 - v.crashed / v.launches : null;
      }),
    );
  }
  quality.push(num({ key: "checks", label: "Failing checks", unit: "count", source: "field", better: "down", value: i.quality.checks.length, missing: !hasField ? missing("No field data from the app yet.", FIX_FIELD, "") : undefined, note: "Checks of the app's main actions that broke on users' devices in this period (Field checks)." }));
  if (mobile && i.stores.android) {
    for (const [key, label] of [
      ["android.crashRate", "Play crash rate"],
      ["android.anrRate", "Play ANR rate (app not responding)"],
    ] as const) {
      const s = doc.series[key];
      const users = doc.series["android.vitalsUsers"];
      const avg = (ds: string[]) => {
        let w = 0;
        let x = 0;
        let n = 0;
        for (const d of ds) {
          const v = s?.[d]?.v;
          if (v === undefined) continue;
          const u = users?.[d]?.v ?? 1;
          w += u;
          x += v * u;
          n += users?.[d]?.v ?? 0;
        }
        return { value: w ? x / w : null, n };
      };
      const a = avg(cur);
      const ap = avg(prev);
      quality.push(
        num({
          key,
          label,
          unit: "percent",
          source: "google_play",
          better: "down",
          value: a.value,
          prev: ap.value,
          n: a.n,
          prevN: ap.n,
          missing: !i.connected.play ? missing("Google Play isn't connected.", FIX_PLAY, "releases") : a.value === null ? missing(doc.google.vitals.error ?? "Google Play hasn't reported vitals for this period.", null) : undefined,
          note: "Share of daily users who had one, from Android vitals (Google's bad-behaviour threshold is 1.09% for crashes, 0.47% for ANRs).",
        }),
      );
    }
  }
  if (mobile) {
    for (const store of ["ios", "android"] as const) {
      if (!i.stores[store]) continue;
      const list = i.quality.ratings.filter((r) => r.store === store && r.average !== null).sort((a, b) => a.at.localeCompare(b.at));
      const last = list.at(-1);
      const before = list.filter((r) => Date.parse(r.at) < curStart).at(-1);
      const name = store === "ios" ? "App Store" : "Google Play";
      quality.push(
        num({
          key: `rating.${store}`,
          label: `${name} rating`,
          unit: "stars",
          source: "store_reviews",
          value: last?.average ?? null,
          prev: before?.average ?? null,
          n: last?.count ?? null,
          prevN: before?.count ?? null,
          min: MIN_COUNT,
          missing: last ? undefined : missing(`day2 hasn't read the ${name} rating yet.`, "The Store page reads it with its daily pass", "store"),
          note: last?.count ? `${last.count} ratings in all.` : undefined,
        }),
      );
    }
    const rv = (from: number, to: number) => i.quality.reviews.filter((r) => Date.parse(r.createdAt) >= from && Date.parse(r.createdAt) <= to);
    const rc = rv(curStart, nowT);
    const rpv = rv(prevStart, curStart - 1);
    const avgOf = (rs: ReviewInput[]) => (rs.length ? round2(rs.reduce((a, r) => a + r.rating, 0) / rs.length) : null);
    const anyStore = i.connected.asc || i.connected.play;
    quality.push(num({ key: "reviews", label: "New reviews", unit: "count", source: "store_reviews", better: "neither", value: rc.length, prev: rpv.length, missing: anyStore ? undefined : missing("No store account is connected.", FIX_ASC, "releases"), note: rc.length ? `Average ${avgOf(rc)} stars${rpv.length ? `, ${avgOf(rpv)} the period before` : ""}.` : undefined }));
  }
  const releases = i.quality.releases.map((r) => ({ release: r.release, label: r.label, devices: r.devices, crashFree: r.devices ? 1 - r.crashed / r.devices : null, tooFew: r.devices < MIN_RATE_N }));

  // ---- Experiments --------------------------------------------------------------------------
  const running = i.experiments.filter((e) => ["building", "waiting", "running"].includes(e.state));
  const decided = i.experiments.filter((e) => e.decision && Date.parse(e.decision.at) >= curStart).sort((a, b) => b.decision!.at.localeCompare(a.decision!.at));
  const decidedPrev = i.experiments.filter((e) => e.decision && inPrev(Date.parse(e.decision.at))).length;
  const experimentsNums = [
    num({ key: "experiments.running", label: "Experiments running", unit: "count", source: "live", better: "neither", value: running.length }),
    num({ key: "experiments.decided", label: "Experiments decided", unit: "count", source: "live", better: "neither", value: decided.length, prev: decidedPrev }),
  ];

  const sections: Section[] = [
    { key: "installs", title: "Installs and new users", numbers: installs, ...(mobile ? {} : { note: "This app runs on the web, so there are no store installs: new people show as first opens and new users." }) },
    { key: "active", title: "Active users", numbers: active },
    { key: "retention", title: "Activation and retention", numbers: retentionNums },
    { key: "engagement", title: "Engagement", numbers: engagement },
    { key: "money", title: "Money", numbers: money },
    { key: "acquisition", title: "Acquisition", numbers: acquisition, ...(mobile && i.stores.android ? { note: "Google Play doesn't offer its store listing visits for download, so the store funnel is App Store only." } : {}) },
    { key: "quality", title: "Quality", numbers: quality },
    { key: "experiments", title: "Experiments", numbers: experimentsNums },
  ];

  const find = (key: string) => sections.flatMap((s) => s.numbers).find((x) => x.key === key)!;
  const firstAvailable = (...keys: string[]) => keys.map((x) => sections.flatMap((s) => s.numbers).find((n) => n.key === x)).find((n) => n && !n.missing) ?? find(keys[0]!);

  return {
    days,
    period: { from: cur[0]!, to: cur.at(-1)!, prevFrom: prev[0]!, prevTo: prev.at(-1)! },
    kind: i.kind,
    fetchedAt: doc.fetchedAt,
    refreshRequestedAt: doc.refreshRequestedAt,
    headline: { newUsers: firstAvailable("newUsers", "firstOpens", "installs.total", "installs.ios", "installs.android"), activeUsers: find("mau"), revenue: find("revenue"), crashFree: find("crashFree") },
    sections,
    charts,
    adPlatforms,
    lifecycle,
    releases,
    checks: i.quality.checks,
    experiments: { running, decided },
    connections: {
      apple: { applies: mobile && i.stores.ios, connected: i.connected.asc, setting: doc.settings.appleVendorNumber, states: [{ label: "Sales and Trends", state: doc.apple.sales }, { label: "App Analytics", state: doc.apple.analytics }] },
      google: { applies: mobile && i.stores.android, connected: i.connected.play, setting: doc.settings.playBucket, states: [{ label: "Installs report", state: doc.google.installs }, { label: "Android vitals", state: doc.google.vitals }] },
    },
  };
}

/** A record's amount in USD (converted back to the app's currency like money/kpis does). */
const toUsdLike = (r: MoneyRecord) => toUsd(r.amount, r.currency);

const LIFECYCLE_LABEL: Record<string, string> = { new: "New", current: "Current", reactivated: "Back after a break", resurrected: "Back after a long time", at_risk: "At risk", lapsing: "Lapsing", dormant: "Dormant" };
const LEAK_LABEL: Record<string, string> = { new: "New users", current: "Current users", back: "Users who came back", at_risk: "At-risk users", lapsing: "Lapsing users" };

/** Pure. Per day: launches (distinct devices with a visit) and how many of them crashed. */
export function crashPerDay(events: EventLike[], crashes: Array<{ deviceId: string; at: string }>): Record<string, { launches: number; crashed: number }> {
  const launches = new Map<string, Set<string>>();
  for (const e of events) if (e.type === "visit") (launches.get(e.at.slice(0, 10)) ?? launches.set(e.at.slice(0, 10), new Set()).get(e.at.slice(0, 10))!).add(e.deviceId);
  const crashed = new Map<string, Set<string>>();
  for (const c of crashes) (crashed.get(c.at.slice(0, 10)) ?? crashed.set(c.at.slice(0, 10), new Set()).get(c.at.slice(0, 10))!).add(c.deviceId);
  const out: Record<string, { launches: number; crashed: number }> = {};
  for (const [d, s] of launches) {
    const c = crashed.get(d);
    // A crash from a device that didn't report its launch still counts as a launch.
    const all = new Set([...s, ...(c ?? [])]);
    out[d] = { launches: all.size, crashed: c?.size ?? 0 };
  }
  return out;
}

function crashFreeByPlatform(events: EventLike[], crashes: Array<{ deviceId: string; at: string }>, from: number, to: number): Split[] {
  const plat = new Map<string, PlatformKey>();
  const launched = new Map<PlatformKey, Set<string>>();
  for (const e of events) {
    if (e.platform) plat.set(e.deviceId, asPlatform(e.platform));
    const t = Date.parse(e.at);
    if (e.type !== "visit" || t < from || t > to) continue;
    const p = asPlatform(e.platform);
    (launched.get(p) ?? launched.set(p, new Set()).get(p)!).add(`${e.deviceId}|${e.at.slice(0, 10)}`);
  }
  const crashed = new Map<PlatformKey, Set<string>>();
  for (const c of crashes) {
    const t = Date.parse(c.at);
    if (t < from || t > to) continue;
    const p = plat.get(c.deviceId) ?? "unknown";
    (crashed.get(p) ?? crashed.set(p, new Set()).get(p)!).add(`${c.deviceId}|${c.at.slice(0, 10)}`);
  }
  return PLATFORM_KEYS.filter((p) => launched.get(p)?.size).map((p) => ({ key: p, label: PLATFORM_LABEL[p], value: 1 - (crashed.get(p)?.size ?? 0) / launched.get(p)!.size, prev: null }));
}
