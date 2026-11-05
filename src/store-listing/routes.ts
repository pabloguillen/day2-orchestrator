import { recordStoreTest } from "../learning/runtime";
import type { AppEntry } from "../apps-registry";
import type { CreditService } from "../credits";
import { appKind } from "../field-work";
import type { Tenant } from "../tenant";
import { makeScreenshots, makingScreenshots, storeDeps } from "./deps";
import { decideProposal, FIELD_LABEL, measure } from "./listing";
import { addCustomPage, addTest, playExperimentWalkthrough, recordResult } from "./page-tests";
import { parseReviewPrompt, ratingTrend } from "./reviews";
import { FLOW_KEY, FLOW_PATH, hasFlow, sizeById, storeShotPath } from "./screenshots";
import { applyApproved, readListings, reviewsPass, runResearch, sendPending, uploadApprovedScreens, type Paid } from "./service";
import { setupWaiting } from "./setup";
import { registerSetupRoutes } from "./setup-routes";
import { captureSoon, noteDecline, noteOwnerInput } from "../memory/runtime";
import type { ProposalKind } from "../memory/types";
import { LIMITS, type StoreFile, type StoreId, type StoreReview, type StoreSettings } from "./types";

/**
 * /api/apps/:id/store/* — the Store page. Registered from api-server.ts
 * with one line; the server hands in its own helpers (routing, sign-in
 * checks, credits) so this module doesn't reach into it.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;
export type RouteKit = {
  route: (method: string, path: string, handler: Handler) => void;
  json: (data: unknown, init?: ResponseInit) => Response;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
  runWithCredits: <T>(t: Tenant, app: AppEntry, service: CreditService, description: string, maxCostUsd: number, fn: () => Promise<T>) => Promise<{ result: T; credits: number }>;
  actorName: (t: Tenant) => Promise<string | undefined>;
  httpError: (status: number, message: string) => Error;
};

const STORE_NAME: Record<StoreId, string> = { ios: "App Store", android: "Google Play" };
/** Inside runWithCredits the whole request is already paid for. */
const inRequest: Paid = async (_s, _l, _m, fn) => ({ result: await fn(), credits: 0 });

export async function storeView(app: AppEntry, t: Tenant) {
  const applies = appKind(app.repoPath) === "react-native";
  const d = await storeDeps(t, app);
  const f = await d.store.load(app.id);
  const reviews = applies ? await d.store.reviews(app.id) : [];
  const tickets = applies ? await d.tickets() : [];
  const flowTicket = tickets.find((x) => x.source.key === FLOW_KEY);
  const shot = (setId: string, file: string) => `/api/apps/${encodeURIComponent(app.id)}/store/screenshots/${encodeURIComponent(setId)}/${encodeURIComponent(file)}`;
  const pending = {
    proposals: f.proposals.filter((p) => p.status === "pending").length,
    screenshots: f.screenshots.filter((s) => s.status === "draft").length,
    tests: f.tests.filter((x) => x.status === "waiting_approval").length + f.customPages.filter((p) => p.status === "waiting_approval").length,
    replies: reviews.filter((r) => r.reply?.state === "draft").length,
    setup: applies ? setupWaiting(f) : 0,
  };
  return {
    applies,
    settings: f.settings,
    connected: { ios: Boolean(d.asc), android: Boolean(d.play) },
    ids: d.ids,
    limits: LIMITS,
    listings: f.listings,
    proposals: f.proposals.slice(-80).reverse().map((p) => ({ ...p, label: FIELD_LABEL[p.field] })),
    research: f.research.slice(0, 3),
    screenshots: {
      flow: { path: FLOW_PATH, exists: hasFlow(app.repoPath), ticket: flowTicket ? { id: flowTicket.id, state: flowTicket.state } : null },
      making: makingScreenshots(app.id),
      sets: f.screenshots
        .slice()
        .reverse()
        .map((s) => ({ ...s, sizes: s.sizes.map((id) => sizeById(id)).filter(Boolean), shots: s.shots.map((x) => ({ name: x.name, caption: x.caption, images: Object.fromEntries(Object.entries(x.framed).map(([size, file]) => [size, shot(s.id, file)])) })) })),
    },
    tests: f.tests
      .slice()
      .reverse()
      .map((x) => ({ ...x, walkthrough: x.kind === "play_experiment" && x.status === "draft" ? playExperimentWalkthrough(x, { appName: d.appName }) : null })),
    customPages: f.customPages.slice().reverse(),
    reviews: reviews.slice(0, 100),
    trend: ratingTrend(reviews),
    ratings: f.ratings.slice(-60),
    log: f.log.slice(-30).reverse(),
    pending: { ...pending, total: pending.proposals + pending.screenshots + pending.tests + pending.replies + pending.setup },
  };
}

const body = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, unknown>;

export function registerStoreRoutes(k: RouteKit): void {
  const { route, json, requireApp, requireManager, httpError } = k;
  registerSetupRoutes(k);
  const storeApp = async (t: Tenant, id: string) => {
    const app = await requireApp(t, id);
    if (appKind(app.repoPath) !== "react-native") throw httpError(409, "Only apps in the App Store and Google Play have a store listing.");
    return app;
  };
  const who = async (t: Tenant) => (await k.actorName(t)) ?? null;
  const fail = (err: unknown) => httpError(400, (err as Error).message);
  const ref = (app: AppEntry, id: string, label: string) => ({ type: "proposal" as const, id, url: `/apps/${app.id}/store`, label: `Store: ${label}` });
  /** A decline: blocked for 90 days; with a "why", day2 learns from it right away. */
  const declined = async (t: Tenant, app: AppEntry, kind: ProposalKind, target: string, reason: unknown, about: string, id: string) => {
    const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    await noteDecline(app, { kind, target, reason: why, who: await who(t), about, ref: ref(app, id, about) });
    if (why) captureSoon(app, (service, description, max, fn) => k.runWithCredits(t, app, service, description, max, fn));
  };

  route("GET", "/api/apps/:id/store", async (_req, p, t) => json(await storeView(await requireApp(t, p.id!), t)));

  /** Languages, how much day2 decides by itself, when to ask for ratings. */
  route("PUT", "/api/apps/:id/store/settings", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const d = await storeDeps(t, app);
    await d.store.update(app.id, (f) => {
      const s: StoreSettings = f.settings;
      if (Array.isArray(b.locales)) {
        const locales = b.locales.filter((x): x is string => typeof x === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(x)).slice(0, 10);
        if (!locales.length) throw httpError(400, "Pick at least one language.");
        s.locales = [...new Set(locales)];
      }
      const a = (b.autonomy ?? {}) as Record<string, unknown>;
      if (a.listing === "ask" || a.listing === "auto") s.autonomy.listing = a.listing;
      if (a.tests === "ask" || a.tests === "auto") s.autonomy.tests = a.tests;
      if (a.replies === "ask" || a.replies === "auto_positive") s.autonomy.replies = a.replies;
      if (b.reviewPrompt) s.reviewPrompt = parseReviewPrompt(b.reviewPrompt, s.reviewPrompt);
      if (typeof b.tablet === "boolean") s.tablet = b.tablet;
      if (typeof b.researchEveryDays === "number" && b.researchEveryDays >= 7 && b.researchEveryDays <= 120) s.researchEveryDays = Math.round(b.researchEveryDays);
      return { file: f, result: null };
    });
    return json(await storeView(app, t));
  });

  /** Read what's in the stores now. */
  route("POST", "/api/apps/:id/store/listing/refresh", async (_req, p, t) => {
    const app = await storeApp(t, p.id!);
    await readListings(await storeDeps(t, app));
    return json(await storeView(app, t));
  });

  /** Research and new proposals now (otherwise every 30 days and after each release). */
  route("POST", "/api/apps/:id/store/research", async (_req, p, t) => {
    const app = await storeApp(t, p.id!);
    const d = { ...(await storeDeps(t, app)), paid: inRequest };
    if (!d.profile) throw httpError(409, `"${app.name}" hasn't been scanned yet — day2 needs to know what the app does first (App profile).`);
    const { result } = await k.runWithCredits(t, app, "content_generation", "Store research and listing texts", 1.1, async () => runResearch(d, "owner", await d.shippedVersion()));
    if (result.skipped) throw httpError(409, result.skipped);
    return json(await storeView(app, t), { status: 201 });
  });

  /** Approve (optionally with edited text) or reject a proposed listing change. */
  route("POST", "/api/apps/:id/store/proposals/:pid", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    if (typeof b.approve !== "boolean") throw httpError(400, "Say approve: true or false.");
    const d = await storeDeps(t, app);
    const by = await who(t);
    const prop = (await d.store.load(app.id)).proposals.find((x) => x.id === p.pid);
    await d.store.update(app.id, (f) => {
      try {
        return { file: decideProposal(f, p.pid!, { approve: b.approve as boolean, ...(typeof b.text === "string" ? { text: b.text } : {}), by, now: new Date(), appName: d.appName }), result: null };
      } catch (err) {
        throw fail(err);
      }
    });
    if (prop) {
      const label = `${FIELD_LABEL[prop.field]} (${prop.locale})`;
      if (!b.approve) await declined(t, app, "store.text", `${prop.field}:${prop.locale}`, b.reason, label, prop.id);
      // The owner rewrote day2's text before approving it: day2 learns the preference behind the edit.
      else if (typeof b.text === "string" && b.text.trim() !== prop.after.trim()) await noteOwnerInput(app, { kind: "edit", text: `edited the ${label}`, before: prop.after, after: b.text.trim(), about: label, ref: ref(app, prop.id, label), who: by });
    }
    if (b.approve) await applyApproved(d).catch(() => null);
    return json(await storeView(app, t));
  });

  /** New screenshots: built and captured on this computer's simulators (takes a while; runs in the background). */
  route("POST", "/api/apps/:id/store/screenshots", async (_req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    if (!hasFlow(app.repoPath)) throw httpError(409, `The app doesn't have its screenshot flow (${FLOW_PATH}) yet — day2 adds it as a ticket.`);
    const d = await storeDeps(t, app);
    if (!d.startScreenshots) throw httpError(409, "Screenshots are made on a Mac with the iPhone Simulator (local mode). This server can't run simulators.");
    void makeScreenshots(app, d).catch((err: Error) =>
      d.store.update(app.id, (f) => {
        f.log.push({ at: new Date().toISOString(), text: `Screenshots didn't work: ${err.message}` });
        return { file: f, result: null };
      }),
    );
    return json(await storeView(app, t), { status: 202 });
  });

  route("POST", "/api/apps/:id/store/screenshots/:sid", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const d = await storeDeps(t, app);
    await d.store.update(app.id, (f) => {
      const s = f.screenshots.find((x) => x.id === p.sid);
      if (!s) throw httpError(404, "No such screenshot set.");
      if (s.status !== "draft") throw httpError(409, `These screenshots are already ${s.status}.`);
      const edits: Array<{ before: string; after: string }> = [];
      if (b.approve === true) s.status = "approved";
      else if (b.approve === false) f.screenshots = f.screenshots.filter((x) => x.id !== s.id);
      else if (b.captions && typeof b.captions === "object") {
        for (const shot of s.shots) {
          const c = (b.captions as Record<string, unknown>)[shot.name];
          if (typeof c === "string" && c.trim().slice(0, 40) !== shot.caption) {
            edits.push({ before: shot.caption, after: c.trim().slice(0, 40) });
            shot.caption = c.trim().slice(0, 40);
          }
        }
      }
      return { file: f, result: edits };
    }).then(async (edits) => {
      if (b.approve === false) await declined(t, app, "store.screenshots", p.sid!, b.reason, "new screenshots", p.sid!);
      if (edits.length) await noteOwnerInput(app, { kind: "edit", text: "edited screenshot captions", before: edits.map((e) => e.before).join(" | "), after: edits.map((e) => e.after).join(" | "), about: "screenshot captions", ref: ref(app, p.sid!, "screenshot captions"), who: await who(t) });
    });
    if (b.approve === true) await uploadApprovedScreens(d).catch(() => null);
    return json(await storeView(app, t));
  });

  route("GET", "/api/apps/:id/store/screenshots/:sid/:file", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    const path = storeShotPath(app.id, p.sid!, p.file!);
    if (!path) throw httpError(404, "Not found.");
    return new Response(Bun.file(path), { headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" } });
  });

  /** A product page test: Apple (screenshots, through the API) or Google Play (a walkthrough). */
  route("POST", "/api/apps/:id/store/tests", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const kind = b.kind === "play_experiment" ? "play_experiment" : "apple_ppo";
    const d = await storeDeps(t, app);
    const treatments = (Array.isArray(b.treatments) ? b.treatments : []).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { name: String(o.name ?? "").trim().slice(0, 40) || "Variant", screenshotSetId: typeof o.screenshotSetId === "string" ? o.screenshotSetId : null, note: String(o.note ?? "").slice(0, 300) };
    });
    await d.store.update(app.id, (f) => {
      try {
        const locale = typeof b.locale === "string" && f.settings.locales.includes(b.locale) ? b.locale : f.settings.locales[0]!;
        const r = addTest(f, { kind, name: String(b.name ?? ""), hypothesis: String(b.hypothesis ?? ""), locale, trafficPercent: Number(b.trafficPercent ?? 50), treatments }, { now: new Date(), auto: f.settings.autonomy.tests === "auto" });
        return { file: r.file, result: null };
      } catch (err) {
        throw fail(err);
      }
    });
    return json(await storeView(app, t), { status: 201 });
  });

  /** Approve a test, stop it, or enter its result. */
  route("POST", "/api/apps/:id/store/tests/:tid", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const d = await storeDeps(t, app);
    const by = await who(t);
    let stopAsc: string | null = null;
    await d.store.update(app.id, (f) => {
      const x = f.tests.find((y) => y.id === p.tid);
      if (!x) throw httpError(404, "No such test.");
      if (b.result && typeof b.result === "object") {
        const r = b.result as Record<string, unknown>;
        try {
          const next = recordResult(f, x.id, { winner: String(r.winner ?? ""), note: String(r.note ?? ""), by, now: new Date() });
          const done = next.tests.find((y) => y.id === x.id);
          if (done?.result) void recordStoreTest(app, { id: done.id, kind: done.kind, treatments: done.treatments, result: done.result });
          return { file: next, result: null };
        } catch (err) {
          throw fail(err);
        }
      }
      if (b.approve === true && x.status === "waiting_approval") x.status = "draft";
      else if (b.approve === false && x.status === "waiting_approval") {
        f.tests = f.tests.filter((y) => y.id !== x.id);
        void declined(t, app, "store.test", `${x.kind}:${x.name}`, b.reason, `the product page test “${x.name}”`, x.id);
      }
      else if (b.stop === true) {
        stopAsc = x.ascId;
        x.status = "stopped";
        x.endedAt = new Date().toISOString();
      } else throw httpError(409, "Nothing to do for this test now.");
      return { file: f, result: null };
    });
    if (stopAsc && d.asc) await d.asc.stopExperiment(stopAsc).catch(() => null);
    return json(await storeView(app, t));
  });

  /** A custom product page (App Store) for an ad campaign or experiment. */
  route("POST", "/api/apps/:id/store/pages", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const d = await storeDeps(t, app);
    const text = String(b.promotionalText ?? "");
    if (measure("promotionalText", text) > LIMITS.promotionalText) throw httpError(400, `Promotional text is at most ${LIMITS.promotionalText} characters.`);
    await d.store.update(app.id, (f) => {
      try {
        const locale = typeof b.locale === "string" && f.settings.locales.includes(b.locale) ? b.locale : f.settings.locales[0]!;
        const campaigns = Array.isArray(b.campaigns) ? b.campaigns.filter((c): c is string => typeof c === "string") : [];
        const r = addCustomPage(f, { name: String(b.name ?? ""), purpose: String(b.purpose ?? ""), locale, promotionalText: text, screenshotSetId: typeof b.screenshotSetId === "string" ? b.screenshotSetId : null, campaigns }, { now: new Date(), auto: f.settings.autonomy.tests === "auto" });
        return { file: r.file, result: null };
      } catch (err) {
        throw fail(err);
      }
    });
    return json(await storeView(app, t), { status: 201 });
  });

  route("POST", "/api/apps/:id/store/pages/:pid", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const d = await storeDeps(t, app);
    await d.store.update(app.id, (f) => {
      const x = f.customPages.find((y) => y.id === p.pid);
      if (!x) throw httpError(404, "No such page.");
      if (x.status !== "waiting_approval") throw httpError(409, `This page is already ${x.status}.`);
      if (b.approve === true) x.status = "draft";
      else {
        f.customPages = f.customPages.filter((y) => y.id !== x.id);
        void declined(t, app, "store.page", x.name, b.reason, `the custom product page “${x.name}”`, x.id);
      }
      return { file: f, result: null };
    });
    return json(await storeView(app, t));
  });

  /** Read new reviews and draft replies now (otherwise every 6 hours). */
  route("POST", "/api/apps/:id/store/reviews/refresh", async (_req, p, t) => {
    const app = await storeApp(t, p.id!);
    const d = { ...(await storeDeps(t, app)), paid: inRequest };
    await k.runWithCredits(t, app, "content_generation", "Store reviews", 1, () => reviewsPass(d));
    return json(await storeView(app, t));
  });

  /** Send a reply (as drafted, or edited), or skip the review. */
  route("POST", "/api/apps/:id/store/reviews/:store/:rid", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    if (p.store !== "ios" && p.store !== "android") throw httpError(404, "Unknown store.");
    const b = await body(req);
    const d = await storeDeps(t, app);
    const by = await who(t);
    const all = await d.store.reviews(app.id);
    const r = all.find((x) => x.store === p.store && x.id === p.rid);
    if (!r) throw httpError(404, "No such review.");
    if (r.existingReply && r.reply?.state !== "failed") throw httpError(409, "This review already has a reply.");
    const max = p.store === "android" ? 350 : 5970;
    let next: StoreReview;
    if (b.skip === true) next = { ...r, reply: { text: r.reply?.text ?? "", state: "skipped", by, at: new Date().toISOString(), sentAt: null, error: null } };
    else {
      const text = typeof b.text === "string" ? b.text.trim() : (r.reply?.text ?? "");
      if (!text) throw httpError(400, "Write a reply first.");
      if (text.length > max) throw httpError(400, `${STORE_NAME[p.store]} replies are at most ${max} characters.`);
      next = { ...r, reply: { text, state: "pending", by, at: new Date().toISOString(), sentAt: null, error: null } };
    }
    const sent = await sendPending(d, [next]);
    await d.store.saveReviews(app.id, all.map((x) => (x.store === r.store && x.id === r.id ? sent.reviews[0]! : x)));
    const view = await storeView(app, t);
    const failed = sent.reviews[0]!.reply?.state === "failed";
    return json({ ...view, sendError: failed ? (sent.reviews[0]!.reply?.error ?? "The store didn't take the reply.") : null });
  });
}

export type StoreView = Awaited<ReturnType<typeof storeView>>;
export type { StoreFile };
