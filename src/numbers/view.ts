import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { APP_LINKS_FILENAME, loadAppLinks, storeIdsFromRepo } from "../ads/app-links";
import { ADS_FILENAME, loadAds } from "../ads/autopilot";
import { fromUsd } from "../ads/fx";
import { platformInfo } from "../ads/registry";
import type { PlatformId } from "../ads/types";
import { creditsForCost } from "../credits";
import { CRASH_CONTRACT, type FieldStore } from "../field-store";
import { appKind, describeBroken } from "../field-work";
import { liveStore } from "../live/runtime";
import { metricLabel } from "../live/experiments";
import { loadReleases, RELEASES_FILENAME } from "../mobile-release/pass";
import { knownUsers, loadAppMoney, moneyLedger } from "../money/wiring";
import { loadStorePrivacy, STORE_PRIVACY_FILENAME } from "../store-privacy";
import { storeListingFor } from "../store-listing/store";
import { fieldStore, releaseCredentials } from "../tenant";
import { computeNumbers, periodDays, type NumbersInput, type NumbersView } from "./compute";
import { numbersStoreFor } from "./store";
import type { Period } from "./types";

/**
 * Gathers what the Numbers page is computed from — the store cache and
 * day2's own records for the app — and computes it (compute.ts). Each
 * source that fails to load counts as "no data" for its numbers (they show
 * as not available), never as zero.
 */

const DAY = 86_400_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch {
    return fallback;
  }
};

/** Release keys worth showing: what's in the stores, the latest update, what the last releases were compared with, the latest one reported. */
export function releaseKeys(app: AppEntry, lastRelease: string | null): Array<{ key: string; label: string }> {
  const file = loadReleases(resolve(app.repoPath, RELEASES_FILENAME));
  const out = new Map<string, string>();
  const plat = (p: string) => (p === "ios" ? "iOS" : p === "android" ? "Android" : p);
  for (const [p, k] of Object.entries(file.shipped?.storeKey ?? {})) if (k) out.set(k, `${plat(p)} store build ${k.replace(/\*$/, "")}`);
  for (const [p, k] of Object.entries(file.shipped?.updateKey ?? {})) if (k) out.set(k, `${plat(p)} update ${k.replace(/^@/, "")}`);
  if (lastRelease && !out.has(lastRelease)) out.set(lastRelease, `Release ${lastRelease}`);
  return [...out].slice(0, 8).map(([key, label]) => ({ key, label }));
}

export async function numbersInput(app: AppEntry, days: Period, now: Date, store: FieldStore = fieldStore()): Promise<NumbersInput> {
  const mobile = appKind(app.repoPath) === "react-native";
  const { curStart, prevStart } = periodDays(now, days);
  const ids = storeIdsFromRepo(app.repoPath);
  const [creds, doc, events, activity, retention, meta] = await Promise.all([
    mobile ? safe(releaseCredentials().list(app.id), []) : Promise.resolve([]),
    numbersStoreFor(app).load(app.id),
    safe(store.events(app.id, new Date(prevStart)), []),
    safe(store.activity(app.id, dayOf(prevStart - 31 * DAY)), { users: [], older: 0 }),
    safe(store.retention(app.id), null),
    safe(store.meta(app.id), null),
  ]);

  // Money (apps in the stores).
  const moneyFile = mobile ? loadAppMoney(app) : null;
  const [records, known] = mobile
    ? await Promise.all([safe(moneyLedger().records(app.id, new Date(prevStart - 60 * DAY)), []), safe(knownUsers(app, store, now, 2 * days), { users: [], events: [] })])
    : [[], { users: [], events: [] }];

  // Quality.
  const crashSince = Math.max(prevStart, now.getTime() - 30 * DAY);
  const [crashes, health, contracts] = await Promise.all([safe(store.failures(app.id, CRASH_CONTRACT, 5000), []), safe(store.health(app.id, new Date(curStart)), []), safe(store.contracts(app.id), null)]);
  const byId = new Map((contracts?.file.contracts ?? []).map((c) => [c.id, c]));
  const keys = mobile ? releaseKeys(app, meta?.lastRelease ?? null) : [];
  const rh = keys.length ? await safe(store.releaseHealth(app.id, keys.map((k) => k.key), new Date(Math.max(curStart, now.getTime() - 30 * DAY))), []) : [];
  const listing = mobile ? await safe(storeListingFor(app).load(app.id), null) : null;
  const reviews = mobile ? await safe(storeListingFor(app).reviews(app.id), []) : [];

  const live = await safe(liveStore().get(app.id), null);
  const ads = loadAds(resolve(app.repoPath, ADS_FILENAME));
  const names: Record<string, string> = {};
  for (const c of ads.campaigns) names[c.platform] ??= safeName(c.platform);
  const links = loadAppLinks(resolve(app.repoPath, APP_LINKS_FILENAME));

  return {
    now,
    days,
    kind: mobile ? "mobile" : "web",
    stores: { ios: mobile && Boolean(ids.bundleId), android: mobile && Boolean(ids.packageName) },
    connected: { asc: creds.some((c) => c.kind === "asc"), play: creds.some((c) => c.kind === "play") },
    doc: { ...doc, apple: { ...doc.apple, appId: doc.apple.appId ?? links.ios?.appStoreId ?? null } },
    events,
    users: activity.users,
    fixedDeviceId: loadStorePrivacy(resolve(app.repoPath, STORE_PRIVACY_FILENAME)).settings.deviceId,
    retention,
    money: {
      applies: mobile,
      records,
      currency: moneyFile?.settings.currency ?? "USD",
      connected: Boolean(moneyFile && Object.values(moneyFile.connections).some((c) => c?.ok)),
      users: known.users,
    },
    ads: {
      campaigns: ads.campaigns.map((c) => ({ betId: c.betId, platform: c.platform, billing: c.billing, currency: c.currency, spendUsd: c.spendUsd, launchedAt: c.launchedAt })),
      names,
      credits: (usd) => creditsForCost(usd, "paid_ads"),
      fromUsd,
    },
    quality: {
      crashes: crashes.filter((f) => Date.parse(f.at) >= crashSince).map((f) => ({ deviceId: f.deviceId, at: f.at })),
      releases: rh.map((r) => ({ release: r.release, label: keys.find((k) => k.key === r.release)?.label ?? r.release, devices: r.devices, crashed: r.crashed })),
      checks: health
        .filter((h) => h.failures > 0 && h.contract !== CRASH_CONTRACT && !h.contract.endsWith("#rejected"))
        .slice(0, 8)
        .map((h) => ({ contract: h.contract, label: describeBroken(h, byId.get(h.contract)), failures: h.failures, devices: h.devices })),
      ratings: (listing?.ratings ?? []).map((r) => ({ at: r.at, store: r.store, average: r.average, count: r.count })),
      reviews: reviews.map((r) => ({ store: r.store, rating: r.rating, createdAt: r.createdAt })),
    },
    experiments: (live?.experiments ?? []).map((e) => ({
      id: e.id,
      title: e.title,
      state: e.state,
      metric: metricLabel(e.metric),
      startedAt: e.startedAt,
      arms: e.result?.arms.map((a) => ({ name: a.name, n: a.n })) ?? [],
      decision: e.decision ? { verdict: e.decision.verdict, winner: e.decision.winner, at: e.decision.at, by: e.decision.by, note: e.decision.note } : null,
    })),
  };
}

function safeName(platform: string): string {
  try {
    return platformInfo(platform as PlatformId).name;
  } catch {
    return platform;
  }
}

/** The page, computed (cached for a minute per app and period; Refresh and setting changes clear it). */
const cache = new Map<string, { at: number; view: NumbersView }>();
const CACHE_MS = 60_000;
export const clearNumbersCache = (appId?: string) => {
  for (const k of [...cache.keys()]) if (!appId || k.startsWith(`${appId}|`)) cache.delete(k);
};

export async function numbersView(app: AppEntry, days: Period, now = new Date()): Promise<NumbersView> {
  const key = `${app.id}|${days}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.view;
  const view = computeNumbers(await numbersInput(app, days, now));
  cache.set(key, { at: now.getTime(), view });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return view;
}
