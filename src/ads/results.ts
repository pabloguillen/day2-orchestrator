import type { UserActivity } from "../field-store";
import type { Bet } from "../growth-bets";
import type { EventLike } from "../metrics/types";
import type { PlatformId } from "./types";

/**
 * What ads brought, measured with day2's own usage events — the same
 * yardstick on every platform. Every ad carries its own tag in its link
 * (`?d2=B-4.tiktok.v1`): experiment, platform, ad. A person counts for the
 * ad that first brought them. Outcomes: the experiment's metric (sign-up or
 * first value).
 *
 * What an ad is responsible for, and what it isn't. An ad brings people to
 * the product; whether they stay is mostly the product and day2's retention
 * engine. So an ad is never judged by absolute retention. It's judged by:
 *  - cost per result (what it controls directly), and
 *  - fit: whether the people it brings stay as well as OTHER new users who
 *    started in the same weeks. Same product, same retention treatments
 *    (holdouts are random, independent of where people came from) — so the
 *    retention engine's effect cancels out, and what's left is whether the
 *    ad attracted the right people with the right promise. Fit is shrunk
 *    towards 1 (no evidence = neutral) and bounded to 0.5–1.5, so it adjusts
 *    the cost instead of overruling it.
 */

export type AdResult = {
  key: string;
  people: number;
  outcomes: number;
  /** Identified users from this ad who started long enough ago to have come back, and those who did. */
  eligible: number;
  retained: number;
  spendUsd: number;
  costPerOutcome: number | null;
  /** How well its people stay compared with other new users at the same time (1 = the same); null = too few to tell. */
  fit: number | null;
  /** Cost per result divided by fit: what ads are ranked and judged by. */
  adjustedCost: number | null;
};
export type PlatformResult = AdResult & { platform: PlatformId; ads: AdResult[] };

/** "B-4.tiktok.v1" → { bet: "B-4", platform: "tiktok", ad: "v1" }. */
export function parseTag(tag: string | undefined): { bet: string; platform?: string; ad?: string } | null {
  if (!tag) return null;
  const [bet, platform, ad] = tag.split(".");
  return bet ? { bet, ...(platform ? { platform } : {}), ...(ad ? { ad } : {}) } : null;
}

/** The ad's short tag from its creative key: "B-4-tiktok-v1" → "v1". */
export const shortKey = (betId: string, platform: string, key: string) => key.slice(`${betId}-${platform}-`.length) || key;

export type Retention = {
  /** Device → the app's (hashed) user, from events that carry both. */
  userOf: Map<string, string>;
  /** User → their first active day (YYYY-MM-DD). */
  firstDay: Map<string, string>;
  /** User → the ad tag that first brought them (any device), if one did. */
  broughtBy: Map<string, string>;
  /** Users who were active again at least `afterDays` after their first day. */
  retained: Set<string>;
  /** Users whose first day is at least `afterDays` ago (so they could have come back). */
  eligible: Set<string>;
  afterDays: number;
};

const DAY = 86_400_000;

/** How long after their first day a user has to be seen again to count as staying, by the app's rhythm. */
export const STAY_AFTER_DAYS: Record<"daily" | "weekly" | "monthly", number> = { daily: 7, weekly: 14, monthly: 30 };

export function retentionFrom(events: EventLike[], users: UserActivity[], now: Date, afterDays = 7): Retention {
  const userOf = new Map<string, string>();
  for (const e of events) if (e.userId && !userOf.has(e.deviceId)) userOf.set(e.deviceId, e.userId);
  // The first tagged visit per device, then per user (earliest device wins).
  const firstTag = new Map<string, { at: string; tag: string }>();
  for (const e of events) {
    const tag = e.acquisition?.campaignId;
    if (e.type !== "visit" || !tag) continue;
    const prev = firstTag.get(e.deviceId);
    if (!prev || e.at < prev.at) firstTag.set(e.deviceId, { at: e.at, tag });
  }
  const best = new Map<string, { at: string; tag: string }>();
  for (const [device, t] of firstTag) {
    const user = userOf.get(device);
    if (!user) continue;
    const prev = best.get(user);
    if (!prev || t.at < prev.at) best.set(user, t);
  }
  const broughtBy = new Map([...best].map(([u, t]) => [u, t.tag]));
  const retained = new Set<string>();
  const eligible = new Set<string>();
  const firstDay = new Map<string, string>();
  for (const u of users) {
    firstDay.set(u.user, u.firstSeen);
    const first = Date.parse(`${u.firstSeen}T00:00:00Z`);
    if (now.getTime() - first < afterDays * DAY) continue;
    eligible.add(u.user);
    if (u.days.some((d) => Date.parse(`${d}T00:00:00Z`) - first >= afterDays * DAY)) retained.add(u.user);
  }
  return { userOf, firstDay, broughtBy, retained, eligible, afterDays };
}

/** Below these, fit is unknown (null): the comparison group and the ad's own users. */
export const FIT_MIN_BASELINE = 20;
export const FIT_MIN_USERS = 5;
/** Prior strength: an ad's users count against this many "average" users before fit moves. */
const FIT_PRIOR = 10;

/**
 * Pure. Relative staying power of an ad's users against the comparison group
 * (other new users in the same window), shrunk towards 1 and bounded.
 */
export function fitOf(ad: { eligible: number; retained: number }, baseline: { eligible: number; retained: number }): number | null {
  if (baseline.eligible < FIT_MIN_BASELINE || ad.eligible < FIT_MIN_USERS) return null;
  const base = baseline.retained / baseline.eligible;
  if (base <= 0) return null;
  const posterior = (ad.retained + FIT_PRIOR * base) / (ad.eligible + FIT_PRIOR);
  return Math.round(Math.min(1.5, Math.max(0.5, posterior / base)) * 100) / 100;
}

/**
 * The comparison group for one experiment: identified users whose first day
 * is on or after `since` (the experiment's first launch) and who did NOT come
 * from this experiment's ads — organic users, other experiments, other channels.
 */
export function baselineFor(betId: string, since: string, retention: Retention): { eligible: number; retained: number } {
  let eligible = 0;
  let retained = 0;
  const day = since.slice(0, 10);
  for (const u of retention.eligible) {
    if ((retention.firstDay.get(u) ?? "") < day) continue;
    if (parseTag(retention.broughtBy.get(u))?.bet === betId) continue;
    eligible++;
    if (retention.retained.has(u)) retained++;
  }
  return { eligible, retained };
}

type CampaignLike = { platform: PlatformId; spendUsd: number; launchedAt?: string; creatives: Array<{ key: string }>; adSpendUsd?: Record<string, number> };

/** Per platform and per ad, for one experiment. */
export function platformResults(bet: Bet, campaigns: CampaignLike[], events: EventLike[], retention?: Retention): PlatformResult[] {
  const outcome = bet.metric === "signup" ? "signup" : "activated";
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const l = byDevice.get(e.deviceId);
    if (l) l.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  type T = { people: number; outcomes: number; eligible: number; retained: number };
  const blank = (): T => ({ people: 0, outcomes: 0, eligible: 0, retained: 0 });
  const perPlatform = new Map<string, T>();
  const perAd = new Map<string, T>();
  for (const [device, list] of byDevice) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const tag = parseTag(list[0]!.acquisition?.campaignId);
    if (!tag || tag.bet !== bet.id || !tag.platform) continue;
    const reached = list.some((e) => e.type === outcome);
    const user = retention?.userOf.get(device);
    const eligible = Boolean(user && retention?.eligible.has(user));
    const kept = Boolean(user && retention?.retained.has(user));
    for (const [map, k] of [[perPlatform, tag.platform], ...(tag.ad ? [[perAd, `${tag.platform}.${tag.ad}`] as const] : [])] as Array<[Map<string, T>, string]>) {
      const t = map.get(k) ?? blank();
      t.people++;
      if (reached) t.outcomes++;
      if (eligible) t.eligible++;
      if (kept) t.retained++;
      map.set(k, t);
    }
  }
  const cost = (spend: number, n: number) => (n > 0 ? spend / n : null);
  const since = campaigns.map((c) => c.launchedAt ?? bet.liveAt ?? bet.createdAt).sort()[0] ?? bet.createdAt;
  const baseline = retention ? baselineFor(bet.id, since, retention) : { eligible: 0, retained: 0 };
  const judge = (t: T, spend: number) => {
    const costPerOutcome = cost(spend, t.outcomes);
    const fit = fitOf(t, baseline);
    return { costPerOutcome, fit, adjustedCost: costPerOutcome === null ? null : costPerOutcome / (fit ?? 1) };
  };
  return campaigns.map((c) => {
    const t = perPlatform.get(c.platform) ?? blank();
    const ads = c.creatives.map((cr) => {
      const short = shortKey(bet.id, c.platform, cr.key);
      const a = perAd.get(`${c.platform}.${short}`) ?? blank();
      const spend = c.adSpendUsd?.[cr.key] ?? 0;
      return { key: cr.key, ...a, spendUsd: spend, ...judge(a, spend) };
    });
    return { platform: c.platform, key: c.platform, ...t, spendUsd: c.spendUsd, ...judge(t, c.spendUsd), ads };
  });
}
