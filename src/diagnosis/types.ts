/**
 * Diagnosis router types (docs/closed-loop-spec.md §8.4). "The core of the
 * closed loop": which funnel step is weakest for a cohort, and which
 * existing loop should act on it.
 */

import type { MetricValue } from "../metrics";

export type DiagnosisRuleId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8" | "D9" | "D10";

export type DiagnosisRoute = "allocator" | "creative" | "config" | "composer" | "evolution" | "healing" | "release";

export type EvidenceEntry = { metric: string; value: number; baseline: number; n: number; ci: [number, number] | null };

export type Diagnosis = {
  id: string;
  appId: string;
  cohortKey: string;
  segmentId?: string;
  ruleId: DiagnosisRuleId;
  primary: boolean;
  evidence: EvidenceEntry[];
  route: DiagnosisRoute;
  proposalId?: string;
  createdAt: string;
};

/** Per cohort (spec §8.1): the real computed metric set, the app-wide
 * baseline (median over the last 4 weeks) for each of those same metrics,
 * and the stage-derived targets D5/D9/D10 check against. Keyed by the
 * metric names M2's `*-kpis.ts` functions already use (e.g. "ctr",
 * "activation_rate", "d7_retention") — this file doesn't recompute
 * anything, it only reads what M2 already produced. */
export type CohortDiagnosisInputs = {
  cohortKey: string;
  segmentId?: string;
  metrics: Partial<Record<string, MetricValue>>;
  /** App-wide median per metric over the last 4 weeks — the comparison
   * baseline every rule's threshold is relative to (spec §8.2's own
   * wording: "Rules compare a cohort to the app baseline"). */
  baseline: Partial<Record<string, number>>;
  targets: {
    /** Spec §9's stage-derived target (e.g. `growth-strategy.ts`'s own
     * stage/KPI table) — D5/D9's "CAC payback > target" /
     * "LTV:CAC > target" checks read this, not a fixed constant. */
    cacPaybackTargetMonths: number;
    ltvToCacTarget: number;
  };
};

/** Spec §8.3's own thresholds, defaults — overridable per app. */
export const DIAGNOSIS_MIN_N_RATE_METRICS = 100;
export const DIAGNOSIS_MIN_N_SEVERITY_METRICS = 30; // D6/D8
