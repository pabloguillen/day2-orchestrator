import type { AuditEntry } from "./owner-feed";
import type { SpendBreakdown } from "./spend-governance";

/**
 * Per-app headline numbers for the console's "Your apps" grid. Pure — the
 * API layer loads each app's real files and pending-PR list and hands them
 * in; this only counts. A figure day2 couldn't actually determine (no git
 * remote, GitHub unreachable) is `null`, never a fabricated 0.
 */
export type AppOverview = {
  id: string;
  hasGitRemote: boolean;
  /** Open day2 pull requests waiting on the owner; null when unknown. */
  pendingApprovals: number | null;
  /** Changes the autonomy model auto-shipped since the first of `now`'s month (UTC). */
  autoShippedThisMonth: number;
  spentUsd: number;
  monthlyBudgetUsd: number;
  killSwitch: boolean;
};

export function summarizeApp(input: {
  id: string;
  hasGitRemote: boolean;
  pendingApprovals: number | null;
  audit: AuditEntry[];
  spend: SpendBreakdown;
  now?: Date;
}): AppOverview {
  const now = input.now ?? new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const autoShippedThisMonth = input.audit.filter(
    (e) => e.autoShip && new Date(e.timestamp).getTime() >= monthStart,
  ).length;
  return {
    id: input.id,
    hasGitRemote: input.hasGitRemote,
    pendingApprovals: input.hasGitRemote ? input.pendingApprovals : null,
    autoShippedThisMonth,
    spentUsd: input.spend.spentUsd,
    monthlyBudgetUsd: input.spend.monthlyBudgetUsd,
    killSwitch: input.spend.killSwitch,
  };
}
