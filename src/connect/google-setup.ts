import type { PlayCredential } from "../mobile-release/credentials";
import { parseCredential } from "../mobile-release/credentials";
import { setupPubSub } from "../money/google-play";
import { bucketCandidates, cloudProblem, playPermissions, projectIdFor, type Cloud, type ServiceAccountKeyJson } from "./google-cloud";
import { ExpoApiError, type ExpoApi } from "./expo";
import { check, scrub, type ConnectFile } from "./state";

/**
 * Everything on the Google side after the owner's one consent, in order:
 *
 *  1. the Google Cloud project for the app (picked or created);
 *  2. the APIs: Android Publisher, Play Developer Reporting, Pub/Sub,
 *     Firebase and FCM (Service Usage);
 *  3. a service account "day2-…" and a JSON key, kept where Releases keeps
 *     the Play service account (release_credentials, encrypted);
 *  4. Android push: FCM role for the service account, Firebase on the
 *     project, the Android app in Firebase (google-services.json → a
 *     ticket), and the key uploaded to EAS as the FCM V1 key when Expo is
 *     connected;
 *  5. Play real-time notifications: a Pub/Sub topic Google Play may
 *     publish to, pushed to day2's /api/store-notify/google/<app>;
 *  6. with the Play Console developer id: the service account invited in
 *     Play Console (users + grants API) and the reports bucket found.
 *
 * 1–3 are needed for the rest; 4–6 each record their own result, so one
 * refusal (an organization policy, a missing permission) leaves a precise
 * guided step instead of stopping everything. Pure orchestration over
 * injected clients — tests use fakes (connect/connect.test.ts).
 */

export type SetupInput = {
  appId: string;
  appName: string;
  packageName: string | null;
  /** Existing project id, or null to create one. */
  projectId: string | null;
  developerId: string | null;
  publicUrl: string;
  /** Money plans paid products (RTDN wanted). */
  wantsRtdn: boolean;
  /** The app has a Play service account already (from this project): reuse it, don't mint another key. */
  existingPlay: PlayCredential | null;
  expo: { api: ExpoApi; accountId: string; projectId: string; projectFullName: string } | null;
  googleServicesInRepo: boolean;
  randomSuffix: string;
};

export type SetupDeps = {
  cloud: Cloud;
  savePlay: (cred: PlayCredential, label: string) => Promise<void>;
  saveRtdn: (o: { pushServiceAccount: string; audience: string }, label: string) => Promise<void>;
  saveBucket: (bucket: string) => Promise<void>;
  /** Opens (or finds) the "add google-services.json" ticket; returns its id. */
  googleServicesTicket: (json: string) => Promise<string | null>;
  /** HEAD-like probe of a reports bucket with the owner's token: true when it exists and they can read it. */
  probeBucket: (bucket: string) => Promise<boolean>;
  progress: (step: string) => void;
  now?: () => Date;
};

export type SetupResult = { file: ConnectFile["google"]; ok: boolean };

export async function runGoogleSetup(prev: ConnectFile["google"], i: SetupInput, d: SetupDeps): Promise<SetupResult> {
  const now = () => (d.now ? d.now() : new Date());
  const g: ConnectFile["google"] = { ...prev, problem: null };
  const stop = (problem: string): SetupResult => ({ file: { ...g, problem: scrub(problem) }, ok: false });

  // 1. Project
  d.progress("project");
  let projectId = i.projectId;
  if (!projectId) {
    projectId = projectIdFor(i.appName, i.randomSuffix);
    try {
      await d.cloud.createProject(projectId, `${i.appName} (day2)`.slice(0, 30));
    } catch (err) {
      return stop(cloudProblem(err, "create a project"));
    }
  }
  g.projectId = projectId;

  // 2. APIs
  d.progress("apis");
  try {
    await d.cloud.enableApis(projectId);
    g.apis = check(true, "Android Publisher, Play Developer Reporting, Pub/Sub, Firebase and Cloud Messaging are on.", now());
  } catch (err) {
    g.apis = check(false, cloudProblem(err, "turn on the APIs"), now());
    return stop(g.apis.note!);
  }

  // 3. Service account + key
  d.progress("service_account");
  const accountId = `day2-${i.appId.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 30).replace(/-$/, "").padEnd(6, "0");
  let email: string;
  try {
    email = await d.cloud.serviceAccount(projectId, accountId, `day2 for ${i.appName}`.slice(0, 100));
  } catch (err) {
    return stop(cloudProblem(err, "create the service account"));
  }
  g.serviceAccount = email;
  let play: PlayCredential;
  let keyJson: ServiceAccountKeyJson | null = null;
  if (i.existingPlay && i.existingPlay.clientEmail === email) {
    play = i.existingPlay;
    g.key = check(true, "The service account's key is already with day2.", now());
  } else {
    try {
      keyJson = await d.cloud.createKey(projectId, email);
      const parsed = parseCredential("play", { json: JSON.stringify(keyJson) });
      play = parsed.value as PlayCredential;
      await d.savePlay(play, `${email} · set up by day2`);
      g.key = check(true, "day2 keeps the key encrypted. It's never shown again.", now());
    } catch (err) {
      g.key = check(false, cloudProblem(err, "create a key for the service account"), now());
      return stop(g.key.note!);
    }
  }

  // 4. Android push (FCM)
  if (i.packageName) {
    d.progress("fcm");
    try {
      await d.cloud.grantProjectRole(projectId, "roles/firebasecloudmessaging.admin", `serviceAccount:${email}`);
      await d.cloud.addFirebase(projectId);
      const fb = await d.cloud.androidApp(projectId, i.packageName, i.appName);
      g.firebase = { ...check(true, "Firebase knows the Android app.", now()), appId: fb.appId };
      if (!i.googleServicesInRepo && fb.googleServicesJson) g.googleServicesTicket = (await d.googleServicesTicket(fb.googleServicesJson)) ?? g.googleServicesTicket;
    } catch (err) {
      g.firebase = { ...check(false, cloudProblem(err, "set up Firebase for Android push"), now()), appId: g.firebase?.appId ?? null };
    }
    if (g.firebase?.ok) {
      if (!i.expo) g.fcm = check(false, "Waiting for Expo: connect it below and day2 uploads the push key to EAS.", now());
      else {
        try {
          const jsonKey = keyJson ?? { type: "service_account", project_id: projectId, client_email: play.clientEmail, private_key: play.privateKey };
          await i.expo.api.setFcmV1Key({ accountId: i.expo.accountId, projectFullName: i.expo.projectFullName, projectId: i.expo.projectId, packageName: i.packageName, jsonKey });
          g.fcm = check(true, "EAS has the FCM V1 key: Android push works with the next build.", now());
        } catch (err) {
          g.fcm = check(false, fcmProblem(err), now());
        }
      }
    }
  }

  // 5. Play real-time notifications (Money)
  if (i.wantsRtdn && i.packageName) {
    d.progress("pubsub");
    const endpoint = `${i.publicUrl}/api/store-notify/google/${i.appId}`;
    if (!endpoint.startsWith("https://")) g.pubsub = { ...check(false, "day2 needs its public https address (DAY2_PUBLIC_URL) before Google can push to it.", now()), topic: null };
    else
      try {
        const r = await setupPubSub(d.cloud.client, { project: projectId, topicName: `day2-play-${i.appId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 200), endpoint, pushAs: email });
        await d.saveRtdn({ pushServiceAccount: email, audience: endpoint }, `Pub/Sub ${r.topic}`);
        g.pubsub = { ...check(true, `Topic ${r.topic} pushes to day2.`, now()), topic: r.topic };
      } catch (err) {
        g.pubsub = { ...check(false, cloudProblem(err, "set up Pub/Sub"), now()), topic: null };
      }
  }

  // 6. Play Console invite and reports bucket (need the developer id)
  if (i.developerId && i.packageName) {
    g.developerId = i.developerId;
    d.progress("play_invite");
    try {
      await d.cloud.invitePlayUser(i.developerId, email, i.packageName, playPermissions({ paidProducts: i.wantsRtdn }));
      g.invite = check(true, "Invited in Play Console. Google can take a few minutes (rarely up to a day) to apply it.", now());
    } catch (err) {
      g.invite = check(false, playInviteProblem(err, email), now());
    }
    d.progress("bucket");
    for (const b of bucketCandidates(i.developerId)) {
      const found = await d.probeBucket(b).catch(() => false);
      if (found) {
        await d.saveBucket(b);
        g.bucket = check(true, `Found gs://${b}.`, now());
        break;
      }
    }
    if (!g.bucket?.ok) g.bucket = check(false, "day2 couldn't find the reports bucket. Copy its address once from Play Console → Download reports.", now());
  }

  g.at = now().toISOString();
  return { file: g, ok: true };
}

/** A fixed message and Expo's safe error code — never Expo's own text, which can echo the key. */
export function fcmProblem(err: unknown): string {
  const code = err instanceof ExpoApiError ? err.code : "network";
  return `EAS didn't take the push key. Expo's error code: ${code}. Check that the robot user has the Developer role on the app's Expo account, then try again.`;
}

function playInviteProblem(err: unknown, email: string): string {
  const m = (err as Error)?.message ?? "";
  if (/403|permission|not allowed/i.test(m)) return `Google didn't let your account invite users in this Play Console (you need "Admin" there). Invite ${email} by hand — the steps are below.`;
  if (/404/.test(m)) return "Google Play doesn't know that developer account. Check the Play Console address and try again, or invite by hand.";
  return `Google Play didn't take the invite (${m.replace(/^Google: /, "").slice(0, 160)}). Invite by hand — the steps are below.`;
}
