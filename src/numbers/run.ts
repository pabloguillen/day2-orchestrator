import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { APP_LINKS_FILENAME, loadAppLinks, storeIdsFromRepo } from "../ads/app-links";
import { ADS_FILENAME, loadAds } from "../ads/autopilot";
import { CRASH_CONTRACT } from "../field-store";
import { appKind } from "../field-work";
import { fieldStore, releaseCredentials } from "../tenant";
import { createAppleReports } from "./apple";
import { crashPerDay } from "./compute";
import { fetchStoreNumbers, snapshotAdSpend, snapshotField, type StoreFetchReport } from "./fetch";
import { createPlayReports } from "./google";
import { numbersStoreFor } from "./store";
import { clearNumbersCache } from "./view";

/**
 * When the Numbers cache is filled: once a day per app from the growth
 * autopilot's timer (numbersDaily), and when the owner presses Refresh
 * (refreshNumbers, rate-limited in routes.ts). Also keeps the daily ad
 * spend and crash counts that the other stores don't keep for long.
 */

const DAY = 86_400_000;
/** The daily pass reads the stores again after this long. */
export const DAILY_EVERY_MS = 20 * 3_600_000;

const running = new Map<string, Promise<StoreFetchReport>>();
export const refreshing = (appId: string) => running.has(appId);

async function snapshots(app: AppEntry, now: Date): Promise<void> {
  const store = fieldStore();
  const since = new Date(now.getTime() - 30 * DAY);
  const [events, crashes] = await Promise.all([store.events(app.id, since).catch(() => []), store.failures(app.id, CRASH_CONTRACT, 5000).catch(() => [])]);
  const perDay = crashPerDay(
    events,
    crashes.filter((c) => c.at >= since.toISOString()),
  );
  const campaigns = loadAds(resolve(app.repoPath, ADS_FILENAME)).campaigns;
  await numbersStoreFor(app).update(app.id, (d) => ({ doc: snapshotField(snapshotAdSpend(d, campaigns, now), perDay, now), result: null }));
}

/** Reads the stores now (one run per app at a time). */
export function refreshNumbers(app: AppEntry, now = new Date()): Promise<StoreFetchReport> {
  const have = running.get(app.id);
  if (have) return have;
  const run = (async () => {
    try {
      await snapshots(app, now).catch((err: Error) => console.error(`[day2-numbers] ${app.name}: ${err.message}`));
      if (appKind(app.repoPath) !== "react-native") {
        await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, fetchedAt: now.toISOString() }, result: null }));
        return { notes: [] };
      }
      const ids = storeIdsFromRepo(app.repoPath);
      const links = loadAppLinks(resolve(app.repoPath, APP_LINKS_FILENAME));
      const creds = releaseCredentials();
      const [asc, play] = await Promise.all([creds.get(app.id, "asc").catch(() => null), creds.get(app.id, "play").catch(() => null)]);
      return await fetchStoreNumbers(app.id, {
        store: numbersStoreFor(app),
        apple: asc ? createAppleReports(asc.value) : null,
        play: play ? createPlayReports(play.value) : null,
        ids: { bundleId: ids.bundleId, packageName: ids.packageName, appStoreId: links.ios?.appStoreId ?? null },
        now,
      });
    } finally {
      running.delete(app.id);
      clearNumbersCache(app.id);
    }
  })();
  running.set(app.id, run);
  return run;
}

/** The daily pass: reads the stores once a day per app. */
export async function numbersDaily(app: AppEntry, now = new Date()): Promise<StoreFetchReport | null> {
  const doc = await numbersStoreFor(app).load(app.id);
  if (doc.fetchedAt && now.getTime() - Date.parse(doc.fetchedAt) < DAILY_EVERY_MS) return null;
  return refreshNumbers(app, now);
}
