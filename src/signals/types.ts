/**
 * General-purpose product-health signals — day2's own version of PostHog's
 * "self-driving" signal/scout/report pipeline, scoped deliberately to
 * product-health findings (errors, interaction friction, pre-release UX
 * checks) rather than growth/acquisition economics, which already have
 * their own typed pipeline (`../metrics/`, `../diagnosis/` — Thompson-
 * sampling allocation, CAC/LTV, experiment significance). This is a
 * parallel, non-overlapping system: it feeds the existing healing pipeline
 * (`BugReport`/`runPipeline`), not the growth diagnosis router's
 * `DiagnosisRoute`.
 *
 * Generic across every day2-managed app — nothing here references
 * expense-buddy or any other specific app. Every field that identifies
 * *which* app a signal came from is an explicit, passed-in value, matching
 * the multi-app direction `apps-registry.ts`'s own `AppEntry` is heading.
 *
 * One narrow, deliberate bridge to the growth side: `diagnosis-to-signal.ts`
 * converts a `route: "healing"` `Diagnosis` (a confirmed crash/error-rate
 * spike concentrated in a cohort — `diagnosis/rules.ts`'s D6) into a real
 * `Signal`, because that specific diagnosis route *is* a product-health
 * finding, not a growth-economics one. Every other `DiagnosisRoute`
 * (`allocator`, `creative`, `config`, `composer`, `evolution`, `release`)
 * stays exactly what it was: a human-readable label `cohort-report-card.ts`/
 * `growth-arm-check.ts` render, never converted here.
 */

export type SignalSource = "sentry" | "interaction-friction" | "ux-swarm" | "growth-diagnosis";

export type Signal = {
  /** Stable id for dedup across repeated scout runs — same discipline as
   * `BugReport.sourceId`. */
  id: string;
  source: SignalSource;
  /** Which app this signal is about — an `AppEntry.id`-shaped string once
   * the apps registry lands; a plain caller-supplied label until then. */
  appId: string;
  at: string;
  /** One-line human description — "what's happening". */
  finding: string;
  /** Supporting data — "the evidence behind it". Kept as a loose record
   * rather than a rigid per-source shape, since each source's real evidence
   * looks different (a Sentry stack trace vs. a friction click count vs. a
   * swarm persona's transcript excerpt) and forcing one shape would mean
   * fabricating fields sources don't actually have. */
  evidence: Record<string, unknown>;
  /** A rough confidence/severity signal every source can honestly supply:
   * how many real occurrences, and how many distinct users/devices,
   * without each source needing to agree on a shared statistical model
   * (that's the metrics layer's job for growth data, not this one's for
   * product-health data at this project's current scale). */
  occurrences: number;
  affectedUsers: number;
  /** Which part of the app this touches, for clustering — a URL path, a
   * route name, or a component identifier, whatever the source can supply. */
  path?: string;
  suggestedAction: string;
};

export type ReportPriority = "P1" | "P2" | "P3";

export type Report = {
  id: string;
  /** Every signal in a cluster shares one `appId` by construction
   * (`cluster.ts` keys on `appId` first) — kept here explicitly rather than
   * parsed back out of `id`, which is sanitized for use as an identifier
   * and can't safely round-trip back into its original parts. */
  appId: string;
  title: string;
  /** Every signal that got clustered into this report — PostHog's own
   * framing, quoted directly: "related signals grouped into one item of
   * work, so you deal with the real problem instead of a noisy stream of
   * findings." */
  signals: Signal[];
  priority: ReportPriority;
  /** Whether this report is concrete enough to become a `BugReport`
   * automatically, or needs a human to look at it first — PostHog's own
   * "actionable" vs. "needs input" split, quoted: "When a report is
   * actionable, PostHog opens a pull request... when it needs your input,
   * it surfaces the report in your inbox instead." A single signal source
   * is enough to be actionable if specific and reproducible (e.g. a named
   * Sentry stack trace); corroboration from a second independent source
   * raises confidence but isn't required to act. */
  actionable: boolean;
  reason: string;
  createdAt: string;
};
