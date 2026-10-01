import type { Report, Signal } from "./types";

/**
 * Closes the loop PostHog's own "validation scout" closes (COORDINATION.md
 * research into their self-driving product): day2's existing canary
 * guardrail (`release.ts`'s `fetchCanaryErrorCount`) only checks for *new*
 * errors during a canary window — it never re-checks whether the *specific
 * thing a fix targeted* actually recovered. This does: given the report
 * that produced a now-merged fix, and a fresh signal sweep taken after a
 * soak window, decides whether the original finding actually cleared.
 *
 * Pure comparison only — the caller is responsible for re-running the same
 * sources (`fetchUnresolvedIssuesAsSignals`/`fetchFrictionSignals`) after
 * waiting, the same separation of "fetch" vs. "decide" every other module
 * here already uses.
 */

export type ImpactResult = {
  reportId: string;
  /** Whether every signal that made up the original report is now absent
   * (or has stopped growing — see `MIN_GROWTH_TO_COUNT_AS_RECURRING`) from
   * the fresh sweep. */
  cleared: boolean;
  /** Per-original-signal detail, so a human (or the owner feed) can see
   * exactly what did or didn't recover, not just a single boolean. */
  signalOutcomes: Array<{ signalId: string; path?: string; source: string; stillPresent: boolean; freshOccurrences: number }>;
  measuredAt: string;
};

// A handful of stray occurrences after a fix merges is expected noise
// (in-flight requests from before the deploy, a slow client retrying) —
// only a real, continuing rate counts as "still broken," matching the
// canary guardrail's own "don't fail on noise" posture.
const MIN_GROWTH_TO_COUNT_AS_RECURRING = 3;

function matchesOriginal(original: Signal, fresh: Signal): boolean {
  if (original.source !== fresh.source || original.appId !== fresh.appId) return false;
  if (original.source === "sentry") {
    // Sentry issue identity, not just path — a path can host more than one
    // issue, and a *different* new issue at the same path isn't recurrence
    // of the one this fix targeted.
    return original.evidence.permalink === fresh.evidence.permalink;
  }
  return original.path === fresh.path && original.evidence.target === fresh.evidence.target;
}

export function measureImpact(report: Report, freshSignals: Signal[]): ImpactResult {
  const signalOutcomes = report.signals.map((original) => {
    const fresh = freshSignals.find((f) => matchesOriginal(original, f));
    const freshOccurrences = fresh?.occurrences ?? 0;
    return {
      signalId: original.id,
      path: original.path,
      source: original.source,
      stillPresent: freshOccurrences >= MIN_GROWTH_TO_COUNT_AS_RECURRING,
      freshOccurrences,
    };
  });

  return {
    reportId: report.id,
    cleared: signalOutcomes.every((o) => !o.stillPresent),
    signalOutcomes,
    measuredAt: new Date().toISOString(),
  };
}
