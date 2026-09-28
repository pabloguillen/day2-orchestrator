/**
 * Step 4 (self-distributing), Component 2 — app-stage growth strategy
 * (COORDINATION.md W39, docs/step4-self-distributing-plan.md).
 *
 * Depends on Component 1's `BudgetConfig`/`KpiGoal` (spend-governance.ts),
 * the real `AppProfile` (onboarding.ts), real per-device signals (fetched
 * live from expense-buddy's `/api/day2-stats`, W39's other half), and —
 * optionally — competitor/trend insights.
 *
 * v1 macro layer is a fixed rule table, same honesty discipline as
 * `decideSlotConfig` (Step 2): stage boundaries and channel weights are
 * hardcoded, not learned, and every non-obvious number in this file is
 * either a named safety rail from the plan or an explicitly disclosed
 * judgment call in a comment next to it — never a silently invented
 * constant.
 *
 * `CompetitorAngleInsight`/`SocialTrendInsight` are specified by the plan
 * as belonging to Component 5 (`growth-creative.ts` / an extended
 * `competitor-feed.ts`), which doesn't exist yet. Defined locally here,
 * matching the plan's exact shapes, so Component 2 isn't blocked on
 * Component 5's build order. `competitor-feed.ts` today only exports the
 * unrelated, Step-3 `CompetitorInsight` — not reused here since its shape
 * (feature/relevance/source, no `channel`/`angle`) doesn't match what this
 * plan specifies for growth strategy. Component 5 should absorb these two
 * types when it lands, not redefine them.
 */

import type { AppProfile } from "./onboarding";
import type { BudgetConfig, KpiGoal } from "./spend-governance";

export type AppStage = "launch" | "traction" | "growth" | "scale";

export type StageSignals = {
  activeUsers: number;
  /** Fraction (0-1) of ever-seen devices classified "established" by the
   * per-user model, or null when there's no observed population yet to
   * compute a fraction from (never fabricated as 0). Mirrors
   * expense-buddy's `Day2Stats.retentionSignal` exactly. */
  retentionSignal: number | null;
};

export type CompetitorAngleInsight = {
  competitor: string;
  angle: string;
  channel: string;
  relevance: string;
  source: string;
};

export type SocialTrendInsight = {
  platform: "tiktok" | "instagram" | "other";
  trend: string;
  format: string;
  relevance: string;
};

/**
 * The plan's own channel union for `ChannelAllocation`, distinct from
 * Component 1's `SpendCategory` (spend-governance.ts) — the two overlap
 * but aren't identical. `referral_loops` is a real growth channel with no
 * dollar spend attached to it (mechanically free word-of-mouth), so it was
 * never meant to be a *budget* category Component 1 needs to govern; it's
 * deliberately absent from `SpendCategory`. `website` and `direct_outreach`
 * exist in both unions and mean the same thing in each. Keeping this as
 * its own type (rather than reusing/widening `SpendCategory`) avoids
 * either lying to the type checker about `referral_loops` being a spend
 * category, or silently widening Component 1's own governed-category list
 * to include a channel it was never meant to cap spend on.
 */
export type GrowthChannel =
  | "aso"
  | "seo_content"
  | "referral_loops"
  | "social_content"
  | "paid_ads"
  | "direct_outreach"
  | "website";

export type ChannelAllocation = {
  channel: GrowthChannel;
  budgetUsd: number;
  rationale: string;
  frequencyPerWeek: number;
};

export type GrowthStrategy = {
  stage: AppStage;
  stageBasis: string;
  totalBudgetUsd: number;
  allocations: ChannelAllocation[];
  paidAcquisitionUnlocked: boolean;
  unlockBasis: string;
  kpiGoals: KpiGoal[];
  competitorSignal?: string;
  derivedAt: string;
};

/** Stage boundaries. Disclosed judgment call (the plan names the stages
 * and their free/paid character but not exact user-count thresholds):
 * launch <100, traction 100-4,999, growth/scale >=5,000 — the plan's own
 * "traction (100-5,000)" range read as a half-open interval. `scale` is
 * reserved for a much larger, KPI-verified population; v1 has no signal
 * that could ever justify placing an app there, so it's defined but
 * unreachable by this function until a future revision adds a real
 * scale-detection signal — never guessed at from user count alone. */
const TRACTION_MIN_USERS = 100;
const GROWTH_MIN_USERS = 5000;

/** Safety rail 1 ("no paid_ads while in launch, regardless of remaining
 * budget") also gates traction: paid_ads only unlocks past a retention
 * threshold, not just a user-count threshold — an app with 200 users and
 * no one sticking around has nothing worth paying to acquire more of.
 * Disclosed judgment call: 0.2 (20% established-device fraction). */
const TRACTION_RETENTION_THRESHOLD = 0.2;

export function deriveAppStage(signals: StageSignals): { stage: AppStage; basis: string } {
  const { activeUsers } = signals;
  if (activeUsers < TRACTION_MIN_USERS) {
    return {
      stage: "launch",
      basis: `${activeUsers} active users is below the ${TRACTION_MIN_USERS}-user launch/traction boundary.`,
    };
  }
  if (activeUsers < GROWTH_MIN_USERS) {
    return {
      stage: "traction",
      basis: `${activeUsers} active users is within the traction range (${TRACTION_MIN_USERS}-${GROWTH_MIN_USERS - 1}).`,
    };
  }
  return {
    stage: "growth",
    basis: `${activeUsers} active users meets the ${GROWTH_MIN_USERS}-user growth boundary. ` +
      `("scale" is not reachable from user count alone in v1 — no signal exists yet to distinguish it from "growth".)`,
  };
}

function buildLaunchAllocations(totalBudgetUsd: number): ChannelAllocation[] {
  return [
    {
      channel: "aso",
      budgetUsd: 0,
      rationale: "Launch stage (<100 active users): 100% free channels per safety rail 1 — paid_ads is hard-locked regardless of remaining budget.",
      frequencyPerWeek: 2,
    },
    {
      channel: "seo_content",
      budgetUsd: 0,
      rationale: "Free organic content — no paid spend justified with this little signal on what resonates yet.",
      frequencyPerWeek: 1,
    },
    {
      channel: "social_content",
      budgetUsd: 0,
      rationale: "Free organic posting to start building a format/response baseline before any paid amplification.",
      frequencyPerWeek: 3,
    },
    {
      channel: "referral_loops",
      budgetUsd: 0,
      rationale: "Mechanically free (word-of-mouth) — appropriate at any stage, including launch.",
      frequencyPerWeek: 1,
    },
  ];
}

function buildTractionAllocations(
  totalBudgetUsd: number,
  paidUnlocked: boolean,
  trendInsights: SocialTrendInsight[],
): ChannelAllocation[] {
  const trendNote = trendInsights.length > 0
    ? ` Social format weighted by observed trend(s): ${trendInsights.map((t) => `${t.platform}/${t.format}`).join(", ")}.`
    : "";
  const allocations: ChannelAllocation[] = [
    {
      channel: "referral_loops",
      budgetUsd: 0,
      rationale: "Primary traction-stage lever: turns an existing (if small) user base into free acquisition.",
      frequencyPerWeek: 2,
    },
    {
      channel: "social_content",
      budgetUsd: paidUnlocked ? Math.round(totalBudgetUsd * 0.2) : 0,
      rationale: `Organic + light paid boosting of the best-performing organic posts.${trendNote}`,
      frequencyPerWeek: 4,
    },
    {
      channel: "seo_content",
      budgetUsd: 0,
      rationale: "Still free — compounding organic content, not yet worth paying to accelerate at this size.",
      frequencyPerWeek: 2,
    },
  ];
  if (paidUnlocked) {
    allocations.push({
      channel: "paid_ads",
      budgetUsd: Math.round(totalBudgetUsd * 0.15),
      rationale: `Small paid_ads slice unlocked: retention signal is at/above the ${TRACTION_RETENTION_THRESHOLD} threshold, so acquiring more users is worth paying for.`,
      frequencyPerWeek: 3,
    });
  }
  return allocations;
}

function buildGrowthAllocations(totalBudgetUsd: number, ltvCaveat: string): ChannelAllocation[] {
  return [
    {
      channel: "paid_ads",
      budgetUsd: Math.round(totalBudgetUsd * 0.5),
      rationale: `Paid scaling, intended to run "while LTV > CAC." ${ltvCaveat}`,
      frequencyPerWeek: 7,
    },
    {
      channel: "social_content",
      budgetUsd: Math.round(totalBudgetUsd * 0.2),
      rationale: "Sustained content pace to keep paid creative supplied with fresh organic-tested angles.",
      frequencyPerWeek: 5,
    },
    {
      channel: "referral_loops",
      budgetUsd: 0,
      rationale: "Still free and still compounding — never displaced by paid growth.",
      frequencyPerWeek: 3,
    },
    {
      channel: "seo_content",
      budgetUsd: Math.round(totalBudgetUsd * 0.1),
      rationale: "Light paid acceleration of organic content production at this size.",
      frequencyPerWeek: 2,
    },
  ];
}

/**
 * "LTV > CAC" needs a real revenue signal to ever be verified, and this
 * codebase has no billing/pricing/payment layer anywhere (confirmed by
 * direct search of expense-buddy's source) — so `businessModel` being
 * null or non-monetary both mean the same thing here: there's nothing to
 * compute LTV from. Driven off the real, onboarding-scanned `AppProfile`
 * (not a hardcoded assumption) so this caveat stays honest if a future
 * app profile *does* carry a real monetization model — it would still
 * need actual billing data (not just a business-model description) to
 * make the claim true, which this function makes explicit either way. */
function buildLtvCaveat(appProfile: AppProfile): string {
  const modelNote = appProfile.businessModel
    ? `Onboarding recorded a business model ("${appProfile.businessModel}"), but no billing/payment/pricing code exists in the app to derive real revenue from.`
    : "No business model was captured during onboarding, and no billing/payment/pricing code exists in the app.";
  return `LTV > CAC is UNVERIFIABLE for this app: ${modelNote} This allocation is a stage-based default, not a profitability-verified one.`;
}

export function deriveGrowthStrategy(
  budget: BudgetConfig,
  appProfile: AppProfile,
  stageSignals: StageSignals,
  kpiGoals: KpiGoal[],
  competitorAngles: CompetitorAngleInsight[] = [],
  trendInsights: SocialTrendInsight[] = [],
): GrowthStrategy {
  const { stage, basis } = deriveAppStage(stageSignals);
  const totalBudgetUsd = budget.monthlyBudgetUsd;

  let allocations: ChannelAllocation[];
  let paidAcquisitionUnlocked: boolean;
  let unlockBasis: string;

  if (stage === "launch") {
    allocations = buildLaunchAllocations(totalBudgetUsd);
    paidAcquisitionUnlocked = false;
    unlockBasis = "Safety rail 1: no paid_ads while in launch stage, regardless of remaining budget or retention signal.";
  } else if (stage === "traction") {
    const retention = stageSignals.retentionSignal;
    paidAcquisitionUnlocked = retention !== null && retention >= TRACTION_RETENTION_THRESHOLD;
    unlockBasis = retention === null
      ? `Retention signal not yet observable (no devices with events yet) — paid_ads stays locked until it is.`
      : paidAcquisitionUnlocked
        ? `Retention signal ${retention.toFixed(2)} meets the ${TRACTION_RETENTION_THRESHOLD} traction-stage threshold — small paid_ads slice unlocked.`
        : `Retention signal ${retention.toFixed(2)} is below the ${TRACTION_RETENTION_THRESHOLD} traction-stage threshold — paid_ads stays locked.`;
    allocations = buildTractionAllocations(totalBudgetUsd, paidAcquisitionUnlocked, trendInsights);
  } else {
    paidAcquisitionUnlocked = true;
    unlockBasis = `Stage is "${stage}" — paid acquisition is unlocked by user-count alone at this size, subject to the LTV caveat below.`;
    allocations = buildGrowthAllocations(totalBudgetUsd, buildLtvCaveat(appProfile));
  }

  const competitorSignal = competitorAngles.length > 0
    ? competitorAngles.map((c) => `${c.competitor} (${c.channel}): ${c.angle} — ${c.relevance}`).join(" | ")
    : undefined;

  return {
    stage,
    stageBasis: basis,
    totalBudgetUsd,
    allocations,
    paidAcquisitionUnlocked,
    unlockBasis,
    kpiGoals,
    competitorSignal,
    derivedAt: new Date().toISOString(),
  };
}

/** Live signal fetch from expense-buddy's `/api/day2-stats` (W39, this
 * same component's other half). Fail-closed: any fetch failure or
 * malformed response is surfaced as a thrown error, never silently
 * defaulted to a fabricated `{ activeUsers: 0 }` — a caller who can't
 * reach the stats endpoint has no basis to derive *any* stage, launch
 * included, and should say so rather than guess launch by omission. */
export async function fetchStageSignals(appBaseUrl: string): Promise<StageSignals> {
  const res = await fetch(`${appBaseUrl}/api/day2-stats`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`day2-stats fetch failed: ${res.status} ${await res.text()}`);
  }
  const stats = (await res.json()) as { activeUsers: number; retentionSignal: number | null };
  return { activeUsers: stats.activeUsers, retentionSignal: stats.retentionSignal };
}

export function renderGrowthStrategySummary(strategy: GrowthStrategy): string {
  const lines: string[] = [];
  lines.push(`Stage: ${strategy.stage} (${strategy.stageBasis})`);
  lines.push(`Paid acquisition: ${strategy.paidAcquisitionUnlocked ? "unlocked" : "locked"} — ${strategy.unlockBasis}`);
  lines.push(`Monthly budget: $${strategy.totalBudgetUsd}`);
  lines.push("Allocations:");
  for (const a of strategy.allocations) {
    lines.push(`  - ${a.channel}: $${a.budgetUsd}/mo, ${a.frequencyPerWeek}x/week — ${a.rationale}`);
  }
  if (strategy.kpiGoals.length > 0) {
    lines.push(`KPI goals: ${strategy.kpiGoals.map((g) => `${g.metric} -> ${g.target}${g.byDate ? ` by ${g.byDate}` : ""}`).join(", ")}`);
  }
  if (strategy.competitorSignal) {
    lines.push(`Competitor signal: ${strategy.competitorSignal}`);
  }
  lines.push(`Derived at: ${strategy.derivedAt}`);
  return lines.join("\n");
}
