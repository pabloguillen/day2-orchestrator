/**
 * Owner feed: cohort report card (docs/closed-loop-spec.md §11). "One card
 * per cohort that changed materially this week" — the closed loop made
 * visible. Links to `owner-feed.ts`/`proposals.ts`/`growth-feed.ts`'s own
 * items rather than replacing them (spec §11: "Existing feeds keep
 * working; the report card links to their items").
 */

import type { Diagnosis } from "./diagnosis";
import type { MetricValue } from "./metrics";

const FUNNEL_METRICS_IN_ORDER = [
  "ctr",
  "landing_to_signup",
  "activation_rate",
  "d7_retention",
  "trial_to_paid",
  "cac_payback_months",
] as const;

export type FunnelStep = {
  metric: string;
  value: number | null;
  baseline: number | null;
  isWeakest: boolean;
};

export type CohortReportCard = {
  cohortKey: string;
  channel: string;
  arm: string;
  creativeThumbnailRef?: string;
  funnel: FunnelStep[];
  diagnosisSummary: string;
  proposedAction: string;
  expectedEffect: string;
  primaryDiagnosis?: Diagnosis;
  linkedItems: { feed: "owner-feed" | "proposals" | "growth-feed"; id: string }[];
};

const RULE_SUMMARIES: Record<Diagnosis["ruleId"], string> = {
  D1: "The ad itself isn't attracting clicks.",
  D2: "People land but don't sign up.",
  D3: "The entry path doesn't fit this cohort.",
  D4: "They activate, but the product doesn't hold them.",
  D5: "The right users, but an expensive channel.",
  D6: "A real quality problem is concentrated in this cohort.",
  D7: "The ad sets expectations the product doesn't meet.",
  D8: "A release hurt satisfaction for this cohort.",
  D9: "The paywall doesn't fit this cohort.",
  D10: "This cohort is working — a real scale-up candidate.",
};

const RULE_ACTIONS: Record<Diagnosis["ruleId"], string> = {
  D1: "Generate a new creative angle for this arm.",
  D2: "Test a different landing variant.",
  D3: "Learn or test a new entry path for this cohort.",
  D4: "Draft a feature proposal for this cohort and segment.",
  D5: "Shift budget toward cheaper channels or organic.",
  D6: "Raise heal priority for issues affecting this cohort.",
  D7: "Review this arm's creative claims against the real app profile.",
  D8: "Check the most recent release for a rollback.",
  D9: "Test paywall timing or offer for this cohort.",
  D10: "Scale this arm's budget within its existing caps.",
};

/**
 * Pure. Spec §8.2's own primary/secondary diagnoses already identify the
 * weakest funnel step; this just marks it on the rendered funnel list.
 * Metrics with no evidence at all are still listed (honestly, as "no
 * data"), not silently dropped — a report card should show the whole
 * funnel, not just the parts with numbers.
 */
export function buildFunnelSteps(metrics: Partial<Record<string, MetricValue>>, baseline: Partial<Record<string, number>>, primaryMetric: string | undefined): FunnelStep[] {
  return FUNNEL_METRICS_IN_ORDER.map((metric) => {
    const mv = metrics[metric];
    return {
      metric,
      value: mv?.value ?? null,
      baseline: baseline[metric] ?? null,
      isWeakest: metric === primaryMetric,
    };
  });
}

/**
 * Spec §11: "changed materially this week." Two real, disclosed triggers —
 * either is sufficient: (1) any funnel metric moved by more than
 * `metricChangeThreshold` (default 10% relative) week over week, or (2) the
 * cohort's primary diagnosis changed (a new problem appeared, an old one
 * resolved, or the route changed) — a diagnosis appearing or disappearing
 * is inherently material even if no single metric crossed the numeric bar
 * on its own.
 */
export function hasChangedMaterially(
  thisWeekMetrics: Partial<Record<string, MetricValue>>,
  lastWeekMetrics: Partial<Record<string, MetricValue>>,
  thisWeekPrimaryRuleId: Diagnosis["ruleId"] | undefined,
  lastWeekPrimaryRuleId: Diagnosis["ruleId"] | undefined,
  metricChangeThreshold = 0.1,
): boolean {
  if (thisWeekPrimaryRuleId !== lastWeekPrimaryRuleId) return true;
  for (const metric of FUNNEL_METRICS_IN_ORDER) {
    const thisWeek = thisWeekMetrics[metric]?.value;
    const lastWeek = lastWeekMetrics[metric]?.value;
    if (thisWeek === undefined || thisWeek === null || lastWeek === undefined || lastWeek === null) continue;
    if (lastWeek === 0) continue; // no real baseline to compute a relative change against
    const relativeChange = Math.abs(thisWeek - lastWeek) / Math.abs(lastWeek);
    if (relativeChange > metricChangeThreshold) return true;
  }
  return false;
}

/**
 * Assembles one real report card for a cohort — the primary diagnosis (if
 * any) drives the summary/action/weakest-step highlight; a cohort with no
 * diagnosis but real material metric movement still gets a card (an
 * honest "this cohort moved, no specific diagnosis crossed its threshold
 * yet" case, not silently dropped).
 */
export function buildCohortReportCard(
  cohortKey: string,
  channel: string,
  arm: string,
  diagnoses: Diagnosis[],
  metrics: Partial<Record<string, MetricValue>>,
  baseline: Partial<Record<string, number>>,
  expectedEffectDescription: string,
  creativeThumbnailRef?: string,
): CohortReportCard {
  const primary = diagnoses.find((d) => d.primary);
  // Highlighting naturally no-ops for a primary diagnosis whose evidence
  // metric isn't one of the listed funnel steps (e.g. D6's crash_free_sessions,
  // D7's refund_rate) — nothing in FUNNEL_METRICS_IN_ORDER matches, so no
  // step gets marked weakest, which is correct: those problems aren't a
  // funnel-conversion-step problem.
  const funnel = buildFunnelSteps(metrics, baseline, primary ? primaryFunnelMetricFor(primary) : undefined);

  return {
    cohortKey,
    channel,
    arm,
    ...(creativeThumbnailRef ? { creativeThumbnailRef } : {}),
    funnel,
    diagnosisSummary: primary ? RULE_SUMMARIES[primary.ruleId] : "This cohort changed this week, but no specific problem crossed a diagnosis threshold.",
    proposedAction: primary ? RULE_ACTIONS[primary.ruleId] : "No action proposed yet — keep watching.",
    expectedEffect: expectedEffectDescription,
    ...(primary ? { primaryDiagnosis: primary } : {}),
    linkedItems: [],
  };
}

function primaryFunnelMetricFor(diagnosis: Diagnosis): string | undefined {
  return diagnosis.evidence[0]?.metric;
}

/** Plain-language render, same idiom as `owner-feed.ts`/`approvals.ts` —
 * literal `[ Apply ]   [ Undo ]   [ Ask a question ]` affordances, matching
 * `approvals.ts`'s own established rendering exactly (spec §11: "Buttons:
 * Apply, Undo, Ask"). */
export function renderCohortReportCard(card: CohortReportCard): string {
  const lines: string[] = [];
  lines.push(`Cohort: ${card.cohortKey} (via ${card.channel} / ${card.arm})`);
  if (card.creativeThumbnailRef) lines.push(`Creative: ${card.creativeThumbnailRef}`);
  lines.push("Funnel:");
  for (const step of card.funnel) {
    const valueStr = step.value === null ? "no data" : step.value.toFixed(3);
    const baselineStr = step.baseline === null ? "no baseline" : step.baseline.toFixed(3);
    const marker = step.isWeakest ? " <- weakest step" : "";
    lines.push(`  - ${step.metric}: ${valueStr} (baseline ${baselineStr})${marker}`);
  }
  lines.push(`Diagnosis: ${card.diagnosisSummary}`);
  lines.push(`Proposed: ${card.proposedAction}`);
  lines.push(`Expected effect: ${card.expectedEffect}`);
  if (card.linkedItems.length > 0) {
    lines.push(`Linked: ${card.linkedItems.map((l) => `${l.feed}#${l.id}`).join(", ")}`);
  }
  lines.push(`[ Apply ]   [ Undo ]   [ Ask a question ]`);
  return lines.join("\n");
}

export function renderCohortReportCards(cards: CohortReportCard[]): string {
  if (cards.length === 0) return "No cohorts changed materially this week.";
  return cards.map(renderCohortReportCard).join("\n\n---\n\n");
}
