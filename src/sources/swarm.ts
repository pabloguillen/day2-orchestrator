import type { PersonaResult } from "../swarm";
import type { BugReport } from "../types";

/**
 * Maps swarm v1's failed persona results (COORDINATION.md W13) into
 * `BugReport`s the healing pipeline can act on — the connection W13's own
 * "not built" note flagged: today a `swarm_check_failed` just blocks the
 * release and logs the reason, and W15 demonstrated the value of closing
 * that gap by hand (reading swarm output, hand-writing a report, running
 * `bun run fix`). This makes that mapping mechanical instead of manual,
 * same "every trigger source maps into the same shape" design `types.ts`
 * already states as its intent for exactly this kind of extension.
 *
 * One `BugReport` per failed persona, not one combined report per swarm
 * run — each persona's finding is independently reproducible and
 * describes a single concern (one accessibility violation, one input-
 * validation gap), matching the fix-agent's own instruction to apply "the
 * smallest fix that addresses the root cause" rather than a grab-bag PR.
 */

const VERDICT_PREFIX = /^SWARM_VERDICT:\s*FAIL\s*—\s*/;

/** Strips the "SWARM_VERDICT: FAIL — " prefix a persona's summary always
 * carries when it reached a real verdict, leaving just the finding — but
 * degrades gracefully (returns the summary as-is) for the rarer case where
 * a persona never reached a parseable verdict at all (see `parseVerdict`'s
 * fail-closed fallback in `swarm.ts`), so a malformed summary still becomes
 * a usable bug report instead of silently dropping the finding. */
function extractFinding(summary: string): string {
  return summary.replace(VERDICT_PREFIX, "").trim() || summary;
}

export type SwarmReportContext = {
  /** The commit under test — becomes part of the report's traceability and
   * the dedup key, so the same finding on the same commit isn't reprocessed
   * if this is run more than once against the same swarm result. */
  sha: string;
  previewUrl: string;
};

export function swarmFailuresToBugReports(
  results: PersonaResult[],
  context: SwarmReportContext,
): BugReport[] {
  return results
    .filter((r) => !r.passed)
    .map((r) => {
      const finding = extractFinding(r.summary);
      return {
        title: `Swarm v1 (${r.persona}): ${finding.slice(0, 120)}`,
        description: finding,
        context:
          `Found by swarm v1's "${r.persona}" persona during automated pre-release ` +
          `testing (COORDINATION.md W13/W17) — real Playwright browser automation ` +
          `against a live deployed preview, not a static analysis guess or a human ` +
          `report. Commit under test: ${context.sha}. Preview at the time of the ` +
          `finding: ${context.previewUrl} (may since have been torn down).` +
          (r.isError ? " Note: this persona did not reach a clean verdict (agent error or turn/budget cap) — treat as lower-confidence than a normal FAIL." : ""),
        sourceId: `swarm-${context.sha.slice(0, 8)}-${r.persona}`,
        source: "swarm" as const,
      };
    });
}
