import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { startConnect } from "../ads/connect-flow";
import { authConfig } from "../auth";
import { AUTONOMY_CONFIG_FILENAME, loadAutonomyConfig, saveAutonomyConfig, setSocialAutoPublish, socialAutoPublish } from "../autonomy-config";
import type { CreditService } from "../credits";
import { GROWTH_CONFIG_FILENAME, loadGrowthConfig } from "../growth-config";
import { noteDecline, noteOwnerInput, captureSoon, chargedRunner } from "../memory/runtime";
import { adConnections, assetStore, platformIdentities, type Tenant } from "../tenant";
import { createHash, randomBytes } from "node:crypto";
import { checkPost, cleanHashtags } from "./safety";
import { allowedLinksOf, capabilities, competitorsOf, connectMetaPage, languageOf, mediaLinks, metaApp, profileOf, socialAccounts, socialPassDeps, socialPosts, statePathOf } from "./runtime";
import { listPublishPages } from "./meta";
import { socialPass } from "./pass";
import { loadSocialState, logLine, updateSocialState } from "./state";
import { MEDIA_TOKEN_RE, type SocialAccount } from "./store";
import { creatorInfo, exchangeTikTokCode, TIKTOK_CALLBACK, tiktokAccessToken, TIKTOK_CONTENT_ENV, tiktokAuthorizeUrl, tiktokChoiceProblem, tiktokContentApp, type CreatorInfo } from "./tiktok";
import { contentHash, FORMAT_LABEL, SOCIAL_PLATFORMS, type Post, type SocialPlatform, type TikTokChoices } from "./types";
import { socialArm } from "./make";
import { checkTruthfulClaims } from "../growth-creative";

const CLAIMS_MAX_USD = 0.3;
let claimsChecker: typeof checkTruthfulClaims = checkTruthfulClaims;
/** Tests: replace day2's claims check (an agent run) with a fake. */
export function setSocialClaimsCheck(fn: typeof checkTruthfulClaims | null): void {
  claimsChecker = fn ?? checkTruthfulClaims;
}

/**
 * The Social API (/api/apps/:id/social/*), registered from api-server.ts.
 * Every route is scoped to an app of the signed-in account (requireApp);
 * connecting, settings and approving need an owner or admin. Tokens never
 * leave the server.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;

export type SocialRouteHelpers = {
  json: (data: unknown, init?: ResponseInit) => Response;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
  actorName: (t: Tenant) => Promise<string | undefined>;
  runWithCredits: <T>(t: Tenant, app: AppEntry, service: CreditService, description: string, maxCostUsd: number, fn: () => Promise<T>) => Promise<{ result: T; credits: number }>;
  httpError: (status: number, message: string) => Error;
};

const BIND_COOKIE = "day2_tiktok_bind";
const BIND_MAX_AGE = 30 * 60;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function bindCookie(appId: string, value: string, maxAge: number): string {
  const secure = authConfig().consoleUrl.startsWith("https://") ? "; Secure" : "";
  return `${BIND_COOKIE}=${value}; Path=/api/apps/${encodeURIComponent(appId)}/social/connect/tiktok; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}
function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const callbackUrl = (name: string) => `${authConfig().publicUrl}/api/ads/connect/callback/${name}`;
const PLATFORM_NAME: Record<SocialPlatform, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok" };

/** What the operator still has to set up on this server for social posting. */
export function socialServerSetup(env: Record<string, string | undefined> = process.env) {
  const pub = authConfig().publicUrl;
  return {
    meta: { ready: Boolean(metaApp(env)), missingEnv: ["META_APP_ID", "META_APP_SECRET"].filter((k) => !env[k]?.trim()), redirectUri: callbackUrl("meta") },
    tiktok: { ready: Boolean(tiktokContentApp(env)), missingEnv: TIKTOK_CONTENT_ENV.filter((k) => !env[k]?.trim()), redirectUri: callbackUrl(TIKTOK_CALLBACK) },
    publicUrl: { ready: /^https:\/\//.test(pub) && !/localhost|127\.0\.0\.1/.test(pub), value: pub },
  };
}

function postView(app: AppEntry, p: Post) {
  const media = (id: string | null | undefined) => (id ? `/api/apps/${encodeURIComponent(app.id)}/social/media/${encodeURIComponent(id)}` : null);
  return {
    id: p.id,
    group: p.group,
    status: p.status,
    kind: p.kind,
    language: p.language,
    idea: p.idea,
    arm: p.source.arm,
    /** "Made with Runway": the creator tools behind the media, and whose account (own = billed by the tool, not in credits). */
    madeWith: (p.source.tools ?? []).map((t) => ({ tool: t.tool, name: t.name, capability: t.capability, account: t.account })),
    scheduledAt: p.scheduledAt,
    timeWhy: p.timeWhy,
    safety: p.safety,
    tiktok: p.tiktok ?? null,
    approvedBy: p.approvedBy ?? null,
    approvedAt: p.approvedAt ?? null,
    declinedReason: p.declinedReason ?? null,
    costCredits: p.costCredits,
    boostCandidate: Boolean(p.boostCandidate),
    installEstimate: p.installEstimate ?? null,
    createdAt: p.createdAt,
    targets: p.targets.map((t) => ({
      platform: t.platform,
      format: t.format,
      label: FORMAT_LABEL[t.format],
      mediaUrl: media(t.assetId),
      coverUrl: media(t.coverAssetId),
      caption: t.caption,
      hashtags: t.hashtags,
      status: t.status,
      permalink: t.permalink ?? null,
      publishedAt: t.publishedAt ?? null,
      error: t.error ?? null,
      note: t.note ?? null,
      attempts: t.attempts,
      nextAttemptAt: t.nextAttemptAt ?? null,
      metrics: t.metrics,
    })),
  };
}

function accountView(a: SocialAccount | undefined) {
  if (!a) return null;
  return a.network === "meta"
    ? { network: "meta" as const, pageName: a.meta.pageName, pageId: a.meta.pageId, instagram: a.meta.igUsername ?? (a.meta.igUserId ? "linked" : null), connectedBy: a.connectedBy, connectedAt: a.connectedAt }
    : { network: "tiktok" as const, nickname: a.meta.nickname, username: a.meta.username, connectedBy: a.connectedBy, connectedAt: a.connectedAt };
}

export async function socialView(app: AppEntry) {
  const accounts = await socialAccounts().forApp(app.id);
  const caps = capabilities(accounts);
  const state = loadSocialState(statePathOf(app));
  const autonomy = loadAutonomyConfig(resolve(app.repoPath, AUTONOMY_CONFIG_FILENAME));
  const posts = await socialPosts().list(app.id, { limit: 100 });
  const setup = socialServerSetup();
  const now = Date.now();
  const rank = (t: Partial<Record<string, { posts: number; score: number }>>) =>
    Object.entries(t)
      .filter(([, s]) => s && s.posts >= 2)
      .map(([k, s]) => ({ key: k, posts: s!.posts, score: Math.round((s!.score / s!.posts) * 100) / 100 }))
      .sort((a, b) => b.score - a.score);
  return {
    unverified: "Publishing is built from Meta's and TikTok's documentation and tested against fakes; it hasn't been run against real accounts yet.",
    setup,
    connections: { meta: accountView(accounts.find((a) => a.network === "meta")), tiktok: accountView(accounts.find((a) => a.network === "tiktok")) },
    platforms: SOCIAL_PLATFORMS.map((p) => ({
      id: p,
      name: PLATFORM_NAME[p],
      ...caps[p],
      serverReady: p === "tiktok" ? setup.tiktok.ready : setup.meta.ready,
      on: !state.platforms || state.platforms.includes(p),
    })),
    settings: { autoPublish: socialAutoPublish(autonomy), paused: state.paused, platforms: state.platforms, language: languageOf(app, profileOf(app)) },
    killSwitch: loadGrowthConfig(resolve(app.repoPath, GROWTH_CONFIG_FILENAME)).budget.killSwitch,
    summary: {
      waiting: posts.filter((p) => p.status === "waiting_approval").length,
      held: posts.filter((p) => p.status === "draft").length,
      scheduled: posts.filter((p) => p.status === "approved" || p.status === "publishing").length,
      publishedThisWeek: posts.filter((p) => p.status === "published" && p.targets.some((t) => t.publishedAt && now - Date.parse(t.publishedAt) < 7 * 86_400_000)).length,
      boostCandidates: posts.filter((p) => p.boostCandidate).length,
    },
    learnings: { hooks: rank(state.learnings.hooks), topics: rank(state.learnings.topics), formats: rank(state.learnings.formats) },
    posts: posts.map((p) => postView(app, p)),
    log: state.log.slice(0, 20),
  };
}

function choicesFrom(v: unknown, prev: TikTokChoices | null | undefined): TikTokChoices {
  const b = (v ?? {}) as Record<string, unknown>;
  const bool = (k: keyof TikTokChoices, d: boolean) => (typeof b[k] === "boolean" ? (b[k] as boolean) : d);
  return {
    privacyLevel: typeof b.privacyLevel === "string" && /^[A-Z_]{4,40}$/.test(b.privacyLevel) ? b.privacyLevel : (prev?.privacyLevel ?? null),
    allowComment: bool("allowComment", prev?.allowComment ?? false),
    allowDuet: bool("allowDuet", prev?.allowDuet ?? false),
    allowStitch: bool("allowStitch", prev?.allowStitch ?? false),
    disclose: bool("disclose", prev?.disclose ?? false),
    yourBrand: bool("yourBrand", prev?.yourBrand ?? false),
    brandedContent: bool("brandedContent", prev?.brandedContent ?? false),
    // Set by day2 from how the video was made; the owner can't turn the AI label off.
    isAigc: prev?.isAigc ?? false,
  };
}

function creatorView(c: CreatorInfo) {
  return { nickname: c.nickname, username: c.username, avatarUrl: c.avatarUrl, privacyOptions: c.privacyOptions, commentDisabled: c.commentDisabled, duetDisabled: c.duetDisabled, stitchDisabled: c.stitchDisabled, maxVideoSeconds: c.maxVideoSeconds, privateOnly: c.privateOnly };
}

export function registerSocialRoutes(route: (method: string, pathname: string, handler: Handler, opts?: { public?: boolean }) => void, h: SocialRouteHelpers): void {
  const fail = h.httpError;
  const who = async (t: Tenant) => (await h.actorName(t)) ?? null;

  route("GET", "/api/apps/:id/social", async (_req, p, t) => h.json(await socialView(await h.requireApp(t, p.id!))));

  /** Settings: "Posts go out on their own" (autonomy), pause (kill switch for Social), platforms, language. */
  route("PUT", "/api/apps/:id/social/settings", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = await body(req);
    if (typeof b.autoPublish === "boolean") {
      const path = resolve(app.repoPath, AUTONOMY_CONFIG_FILENAME);
      saveAutonomyConfig(path, setSocialAutoPublish(loadAutonomyConfig(path), b.autoPublish));
    }
    updateSocialState(statePathOf(app), (s) => {
      let n = { ...s };
      if (typeof b.paused === "boolean") n = logLine({ ...n, paused: b.paused }, b.paused ? "Social paused: nothing is made or posted." : "Social is running again.");
      if (b.platforms === null) n.platforms = null;
      else if (Array.isArray(b.platforms)) n.platforms = b.platforms.filter((x): x is SocialPlatform => (SOCIAL_PLATFORMS as readonly string[]).includes(x as string));
      if (typeof b.language === "string" && /^[a-z]{2}$/.test(b.language)) n.language = b.language;
      if (typeof b.autoPublish === "boolean") n = logLine(n, b.autoPublish ? "Posts now go out on their own (TikTok still asks)." : "Every post now waits for your OK.");
      return n;
    });
    return h.json(await socialView(app));
  });

  // ---- Connecting: Facebook (Instagram + Page) and TikTok, the owner's own accounts.

  route("POST", "/api/apps/:id/social/connect/meta", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    try {
      return h.json(await startConnect({ store: adConnections(), identities: platformIdentities() }, { platform: "meta", scope: { appId: app.id }, purpose: "social", appId: app.id, by: await who(t), callbackUrl: callbackUrl("meta") }));
    } catch (err) {
      throw fail(409, (err as Error).message);
    }
  });

  route("GET", "/api/apps/:id/social/connect/meta/:pending", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const pend = await adConnections().pending(p.pending!);
    const m = metaApp();
    if (!pend?.tokens || pend.appId !== app.id || pend.platform !== "meta" || !m) throw fail(410, "That sign-in expired — connect again.");
    const pages = await listPublishPages(pend.tokens.accessToken, m).catch((err: Error) => {
      throw fail(502, err.message);
    });
    const granted = new Set(pend.tokens.scopes ?? []);
    return h.json({ pages: pages.map((x) => ({ pageId: x.pageId, name: x.name, instagram: x.ig ? (x.ig.username ? `@${x.ig.username}` : "linked") : null, canPost: x.canPost })), declined: ["instagram_content_publish", "pages_manage_posts"].filter((s) => !granted.has(s)) });
  });

  route("POST", "/api/apps/:id/social/connect/meta/:pending", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = await body(req);
    const pend = await adConnections().pending(p.pending!);
    if (!pend?.tokens || pend.appId !== app.id || pend.platform !== "meta") throw fail(410, "That sign-in expired — connect again.");
    if (typeof b.pageId !== "string" || !/^\d{5,25}$/.test(b.pageId)) throw fail(400, "Pick a Page.");
    try {
      const a = await connectMetaPage(app.id, pend.tokens, b.pageId, await who(t));
      await adConnections().endPending(pend.id);
      updateSocialState(statePathOf(app), (s) => logLine(s, `Connected ${a.network === "meta" ? a.meta.pageName : "Facebook"}${a.network === "meta" && a.meta.igUsername ? ` and Instagram @${a.meta.igUsername}` : ""}.`));
    } catch (err) {
      throw fail(409, (err as Error).message);
    }
    return h.json(await socialView(app));
  });

  /**
   * TikTok sign-in, bound to who started it: the state's pending row keeps a
   * hash of a random value set as a short-lived HttpOnly cookie on this
   * browser, and (with accounts) the signed-in user. TikTok's callback only
   * parks the code; the console then finishes from the same browser and
   * session, where both are checked.
   */
  route("POST", "/api/apps/:id/social/connect/tiktok", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const tt = tiktokContentApp();
    if (!tt) throw fail(409, `TikTok posting can't be connected on this server yet: day2's TikTok app keys (${TIKTOK_CONTENT_ENV.join(", ")}) aren't set.`);
    const state = randomBytes(24).toString("base64url");
    const binder = randomBytes(24).toString("base64url");
    await adConnections().startPending({ state, scope: { appId: app.id }, platform: "tiktok", purpose: "social", appId: app.id, pending: { bind: sha(binder), user: t.session?.user.id ?? "" }, createdBy: await who(t) });
    return h.json({ url: tiktokAuthorizeUrl(tt, { state, redirectUri: callbackUrl(TIKTOK_CALLBACK) }) }, { headers: { "set-cookie": bindCookie(app.id, binder, BIND_MAX_AGE) } });
  });

  /** TikTok sends the owner back here (public; registered before the ads callback, whose pattern it shares). Parks the code only. */
  route(
    "GET",
    `/api/ads/connect/callback/${TIKTOK_CALLBACK}`,
    async (req) => {
      const q = new URL(req.url).searchParams;
      const consoleUrl = authConfig().consoleUrl;
      const pend = q.get("state") ? await adConnections().pendingByState(q.get("state")!) : null;
      const page = pend?.appId ? `/apps/${encodeURIComponent(pend.appId)}/social` : "/";
      const back = (qs: string) => Response.redirect(`${consoleUrl}${page}?${qs}`, 302);
      try {
        if (!pend || pend.platform !== "tiktok" || pend.purpose !== "social" || !pend.appId || !pend.pending?.bind || pend.pending.code) throw new Error("That sign-in expired — connect TikTok again.");
        if (q.get("error")) throw new Error(`TikTok said: ${q.get("error_description") ?? q.get("error")}`);
        const code = q.get("code");
        if (!code) throw new Error("TikTok didn't send a sign-in code.");
        await adConnections().setPendingData(pend.id, { ...pend.pending, code: code.slice(0, 500) });
        return back(`ttconnect=${encodeURIComponent(pend.id)}`);
      } catch (err) {
        if (pend) await adConnections().endPending(pend.id).catch(() => {});
        return back(`connectError=${encodeURIComponent((err as Error).message.slice(0, 300))}&platform=tiktok`);
      }
    },
    { public: true },
  );

  /** Finishes the TikTok sign-in from the browser (and session) that started it. */
  route("POST", "/api/apps/:id/social/connect/tiktok/finish", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = await body(req);
    const pend = typeof b.pending === "string" ? await adConnections().pending(b.pending) : null;
    const binder = cookieValue(req, BIND_COOKIE);
    const clear = { "set-cookie": bindCookie(app.id, "", 0) };
    if (!pend || pend.platform !== "tiktok" || pend.purpose !== "social" || pend.appId !== app.id || !pend.pending?.code || !pend.pending.bind) throw fail(410, "That sign-in expired — connect TikTok again.");
    if (!binder || sha(binder) !== pend.pending.bind || (pend.pending.user ?? "") !== (t.session?.user.id ?? "")) throw fail(403, "This TikTok sign-in was started somewhere else — connect TikTok again from here.");
    await adConnections().endPending(pend.id); // single use
    const tt = tiktokContentApp();
    if (!tt) throw fail(409, "TikTok posting isn't set up on this server.");
    try {
      const r = await exchangeTikTokCode(tt, { code: pend.pending.code, redirectUri: callbackUrl(TIKTOK_CALLBACK) });
      const info = await creatorInfo(tt, r.tokens.accessToken).catch(() => null);
      await socialAccounts().save({ appId: app.id, network: "tiktok", meta: { openId: r.openId, nickname: info?.nickname ?? "TikTok", username: info?.username ?? null, scopes: r.scopes }, tokens: r.tokens, connectedBy: pend.createdBy });
      updateSocialState(statePathOf(app), (s) => logLine(s, `Connected TikTok${info?.nickname ? ` (${info.nickname})` : ""}.`));
    } catch (err) {
      throw fail(502, (err as Error).message);
    }
    return h.json(await socialView(app), { headers: clear });
  });

  route("DELETE", "/api/apps/:id/social/accounts/:network", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    if (p.network !== "meta" && p.network !== "tiktok") throw fail(404, "Unknown account.");
    await socialAccounts().remove(app.id, p.network);
    updateSocialState(statePathOf(app), (s) => logLine(s, `Disconnected ${p.network === "meta" ? "Instagram and Facebook" : "TikTok"}.`));
    return h.json(await socialView(app));
  });

  /** Fresh TikTok creator info — TikTok requires it each time the post form is shown. */
  route("GET", "/api/apps/:id/social/tiktok/creator", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    const a = await socialAccounts().get(app.id, "tiktok");
    const tt = tiktokContentApp();
    if (!a || a.network !== "tiktok" || !tt) throw fail(409, "TikTok isn't connected.");
    try {
      return h.json(creatorView(await creatorInfo(tt, await tiktokAccessToken(app.id, socialAccounts(), tt))));
    } catch (err) {
      throw fail(502, (err as Error).message);
    }
  });

  // ---- Posts

  /** Make a post now (instead of waiting for the autopilot). */
  route("POST", "/api/apps/:id/social/posts/make", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const { deps, profile } = await socialPassDeps(t, app, (service, description, max, fn) => h.runWithCredits(t, app, service, description, max, fn));
    if (!profile) throw fail(409, "day2 needs the app's profile first (finish onboarding).");
    if (!deps.platforms.length) throw fail(409, "Connect Instagram, Facebook or TikTok first.");
    if (deps.killSwitch || loadSocialState(statePathOf(app)).paused) throw fail(409, "Social is paused (or the kill switch is on).");
    const r = await deps.draft();
    updateSocialState(statePathOf(app), (s) => logLine({ ...s, lastMadeAt: new Date().toISOString() }, r.posts.length ? "Made a new post on request." : `No post this time: ${r.dropped ?? "nothing usable"}.`));
    return h.json({ made: r.posts.length, dropped: r.dropped, social: await socialView(app) });
  });

  /**
   * Edit the words per platform, the time, or TikTok's choices. Runs the
   * safety check again — and day2's claims check on changed words (kept as
   * an issue until it passes). A content change on an approved post sends it
   * back to the owner; a new time alone keeps the approval.
   */
  route("PATCH", "/api/apps/:id/social/posts/:post", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = await body(req);
    const by = await who(t);
    const cur = await socialPosts().get(app.id, p.post!);
    if (!cur) throw fail(404, "No such post.");
    if (cur.status === "published" || cur.status === "publishing" || cur.status === "declined" || cur.status === "failed") throw fail(409, "This post can't be changed any more.");
    const next = structuredClone(cur);
    const edits: Array<{ before: string; after: string }> = [];
    if (Array.isArray(b.targets))
      for (const x of b.targets as Array<Record<string, unknown>>) {
        const tg = next.targets.find((y) => y.format === x.format);
        if (!tg) continue;
        if (typeof x.caption === "string" && x.caption.trim().slice(0, 2200) !== tg.caption) {
          edits.push({ before: tg.caption, after: x.caption.trim().slice(0, 2200) });
          tg.caption = x.caption.trim().slice(0, 2200);
        }
        if (Array.isArray(x.hashtags)) tg.hashtags = cleanHashtags(x.hashtags, 30);
      }
    if (typeof b.scheduledAt === "string") {
      const at = Date.parse(b.scheduledAt);
      if (!Number.isFinite(at) || at < Date.now() - 60_000) throw fail(409, "Pick a time in the future.");
      next.scheduledAt = new Date(at).toISOString();
      next.timeWhy = "You picked this time.";
    }
    if (b.tiktok !== undefined && next.tiktok) next.tiktok = choicesFrom(b.tiktok, next.tiktok);
    const changed = contentHash(next) !== contentHash(cur);

    // Claims: re-checked on new words; until a check passes, its findings stay.
    let claims = cur.safety.issues.filter((i) => i.startsWith("Claims check:"));
    const profile = profileOf(app);
    if (edits.length && profile) {
      try {
        const creative = { arm: socialArm(next.source.arm), segment: "", headline: next.idea.title, body: next.targets.map((x) => `${x.caption} ${x.hashtags.map((hh) => `#${hh}`).join(" ")}`).join("\n"), claimsCheckedAgainst: profile.featureMap, costUsd: 0 };
        const { result } = await h.runWithCredits(t, app, "content_generation", "Social claims check (edit)", CLAIMS_MAX_USD, () => claimsChecker(creative, profile));
        claims = [...(result.truthful ? [] : result.issues.map((x) => `Claims check: ${x}`)), ...(result.fabricatesTestimonialIdentity ? ["Claims check: presents itself as a real customer"] : [])];
      } catch (err) {
        claims = [`Claims check: couldn't check the new words yet (${(err as Error).message.slice(0, 120)}) — save again to retry`];
      }
    } else if (edits.length) claims = ["Claims check: couldn't check the new words yet (no app profile) — save again to retry"];
    const issues = [...claims, ...checkPost(next, { appName: app.name, competitors: competitorsOf(app), allowedLinks: allowedLinksOf(app) })];
    next.safety = { ok: issues.length === 0, issues, checkedAt: new Date().toISOString() };
    if (changed && next.status === "approved") {
      next.status = "waiting_approval";
      next.approvedBy = null;
      next.approvedAt = null;
      next.approvedHash = null;
    }
    if (!next.safety.ok) next.status = "draft";
    else if (next.status === "draft") next.status = "waiting_approval";
    next.edited = next.edited || edits.length > 0;

    let problem: string | null = null;
    const updated = await socialPosts().update(app.id, cur.id, (post) => {
      // Someone else (the publisher, another tab) changed it meanwhile: refuse instead of overwriting.
      if (post.updatedAt !== cur.updatedAt || post.status !== cur.status) {
        problem = "This post changed meanwhile — reload and try again.";
        return null;
      }
      return next;
    });
    if (problem) throw fail(409, problem);
    if (!updated) throw fail(404, "No such post.");
    if (edits.length) {
      await noteOwnerInput(app, { kind: "edit", text: "edited a social post's words", before: edits.map((e) => e.before).join(" | "), after: edits.map((e) => e.after).join(" | "), about: "social post caption", ref: { type: "proposal", id: updated.id, url: `/apps/${app.id}/social`, label: "Social post" }, who: by });
    }
    return h.json(await socialView(app));
  });

  /** Approve: the post goes out at its time. TikTok posts need the owner's choices (and fresh creator info). */
  route("POST", "/api/apps/:id/social/posts/:post/approve", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = await body(req);
    const cur = await socialPosts().get(app.id, p.post!);
    if (!cur) throw fail(404, "No such post.");
    if (!cur.safety.ok) throw fail(409, `Fix this first: ${cur.safety.issues[0] ?? "the safety check didn't pass"}.`);
    if (cur.status !== "waiting_approval") throw fail(409, "This post isn't waiting for approval.");
    let choices: TikTokChoices | null = null;
    if (cur.targets.some((x) => x.platform === "tiktok")) {
      choices = choicesFrom(b.tiktok, cur.tiktok);
      const a = await socialAccounts().get(app.id, "tiktok");
      const tt = tiktokContentApp();
      if (!a || a.network !== "tiktok" || !tt) throw fail(409, "TikTok isn't connected.");
      const info = await creatorInfo(tt, await tiktokAccessToken(app.id, socialAccounts(), tt)).catch((err: Error) => {
        throw fail(502, `TikTok: ${err.message}`);
      });
      const problem = tiktokChoiceProblem(choices, info);
      if (problem) throw fail(400, problem);
      const asset = await assetStore().get(cur.targets.find((x) => x.platform === "tiktok")!.assetId);
      if (asset?.durationSec && asset.durationSec > info.maxVideoSeconds) throw fail(409, `This video is ${asset.durationSec}s; your TikTok account can post up to ${info.maxVideoSeconds}s.`);
    }
    const by = await who(t);
    let refused: string | null = null;
    const done = await socialPosts().update(app.id, cur.id, (post) => {
      // Checked again on the stored post: exactly what the owner looked at, still safe, still waiting.
      if (post.status !== "waiting_approval") refused = "This post isn't waiting for approval.";
      else if (!post.safety.ok) refused = `Fix this first: ${post.safety.issues[0] ?? "the safety check didn't pass"}.`;
      else if (post.updatedAt !== cur.updatedAt) refused = "This post changed meanwhile — look at it again.";
      if (refused) return null;
      if (choices) post.tiktok = choices;
      if (typeof b.scheduledAt === "string" && Number.isFinite(Date.parse(b.scheduledAt))) post.scheduledAt = new Date(Math.max(Date.parse(b.scheduledAt), Date.now())).toISOString();
      if (!post.scheduledAt || Date.parse(post.scheduledAt) < Date.now()) post.scheduledAt = new Date(Date.now() + 5 * 60_000).toISOString();
      post.status = "approved";
      post.approvedBy = by ?? "the owner";
      post.approvedAt = new Date().toISOString();
      post.approvedHash = contentHash(post);
      return post;
    });
    if (refused) throw fail(409, refused);
    if (done?.status !== "approved") throw fail(409, "This post isn't waiting for approval.");
    updateSocialState(statePathOf(app), (s) => logLine(s, `Approved a post for ${new Date(done.scheduledAt!).toISOString().slice(0, 16).replace("T", " ")} UTC.`));
    return h.json(await socialView(app));
  });

  /** "Not this one" — with an optional short why (memory: day2 won't propose the same again for 90 days). */
  route("POST", "/api/apps/:id/social/posts/:post/decline", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = await body(req);
    const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : "";
    const done = await socialPosts().update(app.id, p.post!, (post) => {
      if (post.status !== "waiting_approval" && post.status !== "draft" && post.status !== "approved") return null;
      post.status = "declined";
      post.declinedReason = reason || null;
      return post;
    });
    if (!done || done.status !== "declined") throw fail(409, "This post can't be turned down any more.");
    await noteDecline(app, { kind: "social.post", target: `${done.idea.topic}/${done.idea.hook}: ${done.idea.title}`, reason: reason || null, who: await who(t), about: `the social post “${done.idea.title}”`, ref: { type: "proposal", id: done.id, url: `/apps/${app.id}/social`, label: "Social post" } });
    if (reason) captureSoon(app, chargedRunner(t, app));
    return h.json(await socialView(app));
  });

  /** A post's image or video for the console preview (signed in, this app only). */
  route("GET", "/api/apps/:id/social/media/:asset", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    const a = await assetStore().get(p.asset!);
    if (!a || a.appId !== app.id || !existsSync(a.path)) throw fail(404, "Not found.");
    return serveFile(req, a.path, a.mime, "private, max-age=3600");
  });

  /** For tests and a manual nudge from the console: run the app's social pass now. */
  route("POST", "/api/apps/:id/social/run", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const { deps } = await socialPassDeps(t, app, (service, description, max, fn) => h.runWithCredits(t, app, service, description, max, fn));
    const r = await socialPass(app.id, { ...deps, perWeek: 0 });
    return h.json({ published: r.publish?.published ?? [], failed: r.publish?.failed ?? [], social: await socialView(app) });
  });
}

/** Serves a file with Range support (videos). */
export function serveFile(req: Request, path: string, mime: string, cache: string): Response {
  const f = Bun.file(path);
  const size = f.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  const headers = { "content-type": mime, "cache-control": cache, "accept-ranges": "bytes", "x-content-type-options": "nosniff" };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(f.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(f, { headers: { ...headers, "content-length": String(size) } });
}

/** The public media link (/api/assets/sm_…): the asset while the link lasts, else 404. */
export async function serveMediaLink(req: Request, file: string): Promise<Response | null> {
  const token = file.replace(/\.[a-z0-9]+$/, "");
  if (!MEDIA_TOKEN_RE.test(token)) return null;
  const l = await mediaLinks().resolve(token);
  const a = l ? await assetStore().get(l.assetId) : null;
  if (!l || !a || a.appId !== l.appId || !existsSync(a.path)) return new Response(JSON.stringify({ error: "Not found." }), { status: 404, headers: { "content-type": "application/json" } });
  return serveFile(req, a.path, a.mime, "public, max-age=3600");
}
