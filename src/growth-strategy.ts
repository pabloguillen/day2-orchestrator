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
 * `CompetitorAngleInsight`/`SocialTrendInsight` were originally specified
 * by the plan as belonging to Component 5 (`growth-creative.ts` / an
 * extended `competitor-feed.ts`), which didn't exist when this file was
 * first built — local stand-ins were defined here at the time, disclosed
 * as "Component 5 should absorb these when it lands." Component 5 (W42)
 * has now landed them for real in `competitor-feed.ts`; imported from
 * there below instead of redefined. One real fix picked up by the dedupe:
 * the local `SocialTrendInsight` was missing `source` (a plain oversight,
 * not a deliberate simplification) — the real, landed type has it.
 *
 * **W45 extension**: `deriveGrowthStrategy` gained an optional
 * `stageComparables: StageComparableInsight[]` (`growth-patterns.ts`) —
 * real, now-successful companies' growth strategy at an equivalent
 * *earlier* stage, not their current mature-company playbook. Filtered
 * internally to only entries whose `observedStage` matches this
 * strategy's own derived `stage` before ever reaching `stageComparableSignal`
 * — a stage-mismatched comparable is silently dropped, never surfaced as
 * if it applied, matching every other supporting-evidence-only field here
 * (`competitorSignal` included): cited in rationale, never able to
 * override a stage-based hard rule.
 */

import type { AppProfile } from "./onboarding";
import type { CompetitorAngleInsight, SocialTrendInsight } from "./competitor-feed";
import type { StageComparableInsight } from "./growth-patterns";
import type { BudgetConfig, KpiGoal } from "./spend-governance";
import { computeDauWauMau, computeRetention, DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG } from "./metrics";
import type { AppMetricConfig, EventLike } from "./metrics";

export type { CompetitorAngleInsight, SocialTrendInsight } from "./competitor-feed";

export type AppStage = "launch" | "traction" | "growth" | "scale";

export type StageSignals = {
  activeUsers: number;
  /** Fraction (0-1) of ever-seen devices classified "established" by the
   * per-user model, or null when there's no observed population yet to
   * compute a fraction from (never fabricated as 0). Mirrors
   * expense-buddy's `Day2Stats.retentionSignal` exactly. */
  retentionSignal: number | null;
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
  /** W45 extension. Only ever built from `stageComparables` entries whose
   * `observedStage` matches this strategy's own derived `stage` — a
   * comparable company's *current, mature* strategy is not evidence for
   * an app at a different stage, so a mismatched entry is silently
   * dropped here, not surfaced as if it applied. */
  stageComparableSignal?: string;
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
  stageComparables: StageComparableInsight[] = [],
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

  const stageMatchedComparables = stageComparables.filter((c) => c.observedStage === stage);
  const stageComparableSignal = stageMatchedComparables.length > 0
    ? stageMatchedComparables
        .map((c) => `${c.company} (${c.approxDate}, at "${c.observedStage}" stage): ${c.strategy}`)
        .join(" | ")
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
    stageComparableSignal,
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
  if (strategy.stageComparableSignal) {
    lines.push(`Stage-matched comparables: ${strategy.stageComparableSignal}`);
  }
  lines.push(`Derived at: ${strategy.derivedAt}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Closed loop M3 (docs/closed-loop-spec.md §9) — additive only.
// `deriveAppStage`/`deriveGrowthStrategy` above are untouched; everything
// below is new.
// ---------------------------------------------------------------------------

/**
 * Spec §9: "Extend growth-strategy.ts::deriveAppStage to read from the
 * metric layer." `deriveAppStage` itself stays a pure function of
 * `StageSignals` — this is a new, additive function computing those same
 * `StageSignals` from M2's real metric layer (`orchestrator/src/metrics/`)
 * instead of the old `/api/day2-stats` aggregate (W39). Callers swap the
 * *source* of the signals; `deriveAppStage`'s own tested logic is
 * unaffected either way.
 */
export function deriveStageSignalsFromMetrics(
  events: EventLike[],
  asOfIso: string,
  config: AppMetricConfig = DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG,
): StageSignals {
  const { mau } = computeDauWauMau(events, config, asOfIso, "app");
  const activeUsers = mau[0]?.value ?? 0;
  const retention = computeRetention(events, { ...config, retentionWindowsDays: [30] }, asOfIso, "app");
  const d30 = retention[30]?.[0];
  return { activeUsers, retentionSignal: d30?.value ?? null };
}

export type StageGoalConfig = { targetKpis: string[]; guardrailKpis: string[] };

/**
 * Spec §9's target-KPI/guardrail table. Disclosed gap: `scale`'s own
 * target KPIs per the spec's literal table are "Net revenue retention,
 * margin" — neither is defined anywhere in spec §4.3's KPI catalog (or
 * built in M2). Listed here as-is, verbatim from the spec, rather than
 * silently substituting a built metric that means something different —
 * a future session building these two KPIs for real should update M2's
 * `monetization-kpis.ts`, not redefine this table to route around the gap.
 */
export const STAGE_GOALS: Record<AppStage, StageGoalConfig> = {
  launch: { targetKpis: ["activation_rate", "d7_retention"], guardrailKpis: ["crash_free_sessions", "error_rate"] },
  traction: {
    targetKpis: ["d30_retention", "organic_share"],
    guardrailKpis: ["crash_free_sessions", "error_rate", "store_rating", "refund_rate"],
  },
  growth: {
    targetKpis: ["ltv_to_cac", "cac_payback_months"],
    guardrailKpis: ["d30_retention", "crash_free_sessions", "error_rate", "store_rating"],
  },
  scale: {
    targetKpis: ["net_revenue_retention", "margin"], // not yet built as real KPIs — see doc comment above
    guardrailKpis: ["d30_retention", "crash_free_sessions", "error_rate", "store_rating", "tickets_per_active_user"],
  },
};

/** `targetKpiDeltas`/`guardrailKpiDeltas` are always "positive = real
 * improvement, negative = real regression" for every metric — the caller
 * normalizes each metric's own polarity (e.g. negates a raw `error_rate`
 * delta, since a *rising* error rate is the regression) before calling
 * this. Matches this codebase's own "caller resolves, function stays a
 * pure/thin consumer" pattern (`deriveGrowthStrategy`'s own competitor/
 * stage-comparable wiring already does this). */
export type ProposalImpactEstimate = {
  stage: AppStage;
  targetKpiDeltas: Partial<Record<string, number>>;
  guardrailKpiDeltas: Partial<Record<string, number>>;
};

export type ProposalScoreResult = {
  accepted: boolean;
  reason: string;
  improvesTargetKpi: boolean;
  violatedGuardrails: string[];
};

/**
 * Spec §9: "Every proposal is scored as: expected change in the stage's
 * target KPI, rejected if any guardrail is predicted or measured to worsen
 * beyond tolerance (default 5% relative)." Pure. A guardrail with no
 * supplied delta is treated as unaffected, not as a violation — proposals
 * scoped narrowly enough to not touch most guardrails shouldn't be
 * penalized for the ones they never claimed to affect.
 */
export function scoreProposalAgainstStageGoals(
  estimate: ProposalImpactEstimate,
  toleranceFraction = 0.05,
): ProposalScoreResult {
  const goals = STAGE_GOALS[estimate.stage];
  const improvesTargetKpi = goals.targetKpis.some((kpi) => (estimate.targetKpiDeltas[kpi] ?? 0) > 0);
  const violatedGuardrails = goals.guardrailKpis.filter((kpi) => {
    const delta = estimate.guardrailKpiDeltas[kpi];
    return delta !== undefined && delta < -toleranceFraction;
  });

  if (violatedGuardrails.length > 0) {
    return {
      accepted: false,
      reason: `Rejected: would worsen ${violatedGuardrails.join(", ")} beyond the ${(toleranceFraction * 100).toFixed(0)}% tolerance.`,
      improvesTargetKpi,
      violatedGuardrails,
    };
  }
  if (!improvesTargetKpi) {
    return {
      accepted: false,
      reason: `Rejected: no predicted improvement to any of ${estimate.stage}'s target KPIs (${goals.targetKpis.join(", ")}).`,
      improvesTargetKpi,
      violatedGuardrails: [],
    };
  }
  return {
    accepted: true,
    reason: `Accepted: improves a ${estimate.stage}-stage target KPI with no guardrail regression beyond tolerance.`,
    improvesTargetKpi,
    violatedGuardrails: [],
  };
}

export type CohortSpendUnlockDecision = { unlocked: boolean; reason: string };

/**
 * Spec §9: "Per-cohort spend unlock in spend-governance.ts: paid spend on
 * an arm scales only when that arm's cohort meets the retention threshold
 * for the app's stage. One good cohort can scale while the rest of the app
 * is still in Traction." Deliberately NOT built inside `spend-governance.ts`
 * itself — this is a gate a caller checks *before* ever building a
 * `SpendRequest` for a given arm, not a change to `evaluateSpend`'s own
 * fuzz-tested math (COORDINATION.md W38's `sum(allowed) <= monthlyBudgetUsd`
 * property suite stays completely untouched). Lives here since it's a
 * stage/cohort decision, the same domain `deriveGrowthStrategy` already
 * owns, not a spend-ledger decision.
 *
 * Retention thresholds per stage extend `deriveGrowthStrategy`'s own
 * existing, real "0.2 retention threshold" precedent for traction's
 * `paid_ads` slice (COORDINATION.md W39) rather than inventing new,
 * ungrounded numbers — growth/scale use a modestly higher bar, disclosed
 * as a reasonable extension, not independently derived from real data
 * (none exists yet at growth/scale for this app).
 */
export function evaluateCohortSpendUnlock(stage: AppStage, cohortD7RetentionRate: number | null): CohortSpendUnlockDecision {
  const RETENTION_THRESHOLD_BY_STAGE: Record<AppStage, number | null> = {
    launch: null, // launch locks paid spend regardless of retention — safety rail 1, never overridden by this gate
    traction: 0.2,
    growth: 0.25,
    scale: 0.3,
  };
  const threshold = RETENTION_THRESHOLD_BY_STAGE[stage];
  if (threshold === null) {
    return { unlocked: false, reason: `Stage "${stage}" locks paid spend regardless of cohort retention (safety rail 1).` };
  }
  if (cohortD7RetentionRate === null) {
    return { unlocked: false, reason: "No real retention data for this cohort yet — fails closed until observable." };
  }
  if (cohortD7RetentionRate >= threshold) {
    return {
      unlocked: true,
      reason: `Cohort D7 retention ${(cohortD7RetentionRate * 100).toFixed(1)}% clears the ${stage} stage's ${(threshold * 100).toFixed(0)}% threshold.`,
    };
  }
  return {
    unlocked: false,
    reason: `Cohort D7 retention ${(cohortD7RetentionRate * 100).toFixed(1)}% is below the ${stage} stage's ${(threshold * 100).toFixed(0)}% threshold.`,
  };
}
