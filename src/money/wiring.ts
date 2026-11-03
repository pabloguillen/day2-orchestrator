import { join, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { APP_LINKS_FILENAME, loadAppLinks, storeIdsFromRepo } from "../ads/app-links";
import { ensureLocalSecretsKey } from "../ads/connections";
import { db } from "../db";
import { dataDir } from "../day2-paths";
import type { FieldStore } from "../field-store";
import type { EventLike } from "../metrics/types";
import type { ReleaseCredentialStore } from "../mobile-release/credentials";
import { ingestKeys, serverMode } from "../tenant";
import { createAppStoreServerApi } from "./apple-server-api";
import { createAppleCatalog, type AppleCatalog } from "./catalog-apple";
import { createGoogleCatalog, type GoogleCatalog } from "./catalog-google";
import { dbMoneyCredentials, fileMoneyCredentials, type MoneyCredentialStore } from "./credentials";
import { createPlayPurchases, googleClient, SCOPE_PLAY } from "./google-play";
import type { KpiUser } from "./kpis";
import { dbMoneyLedger, fileMoneyLedger, type MoneyLedger } from "./ledger";
import type { Batch, GrowthEvent } from "../../packages/sensors/src/types";
import type { MoneyRecord } from "./ledger";
import { addLog, loadMoney, MONEY_FILENAME, saveMoney, type Connection, type MoneyFile } from "./types";
import { tokenResolver, type VerifyDeps } from "./verify";

/**
 * Money's stores for the current mode and the dependencies built from the
 * owner's connected accounts. Kept here (not in tenant.ts) so Money stays
 * one folder.
 */

export function moneyLedger(): MoneyLedger {
  return serverMode() === "accounts" ? dbMoneyLedger(db()) : fileMoneyLedger(join(dataDir(), "money"));
}

export function moneyCredentials(): MoneyCredentialStore {
  if (serverMode() === "accounts") return dbMoneyCredentials(db());
  ensureLocalSecretsKey(join(dataDir(), ".day2-secrets-key"));
  return fileMoneyCredentials(join(dataDir(), ".day2-money-credentials.json"));
}

export const moneyPath = (app: AppEntry) => resolve(app.repoPath, MONEY_FILENAME);
export const loadAppMoney = (app: AppEntry) => loadMoney(moneyPath(app));
export const saveAppMoney = (app: AppEntry, f: MoneyFile) => saveMoney(moneyPath(app), f);

export function setConnection(app: AppEntry, c: Connection, ok: boolean, note: string, now = new Date()): MoneyFile {
  const f = loadAppMoney(app);
  const next = addLog({ ...f, connections: { ...f.connections, [c]: { ok, at: now.toISOString(), note } } }, note, now);
  saveAppMoney(app, next);
  return next;
}

/** Users of the last `days` with their experiment variants and where they came from (from their events). */
export async function knownUsers(app: AppEntry, store: FieldStore, now: Date, days = 90): Promise<{ users: KpiUser[]; events: EventLike[] }> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [activity, events] = await Promise.all([store.activity(app.id, since.toISOString().slice(0, 10)), store.events(app.id, since).catch(() => [] as EventLike[])]);
  const variants = new Map<string, Record<string, string>>();
  const source = new Map<string, string>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!e.userId) continue;
    if (e.variants && Object.keys(e.variants).length) variants.set(e.userId, { ...(variants.get(e.userId) ?? {}), ...e.variants });
    if (e.acquisition?.channel && !source.has(e.userId)) source.set(e.userId, e.acquisition.channel);
  }
  return { users: activity.users.map((u) => ({ user: u.user, variants: variants.get(u.user) ?? {}, source: source.get(u.user) ?? null })), events };
}

/** The store catalogs, from the accounts connected for releases (null when not connected). */
export async function catalogsFor(app: AppEntry, release: ReleaseCredentialStore): Promise<{ apple: AppleCatalog | null; google: GoogleCatalog | null }> {
  const [asc, play] = await Promise.all([release.get(app.id, "asc"), release.get(app.id, "play")]);
  return { apple: asc ? createAppleCatalog(asc.value) : null, google: play ? createGoogleCatalog(googleClient(play.value, SCOPE_PLAY)) : null };
}

/**
 * Pure. Verified records as server events for Live and the metric layer
 * (props.by "store" — not counted as the user being active):
 *  - `purchase_verified` with value: the store confirmed a purchase the app
 *    reported itself as `revenue` (not summed, so it isn't counted twice);
 *  - `revenue` with value: renewals (the app isn't open when they happen);
 *  - `refund` with value: subtracted from revenue.
 * One batch per record (variants are per batch).
 */
export function serverBatches(records: MoneyRecord[]): Batch[] {
  const out: Batch[] = [];
  for (const r of records) {
    if (r.sandbox || !r.user) continue;
    const type = r.type === "purchase_verified" ? "purchase_verified" : r.type === "renewal" ? "revenue" : r.type === "refund" && r.amount > 0 ? "refund" : null;
    if (!type || !(r.amount < 10_000)) continue;
    const e: GrowthEvent = {
      type,
      at: r.at,
      user: r.user,
      value: { amount: Math.round(r.amount * 100) / 100, currency: r.currency },
      props: { by: "store", kind: r.kind, ...(r.productId ? { product: r.productId.slice(0, 80) } : {}) },
    };
    out.push({ v: 1, device: { id: `day2-store-${r.store}`, platform: r.store === "google" ? "android" : "ios" }, passes: {}, failures: [], events: [e], ...(Object.keys(r.variants).length ? { variants: r.variants } : {}) });
  }
  return out;
}

/** Everything verification needs for one app; the user lookup is loaded on first use. */
export async function verifyDepsFor(app: AppEntry, o: { ledger: MoneyLedger; credentials: MoneyCredentialStore; release: ReleaseCredentialStore; store: FieldStore; now?: Date }): Promise<VerifyDeps> {
  const ids = storeIdsFromRepo(app.repoPath);
  const [iap, rtdn, play] = await Promise.all([o.credentials.get(app.id, "iap"), o.credentials.get(app.id, "rtdn"), o.release.get(app.id, "play")]);
  let resolver: ((t: string) => ReturnType<ReturnType<typeof tokenResolver>>) | null = null;
  const file = loadAppMoney(app);
  return {
    ledger: o.ledger,
    async who(token) {
      if (!resolver) {
        const [{ users }, appKey] = await Promise.all([knownUsers(app, o.store, o.now ?? new Date(), 400), ingestKeys().forApp(app.id)]);
        const by = new Map(users.map((u) => [u.user, u]));
        resolver = tokenResolver(
          appKey,
          users.map((u) => u.user),
          (u) => by.get(u)?.variants ?? {},
          (u) => by.get(u)?.source ?? null,
        );
      }
      return resolver(token);
    },
    bundleId: ids.bundleId,
    appAppleId: Number(loadAppLinks(resolve(app.repoPath, APP_LINKS_FILENAME)).ios?.appStoreId) || null,
    packageName: ids.packageName,
    appleApi: iap && ids.bundleId ? createAppStoreServerApi(iap, ids.bundleId) : null,
    play: play ? createPlayPurchases(googleClient(play.value, SCOPE_PLAY)) : null,
    rtdn,
    catalog: file.products,
    connected: async (c, note) => void setConnection(app, c, true, note),
    async emit(records) {
      const now = o.now ?? new Date();
      for (const b of serverBatches(records)) await o.store.record(app.id, b, now);
    },
    ...(o.now ? { now: o.now } : {}),
  };
}
