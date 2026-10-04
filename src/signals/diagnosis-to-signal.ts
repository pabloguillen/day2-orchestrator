import type { Diagnosis } from "../diagnosis";
import type { Signal } from "./types";

/**
 * Bridges the growth diagnosis router's `Diagnosis` into this pipeline's
 * `Signal` shape — the same "every trigger source maps into one shape" sink
 * `report-to-bug-report.ts` uses for `Report` -> `BugReport`, just one layer
 * earlier. Before this file existed, `diagnosis/rules.ts` computed a `route`
 * on every `Diagnosis` but nothing in `src/` ever read it to dispatch
 * anywhere — both real consumers (`cohort-report-card.ts`,
 * `growth-arm-check.ts`) only use `Diagnosis` as a human-readable label.
 *
 * Narrow and deliberate: only a `route: "healing"` diagnosis (today, only
 * D6 — a real crash/error-rate spike concentrated in a cohort, per
 * `diagnosis/rules.ts`) is converted. Every other route (`allocator`,
 * `creative`, `config`, `composer`, `evolution`, `release`) is left exactly
 * as it was: a label those two files render, not a work item.
 *
 * This does NOT invoke the healing pipeline itself. It only makes a healing
 * diagnosis visible to `health-scout-cli.ts`'s existing signal-gathering, so
 * the same schedule/dedup/clustering machinery every other signal already
 * goes through decides what happens next — human-in-the-loop, not an
 * auto-triggered fix.
 */

function findingFor(diagnosis: Diagnosis): string {
  const metrics = diagnosis.evidence
    .map((e) => `${e.metric} ${e.value.toFixed(3)} vs. baseline ${e.baseline.toFixed(3)}`)
    .join(", ");
  return `Cohort "${diagnosis.cohortKey}" flagged for healing (${diagnosis.ruleId})${metrics ? `: ${metrics}` : ""}.`;
}

/** A cohort diagnosis doesn't carry a single raw "event count" the way a
 * Sentry issue does — the only honest stand-in for "how many real
 * occurrences" is the sample size (`n`) each triggered evidence metric
 * already had to clear (`DIAGNOSIS_MIN_N_SEVERITY_METRICS` for D6) before
 * the rule fired at all. The largest of the rule's evidence sample sizes is
 * used rather than fabricating a precise count this layer doesn't have. */
function occurrencesFor(diagnosis: Diagnosis): number {
  return diagnosis.evidence.reduce((max, e) => Math.max(max, e.n), 0);
}

function pathFor(diagnosis: Diagnosis): string {
  return diagnosis.segmentId ? `${diagnosis.cohortKey}/${diagnosis.segmentId}` : diagnosis.cohortKey;
}

/**
 * Converts one healing-routed `Diagnosis` into a `Signal`. Throws for any
 * other route — callers should filter with `diagnosesToSignals` (mirroring
 * `report-to-bug-report.ts`'s actionable-filter-then-map split) rather than
 * call this directly against an unfiltered list.
 */
export function diagnosisToSignal(diagnosis: Diagnosis): Signal {
  if (diagnosis.route !== "healing") {
    throw new Error(
      `diagnosisToSignal: expected a "healing"-routed diagnosis, got "${diagnosis.route}" (${diagnosis.id}). ` +
        `Non-healing routes stay human-readable labels only — use diagnosesToSignals to filter first.`,
    );
  }
  return {
    id: `diagnosis-${diagnosis.id}`,
    source: "growth-diagnosis",
    appId: diagnosis.appId,
    at: diagnosis.createdAt,
    finding: findingFor(diagnosis),
    evidence: {
      ruleId: diagnosis.ruleId,
      cohortKey: diagnosis.cohortKey,
      ...(diagnosis.segmentId ? { segmentId: diagnosis.segmentId } : {}),
      primary: diagnosis.primary,
      metrics: diagnosis.evidence,
      ...(diagnosis.proposalId ? { proposalId: diagnosis.proposalId } : {}),
    },
    occurrences: occurrencesFor(diagnosis),
    // A cohort-level diagnosis doesn't carry a per-user affected count the
    // way a Sentry issue's `userCount` does — disclosed as 0 (unknown)
    // rather than fabricated from the sample size, which measures "how much
    // evidence backs this" not "how many distinct users are affected."
    affectedUsers: 0,
    path: pathFor(diagnosis),
    suggestedAction: `Investigate and fix the quality regression behind ${diagnosis.ruleId} for cohort "${diagnosis.cohortKey}".`,
  };
}

/** Filters to healing-routed diagnoses, then converts — the one entry point
 * callers (e.g. `health-scout-cli.ts`) should use against a mixed list of
 * diagnoses that weren't pre-filtered by route. */
export function diagnosesToSignals(diagnoses: Diagnosis[]): Signal[] {
  return diagnoses.filter((d) => d.route === "healing").map(diagnosisToSignal);
}
