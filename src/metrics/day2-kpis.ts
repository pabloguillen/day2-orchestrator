/**
 * "Day2 itself" domain (docs/closed-loop-spec.md §4.3) — metrics about the
 * system's own behavior, not the app's users. Structural input types over
 * real audit-trail shapes already written by other components
 * (`autonomy.ts::recordAutonomyAudit`, `release.ts`'s canary results,
 * `proposals.ts`, `approvals.ts`) — not imported directly, same cross-
 * component decoupling `growth-execution.ts::StoredEventLike` established
 * in M1: this file's job is the metric math, not coupling to five other
 * files' exact JSONL shapes. A thin loader mapping a real audit file into
 * these shapes is a fast-follow, not built in this pass.
 */

import { hasSufficientData, wilsonScoreInterval } from "./confidence";
import { MetricValue } from "./types";

export type ReleaseRecord = { shippedAt: string; rolledBack: boolean };
export type ProposalRecord = { proposedAt: string; approved: boolean | null }; // null = still pending
export type AutoAppliedChangeRecord = { appliedAt: string; undone: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;

/** shipped changes still live after 30 days / shipped changes old enough to
 * judge. A release shipped 3 days ago is excluded from both numerator and
 * denominator — not yet old enough to say whether it "held up", same
 * eligibility discipline `retention-kpis.ts::computeRetention` uses for
 * devices too young for a given window. */
export function computeChangeSuccessRate(releases: ReleaseRecord[], asOfIso: string): MetricValue {
  const asOfMs = new Date(asOfIso).getTime();
  const eligible = releases.filter((r) => asOfMs - new Date(r.shippedAt).getTime() >= 30 * DAY_MS);
  const n = eligible.length;
  if (n === 0) return { metric: "change_success_rate", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const stillLive = eligible.filter((r) => !r.rolledBack).length;
  return {
    metric: "change_success_rate",
    breakdown: {},
    value: stillLive / n,
    n,
    ci: wilsonScoreInterval(stillLive, n),
    sufficientData: hasSufficientData(n),
  };
}

/** rollbacks / releases — every release, regardless of age (unlike change
 * success rate, a rollback is known immediately, not just after 30 days). */
export function computeRollbackRate(releases: ReleaseRecord[]): MetricValue {
  const n = releases.length;
  if (n === 0) return { metric: "rollback_rate", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const rollbacks = releases.filter((r) => r.rolledBack).length;
  return {
    metric: "rollback_rate",
    breakdown: {},
    value: rollbacks / n,
    n,
    ci: wilsonScoreInterval(rollbacks, n),
    sufficientData: hasSufficientData(n),
  };
}

/** approved / (approved + rejected) — still-pending proposals
 * (`approved: null`) are excluded from the denominator, not counted as
 * rejected; a real, undecided proposal isn't evidence either way. */
export function computeProposalApprovalRate(proposals: ProposalRecord[]): MetricValue {
  const decided = proposals.filter((p) => p.approved !== null);
  const n = decided.length;
  if (n === 0) return { metric: "proposal_approval_rate", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const approved = decided.filter((p) => p.approved === true).length;
  return {
    metric: "proposal_approval_rate",
    breakdown: {},
    value: approved / n,
    n,
    ci: wilsonScoreInterval(approved, n),
    sufficientData: hasSufficientData(n),
  };
}

/** undos / auto-applied changes. */
export function computeOwnerUndoRate(changes: AutoAppliedChangeRecord[]): MetricValue {
  const n = changes.length;
  if (n === 0) return { metric: "owner_undo_rate", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const undone = changes.filter((c) => c.undone).length;
  return {
    metric: "owner_undo_rate",
    breakdown: {},
    value: undone / n,
    n,
    ci: wilsonScoreInterval(undone, n),
    sufficientData: hasSufficientData(n),
  };
}

/** day2 compute cost / MAU — `totalComputeCostUsd` is the caller's own sum
 * over whatever cost-tracking fields already exist in this codebase
 * (`CalibrationVerdict.costUsd`, `Creative.costUsd`, etc.) for the period;
 * not re-derived here to avoid coupling this file to every agent-invoking
 * component's own cost-reporting shape. */
export function computeComputeCostPerActiveUser(totalComputeCostUsd: number, activeUserCount: number): MetricValue {
  return {
    metric: "compute_cost_per_active_user",
    breakdown: {},
    value: activeUserCount > 0 ? totalComputeCostUsd / activeUserCount : null,
    n: activeUserCount,
    ci: null,
    sufficientData: hasSufficientData(activeUserCount),
  };
}
