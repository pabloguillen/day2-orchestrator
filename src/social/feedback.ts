import type { PlatformDeps } from "../ads/types";
import { loadAllocatorState, recordWeightedOutcome, saveAllocatorState } from "../growth-allocator";
import type { Verdict } from "../learning/library";
import type { ChangeKind } from "../learning/taxonomy";
import { socialArm } from "./make";
import { toolArm } from "../creative/select";
import { emptyMetrics, facebookMetrics, instagramMetrics, type MetaPublishCtx } from "./meta";
import { audienceTimeZone, slotOf } from "./schedule";
import { addScore, loadSocialState, updateSocialState } from "./state";
import type { SocialAccountStore, SocialPostStore } from "./store";
import { tiktokAccessToken, tiktokMetrics, type TikTokApp } from "./tiktok";
import type { Metrics, MetricsWindow, Post, SocialArm, Target } from "./types";

/**
 * How posts did, and what day2 does with it (docs/social.md):
 *
 *  - results per post at 24 h, 72 h and 7 days after it went out (reach,
 *    views, likes, comments, shares, saves, follows where the platform
 *    gives them);
 *  - at 72 h: the post's engagement per view feeds the growth allocator's
 *    social_content arm for its format, and this app's own scores for its
 *    opening, topic and time of day (what the next post is built from);
 *  - at 7 days: a result in cross-app learning (fixed words only: format,
 *    opening, topic, time of day — never texts or names), and the posts
 *    that did far better than usual become candidates for paid boosting
 *    (used only once paid ads unlock);
 *  - installs: taps on the post's own link where the platform allows one,
 *    otherwise an estimate from install spikes in the two days after the
 *    post (labelled as such).
 */

export const WINDOWS: Array<{ window: MetricsWindow; afterMs: number }> = [
  { window: "24h", afterMs: 24 * 3_600_000 },
  { window: "72h", afterMs: 72 * 3_600_000 },
  { window: "7d", afterMs: 7 * 86_400_000 },
];

/** Engagement per view: weighted interactions over views (or reach). Null without views. Pure. */
export function engagementRate(m: Metrics): number | null {
  const seen = m.views ?? m.reach;
  if (!seen || seen <= 0) return null;
  const score = (m.likes ?? 0) + 2 * (m.comments ?? 0) + 3 * (m.shares ?? 0) + 3 * (m.saves ?? 0) + 5 * (m.follows ?? 0);
  return Math.min(1, score / seen);
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The allocator reward in [0, 1): 0.5 at the app's usual rate (5% until it has one). Pure. */
export const rewardOf = (rate: number, usual: number | null) => rate / (rate + Math.max(0.005, usual ?? 0.05));

/** Better / worse than the app's usual, once it has at least 5 measured posts. Pure. */
export function verdictOf(rate: number, rates: number[]): Verdict | null {
  const usual = median(rates);
  if (usual === null || rates.length < 5) return null;
  if (rate > usual * 1.25) return "better";
  if (rate < usual * 0.8) return "worse";
  return "no_clear_change";
}

const ARM_WORDS: Record<SocialArm, string> = { "motion-graphics-short-video": "motion video", "app-walkthrough-short-video": "app walkthrough video", "ugc-style-short-video": "ai presenter video", "generated-broll-short-video": "generated video clip", "static-image-post": "still image" };

/** The post's total across its targets for one window. Pure. */
export function totals(p: Post, window: MetricsWindow): Metrics | null {
  const snaps = p.targets.map((t) => t.metrics.find((m) => m.window === window)?.metrics).filter((m): m is Metrics => Boolean(m));
  if (!snaps.length) return null;
  const sum = (k: keyof Metrics) => (snaps.some((m) => m[k] !== null) ? snaps.reduce((n, m) => n + (m[k] ?? 0), 0) : null);
  return { reach: sum("reach"), views: sum("views"), likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), saves: sum("saves"), follows: sum("follows") };
}

export type FeedbackDeps = {
  posts: SocialPostStore;
  accounts: SocialAccountStore;
  meta: { appSecret?: string; apiVersion: string } | null;
  tiktok: TikTokApp | null;
  platformDeps?: PlatformDeps;
  now?: () => Date;
  allocatorPath: string;
  statePath: string;
  /** Cross-app learning (learning/runtime.ts recordOutcome); absent = off. */
  learn?: (r: { kind: ChangeKind; pattern: string; verdict: Verdict; n: number; sourceId: string; effect: { lift: number; low: number; high: number } | null }) => Promise<boolean>;
  /** Taps on the smart link with this tag since a time. */
  clicks?: (tag: string, sinceIso: string) => Promise<number>;
  /** Installs per day (YYYY-MM-DD), both stores, from Numbers. */
  installs?: () => Promise<Record<string, number>>;
  log?: (text: string) => void;
};

/** What one target reported, by platform. */
async function fetchMetrics(t: Target, d: FeedbackDeps, accounts: Awaited<ReturnType<SocialAccountStore["forApp"]>>, appId: string): Promise<{ metrics: Metrics; note?: string }> {
  if (t.platform === "tiktok") {
    const a = accounts.find((x) => x.network === "tiktok");
    if (!a || a.network !== "tiktok" || !d.tiktok) return { metrics: emptyMetrics(), note: "TikTok isn't connected" };
    if (!t.externalId || t.externalId === t.stepId) return { metrics: emptyMetrics(), note: "Private or not public yet: TikTok shares no results for it." };
    const token = await tiktokAccessToken(appId, d.accounts, d.tiktok, d.platformDeps ?? {});
    const m = (await tiktokMetrics(d.tiktok, token, [t.externalId], d.platformDeps)).get(t.externalId);
    return m ? { metrics: { reach: m.reach, views: m.views, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves, follows: m.follows } } : { metrics: emptyMetrics(), note: "TikTok returned no results" };
  }
  const a = accounts.find((x) => x.network === "meta");
  if (!a || a.network !== "meta" || !d.meta || !t.externalId) return { metrics: emptyMetrics(), note: "Meta isn't connected" };
  const ctx: MetaPublishCtx = { pageId: a.meta.pageId, pageToken: a.tokens.pageToken, igUserId: a.meta.igUserId, appSecret: d.meta.appSecret, apiVersion: d.meta.apiVersion, deps: d.platformDeps ?? {} };
  return { metrics: t.platform === "instagram" ? await instagramMetrics(ctx, t.externalId, t.format) : await facebookMetrics(ctx, t.externalId, t.format) };
}

export type FeedbackReport = { collected: number; learned: string[]; boost: string[] };

export async function collectFeedback(appId: string, d: FeedbackDeps): Promise<FeedbackReport> {
  const now = d.now ? d.now() : new Date();
  const report: FeedbackReport = { collected: 0, learned: [], boost: [] };
  const accounts = await d.accounts.forApp(appId);
  const posts = (await d.posts.due(appId)).filter((p) => p.status === "published" || p.status === "publishing");
  for (const post of posts) {
    // Snapshots due for each published target.
    for (let i = 0; i < post.targets.length; i++) {
      const t = post.targets[i]!;
      if (t.status !== "published" || !t.publishedAt) continue;
      const age = now.getTime() - Date.parse(t.publishedAt);
      for (const w of WINDOWS) {
        if (age < w.afterMs || t.metrics.some((m) => m.window === w.window)) continue;
        // A missed window (day2 was off) is skipped, not back-filled with later numbers.
        const next = WINDOWS[WINDOWS.indexOf(w) + 1];
        if (next && age >= next.afterMs) {
          t.metrics.push({ window: w.window, at: now.toISOString(), metrics: emptyMetrics(), note: "missed" });
          continue;
        }
        try {
          const r = await fetchMetrics(t, d, accounts, appId);
          const clicks = t.linkTag && d.clicks ? await d.clicks(t.linkTag, t.publishedAt).catch(() => null) : null;
          t.metrics.push({ window: w.window, at: now.toISOString(), metrics: r.metrics, ...(r.note ? { note: r.note } : clicks !== null ? { note: `${clicks} taps on the post's link` } : {}) });
          report.collected++;
        } catch (err) {
          t.metrics.push({ window: w.window, at: now.toISOString(), metrics: emptyMetrics(), note: `couldn't read results: ${(err as Error).message.slice(0, 120)}` });
        }
      }
    }
    await d.posts.update(appId, post.id, (p) => {
      p.targets = p.targets.map((t, i) => ({ ...t, metrics: post.targets[i]?.metrics ?? t.metrics }));
      return p;
    });
    const learned = await learnFrom(appId, post, d);
    if (learned.length) report.learned.push(...learned.map((w) => `${post.id}@${w}`));
    if (learned.includes("7d")) {
      const fresh = await d.posts.get(appId, post.id);
      if (fresh?.boostCandidate) report.boost.push(post.id);
    }
  }
  if (d.installs) await estimateInstalls(appId, d, now).catch(() => {});
  return report;
}

/** Feeds a post's 72 h and 7 d results into the allocator, this app's scores and cross-app learning — once each. */
async function learnFrom(appId: string, post: Post, d: FeedbackDeps): Promise<MetricsWindow[]> {
  const done: MetricsWindow[] = [];
  for (const window of ["72h", "7d"] as const) {
    if (post.learned?.includes(window)) continue;
    const live = post.targets.filter((t) => t.status === "published");
    if (!live.length || !live.every((t) => t.metrics.some((m) => m.window === window))) continue;
    const m = totals(post, window);
    const rate = m ? engagementRate(m) : null;
    if (rate !== null) {
      const state = loadSocialState(d.statePath);
      const rates = state.learnings.rates;
      if (window === "72h") {
        const reward = rewardOf(rate, median(rates));
        let alloc = recordWeightedOutcome(loadAllocatorState(d.allocatorPath), socialArm(post.source.arm), reward, 0);
        // Which creator tool made it: "<format>@<tool>" arms, so the tool choice learns per kind of post.
        for (const t of post.source.tools ?? []) alloc = recordWeightedOutcome(alloc, toolArm(socialArm(post.source.arm), t.tool), reward, 0);
        saveAllocatorState(d.allocatorPath, alloc);
        const tz = audienceTimeZone(post.language);
        updateSocialState(d.statePath, (s) => {
          const l = s.learnings;
          const slots = { ...l.slots };
          for (const t of live) if (t.publishedAt) slots[t.platform] = addScore(slots[t.platform] ?? {}, slotOf(new Date(t.publishedAt), tz), reward);
          return { ...s, learnings: { ...l, hooks: addScore(l.hooks, post.idea.hook, reward), topics: addScore(l.topics, post.idea.topic, reward), formats: addScore(l.formats, post.source.arm, reward), tools: (post.source.tools ?? []).reduce((acc, t) => addScore(acc, `${post.source.arm}@${t.tool}`, reward), l.tools ?? {}), slots } };
        });
      } else {
        const verdict = verdictOf(rate, rates);
        const usual = median(rates);
        const boost = verdict === "better" && usual !== null && rate >= usual * 1.5;
        if (verdict && d.learn) {
          const lift = usual ? rate / usual - 1 : null;
          const effect = lift !== null && Number.isFinite(lift) ? { lift, low: lift * 0.5, high: lift * 1.5 } : null;
          const n = m?.views ?? m?.reach ?? 0;
          const slot = post.timeSlot ?? "evening";
          await d.learn({ kind: "social.format", pattern: ARM_WORDS[post.source.arm], verdict, n, sourceId: `${post.id}:format`, effect }).catch(() => false);
          await d.learn({ kind: "social.hook", pattern: post.idea.hook.replace(/_/g, " "), verdict, n, sourceId: `${post.id}:hook`, effect }).catch(() => false);
          await d.learn({ kind: "social.topic", pattern: post.idea.topic.replace(/_/g, " "), verdict, n, sourceId: `${post.id}:topic`, effect }).catch(() => false);
          await d.learn({ kind: "social.post_time", pattern: slot, verdict, n, sourceId: `${post.id}:time`, effect }).catch(() => false);
        }
        updateSocialState(d.statePath, (s) => ({ ...s, learnings: { ...s.learnings, rates: [...s.learnings.rates, rate].slice(-100) } }));
        if (boost) await d.posts.update(appId, post.id, (p) => ({ ...p, boostCandidate: true }));
      }
    }
    await d.posts.update(appId, post.id, (p) => ({ ...p, learned: [...(p.learned ?? []), window] }));
    done.push(window);
  }
  return done;
}

const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Installs after a post, as an estimate: installs on the post's day and the
 * next, above the 7 days before (only when clearly above the usual spread),
 * shared between the posts of those days. Never shown as exact.
 */
export function installSpike(series: Record<string, number>, day: string): number | null {
  const before = Array.from({ length: 7 }, (_, i) => series[addDays(day, -(i + 1))]).filter((v): v is number => typeof v === "number");
  const after = [series[day], series[addDays(day, 1)]];
  if (before.length < 5 || after.some((v) => typeof v !== "number")) return null;
  const mean = before.reduce((n, v) => n + v, 0) / before.length;
  const sd = Math.sqrt(before.reduce((n, v) => n + (v - mean) ** 2, 0) / before.length);
  const extra = (after[0]! + after[1]!) - 2 * mean;
  return extra > Math.max(3, 2 * sd * Math.SQRT2) ? Math.round(extra) : 0;
}

async function estimateInstalls(appId: string, d: FeedbackDeps, now: Date): Promise<void> {
  const series = await d.installs!();
  const posts = (await d.posts.due(appId)).filter((p) => p.status === "published" && !p.installEstimate);
  for (const p of posts) {
    const first = p.targets.map((t) => t.publishedAt).filter((x): x is string => Boolean(x)).sort()[0];
    if (!first || now.getTime() - Date.parse(first) < 3 * 86_400_000) continue;
    const day = dayOf(first);
    const spike = installSpike(series, day);
    if (spike === null) continue;
    const sameDays = posts.filter((x) => x.targets.some((t) => t.publishedAt && [day, addDays(day, 1)].includes(dayOf(t.publishedAt)))).length || 1;
    const installs = Math.round(spike / sameDays);
    await d.posts.update(appId, p.id, (x) => ({ ...x, installEstimate: { installs, basis: installs > 0 ? `Estimate: installs in the 2 days after the post were above the week before${sameDays > 1 ? `, shared between ${sameDays} posts` : ""}.` : "Estimate: no clear rise in installs after the post." } }));
  }
}
