import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { NewTicketInput, Ticket } from "./backlog";
import { INSTALL_KEY } from "./field-work";
import { IDENTIFY_KEY } from "./retention";

// Money's ticket keys (src/money/tickets.ts), repeated here to keep this module free of Money's imports.
const MONEY_PURCHASES_KEY = "money:purchases";
const MONEY_ADS_KEY = "money:ads";
const MONEY_ADS_ATT_KEY = "money:ads+att";

/**
 * App Store privacy ("nutrition label") and Google Play Data safety answers
 * for what day2 adds to a mobile app — and what to change when that grows.
 *
 * day2 can't edit App Store Connect or the Play Console, so the owner does
 * it: day2 works out the exact answers from what's actually in the app
 * (merged tickets and the owner's settings), shows what changed since the
 * owner last confirmed, and asks again whenever a change reaches the app.
 * The answers must be updated before the release that ships the change.
 *
 * What day2 adds, and how each store sees it:
 *  - field checks → Diagnostics (crashes and errors, freezes and loading
 *    times, failed checks and device details) and Usage Data → Product
 *    Interaction. Not linked to the user while day2 keeps its default random
 *    id per launch.
 *  - identify (hashed user id) → Identifiers → User ID, and Product
 *    Interaction becomes linked to the user.
 *  - retention treatments → adds Product Personalization.
 *  - a fixed device id (identity "device") → Identifiers → Device ID.
 *  - push notifications (Messages) → Identifiers → Device ID (Apple) and
 *    Device or other IDs (Google): the Expo push token, linked to the user,
 *    for App Functionality and the app's own marketing messages.
 *  - ad conversions (sending the ad's click id back to the ad platform) →
 *    tracking under Apple's rules: Advertising Data, "Used to track you",
 *    and the App Tracking Transparency prompt before the click id is sent.
 *    Off by default for mobile apps.
 *  - hosting (day2 runs the app's backend on Supabase) → Contact Info →
 *    Email Address for sign-in and User Content for files, linked to the
 *    user, App Functionality only; Supabase is a processor, so nothing is
 *    "shared" or "tracking".
 * The visitor's IP address and browser are never sent with conversions from
 * mobile apps (field-ingest keeps them for web visits only), so no location
 * data is involved.
 */

export const STORE_PRIVACY_FILENAME = "day2-store-privacy.json";
export const ATT_KEY = "store-privacy:att";
/** The Messages setup ticket (messages/setup.ts SETUP_KEY; not imported to keep this file free of the messages module). */
export const PUSH_KEY = "messages:setup";

export type Store = "ios" | "android";
export const STORE_NAME: Record<Store, string> = { ios: "App Store Connect → App Privacy", android: "Play Console → App content → Data safety" };

export type Practices = {
  fieldChecks: boolean;
  identify: boolean;
  treatments: boolean;
  deviceId: boolean;
  /** Click ids sent back to ad platforms — only after the App Tracking Transparency prompt. */
  adConversions: boolean;
  /** Push notifications from day2 (messages/): an Expo push token per device, linked to the hashed user. Absent in answers confirmed before Messages. */
  push?: boolean;
  /** Money: in-app purchases verified by day2 (purchase history per hashed user). */
  purchases?: boolean;
  /** Money: in-app ads through Google AdMob (its SDK collects device ids, coarse location, ad interactions). */
  ads?: boolean;
  /** Money: the ads may be personalized after the App Tracking Transparency prompt (not for apps where many users may be minors). */
  adTracking?: boolean;
  /** Hosting (src/hosting/): the app's backend runs on Supabase in one region, as day2's subprocessor. Absent when day2 doesn't host it. */
  hosting?: HostingPractice;
};

/** What day2's hosting adds: accounts (sign-in) and files, kept by Supabase in the chosen region. */
export type HostingPractice = { processor: "Supabase"; region: string; place: string; eu: boolean; accounts: boolean; files: boolean };

export type Settings = {
  /** "off" (default): mobile apps send no click ids, so nothing counts as tracking. "with_consent": after the ATT prompt. */
  adConversions: "off" | "with_consent";
  /** The app keeps a fixed device id (startDay2 identity "device") instead of a random one per launch. */
  deviceId: boolean;
};

export type StorePrivacyFile = {
  settings: Settings;
  confirmed: Partial<Record<Store, { version: string; practices: Practices; at: string; by: string | null }>>;
  /** The owner added day2's section to a privacy notice day2 can't see (e.g. hosted elsewhere). */
  notice?: { version: string; at: string; by: string | null };
};

export function loadStorePrivacy(path: string): StorePrivacyFile {
  const empty: StorePrivacyFile = { settings: { adConversions: "off", deviceId: false }, confirmed: {} };
  if (!existsSync(path)) return empty;
  try {
    const p = JSON.parse(readFileSync(path, "utf-8")) as Partial<StorePrivacyFile>;
    return { settings: { ...empty.settings, ...(p.settings ?? {}) }, confirmed: p.confirmed ?? {}, ...(p.notice ? { notice: p.notice } : {}) };
  } catch {
    return empty;
  }
}

export function saveStorePrivacy(path: string, f: StorePrivacyFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`);
  renameSync(tmp, path);
}

const done = (tickets: Ticket[], pred: (key: string) => boolean) => tickets.some((t) => t.source.key && pred(t.source.key) && t.state === "done");

/** What's in the app now: merged day2 work plus the owner's settings. */
export function practicesFrom(tickets: Ticket[], settings: Settings, wiredByHand: { identify: boolean } | null = null, hosting: HostingPractice | null = null): Practices {
  // In the app through day2's install ticket, or wired in by hand (field-work existingIntegration).
  const fieldChecks = done(tickets, (k) => k === INSTALL_KEY) || Boolean(wiredByHand);
  return {
    fieldChecks,
    // The install ticket includes day2.identify; the separate identify ticket covers apps installed before.
    identify: (fieldChecks && !wiredByHand) || Boolean(wiredByHand?.identify) || done(tickets, (k) => k === IDENTIFY_KEY),
    treatments: done(tickets, (k) => k.startsWith("retention:") && k !== IDENTIFY_KEY && !k.startsWith("retention:undo:")),
    deviceId: fieldChecks && settings.deviceId,
    adConversions: fieldChecks && settings.adConversions === "with_consent" && done(tickets, (k) => k === ATT_KEY),
    push: done(tickets, (k) => k === PUSH_KEY),
    // Money (src/money/tickets.ts): the purchase layer and AdMob, once merged (only set when true).
    ...(done(tickets, (k) => k === MONEY_PURCHASES_KEY) ? { purchases: true } : {}),
    ...(done(tickets, (k) => k === MONEY_ADS_KEY || k === MONEY_ADS_ATT_KEY) ? { ads: true } : {}),
    ...(done(tickets, (k) => k === MONEY_ADS_ATT_KEY) ? { adTracking: true } : {}),
    ...(hosting ? { hosting } : {}),
  };
}

// ---------------------------------------------------------------------------
// The answers, per store
// ---------------------------------------------------------------------------

export type AppleRow = { category: string; type: string; purposes: string[]; linked: boolean; tracking: boolean; covers: string };
export type PlayRow = { category: string; type: string; collected: boolean; shared: boolean; purposes: string[]; covers: string };
export type Disclosure = {
  ios: { rows: AppleRow[]; trackingPrompt: boolean };
  android: { rows: PlayRow[]; encryptedInTransit: true };
};

export function disclosure(p: Practices): Disclosure {
  const apple: AppleRow[] = [];
  const play: PlayRow[] = [];
  if (p.fieldChecks) {
    const interaction = ["Analytics", "App Functionality", ...(p.treatments ? ["Product Personalization"] : []), ...(p.adConversions ? ["Developer's Advertising or Marketing"] : [])];
    apple.push(
      { category: "Usage Data", type: "Product Interaction", purposes: interaction, linked: p.identify, tracking: p.adConversions, covers: "screens, taps, sign-ups and first use" },
      { category: "Diagnostics", type: "Crash Data", purposes: ["App Functionality", "Analytics"], linked: false, tracking: false, covers: "crashes and errors" },
      { category: "Diagnostics", type: "Performance Data", purposes: ["App Functionality", "Analytics"], linked: false, tracking: false, covers: "freezes and loading times" },
      { category: "Diagnostics", type: "Other Diagnostic Data", purposes: ["App Functionality", "Analytics"], linked: false, tracking: false, covers: "failed checks and device details" },
    );
    play.push(
      { category: "App activity", type: "App interactions", collected: true, shared: p.adConversions, purposes: ["Analytics", "App functionality", ...(p.treatments ? ["Personalization"] : []), ...(p.adConversions ? ["Advertising or marketing"] : [])], covers: "screens, taps, sign-ups and first use" },
      { category: "App info and performance", type: "Crash logs", collected: true, shared: false, purposes: ["App functionality", "Analytics"], covers: "crashes" },
      { category: "App info and performance", type: "Diagnostics", collected: true, shared: false, purposes: ["App functionality", "Analytics"], covers: "errors, failed checks and device details" },
      { category: "App info and performance", type: "Other app performance data", collected: true, shared: false, purposes: ["App functionality", "Analytics"], covers: "freezes and loading times" },
    );
  }
  if (p.identify) {
    apple.push({ category: "Identifiers", type: "User ID", purposes: ["Analytics", ...(p.treatments ? ["Product Personalization"] : []), ...(p.adConversions ? ["Developer's Advertising or Marketing"] : [])], linked: true, tracking: p.adConversions, covers: "a salted hash of the app's user id" });
    play.push({ category: "Personal info", type: "User IDs", collected: true, shared: p.adConversions, purposes: ["Analytics", ...(p.treatments ? ["Personalization"] : []), ...(p.adConversions ? ["Advertising or marketing"] : [])], covers: "a salted hash of the app's user id" });
  }
  if (p.deviceId) {
    apple.push({ category: "Identifiers", type: "Device ID", purposes: ["Analytics"], linked: p.identify, tracking: false, covers: "a random id kept on the device, not the advertising id" });
    play.push({ category: "Device or other IDs", type: "Device or other IDs", collected: true, shared: false, purposes: ["Analytics"], covers: "a random id kept on the device, not the advertising id" });
  }
  if (p.push) {
    // Push tokens: Apple's "Device ID" (a device-level identifier) and Google's
    // "Device or other IDs" (identifiers that relate to a device or app
    // install). Linked to the user (kept per hashed user); not tracking.
    // Purposes: sending the notifications (App functionality) and lifecycle
    // messages (Apple: Developer's Advertising or Marketing — "sending
    // marketing communications directly to your users"; Google: Developer
    // communications, Advertising or marketing).
    const covers = "the Expo push token, to send notifications";
    const a = apple.find((r) => r.category === "Identifiers" && r.type === "Device ID");
    const applePurposes = ["App Functionality", "Developer's Advertising or Marketing"];
    if (a) Object.assign(a, { purposes: [...new Set([...a.purposes, ...applePurposes])], linked: true, covers: `${a.covers}; ${covers}` });
    else apple.push({ category: "Identifiers", type: "Device ID", purposes: applePurposes, linked: true, tracking: false, covers });
    const g = play.find((r) => r.category === "Device or other IDs");
    const playPurposes = ["App functionality", "Developer communications", "Advertising or marketing"];
    if (g) Object.assign(g, { purposes: [...new Set([...g.purposes, ...playPurposes])], covers: `${g.covers}; ${covers}` });
    else play.push({ category: "Device or other IDs", type: "Device or other IDs", collected: true, shared: false, purposes: playPurposes, covers });
  }
  if (p.adConversions) {
    apple.push({ category: "Usage Data", type: "Advertising Data", purposes: ["Developer's Advertising or Marketing"], linked: true, tracking: true, covers: "which ad brought the user: the ad platform's click id, sent back to that platform" });
  }
  if (p.purchases) {
    merge(apple, { category: "Purchases", type: "Purchase History", purposes: ["App Functionality", "Analytics"], linked: p.identify, tracking: false, covers: "what the user bought, checked with Apple (no payment details)" });
    merge(play, { category: "Financial info", type: "Purchase history", collected: true, shared: false, purposes: ["App functionality", "Analytics"], covers: "what the user bought, checked with Google (no payment details)" });
  }
  if (p.ads) {
    // Google Mobile Ads SDK, per Google's data disclosure guidance for AdMob.
    const t = Boolean(p.adTracking);
    const adP = ["Third-Party Advertising", "Analytics"];
    merge(apple, { category: "Location", type: "Coarse Location", purposes: adP, linked: false, tracking: t, covers: "approximate location from the IP address, used by Google AdMob" });
    merge(apple, { category: "Identifiers", type: "Device ID", purposes: adP, linked: false, tracking: t, covers: t ? "the advertising id (only after the tracking prompt), used by Google AdMob" : "a device id for ads (not the advertising id), used by Google AdMob" });
    merge(apple, { category: "Usage Data", type: "Product Interaction", purposes: adP, linked: false, tracking: t, covers: "ad views and taps, used by Google AdMob" });
    merge(apple, { category: "Usage Data", type: "Advertising Data", purposes: adP, linked: false, tracking: t, covers: "the ads shown, used by Google AdMob" });
    merge(apple, { category: "Diagnostics", type: "Performance Data", purposes: ["Analytics"], linked: false, tracking: false, covers: "ad loading times, used by Google AdMob" });
    const gP = ["Advertising or marketing", "Analytics", "Fraud prevention, security, and compliance"];
    merge(play, { category: "Location", type: "Approximate location", collected: true, shared: true, purposes: gP, covers: "approximate location from the IP address, used by Google AdMob" });
    merge(play, { category: "Device or other IDs", type: "Device or other IDs", collected: true, shared: true, purposes: gP, covers: "the advertising id, used by Google AdMob" });
    merge(play, { category: "App activity", type: "App interactions", collected: true, shared: true, purposes: gP, covers: "ad views and taps, used by Google AdMob" });
    merge(play, { category: "App info and performance", type: "Diagnostics", collected: true, shared: true, purposes: ["Analytics"], covers: "ad loading and errors, used by Google AdMob" });
  }
  if (p.hosting) {
    // The backend day2 hosts: Supabase is a processor (Apple: not "third-party"; Google: service providers aren't "sharing").
    const where = `kept by ${p.hosting.processor} in ${p.hosting.place} for the app`;
    if (p.hosting.accounts) {
      merge(apple, { category: "Contact Info", type: "Email Address", purposes: ["App Functionality"], linked: true, tracking: false, covers: `the email address for signing in, ${where}` });
      merge(play, { category: "Personal info", type: "Email address", collected: true, shared: false, purposes: ["App functionality", "Account management"], covers: `the email address for signing in, ${where}` });
    }
    if (p.hosting.files) {
      merge(apple, { category: "User Content", type: "Other User Content", purposes: ["App Functionality"], linked: true, tracking: false, covers: `files people add in the app, ${where}` });
      merge(play, { category: "Files and docs", type: "Files and docs", collected: true, shared: false, purposes: ["App functionality"], covers: `files people add in the app, ${where}` });
    }
  }
  return { ios: { rows: apple, trackingPrompt: p.adConversions || Boolean(p.ads && p.adTracking) }, android: { rows: play, encryptedInTransit: true } };
}

/** Adds a row, or folds it into the row for the same data type (purposes joined, linked/tracking/shared if either is). */
function merge<R extends AppleRow | PlayRow>(rows: R[], row: R): void {
  const i = rows.findIndex((r) => r.category === row.category && r.type === row.type);
  if (i === -1) {
    rows.push(row);
    return;
  }
  const o = rows[i]!;
  const purposes = [...o.purposes, ...row.purposes.filter((x) => !o.purposes.includes(x))];
  if ("linked" in o && "linked" in row) rows[i] = { ...o, purposes, linked: o.linked || row.linked, tracking: o.tracking || row.tracking, covers: `${o.covers}; ${row.covers}` } as R;
  else rows[i] = { ...o, purposes, shared: (o as PlayRow).shared || (row as PlayRow).shared, covers: `${o.covers}; ${row.covers}` } as R;
}

/** Changes when the answers change — not when wording elsewhere does. */
export function versionOf(d: Disclosure[Store]): string {
  const rows = (d.rows as Array<AppleRow | PlayRow>).map(({ covers: _c, ...r }) => r);
  return createHash("sha256").update(JSON.stringify({ ...d, rows })).digest("hex").slice(0, 16);
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Pure. What to change in each store, from what was last confirmed (null: never) to now — as steps a person follows. */
export function changesFor(store: Store, before: Practices | null, now: Practices): string[] {
  const was = before ? disclosure(before)[store] : { rows: [] as Array<AppleRow | PlayRow> };
  const is = disclosure(now)[store];
  const steps: string[] = [];
  const key = (r: AppleRow | PlayRow) => `${r.category} → ${r.type}`;
  for (const r of is.rows as Array<AppleRow | PlayRow>) {
    const old = (was.rows as Array<AppleRow | PlayRow>).find((x) => key(x) === key(r));
    if (store === "ios") {
      const a = r as AppleRow;
      const o = old as AppleRow | undefined;
      if (!o) steps.push(`Add ${key(a)} (${a.covers}). Purposes: ${list(a.purposes)}. Linked to the user: ${a.linked ? "Yes" : "No"}. Used to track you: ${a.tracking ? "Yes" : "No"}.`);
      else {
        const added = a.purposes.filter((x) => !o.purposes.includes(x));
        if (added.length) steps.push(`${key(a)}: add the purpose${added.length > 1 ? "s" : ""} ${list(added)}.`);
        if (a.linked !== o.linked) steps.push(`${key(a)}: Linked to the user → ${a.linked ? "Yes" : "No"}.`);
        if (a.tracking !== o.tracking) steps.push(`${key(a)}: Used to track you → ${a.tracking ? "Yes" : "No"}.`);
      }
    } else {
      const a = r as PlayRow;
      const o = old as PlayRow | undefined;
      if (!o) steps.push(`Add ${key(a)} (${a.covers}): collected${a.shared ? " and shared" : ", not shared"}. Purposes: ${list(a.purposes)}.`);
      else {
        const added = a.purposes.filter((x) => !o.purposes.includes(x));
        if (added.length) steps.push(`${key(a)}: add the purpose${added.length > 1 ? "s" : ""} ${list(added)}.`);
        if (a.shared !== o.shared) steps.push(`${key(a)}: ${a.shared ? "mark it as shared (with the ad platforms)" : "no longer shared"}.`);
      }
    }
  }
  for (const o of was.rows as Array<AppleRow | PlayRow>) if (!(is.rows as Array<AppleRow | PlayRow>).some((x) => key(x) === key(o))) steps.push(`${key(o)}: no longer needed for day2 (keep it if the app collects it for other reasons).`);
  if (store === "ios") {
    const prompt = (is as Disclosure["ios"]).trackingPrompt;
    const had = before ? disclosure(before).ios.trackingPrompt : false;
    if (prompt && !had) steps.push('The App Store page will show "Data Used to Track You". The app asks for tracking permission (App Tracking Transparency) and sends the click id only after a yes.');
  } else if (!before && is.rows.length) {
    steps.push("Data encrypted in transit: Yes (day2 sends over HTTPS).");
  }
  return steps;
}

export type StoreStatus = {
  store: Store;
  where: string;
  upToDate: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** What to change since the last confirmation. Empty when up to date. */
  steps: string[];
  version: string;
};

export function storeStatus(file: StorePrivacyFile, now: Practices): StoreStatus[] {
  const d = disclosure(now);
  return (["ios", "android"] as Store[]).map((store) => {
    const version = versionOf(d[store]);
    const c = file.confirmed[store];
    const upToDate = d[store].rows.length === 0 ? !c || c.version === version : c?.version === version;
    return { store, where: STORE_NAME[store], upToDate, confirmedAt: c?.at ?? null, confirmedBy: c?.by ?? null, steps: upToDate ? [] : changesFor(store, c?.practices ?? null, now), version };
  });
}

/** The code change that makes ad conversions allowed on iOS: ask first (App Tracking Transparency). */
export function attTicket(): NewTicketInput {
  return {
    title: "Ask for tracking permission before sending ad click ids",
    type: "feature",
    description: [
      "The owner turned on ad conversions for this app: day2 tells the ad platform which of its ads brought a sign-up, so it finds more people like them. Under Apple's rules that's tracking, so the app has to ask first.",
      "",
      "1. iOS: show Apple's App Tracking Transparency prompt (expo-tracking-transparency, or react-native-tracking-transparency without Expo) at a calm moment — after sign-up, never on first launch. Add NSUserTrackingUsageDescription to Info.plist (app.json → ios.infoPlist with Expo), e.g. \"Lets us see which of our ads brought you here, so we show them to people like you.\"",
      '2. Start day2 with adClickIds: "after_consent" (startDay2 options). Then, only when the prompt returns "granted", call day2.allowAdTracking().',
      "3. Android has no such prompt; call day2.allowAdTracking() once the user accepts ad measurement in the app's own consent (or not at all if the app has none).",
      "4. Add a test: allowAdTracking is not called when permission is denied.",
      "",
      "Before the release with this change, update the store privacy answers (day2 lists the exact changes on the app's Privacy page).",
    ].join("\n"),
    doneWhen: ['startDay2 runs with adClickIds: "after_consent"', 'iOS shows the tracking prompt and calls day2.allowAdTracking() only after "granted"', "NSUserTrackingUsageDescription is set", "A test covers denied permission", "The app builds and its tests pass"],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: ATT_KEY },
    actor: "day2",
    createdNote: "The owner turned on ad conversions for the mobile app.",
  };
}
