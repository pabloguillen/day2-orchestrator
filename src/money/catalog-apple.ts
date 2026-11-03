import { redact } from "../ads/http";
import { ascJwt, describeAppleErrors } from "../mobile-release/app-store";
import type { AscCredential } from "../mobile-release/credentials";
import type { Period, Product, RegionalPrice, StoreSide } from "./types";

/**
 * Products and prices in App Store Connect, with the App Store Connect API
 * key the owner already connected for releases (App Manager role).
 *
 * Subscriptions: subscription group (+ its localization) → subscription →
 * localization → availability → prices (the base region's price point and
 * Apple's equalized price points for every other territory, overridden
 * where the strategy set a regional price) → introductory offer (free
 * trial) per territory.
 * One-time and consumables: inAppPurchasesV2 → localization → price
 * schedule (base territory + manual regional prices; Apple equalizes the
 * rest) → availability.
 *
 * Apple's rules that need the owner: the first in-app purchase or
 * subscription of an app must be submitted together with an app version
 * (select it on the version page before submitting), and each product needs
 * a review screenshot before it can be submitted.
 */

const BASE = "https://api.appstoreconnect.apple.com";

/** ISO alpha-2 → App Store territory (alpha-3) for the regions strategies use. */
export const TERRITORY: Record<string, string> = {
  DE: "DEU", AT: "AUT", CH: "CHE", US: "USA", GB: "GBR", FR: "FRA", IT: "ITA", ES: "ESP", NL: "NLD", BE: "BEL", PL: "POL", SE: "SWE", DK: "DNK", NO: "NOR", FI: "FIN",
  IE: "IRL", PT: "PRT", CZ: "CZE", HU: "HUN", RO: "ROU", TR: "TUR", IN: "IND", BR: "BRA", MX: "MEX", CA: "CAN", AU: "AUS", NZ: "NZL", JP: "JPN", KR: "KOR", CN: "CHN",
};

export const APPLE_PERIOD: Record<Period, string> = { P1W: "ONE_WEEK", P1M: "ONE_MONTH", P2M: "TWO_MONTHS", P3M: "THREE_MONTHS", P6M: "SIX_MONTHS", P1Y: "ONE_YEAR" };

/** Free-trial durations Apple offers, by days. */
export function appleTrial(days: number): string | null {
  if (days <= 0) return null;
  if (days <= 3) return "THREE_DAYS";
  if (days <= 7) return "ONE_WEEK";
  if (days <= 14) return "TWO_WEEKS";
  if (days <= 31) return "ONE_MONTH";
  if (days <= 62) return "TWO_MONTHS";
  if (days <= 93) return "THREE_MONTHS";
  if (days <= 186) return "SIX_MONTHS";
  return "ONE_YEAR";
}

export const FIRST_PURCHASE_TODO = "Apple: the first in-app purchase must go to review with an app version. In App Store Connect, open the next version's page, find “In-App Purchases and Subscriptions”, click +, select this product, then submit the version.";
export const SCREENSHOT_TODO = "Apple: add a review screenshot of the paywall (App Store Connect → the product → Review Information). day2 adds it by itself once a device check has taken one.";

type Res<A = Record<string, unknown>> = { id: string; type: string; attributes?: A; relationships?: Record<string, { data?: { id: string; type: string } | null }> };
type Doc<T> = { data: T; included?: Res[]; links?: { next?: string } };

export class AscCatalogError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(`App Store Connect: ${message}`);
  }
}

export type AppleCatalog = {
  /** Creates the product (or finds it) with its price and trial; returns the store side. */
  ensure(product: Product, o: { bundleId: string; locale: string; groupName: string; firstPurchase: boolean }): Promise<StoreSide>;
  /** The product's current state in App Store Connect (MISSING_METADATA, READY_TO_SUBMIT, …). */
  state(product: Product): Promise<string | null>;
  /** Uploads a review screenshot (PNG/JPEG bytes). */
  reviewScreenshot(product: Product, file: { name: string; bytes: Uint8Array }): Promise<void>;
};

const rel = (type: string, id: string) => ({ data: { type, id } });

export function createAppleCatalog(cred: AscCredential, deps: { fetch?: typeof fetch; now?: () => Date } = {}): AppleCatalog {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
    const res = await doFetch(path.startsWith("http") ? path : `${BASE}${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: { authorization: `Bearer ${ascJwt(cred, now())}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 400);
      try {
        const j = JSON.parse(text) as { errors?: Parameters<typeof describeAppleErrors>[0] };
        if (j.errors?.length) msg = describeAppleErrors(j.errors) || msg;
      } catch {
        /* not JSON */
      }
      throw new AscCatalogError(`${res.status} ${redact(msg)}`, res.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Follows `links.next` (Apple pages at 200 by default). */
  async function all<A>(path: string): Promise<Array<Res<A>>> {
    const out: Array<Res<A>> = [];
    let next: string | undefined = path;
    for (let i = 0; next && i < 50; i++) {
      const page: Doc<Array<Res<A>>> = await api<Doc<Array<Res<A>>>>(next);
      out.push(...(page.data ?? []));
      next = page.links?.next;
    }
    return out;
  }

  const appIds = new Map<string, string>();
  async function appId(bundleId: string): Promise<string> {
    if (appIds.has(bundleId)) return appIds.get(bundleId)!;
    const r = await api<Doc<Res[]>>(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
    const id = r.data?.[0]?.id;
    if (!id) throw new AscCatalogError(`there's no app with bundle id ${bundleId} for this key's team.`);
    appIds.set(bundleId, id);
    return id;
  }

  let territories: string[] | null = null;
  const allTerritories = async () => (territories ??= (await all<{ currency?: string }>("/v1/territories?limit=200")).map((t) => t.id));

  /** The price point whose customer price matches `amount` in `territory`. */
  async function pricePoint(path: string, territory: string, amount: number): Promise<string> {
    const points = await all<{ customerPrice?: string }>(`${path}?filter[territory]=${territory}&limit=8000`);
    let best: { id: string; diff: number } | null = null;
    for (const p of points) {
      const diff = Math.abs(Number(p.attributes?.customerPrice ?? NaN) - amount);
      if (Number.isFinite(diff) && (!best || diff < best.diff)) best = { id: p.id, diff };
    }
    if (!best) throw new AscCatalogError(`no price points for ${territory}.`);
    if (best.diff > Math.max(0.01, amount * 0.02)) throw new AscCatalogError(`${amount} isn't one of Apple's price points in ${territory}; pick a listed price.`);
    return best.id;
  }

  async function ensureSubscription(p: Product, o: { bundleId: string; locale: string; groupName: string }): Promise<StoreSide> {
    const app = await appId(o.bundleId);
    // 1. Group.
    const groups = await all<{ referenceName?: string }>(`/v1/apps/${app}/subscriptionGroups?limit=200`);
    let group = groups.find((g) => g.attributes?.referenceName === o.groupName)?.id;
    if (!group) {
      group = (await api<Doc<Res>>("/v1/subscriptionGroups", { json: { data: { type: "subscriptionGroups", attributes: { referenceName: o.groupName }, relationships: { app: rel("apps", app) } } } })).data.id;
      await api("/v1/subscriptionGroupLocalizations", {
        json: { data: { type: "subscriptionGroupLocalizations", attributes: { locale: o.locale, name: o.groupName.slice(0, 75) }, relationships: { subscriptionGroup: rel("subscriptionGroups", group) } } },
      });
    }
    // 2. Subscription (found by product id on a re-run).
    const existing = (await all<{ productId?: string }>(`/v1/subscriptionGroups/${group}/subscriptions?limit=200`)).find((s) => s.attributes?.productId === p.productId);
    if (existing) return { state: "created", ref: existing.id, group, offer: p.trialDays ? appleTrial(p.trialDays) : null };
    const sub = (
      await api<Doc<Res>>("/v1/subscriptions", {
        json: {
          data: {
            type: "subscriptions",
            attributes: { name: p.name.slice(0, 64), productId: p.productId, subscriptionPeriod: APPLE_PERIOD[p.period ?? "P1M"], groupLevel: p.tier ?? 1, familySharable: false, reviewNote: reviewNote(p) },
            relationships: { group: rel("subscriptionGroups", group) },
          },
        },
      })
    ).data.id;
    await api("/v1/subscriptionLocalizations", {
      json: { data: { type: "subscriptionLocalizations", attributes: { locale: o.locale, name: p.name.slice(0, 35), description: p.description.slice(0, 55) }, relationships: { subscription: rel("subscriptions", sub) } } },
    });
    // 3. Where it's sold: everywhere, and new territories too.
    const terr = await allTerritories();
    await api("/v1/subscriptionAvailabilities", {
      json: {
        data: {
          type: "subscriptionAvailabilities",
          attributes: { availableInNewTerritories: true },
          relationships: { subscription: rel("subscriptions", sub), availableTerritories: { data: terr.map((id) => ({ type: "territories", id })) } },
        },
      },
    });
    // 4. Prices: the base price point, Apple's equalized points elsewhere, the strategy's regional prices on top.
    const baseTerr = TERRITORY[p.base.region] ?? p.base.region;
    const basePoint = await pricePoint(`/v1/subscriptions/${sub}/pricePoints`, baseTerr, p.base.amount);
    const perTerritory = new Map<string, string>([[baseTerr, basePoint]]);
    const eq = await api<Doc<Res[]>>(`/v1/subscriptionPricePoints/${basePoint}/equalizations?include=territory&limit=8000`);
    for (const e of eq.data ?? []) {
      const t = e.relationships?.territory?.data?.id;
      if (t && !perTerritory.has(t)) perTerritory.set(t, e.id);
    }
    for (const r of p.regional) {
      const t = TERRITORY[r.region];
      if (t) perTerritory.set(t, await pricePoint(`/v1/subscriptions/${sub}/pricePoints`, t, r.amount));
    }
    for (const [t, point] of perTerritory)
      await api("/v1/subscriptionPrices", {
        json: {
          data: {
            type: "subscriptionPrices",
            attributes: { startDate: null, preserveCurrentPrice: false },
            relationships: { subscription: rel("subscriptions", sub), subscriptionPricePoint: rel("subscriptionPricePoints", point), territory: rel("territories", t) },
          },
        },
      });
    // 5. Free trial for new subscribers.
    const trial = p.trialDays ? appleTrial(p.trialDays) : null;
    if (trial)
      for (const t of perTerritory.keys())
        await api("/v1/subscriptionIntroductoryOffers", {
          json: {
            data: {
              type: "subscriptionIntroductoryOffers",
              attributes: { duration: trial, offerMode: "FREE_TRIAL", numberOfPeriods: 1, startDate: null, endDate: null },
              relationships: { subscription: rel("subscriptions", sub), territory: rel("territories", t) },
            },
          },
        });
    return { state: "created", ref: sub, group, offer: trial };
  }

  async function ensureOneTime(p: Product, o: { bundleId: string; locale: string }): Promise<StoreSide> {
    const app = await appId(o.bundleId);
    const existing = (await all<{ productId?: string }>(`/v1/apps/${app}/inAppPurchasesV2?filter[productId]=${encodeURIComponent(p.productId)}&limit=50`)).find((x) => x.attributes?.productId === p.productId);
    if (existing) return { state: "created", ref: existing.id };
    const iap = (
      await api<Doc<Res>>("/v2/inAppPurchases", {
        json: {
          data: {
            type: "inAppPurchases",
            attributes: { name: p.name.slice(0, 64), productId: p.productId, inAppPurchaseType: p.kind === "consumable" ? "CONSUMABLE" : "NON_CONSUMABLE", reviewNote: reviewNote(p), familySharable: false },
            relationships: { app: rel("apps", app) },
          },
        },
      })
    ).data.id;
    await api("/v1/inAppPurchaseLocalizations", {
      json: { data: { type: "inAppPurchaseLocalizations", attributes: { locale: o.locale, name: p.name.slice(0, 35), description: p.description.slice(0, 55) }, relationships: { inAppPurchaseV2: rel("inAppPurchases", iap) } } },
    });
    const baseTerr = TERRITORY[p.base.region] ?? p.base.region;
    const prices: Array<{ id: string; point: string }> = [{ id: "${base}", point: await pricePoint(`/v2/inAppPurchases/${iap}/pricePoints`, baseTerr, p.base.amount) }];
    for (const [i, r] of p.regional.entries()) {
      const t = TERRITORY[r.region];
      if (t) prices.push({ id: `\${r${i}}`, point: await pricePoint(`/v2/inAppPurchases/${iap}/pricePoints`, t, r.amount) });
    }
    await api("/v1/inAppPurchasePriceSchedules", {
      json: {
        data: {
          type: "inAppPurchasePriceSchedules",
          relationships: {
            inAppPurchase: rel("inAppPurchases", iap),
            baseTerritory: rel("territories", baseTerr),
            manualPrices: { data: prices.map((x) => ({ type: "inAppPurchasePrices", id: x.id })) },
          },
        },
        included: prices.map((x) => ({
          type: "inAppPurchasePrices",
          id: x.id,
          attributes: { startDate: null },
          relationships: { inAppPurchaseV2: rel("inAppPurchases", iap), inAppPurchasePricePoint: rel("inAppPurchasePricePoints", x.point) },
        })),
      },
    });
    const terr = await allTerritories();
    await api("/v1/inAppPurchaseAvailabilities", {
      json: {
        data: {
          type: "inAppPurchaseAvailabilities",
          attributes: { availableInNewTerritories: true },
          relationships: { inAppPurchase: rel("inAppPurchases", iap), availableTerritories: { data: terr.map((id) => ({ type: "territories", id })) } },
        },
      },
    });
    return { state: "created", ref: iap };
  }

  return {
    async ensure(p, o) {
      const side = p.kind === "subscription" ? await ensureSubscription(p, o) : await ensureOneTime(p, o);
      return { ...side, status: await this.state({ ...p, ios: side }).catch(() => null), todo: [SCREENSHOT_TODO, ...(o.firstPurchase ? [FIRST_PURCHASE_TODO] : [])], at: now().toISOString(), error: null };
    },
    async state(p) {
      if (!p.ios.ref) return null;
      const path = p.kind === "subscription" ? `/v1/subscriptions/${p.ios.ref}` : `/v2/inAppPurchases/${p.ios.ref}`;
      return ((await api<Doc<Res<{ state?: string }>>>(path)).data.attributes?.state as string | undefined) ?? null;
    },
    async reviewScreenshot(p, file) {
      if (!p.ios.ref) throw new AscCatalogError("the product isn't in App Store Connect yet.");
      const sub = p.kind === "subscription";
      const type = sub ? "subscriptionAppStoreReviewScreenshots" : "inAppPurchaseAppStoreReviewScreenshots";
      const created = await api<Doc<Res<{ uploadOperations?: Array<{ method: string; url: string; offset: number; length: number; requestHeaders?: Array<{ name: string; value: string }> }> }>>>(`/v1/${type}`, {
        json: { data: { type, attributes: { fileName: file.name, fileSize: file.bytes.length }, relationships: sub ? { subscription: rel("subscriptions", p.ios.ref) } : { inAppPurchaseV2: rel("inAppPurchases", p.ios.ref) } } },
      });
      for (const op of created.data.attributes?.uploadOperations ?? []) {
        const r = await doFetch(op.url, { method: op.method, headers: Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value])), body: file.bytes.slice(op.offset, op.offset + op.length) });
        if (!r.ok) throw new AscCatalogError(`the screenshot upload failed (${r.status}).`, r.status);
      }
      const md5 = new Bun.CryptoHasher("md5").update(file.bytes).digest("hex");
      await api(`/v1/${type}/${created.data.id}`, { method: "PATCH", json: { data: { type, id: created.data.id, attributes: { uploaded: true, sourceFileChecksum: md5 } } } });
    },
  };
}

/** What App Review needs to find the product. */
export function reviewNote(p: Product): string {
  return `${p.name}: ${p.description} Shown on the in-app paywall. Purchases are verified with App Store Server Notifications.`.slice(0, 4000);
}

/** The regional price in a region, falling back to the base. */
export const priceIn = (p: { base: RegionalPrice; regional: RegionalPrice[] }, region: string): RegionalPrice | null => (p.base.region === region ? p.base : (p.regional.find((r) => r.region === region) ?? null));
