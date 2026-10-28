import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { billAdSpend } from "../ads";
import { authorize, creditsForCost, recordCharge, type CreditStore } from "../credits";
import { betLink, BETS_FILENAME, loadBets, measureBet, saveBets, type Bet } from "../growth-bets";
import type { EventLike } from "../metrics/types";
import type { AppProfile } from "../onboarding";
import type { AssetStore, StoredAsset } from "./assets";
import { renderImageAd, SIZE, type Brand } from "./content";
import { checkAdCopy, toAdCopy, writeAdCopy, type AdCopyPlan, type CopyInput, type CopyVariant } from "./copy";
import { fit } from "./http";
import type { PlatformIdentityStore } from "./identities";
import { produceContent, type ProduceInput, type Produced } from "./produce";
import type { VideoProvider } from "./providers/video";
import type { AdCreativeInput, AdPlatform, AdStats, Identity, Launched, PlatformId, PlatformInfo, Ratio } from "./types";

/**
 * day2 running an app's paid ads on every platform it can, by itself.
 *
 * For each live experiment (growth-bets.ts) without ads:
 *  1. Pick platforms: the ones day2 has an ad account on, where the app's
 *     identity is ready, that fit the audience (consumer / business), as
 *     many as the budget covers at each platform's minimum (at most 4).
 *  2. Write the copy once (2 variants, a presenter script, keywords) and run
 *     both independent checks; produce images and videos once, in every
 *     format those platforms need.
 *  3. Launch on each platform with its own tracked link (?d2=B-4.tiktok),
 *     so day2 sees which platform brought whom — in its own usage events,
 *     the same yardstick everywhere.
 *
 * On every pass (results read every 6 hours):
 *  - bill spend in credits; hold ads whose page is broken, and ads over the
 *    month's ad budget, until it's fixed / the new month;
 *  - a platform that rejects an ad is stopped, with its reason;
 *  - per experiment, compare platforms by cost per outcome (sign-up or
 *    first value): stop one that spent without a single outcome, cut one
 *    that costs far more than the best, give the best more (weekly);
 *  - an experiment measured as worse stops everywhere.
 */

export const ADS_FILENAME = "day2-ads.json";
const DAY = 86_400_000;
const STATS_EVERY_MS = 6 * 3_600_000;
const SCALE_EVERY_MS = 7 * DAY;
const SCALE_FACTOR = 1.5;
const MAX_PLATFORMS = 4;
/** Before judging a platform: running this long and spending at least this. */
const JUDGE_AFTER_DAYS = 3;
const JUDGE_MIN_SPEND_USD = 30;
/** Generated video per experiment, USD (before markup). */
export const GENERATIVE_BUDGET_USD = 12;

export type PlatformCampaign = {
  betId: string;
  platform: PlatformId;
  launched: Launched;
  status: "active" | "paused" | "stopped";
  dailyBudgetUsd: number;
  launchedAt: string;
  spendUsd: number;
  billedSpendUsd: number;
  impressions: number;
  clicks: number;
  lastSyncAt: string | null;
  lastScaledAt: string | null;
  /** Paused for a reason that ends by itself: a broken page, the month's budget. */
  heldFor: string | null;
  stopReason: string | null;
  review: AdStats["status"] | null;
  /** The month spend is counted from ("2026-10") and the lifetime spend when it started. */
  month: { id: string; spendAtStart: number };
  creatives: Array<{ key: string; variant: number; assetId: string | null; kind: "image" | "video" | "text" }>;
};

export type ContentSet = { betId: string; at: string; copy: AdCopyPlan; dropped: Array<{ what: string; why: string }>; assets: Array<{ assetId: string; variant: number }>; costUsd: number; notes: string[] };
export type AdsFile = { campaigns: PlatformCampaign[]; content: ContentSet[] };

export function loadAds(path: string): AdsFile {
  if (!existsSync(path)) return { campaigns: [], content: [] };
  try {
    const p = JSON.parse(readFileSync(path, "utf-8")) as Partial<AdsFile>;
    return { campaigns: Array.isArray(p.campaigns) ? p.campaigns : [], content: Array.isArray(p.content) ? p.content : [] };
  } catch {
    return { campaigns: [], content: [] };
  }
}

export function saveAds(path: string, f: AdsFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`);
  renameSync(tmp, path);
}

const monthId = (d: Date) => d.toISOString().slice(0, 7);
/** Amounts shown to the app's owner (log, reasons) are in credits, never in day2's own costs. */
const money = (usd: number) => `${creditsForCost(usd, "paid_ads").toLocaleString("en-US")} credits`;

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** Platforms in the order they usually work for an audience; platforms that don't fit it are left out. */
export const FIT_ORDER: Record<"consumer" | "business", PlatformId[]> = {
  consumer: ["meta", "tiktok", "google", "snapchat", "pinterest", "reddit", "x"],
  business: ["linkedin", "google", "meta", "x", "reddit"],
};

/**
 * Which platforms an experiment runs on, and each one's daily budget: in
 * fit order, as many as the budget covers at their minimums (≤ 4); what's
 * left over is shared equally.
 */
export function choosePlatforms(ready: PlatformInfo[], audience: "consumer" | "business", dailyUsd: number, max = MAX_PLATFORMS): { chosen: Array<{ id: PlatformId; dailyUsd: number }>; skipped: Array<{ id: PlatformId; why: string }> } {
  const byId = new Map(ready.map((p) => [p.id, p]));
  const chosen: PlatformInfo[] = [];
  const skipped: Array<{ id: PlatformId; why: string }> = [];
  let committed = 0;
  for (const id of FIT_ORDER[audience]) {
    const p = byId.get(id);
    if (!p) continue;
    if (!p.audiences.includes(audience)) continue;
    if (chosen.length >= max) {
      skipped.push({ id, why: `at most ${max} platforms per experiment` });
      continue;
    }
    if (committed + p.minDailyUsd > dailyUsd) {
      skipped.push({ id, why: `its minimum is ${money(p.minDailyUsd)} a day, more than the budget left (${money(dailyUsd - committed)} a day)` });
      continue;
    }
    chosen.push(p);
    committed += p.minDailyUsd;
  }
  const extra = chosen.length ? (dailyUsd - committed) / chosen.length : 0;
  return { chosen: chosen.map((p) => ({ id: p.id, dailyUsd: Math.floor((p.minDailyUsd + extra) * 100) / 100 })), skipped };
}

/** The ads for one platform from the experiment's content: videos where the platform takes them, else images, else text. */
export function creativesFor(info: PlatformInfo, betId: string, copy: AdCopyPlan, assets: Array<{ asset: StoredAsset; variant: number }>, opts: { preferText?: boolean } = {}): Array<AdCreativeInput & { variant: number }> {
  const limits = info.copyLimits;
  const words = (v: CopyVariant, aiPerson: boolean) => {
    const headline = fit(limits.headline <= 30 ? v.shortHeadline : v.headline, limits.headline);
    // Synthetic performers are disclosed in the ad's own text (e.g. New York's law; California from 2027).
    const body = fit(aiPerson ? `${v.body} (AI presenter)` : v.body, limits.body);
    return { headline, body, ...(limits.description ? { description: fit(v.description, limits.description) } : {}), cta: v.cta };
  };
  const fits = (a: StoredAsset) => info.formats.some((f) => f.kind === a.kind && f.ratio === a.ratio && a.bytes <= f.maxBytes && (a.kind === "image" || ((f.maxDurationSec ?? Infinity) >= (a.durationSec ?? 0) && (f.minDurationSec ?? 0) <= (a.durationSec ?? Infinity))));
  const order = (r: Ratio) => {
    const i = info.formats.findIndex((f) => f.ratio === r);
    return i === -1 ? 99 : i;
  };
  if (opts.preferText && info.textOnly) {
    return copy.variants.map((v, n) => ({ key: `${betId}-${info.id}-t${n + 1}`, variant: n, copy: words(v, false), asset: null }));
  }
  // Videos: one ad per kind of video (walkthrough, presenter, generated), best ratio for the platform.
  const videos = assets.filter((a) => a.asset.kind === "video" && fits(a.asset));
  if (videos.length) {
    const bySource = new Map<string, { asset: StoredAsset; variant: number }>();
    for (const a of [...videos].sort((x, y) => order(x.asset.ratio) - order(y.asset.ratio))) if (!bySource.has(a.asset.source)) bySource.set(a.asset.source, a);
    return [...bySource.values()].slice(0, 3).map((a, n) => ({ key: `${betId}-${info.id}-v${n + 1}`, variant: 0, copy: words(copy.variants[0]!, a.asset.aiPerson), asset: a.asset }));
  }
  const images = assets.filter((a) => a.asset.kind === "image" && !a.asset.label.startsWith("Cover") && fits(a.asset));
  if (images.length) {
    const out: Array<AdCreativeInput & { variant: number }> = [];
    for (const [n, v] of copy.variants.entries()) {
      const best = images.filter((a) => a.variant === n).sort((x, y) => order(x.asset.ratio) - order(y.asset.ratio))[0];
      if (best) out.push({ key: `${betId}-${info.id}-i${n + 1}`, variant: n, copy: words(v, best.asset.aiPerson), asset: best.asset });
    }
    return out;
  }
  return info.textOnly ? copy.variants.map((v, n) => ({ key: `${betId}-${info.id}-t${n + 1}`, variant: n, copy: words(v, false), asset: null })) : [];
}

export type PlatformResult = { platform: PlatformId; people: number; outcomes: number; spendUsd: number; costPerOutcome: number | null };

/** What each platform brought for an experiment, from day2's own events: people who first arrived through its link, and how many reached the outcome. */
export function platformResults(bet: Bet, campaigns: PlatformCampaign[], events: EventLike[]): PlatformResult[] {
  const outcome = bet.metric === "signup" ? "signup" : "activated";
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const l = byDevice.get(e.deviceId);
    if (l) l.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const tally = new Map<string, { people: number; outcomes: number }>();
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const c = list[0]!.acquisition?.campaignId;
    if (!c?.startsWith(`${bet.id}.`)) continue;
    const t = tally.get(c.slice(bet.id.length + 1)) ?? { people: 0, outcomes: 0 };
    t.people++;
    if (list.some((e) => e.type === outcome)) t.outcomes++;
    tally.set(c.slice(bet.id.length + 1), t);
  }
  return campaigns.map((c) => {
    const t = tally.get(c.platform) ?? { people: 0, outcomes: 0 };
    return { platform: c.platform, ...t, spendUsd: c.spendUsd, costPerOutcome: t.outcomes ? c.spendUsd / t.outcomes : null };
  });
}

export type Decision = { platform: PlatformId; action: "stop" | "cut" | "scale"; dailyUsd?: number; why: string };

/**
 * Per experiment, comparing its platforms (pure). A platform is judged once
 * it ran JUDGE_AFTER_DAYS and spent enough to tell.
 */
export function rebalance(campaigns: PlatformCampaign[], results: PlatformResult[], infos: Map<PlatformId, PlatformInfo>, now: Date, room: { dailyUsd: number }, outcomeWord: string): Decision[] {
  const decisions: Decision[] = [];
  const active = campaigns.filter((c) => c.status === "active");
  const res = new Map(results.map((r) => [r.platform, r]));
  const judged = active.filter((c) => {
    const min = infos.get(c.platform)?.minDailyUsd ?? 5;
    return now.getTime() - Date.parse(c.launchedAt) >= JUDGE_AFTER_DAYS * DAY && c.spendUsd >= Math.max(JUDGE_MIN_SPEND_USD, 3 * min);
  });
  const withCpa = judged.filter((c) => res.get(c.platform)?.costPerOutcome != null).sort((a, b) => res.get(a.platform)!.costPerOutcome! - res.get(b.platform)!.costPerOutcome!);
  const best = withCpa[0];
  const bestCpa = best ? res.get(best.platform)!.costPerOutcome! : null;
  for (const c of judged) {
    const r = res.get(c.platform)!;
    const min = infos.get(c.platform)?.minDailyUsd ?? 5;
    if (r.outcomes === 0 && c.spendUsd >= Math.max(2 * JUDGE_MIN_SPEND_USD, 5 * min, bestCpa ? 3 * bestCpa : 0)) {
      decisions.push({ platform: c.platform, action: "stop", why: `spent ${money(c.spendUsd)} without a single ${outcomeWord}` });
    } else if (best && c !== best && r.costPerOutcome !== null && bestCpa !== null && r.costPerOutcome > 2.5 * bestCpa) {
      const times = (r.costPerOutcome / bestCpa).toFixed(1);
      if (c.dailyBudgetUsd > min) decisions.push({ platform: c.platform, action: "cut", dailyUsd: min, why: `each ${outcomeWord} costs ${times}× more than on ${infos.get(best.platform)?.name ?? best.platform}` });
      else decisions.push({ platform: c.platform, action: "stop", why: `each ${outcomeWord} costs ${times}× more than on ${infos.get(best.platform)?.name ?? best.platform}, already at its minimum budget` });
    }
  }
  if (best && (!best.lastScaledAt || now.getTime() - Date.parse(best.lastScaledAt) >= SCALE_EVERY_MS)) {
    const freed = decisions.reduce((n, d) => n + (d.action === "stop" ? (active.find((c) => c.platform === d.platform)?.dailyBudgetUsd ?? 0) : d.action === "cut" ? (active.find((c) => c.platform === d.platform)?.dailyBudgetUsd ?? 0) - (d.dailyUsd ?? 0) : 0), 0);
    const target = Math.min(Math.round(best.dailyBudgetUsd * SCALE_FACTOR * 100) / 100, best.dailyBudgetUsd + room.dailyUsd + freed);
    if (target > best.dailyBudgetUsd + 0.5) decisions.push({ platform: best.platform, action: "scale", dailyUsd: target, why: `the lowest cost per ${outcomeWord} (${money(bestCpa!)})` });
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export type PlatformAdsDeps = {
  credits: CreditStore;
  platforms: Map<PlatformId, AdPlatform>;
  infos: Map<PlatformId, PlatformInfo>;
  identities: PlatformIdentityStore;
  assets: AssetStore;
  providers: { creatify: VideoProvider | null; runway: VideoProvider | null };
  events: (app: AppEntry, sinceIso: string) => Promise<EventLike[] | null>;
  pageHealth?: (app: AppEntry, path: string) => Promise<{ ok: boolean; reason: string }>;
  paidGate: (app: AppEntry, profile: AppProfile) => Promise<{ unlocked: boolean; reason: string }>;
  /** Overridable for tests. */
  writeCopy?: (i: CopyInput) => Promise<AdCopyPlan | null>;
  checkCopy?: (plan: AdCopyPlan, profile: AppProfile) => ReturnType<typeof checkAdCopy>;
  produce?: (i: ProduceInput) => Promise<Produced>;
  /** Markets the owner set for the app (ISO codes), if any. */
  markets?: { countries: string[]; languages: string[] } | null;
};

export type PlatformAdsReport = { launched: string[]; paused: string[]; stopped: string[]; scaled: string[]; skipped: string[] };

type Log = (text: string, credits?: number) => void;

function brandOf(app: AppEntry, profile: AppProfile): Brand {
  return { name: app.name, colors: profile.styleGuide?.colors?.length ? profile.styleGuide.colors : ["#141414", "#6B6B6B"] };
}

/** Pauses every active platform campaign (kill switch, autopilot off). Returns "B-4 on TikTok" labels. */
export async function pausePlatformAds(app: AppEntry, platforms: Map<PlatformId, AdPlatform>, log: Log, why: string): Promise<string[]> {
  const path = resolve(app.repoPath, ADS_FILENAME);
  if (!existsSync(path)) return [];
  const file = loadAds(path);
  const paused: string[] = [];
  for (const c of file.campaigns) {
    if (c.status !== "active") continue;
    const p = platforms.get(c.platform);
    if (!p) continue;
    try {
      await p.pause(c.launched);
      c.status = "paused";
      c.heldFor = why;
      paused.push(`${c.betId} on ${c.platform}`);
    } catch (err) {
      log(`Couldn't pause ${c.betId} on ${c.platform}: ${(err as Error).message}`);
    }
  }
  saveAds(path, file);
  if (paused.length) log(`Paused ${paused.length} ad${paused.length === 1 ? "" : "s"} because ${why}.`);
  return paused;
}

export async function runPlatformAds(app: AppEntry, profile: AppProfile, deps: PlatformAdsDeps, opts: { monthlyAdsUsd: number; now: Date; log: Log }): Promise<PlatformAdsReport> {
  const { now, log } = opts;
  const at = now.toISOString();
  const report: PlatformAdsReport = { launched: [], paused: [], stopped: [], scaled: [], skipped: [] };
  const path = resolve(app.repoPath, ADS_FILENAME);
  const betsPath = resolve(app.repoPath, BETS_FILENAME);
  const file = loadAds(path);
  let bets = loadBets(betsPath);
  const save = () => saveAds(path, file);
  const nameOf = (id: PlatformId) => deps.infos.get(id)?.name ?? id;
  const healthOf = async (betId: string) => {
    const b = bets.bets.find((x) => x.id === betId);
    return b && deps.pageHealth ? deps.pageHealth(app, b.landingPath) : { ok: true, reason: "" };
  };

  // Month-to-date spend, and the ad budget's cap.
  for (const c of file.campaigns) if (c.month.id !== monthId(now)) c.month = { id: monthId(now), spendAtStart: c.spendUsd };
  const monthSpend = () => file.campaigns.reduce((n, c) => n + Math.max(0, c.spendUsd - c.month.spendAtStart), 0);
  const OVER = "this month's ad budget is used up";

  // 1. Running campaigns: sync, bill, hold/resume, review.
  for (const c of file.campaigns) {
    const p = deps.platforms.get(c.platform);
    if (!p || c.status === "stopped") continue;
    // Held ads come back when the reason is gone.
    if (c.status === "paused" && c.heldFor) {
      const back = c.heldFor === OVER ? monthSpend() < opts.monthlyAdsUsd : (await healthOf(c.betId)).ok;
      const b = bets.bets.find((x) => x.id === c.betId);
      if (back && b?.status === "live") {
        try {
          await p.resume(c.launched);
          log(`${c.betId} on ${nameOf(c.platform)} is back on (${c.heldFor === OVER ? "a new month's budget" : "its page works again"}).`);
          c.status = "active";
          c.heldFor = null;
        } catch (err) {
          log(`Couldn't turn ${c.betId} back on on ${nameOf(c.platform)}: ${(err as Error).message}`);
        }
      }
      continue;
    }
    if (c.status !== "active") continue;
    const h = await healthOf(c.betId);
    if (!h.ok) {
      try {
        await p.pause(c.launched);
        c.status = "paused";
        c.heldFor = `its page is broken (${h.reason})`;
        report.paused.push(`${c.betId}:${c.platform}`);
        log(`Paused ${c.betId} on ${nameOf(c.platform)}: its page is broken (${h.reason}). It turns back on when the page works.`);
      } catch (err) {
        log(`Couldn't pause ${c.betId} on ${nameOf(c.platform)}: ${(err as Error).message}`);
      }
      continue;
    }
    if (c.lastSyncAt && now.getTime() - Date.parse(c.lastSyncAt) < STATS_EVERY_MS) continue;
    try {
      const s = await p.stats(c.launched);
      c.billedSpendUsd = await billAdSpend(deps.credits, { appId: app.id, campaignId: `${c.platform}:${c.launched.campaignId}`, label: `${c.betId} on ${nameOf(c.platform)}`, reportedSpendUsd: s.spendUsd, billedSpendUsd: c.billedSpendUsd });
      Object.assign(c, { spendUsd: s.spendUsd, impressions: s.impressions, clicks: s.clicks, lastSyncAt: at, review: s.status });
      if (s.status === "rejected") {
        await p.pause(c.launched).catch(() => {});
        c.status = "stopped";
        c.stopReason = `${nameOf(c.platform)} rejected the ad${s.rejection ? `: ${s.rejection}` : ""}`;
        report.stopped.push(`${c.betId}:${c.platform}`);
        log(`${nameOf(c.platform)} rejected the ad for ${c.betId}${s.rejection ? ` (${s.rejection})` : ""} — stopped it there.`);
      }
    } catch (err) {
      log(`Couldn't read results for ${c.betId} on ${nameOf(c.platform)}: ${(err as Error).message}`);
    }
  }
  save();

  // 2. The month's budget: hold everything once it's used.
  if (opts.monthlyAdsUsd > 0 && monthSpend() >= opts.monthlyAdsUsd) {
    for (const c of file.campaigns.filter((x) => x.status === "active")) {
      const p = deps.platforms.get(c.platform);
      if (!p) continue;
      await p.pause(c.launched).then(
        () => {
          c.status = "paused";
          c.heldFor = OVER;
          report.paused.push(`${c.betId}:${c.platform}`);
        },
        (err: Error) => log(`Couldn't pause ${c.betId} on ${nameOf(c.platform)}: ${err.message}`),
      );
    }
    log(`This month's ad budget (${money(opts.monthlyAdsUsd)}) is used — ads are paused until the new month.`);
    save();
  }

  // 3. Per experiment: stopped or measured worse → stop everywhere; otherwise compare its platforms.
  const sinceIso = bets.bets.map((b) => b.liveAt).filter((x): x is string => Boolean(x)).sort()[0];
  const events = sinceIso ? await deps.events(app, sinceIso) : null;
  const stopAll = async (betId: string, why: string) => {
    for (const c of file.campaigns.filter((x) => x.betId === betId && x.status !== "stopped")) {
      const p = deps.platforms.get(c.platform);
      await p?.pause(c.launched).catch(() => {});
      c.status = "stopped";
      c.stopReason = why;
      report.stopped.push(`${c.betId}:${c.platform}`);
    }
  };
  for (const b of bets.bets) {
    const mine = file.campaigns.filter((c) => c.betId === b.id && c.status !== "stopped");
    if (!mine.length) continue;
    if (b.status === "stopped") {
      await stopAll(b.id, "the experiment was stopped");
      log(`Stopped ${b.id}'s ads on every platform (the experiment was stopped).`);
      continue;
    }
    const verdict = measureBet(b, events);
    if (verdict.state === "worse") {
      await stopAll(b.id, "it brought people who reach the goal less often than everyone else");
      bets = { ...bets, bets: bets.bets.map((x) => (x.id === b.id ? { ...x, status: "stopped", stoppedAt: at, stopReason: "Stopped by day2: it brought people who reach the goal less often than everyone else." } : x)) };
      saveBets(betsPath, bets);
      log(`Stopped ${b.id} on every platform — ${verdict.note}`);
      continue;
    }
    if (!events) continue;
    const results = platformResults(b, mine, events);
    const activeDaily = file.campaigns.filter((c) => c.status === "active").reduce((n, c) => n + c.dailyBudgetUsd, 0);
    const room = { dailyUsd: Math.max(0, opts.monthlyAdsUsd / 30 - activeDaily) };
    const outcomeWord = b.metric === "signup" ? "sign-up" : "new user reaching first value";
    for (const d of rebalance(mine, results, deps.infos, now, room, outcomeWord)) {
      const c = mine.find((x) => x.platform === d.platform)!;
      const p = deps.platforms.get(c.platform);
      if (!p) continue;
      try {
        if (d.action === "stop") {
          await p.pause(c.launched);
          c.status = "stopped";
          c.stopReason = d.why;
          report.stopped.push(`${b.id}:${c.platform}`);
          log(`Stopped ${b.id} on ${nameOf(c.platform)}: ${d.why}.`);
        } else {
          if (d.action === "scale") {
            const check = await authorize(deps.credits, { appId: app.id, appName: app.name, service: "paid_ads", maxCostUsd: d.dailyUsd! * 7 }, now);
            if (!check.ok) continue;
          }
          await p.setDailyBudget(c.launched, d.dailyUsd!);
          log(`${d.action === "scale" ? "Raised" : "Cut"} ${b.id} on ${nameOf(c.platform)} to ${money(d.dailyUsd!)} a day: ${d.why}.`);
          if (d.action === "scale") {
            c.lastScaledAt = at;
            report.scaled.push(`${b.id}:${c.platform}`);
          }
          c.dailyBudgetUsd = d.dailyUsd!;
        }
      } catch (err) {
        log(`Couldn't change ${b.id} on ${nameOf(c.platform)}: ${(err as Error).message}`);
      }
    }
  }
  save();

  // 4. Live experiments without ads: launch.
  const waiting = bets.bets.filter((b) => b.status === "live" && !b.campaign && !file.campaigns.some((c) => c.betId === b.id));
  if (!waiting.length) return report;
  if (opts.monthlyAdsUsd <= 0) {
    report.skipped.push("ads: the app has no monthly growth budget set, so day2 doesn't buy ads.");
    return report;
  }
  if (monthSpend() >= opts.monthlyAdsUsd) return report;
  if (!deps.platforms.size) {
    report.skipped.push("ads: no ad platform is connected on this server yet.");
    return report;
  }
  const gate = await deps.paidGate(app, profile);
  if (!gate.unlocked) {
    report.skipped.push(`ads: ${gate.reason}`);
    return report;
  }

  for (const b of waiting) {
    const base = betLink(b, app.appBaseUrl);
    if (!base) continue;
    const page = await healthOf(b.id);
    if (!page.ok) {
      report.skipped.push(`ads: ${b.id}'s page is broken (${page.reason})`);
      continue;
    }
    // Budget: an equal share of what's left, starting at half of it (it earns the rest by working).
    const runningBets = new Set(file.campaigns.filter((c) => c.status === "active").map((c) => c.betId)).size;
    const activeDaily = file.campaigns.filter((c) => c.status === "active").reduce((n, c) => n + c.dailyBudgetUsd, 0);
    const daily = Math.min(opts.monthlyAdsUsd / 30 - activeDaily, opts.monthlyAdsUsd / 30 / (runningBets + 1) / 2 + 0.01);

    // Words first (they tell the audience), checked.
    let content = file.content.find((x) => x.betId === b.id);
    if (!content) {
      const plan = await (deps.writeCopy ?? writeAdCopy)({ appName: app.name, profile, angle: b.angle, audience: b.audience, link: base, ...(deps.markets ?? {}) });
      if (!plan) {
        log(`Couldn't write ads for ${b.id} this time — nothing launched.`);
        continue;
      }
      const checked = await (deps.checkCopy ?? checkAdCopy)(plan, profile);
      for (const d of checked.dropped) log(`Left out the ${d.what} for ${b.id}: ${d.why}.`);
      if (!checked.plan.variants.length) {
        log(`No ad copy for ${b.id} passed the truth and authenticity checks — nothing launched.`);
        continue;
      }
      content = { betId: b.id, at, copy: checked.plan, dropped: checked.dropped, assets: [], costUsd: 0, notes: [] };
      file.content.push(content);
      save();
    }

    // Platforms: ready, fitting, within budget.
    const ready: PlatformInfo[] = [];
    const notReady: string[] = [];
    for (const [id] of deps.platforms) {
      const info = deps.infos.get(id)!;
      if (info.identity === "app_account" && !(await deps.identities.get(app.id, id))) {
        notReady.push(`${info.name} (needs ${info.identityHelp ?? "the app's own account linked"})`);
        continue;
      }
      ready.push(info);
    }
    const { chosen, skipped } = choosePlatforms(ready, content.copy.audience, daily);
    for (const s of skipped) report.skipped.push(`ads: ${b.id} not on ${nameOf(s.id)}: ${s.why}`);
    if (notReady.length) report.skipped.push(`ads: not ready yet: ${notReady.join("; ")}`);
    if (!chosen.length) {
      log(`No platform fits ${b.id}'s budget of ${money(daily)} a day yet${skipped[0] ? ` (${skipped[0].why})` : ""}.`);
      continue;
    }
    const total = chosen.reduce((n, c) => n + c.dailyUsd, 0);
    const check = await authorize(deps.credits, { appId: app.id, appName: app.name, service: "paid_ads", maxCostUsd: total * 7 }, now);
    if (!check.ok) {
      report.skipped.push(`ads: ${check.reason}`);
      log(`Didn't launch ads for ${b.id}: ${check.reason}`);
      continue;
    }

    // Content, once per experiment.
    let produced: Array<{ asset: StoredAsset; variant: number }>;
    if (content.assets.length) {
      produced = (await Promise.all(content.assets.map(async (a) => ({ asset: await deps.assets.get(a.assetId), variant: a.variant })))).filter((a): a is { asset: StoredAsset; variant: number } => Boolean(a.asset));
    } else {
      const genOk = await authorize(deps.credits, { appId: app.id, appName: app.name, service: "content_generation", maxCostUsd: GENERATIVE_BUDGET_USD }, now);
      const pageUrl = base.replace(/\?.*$/, "");
      try {
        const r = await (deps.produce ?? produceContent)({
          appId: app.id,
          purpose: b.id,
          pageUrl,
          brand: brandOf(app, profile),
          copy: content.copy,
          platforms: chosen.map((c) => deps.infos.get(c.id)!),
          store: deps.assets,
          providers: deps.providers,
          generativeBudgetUsd: genOk.ok ? GENERATIVE_BUDGET_USD : 0,
        });
        if (r.costUsd > 0) await recordCharge(deps.credits, { id: `adgen:${app.id}:${b.id}`, appId: app.id, service: "content_generation", costUsd: r.costUsd, description: `Ad videos for ${b.id}` }, now);
        produced = r.assets;
        content.assets = r.assets.map((a) => ({ assetId: a.asset.id, variant: a.variant }));
        content.costUsd = r.costUsd;
        content.notes = r.notes;
        for (const n of r.notes) log(`${b.id}: ${n}`);
        const counts = { image: r.assets.filter((a) => a.asset.kind === "image" && !a.asset.label.startsWith("Cover")).length, video: r.assets.filter((a) => a.asset.kind === "video").length };
        log(`Made ${counts.image} image${counts.image === 1 ? "" : "s"} and ${counts.video} video${counts.video === 1 ? "" : "s"} for ${b.id} from the app's real page.`, r.costUsd ? Math.round(r.costUsd * 100) : undefined);
        save();
      } catch (err) {
        log(`Couldn't make the ads for ${b.id}: ${(err as Error).message}`);
        continue;
      }
    }

    // Launch on each chosen platform.
    for (const ch of chosen) {
      const info = deps.infos.get(ch.id)!;
      const p = deps.platforms.get(ch.id)!;
      let identity: Identity | null = null;
      try {
        identity = await identityFor(app, info, p, deps, produced);
      } catch (err) {
        log(`Couldn't set up how ${app.name} shows on ${info.name}: ${(err as Error).message}`);
        continue;
      }
      if (info.identity !== "none" && !identity) continue;
      const creatives = creativesFor(info, b.id, content.copy, produced, { preferText: ch.id === "google" && content.copy.keywords.length >= 3 });
      if (!creatives.length) {
        report.skipped.push(`ads: nothing made for ${b.id} fits ${info.name}'s formats`);
        continue;
      }
      const u = new URL(base);
      u.searchParams.set("d2", `${b.id}.${ch.id}`);
      const link = u.toString();
      try {
        const launched = await p.launch({
          appId: app.id,
          appName: app.name,
          campaignName: `day2 ${app.name} ${b.id}`,
          link,
          dailyBudgetUsd: ch.dailyUsd,
          targeting: { countries: content.copy.countries, languages: content.copy.languages, ageMin: 18, audience: content.copy.audience, interests: content.copy.interests, keywords: content.copy.keywords },
          creatives: creatives.map(({ variant: _v, ...c }) => c),
          identity,
          aiContent: creatives.some((c) => c.asset?.aiGenerated),
        });
        file.campaigns.push({
          betId: b.id,
          platform: ch.id,
          launched,
          status: "active",
          dailyBudgetUsd: ch.dailyUsd,
          launchedAt: at,
          spendUsd: 0,
          billedSpendUsd: 0,
          impressions: 0,
          clicks: 0,
          lastSyncAt: null,
          lastScaledAt: null,
          heldFor: null,
          stopReason: null,
          review: null,
          month: { id: monthId(now), spendAtStart: 0 },
          creatives: creatives.map((c) => ({ key: c.key, variant: c.variant, assetId: c.asset?.id ?? null, kind: c.asset ? c.asset.kind : "text" })),
        });
        save();
        report.launched.push(`${b.id}:${ch.id}`);
        const kinds = [...new Set(creatives.map((c) => (c.asset ? c.asset.kind : "text")))].join(" and ");
        log(`Launched ${b.id} on ${info.name} at ${money(ch.dailyUsd)} a day: ${creatives.length} ${kinds} ad${creatives.length === 1 ? "" : "s"}.`);
      } catch (err) {
        log(`Couldn't launch ${b.id} on ${info.name}: ${(err as Error).message}`);
      }
    }
  }
  return report;
}

/** The identity an app's ads show as on a platform: none, day2-made (stored once), or the linked account. */
async function identityFor(app: AppEntry, info: PlatformInfo, p: AdPlatform, deps: PlatformAdsDeps, produced: Array<{ asset: StoredAsset }>): Promise<Identity | null> {
  if (info.identity === "none") return null;
  const have = await deps.identities.get(app.id, info.id);
  if (have) return { platform: info.id, ref: have.ref, displayName: have.displayName || app.name };
  if (info.identity !== "custom" || !p.ensureIdentity) return null;
  const logo = produced.find((a) => a.asset.kind === "image" && a.asset.ratio === "1:1")?.asset ?? (await squareLogo(app, deps));
  const made = await p.ensureIdentity({ appId: app.id, displayName: app.name, logo });
  await deps.identities.set({ appId: app.id, platform: info.id, ref: made.ref, displayName: made.displayName, setBy: "day2" });
  return made;
}

/** A simple square logo from the app's name and brand color, when nothing better exists. */
async function squareLogo(app: AppEntry, deps: PlatformAdsDeps): Promise<StoredAsset> {
  const dir = mkdtempSync(join(tmpdir(), "day2-logo-"));
  try {
    const f = join(dir, "logo.png");
    await renderImageAd("1:1", { headline: app.name, cta: "" }, { name: "", colors: ["#141414"] }, "", f);
    const { w, h } = SIZE["1:1"];
    return await deps.assets.put(f, { appId: app.id, purpose: "identity", label: "Logo", kind: "image", ratio: "1:1", width: w, height: h, mime: "image/png", source: "template", aiGenerated: false, aiPerson: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
