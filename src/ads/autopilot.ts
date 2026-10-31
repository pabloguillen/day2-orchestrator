import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { billAdSpend } from "../ads";
import { authorize, creditsForCost, recordCharge, type CreditStore } from "../credits";
import type { UserActivity } from "../field-store";
import { loadAllocatorState, saveAllocatorState } from "../growth-allocator";
import { betLink, BETS_FILENAME, loadBets, measureBet, saveBets, type Bet } from "../growth-bets";
import type { EventLike } from "../metrics/types";
import type { AppProfile } from "../onboarding";
import type { AssetStore, StoredAsset } from "./assets";
import { renderImageAd, SIZE, type Brand } from "./content";
import { checkAdCopy, writeAdCopy, type AdCopyPlan, type CopyInput, type CopyVariant } from "./copy";
import { collectConversions, OPTIMIZE_FOR_SIGNUPS_AFTER, type SentConversions } from "./conversions";
import { fromUsd, toUsd } from "./fx";
import { fit } from "./http";
import type { PlatformIdentityStore } from "./identities";
import { computeLearnings, copyHints, formatOf, formatsToSkip, platformOrder, recordInAllocator, type Format, type Learnings } from "./learnings";
import { produceContent, type ProduceInput, type Produced } from "./produce";
import type { VideoProvider } from "./providers/video";
import { platformResults, retentionFrom, shortKey, type PlatformResult, type Retention } from "./results";
import { scaleGate, stayAfterDays } from "./retention-link";
import type { RetentionSnapshot } from "../retention";
import type { AdCreativeInput, AdPlatform, AdStats, ConversionSetup, Identity, Launched, PlatformId, PlatformInfo, Ratio } from "./types";
import { effectiveDestination, type Destination } from "./destination";

export { platformResults } from "./results";

/**
 * day2 running an app's paid ads on every platform it can, by itself — on
 * day2's own ad accounts (spend billed in credits) or the app's own (the
 * customer pays the platform), per platform.
 *
 * For each live experiment (growth-bets.ts) without ads:
 *  1. Pick platforms: those connected, where the app's identity is ready,
 *     that fit the audience — in the order this app's own results rank
 *     them — as many as the budget covers at their minimums (≤ 4).
 *  2. Write the copy once (with what worked and failed before), run both
 *     independent checks; make images and videos in every format needed,
 *     skipping formats that keep losing.
 *  3. Launch with a tag per ad (?d2=B-4.tiktok.v1), optimising for sign-ups
 *     where the platform already gets enough conversions from day2, else for
 *     clicks.
 *
 * Every pass (results every 6 hours):
 *  - spend: billed in credits (day2's accounts), converted from the account's
 *    currency; broken pages and an exhausted monthly budget hold ads;
 *  - conversions: sign-ups and first value go back to the platform that
 *    brought them (with its click id), so it learns who to show ads to;
 *  - judging, per experiment: by users who stayed once enough could have,
 *    else by sign-ups / first value: losing ads paused inside a platform,
 *    platforms stopped/cut/scaled, a worse experiment stopped everywhere;
 *  - learnings: platforms, formats, copy and angles ranked, fed into the
 *    next round (and the growth allocator).
 */

export const ADS_FILENAME = "day2-ads.json";
const ALLOCATOR_FILENAME = "day2-allocator-state.json";
const DAY = 86_400_000;
const STATS_EVERY_MS = 6 * 3_600_000;
const SCALE_EVERY_MS = 7 * DAY;
const SCALE_FACTOR = 1.5;
const MAX_PLATFORMS = 4;
/** Before judging a platform: running this long and spending at least this. */
const JUDGE_AFTER_DAYS = 3;
const JUDGE_MIN_SPEND_USD = 30;
/** Before judging an ad inside a platform. */
const AD_MIN_SPEND_USD = 15;
/** Generated video per experiment, USD (before markup). */
export const GENERATIVE_BUDGET_USD = 12;

export type Billing = "credits" | "own";

export type PlatformCampaign = {
  betId: string;
  platform: PlatformId;
  launched: Launched;
  status: "active" | "paused" | "stopped";
  /** Whose ad account: day2's (billed in credits) or the app's own. */
  billing: Billing;
  /** The ad account's currency; amounts below are converted to USD. */
  currency: string;
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
  optimizeFor: "clicks" | "signups";
  /** The month spend is counted from ("2026-10") and the lifetime spend when it started. */
  month: { id: string; spendAtStart: number };
  creatives: Array<{ key: string; variant: number; assetId: string | null; kind: "image" | "video" | "text"; format?: Format; headline?: string; paused?: string | null }>;
  /** Spend per ad (creative key), USD. */
  adSpendUsd?: Record<string, number>;
};

export type ContentSet = { betId: string; at: string; copy: AdCopyPlan; dropped: Array<{ what: string; why: string }>; assets: Array<{ assetId: string; variant: number }>; costUsd: number; notes: string[] };
export type AdsFile = {
  campaigns: PlatformCampaign[];
  content: ContentSet[];
  learnings: Learnings | null;
  /** Per platform: what receives day2's conversions (pixel, conversion action…). */
  conversions: Partial<Record<PlatformId, { setup: ConversionSetup; at: string }>>;
  /** What was already counted into the growth allocator, per ad. */
  allocatorRecorded: Record<string, { people: number; outcomes: number; spendUsd: number }>;
  /** Why scale-ups are on hold for the retention engine (retention-link.ts), or null. */
  scaleHeld: string | null;
  /** Where the owner wants ads to lead (destination.ts), or null for day2's default. */
  destination: Destination | null;
  /** Whether the website sends phones from ads on to the stores (website destination for apps in the stores). */
  handoff: { ready: boolean; at: string; ticketId: string | null; why: string | null } | null;
};

export function loadAds(path: string): AdsFile {
  const empty: AdsFile = { campaigns: [], content: [], learnings: null, conversions: {}, allocatorRecorded: {}, scaleHeld: null, destination: null, handoff: null };
  if (!existsSync(path)) return empty;
  try {
    const p = JSON.parse(readFileSync(path, "utf-8")) as Partial<AdsFile>;
    return {
      campaigns: (Array.isArray(p.campaigns) ? p.campaigns : []).map((c) => ({ ...c, billing: c.billing ?? "credits", currency: c.currency ?? "USD", optimizeFor: c.optimizeFor ?? "clicks" })),
      content: Array.isArray(p.content) ? p.content : [],
      // Learnings from before fit-adjusted judging are recomputed on the next pass.
      learnings: p.learnings && "fitKnown" in p.learnings ? p.learnings : null,
      conversions: p.conversions ?? {},
      allocatorRecorded: p.allocatorRecorded ?? {},
      scaleHeld: p.scaleHeld ?? null,
      destination: p.destination === "website" || p.destination === "store" ? p.destination : null,
      handoff: p.handoff ?? null,
    };
  } catch {
    return empty;
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
 * `order` (this app's results first, else the usual fit order), as many as
 * the budget covers at their minimums (≤ 4); what's left is shared equally.
 */
export function choosePlatforms(ready: PlatformInfo[], audience: "consumer" | "business", dailyUsd: number, max = MAX_PLATFORMS, order: PlatformId[] = FIT_ORDER[audience]): { chosen: Array<{ id: PlatformId; dailyUsd: number }>; skipped: Array<{ id: PlatformId; why: string }> } {
  const byId = new Map(ready.map((p) => [p.id, p]));
  const chosen: PlatformInfo[] = [];
  const skipped: Array<{ id: PlatformId; why: string }> = [];
  let committed = 0;
  for (const id of order) {
    const p = byId.get(id);
    if (!p || !p.audiences.includes(audience)) continue;
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

/** "https://…/go?d2=B-4" + "B-4.tiktok.v1" → the same link carrying that ad's tag. */
export function taggedLink(base: string, tag: string): string {
  const u = new URL(base);
  u.searchParams.set("d2", tag);
  return u.toString();
}

/** The ads for one platform from the experiment's content: videos where the platform takes them, else images, else text — each with its own tagged link. */
export function creativesFor(info: PlatformInfo, betId: string, copy: AdCopyPlan, assets: Array<{ asset: StoredAsset; variant: number }>, opts: { preferText?: boolean; baseLink?: string; skip?: Format[] } = {}): Array<AdCreativeInput & { variant: number; format: Format }> {
  const limits = info.copyLimits;
  const skip = new Set(opts.skip ?? []);
  const words = (v: CopyVariant, aiPerson: boolean) => {
    const headline = fit(limits.headline <= 30 ? v.shortHeadline : v.headline, limits.headline);
    // Synthetic performers are disclosed in the ad's own text (e.g. New York's law; California from 2027).
    const body = fit(aiPerson ? `${v.body} (AI presenter)` : v.body, limits.body);
    return { headline, body, ...(limits.description ? { description: fit(v.description, limits.description) } : {}), cta: v.cta };
  };
  const withLink = <T extends { key: string }>(c: T): T & { link?: string } => (opts.baseLink ? { ...c, link: taggedLink(opts.baseLink, `${betId}.${info.id}.${shortKey(betId, info.id, c.key)}`) } : c);
  const fits = (a: StoredAsset) => info.formats.some((f) => f.kind === a.kind && f.ratio === a.ratio && a.bytes <= f.maxBytes && (a.kind === "image" || ((f.maxDurationSec ?? Infinity) >= (a.durationSec ?? 0) && (f.minDurationSec ?? 0) <= (a.durationSec ?? Infinity))));
  const order = (r: Ratio) => {
    const i = info.formats.findIndex((f) => f.ratio === r);
    return i === -1 ? 99 : i;
  };
  const text = () => copy.variants.map((v, n) => withLink({ key: `${betId}-${info.id}-t${n + 1}`, variant: n, format: "text" as Format, copy: words(v, false), asset: null }));
  if (opts.preferText && info.textOnly && !skip.has("text")) return text();
  // Videos: one ad per kind of video (walkthrough, presenter, generated), best ratio for the platform.
  const videos = assets.filter((a) => a.asset.kind === "video" && fits(a.asset) && !skip.has(formatOf(a.asset.source, "video")));
  if (videos.length) {
    const bySource = new Map<string, { asset: StoredAsset; variant: number }>();
    for (const a of [...videos].sort((x, y) => order(x.asset.ratio) - order(y.asset.ratio))) if (!bySource.has(a.asset.source)) bySource.set(a.asset.source, a);
    return [...bySource.values()].slice(0, 3).map((a, n) => withLink({ key: `${betId}-${info.id}-v${n + 1}`, variant: 0, format: formatOf(a.asset.source, "video"), copy: words(copy.variants[0]!, a.asset.aiPerson), asset: a.asset }));
  }
  const images = skip.has("image") ? [] : assets.filter((a) => a.asset.kind === "image" && !a.asset.label.startsWith("Cover") && fits(a.asset));
  if (images.length) {
    const out: Array<AdCreativeInput & { variant: number; format: Format }> = [];
    for (const [n, v] of copy.variants.entries()) {
      const best = images.filter((a) => a.variant === n).sort((x, y) => order(x.asset.ratio) - order(y.asset.ratio))[0];
      if (best) out.push(withLink({ key: `${betId}-${info.id}-i${n + 1}`, variant: n, format: "image" as Format, copy: words(v, best.asset.aiPerson), asset: best.asset }));
    }
    return out;
  }
  return info.textOnly && !skip.has("text") ? text() : [];
}

export type Decision = { platform: PlatformId; action: "stop" | "cut" | "scale"; dailyUsd?: number; why: string };

const costOf = (r: { adjustedCost: number | null }) => r.adjustedCost;

/** Why one cost is worse than another, saying so when how well its people stay is part of it. */
function worseBy(a: { adjustedCost: number | null; costPerOutcome: number | null; fit: number | null }, b: { adjustedCost: number | null; costPerOutcome: number | null; fit: number | null }, word: string, than: string): string {
  const times = (a.adjustedCost! / b.adjustedCost!).toFixed(1);
  const rawTimes = a.costPerOutcome && b.costPerOutcome ? a.costPerOutcome / b.costPerOutcome : null;
  const fitMatters = (a.fit ?? 1) !== (b.fit ?? 1) && rawTimes !== null && Math.abs(rawTimes - Number(times)) >= 0.2;
  return fitMatters
    ? `each ${word} costs ${rawTimes!.toFixed(1)}× as much as ${than}, and its people stay ${a.fit !== null && a.fit < 1 ? "less than" : "about as well as"} other new users (${times}× all told)`
    : `each ${word} costs ${times}× more than ${than}`;
}

/**
 * Per experiment, comparing its platforms (pure). A platform is judged once
 * it ran JUDGE_AFTER_DAYS and spent enough to tell — by cost per result,
 * adjusted for fit (results.ts). `hold` stops scale-ups (retention-link.ts).
 */
export function rebalance(campaigns: PlatformCampaign[], results: PlatformResult[], infos: Map<PlatformId, PlatformInfo>, now: Date, room: { dailyUsd: number }, word: string, hold = false): Decision[] {
  const decisions: Decision[] = [];
  const active = campaigns.filter((c) => c.status === "active");
  const res = new Map(results.map((r) => [r.platform, r]));
  const judged = active.filter((c) => {
    const min = infos.get(c.platform)?.minDailyUsd ?? 5;
    return now.getTime() - Date.parse(c.launchedAt) >= JUDGE_AFTER_DAYS * DAY && c.spendUsd >= Math.max(JUDGE_MIN_SPEND_USD, 3 * min);
  });
  const withCost = judged.filter((c) => costOf(res.get(c.platform)!) != null).sort((a, b) => costOf(res.get(a.platform)!)! - costOf(res.get(b.platform)!)!);
  const best = withCost[0];
  const bestR = best ? res.get(best.platform)! : null;
  const bestCost = bestR ? costOf(bestR)! : null;
  for (const c of judged) {
    const r = res.get(c.platform)!;
    const min = infos.get(c.platform)?.minDailyUsd ?? 5;
    const cost = costOf(r);
    if (r.outcomes === 0 && c.spendUsd >= Math.max(2 * JUDGE_MIN_SPEND_USD, 5 * min, bestCost ? 3 * bestCost : 0)) {
      decisions.push({ platform: c.platform, action: "stop", why: `spent ${money(c.spendUsd)} without a single ${word}` });
    } else if (best && bestR && c !== best && cost !== null && bestCost !== null && cost > 2.5 * bestCost) {
      const why = worseBy(r, bestR, word, `on ${infos.get(best.platform)?.name ?? best.platform}`);
      if (c.dailyBudgetUsd > min) decisions.push({ platform: c.platform, action: "cut", dailyUsd: min, why });
      else decisions.push({ platform: c.platform, action: "stop", why: `${why}, already at its minimum budget` });
    }
  }
  if (!hold && best && (!best.lastScaledAt || now.getTime() - Date.parse(best.lastScaledAt) >= SCALE_EVERY_MS)) {
    const freed = decisions.reduce((n, d) => {
      const c = active.find((x) => x.platform === d.platform);
      return n + (d.action === "stop" ? (c?.dailyBudgetUsd ?? 0) : d.action === "cut" ? (c?.dailyBudgetUsd ?? 0) - (d.dailyUsd ?? 0) : 0);
    }, 0);
    const target = Math.min(Math.round(best.dailyBudgetUsd * SCALE_FACTOR * 100) / 100, best.dailyBudgetUsd + room.dailyUsd + freed);
    const fitNote = bestR!.fit !== null && bestR!.fit > 1.05 ? ", and its people stay better than other new users" : "";
    if (target > best.dailyBudgetUsd + 0.5) decisions.push({ platform: best.platform, action: "scale", dailyUsd: target, why: `the lowest cost per ${word} (${money(bestR!.costPerOutcome!)})${fitNote}` });
  }
  return decisions;
}

/**
 * Inside one platform: ads to pause (pure). An ad is judged once it spent
 * enough; it's paused when it brought nothing while another ad did, or when
 * its fit-adjusted cost per result is 2.5× the best ad's. At least one ad keeps running.
 */
export function adDecisions(c: PlatformCampaign, r: PlatformResult): Array<{ key: string; why: string }> {
  const live = c.creatives.filter((x) => !x.paused);
  if (live.length < 2) return [];
  const rows = r.ads.filter((a) => live.some((x) => x.key === a.key) && a.spendUsd >= AD_MIN_SPEND_USD);
  const withCost = rows.filter((a) => costOf(a) !== null).sort((a, b) => costOf(a)! - costOf(b)!);
  const best = withCost[0];
  if (!best) return [];
  const bestCost = costOf(best)!;
  const out: Array<{ key: string; why: string }> = [];
  for (const a of rows) {
    if (a === best || live.length - out.length <= 1) continue;
    const cost = costOf(a);
    if (cost === null && a.spendUsd >= Math.max(2 * AD_MIN_SPEND_USD, 3 * bestCost)) out.push({ key: a.key, why: `spent ${money(a.spendUsd)} without a single result, while another ad brought them` });
    else if (cost !== null && cost > 2.5 * bestCost) out.push({ key: a.key, why: worseBy(a, best, "result", "the best ad's") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export type PlatformAdsDeps = {
  credits: CreditStore;
  platforms: Map<PlatformId, AdPlatform>;
  infos: Map<PlatformId, PlatformInfo>;
  /** Per platform: whose ad account (default day2's, billed in credits) and its currency (default USD). */
  accounts?: Map<PlatformId, { billing: Billing; currency: string }>;
  identities: PlatformIdentityStore;
  assets: AssetStore;
  providers: { creatify: VideoProvider | null; runway: VideoProvider | null };
  events: (app: AppEntry, sinceIso: string) => Promise<EventLike[] | null>;
  /** Identified users' active days (retention engine); absent = fit unknown, cost alone. */
  users?: (app: AppEntry) => Promise<UserActivity[]>;
  /** The retention engine's latest snapshot: the app's rhythm, and whether new users come back at all. */
  retention?: (app: AppEntry) => Promise<RetentionSnapshot | null>;
  /** Conversions already sent; absent = don't send conversions. */
  sentConversions?: SentConversions;
  pageHealth?: (app: AppEntry, path: string) => Promise<{ ok: boolean; reason: string }>;
  paidGate: (app: AppEntry, profile: AppProfile) => Promise<{ unlocked: boolean; reason: string }>;
  /** Overridable for tests. */
  writeCopy?: (i: CopyInput) => Promise<AdCopyPlan | null>;
  checkCopy?: (plan: AdCopyPlan, profile: AppProfile) => ReturnType<typeof checkAdCopy>;
  produce?: (i: ProduceInput) => Promise<Produced>;
  /**
   * The app's smart link (ads/app-links.ts) when it is in the App Store /
   * Google Play: ads that lead to the stores use it.
   */
  storeLink?: string | null;
  /**
   * For apps in the stores whose ads lead to the website: makes sure the
   * website sends phones on to the stores (one ticket), and checks a page.
   */
  handoff?: { ensure: () => Promise<{ ready: boolean; ticketId: string | null; why: string | null }>; pageOk: (url: string) => Promise<boolean> };
  /** The app's real screens as image files (App Store screenshots), for store-only apps' ad content. */
  storeScreens?: () => Promise<string[]>;
  /** Markets the owner set for the app (ISO codes), if any. */
  markets?: { countries: string[]; languages: string[] } | null;
};

export type PlatformAdsReport = { launched: string[]; paused: string[]; stopped: string[]; scaled: string[]; skipped: string[]; conversionsSent: number };

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
  const report: PlatformAdsReport = { launched: [], paused: [], stopped: [], scaled: [], skipped: [], conversionsSent: 0 };
  const path = resolve(app.repoPath, ADS_FILENAME);
  const betsPath = resolve(app.repoPath, BETS_FILENAME);
  const file = loadAds(path);
  let bets = loadBets(betsPath);
  // The owner's destination choice can change while a pass runs: keep theirs.
  const save = () => saveAds(path, { ...file, destination: loadAds(path).destination });
  const nameOf = (id: PlatformId) => deps.infos.get(id)?.name ?? id;
  const account = (id: PlatformId) => deps.accounts?.get(id) ?? { billing: "credits" as Billing, currency: "USD" };
  const local = (usd: number, currency: string) => (currency === "USD" ? usd : fromUsd(usd, currency));
  /** Where new ads lead: the owner's choice (destination.ts). The smart link has no page to break. */
  const destination = effectiveDestination(file.destination, Boolean(app.appBaseUrl), Boolean(deps.storeLink));
  const toStores = destination === "store" && Boolean(deps.storeLink);
  const handoff = destination === "website" && deps.storeLink ? (deps.handoff ?? null) : null;
  const healthOf = async (betId: string) => {
    const b = bets.bets.find((x) => x.id === betId);
    if (!b || toStores) return { ok: true, reason: "" };
    const page = deps.pageHealth ? await deps.pageHealth(app, b.landingPath) : { ok: true, reason: "" };
    if (page.ok && handoff && app.appBaseUrl && !(await handoff.pageOk(`${app.appBaseUrl.replace(/\/+$/, "")}${b.landingPath}`)))
      return { ok: false, reason: "the page doesn't send phones on to the App Store / Google Play yet (day2's handoff script is missing)" };
    return page;
  };
  const linkOf = (b: Bet) => (toStores ? `${deps.storeLink}?d2=${encodeURIComponent(b.id)}` : betLink(b, app.appBaseUrl));

  // Month-to-date spend, and the ad budget's cap.
  for (const c of file.campaigns) if (c.month.id !== monthId(now)) c.month = { id: monthId(now), spendAtStart: c.spendUsd };
  const monthSpend = () => file.campaigns.reduce((n, c) => n + Math.max(0, c.spendUsd - c.month.spendAtStart), 0);
  const OVER = "this month's ad budget is used up";

  // 1. Running campaigns: sync, bill, hold/resume, review.
  for (const c of file.campaigns) {
    const p = deps.platforms.get(c.platform);
    if (!p || c.status === "stopped") continue;
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
      const usd = (amount: number) => (s.currency === "USD" ? amount : toUsd(amount, s.currency));
      const spendUsd = usd(s.spend);
      // Only day2's own accounts are billed in credits; the app's own account is paid by the customer.
      if (c.billing === "credits") c.billedSpendUsd = await billAdSpend(deps.credits, { appId: app.id, campaignId: `${c.platform}:${c.launched.campaignId}`, label: `${c.betId} on ${nameOf(c.platform)}`, reportedSpendUsd: spendUsd, billedSpendUsd: c.billedSpendUsd });
      Object.assign(c, { spendUsd, impressions: s.impressions, clicks: s.clicks, lastSyncAt: at, review: s.status, currency: s.currency });
      if (s.byCreative) c.adSpendUsd = Object.fromEntries(Object.entries(s.byCreative).map(([k, v]) => [k, usd(v.spend)]));
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

  const sinceIso = [...bets.bets.map((b) => b.liveAt), ...file.campaigns.map((c) => c.launchedAt)].filter((x): x is string => Boolean(x)).sort()[0];
  const events = sinceIso ? await deps.events(app, sinceIso) : null;

  // 3. Conversions back to the platforms that brought them.
  if (events && deps.sentConversions) {
    for (const id of [...new Set(file.campaigns.map((c) => c.platform))]) {
      const p = deps.platforms.get(id);
      const info = deps.infos.get(id);
      if (!p?.ensureConversions || !p.sendConversions || !info) continue;
      try {
        let setup = file.conversions[id]?.setup;
        if (!setup) {
          setup = await p.ensureConversions();
          file.conversions[id] = { setup, at };
          save();
        }
        const sent = await deps.sentConversions.sent(app.id, id);
        const todo = collectConversions({
          platform: id,
          clickParam: info.clickIdParam,
          events,
          sent,
          pageUrl: (betId) => {
            const b = bets.bets.find((x) => x.id === betId);
            return b && app.appBaseUrl ? `${app.appBaseUrl.replace(/\/+$/, "")}${b.landingPath}` : null;
          },
        });
        for (let i = 0; i < todo.length; i += 500) {
          const batch = todo.slice(i, i + 500);
          const r = await p.sendConversions(setup, batch);
          const rejected = new Set(r.rejected.map((x) => x.eventId));
          await deps.sentConversions.markSent(app.id, id, batch.map((x) => x.eventId).filter((x) => !rejected.has(x)), now);
          report.conversionsSent += r.sent;
        }
      } catch (err) {
        log(`Couldn't send sign-ups to ${nameOf(id)}: ${(err as Error).message}`);
      }
    }
    if (report.conversionsSent) log(`Told the ad platforms about ${report.conversionsSent} sign-up${report.conversionsSent === 1 ? "" : "s"} and first uses they brought, so they find more people like them.`);
  }

  // 4. Judge per experiment: stop, pause losing ads, compare platforms.
  const users = deps.users ? await deps.users(app).catch(() => [] as UserActivity[]) : [];
  const snapshot = deps.retention ? await deps.retention(app).catch(() => null) : null;
  const retention: Retention | undefined = events && users.length ? retentionFrom(events, users, now, stayAfterDays(snapshot)) : undefined;
  const held = scaleGate(snapshot);
  if (held.hold && !file.scaleHeld) log(`Holding ad scale-ups: ${held.why}. Running ads continue.`);
  if (!held.hold && file.scaleHeld) log("New users come back often enough again — ads may scale up again.");
  file.scaleHeld = held.hold ? held.why : null;
  const allResults = new Map<string, PlatformResult[]>();
  const stopAll = async (betId: string, why: string) => {
    for (const c of file.campaigns.filter((x) => x.betId === betId && x.status !== "stopped")) {
      await deps.platforms.get(c.platform)?.pause(c.launched).catch(() => {});
      c.status = "stopped";
      c.stopReason = why;
      report.stopped.push(`${c.betId}:${c.platform}`);
    }
  };
  for (const b of bets.bets) {
    const all = file.campaigns.filter((c) => c.betId === b.id);
    if (!all.length) continue;
    if (events) allResults.set(b.id, platformResults(b, all, events, retention));
    const mine = all.filter((c) => c.status !== "stopped");
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
    const results = allResults.get(b.id)!.filter((r) => mine.some((c) => c.platform === r.platform));
    // Inside each platform: losing ads.
    for (const c of mine.filter((x) => x.status === "active")) {
      const r = results.find((x) => x.platform === c.platform);
      const p = deps.platforms.get(c.platform);
      if (!r || !p) continue;
      for (const d of adDecisions(c, r)) {
        try {
          await p.setAdActive(c.launched, d.key, false);
          const cr = c.creatives.find((x) => x.key === d.key)!;
          cr.paused = d.why;
          log(`Paused one of ${b.id}'s ads on ${nameOf(c.platform)} (${cr.format ? cr.format.replace(/_/g, " ") : "ad"}): ${d.why}.`);
        } catch (err) {
          log(`Couldn't pause an ad of ${b.id} on ${nameOf(c.platform)}: ${(err as Error).message}`);
        }
      }
    }
    // Across platforms.
    const activeDaily = file.campaigns.filter((c) => c.status === "active").reduce((n, c) => n + c.dailyBudgetUsd, 0);
    const room = { dailyUsd: Math.max(0, opts.monthlyAdsUsd / 30 - activeDaily) };
    const outcomeWord = b.metric === "signup" ? "sign-up" : "new user reaching first value";
    for (const d of rebalance(mine, results, deps.infos, now, room, outcomeWord, held.hold)) {
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
          if (d.action === "scale" && c.billing === "credits") {
            const check = await authorize(deps.credits, { appId: app.id, appName: app.name, service: "paid_ads", maxCostUsd: d.dailyUsd! * 7 }, now);
            if (!check.ok) continue;
          }
          await p.setDailyBudget(c.launched, local(d.dailyUsd!, c.currency));
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

  // 5. What day2 learned, for the next round (and the growth allocator).
  if (allResults.size) {
    const views = file.campaigns.map((c) => ({ betId: c.betId, platform: c.platform, status: c.status, stopReason: c.stopReason, creatives: c.creatives }));
    file.learnings = computeLearnings(bets.bets, views, allResults, now);
    const ads = [...allResults.entries()].flatMap(([betId, rs]) =>
      rs.flatMap((r) => {
        const c = file.campaigns.find((x) => x.betId === betId && x.platform === r.platform);
        return r.ads.map((a) => ({ key: a.key, format: c?.creatives.find((x) => x.key === a.key)?.format ?? ("image" as Format), people: a.people, outcomes: a.outcomes, spendUsd: a.spendUsd }));
      }),
    );
    const allocPath = resolve(app.repoPath, ALLOCATOR_FILENAME);
    const rec = recordInAllocator(loadAllocatorState(allocPath), ads, file.allocatorRecorded);
    if (rec.state.arms.length) saveAllocatorState(allocPath, rec.state);
    file.allocatorRecorded = rec.recorded;
    save();
  }

  // 6. Live experiments without ads: launch.
  const waiting = bets.bets.filter((b) => b.status === "live" && !b.campaign && !file.campaigns.some((c) => c.betId === b.id));
  if (!waiting.length) return report;
  if (opts.monthlyAdsUsd <= 0) {
    report.skipped.push("ads: the app has no monthly growth budget set, so day2 doesn't buy ads.");
    return report;
  }
  if (monthSpend() >= opts.monthlyAdsUsd) return report;
  if (!deps.platforms.size) {
    report.skipped.push("ads: no ad platform is connected yet.");
    return report;
  }
  const gate = await deps.paidGate(app, profile);
  if (!gate.unlocked) {
    report.skipped.push(`ads: ${gate.reason}`);
    return report;
  }

  // Ads to the website of an app in the stores: the website has to send phones on to the stores first.
  let launchHeld = false;
  if (handoff && waiting.length) {
    const h = await handoff.ensure();
    if (!h.ready && (!file.handoff || file.handoff.ready)) log(`New ads wait: ${h.why ?? "the website doesn't send phones on to the App Store / Google Play yet"}${h.ticketId ? ` (${h.ticketId})` : ""}.`);
    if (h.ready && file.handoff && !file.handoff.ready) log("The website now sends phones from ads on to the App Store / Google Play.");
    file.handoff = { ...h, at };
    save();
    launchHeld = !h.ready;
    if (launchHeld) report.skipped.push(`ads: ${h.why ?? "waiting for the website to send phones on to the stores"}`);
  }

  for (const b of launchHeld ? [] : waiting) {
    const base = linkOf(b);
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

    // Words first (they tell the audience), with what worked before, checked.
    let content = file.content.find((x) => x.betId === b.id);
    if (!content) {
      const hints = copyHints(file.learnings);
      const plan = await (deps.writeCopy ?? writeAdCopy)({ appName: app.name, profile, angle: b.angle, audience: b.audience, link: base, ...(deps.markets ?? {}), ...(hints ? { learned: hints } : {}) });
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

    // Platforms: connected, identity ready, fitting, within budget — in the order this app's results rank them.
    const ready: PlatformInfo[] = [];
    const notReady: string[] = [];
    for (const [id] of deps.platforms) {
      const info = deps.infos.get(id)!;
      if (info.identity === "app_account") {
        const ident = await deps.identities.get(app.id, id);
        if (!ident || ident.status === "pending") {
          notReady.push(`${info.name} (${ident?.status === "pending" ? (ident.todo ?? "waiting for approval") : `needs ${info.identityHelp ?? "the app's own account linked"}`})`);
          continue;
        }
      }
      ready.push(info);
    }
    const order = platformOrder(FIT_ORDER[content.copy.audience], file.learnings);
    const { chosen, skipped } = choosePlatforms(ready, content.copy.audience, daily, MAX_PLATFORMS, order);
    for (const s of skipped) report.skipped.push(`ads: ${b.id} not on ${nameOf(s.id)}: ${s.why}`);
    if (notReady.length) report.skipped.push(`ads: not ready yet: ${notReady.join("; ")}`);
    if (!chosen.length) {
      log(`No platform fits ${b.id}'s budget of ${money(daily)} a day yet${skipped[0] ? ` (${skipped[0].why})` : ""}.`);
      continue;
    }
    const onCredits = chosen.filter((c) => account(c.id).billing === "credits").reduce((n, c) => n + c.dailyUsd, 0);
    if (onCredits > 0) {
      const check = await authorize(deps.credits, { appId: app.id, appName: app.name, service: "paid_ads", maxCostUsd: onCredits * 7 }, now);
      if (!check.ok) {
        report.skipped.push(`ads: ${check.reason}`);
        log(`Didn't launch ads for ${b.id}: ${check.reason}`);
        continue;
      }
    }

    // Content, once per experiment — without formats that keep losing.
    const skip = formatsToSkip(file.learnings);
    let produced: Array<{ asset: StoredAsset; variant: number }>;
    if (content.assets.length) {
      produced = (await Promise.all(content.assets.map(async (a) => ({ asset: await deps.assets.get(a.assetId), variant: a.variant })))).filter((a): a is { asset: StoredAsset; variant: number } => Boolean(a.asset));
    } else {
      const genOk = skip.includes("presenter") && skip.includes("generated") ? { ok: false } : await authorize(deps.credits, { appId: app.id, appName: app.name, service: "content_generation", maxCostUsd: GENERATIVE_BUDGET_USD }, now);
      try {
        const screenshots = toStores && deps.storeScreens ? await deps.storeScreens().catch(() => [] as string[]) : [];
        if (toStores && !screenshots.length) {
          log(`No ads for ${b.id} yet: day2 needs the app's App Store screenshots (its real screens) to make them.`);
          continue;
        }
        const r = await (deps.produce ?? produceContent)({
          ...(screenshots.length ? { screenshots } : {}),
          appId: app.id,
          purpose: b.id,
          pageUrl: base.replace(/\?.*$/, ""),
          brand: brandOf(app, profile),
          copy: content.copy,
          platforms: chosen.map((c) => deps.infos.get(c.id)!),
          store: deps.assets,
          providers: { creatify: skip.includes("presenter") ? null : deps.providers.creatify, runway: skip.includes("generated") ? null : deps.providers.runway },
          generativeBudgetUsd: genOk.ok ? GENERATIVE_BUDGET_USD : 0,
          ...(skip.includes("walkthrough") ? { skipWalkthrough: true } : {}),
          ...(skip.includes("motion") ? { skipMotion: true } : {}),
        });
        if (r.costUsd > 0) await recordCharge(deps.credits, { id: `adgen:${app.id}:${b.id}`, appId: app.id, service: "content_generation", costUsd: r.costUsd, description: `Ad videos for ${b.id}` }, now);
        produced = r.assets;
        content.assets = r.assets.map((a) => ({ assetId: a.asset.id, variant: a.variant }));
        content.costUsd = r.costUsd;
        content.notes = [...r.notes, ...skip.map((f) => `Not made: ${f} ads (they lost in earlier experiments).`)];
        for (const n of content.notes) log(`${b.id}: ${n}`);
        const counts = { image: r.assets.filter((a) => a.asset.kind === "image" && !a.asset.label.startsWith("Cover")).length, video: r.assets.filter((a) => a.asset.kind === "video").length };
        log(`Made ${counts.image} image${counts.image === 1 ? "" : "s"} and ${counts.video} video${counts.video === 1 ? "" : "s"} for ${b.id} ${toStores ? "from the app's real screens (App Store screenshots)" : "from the app's real page"}.`, r.costUsd ? Math.round(r.costUsd * 100) : undefined);
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
      const acct = account(ch.id);
      let identity: Identity | null = null;
      try {
        identity = await identityFor(app, info, p, deps, produced);
      } catch (err) {
        log(`Couldn't set up how ${app.name} shows on ${info.name}: ${(err as Error).message}`);
        continue;
      }
      if (info.identity !== "none" && !identity) continue;
      const creatives = creativesFor(info, b.id, content.copy, produced, { preferText: ch.id === "google" && content.copy.keywords.length >= 3, baseLink: base, skip });
      if (!creatives.length) {
        report.skipped.push(`ads: nothing made for ${b.id} fits ${info.name}'s formats`);
        continue;
      }
      // Optimise for sign-ups once the platform gets enough of them from day2; until then for clicks.
      const setup = file.conversions[ch.id]?.setup;
      const recent = deps.sentConversions && setup ? await deps.sentConversions.countSince(app.id, ch.id, new Date(now.getTime() - 7 * DAY)) : 0;
      const optimizeFor = setup && recent >= OPTIMIZE_FOR_SIGNUPS_AFTER ? "signups" : "clicks";
      try {
        const launched = await p.launch({
          appId: app.id,
          appName: app.name,
          campaignName: `day2 ${app.name} ${b.id}`,
          link: taggedLink(base, `${b.id}.${ch.id}`),
          dailyBudget: local(ch.dailyUsd, acct.currency),
          currency: acct.currency,
          optimizeFor,
          ...(optimizeFor === "signups" && setup ? { conversion: setup } : {}),
          targeting: { countries: content.copy.countries, languages: content.copy.languages, ageMin: 18, audience: content.copy.audience, interests: content.copy.interests, keywords: content.copy.keywords },
          creatives: creatives.map(({ variant: _v, format: _f, ...c }) => c),
          identity,
          aiContent: creatives.some((c) => c.asset?.aiGenerated),
        });
        file.campaigns.push({
          betId: b.id,
          platform: ch.id,
          launched,
          status: "active",
          billing: acct.billing,
          currency: acct.currency,
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
          optimizeFor,
          month: { id: monthId(now), spendAtStart: 0 },
          creatives: creatives.map((c) => ({ key: c.key, variant: c.variant, assetId: c.asset?.id ?? null, kind: c.asset ? c.asset.kind : "text", format: c.format, headline: c.copy.headline, paused: null })),
        });
        save();
        report.launched.push(`${b.id}:${ch.id}`);
        const kinds = [...new Set(creatives.map((c) => (c.asset ? c.asset.kind : "text")))].join(" and ");
        log(`Launched ${b.id} on ${info.name} at ${money(ch.dailyUsd)} a day${acct.billing === "own" ? " (your ad account)" : ""}: ${creatives.length} ${kinds} ad${creatives.length === 1 ? "" : "s"}, optimising for ${optimizeFor === "signups" ? "sign-ups" : "clicks"}.`);
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
  if (have && have.status !== "pending") return { platform: info.id, ref: have.ref, displayName: have.displayName || app.name };
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
