import { playPermissions } from "./google-cloud";
import { robotsUrl } from "./expo";
import type { Check, ConnectFile } from "./state";

/**
 * "Connect your stores": one page per app with every connection day2 needs,
 * where each stands, what it unlocks, and the one thing to do next. Pure —
 * the route gathers the facts (connect/routes.ts).
 *
 * Steps only show when they apply: Apple only with an iOS bundle id, Google
 * only with an Android package, the In-App Purchase key, Paid Apps agreement,
 * server notifications and Pub/Sub only when Money plans paid products, the
 * Facebook Page only when the app runs ads on Meta.
 */

export type Feature = "Releases" | "Store" | "Numbers" | "Money" | "Messages" | "Ads";
export type StepState = "done" | "todo" | "checking" | "broken";

export type StepAction =
  | { kind: "google_signin"; label: string }
  | { kind: "google_check"; label: string }
  | { kind: "google_developer"; label: string }
  | { kind: "fcm_upload"; label: string }
  | { kind: "bucket"; label: string }
  | { kind: "expo_token"; label: string }
  | { kind: "expo_project"; label: string }
  | { kind: "asc_key"; label: string }
  | { kind: "iap_key"; label: string }
  | { kind: "apple_notifications"; label: string }
  | { kind: "vendor"; label: string }
  | { kind: "analytics"; label: string }
  | { kind: "confirm"; label: string; confirm: "membership" | "paid_apps" }
  | { kind: "open"; label: string; to: string };

export type HubStep = {
  id: string;
  title: string;
  /** Why day2 needs it, one line. */
  why: string;
  state: StepState;
  /** What went wrong, or what day2 is waiting for. */
  note: string | null;
  /** Exact click path, in words. */
  how: string[];
  links: Array<{ label: string; url: string }>;
  copy: Array<{ label: string; value: string }>;
  permissions: string[];
  action: StepAction | null;
};

export type HubConnection = {
  id: "google" | "expo" | "apple" | "meta";
  title: string;
  state: "connected" | "needs_you" | "checking" | "broken";
  summary: string;
  unlocks: Feature[];
  steps: HubStep[];
};

export type HubInput = {
  appId: string;
  appName: string;
  mobile: boolean;
  ids: { bundleId: string | null; packageName: string | null };
  publicUrl: string;
  file: ConnectFile;
  running: string | null;
  googleAvailable: boolean;
  release: { expo: string | null; asc: string | null; play: string | null };
  money: { paidProducts: boolean; iap: string | null; rtdn: string | null; notificationsOk: boolean; paidAppsConfirmed: boolean };
  numbers: { vendor: string | null; bucket: string | null; analyticsRequested: boolean };
  expoProjectInRepo: string | null;
  meta: { wanted: boolean; page: string | null };
};

const step = (s: Partial<HubStep> & Pick<HubStep, "id" | "title" | "why" | "state">): HubStep => ({ note: null, how: [], links: [], copy: [], permissions: [], action: null, ...s });
const fromCheck = (c: Check | null | undefined, has: boolean): StepState => (c?.ok ? "done" : has && c && !c.ok ? "broken" : "todo");

function rollup(steps: HubStep[]): HubConnection["state"] {
  if (steps.every((s) => s.state === "done")) return "connected";
  if (steps.some((s) => s.state === "broken")) return "broken";
  if (steps.some((s) => s.state === "checking") && !steps.some((s) => s.state === "todo")) return "checking";
  return "needs_you";
}

function summary(c: HubConnection["state"], steps: HubStep[]): string {
  const left = steps.filter((s) => s.state !== "done").length;
  if (c === "connected") return "Connected.";
  if (c === "broken") return steps.find((s) => s.state === "broken")?.note ?? "Something stopped working.";
  if (c === "checking") return "day2 is checking…";
  return `${left} step${left === 1 ? "" : "s"} left.`;
}

/** Pure. The whole page. */
export function hubView(i: HubInput) {
  const connections: HubConnection[] = [];
  if (!i.mobile) return { applies: false, connections, left: 0, googleAvailable: i.googleAvailable };
  const g = i.file.google;
  const run = (id: string) => i.running !== null && i.running === id;
  const runningGoogle = i.running !== null && !["expo", "apple"].includes(i.running);

  if (i.ids.packageName) {
    const sa = g.serviceAccount ?? (i.release.play ? i.release.play.split(" ")[0]! : null);
    const consoleUsers = g.developerId ? `https://play.google.com/console/developers/${g.developerId}/users-and-permissions` : "https://play.google.com/console/users-and-permissions";
    const steps: HubStep[] = [
      step({
        id: "google_signin",
        title: "Sign in with Google",
        why: "day2 sets up your Google Cloud project, the APIs and a service account for this app — no keys to copy.",
        state: runningGoogle ? "checking" : i.release.play ? "done" : g.problem ? "broken" : "todo",
        note: runningGoogle ? "day2 is setting up Google Cloud…" : i.release.play ? (g.projectId ? `Project ${g.projectId} · ${sa}` : i.release.play) : g.problem,
        how: ["Click Sign in with Google and pick the Google account that owns your Play Console.", "Tick every box on Google's page — day2 only uses them for this app.", "Choose a Google Cloud project (or let day2 make one). That's it."],
        action: i.googleAvailable ? { kind: "google_signin", label: i.release.play ? "Run setup again" : "Sign in with Google" } : null,
        ...(i.googleAvailable ? {} : { note: i.release.play ? i.release.play : "This day2 server can't use Google sign-in yet — its operator still has to set it up. Until then you can paste a service account key on Releases." }),
      }),
      step({
        id: "play_access",
        title: "Give day2 access in Play Console",
        why: "Google lets only you add users to your Play Console. One invite, then day2 releases, reads numbers and replies to reviews.",
        state: g.access?.ok ? "done" : !i.release.play ? "todo" : g.invite?.ok ? "checking" : g.access && !g.access.ok ? "broken" : "todo",
        note: g.access?.ok ? g.access.note : g.invite?.ok ? `${g.invite.note} Click Check when you're ready.` : (g.access?.note ?? g.invite?.note ?? null),
        how: [
          "Open Play Console → Users and permissions → Invite new users.",
          "Paste the email below.",
          "Account permissions: tick “View app information and download bulk reports (read-only)”.",
          `App permissions → Add app → ${i.appName}: tick the permissions listed below, Apply.`,
          "Click Invite user, then come back and click Check.",
        ],
        links: [{ label: "Open Users and permissions", url: consoleUsers }],
        copy: sa ? [{ label: "Service account email", value: sa }] : [],
        permissions: playPermissions({ paidProducts: i.money.paidProducts }).names,
        action: i.release.play ? { kind: "google_check", label: "Check" } : null,
      }),
      step({
        id: "play_developer",
        title: "Your Play Console address",
        why: "With it day2 can invite itself and find your reports bucket. Paste it once.",
        state: g.developerId ? "done" : "todo",
        note: g.developerId ? `Developer account ${g.developerId}` : null,
        how: ["Open the Play Console and copy the address from the browser bar (it contains /developers/ and a long number)."],
        links: [{ label: "Open the Play Console", url: "https://play.google.com/console" }],
        action: { kind: "google_developer", label: "Save" },
      }),
      step({
        id: "play_bucket",
        title: "Play reports (installs)",
        why: "Google keeps install numbers in a Cloud Storage bucket only your account knows the name of.",
        state: i.numbers.bucket ? "done" : "todo",
        note: i.numbers.bucket ? `gs://${i.numbers.bucket}` : (g.bucket?.note ?? "day2 finds it once you've added your Play Console address."),
        how: ["Play Console → Download reports → Statistics → Copy Cloud Storage URI (gs://pubsite_prod_…)."],
        links: [{ label: "Open Download reports", url: g.developerId ? `https://play.google.com/console/developers/${g.developerId}/download-reports/statistics` : "https://play.google.com/console" }],
        action: { kind: "bucket", label: "Save" },
      }),
      step({
        id: "android_push",
        title: "Android push (FCM)",
        why: "Push notifications on Android go through Firebase; EAS needs its key once.",
        state: g.fcm?.ok ? "done" : run("fcm") ? "checking" : g.firebase && !g.firebase.ok ? "broken" : "todo",
        note: g.fcm?.ok ? `${g.fcm.note}${g.googleServicesTicket ? ` google-services.json goes in with ${g.googleServicesTicket}.` : ""}` : (g.fcm?.note ?? g.firebase?.note ?? (i.release.play ? null : "Comes with Sign in with Google.")),
        action: i.release.play && i.release.expo ? { kind: "fcm_upload", label: g.fcm ? "Try again" : "Upload the key to EAS" } : null,
      }),
    ];
    if (i.money.paidProducts)
      steps.push(
        step({
          id: "play_notifications",
          title: "Purchase notifications from Google Play",
          why: "Google Play tells day2 about every purchase, renewal and refund through Pub/Sub.",
          state: i.money.rtdn ? "done" : g.pubsub && !g.pubsub.ok ? "broken" : "todo",
          note: i.money.rtdn ?? g.pubsub?.note ?? "Comes with Sign in with Google.",
          how: g.pubsub?.topic
            ? ["Play Console → your app → Monetize with Play → Monetization setup.", "Real-time developer notifications: turn on, paste the topic below, Save, then Send test notification."]
            : [],
          copy: g.pubsub?.topic ? [{ label: "Topic name", value: g.pubsub.topic }] : [],
          links: g.pubsub?.topic ? [{ label: "Open the Play Console", url: "https://play.google.com/console" }] : [],
          action: { kind: "open", label: "Open Money", to: `/apps/${i.appId}/money` },
        }),
      );
    const state = rollup(steps);
    connections.push({ id: "google", title: "Google Play", state, summary: summary(state, steps), unlocks: ["Releases", "Store", "Numbers", ...(i.money.paidProducts ? (["Money"] as Feature[]) : []), "Messages"], steps });
  }

  {
    const projectId = i.expoProjectInRepo ?? i.file.expo.projectId;
    const steps: HubStep[] = [
      step({
        id: "expo_token",
        title: "Expo robot token",
        why: "EAS builds the app and sends updates and push. Expo has no “Sign in with Expo” for other services, so it's one paste.",
        state: run("expo") ? "checking" : i.release.expo ? fromCheck(i.file.expo.check, true) === "broken" ? "broken" : "done" : "todo",
        note: i.release.expo ? (i.file.expo.check && !i.file.expo.check.ok ? i.file.expo.check.note : i.release.expo) : null,
        how: [
          "Open your Expo account's Robot users page.",
          "Click Create robot user. Name: day2. Role: Developer.",
          "Click Create access token on the new robot, copy it (Expo shows it once) and paste it here.",
        ],
        links: [{ label: "Open Robot users", url: robotsUrl(i.file.expo.account) }],
        action: { kind: "expo_token", label: i.release.expo ? "Replace" : "Connect" },
      }),
      step({
        id: "expo_project",
        title: "EAS project",
        why: "Updates, builds and push keys belong to the app's EAS project.",
        state: projectId ? "done" : i.file.expo.check && !i.file.expo.check.ok && i.release.expo ? "broken" : "todo",
        note: projectId ? `${i.file.expo.projectFullName ?? "Project"} · ${projectId}${!i.expoProjectInRepo && i.file.expo.linkTicket ? ` · linked in the app with ${i.file.expo.linkTicket}` : ""}` : i.release.expo ? "day2 finds or creates it." : "Comes with the robot token.",
        action: i.release.expo && !projectId ? { kind: "expo_project", label: "Find or create it" } : null,
      }),
    ];
    const state = rollup(steps);
    connections.push({ id: "expo", title: "Expo (EAS)", state, summary: summary(state, steps), unlocks: ["Releases", "Messages"], steps });
  }

  if (i.ids.bundleId) {
    const a = i.file.apple;
    const keys = "https://appstoreconnect.apple.com/access/integrations/api";
    const steps: HubStep[] = [
      step({
        id: "apple_membership",
        title: "Apple Developer Program",
        why: "Apps are published under your own Apple developer account (Apple's rule 4.2.6), and it has to be active.",
        state: i.release.asc || a.confirmed.membership ? "done" : "todo",
        note: i.release.asc ? "Active — App Store Connect answers day2's key." : a.confirmed.membership ? `Confirmed ${a.confirmed.membership.at.slice(0, 10)}` : null,
        how: ["Open Apple Developer → Account → Membership details. It should say “Active”. If it isn't, renew or enroll there."],
        links: [{ label: "Open Membership", url: "https://developer.apple.com/account#MembershipDetailsCard" }],
        action: i.release.asc ? null : { kind: "confirm", label: "It's active", confirm: "membership" },
      }),
      step({
        id: "apple_key",
        title: "App Store Connect API key",
        why: "Lets day2 submit versions, fill in the store listing and read numbers. Apple has no way to create it for you.",
        state: i.release.asc ? (a.checks.asc_key && !a.checks.asc_key.ok ? "broken" : "done") : "todo",
        note: i.release.asc ? (a.checks.asc_key && !a.checks.asc_key.ok ? a.checks.asc_key.note : i.release.asc) : null,
        how: [
          "App Store Connect → Users and Access → Integrations → App Store Connect API. (First time: the Account Holder clicks Request Access.)",
          "Under Team Keys click +. Name: day2. Access: App Manager. Generate.",
          "Download the key (AuthKey_….p8 — Apple allows it once) and drop it here. day2 reads the Key ID from the file name.",
          "Copy the Issuer ID from above the list of keys.",
        ],
        links: [{ label: "Open Integrations", url: keys }],
        action: { kind: "asc_key", label: i.release.asc ? "Replace" : "Add the key" },
      }),
    ];
    if (i.money.paidProducts) {
      steps.push(
        step({
          id: "apple_paid_apps",
          title: "Paid Apps agreement",
          why: "Apple pays you, and lets purchases be tested, only once it's active.",
          state: i.money.paidAppsConfirmed ? "done" : "todo",
          note: i.money.paidAppsConfirmed ? "Confirmed." : "Apple has no API to check this — confirm it when Apple shows “Active”.",
          how: ["App Store Connect → Business (Agreements, Tax, and Banking), signed in as the Account Holder.", "Paid Apps → View and Agree to Terms; add the bank account and tax forms.", "When it says Active, confirm here."],
          links: [{ label: "Open Business", url: "https://appstoreconnect.apple.com/business" }],
          action: i.money.paidAppsConfirmed ? null : { kind: "confirm", label: "It's active", confirm: "paid_apps" },
        }),
        step({
          id: "apple_iap_key",
          title: "In-App Purchase key",
          why: "A separate key that lets day2 check every purchase with Apple.",
          state: i.money.iap ? "done" : "todo",
          note: i.money.iap,
          how: ["App Store Connect → Users and Access → Integrations → In-App Purchase.", "Generate In-App Purchase Key, name it day2.", "Download SubscriptionKey_….p8 (once) and drop it here with the Issuer ID."],
          links: [{ label: "Open Integrations", url: keys }],
          action: { kind: "iap_key", label: i.money.iap ? "Replace" : "Add the key" },
        }),
        step({
          id: "apple_notifications",
          title: "Purchase notifications from Apple",
          why: "Apple tells day2 about renewals, refunds and cancellations.",
          state: i.money.notificationsOk ? "done" : run("apple") ? "checking" : a.notificationsUrlSet ? "checking" : a.checks.notifications && !a.checks.notifications.ok ? "broken" : "todo",
          note: i.money.notificationsOk ? "Apple's notifications arrive." : a.notificationsUrlSet ? "The address is set. Send a test notification from the Money page to finish." : (a.checks.notifications?.note ?? (i.release.asc ? "day2 sets the address for you." : "Add the App Store Connect key first.")),
          how: a.checks.notifications && !a.checks.notifications.ok ? ["App Store Connect → your app → App Information → App Store Server Notifications.", "Production and Sandbox Server URL: paste the address below, Version 2, Save."] : [],
          copy: [{ label: "Notification URL", value: `${i.publicUrl}/api/store-notify/apple/${i.appId}` }],
          action: i.release.asc && !a.notificationsUrlSet ? { kind: "apple_notifications", label: "Set it for me" } : a.notificationsUrlSet && !i.money.notificationsOk ? { kind: "open", label: "Send a test from Money", to: `/apps/${i.appId}/money` } : null,
        }),
      );
    }
    steps.push(
      step({
        id: "apple_vendor",
        title: "Vendor number",
        why: "Apple's sales reports need it, and Apple's API has no way to look it up.",
        state: i.numbers.vendor ? (a.checks.vendor && !a.checks.vendor.ok ? "broken" : "done") : "todo",
        note: i.numbers.vendor ? (a.checks.vendor?.note ?? `Vendor ${i.numbers.vendor}`) : null,
        how: ["App Store Connect → Payments and Financial Reports. The vendor number is the number at the top left, under your name.", "Paste it here — day2 checks it with Apple right away."],
        links: [{ label: "Open Payments and Financial Reports", url: "https://appstoreconnect.apple.com/itc/payments_and_financial_reports" }],
        action: { kind: "vendor", label: i.numbers.vendor ? "Change" : "Save" },
      }),
      step({
        id: "apple_analytics",
        title: "App Analytics reports",
        why: "Impressions, page views and sessions come from reports only an Admin key can switch on, once.",
        state: i.numbers.analyticsRequested || a.checks.analytics?.ok ? "done" : "todo",
        note: i.numbers.analyticsRequested || a.checks.analytics?.ok ? (a.checks.analytics?.note ?? "Apple is preparing the reports.") : (a.checks.analytics?.note ?? (i.release.asc ? "Click Check: day2 tries with your key first." : "Add the App Store Connect key first.")),
        how: a.checks.analytics && !a.checks.analytics.ok ? ["Create one more key with Access: Admin (Integrations → Team Keys → +).", "Drop it here: day2 uses it once to start the reports and doesn't keep it.", "Then revoke that key in App Store Connect."] : [],
        links: [{ label: "Open Integrations", url: keys }],
        action: i.release.asc ? { kind: "analytics", label: "Check" } : null,
      }),
    );
    const state = rollup(steps);
    connections.push({ id: "apple", title: "Apple App Store", state, summary: summary(state, steps), unlocks: ["Releases", "Store", "Numbers", ...(i.money.paidProducts ? (["Money"] as Feature[]) : [])], steps });
  }

  if (i.meta.wanted) {
    const steps = [
      step({
        id: "meta_page",
        title: "Facebook Page for ads",
        why: "Meta shows every ad under a Facebook Page (and its Instagram account).",
        state: i.meta.page ? "done" : "todo",
        note: i.meta.page ? `Page ${i.meta.page}` : null,
        how: ["On Ads, click Connect next to Meta, sign in with Facebook and pick the Page (and Instagram account) for this app."],
        action: { kind: "open", label: "Pick the Page", to: `/apps/${i.appId}/growth/ads` },
      }),
    ];
    const state = rollup(steps);
    connections.push({ id: "meta", title: "Meta (ads)", state, summary: summary(state, steps), unlocks: ["Ads"], steps });
  }

  const left = connections.flatMap((c) => c.steps).filter((s) => s.state === "todo" || s.state === "broken").length;
  return { applies: true, connections, left, googleAvailable: i.googleAvailable };
}

export type HubView = ReturnType<typeof hubView>;
