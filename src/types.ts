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
  source: "sentry" | "manual" | "swarm" | "health-scout";
  /** Identity of the real-world issue this report is about, independent of
   * which path detected it. Only set when a source can honestly supply a
   * strong cross-source identity (e.g. a Sentry permalink) — the same
   * Sentry issue can reach the pipeline either directly via `sources/
   * sentry.ts` (sourceId = the Sentry issue id) or indirectly via a
   * health-scout cluster that corroborates it (sourceId = the cluster's
   * report id); without this, `pipeline.ts` would process both as
   * unrelated and open two competing fix PRs for the same bug. */
  correlationKey?: string;
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
 * moves up after a track record at the level below.
 *
 * **Current implementation reality (decided 2026-10-03, documented not
 * built):** only the L3 threshold is behaviorally real. `autonomy.ts`'s
 * `evaluateAutonomy` checks exactly one thing — `level >= L3` — to decide
 * whether an area auto-ships. L4 ("runs product-wide experiments") and L5
 * ("promotes new features") are real target definitions from the source
 * doc, kept here as the north star for where per-area trust eventually
 * goes, but they are NOT yet distinct code paths: setting an area to L4 or
 * L5 today has the exact same effect as L3. This was a deliberate choice,
 * not an oversight — graduated autonomy beyond "ships low-risk fixes
 * automatically" isn't something this project has decided it wants yet
 * (there's nothing today that would exercise L4's "product-wide
 * experiments" or L5's "promotes new features" — Step 3's experiment
 * engine has zero active experiments, and Step 4 has never executed a
 * real external action). Revisit this comment, not just the behavior,
 * when/if that changes. See `docs/platform-audit-findings.md` (Cross-
 * cutting #3) for the audit that surfaced this gap. */
export type AutonomyLevel =
  | "L0" // Observe — reports issues/opportunities; human decides and builds everything
  | "L1" // Suggest — diagnoses and drafts fixes/proposals; human reviews and implements
  | "L2" // Prepare — opens tested PRs and experiment plans; human approves and merges
  | "L3" // Act on low risk — ships low-risk fixes and per-user adaptations; human reviews summaries, can veto
  | "L4" // Experiment (not yet behaviorally distinct from L3 — see note above) — runs product-wide experiments within guardrails; human sets goals and guardrails
  | "L5"; // Evolve (not yet behaviorally distinct from L3 — see note above) — promotes new features and blocks; human owns vision and core

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
