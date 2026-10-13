import type { AuditEntry } from "./owner-feed";
import type { AppCreditUsage } from "./credits";

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
  /** Credits this app used this calendar month (UTC). */
  creditsUsedThisMonth: number;
  /** The app's own monthly credit cap; null when it has none and can draw
   * on the whole account balance. */
  monthlyCreditCap: number | null;
  killSwitch: boolean;
};

export function summarizeApp(input: {
  id: string;
  hasGitRemote: boolean;
  pendingApprovals: number | null;
  audit: AuditEntry[];
  credits: AppCreditUsage;
  killSwitch: boolean;
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
    creditsUsedThisMonth: input.credits.usedThisMonth,
    monthlyCreditCap: input.credits.caps.monthlyCredits ?? null,
    killSwitch: input.killSwitch,
  };
}
