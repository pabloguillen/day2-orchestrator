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
/** A Sentry permalink is the one cross-source identity every path that can
 * see a Sentry issue agrees on (`sources/sentry.ts`'s own `correlationKey`,
 * `impact.ts`'s `matchesOriginal`). If this cluster corroborates a Sentry
 * issue, reuse its permalink so `pipeline.ts` recognizes it as the same
 * real-world issue the classic Sentry path may have already reported under
 * a different `sourceId` — not a new, separately-processed signal. */
function correlationKeyFor(report: Report): string | undefined {
  for (const signal of report.signals) {
    const permalink = signal.evidence.permalink;
    if (typeof permalink === "string" && permalink.length > 0) return permalink;
  }
  return undefined;
}

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
    correlationKey: correlationKeyFor(report),
  };
}

export function reportsToBugReports(reports: Report[]): BugReport[] {
  return reports.filter((r) => r.actionable).map(reportToBugReport);
}
