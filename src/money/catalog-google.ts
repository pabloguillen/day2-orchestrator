import { GoogleError, type GoogleClient } from "./google-play";
import type { Product, StoreSide } from "./types";

/**
 * Products and prices in Google Play, with the service account the owner
 * already connected for releases (it needs "Manage store presence" for
 * products, and "View financial data, orders and cancellation survey
 * responses" + "Manage orders and subscriptions" for the purchases API).
 *
 * Subscriptions (monetization.subscriptions): one subscription per product,
 * one auto-renewing base plan with prices in every region (Google's own
 * conversion of the base price — pricing:convertRegionPrices — overridden
 * by the strategy's regional prices), activated; a free-trial offer for new
 * subscribers, activated.
 * One-time and consumables: inappproducts (managed products) with
 * autoConvertMissingPrices. Google is moving one-time products to
 * monetization.onetimeproducts; day2 still uses inappproducts (not verified
 * against the newest Play Console accounts).
 */

const PLAY = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const REGIONS_VERSION = "2022/02";

type GMoney = { currencyCode: string; units: string; nanos: number };
export const gMoney = (amount: number, currency: string): GMoney => {
  const units = Math.floor(amount);
  return { currencyCode: currency, units: String(units), nanos: Math.round((amount - units) * 1e9) };
};
const micros = (amount: number) => String(Math.round(amount * 1e6));

export const BASE_PLAN_ID: Record<string, string> = { P1W: "weekly", P1M: "monthly", P2M: "every-2-months", P3M: "quarterly", P6M: "every-6-months", P1Y: "yearly" };
export const trialOfferId = (days: number) => `trial-${days}d`;

export type GoogleCatalog = {
  ensure(product: Product, o: { packageName: string; locale: string }): Promise<StoreSide>;
  state(product: Product, packageName: string): Promise<string | null>;
};

export function createGoogleCatalog(client: GoogleClient): GoogleCatalog {
  const app = (pkg: string) => `${PLAY}/applications/${encodeURIComponent(pkg)}`;
  const missing = (err: unknown) => err instanceof GoogleError && err.status === 404;

  async function regionPrices(pkg: string, p: Product): Promise<Map<string, GMoney>> {
    const r = await client.call<{ convertedRegionPrices?: Record<string, { regionCode: string; price: GMoney }> }>(`${app(pkg)}/pricing:convertRegionPrices`, {
      method: "POST",
      body: { price: gMoney(p.base.amount, p.base.currency) },
    });
    const m = new Map<string, GMoney>();
    for (const [code, v] of Object.entries(r.convertedRegionPrices ?? {})) m.set(code, v.price);
    m.set(p.base.region, gMoney(p.base.amount, p.base.currency));
    for (const x of p.regional) m.set(x.region, gMoney(x.amount, x.currency));
    return m;
  }

  async function ensureSubscription(p: Product, pkg: string, locale: string): Promise<StoreSide> {
    const basePlanId = BASE_PLAN_ID[p.period ?? "P1M"]!;
    const offerId = p.trialDays ? trialOfferId(p.trialDays) : null;
    const path = `${app(pkg)}/subscriptions/${encodeURIComponent(p.productId)}`;
    const existing = await client.call<{ basePlans?: Array<{ basePlanId: string; state?: string }> }>(path).catch((err) => {
      if (missing(err)) return null;
      throw err;
    });
    if (existing) return { state: "created", ref: p.productId, group: basePlanId, offer: offerId, status: existing.basePlans?.[0]?.state ?? null };
    const prices = await regionPrices(pkg, p);
    const regionalConfigs = [...prices].map(([regionCode, price]) => ({ regionCode, newSubscriberAvailability: true, price }));
    await client.call(`${app(pkg)}/subscriptions`, {
      method: "POST",
      query: { productId: p.productId, "regionsVersion.version": REGIONS_VERSION },
      body: {
        packageName: pkg,
        productId: p.productId,
        listings: [{ languageCode: locale, title: p.name.slice(0, 55), benefits: [], description: p.description.slice(0, 80) }],
        basePlans: [
          {
            basePlanId,
            autoRenewingBasePlanType: {
              billingPeriodDuration: p.period ?? "P1M",
              gracePeriodDuration: "P3D",
              resubscribeState: "RESUBSCRIBE_STATE_ACTIVE",
              prorationMode: "SUBSCRIPTION_PRORATION_MODE_CHARGE_ON_NEXT_BILLING_DATE",
              legacyCompatible: true,
            },
            regionalConfigs,
          },
        ],
      },
    });
    await client.call(`${path}/basePlans/${basePlanId}:activate`, { method: "POST", body: {} });
    if (offerId && p.trialDays) {
      const regions = [...prices.keys()];
      await client.call(`${path}/basePlans/${basePlanId}/offers`, {
        method: "POST",
        query: { offerId, "regionsVersion.version": REGIONS_VERSION },
        body: {
          packageName: pkg,
          productId: p.productId,
          basePlanId,
          offerId,
          phases: [{ recurrenceCount: 1, duration: `P${p.trialDays}D`, regionalConfigs: regions.map((regionCode) => ({ regionCode, free: {} })) }],
          regionalConfigs: regions.map((regionCode) => ({ regionCode, newSubscriberAvailability: true })),
          // Only people who never had this subscription get the trial.
          targeting: { acquisitionRule: { scope: { specificSubscriptionInApp: p.productId } } },
        },
      });
      await client.call(`${path}/basePlans/${basePlanId}/offers/${offerId}:activate`, { method: "POST", body: {} });
    }
    return { state: "created", ref: p.productId, group: basePlanId, offer: offerId, status: "ACTIVE" };
  }

  async function ensureOneTime(p: Product, pkg: string, locale: string): Promise<StoreSide> {
    const path = `${app(pkg)}/inappproducts/${encodeURIComponent(p.productId)}`;
    const existing = await client.call<{ status?: string }>(path).catch((err) => {
      if (missing(err)) return null;
      throw err;
    });
    if (existing) return { state: "created", ref: p.productId, status: existing.status ?? null };
    const prices: Record<string, { priceMicros: string; currency: string }> = {};
    for (const r of p.regional) prices[r.region] = { priceMicros: micros(r.amount), currency: r.currency };
    await client.call(`${app(pkg)}/inappproducts`, {
      method: "POST",
      query: { autoConvertMissingPrices: "true" },
      body: {
        packageName: pkg,
        sku: p.productId,
        status: "active",
        purchaseType: "managedUser",
        defaultLanguage: locale,
        defaultPrice: { priceMicros: micros(p.base.amount), currency: p.base.currency },
        prices,
        listings: { [locale]: { title: p.name.slice(0, 55), description: p.description.slice(0, 200) } },
      },
    });
    return { state: "created", ref: p.productId, status: "active" };
  }

  return {
    async ensure(p, o) {
      const side = p.kind === "subscription" ? await ensureSubscription(p, o.packageName, o.locale) : await ensureOneTime(p, o.packageName, o.locale);
      return { ...side, error: null, todo: [], at: new Date().toISOString() };
    },
    async state(p, pkg) {
      if (p.kind === "subscription") {
        const s = await client.call<{ basePlans?: Array<{ state?: string }> }>(`${app(pkg)}/subscriptions/${encodeURIComponent(p.productId)}`);
        return s.basePlans?.[0]?.state ?? null;
      }
      return (await client.call<{ status?: string }>(`${app(pkg)}/inappproducts/${encodeURIComponent(p.productId)}`)).status ?? null;
    },
  };
}
