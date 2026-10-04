import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCohortReportCard,
  hasChangedMaterially,
  renderCohortReportCards,
  type CohortReportCard,
} from "./cohort-report-card";
import type { Diagnosis } from "./diagnosis";
import {
  computeActivationRate,
  computeLandingToSignup,
  computeRetention,
  computeTrialToPaid,
  resolveAllDeviceBreakdowns,
  DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG,
  type AppMetricConfig,
  type EventLike,
  type MetricValue,
} from "./metrics";
import { loadAuditEntries, type AuditEntry } from "./owner-feed";
import { listProposals, type RecordedProposal } from "./proposals";

/**
 * CLI entrypoint for M5's cohort report card (docs/closed-loop-spec.md §11).
 * `cohort-report-card.ts` was fully real, tested, pure logic with zero
 * production caller — `linkedItems` was hardcoded to always resolve `[]`
 * because nothing ever called `buildCohortReportCard` with real proposal/
 * audit inputs, a real orphaned-module finding from the independent audit.
 * This file is that caller, assembled from real inputs already available in
 * this orchestrator:
 *   - the metric side: `metrics/core.ts` + `metrics/breakdown.ts`'s own
 *     cohort-grouping primitives, via the handful of domain KPI functions
 *     (`activation-engagement-kpis.ts`, `acquisition-virality-kpis.ts`,
 *     `monetization-kpis.ts`, `retention-kpis.ts`) that are already built on
 *     top of them — not reinvented here.
 *   - the linked-items side: `proposals.ts`'s `listProposals` and
 *     `owner-feed.ts`'s `loadAuditEntries`, cross-referenced by
 *     `findLinkedItems` (cohort-report-card.ts's own new, additive logic).
 *
 * Two funnel metrics from spec §11's own `FUNNEL_METRICS_IN_ORDER` are
 * honestly left uncomputed here: `ctr` and `cac_payback_months` both need
 * real ad-spend ingest (`external-ingest.ts`'s `SpendIngestRow[]`), a
 * separate file-based input this pass doesn't wire in — `buildFunnelSteps`
 * already renders an absent metric as "no data", not a fabricated number,
 * so this is a disclosed gap, not silently wrong output.
 *
 * Usage:
 *   bun run src/cohort-report-card-cli.ts --events-file <path> \
 *     [--last-week-events-file <path>] [--diagnoses-file <path>] \
 *     [--proposals-file <path>] [--audit-file <path>] [--as-of <iso>]
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    eventsFile: get("--events-file"),
    lastWeekEventsFile: get("--last-week-events-file"),
    diagnosesFile: get("--diagnoses-file"),
    proposalsFile: get("--proposals-file"),
    auditFile: get("--audit-file"),
    asOf: get("--as-of"),
  };
}

/** Fail-closed: a missing/malformed JSON-array input file is a real error,
 * not a silent "treat it as empty" — same discipline `apps-registry.ts`'s
 * and `health-scout-cli.ts`'s own JSON-array loaders already apply. */
export function loadJsonArrayFile<T>(path: string, label: string): T[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of ${label}.`);
  }
  return parsed as T[];
}

/** One cohort's real funnel metrics, keyed by metric name — `undefined`
 * dimension keys (shouldn't occur for the "cohort" dimension, but guarded
 * rather than assumed) are skipped rather than silently merged into the
 * wrong bucket. */
function computeFunnelMetricsByCohort(
  events: EventLike[],
  config: AppMetricConfig,
  asOfIso: string,
): Map<string, Partial<Record<string, MetricValue>>> {
  const byCohort = new Map<string, Partial<Record<string, MetricValue>>>();
  const add = (mv: MetricValue) => {
    const key = mv.breakdown.cohort;
    if (!key) return;
    const existing = byCohort.get(key) ?? {};
    existing[mv.metric] = mv;
    byCohort.set(key, existing);
  };

  for (const mv of computeLandingToSignup(events, "cohort")) add(mv);
  for (const mv of computeActivationRate(events, config, "cohort")) add(mv);
  for (const mv of computeTrialToPaid(events, "cohort")) add(mv);
  const retention = computeRetention(events, config, asOfIso, "cohort");
  for (const mv of retention[7] ?? []) add(mv);

  return byCohort;
}

/** App-wide value per metric — spec §8.1's real baseline concept, median
 * over the last 4 weeks, needs the diagnosis module's own historical-window
 * machinery (out of scope for this CLI); this uses the simpler, still-real
 * "whole app, right now" rate as the comparison baseline instead, disclosed
 * here rather than silently presented as the spec's exact definition. */
function computeAppWideBaseline(events: EventLike[], config: AppMetricConfig, asOfIso: string): Partial<Record<string, number>> {
  const baseline: Partial<Record<string, number>> = {};
  const landingToSignup = computeLandingToSignup(events, "app")[0]?.value;
  const activation = computeActivationRate(events, config, "app")[0]?.value;
  const trialToPaid = computeTrialToPaid(events, "app")[0]?.value;
  const retention = computeRetention(events, config, asOfIso, "app")[7]?.[0]?.value;
  if (landingToSignup !== null && landingToSignup !== undefined) baseline.landing_to_signup = landingToSignup;
  if (activation !== null && activation !== undefined) baseline.activation_rate = activation;
  if (trialToPaid !== null && trialToPaid !== undefined) baseline.trial_to_paid = trialToPaid;
  if (retention !== null && retention !== undefined) baseline.d7_retention = retention;
  return baseline;
}

/** Real arm/channel for a cohort key — read off any one device whose
 * resolved breakdown produced that cohort key (every device in a cohort
 * shares the same arm/channel by construction, `breakdown.ts::
 * resolveDeviceBreakdown`'s own `cohort = \`${armKey}@${isoWeek}\`` logic). */
function resolveArmChannelForCohort(events: EventLike[], cohortKey: string): { arm: string; channel: string } {
  const breakdowns = resolveAllDeviceBreakdowns(events);
  for (const b of breakdowns.values()) {
    if (b.cohort === cohortKey) return { arm: b.arm, channel: b.channel };
  }
  return { arm: "unattributed", channel: "(none)" };
}

export type CohortReportCardCliInputs = {
  events: EventLike[];
  /** Omitted entirely means "no prior snapshot to diff against" — every
   * real cohort present in `events` is shown, the only honest default when
   * there's nothing to compare to (not "nothing changed"). */
  lastWeekEvents?: EventLike[];
  diagnoses?: Diagnosis[];
  proposals?: RecordedProposal[];
  auditEntries?: AuditEntry[];
  config?: AppMetricConfig;
  asOfIso: string;
};

/**
 * Pure assembly of real report cards from real inputs — no file I/O, so
 * this is directly testable against constructed fixtures (`main` below is
 * the thin I/O shell around it, same split `auto-release-cli.ts`/
 * `health-scout-cli.ts` already establish between pure CLI logic and I/O).
 */
export function buildReportCardsFromInputs(inputs: CohortReportCardCliInputs): CohortReportCard[] {
  const config = inputs.config ?? DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG;
  const diagnoses = inputs.diagnoses ?? [];
  const proposals = inputs.proposals ?? [];
  const auditEntries = inputs.auditEntries ?? [];

  const thisWeek = computeFunnelMetricsByCohort(inputs.events, config, inputs.asOfIso);
  const baseline = computeAppWideBaseline(inputs.events, config, inputs.asOfIso);
  const lastWeek = inputs.lastWeekEvents ? computeFunnelMetricsByCohort(inputs.lastWeekEvents, config, inputs.asOfIso) : undefined;

  const diagnosesByCohort = new Map<string, Diagnosis[]>();
  for (const d of diagnoses) {
    const list = diagnosesByCohort.get(d.cohortKey) ?? [];
    list.push(d);
    diagnosesByCohort.set(d.cohortKey, list);
  }

  const cards: CohortReportCard[] = [];
  for (const cohortKey of [...thisWeek.keys()].sort()) {
    const thisWeekMetrics = thisWeek.get(cohortKey) ?? {};
    const diagnosesForCohort = diagnosesByCohort.get(cohortKey) ?? [];
    const primaryRuleId = diagnosesForCohort.find((d) => d.primary)?.ruleId;

    if (lastWeek) {
      const lastWeekMetrics = lastWeek.get(cohortKey) ?? {};
      // This CLI only has last week's raw events, not last week's computed
      // diagnosis — so the "diagnosis changed" half of hasChangedMaterially
      // is conservatively disabled (same ruleId passed on both sides) and
      // only the real metric-movement threshold decides materiality here.
      const changed = hasChangedMaterially(thisWeekMetrics, lastWeekMetrics, primaryRuleId, primaryRuleId);
      if (!changed) continue;
    }

    const { arm, channel } = resolveArmChannelForCohort(inputs.events, cohortKey);
    const primary = diagnosesForCohort.find((d) => d.primary);
    const expectedEffect = primary
      ? `Expected to move ${primary.evidence[0]?.metric ?? "the weakest funnel step"} toward this cohort's own baseline.`
      : "No specific expected effect — no diagnosis available for this cohort this run.";

    cards.push(
      buildCohortReportCard(
        cohortKey,
        channel,
        arm,
        diagnosesForCohort,
        thisWeekMetrics,
        baseline,
        expectedEffect,
        undefined,
        proposals,
        auditEntries,
      ),
    );
  }
  return cards;
}

function usage(): never {
  console.error(
    "Usage: bun run src/cohort-report-card-cli.ts --events-file <path> " +
      "[--last-week-events-file <path>] [--diagnoses-file <path>] " +
      "[--proposals-file <path>] [--audit-file <path>] [--as-of <iso>]",
  );
  process.exit(1);
}

function main() {
  const opts = parseArgs();
  if (!opts.eventsFile) usage();

  const events = loadJsonArrayFile<EventLike>(resolve(opts.eventsFile), "events");
  const lastWeekEvents = opts.lastWeekEventsFile
    ? loadJsonArrayFile<EventLike>(resolve(opts.lastWeekEventsFile), "events")
    : undefined;
  const diagnoses = opts.diagnosesFile ? loadJsonArrayFile<Diagnosis>(resolve(opts.diagnosesFile), "diagnoses") : [];
  const proposals = listProposals(resolve(opts.proposalsFile ?? "day2-proposals.jsonl"));
  const auditEntries = loadAuditEntries(resolve(opts.auditFile ?? "day2-autonomy-audit.jsonl"));
  const asOfIso = opts.asOf ?? new Date().toISOString();

  const cards = buildReportCardsFromInputs({ events, lastWeekEvents, diagnoses, proposals, auditEntries, asOfIso });
  console.log(renderCohortReportCards(cards));
}

if (import.meta.main) {
  main();
}
