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
  source: "sentry" | "manual" | "swarm";
};

export type PipelineResult =
  | { status: "no_signal" }
  | { status: "already_processed"; sourceId: string }
  | { status: "reproduction_failed"; reason: string }
  | { status: "verifier_rejected"; reason: string }
  | { status: "ci_failed"; reason: string }
  | { status: "pr_opened"; url: string; branch: string };

/** Governance levels L0-L5, per source doc "Autonomy levels and governance".
 * Autonomy is earned per area, not granted platform-wide — an area only
 * moves up after a track record at the level below. */
export type AutonomyLevel =
  | "L0" // Observe — reports issues/opportunities; human decides and builds everything
  | "L1" // Suggest — diagnoses and drafts fixes/proposals; human reviews and implements
  | "L2" // Prepare — opens tested PRs and experiment plans; human approves and merges
  | "L3" // Act on low risk — ships low-risk fixes and per-user adaptations; human reviews summaries, can veto
  | "L4" // Experiment — runs product-wide experiments within guardrails; human sets goals and guardrails
  | "L5"; // Evolve — promotes new features and blocks; human owns vision and core

/** One named zone of the app (e.g. "ui", "billing") mapped to the path globs
 * its files live under, with its own autonomy level. */
export type AutonomyAreaConfig = {
  area: string;
  pathGlobs: string[];
  level: AutonomyLevel;
};

/** Per-repo autonomy configuration. Any file not matched by an area falls
 * back to `defaultLevel`, which must be "L2" wherever this is constructed
 * for a repo that hasn't explicitly opted into a higher level. */
export type AutonomyConfig = {
  defaultLevel: AutonomyLevel;
  areas: AutonomyAreaConfig[];
};

/** The subset of a pipeline run's state that autonomy evaluation needs. */
export type ChangeForAutonomy = {
  sourceId: string;
  filesChanged: string[];
  isBugfix: boolean;
  verifierApproved: boolean;
  ciPassed: boolean;
};

export type AutonomyDecision = {
  level: AutonomyLevel;
  autoShip: boolean;
  area: string;
  reason: string;
};
