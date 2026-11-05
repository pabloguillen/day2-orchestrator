import type { AppEntry } from "../apps-registry";
import { loadAppLinks, APP_LINKS_FILENAME, storeIdsFromRepo } from "../ads/app-links";
import { authConfig } from "../auth";
import { renderBrandBrief } from "../brand-dna";
import { authorize, CreditsError, type CreditService } from "../credits";
import { appKind } from "../field-work";
import { APP_PROFILE_FILENAME, loadAppProfile } from "../onboarding";
import { replayOf } from "../ingest-inbox";
import { createLimiter, requestIp } from "../rate-limit";
import { fieldStore, releaseCredentials, runAsTenant, type Tenant } from "../tenant";
import { resolve } from "node:path";
import { createAppStoreServerApi } from "./apple-server-api";
import { liveConfigPart } from "./config";
import { checkAdMobIds, checkIap, connectionViews } from "./connections";
import { parseMoneyCredential, type IapCredential, type MoneyCredentialKind } from "./credentials";
import { googleClient, SCOPE_PUBSUB, setupPubSub } from "./google-play";
import { copyTest, addTest, decideTest, testTarget } from "./offer-tests";
import { dropDeclined, moneyKnowledge } from "./memory";
import { captureSoon, noteDecline, noteOwnerInput } from "../memory/runtime";
import type { ProposalKind } from "../memory/types";
import { adoptStrategy, ensureTickets, moneyPass } from "./pass";
import { decideProduct } from "./products";
import { receiveRevenueCat } from "./revenuecat";
import { findAppForWebhook, moneyPassDeps, STRATEGY_MAX_USD } from "./run";
import { decideStrategy, minorsHint, propose, researchStrategy } from "./strategy";
import { usesRevenueCat } from "./tickets";
import { addLog, currentStrategy, EARNING_MODELS, MODEL_LABEL, proposedStrategy, type Connection, type MoneyFile } from "./types";
import { receiveApple, receiveGoogle } from "./verify";
import { knownUsers, loadAppMoney, moneyCredentials, moneyLedger, saveAppMoney, setConnection, verifyDepsFor } from "./wiring";

/**
 * Money's API: /api/apps/:id/money/* (signed in) and the public store
 * webhooks /api/store-notify/{apple,google,revenuecat}/:appId (each proves
 * itself: Apple's signature chain, Google's OIDC token, RevenueCat's shared
 * secret). Registered from api-server.ts with one line. Keys are stored
 * encrypted and never returned — only their labels.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;
export type MoneyRouteContext = {
  route: (method: string, pathname: string, handler: Handler, opts?: { public?: boolean }) => void;
  json: (data: unknown, init?: ResponseInit) => Response;
  httpError: (status: number, message: string) => Error;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
  actorName: (t: Tenant) => Promise<string | undefined>;
  runWithCredits: <T>(t: Tenant, app: AppEntry, service: CreditService, description: string, maxCostUsd: number, fn: () => Promise<T>) => Promise<{ result: T; credits: number }>;
};

const MAX_WEBHOOK_BYTES = 256 * 1024;
/** Store notifications per address and minute (Apple's and Google's senders; replays from the inbox don't count). */
const NOTIFY_PER_IP_PER_MIN = 600;
const notifyLimiter = createLimiter(20_000);
export const resetStoreNotifyLimits = () => notifyLimiter.reset();

const TOO_LARGE = Symbol("too large");

/** The body, read at most up to `max` bytes (whatever content-length says); TOO_LARGE past that. */
async function readCapped(req: Request, max: number): Promise<string | typeof TOO_LARGE> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return TOO_LARGE;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf-8");
}

const JWS_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Pure. Whether a webhook body looks like what that store sends, before anything is looked up or decrypted. */
export function webhookShapeOk(store: "apple" | "google" | "revenuecat", b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  if (store === "apple") {
    const p = (b as { signedPayload?: unknown }).signedPayload;
    return typeof p === "string" && p.length <= MAX_WEBHOOK_BYTES && JWS_SHAPE.test(p);
  }
  if (store === "google") {
    const m = (b as { message?: { data?: unknown; messageId?: unknown; message_id?: unknown } }).message;
    const id = m?.messageId ?? m?.message_id;
    return Boolean(m && typeof m === "object" && typeof m.data === "string" && m.data.length > 0 && (typeof id === "string" || typeof id === "number"));
  }
  const e = (b as { event?: { id?: unknown; type?: unknown } }).event;
  return Boolean(e && typeof e === "object" && typeof e.id === "string" && typeof e.type === "string");
}

/** What the Money page shows. */
export async function moneyView(app: AppEntry) {
  const applies = appKind(app.repoPath) === "react-native";
  const file = loadAppMoney(app);
  const ids = storeIdsFromRepo(app.repoPath);
  const [creds, queue] = applies ? await Promise.all([moneyCredentials().list(app.id), moneyLedger().queue(app.id, 20)]) : [[], []];
  const label = (k: MoneyCredentialKind) => creds.find((c) => c.kind === k)?.label ?? null;
  const links = loadAppLinks(resolve(app.repoPath, APP_LINKS_FILENAME));
  const releaseAccounts = applies ? await releaseCredentials().list(app.id) : [];
  return {
    applies,
    settings: file.settings,
    strategy: currentStrategy(file),
    proposed: proposedStrategy(file),
    planning: Boolean(planning.get(app.id)),
    models: EARNING_MODELS.map((m) => ({ id: m, label: MODEL_LABEL[m] })),
    products: file.products,
    paywalls: file.paywalls,
    ads: file.ads,
    tests: file.tests,
    kpis: file.kpis,
    queue: queue.map((q) => ({ id: q.id, store: q.store, receivedAt: q.receivedAt, state: q.state, attempts: q.attempts, note: q.note, error: q.error })),
    stores: { ios: ids.bundleId, android: ids.packageName, asc: releaseAccounts.some((c) => c.kind === "asc"), play: releaseAccounts.some((c) => c.kind === "play") },
    connections: applies
      ? connectionViews(file, { appName: app.name, appStoreId: links.ios?.appStoreId ?? null, publicUrl: authConfig().publicUrl, appId: app.id, iapLabel: label("iap"), rtdnLabel: label("rtdn"), hasIos: Boolean(ids.bundleId), hasAndroid: Boolean(ids.packageName) })
      : [],
    revenueCat: file.settings.revenueCat || usesRevenueCat(app.repoPath) ? { connected: Boolean(label("revenuecat")), webhook: `${authConfig().publicUrl}/api/store-notify/revenuecat/${app.id}` } : null,
    config: liveConfigPart(file),
    log: file.log.slice(0, 30),
  };
}

const planning = new Map<string, string>();

export function registerMoneyRoutes(ctx: MoneyRouteContext): void {
  const { route, json, httpError, requireApp, requireManager, actorName } = ctx;
  const mobile = (app: AppEntry) => {
    if (appKind(app.repoPath) !== "react-native") throw httpError(409, "Money is for apps in the App Store and Google Play (React Native / Expo).");
  };
  const update = (app: AppEntry, fn: (f: MoneyFile) => MoneyFile) => {
    const next = fn(loadAppMoney(app));
    saveAppMoney(app, next);
    return next;
  };
  /** A decline: blocked for 90 days; with a "why", day2 learns from it right away. */
  const declined = async (t: Tenant, app: AppEntry, kind: ProposalKind, target: string, reason: unknown, about: string, id: string) => {
    const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    await noteDecline(app, { kind, target, reason: why, who: (await actorName(t)) ?? null, about, ref: { type: "proposal", id, url: `/apps/${app.id}/money`, label: `Money: ${about}` } });
    if (why) captureSoon(app, (service, description, max, fn) => ctx.runWithCredits(t, app, service, description, max, fn));
  };
  const kick = (t: Tenant, app: AppEntry) => {
    // Products and tickets right away instead of at the next autopilot tick.
    const profile = loadAppProfile(resolve(app.repoPath, APP_PROFILE_FILENAME));
    if (profile) void runAsTenant(t, () => moneyPass(app, profile, moneyPassDeps(t, app), () => {}, new Date())).catch((err: Error) => console.error(`[day2-money] ${app.name}: ${err.message}`));
  };

  for (const store of ["apple", "google", "revenuecat"] as const) route("POST", `/api/store-notify/${store}/:appId`, (req, p) => handleStoreNotify(req, store, p.appId!), { public: true });

  route("GET", "/api/apps/:id/money", async (_req, p, t) => json(await moneyView(await requireApp(t, p.id!))));

  route("PUT", "/api/apps/:id/money/settings", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const b = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    update(app, (f) => {
      const s = { ...f.settings };
      if (typeof b.enabled === "boolean") s.enabled = b.enabled;
      if (b.prices === "ask" || b.prices === "auto") s.prices = b.prices;
      if (b.tests === "ask" || b.tests === "auto") s.tests = b.tests;
      if (typeof b.currency === "string" && /^[A-Z]{3}$/.test(b.currency)) s.currency = b.currency;
      if (typeof b.baseRegion === "string" && /^[A-Z]{2}$/.test(b.baseRegion)) s.baseRegion = b.baseRegion;
      if (typeof b.locale === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(b.locale)) s.locale = b.locale;
      if (typeof b.revenueCat === "boolean") s.revenueCat = b.revenueCat;
      return { ...f, settings: s };
    });
    return json(await moneyView(app));
  });

  /** Plan now (also with few users): research runs in the background; the page polls. */
  route("POST", "/api/apps/:id/money/strategy/plan", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    mobile(app);
    requireManager(t);
    const profile = loadAppProfile(resolve(app.repoPath, APP_PROFILE_FILENAME));
    if (!profile) throw httpError(409, "Scan the app first (App profile) — the plan is built on what the app does and for whom.");
    if (planning.get(app.id)) return json(await moneyView(app), { status: 202 });
    // The owner asked for it here, so a decline of an earlier plan doesn't stop it; a "never" rule does.
    const known = await moneyKnowledge(app);
    if (known.blocked.blocked && known.blocked.until === null) throw httpError(409, `day2 won't plan prices: ${known.blocked.why} Change it on “What day2 knows” if that's no longer true.`);
    const check = await authorize(t.credits, { appId: app.id, appName: app.name, service: "scan_answer", maxCostUsd: STRATEGY_MAX_USD });
    if (!check.ok) throw new CreditsError(check);
    planning.set(app.id, new Date().toISOString());
    const file = loadAppMoney(app);
    void (async () => {
      try {
        const now = new Date();
        const { users } = await knownUsers(app, fieldStore(), now, 30);
        const snap = await fieldStore().retention(app.id).catch(() => null);
        const minors = minorsHint(profile.targetUsers, profile.brand?.audience.primary, profile.purpose);
        const { result, credits } = await ctx.runWithCredits(t, app, "scan_answer", "How the app earns", STRATEGY_MAX_USD, () =>
          researchStrategy({
            appName: app.name,
            purpose: profile.purpose,
            targetUsers: profile.targetUsers,
            featureMap: profile.featureMap.join(", "),
            businessModel: profile.businessModel,
            brandBrief: renderBrandBrief(profile.brand ?? null),
            users: users.length,
            rhythm: snap?.rhythm ?? null,
            d7: snap?.rates.new ?? null,
            currency: file.settings.currency,
            baseRegion: file.settings.baseRegion,
            existing: [],
            minorsHint: minors,
            excerpts: [],
            memory: known.memory,
            avoid: known.avoid,
            worked: known.worked,
          }),
        );
        const kept = result ? await dropDeclined(app, result) : null;
        update(app, (f) => (kept ? propose(f, kept, { users: users.length, rhythm: snap?.rhythm ?? null, credits, now }).file : addLog(f, "Couldn't verify how leading apps of this kind earn — day2 proposes nothing rather than guess.", now)));
      } catch (err) {
        update(app, (f) => addLog(f, `Couldn't plan: ${(err as Error).message}`, new Date()));
      } finally {
        planning.delete(app.id);
      }
    })();
    return json(await moneyView(app), { status: 202 });
  });

  route("POST", "/api/apps/:id/money/strategy/:sid/decide", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    mobile(app);
    requireManager(t);
    const b = ((await req.json().catch(() => ({}))) ?? {}) as { approve?: unknown; reason?: unknown };
    if (typeof b.approve !== "boolean") throw httpError(400, "Say approve: true or false.");
    const now = new Date();
    const by = (await actorName(t)) ?? null;
    const f = loadAppMoney(app);
    const d = decideStrategy(f, p.sid!, b.approve, by, now);
    if (!d.strategy) throw httpError(404, "No such plan waiting for a decision.");
    if (!b.approve) await declined(t, app, "money.strategy", d.strategy.models.slice().sort().join(",") || "not_yet", b.reason, `the plan for how the app earns (${d.strategy.models.join(" + ") || "not yet"})`, d.strategy.id);
    const ids = storeIdsFromRepo(app.repoPath);
    let next = d.file;
    if (b.approve) {
      next = adoptStrategy(next, d.strategy, { idBase: ids.bundleId ?? ids.packageName ?? app.id, stores: { ios: Boolean(ids.bundleId), android: Boolean(ids.packageName) }, now });
      next = (await ensureTickets(app, next, d.strategy, now)).file;
    }
    saveAppMoney(app, next);
    if (b.approve) kick(t, app);
    return json(await moneyView(app));
  });

  route("POST", "/api/apps/:id/money/products/:pid/decide", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const b = ((await req.json().catch(() => ({}))) ?? {}) as { approve?: unknown; reason?: unknown };
    if (typeof b.approve !== "boolean") throw httpError(400, "Say approve: true or false.");
    const by = (await actorName(t)) ?? null;
    const product = loadAppMoney(app).products.find((x) => x.productId === decodeURIComponent(p.pid!));
    update(app, (f) => decideProduct(f, decodeURIComponent(p.pid!), b.approve as boolean, by, new Date()));
    if (!b.approve && product) await declined(t, app, "money.product", product.key, b.reason, `the product “${product.name}” at ${product.base.amount} ${product.base.currency}`, product.productId);
    if (b.approve) kick(t, app);
    return json(await moneyView(app));
  });

  route("POST", "/api/apps/:id/money/tests/:tid/decide", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const b = ((await req.json().catch(() => ({}))) ?? {}) as { approve?: unknown; reason?: unknown };
    if (typeof b.approve !== "boolean") throw httpError(400, "Say approve: true or false.");
    const by = (await actorName(t)) ?? null;
    const test = loadAppMoney(app).tests.find((x) => x.id === p.tid);
    update(app, (f) => decideTest(f, p.tid!, b.approve as boolean, by, new Date()));
    if (!b.approve && test) await declined(t, app, "money.test", testTarget(test), b.reason, `the test “${test.title}”`, test.id);
    if (b.approve) kick(t, app);
    return json(await moneyView(app));
  });

  /** The owner's own wording for a paywall, tested against the current one. */
  route("POST", "/api/apps/:id/money/tests/copy", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const b = ((await req.json().catch(() => ({}))) ?? {}) as { placement?: unknown; title?: unknown; subtitle?: unknown; cta?: unknown };
    const f = loadAppMoney(app);
    const w = f.paywalls.find((x) => x.placement === b.placement);
    if (!w) throw httpError(404, "No such paywall.");
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const test = copyTest(f, w, { title: s(b.title, 80), subtitle: s(b.subtitle, 160) || undefined, cta: s(b.cta, 40) || undefined }, new Date());
    if (!test) throw httpError(409, "The paywall isn't live yet (its products have to be in the stores first), or the title is empty.");
    if (f.tests.some((x) => x.state === "running" || x.state === "proposed" || x.state === "waiting_approval")) throw httpError(409, "Another test is running — one at a time, so each result is clear.");
    saveAppMoney(app, addTest(f, test, new Date()));
    // The owner rewrote day2's paywall copy: day2 learns the preference behind it.
    const was = [w.title, w.subtitle, w.cta].filter(Boolean).join(" · ");
    const now = [s(b.title, 80), s(b.subtitle, 160), s(b.cta, 40)].filter(Boolean).join(" · ");
    await noteOwnerInput(app, { kind: "edit", text: "rewrote the paywall wording", before: was, after: now, about: `paywall “${w.placement}”`, ref: { type: "proposal", id: `paywall.${w.placement}`, url: `/apps/${app.id}/money`, label: `Money: paywall ${w.placement}` }, who: await actorName(t) });
    return json(await moneyView(app), { status: 201 });
  });

  route("PUT", "/api/apps/:id/money/paywalls/:placement", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const b = ((await req.json().catch(() => ({}))) ?? {}) as { enabled?: unknown };
    if (typeof b.enabled !== "boolean") throw httpError(400, "Say enabled: true or false.");
    update(app, (f) => ({ ...f, paywalls: f.paywalls.map((w) => (w.placement === p.placement ? { ...w, enabled: b.enabled as boolean } : w)) }));
    return json(await moneyView(app));
  });

  /** AdMob app ids, ad unit ids per placement, placements on/off. */
  route("PUT", "/api/apps/:id/money/ads", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const b = ((await req.json().catch(() => ({}))) ?? {}) as { appId?: { ios?: string; android?: string }; units?: Record<string, { ios?: string; android?: string }>; enabled?: Record<string, boolean> };
    const clean = (o?: { ios?: string; android?: string }) => ({ ...(o?.ios?.trim() ? { ios: o.ios.trim() } : {}), ...(o?.android?.trim() ? { android: o.android.trim() } : {}) });
    const appId = b.appId ? clean(b.appId) : undefined;
    const units = Object.fromEntries(Object.entries(b.units ?? {}).map(([k, v]) => [k, clean(v)]));
    const bad = checkAdMobIds({ ...(appId ? { appId } : {}), units });
    if (bad) throw httpError(400, bad);
    update(app, (f) => ({
      ...f,
      settings: appId ? { ...f.settings, admob: { appId: { ...f.settings.admob.appId, ...appId } } } : f.settings,
      ads: f.ads.map((a) => ({ ...a, ...(units[a.id] ? { unitId: { ...a.unitId, ...units[a.id] } } : {}), ...(typeof b.enabled?.[a.id] === "boolean" ? { enabled: b.enabled[a.id]! } : {}) })),
    }));
    return json(await moneyView(app));
  });

  /** In-App Purchase key / Pub/Sub push identity / RevenueCat: checked, then stored encrypted. */
  route("PUT", "/api/apps/:id/money/connections/:kind", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const kind = p.kind as MoneyCredentialKind;
    if (kind !== "iap" && kind !== "rtdn" && kind !== "revenuecat") throw httpError(404, "Unknown connection.");
    let parsed;
    try {
      parsed = parseMoneyCredential(kind, await req.json().catch(() => ({})));
    } catch (err) {
      throw httpError(400, (err as Error).message);
    }
    let label = parsed.label;
    if (kind === "iap") {
      const access = await checkIap(parsed.value as IapCredential, storeIdsFromRepo(app.repoPath).bundleId);
      if (!access.ok) throw httpError(400, access.why);
      label = `${parsed.label} · ${access.who}`;
      setConnection(app, "iap_key", true, "The In-App Purchase key works.");
    }
    await moneyCredentials().set(app.id, kind, parsed.value as never, label, (await actorName(t)) ?? null);
    return json(await moneyView(app));
  });

  route("DELETE", "/api/apps/:id/money/connections/:kind", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const kind = p.kind as MoneyCredentialKind;
    if (kind !== "iap" && kind !== "rtdn" && kind !== "revenuecat") throw httpError(404, "Unknown connection.");
    await moneyCredentials().remove(app.id, kind);
    if (kind === "iap") update(app, (f) => ({ ...f, connections: { ...f.connections, iap_key: undefined } }));
    return json(await moneyView(app));
  });

  /** Ask Apple to send a test notification (with the In-App Purchase key). */
  route("POST", "/api/apps/:id/money/connections/apple_notifications/test", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const cred = await moneyCredentials().get(app.id, "iap");
    const bundleId = storeIdsFromRepo(app.repoPath).bundleId;
    if (!cred || !bundleId) throw httpError(409, "Add the In-App Purchase key first.");
    try {
      await createAppStoreServerApi(cred, bundleId).requestTestNotification();
    } catch (err) {
      throw httpError(502, `${(err as Error).message} — is the Production Server URL set in App Store Connect?`);
    }
    update(app, (f) => addLog(f, "Asked Apple for a test notification — this card turns green when it arrives (usually within a minute).", new Date()));
    return json(await moneyView(app), { status: 202 });
  });

  /** Create the Pub/Sub topic and push subscription with the Google Play service account, when it's allowed to. */
  route("POST", "/api/apps/:id/money/connections/rtdn/setup", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const play = await releaseCredentials().get(app.id, "play");
    if (!play) throw httpError(409, "Connect Google Play first (Releases page).");
    if (!play.value.projectId) throw httpError(409, "The service account key has no project id — follow the steps by hand.");
    const endpoint = `${authConfig().publicUrl}/api/store-notify/google/${app.id}`;
    if (!endpoint.startsWith("https://")) throw httpError(409, "day2 needs its public https address (DAY2_PUBLIC_URL) before Google can push to it.");
    let r;
    try {
      r = await setupPubSub(googleClient(play.value, SCOPE_PUBSUB), { project: play.value.projectId, topicName: `day2-play-${app.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 200), endpoint, pushAs: play.value.clientEmail });
    } catch (err) {
      throw httpError(400, `Google didn't let the service account set up Pub/Sub (${(err as Error).message}). Give it the Pub/Sub Admin role in ${play.value.projectId}, or follow the steps by hand.`);
    }
    await moneyCredentials().set(app.id, "rtdn", { pushServiceAccount: play.value.clientEmail, audience: endpoint }, `Pub/Sub ${r.topic}`, (await actorName(t)) ?? null);
    update(app, (f) => addLog(f, `Created ${r.topic} with a push to day2. Now enter that topic in the Play Console (Monetization setup) and send a test notification.`, new Date()));
    return json({ ...(await moneyView(app)), topic: r.topic });
  });

  /** Steps only the owner can do and day2 can't check (agreements, payments profile, AdMob account). */
  route("POST", "/api/apps/:id/money/connections/:cid/confirm", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    requireManager(t);
    const id = p.cid as Connection;
    if (id !== "paid_apps" && id !== "payments_profile" && id !== "admob") throw httpError(404, "day2 checks that one itself.");
    const by = (await actorName(t)) ?? null;
    update(app, (f) => ({ ...f, settings: { ...f.settings, confirmed: { ...f.settings.confirmed, [id]: { at: new Date().toISOString(), by } } } }));
    return json(await moneyView(app));
  });
}

// ---- Store webhooks (public; each proves itself) ----

/**
 * POST /api/store-notify/{apple,google,revenuecat}/:appId — public routes
 * (no session; the CSRF check skips /api/store-notify/). Unknown apps get
 * the same answer as bad signatures. A replay of a notification the inbox
 * Worker kept while day2 was away is marked in-process by drainInbox
 * (replayOf) — never by a header, so no request from outside can skip
 * Google's OIDC check.
 *
 * Cheap checks first: size (content-length, then a capped read), a limit
 * per address, the body's shape and the Authorization header — only then
 * is the app looked up and its keys decrypted.
 */
export async function handleStoreNotify(req: Request, store: "apple" | "google" | "revenuecat", appId: string): Promise<Response> {
  const refused = new Response(null, { status: store === "google" ? 401 : 400 });
  const replay = replayOf(req) !== null;
  if (!replay && !notifyLimiter.allow(`i:${requestIp(req) ?? "?"}`, NOTIFY_PER_IP_PER_MIN, Date.now())) return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  const text = await readCapped(req, MAX_WEBHOOK_BYTES);
  if (text === TOO_LARGE) return new Response(null, { status: 413 });
  let b: unknown = null;
  try {
    b = JSON.parse(text);
  } catch {
    b = null;
  }
  const auth = req.headers.get("authorization");
  if (store === "google" && !replay && !auth) return new Response(null, { status: 401 });
  if (store === "revenuecat" && !auth) return new Response(null, { status: 401 });
  if (!webhookShapeOk(store, b)) return store === "google" && !replay ? new Response(null, { status: 401 }) : new Response(null, { status: 400 });
  const hit = await findAppForWebhook(appId);
  if (!hit) return refused;
  return runAsTenant(hit.tenant, async () => {
    const deps = await verifyDepsFor(hit.app, { ledger: moneyLedger(), credentials: moneyCredentials(), release: releaseCredentials(), store: fieldStore() });
    const out =
      store === "apple"
        ? await receiveApple(hit.app.id, b, deps)
        : store === "google"
          ? await receiveGoogle(hit.app.id, auth, b, deps, { replay })
          : await receiveRevenueCat(hit.app.id, auth, b, { ...deps, webhookAuth: (await moneyCredentials().get(hit.app.id, "revenuecat"))?.webhookAuth ?? null });
    if (out.status >= 400) console.warn(`[day2-money] ${store} notification for ${hit.app.id} refused: ${out.note}`);
    return new Response(null, { status: out.status });
  });
}
