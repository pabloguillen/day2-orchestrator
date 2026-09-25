/** A production signal, normalized regardless of where it came from — a Sentry
 * issue, a session replay, a user feedback submission, or a hand-written report.
 * Every trigger source (see src/sources/) maps into this same shape so the
 * pipeline never needs to know or care where the report originated. */
export type BugReport = {
  /** Short, human title — becomes the PR title prefix. */
  title: string;
  /** Full description: what's broken, for whom, how it was noticed. */
  description: string;
  /** Optional stack trace, breadcrumbs, or replay-derived action sequence. */
  context?: string;
  /** Stable ID from the source system, used to avoid double-processing. */
  sourceId: string;
  source: "sentry" | "manual";
};

export type PipelineResult =
  | { status: "no_signal" }
  | { status: "already_processed"; sourceId: string }
  | { status: "reproduction_failed"; reason: string }
  | { status: "verifier_rejected"; reason: string }
  | { status: "ci_failed"; reason: string }
  | { status: "pr_opened"; url: string; branch: string };
