import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { storeIdsFromRepo } from "../ads/app-links";
import { authConfig } from "../auth";
import { createTicket, rankBacklog, withBacklog, type NewTicketInput } from "../backlog";
import { backlogFile } from "../backlog-work";
import { appKind } from "../field-work";
import { checkAsc, checkPlay } from "../mobile-release/check-access";
import { parseCredential, type AscCredential, type PlayCredential } from "../mobile-release/credentials";
import { checkIap } from "../money/connections";
import { parseMoneyCredential, type IapCredential } from "../money/credentials";
import { currentStrategy } from "../money/types";
import { loadAppMoney, moneyCredentials, saveAppMoney, setConnection } from "../money/wiring";
import { AppleReportError, createAppleReports } from "../numbers/apple";
import { bucketName, createPlayReports, googleReason } from "../numbers/google";
import { parseVendorNumber } from "../numbers/routes";
import { numbersStoreFor } from "../numbers/store";
import { clearNumbersCache } from "../numbers/view";
import { adConnections, adIdentities, googleSessions, platformIdentities, releaseCredentials, type Tenant } from "../tenant";
import { ensureAnalytics, keyIdFromFilename, setNotificationsUrl } from "./apple";
import { createExpoApi, expoConfig, ExpoApiError, type ExpoApi } from "./expo";
import { bucketCandidates, createCloud, playDeveloperId } from "./google-cloud";
import { exchangeStoresCode, revokeStoresToken, STORES_CALLBACK_PATH, STORES_SCOPES, storesAuthorizeUrl, storesOAuthClient, storesRedirectUri } from "./google-oauth";
import { fcmProblem, runGoogleSetup } from "./google-setup";
import { hubView } from "./hub";
import { check, loadAppConnect, pkceChallenge, scrub, updateAppConnect } from "./state";

/**
 * The "Connect your stores" API (registered from api-server.ts with one line):
 *
 *  GET  /api/apps/:id/connect                          the hub (no secrets, ever)
 *  POST /api/apps/:id/connect/google/start             → Google's consent page
 *  GET  /api/ads/connect/callback/googlecloud           Google sends the person back (public, already on the tunnel allowlist)
 *  GET  /api/apps/:id/connect/google/session/:sid      the Google Cloud projects to pick from
 *  POST /api/apps/:id/connect/google/session/:sid/setup  set everything up (in the background; the hub shows "checking")
 *  POST /api/apps/:id/connect/google/check             is the Play Console invite in place? (Play API, with the service account)
 *  PUT  /api/apps/:id/connect/google/developer         the Play Console address (developer id) → bucket
 *  PUT  /api/apps/:id/connect/google/bucket            the reports bucket by hand
 *  POST /api/apps/:id/connect/fcm                      the push key to EAS
 *  PUT  /api/apps/:id/connect/expo                     the robot token, checked, then the EAS project found
 *  POST /api/apps/:id/connect/expo/project             find or create the EAS project
 *  PUT  /api/apps/:id/connect/apple/key                App Store Connect key (.p8, Issuer ID; Key ID from the file name)
 *  PUT  /api/apps/:id/connect/apple/iap                In-App Purchase key
 *  POST /api/apps/:id/connect/apple/notifications      day2 sets the server notification URL
 *  PUT  /api/apps/:id/connect/apple/vendor             vendor number, checked with Apple
 *  POST /api/apps/:id/connect/apple/analytics          start App Analytics (stored key, or a one-time Admin key that isn't kept)
 *  POST /api/apps/:id/connect/confirm/:what            membership | paid_apps
 *  GET  /api/platform/connect                          what day2's server needs for this (operator)
 *
 * Every key goes where the feature that uses it already keeps it
 * (release_credentials, money_credentials, Numbers settings), so the old
 * per-page forms and APIs keep working.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;
export type ConnectRouteContext = {
  route: (method: string, pathname: string, handler: Handler, opts?: { public?: boolean }) => void;
  json: (data: unknown, init?: ResponseInit) => Response;
  httpError: (status: number, message: string) => Error;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
  requireOperator: (t: Tenant) => void;
  actorName: (t: Tenant) => Promise<string | undefined>;
};

/** Deletes a Google session and revokes its token at Google (best effort). */
async function endSession(id: string): Promise<void> {
  const token = await googleSessions()
    .end(id)
    .catch(() => null);
  if (token) await revokeStoresToken(token.accessToken);
}

/**
 * Abandoned sign-ins (an hour old: consent given, setup never started or
 * the tab closed): deleted, their tokens revoked. On the backlog timer.
 */
export async function purgeGoogleSessions(now = Date.now()): Promise<number> {
  const tokens = await googleSessions().takeExpired(now);
  for (const t of tokens) await revokeStoresToken(t.accessToken);
  return tokens.length;
}

/** What runs in the background per app (the hub shows "checking"). */
const running = new Map<string, string>();
export const connectRunning = (appId: string) => running.get(appId) ?? null;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** An error's text, scrubbed of keys and tokens (connect/state.ts scrub) — for anything shown or stored. */
const errText = (err: unknown) => scrub((err as Error)?.message ?? String(err));

function readAppJson(app: AppEntry): unknown {
  try {
    return JSON.parse(readFileSync(join(app.repoPath, "app.json"), "utf-8"));
  } catch {
    return null;
  }
}

function paidProducts(app: AppEntry): boolean {
  const m = loadAppMoney(app);
  return m.products.some((p) => !p.retiredAt) || (currentStrategy(m)?.models ?? []).some((x) => x === "subscription" || x === "one_time" || x === "consumables");
}

async function ticketOnce(app: AppEntry, input: NewTicketInput): Promise<string> {
  return withBacklog(backlogFile(app), (b) => {
    const have = b.tickets.find((t) => t.source.key === input.source.key && t.state !== "parked");
    if (have) return { backlog: b, result: have.id };
    const now = new Date();
    const r = createTicket(b, input, now);
    return { backlog: rankBacklog(r.backlog, now).backlog, result: r.ticket.id };
  });
}

const googleServicesTicket = (json: string): NewTicketInput => ({
  title: "Add google-services.json for Android push",
  type: "task",
  description: [
    "day2 set up Firebase for this app's Android push (Connect your stores). Android needs Firebase's config file in the app:",
    "",
    "1. Save this as google-services.json in the project root (it holds no secret; Google says it may be committed):",
    "",
    "```json",
    json.trim(),
    "```",
    "",
    '2. In app.json: expo.android.googleServicesFile = "./google-services.json".',
    "3. Don't change anything else. This is a native change: it reaches users with the next store build.",
  ].join("\n"),
  doneWhen: ["google-services.json is in the project root", "app.json points expo.android.googleServicesFile at it", "The app builds"],
  priority: 2,
  prioritySource: "day2",
  source: { kind: "day2_proposal", key: "connect:google-services" },
  actor: "day2",
  createdNote: "Set up by Connect your stores.",
});

const linkProjectTicket = (projectId: string, owner: string | null): NewTicketInput => ({
  title: "Link the app to its EAS project",
  type: "task",
  description: [
    `day2 found the app's EAS project (${projectId}). Builds and updates need the id in the app config:`,
    "",
    `- app.json: expo.extra.eas.projectId = "${projectId}"${owner ? ` and expo.owner = "${owner}"` : ""}.`,
    "- Keep everything else as it is.",
  ].join("\n"),
  doneWhen: ["expo.extra.eas.projectId is set in app.json", "The app builds"],
  priority: 2,
  prioritySource: "day2",
  source: { kind: "day2_proposal", key: "connect:eas-project" },
  actor: "day2",
  createdNote: "Found by Connect your stores.",
});

/** The app's EAS project: from app.json, else @owner/slug in the robot's accounts, else (create) a new one. */
async function findExpoProject(api: ExpoApi, app: AppEntry, create: boolean): Promise<{ id: string; fullName: string; accountId: string; account: string; created: boolean } | null> {
  const who = await api.whoami();
  const cfg = expoConfig(readAppJson(app));
  if (cfg.projectId) {
    const p = await api.projectById(cfg.projectId);
    if (p) {
      const account = p.fullName.replace(/^@/, "").split("/")[0] ?? "";
      const acc = who.accounts.find((a) => a.name === account) ?? who.accounts[0];
      if (acc) return { ...p, accountId: acc.id, account: acc.name, created: false };
    }
  }
  const slug = cfg.slug ?? app.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const accounts = cfg.owner ? [...who.accounts.filter((a) => a.name === cfg.owner), ...who.accounts.filter((a) => a.name !== cfg.owner)] : who.accounts;
  for (const a of accounts) {
    const p = await api.projectByFullName(`@${a.name}/${slug}`);
    if (p) return { ...p, accountId: a.id, account: a.name, created: false };
  }
  if (!create) return null;
  const acc = accounts[0];
  if (!acc) throw new ExpoApiError("The token isn't in any Expo account. Make the robot user in the account that owns the app.");
  const id = await api.createProject(acc.id, slug);
  return { id, fullName: `@${acc.name}/${slug}`, accountId: acc.id, account: acc.name, created: true };
}

export function registerConnectRoutes(ctx: ConnectRouteContext): void {
  const { route, json, httpError, requireApp, requireManager, requireOperator, actorName } = ctx;
  const mobile = (app: AppEntry) => {
    if (appKind(app.repoPath) !== "react-native") throw httpError(409, "Connecting the stores is for apps in the App Store and Google Play (React Native / Expo).");
  };

  async function view(app: AppEntry) {
    const ids = storeIdsFromRepo(app.repoPath);
    const isMobile = appKind(app.repoPath) === "react-native";
    const rel = isMobile ? await releaseCredentials().list(app.id) : [];
    const label = (k: string) => rel.find((c) => c.kind === k)?.label ?? null;
    const money = isMobile ? await moneyCredentials().list(app.id) : [];
    const mfile = loadAppMoney(app);
    const ndoc = await numbersStoreFor(app).load(app.id);
    const metaConn = (await adConnections().get({ appId: app.id }, "meta").catch(() => null)) ?? (await adConnections().get("day2", "meta").catch(() => null));
    const metaIdent = (await platformIdentities().forApp(app.id).catch(() => [])).find((x) => x.platform === "meta");
    const page = (await adIdentities().get(app.id).catch(() => undefined))?.metaPageId ?? metaIdent?.ref.split(":")[0] ?? null;
    return hubView({
      appId: app.id,
      appName: app.name,
      mobile: isMobile,
      ids,
      publicUrl: authConfig().publicUrl,
      file: loadAppConnect(app),
      running: connectRunning(app.id),
      googleAvailable: Boolean(storesOAuthClient()),
      release: { expo: label("expo"), asc: label("asc"), play: label("play") },
      money: {
        paidProducts: isMobile && paidProducts(app),
        iap: money.find((c) => c.kind === "iap")?.label ?? null,
        rtdn: money.find((c) => c.kind === "rtdn")?.label ?? null,
        notificationsOk: Boolean(mfile.connections.apple_notifications?.ok),
        paidAppsConfirmed: Boolean(mfile.settings.confirmed.paid_apps),
      },
      numbers: { vendor: ndoc.settings.appleVendorNumber, bucket: ndoc.settings.playBucket, analyticsRequested: Boolean(ndoc.apple.analyticsRequestId) },
      expoProjectInRepo: expoConfig(readAppJson(app)).projectId,
      meta: { wanted: Boolean(metaConn) || Boolean(page) || Boolean(process.env.META_APP_ID), page },
    });
  }

  route("GET", "/api/apps/:id/connect", async (_req, p, t) => json(await view(await requireApp(t, p.id!))));

  // ---- Google ----

  route("POST", "/api/apps/:id/connect/google/start", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    mobile(app);
    const client = storesOAuthClient();
    if (!client) throw httpError(409, "This day2 server can't use Google sign-in yet (its operator hasn't set DAY2_GOOGLE_OAUTH_CLIENT_ID). Paste a service account key on Releases instead.");
    const b = await body(req);
    const s = await googleSessions().start({ accountId: t.accountId, appId: app.id, createdBy: (await actorName(t)) ?? null });
    const hint = str(b.loginHint);
    return json({ url: storesAuthorizeUrl(client, { state: s.state, challenge: pkceChallenge(s.verifier), redirectUri: storesRedirectUri(authConfig().publicUrl), loginHint: /^[^@\s]+@[^@\s]+$/.test(hint) ? hint : null }) });
  });

  route(
    "GET",
    STORES_CALLBACK_PATH,
    async (req) => {
      const q = new URL(req.url).searchParams;
      const consoleUrl = authConfig().consoleUrl;
      // Single-use: the first callback consumes the state; a replay finds nothing.
      const s = q.get("state") ? await googleSessions().consumeState(q.get("state")!) : null;
      if (!s) return Response.redirect(`${consoleUrl}/apps?googleError=${encodeURIComponent("That Google sign-in expired or was already used — start again.")}`, 302);
      const back = (query: string) => Response.redirect(`${consoleUrl}/apps/${encodeURIComponent(s.appId)}/connect?${query}`, 302);
      const fail = async (message: string) => {
        await endSession(s.id);
        return back(`googleError=${encodeURIComponent(message)}`);
      };
      if (q.get("error")) return fail(q.get("error") === "access_denied" ? "You cancelled the Google sign-in." : "Google didn't finish the sign-in.");
      const client = storesOAuthClient();
      if (!client || !q.get("code")) return fail("Google didn't finish the sign-in.");
      try {
        const tok = await exchangeStoresCode(client, q.get("code")!, storesRedirectUri(authConfig().publicUrl), s.verifier);
        const replaced = await googleSessions().setToken(s.id, { accessToken: tok.accessToken, expiresAt: tok.expiresAt, email: tok.email });
        if (replaced && replaced.accessToken !== tok.accessToken) await revokeStoresToken(replaced.accessToken);
        return back(`google=${encodeURIComponent(s.id)}`);
      } catch (err) {
        return fail(errText(err).slice(0, 200));
      }
    },
    { public: true },
  );

  const sessionFor = async (t: Tenant, app: AppEntry, sid: string) => {
    const s = await googleSessions().get(sid);
    if (!s || s.appId !== app.id || s.accountId !== t.accountId || !s.token || s.token.expiresAt < Date.now()) throw httpError(410, "That Google sign-in expired — sign in with Google again.");
    return s as typeof s & { token: NonNullable<typeof s.token> };
  };

  route("GET", "/api/apps/:id/connect/google/session/:sid", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const s = await sessionFor(t, app, p.sid!);
    try {
      const projects = await createCloud(s.token.accessToken).listProjects();
      const play = await releaseCredentials().get(app.id, "play");
      return json({ email: s.token.email, projects, suggested: play?.value.projectId ?? loadAppConnect(app).google.projectId ?? null });
    } catch (err) {
      // An unusable sign-in isn't kept: revoked and deleted (the owner signs in again).
      await endSession(s.id);
      throw httpError(502, `Google didn't list your projects: ${errText(err).replace(/^Google: /, "").slice(0, 200)} — sign in with Google again.`);
    }
  });

  /** The owner cancelled after signing in: the token goes right away. */
  route("DELETE", "/api/apps/:id/connect/google/session/:sid", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const s = await googleSessions().get(p.sid!);
    if (s && s.appId === app.id && s.accountId === t.accountId && !running.has(app.id)) await endSession(s.id);
    return json(await view(app));
  });

  route("POST", "/api/apps/:id/connect/google/session/:sid/setup", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    mobile(app);
    const s = await sessionFor(t, app, p.sid!);
    // Check and take the lock with no await in between, so two requests can't both start.
    if (running.has(app.id)) throw httpError(409, "day2 is already setting this up.");
    running.set(app.id, "project");
    let launched = false;
    try {
      const b = await body(req);
      const projectId = b.projectId === null || b.projectId === "new" ? null : str(b.projectId);
      if (projectId !== null && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw httpError(400, "Pick one of your projects, or let day2 create one.");
      const dev = str(b.playConsoleUrl) ? playDeveloperId(str(b.playConsoleUrl)) : loadAppConnect(app).google.developerId;
      if (str(b.playConsoleUrl) && !dev) throw httpError(400, "That isn't a Play Console address — copy it from the browser bar while the Play Console is open (it contains /developers/ and a number).");
      const by = (await actorName(t)) ?? null;
      const ids = storeIdsFromRepo(app.repoPath);
      const existing = await releaseCredentials().get(app.id, "play");
      const expoCred = await releaseCredentials().get(app.id, "expo");
      const cloud = createCloud(s.token.accessToken);
      launched = true;
      void (async () => {
        try {
          let expo = null;
          if (expoCred) {
            const api = createExpoApi(expoCred.value.token);
            const proj = await findExpoProject(api, app, false).catch(() => null);
            if (proj) expo = { api, accountId: proj.accountId, projectId: proj.id, projectFullName: proj.fullName };
          }
          const appJson = readAppJson(app) as { expo?: { android?: { googleServicesFile?: string } } } | null;
          const r = await runGoogleSetup(
            loadAppConnect(app).google,
            {
              appId: app.id,
              appName: app.name,
              packageName: ids.packageName,
              projectId,
              developerId: dev,
              publicUrl: authConfig().publicUrl,
              wantsRtdn: paidProducts(app),
              existingPlay: existing?.value ?? null,
              expo,
              googleServicesInRepo: Boolean(appJson?.expo?.android?.googleServicesFile) || existsSync(join(app.repoPath, "google-services.json")),
              randomSuffix: randomBytes(4).toString("hex"),
            },
            {
              cloud,
              savePlay: (cred, label) => releaseCredentials().set(app.id, "play", cred, label, by),
              saveRtdn: (v, label) => moneyCredentials().set(app.id, "rtdn", v, label, by),
              saveBucket: async (bucket) => {
                await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, settings: { ...d.settings, playBucket: bucket } }, result: null }));
                clearNumbersCache(app.id);
              },
              googleServicesTicket: (j) => ticketOnce(app, googleServicesTicket(j)),
              probeBucket: async (bucket) => {
                const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?maxResults=1&fields=items(name)`, { headers: { authorization: `Bearer ${s.token.accessToken}` } }).catch(() => null);
                return Boolean(res?.ok);
              },
              progress: (stepName) => running.set(app.id, stepName),
            },
          );
          updateAppConnect(app, (f) => ({ ...f, google: { ...r.file, email: s.token.email, by } }));
          // The service account is in place: see right away whether Play already lets it in.
          const play = await releaseCredentials().get(app.id, "play");
          if (r.ok && play && ids.packageName) {
            const a = await checkPlay(play.value, ids.packageName);
            updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, access: check(a.ok, a.ok ? "day2 can release this app on Google Play." : a.why) } }));
          }
        } catch (err) {
          updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, problem: `Setup stopped: ${errText(err).replace(/^Google: /, "").slice(0, 200)}` } }));
        } finally {
          running.delete(app.id);
          // The owner's token isn't needed any more: revoked and deleted.
          await endSession(s.id);
        }
      })();
    } finally {
      // Refused before the run started (bad input, a store error): free the lock again.
      if (!launched) running.delete(app.id);
    }
    return json(await view(app), { status: 202 });
  });

  route("POST", "/api/apps/:id/connect/google/check", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const play = await releaseCredentials().get(app.id, "play");
    const pkg = storeIdsFromRepo(app.repoPath).packageName;
    if (!play) throw httpError(409, "Sign in with Google first (or connect a service account on Releases).");
    if (!pkg) throw httpError(409, "day2 can't find the Android package name (android.package in app.json).");
    const a = await checkPlay(play.value, pkg);
    updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, access: check(a.ok, a.ok ? "day2 can release this app on Google Play." : a.why) } }));
    return json(await view(app));
  });

  /** Tries the bucket names for a developer id with the service account (works once Play applied the invite). */
  async function guessBucket(app: AppEntry, play: PlayCredential | null, developerId: string, pkg: string | null) {
    if (!play || !pkg) return;
    for (const b of bucketCandidates(developerId)) {
      const ok = await createPlayReports(play)
        .installReports(b, pkg)
        .then(() => true)
        .catch(() => false);
      if (ok) {
        await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, settings: { ...d.settings, playBucket: b } }, result: null }));
        clearNumbersCache(app.id);
        updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, bucket: check(true, `Found gs://${b}.`) } }));
        return;
      }
    }
  }

  route("PUT", "/api/apps/:id/connect/google/developer", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const dev = playDeveloperId(str((await body(req)).playConsoleUrl));
    if (!dev) throw httpError(400, "That isn't a Play Console address — copy it from the browser bar while the Play Console is open (it contains /developers/ and a number).");
    updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, developerId: dev } }));
    const play = await releaseCredentials().get(app.id, "play");
    await guessBucket(app, play?.value ?? null, dev, storeIdsFromRepo(app.repoPath).packageName);
    return json(await view(app));
  });

  route("PUT", "/api/apps/:id/connect/google/bucket", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const name = bucketName(str((await body(req)).playBucket));
    if (!name) throw httpError(400, "Paste the Cloud Storage URI from Play Console → Download reports (it starts with gs://pubsite_prod_).");
    await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, settings: { ...d.settings, playBucket: name } }, result: null }));
    clearNumbersCache(app.id);
    const play = await releaseCredentials().get(app.id, "play");
    const pkg = storeIdsFromRepo(app.repoPath).packageName;
    let note: ReturnType<typeof check> = check(true, `gs://${name}`);
    if (play && pkg) {
      try {
        await createPlayReports(play.value).installReports(name, pkg);
        note = check(true, `gs://${name} answers.`);
      } catch (err) {
        note = check(false, googleReason(err, "installs"));
      }
    }
    updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, bucket: note } }));
    return json(await view(app));
  });

  route("POST", "/api/apps/:id/connect/fcm", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const [play, expoCred] = await Promise.all([releaseCredentials().get(app.id, "play"), releaseCredentials().get(app.id, "expo")]);
    const pkg = storeIdsFromRepo(app.repoPath).packageName;
    if (!play || !expoCred || !pkg) throw httpError(409, "Connect Google and Expo first.");
    const api = createExpoApi(expoCred.value.token);
    let proj;
    try {
      proj = await findExpoProject(api, app, false);
    } catch (err) {
      throw httpError(502, errText(err));
    }
    if (!proj) throw httpError(409, "day2 can't find the app's EAS project yet — use “Find or create it” under Expo first.");
    try {
      await api.setFcmV1Key({ accountId: proj.accountId, projectFullName: proj.fullName, projectId: proj.id, packageName: pkg, jsonKey: { type: "service_account", project_id: play.value.projectId, client_email: play.value.clientEmail, private_key: play.value.privateKey } });
      updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, fcm: check(true, "EAS has the FCM V1 key: Android push works with the next build.") } }));
    } catch (err) {
      updateAppConnect(app, (f) => ({ ...f, google: { ...f.google, fcm: check(false, fcmProblem(err)) } }));
    }
    return json(await view(app));
  });

  // ---- Expo ----

  async function linkExpo(app: AppEntry, api: ExpoApi, create: boolean) {
    const proj = await findExpoProject(api, app, create);
    if (!proj) {
      updateAppConnect(app, (f) => ({ ...f, expo: { ...f.expo, check: check(true, "Connected. day2 didn't find an EAS project for this app yet.") } }));
      return;
    }
    const inRepo = expoConfig(readAppJson(app)).projectId;
    const ticket = inRepo === proj.id ? null : await ticketOnce(app, linkProjectTicket(proj.id, proj.account));
    updateAppConnect(app, (f) => ({ ...f, expo: { ...f.expo, account: proj.account, projectId: proj.id, projectFullName: proj.fullName, linkTicket: ticket, check: check(true, proj.created ? `Created ${proj.fullName}.` : `Found ${proj.fullName}.`) } }));
  }

  route("PUT", "/api/apps/:id/connect/expo", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    mobile(app);
    let parsed;
    try {
      parsed = parseCredential("expo", await body(req));
    } catch (err) {
      throw httpError(400, errText(err));
    }
    const token = (parsed.value as { token: string }).token;
    const api = createExpoApi(token);
    let who;
    try {
      who = await api.whoami();
    } catch (err) {
      throw httpError(400, errText(err));
    }
    await releaseCredentials().set(app.id, "expo", { token }, `${parsed.label} · ${who.kind === "robot" ? "robot" : "Expo user"} ${who.name}`, (await actorName(t)) ?? null);
    updateAppConnect(app, (f) => ({ ...f, expo: { ...f.expo, account: who.accounts[0]?.name ?? f.expo.account, check: check(true, null) } }));
    await linkExpo(app, api, false).catch((err: Error) => updateAppConnect(app, (f) => ({ ...f, expo: { ...f.expo, check: check(true, `Connected, but day2 couldn't look up the EAS project: ${errText(err)}`) } })));
    return json(await view(app));
  });

  route("POST", "/api/apps/:id/connect/expo/project", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const cred = await releaseCredentials().get(app.id, "expo");
    if (!cred) throw httpError(409, "Connect Expo first.");
    try {
      await linkExpo(app, createExpoApi(cred.value.token), true);
    } catch (err) {
      const m = errText(err);
      throw httpError(400, /permission|not authorized|forbidden/i.test(m) ? "The robot user can't create projects. Give it the Admin role on expo.dev for a moment, or create the project there, then try again." : m);
    }
    return json(await view(app));
  });

  // ---- Apple ----

  const p8 = (b: Record<string, unknown>) => ({ issuerId: str(b.issuerId), keyId: str(b.keyId) || keyIdFromFilename(str(b.fileName)) || "", privateKey: str(b.privateKey) });

  route("PUT", "/api/apps/:id/connect/apple/key", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    mobile(app);
    let parsed;
    try {
      parsed = parseCredential("asc", p8(await body(req)));
    } catch (err) {
      throw httpError(400, errText(err));
    }
    const access = await checkAsc(parsed.value as AscCredential, storeIdsFromRepo(app.repoPath).bundleId);
    updateAppConnect(app, (f) => ({ ...f, apple: { ...f.apple, checks: { ...f.apple.checks, asc_key: check(access.ok, access.ok ? null : access.why) } } }));
    if (!access.ok) throw httpError(400, access.why);
    await releaseCredentials().set(app.id, "asc", parsed.value as never, `${parsed.label} · ${access.who}`, (await actorName(t)) ?? null);
    return json(await view(app));
  });

  route("PUT", "/api/apps/:id/connect/apple/iap", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    mobile(app);
    let parsed;
    try {
      parsed = parseMoneyCredential("iap", p8(await body(req)));
    } catch (err) {
      throw httpError(400, errText(err));
    }
    const access = await checkIap(parsed.value as IapCredential, storeIdsFromRepo(app.repoPath).bundleId);
    if (!access.ok) throw httpError(400, access.why);
    setConnection(app, "iap_key", true, "The In-App Purchase key works.");
    await moneyCredentials().set(app.id, "iap", parsed.value as never, `${parsed.label} · ${access.who}`, (await actorName(t)) ?? null);
    return json(await view(app));
  });

  route("POST", "/api/apps/:id/connect/apple/notifications", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const cred = await releaseCredentials().get(app.id, "asc");
    const bundleId = storeIdsFromRepo(app.repoPath).bundleId;
    if (!cred || !bundleId) throw httpError(409, "Add the App Store Connect key first.");
    const url = `${authConfig().publicUrl}/api/store-notify/apple/${app.id}`;
    if (!url.startsWith("https://")) throw httpError(409, "day2 needs its public https address (DAY2_PUBLIC_URL) before Apple can send to it.");
    const r = await setNotificationsUrl(cred.value, bundleId, url);
    updateAppConnect(app, (f) => ({ ...f, apple: { ...f.apple, notificationsUrlSet: r.ok ? { at: new Date().toISOString(), url } : f.apple.notificationsUrlSet, checks: { ...f.apple.checks, notifications: check(r.ok, r.ok ? r.note : r.why) } } }));
    return json(await view(app));
  });

  route("PUT", "/api/apps/:id/connect/apple/vendor", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    let vendor: string | null;
    try {
      vendor = parseVendorNumber((await body(req)).vendorNumber);
    } catch (err) {
      throw httpError(400, errText(err));
    }
    if (!vendor) throw httpError(400, "The vendor number is the number shown in App Store Connect → Payments and Financial Reports (top left), digits only.");
    const cred = await releaseCredentials().get(app.id, "asc");
    let c = check(true, `Vendor ${vendor}`);
    if (cred) {
      const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
      try {
        await createAppleReports(cred.value).salesDay(vendor, day);
        c = check(true, `Vendor ${vendor} — Apple's sales reports answer.`);
      } catch (err) {
        const m = errText(err);
        if (err instanceof AppleReportError && (err.status === 400 || err.status === 403 || err.status === 404)) throw httpError(400, `Apple didn't accept vendor number ${vendor}: ${m}`);
        c = check(true, `Vendor ${vendor} saved; Apple didn't answer the check (${m}).`);
      }
    }
    await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, settings: { ...d.settings, appleVendorNumber: vendor } }, result: null }));
    clearNumbersCache(app.id);
    updateAppConnect(app, (f) => ({ ...f, apple: { ...f.apple, checks: { ...f.apple.checks, vendor: c } } }));
    return json(await view(app));
  });

  route("POST", "/api/apps/:id/connect/apple/analytics", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const bundleId = storeIdsFromRepo(app.repoPath).bundleId;
    if (!bundleId) throw httpError(409, "day2 can't find the iOS bundle id (ios.bundleIdentifier in app.json).");
    const b = await body(req);
    let cred: AscCredential | null = null;
    if (str(b.privateKey)) {
      try {
        // A one-time Admin key: used for this call only, never stored.
        cred = parseCredential("asc", p8(b)).value as AscCredential;
      } catch (err) {
        throw httpError(400, errText(err));
      }
    } else cred = (await releaseCredentials().get(app.id, "asc"))?.value ?? null;
    if (!cred) throw httpError(409, "Add the App Store Connect key first.");
    const r = await ensureAnalytics(cred, bundleId);
    if (r.ok && r.requestId) {
      await numbersStoreFor(app).update(app.id, (d) => ({ doc: { ...d, apple: { ...d.apple, analyticsRequestId: r.requestId! } }, result: null }));
      clearNumbersCache(app.id);
    }
    updateAppConnect(app, (f) => ({ ...f, apple: { ...f.apple, checks: { ...f.apple.checks, analytics: check(r.ok, r.ok ? r.note : r.why) } } }));
    return json(await view(app));
  });

  route("POST", "/api/apps/:id/connect/confirm/:what", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const by = (await actorName(t)) ?? null;
    const at = new Date().toISOString();
    if (p.what === "membership") updateAppConnect(app, (f) => ({ ...f, apple: { ...f.apple, confirmed: { ...f.apple.confirmed, membership: { at, by } } } }));
    else if (p.what === "paid_apps") {
      const m = loadAppMoney(app);
      saveAppMoney(app, { ...m, settings: { ...m.settings, confirmed: { ...m.settings.confirmed, paid_apps: { at, by } } } });
    } else throw httpError(404, "day2 checks that one itself.");
    return json(await view(app));
  });

  // ---- Operator: what day2's server needs ----

  route("GET", "/api/platform/connect", async (_req, _p, t) => {
    requireOperator(t);
    const client = storesOAuthClient();
    const pub = authConfig().publicUrl;
    return json({
      google: {
        ready: Boolean(client),
        source: client?.source ?? null,
        missingEnv: client ? [] : ["DAY2_GOOGLE_OAUTH_CLIENT_ID", "DAY2_GOOGLE_OAUTH_CLIENT_SECRET"],
        redirectUri: storesRedirectUri(pub),
        scopes: [...STORES_SCOPES],
        consent:
          "cloud-platform and androidpublisher are sensitive scopes: until Google verifies day2's OAuth consent screen, only test users you list can sign in (and see an “unverified app” warning). Verification can take weeks — start early.",
        https: /^https:\/\//.test(pub),
      },
      expo: { ready: true, note: "Nothing to set: Expo has no OAuth for other services; owners paste a robot user's token." },
      apple: { ready: true, note: "Nothing to set: Apple keys are per developer account and stay with each owner." },
    });
  });
}
