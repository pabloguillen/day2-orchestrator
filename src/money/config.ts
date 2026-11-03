import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { Json, LiveAd } from "../../packages/sensors/src/types";
import type { LiveContribution, LiveContributor } from "../live/contributors";
import { currentStrategy, loadMoney, MONEY_FILENAME, type MoneyFile, type Product } from "./types";

/**
 * Money's part of Live config (served to the app, public — nothing secret;
 * the same for every user, as contributors must be):
 *  - `paywall.<placement>`: the paywall's texts, products (store ids),
 *    highlight and trial, which the app's own paywall screen reads with
 *    day2.value(). Paywall tests override these keys.
 *  - `money.products`: every product the purchase layer should fetch.
 *  - `money.ads`: request options for AdMob (non-personalized and tagged
 *    for under the age of consent when many users may be minors) and which
 *    placements wait until the second session.
 *  - `ads`: each placement with its ad unit ids and caps; day2.adPlacement()
 *    decides per user and day2.adShown() counts toward the caps.
 */

const sold = (p: Product) => !p.retiredAt && (p.ios.state === "created" || p.android.state === "created");

const productValue = (p: Product): Json => ({
  id: p.productId,
  key: p.key,
  kind: p.kind,
  ...(p.period ? { period: p.period } : {}),
  trialDays: p.trialDays ?? 0,
  ios: p.ios.state === "created",
  android: p.android.state === "created",
});

/** Pure. */
export function liveConfigPart(file: MoneyFile): LiveContribution {
  if (!file.settings.enabled) return {};
  const strategy = currentStrategy(file);
  const minors = strategy?.basis.minors ?? false;
  const values: Record<string, Json> = {};
  // The newest sold version of each key (older ones stay for existing buyers).
  const byKey = new Map<string, Product>();
  for (const p of file.products.filter((x) => sold(x) && !x.test)) {
    const have = byKey.get(p.key);
    if (!have || p.version > have.version) byKey.set(p.key, p);
  }
  const all = file.products.filter(sold);
  if (all.length) values["money.products"] = all.map(productValue);
  for (const w of file.paywalls.filter((x) => x.enabled)) {
    const products = w.products.map((k) => byKey.get(k)).filter((p): p is Product => Boolean(p));
    if (!products.length) continue;
    const highlight = (w.highlight && byKey.get(w.highlight)) || products[0]!;
    values[`paywall.${w.placement}`] = {
      title: w.title,
      subtitle: w.subtitle,
      bullets: w.bullets,
      cta: w.cta,
      products: products.map(productValue),
      highlight: highlight.productId,
      trialDays: highlight.trialDays ?? 0,
      layout: "list",
    };
  }
  const ads: Record<string, LiveAd> = {};
  for (const a of file.ads) {
    const hasUnit = Boolean(a.unitId.ios || a.unitId.android);
    ads[a.id] = { format: a.format, unitId: { ...a.unitId }, cap: { ...a.cap }, enabled: a.enabled && hasUnit };
  }
  if (file.ads.length)
    values["money.ads"] = {
      nonPersonalized: minors,
      tagForUnderAgeOfConsent: minors,
      maxAdContentRating: minors ? "T" : "MA",
      notInFirstSession: file.ads.filter((a) => a.notInFirstSession).map((a) => a.id),
    };
  return { ...(Object.keys(values).length ? { values } : {}), ...(Object.keys(ads).length ? { ads } : {}) };
}

export const moneyContributor: LiveContributor = {
  module: "money",
  async contribute(app: AppEntry) {
    return liveConfigPart(loadMoney(resolve(app.repoPath, MONEY_FILENAME)));
  },
};
