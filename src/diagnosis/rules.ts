/**
 * D1-D10 (docs/closed-loop-spec.md §8.2). Each rule is a pure predicate
 * over `CohortDiagnosisInputs`; `diagnoseFunnel` (below) runs them in the
 * spec's own table order — "funnel order" — and marks the first true one
 * primary, the rest secondary (spec §8.2: "This prevents fixing retention
 * for users who were never activated" — achieved because only the primary
 * diagnosis's route actually receives a proposal downstream; secondary
 * diagnoses are recorded as evidence, not separately acted on here).
 *
 * Where the spec's own wording is ambiguous, the interpretation taken is
 * disclosed inline rather than silently guessed at (same discipline this
 * whole project applies everywhere): D6's "crash-free or error rate > 1.3x
 * baseline" and D8's "store rating drop after a release" both need a real,
 * stated design decision the spec's prose doesn't fully pin down.
 */

import {
  CohortDiagnosisInputs,
  Diagnosis,
  DiagnosisRoute,
  DiagnosisRuleId,
  DIAGNOSIS_MIN_N_RATE_METRICS,
  DIAGNOSIS_MIN_N_SEVERITY_METRICS,
  EvidenceEntry,
} from "./types";

type RuleResult = { ruleId: DiagnosisRuleId; triggered: boolean; route: DiagnosisRoute; evidence: EvidenceEntry[] };

function metricValue(inputs: CohortDiagnosisInputs, metric: string): { value: number; n: number; ci: [number, number] | null } | null {
  const m = inputs.metrics[metric];
  if (!m || m.value === null) return null;
  return { value: m.value, n: m.n, ci: m.ci };
}

function evidenceFor(inputs: CohortDiagnosisInputs, metric: string): EvidenceEntry | null {
  const mv = metricValue(inputs, metric);
  const baseline = inputs.baseline[metric];
  if (!mv || baseline === undefined) return null;
  return { metric, value: mv.value, baseline, n: mv.n, ci: mv.ci };
}

/** Spec §8.3: n >= 100 for rate metrics (30 for D6/D8, severity-driven). A
 * rule that can't clear this for its own evidence metric never triggers —
 * "insufficient data" is not treated as a silent pass, but it's also never
 * escalated as a diagnosis nobody asked for. */
function hasEnoughData(n: number, ruleId: DiagnosisRuleId): boolean {
  const min = ruleId === "D6" || ruleId === "D8" ? DIAGNOSIS_MIN_N_SEVERITY_METRICS : DIAGNOSIS_MIN_N_RATE_METRICS;
  return n >= min;
}

function belowRelativeThreshold(value: number, baseline: number, fraction: number): boolean {
  return baseline > 0 && value < baseline * fraction;
}

function aboveRelativeThreshold(value: number, baseline: number, fraction: number): boolean {
  return baseline > 0 && value > baseline * fraction;
}

function d1(inputs: CohortDiagnosisInputs): RuleResult {
  const ev = evidenceFor(inputs, "ctr");
  const triggered = !!ev && hasEnoughData(ev.n, "D1") && belowRelativeThreshold(ev.value, ev.baseline, 0.7);
  return { ruleId: "D1", triggered, route: "creative", evidence: ev ? [ev] : [] };
}

function d2(inputs: CohortDiagnosisInputs): RuleResult {
  const ev = evidenceFor(inputs, "landing_to_signup");
  const triggered = !!ev && hasEnoughData(ev.n, "D2") && belowRelativeThreshold(ev.value, ev.baseline, 0.7);
  return { ruleId: "D2", triggered, route: "config", evidence: ev ? [ev] : [] };
}

function d3(inputs: CohortDiagnosisInputs): RuleResult {
  const ev = evidenceFor(inputs, "activation_rate");
  const triggered = !!ev && hasEnoughData(ev.n, "D3") && belowRelativeThreshold(ev.value, ev.baseline, 0.8);
  return { ruleId: "D3", triggered, route: "composer", evidence: ev ? [ev] : [] };
}

function d4(inputs: CohortDiagnosisInputs): RuleResult {
  const activationEv = evidenceFor(inputs, "activation_rate");
  const retentionEv = evidenceFor(inputs, "d7_retention");
  // "Activated, but D7 < 0.8x" — literally conjunctive: the cohort must
  // have cleared activation (not already D3's problem) AND still show weak
  // D7 retention, or this isn't really a "product doesn't hold them"
  // finding, it's D3's finding wearing a different metric.
  const activated = !!activationEv && !belowRelativeThreshold(activationEv.value, activationEv.baseline, 0.8);
  const triggered =
    activated && !!retentionEv && hasEnoughData(retentionEv.n, "D4") && belowRelativeThreshold(retentionEv.value, retentionEv.baseline, 0.8);
  const evidence = [activationEv, retentionEv].filter((e): e is EvidenceEntry => e !== null);
  return { ruleId: "D4", triggered, route: "evolution", evidence };
}

function d5(inputs: CohortDiagnosisInputs): RuleResult {
  const retentionEv = evidenceFor(inputs, "d7_retention");
  const paybackEv = evidenceFor(inputs, "cac_payback_months");
  const retained = !!retentionEv && !belowRelativeThreshold(retentionEv.value, retentionEv.baseline, 0.8);
  const triggered =
    retained &&
    !!paybackEv &&
    hasEnoughData(paybackEv.n, "D5") &&
    paybackEv.value > inputs.targets.cacPaybackTargetMonths;
  const evidence = [retentionEv, paybackEv].filter((e): e is EvidenceEntry => e !== null);
  return { ruleId: "D5", triggered, route: "allocator", evidence };
}

/**
 * Disclosed interpretation: the spec's "Crash-free or error rate > 1.3x
 * baseline" is read as two independent severity checks, either of which
 * can trigger D6 on its own — a cohort with a real crash-rate spike but a
 * normal error rate (or vice versa) is still a real quality problem, not
 * something that needs both to fire together.
 */
function d6(inputs: CohortDiagnosisInputs): RuleResult {
  const crashFreeEv = evidenceFor(inputs, "crash_free_sessions");
  const errorRateEv = evidenceFor(inputs, "error_rate");
  const crashRateSpiked =
    !!crashFreeEv && hasEnoughData(crashFreeEv.n, "D6") && aboveRelativeThreshold(1 - crashFreeEv.value, 1 - crashFreeEv.baseline, 1.3);
  const errorRateSpiked = !!errorRateEv && hasEnoughData(errorRateEv.n, "D6") && aboveRelativeThreshold(errorRateEv.value, errorRateEv.baseline, 1.3);
  const evidence = [crashFreeEv, errorRateEv].filter((e): e is EvidenceEntry => e !== null);
  return { ruleId: "D6", triggered: crashRateSpiked || errorRateSpiked, route: "healing", evidence };
}

function d7(inputs: CohortDiagnosisInputs): RuleResult {
  const ev = evidenceFor(inputs, "refund_rate");
  const triggered = !!ev && hasEnoughData(ev.n, "D7") && aboveRelativeThreshold(ev.value, ev.baseline, 1.5);
  return { ruleId: "D7", triggered, route: "creative", evidence: ev ? [ev] : [] };
}

/**
 * Disclosed interpretation: "store rating drop after a release" needs a
 * before/after-a-specific-release comparison, a different shape from every
 * other rule's "cohort vs. 4-week app median" check. This rule treats
 * `inputs.baseline.store_rating` as the pre-release baseline the caller is
 * responsible for supplying for this specific comparison (not the generic
 * 4-week median another caller might pass for a different rule) — real,
 * computable from `quality-satisfaction-kpis.ts::computeStoreRating` run
 * on a pre-release vs. post-release window, but that windowing choice is
 * the caller's job, not re-derived here. A 10% relative drop is the
 * disclosed severity bar, matching this file's own consistent style of
 * naming its thresholds rather than leaving them implicit.
 */
function d8(inputs: CohortDiagnosisInputs): RuleResult {
  const ev = evidenceFor(inputs, "store_rating");
  const triggered = !!ev && hasEnoughData(ev.n, "D8") && belowRelativeThreshold(ev.value, ev.baseline, 0.9);
  return { ruleId: "D8", triggered, route: "release", evidence: ev ? [ev] : [] };
}

function d9(inputs: CohortDiagnosisInputs): RuleResult {
  const ev = evidenceFor(inputs, "trial_to_paid");
  const triggered = !!ev && hasEnoughData(ev.n, "D9") && belowRelativeThreshold(ev.value, ev.baseline, 0.7);
  return { ruleId: "D9", triggered, route: "config", evidence: ev ? [ev] : [] };
}

function d10(inputs: CohortDiagnosisInputs): RuleResult {
  // "All steps >= baseline" — only the steps this cohort actually has
  // sufficient-data evidence for are checked; a metric with no evidence at
  // all doesn't block D10 from firing (e.g. expense-buddy has no real
  // trial/paid funnel yet — absence of that data shouldn't prevent
  // recognizing a cohort that's otherwise working on everything it CAN be
  // measured on).
  const fundamentalMetrics = ["ctr", "landing_to_signup", "activation_rate", "d7_retention"];
  const allAboveBaseline = fundamentalMetrics.every((metric) => {
    const ev = evidenceFor(inputs, metric);
    if (!ev) return true; // no evidence — doesn't block D10
    return !belowRelativeThreshold(ev.value, ev.baseline, 1.0);
  });
  const ltvToCacEv = evidenceFor(inputs, "ltv_to_cac");
  const triggered =
    allAboveBaseline && !!ltvToCacEv && hasEnoughData(ltvToCacEv.n, "D10") && ltvToCacEv.value > inputs.targets.ltvToCacTarget;
  const evidence = ltvToCacEv ? [ltvToCacEv] : [];
  return { ruleId: "D10", triggered, route: "allocator", evidence };
}

const RULES_IN_FUNNEL_ORDER: ((inputs: CohortDiagnosisInputs) => RuleResult)[] = [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10];

/**
 * Runs every rule in funnel order against one cohort's real inputs. The
 * first triggered rule is `primary: true`; every other triggered rule is
 * recorded as `primary: false` (visible evidence, not separately routed).
 * Returns `[]` when nothing triggers — a cohort with no real problem
 * produces no diagnoses, not a fabricated one.
 */
export function diagnoseFunnel(inputs: CohortDiagnosisInputs, appId: string, createdAt: string): Diagnosis[] {
  const diagnoses: Diagnosis[] = [];
  let primaryAssigned = false;
  for (const rule of RULES_IN_FUNNEL_ORDER) {
    const result = rule(inputs);
    if (!result.triggered) continue;
    const primary = !primaryAssigned;
    if (primary) primaryAssigned = true;
    diagnoses.push({
      id: `${appId}:${inputs.cohortKey}:${result.ruleId}:${createdAt}`,
      appId,
      cohortKey: inputs.cohortKey,
      ...(inputs.segmentId ? { segmentId: inputs.segmentId } : {}),
      ruleId: result.ruleId,
      primary,
      evidence: result.evidence,
      route: result.route,
      createdAt,
    });
  }
  return diagnoses;
}
