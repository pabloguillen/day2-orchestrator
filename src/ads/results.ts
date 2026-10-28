import type { UserActivity } from "../field-store";
import type { Bet } from "../growth-bets";
import type { EventLike } from "../metrics/types";
import type { PlatformId } from "./types";

/**
 * What ads brought, measured with day2's own usage events — the same
 * yardstick on every platform. Every ad carries its own tag in its link
 * (`?d2=B-4.tiktok.v1`): experiment, platform, ad. A person counts for the
 * ad that first brought them. Outcomes: the experiment's metric (sign-up or
 * first value). Retained: they were still active a while after their first
 * day (needs the app to identify users — retention engine).
 */

export type AdResult = { key: string; people: number; outcomes: number; eligible: number; retained: number; spendUsd: number; costPerOutcome: number | null; costPerRetained: number | null };
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
  /** Users who were active again at least `afterDays` after their first day. */
  retained: Set<string>;
  /** Users whose first day is at least `afterDays` ago (so they could have come back). */
  eligible: Set<string>;
  afterDays: number;
};

const DAY = 86_400_000;

export function retentionFrom(events: EventLike[], users: UserActivity[], now: Date, afterDays = 7): Retention {
  const userOf = new Map<string, string>();
  for (const e of events) if (e.userId && !userOf.has(e.deviceId)) userOf.set(e.deviceId, e.userId);
  const retained = new Set<string>();
  const eligible = new Set<string>();
  for (const u of users) {
    const first = Date.parse(`${u.firstSeen}T00:00:00Z`);
    if (now.getTime() - first < afterDays * DAY) continue;
    eligible.add(u.user);
    if (u.days.some((d) => Date.parse(`${d}T00:00:00Z`) - first >= afterDays * DAY)) retained.add(u.user);
  }
  return { userOf, retained, eligible, afterDays };
}

type CampaignLike = { platform: PlatformId; spendUsd: number; creatives: Array<{ key: string }>; adSpendUsd?: Record<string, number> };

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
  return campaigns.map((c) => {
    const t = perPlatform.get(c.platform) ?? blank();
    const ads = c.creatives.map((cr) => {
      const short = shortKey(bet.id, c.platform, cr.key);
      const a = perAd.get(`${c.platform}.${short}`) ?? blank();
      const spend = c.adSpendUsd?.[cr.key] ?? 0;
      return { key: cr.key, ...a, spendUsd: spend, costPerOutcome: cost(spend, a.outcomes), costPerRetained: cost(spend, a.retained) };
    });
    return { platform: c.platform, key: c.platform, ...t, spendUsd: c.spendUsd, costPerOutcome: cost(c.spendUsd, t.outcomes), costPerRetained: cost(c.spendUsd, t.retained), ads };
  });
}

/**
 * Which number to judge by: users who stayed, once enough of them could
 * have come back (≥ 10 eligible across the experiment's platforms);
 * otherwise sign-ups / first value.
 */
export function judgeBy(results: PlatformResult[]): "retained" | "outcome" {
  return results.reduce((n, r) => n + r.eligible, 0) >= 10 ? "retained" : "outcome";
}
