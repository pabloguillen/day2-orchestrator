import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { NewTicketInput } from "../backlog";
import { registerNativeNeed } from "../live/native-foundations";
import { currentStrategy, PERIOD_LABEL, type MoneyFile, type Strategy } from "./types";

/**
 * The app's code for Money, built once by the build agent through tickets,
 * in the app's own style. Everything that changes later (texts, products,
 * highlight, trial, placements, caps) comes from Live config, so tests and
 * new prices need no new code.
 *
 *  - Purchases: expo-iap — fetch products, buy with day2's purchase token,
 *    finish transactions, restore, entitlement state.
 *  - Paywall: one screen in the app's style reading `paywall.<placement>`.
 *  - Ads: react-native-google-mobile-ads with Google's UMP consent (and
 *    Apple's tracking prompt only when ads may be personalized), placements
 *    gated by day2.adPlacement(), reported with day2.adShown() and onPaid →
 *    day2.revenue({ kind: "ad" }).
 * Native packages are registered with Live's native foundations, so they
 * reach users together in one store release.
 */

export const PURCHASES_KEY = "money:purchases";
export const PAYWALL_KEY = "money:paywall";
export const ADS_KEY = "money:ads";
export const ADS_ATT_KEY = "money:ads+att";

/** The packages' current majors as day2 last checked them (the build agent installs with `npx expo install`, which picks what fits the SDK). */
const PURCHASE_PACKAGES = ["expo-iap"];
const AD_PACKAGES = ["react-native-google-mobile-ads"];

export function repoHas(repoPath: string, pkg: string): boolean {
  const p = join(repoPath, "package.json");
  if (!existsSync(p)) return false;
  return readFileSync(p, "utf-8").includes(`"${pkg}"`);
}

/** RevenueCat already in the app: day2 reads its webhooks instead of verifying itself. */
export const usesRevenueCat = (repoPath: string) => repoHas(repoPath, "react-native-purchases");

const lines = (xs: Array<string | false | null | undefined>) => xs.filter((x): x is string => typeof x === "string").join("\n");

export function purchasesTicket(s: Strategy): NewTicketInput {
  const subs = s.products.some((p) => p.kind === "subscription");
  return {
    title: "In-app purchases with Apple's and Google's billing (expo-iap)",
    type: "feature",
    description: lines([
      `day2's approved plan for this app: ${s.summary}`,
      "",
      "Build the purchase layer once; which products exist and how they're shown comes from day2's Live config, so prices and tests change without new code.",
      "",
      "1. Install expo-iap with `npx expo install expo-iap` and add its config plugin to app.json (native foundations: this ships in the next store build).",
      '2. Products: read `day2.value("money.products", [])` — a list of `{ id, kind, period?, trialDays, ios, android }`. Fetch them from the store with expo-iap (subscriptions as type "subs", one-time and consumables as "in-app"), only those available on the current platform.',
      "3. Buy: pass day2's purchase token so day2 can match the store's notification to the user without any personal data:",
      "   - iOS: `appAccountToken: day2.purchaseToken()`",
      "   - Android: `obfuscatedAccountIdAndroid: day2.purchaseToken()`",
      "   If purchaseToken() is null (the user isn't identified), buy without it.",
      "4. After a successful purchase: unlock, then finish the transaction (`finishTransaction`, with isConsumable for consumables — this also acknowledges it on Google Play; unacknowledged purchases are refunded after 3 days). Then call `day2.revenue({ kind, amount, currency, productId })` with the localized price the store returned (kind: \"subscription\" or \"purchase\"). day2 checks the real amount with Apple and Google itself.",
      "5. Restore: a \"Restore purchases\" button (Apple requires it) that reads the user's available purchases and restores entitlements.",
      `6. Entitlements: one small module (e.g. useEntitlement()) that knows what the user owns from the store's own purchase history on launch and after each purchase or restore${subs ? "; an expired or refunded subscription removes access" : ""}. Everything that's paid checks it.`,
      "7. Errors in plain words (cancelled = no message; pending = \"waiting for approval\", e.g. Ask to Buy; network = try again).",
      "8. Tests: the entitlement module, the purchase flow with expo-iap mocked (token passed, transaction finished, revenue reported once), restore.",
      "",
      "Never log receipts, purchase tokens or the user's id. No prices hard-coded: they come from the store (localized).",
    ]),
    doneWhen: [
      "Products from day2.value(\"money.products\") are fetched from the App Store / Google Play",
      "Purchases carry day2.purchaseToken() (appAccountToken / obfuscatedAccountIdAndroid)",
      "Transactions are finished (consumables consumed) and reported with day2.revenue",
      "Restore purchases works and entitlements follow the store's state",
      "Tests cover purchase, restore and entitlements",
    ],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: PURCHASES_KEY },
    actor: "day2",
    createdNote: "From the monetization plan the owner approved.",
  };
}

export function paywallTicket(s: Strategy): NewTicketInput {
  const where = s.paywalls.map((w) => `- \`${w.placement}\`: ${w.trigger}${w.why ? ` (${w.why})` : ""}`).join("\n");
  const example = s.paywalls[0];
  return {
    title: "Paywall screen in the app's style, driven by day2's config",
    type: "feature",
    description: lines([
      "One paywall screen, built in the app's own design (colors, type, components, voice) — not a generic one. Everything on it comes from Live config, so day2 can test wording, layout, trial length and prices without a release.",
      "",
      'Read `day2.value("paywall.<placement>", null)` (or `useDay2Value`) when the screen opens. Shape:',
      "```",
      '{ title, subtitle, bullets: string[], cta, products: [{ id, kind, period?, trialDays, ios, android }], highlight: "<product id>", trialDays, layout: "list" | "cards" }',
      "```",
      example ? `For example, now: title "${example.title}", button "${example.cta}".` : "",
      "",
      "Placements (show the screen there; when the value is null, don't show it):",
      where || "- (none yet)",
      "",
      "On the screen:",
      "- The store's localized price for each product (from expo-iap), with the period (\"/ month\") and, when trialDays > 0, the trial (\"7 days free, then …\") — Apple and Google require the full price and renewal terms to be clear.",
      "- The highlighted product preselected; layout \"cards\" shows products side by side, \"list\" stacked.",
      "- Restore purchases, Terms of Use and Privacy Policy links (Apple requires them for subscriptions).",
      "- A clear close button. Never block the app's free part behind it.",
      `- When it opens: \`day2.track("paywall_shown", { props: { placement } })\` (with a library version that has event props; plain \`day2.track("paywall_shown")\` before that). Buying uses the purchase layer (ticket "${PURCHASES_KEY}").`,
      "",
      "Tests: renders from a config value, hides when null, shows trial terms only when trialDays > 0.",
    ]),
    doneWhen: [
      "The paywall reads paywall.<placement> from day2 and shows nothing when it's null",
      "Prices, periods and trial terms come from the store, localized",
      "Restore, Terms and Privacy links, and a close button",
      "paywall_shown is tracked with its placement",
      "Built in the app's own style; tests pass",
    ],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: PAYWALL_KEY },
    actor: "day2",
    createdNote: "From the monetization plan the owner approved.",
  };
}

export function adsTicket(s: Strategy, o: { appId: { ios?: string; android?: string } }): NewTicketInput {
  const minors = s.basis.minors;
  const att = !minors;
  const places = s.ads.map((a) => `- \`${a.id}\` (${a.format}): ${a.where}${a.notInFirstSession ? " — not in the first session" : ""}`).join("\n");
  return {
    title: "In-app ads with Google AdMob, consent first",
    type: "feature",
    description: lines([
      `day2's approved plan for this app: ${s.summary}`,
      "",
      "1. Install react-native-google-mobile-ads with `npx expo install react-native-google-mobile-ads` and set its config plugin with the AdMob app ids:",
      `   iOS ${o.appId.ios ?? "(the owner enters it on day2's Money page)"}, Android ${o.appId.android ?? "(the owner enters it on day2's Money page)"}. Add Google's SKAdNetwork identifiers on iOS (the plugin's skAdNetworkItems).`,
      "2. Consent before any ad request: Google's User Messaging Platform (AdsConsent in this library) — request consent info on launch, show the form when required (EU/UK), and only call `mobileAds().initialize()` once `canRequestAds` is true.",
      att
        ? '3. iOS tracking prompt (expo-tracking-transparency): ask after the first session, never on first launch, with NSUserTrackingUsageDescription in app.json (e.g. "Damit wir dir passende Werbung zeigen können."). Without a yes, ads are non-personalized.'
        : "3. Many users may be minors: no tracking prompt. Request only non-personalized ads, and set the request configuration from config.",
      '4. Request options from `day2.value("money.ads", {})`: `{ nonPersonalized, tagForUnderAgeOfConsent, maxAdContentRating, notInFirstSession: string[] }` → `mobileAds().setRequestConfiguration(...)` and `requestNonPersonalizedAdsOnly`.',
      "5. Every placement asks day2 first: `const p = day2.adPlacement(id)`; show only when `p.show`, with `p.unitId`. Placements listed in notInFirstSession wait until the user's second session.",
      "   In development builds (`__DEV__`) always use the library's TestIds instead of p.unitId — never real ads while testing.",
      "6. When an ad was shown: `day2.adShown(id)` (counts toward the caps). On the ad's paid event (onPaid / AdEventType.PAID): `day2.revenue({ kind: \"ad\", amount: value, currency, placement: id })` (value is the estimated earnings AdMob reports, already in units, not micros — check the library's event).",
      "7. Rewarded ads only where the user chooses to watch, and the reward is given on the earned-reward event.",
      "",
      "Placements in the plan:",
      places || "- (none yet)",
      "",
      "Tests: no ad request before consent; a placement with show=false renders nothing; adShown and revenue are reported once per ad.",
      "",
      "Before the release with this change, update the store privacy answers (day2 lists them on the app's Privacy page).",
    ]),
    doneWhen: [
      "AdMob app ids in the config plugin; test ads in development builds",
      "No ad request before UMP consent allows it",
      att ? "The tracking prompt shows after the first session, never on first launch" : "Only non-personalized ads, tagged for under the age of consent",
      "Placements are gated by day2.adPlacement and reported with adShown and revenue({ kind: \"ad\" })",
      "Tests pass",
    ],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: att ? ADS_ATT_KEY : ADS_KEY },
    actor: "day2",
    createdNote: "From the monetization plan the owner approved.",
  };
}

/** Pure. The tickets an approved strategy needs that the app doesn't have yet. */
export function ticketsFor(file: MoneyFile, s: Strategy, o: { haveKeys: Set<string>; usesRevenueCat: boolean }): NewTicketInput[] {
  if (s.verdict !== "monetize") return [];
  const out: NewTicketInput[] = [];
  const need = (k: string) => !o.haveKeys.has(k) && !file.tickets[k];
  if (s.products.length && !o.usesRevenueCat && need(PURCHASES_KEY)) out.push(purchasesTicket(s));
  if (s.paywalls.length && need(PAYWALL_KEY)) out.push(paywallTicket(s));
  if (s.ads.length && need(ADS_KEY) && need(ADS_ATT_KEY)) out.push(adsTicket(s, { appId: file.settings.admob.appId }));
  return out;
}

/**
 * Native code Money needs, for Live's single "native foundations" release
 * (one need per module): expo-iap when the plan sells something,
 * react-native-google-mobile-ads when it has ads. Live installs only the
 * packages the app doesn't have yet.
 */
export function registerMoneyNativeNeeds(load: (app: AppEntry) => MoneyFile): void {
  registerNativeNeed({
    module: "money",
    packages: [...PURCHASE_PACKAGES, ...AD_PACKAGES],
    plugins: ["expo-iap", "react-native-google-mobile-ads"],
    instructions: [
      "expo-iap: Apple's and Google's in-app billing (StoreKit 2 / Play Billing), plugin \"expo-iap\".",
      "react-native-google-mobile-ads: Google AdMob with Google's consent form (UMP); set the AdMob app ids for iOS and Android in its config plugin (from day2's Money page) and Google's SKAdNetwork identifiers; for personalized ads on iOS also expo-tracking-transparency with NSUserTrackingUsageDescription.",
      "If the plan has no ads yet, leave react-native-google-mobile-ads out (and vice versa for purchases): the Money page shows which parts the plan uses.",
    ].join(" "),
    async whenNeeded(app) {
      const s = currentStrategy(load(app));
      if (!s || s.verdict !== "monetize") return false;
      const buys = s.products.length > 0 && !usesRevenueCat(app.repoPath) && !repoHas(app.repoPath, "expo-iap");
      const ads = s.ads.length > 0 && !repoHas(app.repoPath, "react-native-google-mobile-ads");
      return buys || ads;
    },
  });
}

export const periodWord = (p?: string) => (p && p in PERIOD_LABEL ? PERIOD_LABEL[p as keyof typeof PERIOD_LABEL] : "");
