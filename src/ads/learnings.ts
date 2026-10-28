import { recordOutcome, type AllocatorState, type Arm } from "../growth-allocator";
import type { Bet } from "../growth-bets";
import type { PlatformResult } from "./results";
import type { PlatformId } from "./types";

/**
 * What day2 has learned from an app's ads, across experiments — and where
 * it goes next:
 *  - platforms: ranked by cost per result → the order platforms are picked
 *    in for the next experiment;
 *  - formats (app walkthrough video, AI presenter, generated motion, image,
 *    search text): wins and losses per experiment → what gets made next
 *    (a format that lost twice and never won isn't made again);
 *  - copy: the headlines that brought results cheapest, and the ones that
 *    didn't → shown to the copy writer for the next experiment;
 *  - angles: experiments that worked or failed → shown to market research
 *    when it looks for the next ideas;
 *  - the growth allocator gets every ad's people and outcomes as format
 *    trials, so its picture of what works includes paid ads.
 */

export type Format = "walkthrough" | "presenter" | "generated" | "image" | "text";
export const FORMAT_LABEL: Record<Format, string> = { walkthrough: "App walkthrough video", presenter: "AI presenter video", generated: "Generated motion video", image: "Image", text: "Search text" };

export function formatOf(source: string | null, kind: "image" | "video" | "text"): Format {
  if (kind === "text") return "text";
  if (source === "creatify") return "presenter";
  if (source === "runway") return "generated";
  return kind === "video" ? "walkthrough" : "image";
}

export type Learnings = {
  at: string;
  /** "retained": judged by users who stayed; "outcome": by sign-ups / first value. */
  judgedBy: "retained" | "outcome";
  platforms: Array<{ platform: PlatformId; people: number; outcomes: number; retained: number; spendUsd: number; costUsd: number | null }>;
  formats: Array<{ format: Format; ads: number; people: number; outcomes: number; spendUsd: number; costUsd: number | null; wins: number; losses: number }>;
  copy: { winners: Array<{ headline: string; betId: string; platform: PlatformId; costUsd: number }>; losers: Array<{ headline: string; betId: string; platform: PlatformId }> };
  angles: { winners: Array<{ betId: string; angle: string }>; losers: Array<{ betId: string; angle: string; why: string }> };
};

export type CampaignView = {
  betId: string;
  platform: PlatformId;
  status: string;
  stopReason: string | null;
  creatives: Array<{ key: string; format?: Format; headline?: string }>;
};

const MIN_AD_SPEND_USD = 15;

/** Pure. `results` per experiment id. */
export function computeLearnings(bets: Bet[], campaigns: CampaignView[], results: Map<string, PlatformResult[]>, judgedBy: "retained" | "outcome", now: Date): Learnings {
  const score = (r: { outcomes: number; retained: number }) => (judgedBy === "retained" ? r.retained : r.outcomes);
  const plat = new Map<PlatformId, Learnings["platforms"][number]>();
  const fmt = new Map<Format, Learnings["formats"][number]>();
  const winners: Learnings["copy"]["winners"] = [];
  const losers: Learnings["copy"]["losers"] = [];
  for (const [betId, rs] of results) {
    const adRows: Array<{ format: Format; cost: number | null; spend: number; headline?: string; platform: PlatformId }> = [];
    for (const r of rs) {
      const p = plat.get(r.platform) ?? { platform: r.platform, people: 0, outcomes: 0, retained: 0, spendUsd: 0, costUsd: null };
      p.people += r.people;
      p.outcomes += r.outcomes;
      p.retained += r.retained;
      p.spendUsd += r.spendUsd;
      plat.set(r.platform, p);
      const c = campaigns.find((x) => x.betId === betId && x.platform === r.platform);
      for (const a of r.ads) {
        const cr = c?.creatives.find((x) => x.key === a.key);
        const format = cr?.format ?? "image";
        const f = fmt.get(format) ?? { format, ads: 0, people: 0, outcomes: 0, spendUsd: 0, costUsd: null, wins: 0, losses: 0 };
        f.ads++;
        f.people += a.people;
        f.outcomes += score(a);
        f.spendUsd += a.spendUsd;
        fmt.set(format, f);
        const n = score(a);
        adRows.push({ format, cost: n ? a.spendUsd / n : null, spend: a.spendUsd, platform: r.platform, ...(cr?.headline ? { headline: cr.headline } : {}) });
      }
    }
    // Within the experiment: the cheapest ad wins, an ad that spent without results (or cost most) loses.
    const judged = adRows.filter((a) => a.spend >= MIN_AD_SPEND_USD);
    if (judged.length >= 2) {
      const withCost = judged.filter((a) => a.cost !== null).sort((a, b) => a.cost! - b.cost!);
      const best = withCost[0];
      const worst = judged.find((a) => a.cost === null) ?? (withCost.length >= 2 ? withCost.at(-1) : undefined);
      if (best) {
        fmt.get(best.format)!.wins++;
        if (best.headline) winners.push({ headline: best.headline, betId, platform: best.platform, costUsd: best.cost! });
      }
      if (worst && worst !== best) {
        fmt.get(worst.format)!.losses++;
        if (worst.headline) losers.push({ headline: worst.headline, betId, platform: worst.platform });
      }
    }
  }
  const withCostP = [...plat.values()].map((p) => ({ ...p, costUsd: score(p) ? p.spendUsd / score(p) : null }));
  const withCostF = [...fmt.values()].map((f) => ({ ...f, costUsd: f.outcomes ? f.spendUsd / f.outcomes : null }));
  const byCost = <T extends { costUsd: number | null; spendUsd: number }>(a: T, b: T) => (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity) || b.spendUsd - a.spendUsd;
  return {
    at: now.toISOString(),
    judgedBy,
    platforms: withCostP.sort(byCost),
    formats: withCostF.sort(byCost),
    copy: { winners: winners.sort((a, b) => a.costUsd - b.costUsd).slice(0, 5), losers: losers.slice(0, 5) },
    angles: {
      winners: bets.filter((b) => b.status !== "stopped" && results.get(b.id)?.some((r) => score(r) > 0)).map((b) => ({ betId: b.id, angle: b.angle })),
      losers: bets.filter((b) => b.status === "stopped" && b.stopReason).map((b) => ({ betId: b.id, angle: b.angle, why: b.stopReason!.replace(/^Stopped by day2: /, "") })),
    },
  };
}

/** The platforms in the order to try them for this app: proven cheapest first, untested in the usual order, proven useless last. */
export function platformOrder(base: PlatformId[], l: Learnings | null): PlatformId[] {
  if (!l) return base;
  const known = new Map(l.platforms.map((p) => [p.platform, p]));
  const proven = l.platforms.filter((p) => base.includes(p.platform) && p.costUsd !== null).map((p) => p.platform);
  const useless = l.platforms.filter((p) => base.includes(p.platform) && p.costUsd === null && p.spendUsd >= 50).map((p) => p.platform);
  const rest = base.filter((id) => !proven.includes(id) && !useless.includes(id) && (known.get(id)?.costUsd ?? null) === null);
  return [...proven, ...rest, ...useless];
}

/** Formats not worth making again: lost in at least two experiments and never won. */
export function formatsToSkip(l: Learnings | null): Format[] {
  return (l?.formats ?? []).filter((f) => f.losses >= 2 && f.wins === 0).map((f) => f.format);
}

/** For the copy writer: what worked and what didn't, in this app's own ads. */
export function copyHints(l: Learnings | null): string | null {
  if (!l || (!l.copy.winners.length && !l.copy.losers.length && !l.angles.losers.length)) return null;
  const lines = [
    ...l.copy.winners.slice(0, 3).map((w) => `Worked (cheapest results, ${w.platform}): "${w.headline}"`),
    ...l.copy.losers.slice(0, 3).map((w) => `Didn't work (${w.platform}): "${w.headline}"`),
    ...l.angles.losers.slice(0, 2).map((a) => `Angle that failed: "${a.angle}" (${a.why})`),
  ];
  return lines.join("\n");
}

/** For market research: angles that worked and failed in this app's ads. */
export function researchHint(l: Learnings | null): string | null {
  if (!l || (!l.angles.winners.length && !l.angles.losers.length)) return null;
  const w = l.angles.winners.slice(0, 3).map((a) => a.angle);
  const f = l.angles.losers.slice(0, 3).map((a) => a.angle);
  return [w.length ? `worked: ${w.join("; ")}` : "", f.length ? `failed: ${f.join("; ")}` : ""].filter(Boolean).join(" — ");
}

/**
 * Feeds ad results into the growth allocator as format trials: every new
 * person an ad brought is one attempt, a success when they reached the
 * outcome. `recorded` remembers what was already counted, per ad.
 */
export function recordInAllocator(state: AllocatorState, ads: Array<{ key: string; format: Format; people: number; outcomes: number; spendUsd: number }>, recorded: Record<string, { people: number; outcomes: number; spendUsd: number }>): { state: AllocatorState; recorded: Record<string, { people: number; outcomes: number; spendUsd: number }> } {
  let s = state;
  const next = { ...recorded };
  for (const a of ads) {
    const prev = next[a.key] ?? { people: 0, outcomes: 0, spendUsd: 0 };
    const people = Math.max(0, a.people - prev.people);
    const wins = Math.min(people, Math.max(0, a.outcomes - prev.outcomes));
    const spend = Math.max(0, a.spendUsd - prev.spendUsd);
    if (!people) continue;
    const arm: Arm = {
      channel: "paid_ads" as Arm["channel"],
      assetType: a.format === "text" ? "text" : a.format === "image" ? "image" : "video",
      ...(a.format === "presenter" ? { videoFormat: "ugc" as const } : a.format === "walkthrough" || a.format === "generated" ? { videoFormat: "motion_graphics" as const } : {}),
      formatTag: a.format,
    };
    for (let i = 0; i < people; i++) s = recordOutcome(s, arm, i < wins, i === 0 ? spend : 0);
    next[a.key] = { people: a.people, outcomes: a.outcomes, spendUsd: a.spendUsd };
  }
  return { state: s, recorded: next };
}
