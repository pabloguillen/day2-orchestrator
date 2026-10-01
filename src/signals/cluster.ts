import type { Report, ReportPriority, Signal } from "./types";

/**
 * Clusters raw signals into reports — the step PostHog's own docs describe
 * as turning "a noisy stream of findings" into "one item of work." Honest
 * v1: groups by `appId` + `path` (same screen/flow), not semantic
 * similarity of the finding text — matches this project's standing
 * "simple, disclosed v1" discipline (`handleStats`'s own "capped at 1000
 * keys... honest v1 simplification" precedent) rather than claiming NLP
 * clustering this doesn't do. Signals with no `path` each become their own
 * single-signal cluster, since there's no shared dimension to group them on.
 */

const P1_AFFECTED_USERS_THRESHOLD = 5;
const P1_OCCURRENCES_THRESHOLD = 10;

function clusterKey(signal: Signal): string {
  return signal.path ? `${signal.appId}::${signal.path}` : `${signal.appId}::${signal.id}`;
}

function computePriority(signals: Signal[]): ReportPriority {
  const totalAffectedUsers = signals.reduce((s, sig) => s + sig.affectedUsers, 0);
  const totalOccurrences = signals.reduce((s, sig) => s + sig.occurrences, 0);
  const sourceCount = new Set(signals.map((s) => s.source)).size;

  // Corroboration across independent sources is itself evidence of real
  // impact — PostHog's own worked example (error tracking + replay +
  // support tickets, all for the same bug) is explicitly P1 partly *because*
  // three independent signals agree, not just because of raw counts.
  if (sourceCount >= 2) return "P1";
  if (totalAffectedUsers >= P1_AFFECTED_USERS_THRESHOLD || totalOccurrences >= P1_OCCURRENCES_THRESHOLD) {
    return "P1";
  }
  if (totalAffectedUsers > 0 || totalOccurrences > 1) return "P2";
  return "P3";
}

/** A cluster is actionable unless every signal in it is explicitly
 * low-confidence (e.g. a swarm persona that errored before reaching a real
 * verdict) — same fail-closed-toward-caution posture `sources/swarm.ts`
 * already uses for that exact case, just expressed at the cluster level. */
function computeActionability(signals: Signal[]): { actionable: boolean; reason: string } {
  const allLowConfidence = signals.every((s) => s.evidence.lowConfidence === true);
  if (allLowConfidence) {
    return {
      actionable: false,
      reason: "every signal in this cluster is low-confidence (no clean verdict reached) — needs a human look, not an automatic fix attempt",
    };
  }
  return {
    actionable: true,
    reason:
      signals.length > 1
        ? `corroborated by ${signals.length} signals across ${new Set(signals.map((s) => s.source)).size} source(s)`
        : "single concrete, reproducible signal",
  };
}

function titleFor(signals: Signal[]): string {
  const primary = [...signals].sort((a, b) => b.occurrences - a.occurrences)[0]!;
  return signals.length === 1
    ? primary.finding.slice(0, 120)
    : `${primary.finding.slice(0, 100)} (+${signals.length - 1} corroborating signal(s))`;
}

export function clusterSignals(signals: Signal[]): Report[] {
  const groups = new Map<string, Signal[]>();
  for (const signal of signals) {
    const key = clusterKey(signal);
    groups.set(key, [...(groups.get(key) ?? []), signal]);
  }

  return [...groups.entries()].map(([key, groupSignals]) => {
    const { actionable, reason } = computeActionability(groupSignals);
    return {
      id: `report-${key.replace(/[^a-zA-Z0-9]/g, "-")}`,
      appId: groupSignals[0]!.appId,
      title: titleFor(groupSignals),
      signals: groupSignals,
      priority: computePriority(groupSignals),
      actionable,
      reason,
      createdAt: new Date().toISOString(),
    };
  });
}
