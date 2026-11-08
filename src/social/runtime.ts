import { join, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { hasStores, refreshAppLinks, smartLink, storeScreenshots } from "../ads/app-links";
import { ensureLocalSecretsKey } from "../ads/connections";
import { CONNECTS } from "../ads/registry";
import { creatorKitFor } from "../creative/kit";
import { META_API_VERSION } from "../ads/platforms/meta";
import type { Tokens } from "../ads/connect/types";
import { authConfig } from "../auth";
import { AUTONOMY_CONFIG_FILENAME, loadAutonomyConfig, socialAutoPublish } from "../autonomy-config";
import { researchSocialTrends, type SocialTrendInsight } from "../competitor-feed";
import { creditsForCost, recordCharge } from "../credits";
import { loadAllocatorState } from "../growth-allocator";
import { dataDir } from "../day2-paths";
import { db } from "../db";
import { appKind } from "../field-work";
import { GROWTH_CONFIG_FILENAME, loadGrowthConfig } from "../growth-config";
import { checkAuthenticity, checkTruthfulClaims } from "../growth-creative";
import { recordGrowthAction } from "../growth-feed";
import { deriveGrowthStrategy } from "../growth-strategy";
import { resolveStageSignals } from "../stage-signals";
import { recordOutcome, workedLines } from "../learning/runtime";
import { categorize } from "../learning/taxonomy";
import { loadResearch, MARKET_RESEARCH_FILENAME } from "../market-research";
import { chargedRunner, proposalContext, type CreditRunner } from "../memory/runtime";
import { numbersStoreFor } from "../numbers/store";
import { APP_PROFILE_FILENAME, loadAppProfile, type AppProfile } from "../onboarding";
import { loadSpendLedger } from "../spend-governance";
import { assetStore, fieldStore, serverMode, type Tenant } from "../tenant";
import { tmpdir } from "node:os";
import { draftPosts, runSocialWriter, WRITE_MAX_USD } from "./make";
import { listPublishPages, NEEDED_SCOPES } from "./meta";
import { socialPass, type PassReport } from "./pass";
import { guessLanguage, loadSocialState, SOCIAL_FILENAME, updateSocialState } from "./state";
import { dbMediaLinks, dbSocialAccounts, dbSocialPosts, fileMediaLinks, fileSocialAccounts, fileSocialPosts, type MediaLinkStore, type SocialAccount, type SocialAccountStore, type SocialPostStore } from "./store";
import { tiktokContentApp } from "./tiktok";
import type { Post, SocialPlatform, Target } from "./types";

/** The stores for this server's mode. */
export function socialAccounts(): SocialAccountStore {
  if (serverMode() === "accounts") return dbSocialAccounts(db());
  ensureLocalSecretsKey(join(dataDir(), ".day2-secrets-key"));
  return fileSocialAccounts(join(dataDir(), ".day2-social-accounts.json"));
}
export const socialPosts = (): SocialPostStore => (serverMode() === "accounts" ? dbSocialPosts(db()) : fileSocialPosts(join(dataDir(), "social", "posts.json")));
export const mediaLinks = (): MediaLinkStore => (serverMode() === "accounts" ? dbMediaLinks(db()) : fileMediaLinks(join(dataDir(), "social", "media-links.json")));

export const statePathOf = (app: Pick<AppEntry, "repoPath">) => resolve(app.repoPath, SOCIAL_FILENAME);
const allocatorPathOf = (app: Pick<AppEntry, "repoPath">) => resolve(app.repoPath, "day2-allocator-state.json");

/** Meta: day2's app on this server (META_APP_ID / META_APP_SECRET), for the Graph calls. */
export function metaApp(env: Record<string, string | undefined> = process.env): { appSecret?: string; apiVersion: string } | null {
  const app = CONNECTS.meta.appCredentials(env);
  return app ? { appSecret: app.appSecret, apiVersion: app.apiVersion ?? META_API_VERSION } : null;
}

/** What each connected account can publish (from the permissions the owner granted). Pure. */
export function capabilities(accounts: SocialAccount[]): Record<SocialPlatform, { connected: boolean; canPost: boolean; canRead: boolean; missing: string[] }> {
  const meta = accounts.find((a) => a.network === "meta");
  const tt = accounts.find((a) => a.network === "tiktok");
  const scopes = new Set(meta?.network === "meta" ? meta.meta.scopes : []);
  const miss = (need: readonly string[]) => need.filter((s) => !scopes.has(s));
  const igMissing = meta?.network === "meta" ? [...miss(NEEDED_SCOPES.instagram), ...(meta.meta.igUserId ? [] : ["an Instagram professional account linked to the Page"])] : ["Facebook sign-in"];
  const fbMissing = meta ? miss(NEEDED_SCOPES.facebook) : ["Facebook sign-in"];
  const ttScopes = new Set(tt?.network === "tiktok" ? tt.meta.scopes : []);
  const ttMissing = tt ? ["video.publish", "video.upload"].filter((s) => !ttScopes.has(s)) : ["TikTok sign-in"];
  return {
    instagram: { connected: Boolean(meta), canPost: Boolean(meta) && igMissing.length === 0, canRead: scopes.has("instagram_manage_insights"), missing: igMissing },
    facebook: { connected: Boolean(meta), canPost: Boolean(meta) && fbMissing.length === 0, canRead: scopes.has("read_insights") || scopes.has("pages_read_engagement"), missing: fbMissing },
    tiktok: { connected: Boolean(tt), canPost: Boolean(tt) && ttMissing.length === 0, canRead: ttScopes.has("video.list"), missing: ttMissing },
  };
}

export async function postingPlatforms(app: Pick<AppEntry, "id" | "repoPath">): Promise<SocialPlatform[]> {
  const caps = capabilities(await socialAccounts().forApp(app.id));
  const chosen = loadSocialState(statePathOf(app)).platforms;
  return (Object.keys(caps) as SocialPlatform[]).filter((p) => caps[p].canPost && (!chosen || chosen.includes(p)));
}

/**
 * After the owner's Facebook sign-in: the Page (and its Instagram account)
 * day2 posts as, with its Page access token (kept encrypted). With a
 * long-lived user token, Meta's Page token doesn't expire.
 */
export async function connectMetaPage(appId: string, tokens: Tokens, pageId: string, by: string | null, deps = {}): Promise<SocialAccount> {
  const app = metaApp();
  if (!app) throw new Error("Meta isn't set up on this server yet (META_APP_ID, META_APP_SECRET).");
  const pages = await listPublishPages(tokens.accessToken, app, deps);
  const page = pages.find((p) => p.pageId === pageId);
  if (!page) throw new Error("That Page isn't available to this Facebook sign-in.");
  if (!page.canPost) throw new Error("This Facebook account can't post on that Page — sign in as someone who manages it.");
  return socialAccounts().save({ appId, network: "meta", meta: { pageId: page.pageId, pageName: page.name, igUserId: page.ig?.id ?? null, igUsername: page.ig?.username ?? null, igAccountType: null, scopes: tokens.scopes ?? [] }, tokens: { pageToken: page.pageToken }, connectedBy: by });
}

/** Competitor names day2's research found for the app (the safety check keeps them out of posts). */
export function competitorsOf(app: Pick<AppEntry, "repoPath">): string[] {
  try {
    const research = loadResearch(resolve(app.repoPath, MARKET_RESEARCH_FILENAME));
    return [...new Set(research.runs.flatMap((r) => r.findings.map((f) => f.competitor)).filter(Boolean))];
  } catch {
    return [];
  }
}

/** The only links a post may contain: the app's smart link and its own website. */
export function allowedLinksOf(app: Pick<AppEntry, "id" | "appBaseUrl">): string[] {
  return [smartLink(authConfig().publicUrl, app.id), ...(app.appBaseUrl ? [app.appBaseUrl] : [])];
}

/** The app's profile, or null before onboarding. */
export function profileOf(app: Pick<AppEntry, "repoPath">): AppProfile | null {
  try {
    return loadAppProfile(resolve(app.repoPath, APP_PROFILE_FILENAME));
  } catch {
    return null;
  }
}

export function languageOf(app: Pick<AppEntry, "repoPath">, profile: AppProfile | null): string {
  return loadSocialState(statePathOf(app)).language ?? guessLanguage([profile?.targetUsers, profile?.purpose, profile?.brand?.audience.primary, ...(profile?.brand?.voice.sampleLines ?? [])]);
}

/** social_content posts a week from the app's growth strategy (usage from day2's field data; the launch stage's 3 when there is none yet). */
async function postsPerWeek(app: AppEntry, profile: AppProfile): Promise<number> {
  const config = loadGrowthConfig(resolve(app.repoPath, GROWTH_CONFIG_FILENAME));
  const signals = await resolveStageSignals({ store: fieldStore(), appId: app.id, appBaseUrl: app.appBaseUrl });
  const s = deriveGrowthStrategy(config.budget, profile, signals, config.kpiGoals);
  return s.allocations.find((a) => a.channel === "social_content")?.frequencyPerWeek ?? 3;
}

const TRENDS_EVERY_MS = 7 * 86_400_000;
const TRENDS_MAX_USD = 0.8;

/** The deps of one social pass for an app, with day2's real tools. */
export async function socialPassDeps(tenant: Tenant, app: AppEntry, run: CreditRunner = chargedRunner(tenant, app)) {
  const profile = profileOf(app);
  const statePath = statePathOf(app);
  const posts = socialPosts();
  const accounts = socialAccounts();
  const links = mediaLinks();
  const config = loadGrowthConfig(resolve(app.repoPath, GROWTH_CONFIG_FILENAME));
  const platforms = profile ? await postingPlatforms(app) : [];
  const language = languageOf(app, profile);
  const pub = authConfig().publicUrl;
  const storeApp = appKind(app.repoPath) === "react-native";
  const appLinks = storeApp ? await refreshAppLinks(app.repoPath, new Date()).catch(() => null) : null;
  const link = appLinks && hasStores(appLinks) ? smartLink(pub, app.id) : (app.appBaseUrl ?? null);
  const meta = metaApp();
  const tiktok = tiktokContentApp();
  const auditFile = resolve(app.repoPath, "day2-growth-actions.jsonl");
  return {
    profile,
    deps: {
      posts,
      statePath,
      platforms,
      perWeek: profile ? await postsPerWeek(app, profile).catch(() => 3) : 0,
      killSwitch: config.budget.killSwitch,
      draft: async () => {
        if (!profile) throw new Error("day2 needs the app's profile first (finish onboarding).");
        const ctx = await proposalContext(app, "social", ["social.post"]);
        if (ctx.blocked.blocked) return { posts: [], dropped: `you asked day2 not to make posts (${ctx.blocked.why})`, arm: null, costUsd: 0 };
        // Trends, at most weekly (credits).
        let state = loadSocialState(statePath);
        if (!state.trends || Date.now() - Date.parse(state.trends.at) > TRENDS_EVERY_MS) {
          const items = await run("scan_answer", "Social trends (autopilot)", TRENDS_MAX_USD, () => researchSocialTrends(categorize(profile.purpose, profile.targetUsers), platforms.includes("tiktok") ? ["tiktok", "instagram"] : ["instagram"]))
            .then((r) => r.result)
            .catch(() => [] as SocialTrendInsight[]);
          state = updateSocialState(statePath, (s) => ({ ...s, trends: { at: new Date().toISOString(), items } }));
        }
        const competitors = competitorsOf(app);
        const worked = await workedLines(app, "social").catch(() => [] as string[]);
        const autonomy = loadAutonomyConfig(resolve(app.repoPath, AUTONOMY_CONFIG_FILENAME));
        // Each day2-account tool job is charged by the kit right after it runs (a later failure can't lose the charge).
        const creator = await creatorKitFor(tenant.accountId, app, "posts", { billing: { credits: tenant.credits, appId: app.id, appName: app.name } }).catch(() => null);
        const { result, credits } = await run("content_generation", "Social post (autopilot)", WRITE_MAX_USD * 3, () =>
          draftPosts(app, profile, {
            posts,
            assets: assetStore(),
            platforms,
            write: runSocialWriter,
            checks: { truthful: checkTruthfulClaims, authentic: checkAuthenticity },
            screens: async () => (appLinks && hasStores(appLinks) ? await storeScreenshots(appLinks, join(tmpdir(), `day2-social-shots-${app.id}`)).catch(() => []) : []),
            pageUrl: storeApp ? null : (app.appBaseUrl ?? null),
            creator,
            memory: ctx.memory,
            avoid: ctx.avoid,
            worked,
            trends: (state.trends?.items ?? []).slice(0, 4).map((t) => `${t.platform}: ${t.trend} (${t.format})`),
            competitors,
            allowedLinks: allowedLinksOf(app),
            learnings: state.learnings,
            allocator: loadAllocatorState(allocatorPathOf(app)),
            language,
            country: null,
            link: link ? `${link}${link.includes("?") ? "&" : "?"}d2=social.fb` : null,
            autoPublish: socialAutoPublish(autonomy),
            now: new Date(),
          }),
        );
        if (result.costUsd > 0) await recordCharge(tenant.credits, { id: `socialgen:${app.id}:${result.posts[0]?.group ?? Date.now()}`, appId: app.id, service: "content_generation", costUsd: result.costUsd, description: `Social post media${result.posts[0]?.source.tools?.length ? ` (${[...new Set(result.posts[0].source.tools.filter((x) => x.account === "day2").map((x) => x.name))].join(", ")})` : ""}` }).catch(() => null);
        const total = credits + (result.costUsd > 0 ? creditsForCost(result.costUsd, "content_generation") : 0) + (result.prebilledUsd ? creditsForCost(result.prebilledUsd, "content_generation") : 0);
        for (const p of result.posts) await posts.update(app.id, p.id, (x) => ({ ...x, costCredits: Math.round(total / result.posts.length), targets: x.targets.map((t) => (t.platform === "facebook" && link ? { ...t, linkTag: "social.fb" } : t)) }));
        return { ...result, credits: total };
      },
      publish: {
        posts,
        accounts,
        links,
        assets: assetStore(),
        publicUrl: pub,
        meta,
        tiktok,
        budget: config.budget,
        ledger: loadSpendLedger(resolve(app.repoPath, "day2-spend-ledger.jsonl")),
        onPublished: (post: Post, t: Target) => feedRecord(auditFile, app, post, t),
      },
      feedback: {
        posts,
        accounts,
        meta,
        tiktok,
        allocatorPath: allocatorPathOf(app),
        statePath,
        learn: (r: Parameters<NonNullable<import("./feedback").FeedbackDeps["learn"]>>[0]) => recordOutcome(app, { kind: r.kind, pattern: r.pattern, metric: "engagement_rate", effect: r.effect, n: r.n, verdict: r.verdict, source: "social", sourceId: r.sourceId }, { accountId: tenant.accountId }),
        clicks: async (tag: string, since: string) => (await fieldStore().events(app.id, new Date(since))).filter((e) => (e as { type?: string }).type === "store_click" && (e as { acquisition?: { campaignId?: string } }).acquisition?.campaignId === tag).length,
        installs: async () => {
          const doc = await numbersStoreFor(app).load(app.id);
          const out: Record<string, number> = {};
          for (const key of ["ios.downloads", "android.installs"] as const) for (const [day, v] of Object.entries(doc.series[key] ?? {})) out[day] = (out[day] ?? 0) + (v?.v ?? 0);
          return out;
        },
      },
    },
  };
}

function feedRecord(auditFile: string, app: AppEntry, post: Post, t: Target): void {
  try {
    const creative = { arm: { channel: "social_content" as const, assetType: post.kind, formatTag: post.source.arm }, segment: "", headline: post.idea.title, body: t.caption, claimsCheckedAgainst: [], costUsd: 0 };
    recordGrowthAction(auditFile, {
      timestamp: new Date().toISOString(),
      creativeId: `${post.id}:${t.format}`,
      appId: app.id,
      strategy: { stage: "launch", channel: "social_content" },
      arm: creative.arm,
      toolUsed: null,
      frequency: `${t.format} on ${t.platform}`,
      spend: { requested: 0, allowed: true, runningMonthlyTotalUsd: 0, monthlyBudgetUsd: 0 },
      claimsCheck: { creative, truthful: post.safety.ok, issues: post.safety.issues },
      authenticityCheck: { creative, readsAsGeneric: false, matchedPatterns: [], suggestion: "" },
      executionResult: "executed",
    });
  } catch {
    /* the feed is best-effort */
  }
}

/** The social pass for one app (autopilot timer). */
export async function socialPassFor(tenant: Tenant, app: AppEntry, opts: { make?: boolean } = {}): Promise<PassReport | null> {
  if (!(await socialAccounts().forApp(app.id)).length && !(await socialPosts().list(app.id, { limit: 1 })).length) return null;
  const { deps } = await socialPassDeps(tenant, app);
  return socialPass(app.id, opts.make === false ? { ...deps, perWeek: 0 } : deps);
}
