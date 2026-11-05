import { AppleReportError, downloadsByDay, engagementByDay, parseSalesReport, REPORT_DOWNLOADS, REPORT_ENGAGEMENT, REPORT_SESSIONS, sessionsByDay, type AppleReports } from "./apple";
import { googleReason, parseInstallsCsv, type PlayReports } from "./google";
import type { NumbersStore } from "./store";
import type { FetchState, NumbersDoc, SeriesKey } from "./types";

/**
 * The store pass: reads what App Store Connect and Google Play reported
 * since the last pass into the app's Numbers cache. Runs once a day from
 * the growth autopilot's timer (run.ts) and when the owner presses
 * Refresh. Every step records whether it worked and, if not, why in plain
 * words — the page shows that next to the number instead of a 0.
 */

const DAY = 86_400_000;
/** How far back daily sales are read the first time (the longest period and the one before it). */
export const SALES_BACKFILL_DAYS = 180;
/** Sales reports for the last days can still be missing: a 404 there isn't "no sales". */
const SALES_SETTLE_DAYS = 3;
const MAX_SALES_REQUESTS = 200;
const SALES_CONCURRENCY = 4;
const MAX_INSTANCES_PER_REPORT = 40;
const INSTALL_MONTHS = 7;

export type StoreFetchDeps = {
  store: NumbersStore;
  /** null: no App Store Connect key connected (Releases). */
  apple: AppleReports | null;
  /** null: no Google Play service account connected (Releases). */
  play: PlayReports | null;
  ids: { bundleId: string | null; packageName: string | null; appStoreId: string | null };
  now: Date;
};

export type StoreFetchReport = { notes: string[] };

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const ok = (now: Date): FetchState => ({ at: now.toISOString(), ok: true, error: null });
const failed = (now: Date, error: string): FetchState => ({ at: now.toISOString(), ok: false, error });

/** Pure. Writes per-day values into a series; with `p` (Apple's processing date), only over older or equal ones. */
export function putSeries(doc: NumbersDoc, key: SeriesKey, values: Record<string, number>, p?: string): NumbersDoc {
  const s = { ...(doc.series[key] ?? {}) };
  for (const [day, v] of Object.entries(values)) {
    const have = s[day];
    if (p && have?.p && have.p > p) continue;
    s[day] = p ? { v, p } : { v };
  }
  return { ...doc, series: { ...doc.series, [key]: s } };
}

const errText = (err: unknown) => (err instanceof AppleReportError ? err.message : `App Store Connect: ${(err as Error).message}`);

async function appleSales(doc: NumbersDoc, a: AppleReports, now: Date): Promise<NumbersDoc> {
  const vendor = doc.settings.appleVendorNumber;
  if (!vendor) return doc;
  const have = doc.series["ios.salesUnits"] ?? {};
  const days: string[] = [];
  for (let i = 1; i <= SALES_BACKFILL_DAYS; i++) {
    const d = dayOf(now.getTime() - i * DAY);
    if (!have[d]) days.push(d);
  }
  const todo = days.slice(0, MAX_SALES_REQUESTS);
  const units: Record<string, number> = {};
  let error: string | null = null;
  for (let i = 0; i < todo.length && !error; i += SALES_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + SALES_CONCURRENCY).map(async (day) => {
        try {
          const text = await a.salesDay(vendor, day);
          const recent = now.getTime() - Date.parse(`${day}T00:00:00Z`) < SALES_SETTLE_DAYS * DAY;
          if (text === null && recent) return; // not published yet
          const s = text === null ? { downloads: 0, redownloads: 0, updates: 0 } : parseSalesReport(text, doc.apple.appId);
          units[day] = s.downloads;
        } catch (err) {
          error ??= errText(err);
        }
      }),
    );
  }
  const next = putSeries(doc, "ios.salesUnits", units);
  return { ...next, apple: { ...next.apple, sales: error ? failed(now, error) : ok(now) } };
}

async function appleAnalytics(doc: NumbersDoc, a: AppleReports, appleId: string, now: Date): Promise<NumbersDoc> {
  let requestId = doc.apple.analyticsRequestId;
  try {
    requestId ??= (await a.ongoingRequest(appleId)) ?? (await a.createOngoingRequest(appleId));
  } catch (err) {
    const status = err instanceof AppleReportError ? err.status : undefined;
    const msg = status === 403 ? (err as Error).message : errText(err);
    return { ...doc, apple: { ...doc.apple, analytics: failed(now, msg) } };
  }
  let next: NumbersDoc = { ...doc, apple: { ...doc.apple, analyticsRequestId: requestId } };
  const seen = new Set(next.apple.seenInstances);
  let found = 0;
  try {
    for (const name of [REPORT_DOWNLOADS, REPORT_ENGAGEMENT, REPORT_SESSIONS]) {
      const reportId = await a.report(requestId, name);
      if (!reportId) continue;
      found++;
      const fresh = (await a.instances(reportId))
        .filter((i) => !seen.has(i.id))
        .sort((x, y) => x.processingDate.localeCompare(y.processingDate))
        .slice(-MAX_INSTANCES_PER_REPORT);
      for (const inst of fresh) {
        const rows = await a.instanceRows(inst.id);
        const p = inst.processingDate;
        if (name === REPORT_DOWNLOADS) {
          const d = downloadsByDay(rows, appleId);
          next = putSeries(putSeries(next, "ios.downloads", d.downloads, p), "ios.redownloads", d.redownloads, p);
        } else if (name === REPORT_ENGAGEMENT) {
          const e = engagementByDay(rows, appleId);
          next = putSeries(putSeries(next, "ios.impressions", e.impressions, p), "ios.pageViews", e.pageViews, p);
        } else {
          const s = sessionsByDay(rows, appleId);
          next = putSeries(putSeries(next, "ios.sessions", s.sessions, p), "ios.sessionDevices", s.devices, p);
        }
        seen.add(inst.id);
      }
    }
  } catch (err) {
    return { ...next, apple: { ...next.apple, seenInstances: [...seen], analytics: failed(now, errText(err)) } };
  }
  const state = found ? ok(now) : { at: now.toISOString(), ok: true, error: "Apple is preparing the first App Analytics reports — they arrive 1–2 days after day2 asked for them." };
  return { ...next, apple: { ...next.apple, seenInstances: [...seen], analytics: state } };
}

async function playInstalls(doc: NumbersDoc, p: PlayReports, pkg: string, now: Date): Promise<NumbersDoc> {
  const bucket = doc.settings.playBucket;
  if (!bucket) return doc;
  let next = doc;
  const months: Record<string, string> = { ...doc.google.months };
  try {
    for (let i = 0; i < INSTALL_MONTHS; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const m = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      // The current and the last month keep changing; older months are read once.
      if (months[m] && i > 1) continue;
      const text = await p.installsMonth(bucket, pkg, m);
      if (text === null) continue;
      next = putSeries(next, "android.installs", parseInstallsCsv(text).byDay);
      months[m] = now.toISOString();
    }
  } catch (err) {
    return { ...next, google: { ...next.google, months, installs: failed(now, googleReason(err, "installs")) } };
  }
  return { ...next, google: { ...next.google, months, installs: ok(now) } };
}

async function playVitals(doc: NumbersDoc, p: PlayReports, pkg: string, now: Date): Promise<NumbersDoc> {
  const first = !doc.series["android.crashRate"];
  try {
    const days = first ? SALES_BACKFILL_DAYS : 30;
    const [crash, anr] = await Promise.all([p.vitals(pkg, "crashRate", days), p.vitals(pkg, "anrRate", days)]);
    let next = putSeries(doc, "android.crashRate", Object.fromEntries(Object.entries(crash).map(([d, v]) => [d, v.rate])));
    next = putSeries(next, "android.anrRate", Object.fromEntries(Object.entries(anr).map(([d, v]) => [d, v.rate])));
    next = putSeries(next, "android.vitalsUsers", Object.fromEntries(Object.entries(crash).flatMap(([d, v]) => (v.users === null ? [] : [[d, v.users]]))));
    return { ...next, google: { ...next.google, vitals: ok(now) } };
  } catch (err) {
    return { ...doc, google: { ...doc.google, vitals: failed(now, googleReason(err, "vitals")) } };
  }
}

/** Reads everything the stores have that the cache doesn't, and records how each part went. */
export async function fetchStoreNumbers(appId: string, deps: StoreFetchDeps): Promise<StoreFetchReport> {
  const { now } = deps;
  const notes: string[] = [];
  let doc = await deps.store.load(appId);

  if (deps.apple && deps.ids.bundleId) {
    let appleId = doc.apple.appId ?? deps.ids.appStoreId;
    if (!appleId) {
      try {
        appleId = await deps.apple.findAppId(deps.ids.bundleId);
        if (!appleId) doc = { ...doc, apple: { ...doc.apple, sales: failed(now, `App Store Connect has no app with the bundle id ${deps.ids.bundleId} on this key's team.`), analytics: failed(now, `App Store Connect has no app with the bundle id ${deps.ids.bundleId} on this key's team.`) } };
      } catch (err) {
        doc = { ...doc, apple: { ...doc.apple, sales: failed(now, errText(err)), analytics: failed(now, errText(err)) } };
      }
    }
    if (appleId) {
      doc = { ...doc, apple: { ...doc.apple, appId: appleId } };
      doc = await appleSales(doc, deps.apple, now);
      doc = await appleAnalytics(doc, deps.apple, appleId, now);
    }
    for (const s of [doc.apple.sales, doc.apple.analytics]) if (s.error) notes.push(s.error);
  }

  if (deps.play && deps.ids.packageName) {
    doc = await playInstalls(doc, deps.play, deps.ids.packageName, now);
    doc = await playVitals(doc, deps.play, deps.ids.packageName, now);
    for (const s of [doc.google.installs, doc.google.vitals]) if (s.error) notes.push(s.error);
  }

  const done = { ...doc, fetchedAt: now.toISOString() };
  // Written in one go; settings the owner changed meanwhile are kept.
  await deps.store.update(appId, (cur) => ({ doc: { ...done, settings: cur.settings, refreshRequestedAt: cur.refreshRequestedAt, adSpend: { ...done.adSpend, ...cur.adSpend }, field: { ...done.field, ...cur.field } }, result: null }));
  return { notes };
}

// ---------------------------------------------------------------------------
// Snapshots kept past what the sources keep
// ---------------------------------------------------------------------------

type CampaignLike = { betId: string; platform: string; spendUsd: number };

/** Pure. Today's lifetime spend per campaign, so spend per period can be told later. */
export function snapshotAdSpend(doc: NumbersDoc, campaigns: CampaignLike[], now: Date): NumbersDoc {
  if (!campaigns.length) return doc;
  const day = dayOf(now.getTime());
  return { ...doc, adSpend: { ...doc.adSpend, [day]: Object.fromEntries(campaigns.map((c) => [`${c.betId}:${c.platform}`, Math.round(c.spendUsd * 100) / 100])) } };
}

/** Pure. Launches and crashed devices per finished day (crash reports are kept 30 days; the counts stay). */
export function snapshotField(doc: NumbersDoc, perDay: Record<string, { launches: number; crashed: number }>, now: Date): NumbersDoc {
  const today = dayOf(now.getTime());
  const field = { ...doc.field };
  for (const [day, v] of Object.entries(perDay)) if (day < today && v.launches > 0) field[day] = v;
  return { ...doc, field };
}
