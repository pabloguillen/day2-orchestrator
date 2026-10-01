import type { BugReport } from "../types";
import type { Report } from "./types";

/**
 * Turns an actionable `Report` into a `BugReport` the existing healing
 * pipeline (`runPipeline`) can act on — the same "every trigger source maps
 * into the same shape" sink `sources/swarm.ts`/`sources/sentry.ts` already
 * use. Non-actionable reports (PostHog's own "needs input" case) are
 * deliberately excluded here, not converted with a caveat — they belong in
 * an owner-facing inbox for a human to look at, not fed to `bun run fix`.
 */
export function reportToBugReport(report: Report): BugReport {
  const sourceList = [...new Set(report.signals.map((s) => s.source))].join(", ");
  const evidenceLines = report.signals
    .map(
      (s) =>
        `- [${s.source}] ${s.finding} (${s.occurrences} occurrence(s), ${s.affectedUsers} affected user(s))\n` +
        `  Evidence: ${JSON.stringify(s.evidence)}\n  Suggested action: ${s.suggestedAction}`,
    )
    .join("\n");

  return {
    title: `[${report.priority}] ${report.title}`,
    description:
      `${report.title}\n\n` +
      `Priority: ${report.priority} (${report.reason})\n` +
      `Detected by: ${sourceList}\n\n` +
      `Evidence from ${report.signals.length} signal(s):\n${evidenceLines}`,
    context: `Clustered by day2's health-signal scout (orchestrator/src/signals/) for app "${report.appId}" from ${report.signals.length} real signal(s) — not a static analysis guess or a hand-written report.`,
    sourceId: report.id,
    source: "health-scout" as const,
  };
}

export function reportsToBugReports(reports: Report[]): BugReport[] {
  return reports.filter((r) => r.actionable).map(reportToBugReport);
}
