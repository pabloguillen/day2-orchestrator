import type { WalkStep } from "../store-walkthrough";
import type { IapCredential } from "./credentials";
import { storeKitJwt, STOREKIT_PRODUCTION } from "./apple-server-api";
import type { Connection, MoneyFile } from "./types";

/**
 * What the owner sets up once for Money, each with a connection test like
 * mobile-release/check-access.ts and a "Do it with me" walkthrough
 * (store-walkthrough.ts's WalkStep): Apple's In-App Purchase key and server
 * notification URL, Google's Pub/Sub topic and Play Console notifications,
 * Apple's Paid Apps agreement, Google's payments profile, and AdMob.
 */

export type Access = { ok: true; who: string } | { ok: false; why: string };

export const ADMOB_APP_ID = /^ca-app-pub-\d{16}~\d{10}$/;
export const ADMOB_UNIT_ID = /^ca-app-pub-\d{16}\/\d{10}$/;

/**
 * The lightest call that proves the key: looking up a transaction id that
 * can't exist. Apple answers 4xx "not found / invalid id" when the key is
 * accepted and 401 when it isn't.
 */
export async function checkIap(cred: IapCredential, bundleId: string | null, doFetch: typeof fetch = fetch): Promise<Access> {
  if (!bundleId) return { ok: false, why: "day2 needs the app's bundle id (ios.bundleIdentifier in app.json) to use the key." };
  let res: Response;
  try {
    res = await doFetch(`${STOREKIT_PRODUCTION}/inApps/v1/transactions/0`, { headers: { authorization: `Bearer ${storeKitJwt(cred, bundleId, new Date())}` }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    if (/key|pem|asn1|decoder/i.test((err as Error).message)) return { ok: false, why: "The .p8 file didn't read as a key. Paste the whole file, including the BEGIN and END lines." };
    return { ok: false, why: "day2 couldn't reach Apple. Try again in a minute." };
  }
  if (res.status === 401) return { ok: false, why: "Apple didn't accept the key. Check that it's the In-App Purchase key (not the App Store Connect API key), the key id next to its name, and the issuer id at the top of the page." };
  if (res.status === 400 || res.status === 404) return { ok: true, who: `In-App Purchase key for ${bundleId}` };
  if (res.status === 429) return { ok: false, why: "Apple asks day2 to slow down. Try again in a minute." };
  return { ok: false, why: `Apple answered ${res.status}. Try again in a minute.` };
}

/** Pure. Ad unit ids the owner entered, checked. */
export function checkAdMobIds(input: { appId?: { ios?: string; android?: string }; units?: Record<string, { ios?: string; android?: string }> }): string | null {
  for (const [p, v] of Object.entries(input.appId ?? {})) if (v && !ADMOB_APP_ID.test(v)) return `The ${p === "ios" ? "iOS" : "Android"} AdMob app id looks like ca-app-pub-1234567890123456~1234567890 (with a ~).`;
  for (const [id, u] of Object.entries(input.units ?? {}))
    for (const [p, v] of Object.entries(u)) if (v && !ADMOB_UNIT_ID.test(v)) return `The ${p === "ios" ? "iOS" : "Android"} ad unit id for “${id}” looks like ca-app-pub-1234567890123456/1234567890 (with a /).`;
  return null;
}

export type ConnectionView = { id: Connection; title: string; what: string; state: "done" | "todo"; note: string | null; walkthrough: WalkStep[]; test: "upload" | "button" | "confirm" };

/** Pure. What the owner does once, in order, with where each one stands. */
export function connectionViews(file: MoneyFile, o: { appName: string; appStoreId: string | null; publicUrl: string; appId: string; iapLabel: string | null; rtdnLabel: string | null; hasIos: boolean; hasAndroid: boolean }): ConnectionView[] {
  const c = file.connections;
  const conf = file.settings.confirmed;
  const appleUrl = `${o.publicUrl}/api/store-notify/apple/${o.appId}`;
  const googleUrl = `${o.publicUrl}/api/store-notify/google/${o.appId}`;
  const asc = (path: string) => (o.appStoreId ? `https://appstoreconnect.apple.com/apps/${o.appStoreId}/${path}` : "https://appstoreconnect.apple.com/apps");
  const ads = file.ads.length > 0 || Boolean(file.settings.admob.appId.ios || file.settings.admob.appId.android);
  const views: ConnectionView[] = [];
  if (o.hasIos) {
    views.push(
      {
        id: "paid_apps",
        title: "Apple: Paid Apps agreement",
        what: "Apple pays you only after you accept the Paid Apps agreement and add your bank account and tax forms. Without it, in-app purchases can't be sold or even tested in TestFlight.",
        state: conf.paid_apps ? "done" : "todo",
        note: conf.paid_apps ? `Confirmed ${conf.paid_apps.at.slice(0, 10)}` : null,
        test: "confirm",
        walkthrough: [
          { title: "Open Agreements", detail: "Sign in to App Store Connect as the Account Holder (only they can accept agreements). Open Business (Agreements, Tax, and Banking).", link: { label: "Open Business", url: "https://appstoreconnect.apple.com/business" } },
          { title: "Accept Paid Apps", detail: "Under Agreements, find “Paid Apps” and click View and Agree to Terms. Read and accept." },
          { title: "Bank account", detail: "Under Bank Accounts, add the account Apple pays into (IBAN for a German account). Apple pays monthly, about 45 days after the end of the month, once you've earned at least the payment threshold." },
          { title: "Tax forms", detail: "Under Tax Forms, fill in the U.S. tax form (W-8BEN for a person, W-8BEN-E for a company outside the US) — needed even if you never sell in the US." },
          { title: "Wait for “Active”", detail: "The Paid Apps agreement shows “Active” once Apple has checked everything (can take a day or two). Then come back and confirm here." },
        ],
      },
      {
        id: "iap_key",
        title: "Apple: In-App Purchase key",
        what: "A separate key (not the one for releases) that lets day2 look up purchases with Apple's App Store Server API. Stored encrypted, never shown again.",
        state: c.iap_key?.ok ? "done" : "todo",
        note: o.iapLabel ?? c.iap_key?.note ?? null,
        test: "upload",
        walkthrough: [
          { title: "Open Integrations", detail: "In App Store Connect, open Users and Access, then Integrations at the top, then “In-App Purchase” in the left list.", link: { label: "Open Integrations", url: "https://appstoreconnect.apple.com/access/integrations/api" } },
          { title: "Generate the key", detail: "Click Generate In-App Purchase Key (or + next to Active), name it “day2”, click Generate." },
          { title: "Download it once", detail: "Click Download next to the new key. Apple lets you download it only once — the file is called SubscriptionKey_XXXXXXXXXX.p8." },
          { title: "Paste it here", detail: "Copy the key id (next to its name) and the issuer id (at the top of the Integrations page), then paste them and the whole .p8 file in the form below. day2 tries the key with Apple before it keeps it." },
        ],
      },
      {
        id: "apple_notifications",
        title: "Apple: server notifications",
        what: "Apple tells day2 about every purchase, renewal, refund and cancellation. day2 checks each one's signature before it counts.",
        state: c.apple_notifications?.ok ? "done" : "todo",
        note: c.apple_notifications?.note ?? null,
        test: "button",
        walkthrough: [
          { title: "Open App Information", detail: `In App Store Connect, open ${o.appName}, then App Information (under General).`, link: { label: "Open App Information", url: asc("distribution/info") } },
          { title: "Production URL", detail: `Find “App Store Server Notifications”. Next to Production Server URL click Set Up URL and enter:\n${appleUrl}\nChoose Version 2 notifications. Save.` },
          { title: "Sandbox URL", detail: `Next to Sandbox Server URL, enter the same address:\n${appleUrl}\nVersion 2. Save. Sandbox purchases (TestFlight, test accounts) are recorded but never counted as revenue.` },
          { title: "Test it", detail: "Back here, click “Send a test notification”. day2 asks Apple to send one (with the In-App Purchase key) and shows when it arrived." },
        ],
      },
    );
  }
  if (o.hasAndroid) {
    views.push(
      {
        id: "payments_profile",
        title: "Google: payments profile",
        what: "Google pays you through a payments profile linked to your Play Console. Without it you can't create paid products.",
        state: conf.payments_profile ? "done" : "todo",
        note: conf.payments_profile ? `Confirmed ${conf.payments_profile.at.slice(0, 10)}` : null,
        test: "confirm",
        walkthrough: [
          { title: "Open Payments profile", detail: "In the Play Console, open Settings (left menu, bottom) → Payments profile.", link: { label: "Open the Play Console", url: "https://play.google.com/console" } },
          { title: "Create or link it", detail: "Create a payments profile (or link the one you have) with your legal name or company and address. Add your bank account under Payment methods; Google sends a small test deposit to confirm it." },
          { title: "Tax info", detail: "Fill in the tax information (for Germany your VAT number if you have one). Then confirm here." },
        ],
      },
      {
        id: "rtdn",
        title: "Google: real-time notifications",
        what: "Google Play tells day2 about purchases, renewals, cancellations and refunds through a Pub/Sub topic. day2 checks that each message really comes from Google, then reads the purchase from Google Play.",
        state: c.rtdn?.ok ? "done" : "todo",
        note: o.rtdnLabel ?? c.rtdn?.note ?? null,
        test: "button",
        walkthrough: [
          { title: "Let day2 try first", detail: "Click “Set up Pub/Sub for me”. If the Google Play service account has Pub/Sub Admin in its Google Cloud project, day2 creates the topic and the push subscription itself — skip to step 5." },
          { title: "Create the topic", detail: "Otherwise: in Google Cloud Console (the project of the service account), open Pub/Sub → Topics → Create topic, name it day2-play, without a default subscription.", link: { label: "Open Pub/Sub", url: "https://console.cloud.google.com/cloudpubsub/topic/list" } },
          { title: "Let Google Play publish", detail: "Open the topic → Permissions → Add principal: google-play-developer-notifications@system.gserviceaccount.com with the role Pub/Sub Publisher." },
          { title: "Push to day2", detail: `Create a subscription on the topic: delivery type Push, endpoint\n${googleUrl}\nTick “Enable authentication”, pick the service account day2 uses for Google Play, audience: the same address. Then paste the service account email here.` },
          { title: "Tell Google Play", detail: "In the Play Console, open the app → Monetize with Play → Monetization setup. Under Real-time developer notifications, turn it on, enter the full topic name (projects/<project>/topics/day2-play), choose “Subscriptions, voided purchases, and all one-time products”, save." },
          { title: "Send a test", detail: "Still there, click Send test notification. This card turns green when it arrives." },
        ],
      },
    );
  }
  if (ads)
    views.push({
      id: "admob",
      title: "Google AdMob",
      what: "Ads are served and paid by Google AdMob into your own AdMob account. day2 decides where and how often; it never sees your AdMob login.",
      state: (file.settings.admob.appId.ios || !o.hasIos) && (file.settings.admob.appId.android || !o.hasAndroid) && file.ads.every((a) => a.unitId.ios || a.unitId.android) ? "done" : "todo",
      note: null,
      test: "confirm",
      walkthrough: [
        { title: "Create the AdMob account", detail: "Sign in at admob.google.com with the Google account that should receive ad payments and create the account (country, time zone, payments currency).", link: { label: "Open AdMob", url: "https://admob.google.com" } },
        { title: "Add the app", detail: `Apps → Add app. Add ${o.appName} once for iOS and once for Android; link each to its store listing once it's published. Copy each app id (ca-app-pub-…~…) into the form on this page.` },
        { title: "Create ad units", detail: `For each placement listed on this page, create an ad unit of the same format (Banner, Interstitial or Rewarded) in each app. Name it like the placement. Copy each ad unit id (ca-app-pub-…/…) next to its placement here.` },
        { title: "Payments and app-ads.txt", detail: "Under Payments, add your payment details (AdMob pays monthly above a threshold). Put the app-ads.txt line AdMob shows into your developer website's root (the website in your store listings) — unverified apps earn less." },
        { title: "Test ads", detail: "Development builds always show Google's test ads (the code uses TestIds when __DEV__); never tap your own real ads — AdMob can close accounts for it." },
      ],
    });
  return views;
}
