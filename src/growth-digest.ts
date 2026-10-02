import type { AuditEntry } from "./owner-feed";
import type { GrowthActionRecord } from "./growth-feed";
import type { RecordedProposal } from "./proposals";
import type { ChangeCard } from "./approvals";

/**
 * Push-based daily/weekly digest (user-directed: "What we can learn from
 * Revnu... push-based daily digest, not just a pull console" — already
 * self-flagged as a real, unbuilt gap in the original Step 4 plan: "no
 * scheduler exists anywhere in this codebase").
 *
 * Deliberately pure composition over data every other component already
 * computes — `loadAuditEntries` (autonomy), `loadGrowthActions` (growth
 * feed), `listProposals` (evolution), `fetchPendingChangeCards`
 * (approvals). No new data model, no new judgment logic; this file's only
 * real job is turning four already-real feeds into one plain-language
 * message and sending it.
 *
 * Deliberately NOT a scheduler. "When does this run" is the same kind of
 * trigger/hosting decision `maybeAutoRelease`'s own header comment already
 * draws a line around ("nothing currently calls this automatically... that
 * needs a merge-detection mechanism... which doesn't exist yet") —
 * `growth-digest-cli.ts` is built to be invoked by an operator's own cron
 * job or GitHub Actions schedule, the same way `auto-release-cli.ts` is
 * invoked by `auto-release.yml`, not by a scheduler living in this repo.
 */

export type DigestPeriod = "daily" | "weekly";

export type DigestData = {
  auditEntries: AuditEntry[];
  growthActions: GrowthActionRecord[];
  proposals: RecordedProposal[];
  pendingApprovals: ChangeCard[];
};

/** Pure, unit-tested — the entire real logic of this file. Plain-language,
 * no jargon, matching every other render function's style in this
 * codebase. Every number here is counted live from the real data passed
 * in, never a cached/estimated figure. */
export function renderDigest(appName: string, period: DigestPeriod, data: DigestData): string {
  const periodLabel = period === "daily" ? "today" : "this week";
  const lines: string[] = [`*${appName} — ${period} digest*`];

  const autoShipped = data.auditEntries.filter((e) => e.autoShip).length;
  const needsReview = data.auditEntries.length - autoShipped;
  if (data.auditEntries.length === 0) {
    lines.push(`No code changes ${periodLabel}.`);
  } else {
    lines.push(
      `${data.auditEntries.length} change${data.auditEntries.length === 1 ? "" : "s"} ${periodLabel}: ${autoShipped} shipped automatically, ${needsReview} waiting on your review.`,
    );
  }

  const executed = data.growthActions.filter((a) => a.executionResult === "executed").length;
  const simulated = data.growthActions.filter((a) => a.executionResult.startsWith("simulated")).length;
  const blocked = data.growthActions.filter((a) => a.executionResult.startsWith("blocked")).length;
  if (data.growthActions.length === 0) {
    lines.push(`No growth actions ${periodLabel}.`);
  } else {
    const spend = data.growthActions.reduce((sum, a) => sum + (a.spend.allowed ? a.spend.requested : 0), 0);
    lines.push(
      `${data.growthActions.length} growth action${data.growthActions.length === 1 ? "" : "s"} ${periodLabel} ($${spend.toFixed(2)} spent): ` +
        `${executed} real, ${simulated} simulated, ${blocked} blocked.`,
    );
  }

  if (data.pendingApprovals.length > 0) {
    lines.push(`${data.pendingApprovals.length} pending approval${data.pendingApprovals.length === 1 ? "" : "s"} waiting on you.`);
  }

  if (data.proposals.length > 0) {
    lines.push(`${data.proposals.length} new feature proposal${data.proposals.length === 1 ? "" : "s"} to review.`);
  }

  if (data.auditEntries.length === 0 && data.growthActions.length === 0 && data.pendingApprovals.length === 0 && data.proposals.length === 0) {
    lines.push(`Nothing happened ${periodLabel} — quiet period.`);
  }

  return lines.join("\n");
}

export type DigestSendResult = { ok: true } | { ok: false; reason: string };

/** Thin IO wrapper — a real HTTP POST to a Slack incoming webhook (the
 * standard, well-documented mechanism; no Slack SDK dependency needed for
 * a single text message). Never throws — a delivery failure is reported
 * back, not an unhandled rejection a cron job would silently swallow. */
export async function sendSlackDigest(webhookUrl: string, message: string): Promise<DigestSendResult> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) {
      return { ok: false, reason: `Slack webhook returned HTTP ${res.status}: ${await res.text()}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Slack webhook request failed: ${(err as Error).message}` };
  }
}
