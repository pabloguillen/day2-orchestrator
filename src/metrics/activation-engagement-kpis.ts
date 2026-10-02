/**
 * Activation + Engagement domains (docs/closed-loop-spec.md §4.3). Purely
 * event-based — no external ingest needed.
 */

import {
  computeDistinctCountMetric,
  computeMeanMetric,
  computeRateMetric,
  countOfType,
  hasEventType,
  meetsCountedEventThreshold,
} from "./core";
import { hasSufficientData } from "./confidence";
import { AppMetricConfig, BreakdownDimension, EventLike, MetricValue } from "./types";

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** users meeting `config.activation` / signups. expense-buddy has no real
 * `signup` event (no accounts) — the denominator here is every device with
 * at least one event at all, the honest proxy this no-auth app already
 * uses elsewhere (device-keyed identity, per the resolved identity strategy
 * in docs/step2-self-adapting-spec.md §2). */
export function computeActivationRate(
  events: EventLike[],
  config: AppMetricConfig,
  dimension: BreakdownDimension = "cohort",
): MetricValue[] {
  return computeRateMetric(
    "activation_rate",
    events,
    dimension,
    () => true,
    (d) => meetsCountedEventThreshold(d, config.activation.event, config.activation.count, config.activation.withinHours),
  );
}

/** Median time (hours) from a device's first event to meeting the
 * activation threshold — only over devices that actually activated. */
export function computeTimeToValueHours(events: EventLike[], config: AppMetricConfig): MetricValue {
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const hoursToActivate: number[] = [];
  for (const deviceEvents of byDevice.values()) {
    const sorted = [...deviceEvents].sort((a, b) => a.at.localeCompare(b.at));
    const first = sorted[0];
    if (!first) continue;
    const activationEvent = sorted.find((e) => e.type === config.activation.event);
    if (!activationEvent) continue;
    const hours = (new Date(activationEvent.at).getTime() - new Date(first.at).getTime()) / (1000 * 60 * 60);
    hoursToActivate.push(hours);
  }
  if (hoursToActivate.length === 0) {
    return { metric: "time_to_value_hours", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  }
  const sorted = [...hoursToActivate].sort((a, b) => a - b);
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return {
    metric: "time_to_value_hours",
    breakdown: {},
    value: median,
    n: hoursToActivate.length,
    ci: null, // median, not a mean — the mean-CI primitive doesn't apply; disclosed, not computed
    sufficientData: hasSufficientData(hoursToActivate.length),
  };
}

/** For devices that never activated: which `screen_view` (or, lacking that,
 * any event) was their last before the session ended — a distribution, not
 * a single number, since "the weakest step" (spec §8) needs to know *where*
 * drop-off concentrates. Returns counts per last-event-type, most first. */
export function computeFirstSessionDropOff(
  events: EventLike[],
  config: AppMetricConfig,
): { eventType: string; count: number }[] {
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const counts = new Map<string, number>();
  for (const deviceEvents of byDevice.values()) {
    if (meetsCountedEventThreshold(deviceEvents, config.activation.event, config.activation.count, config.activation.withinHours)) {
      continue; // only non-activators count toward drop-off
    }
    const sorted = [...deviceEvents].sort((a, b) => a.at.localeCompare(b.at));
    const last = sorted[sorted.length - 1];
    if (!last) continue;
    counts.set(last.type, (counts.get(last.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

function activeWithinDays(deviceEvents: EventLike[], config: AppMetricConfig, asOfIso: string, days: number): boolean {
  const cutoff = new Date(asOfIso).getTime() - days * 24 * 60 * 60 * 1000;
  const count = deviceEvents.filter((e) => e.type === config.activeUser.event && new Date(e.at).getTime() >= cutoff).length;
  return count >= config.activeUser.minCount;
}

/** DAU/WAU/MAU — distinct active-user counts over 1/7/30 days, as of
 * `asOfIso`. Raw counts (spec §4.3 doesn't ask for a rate here). */
export function computeDauWauMau(
  events: EventLike[],
  config: AppMetricConfig,
  asOfIso: string,
  dimension: BreakdownDimension = "app",
): { dau: MetricValue[]; wau: MetricValue[]; mau: MetricValue[] } {
  return {
    dau: computeDistinctCountMetric("dau", events, dimension, (d) => activeWithinDays(d, config, asOfIso, 1)),
    wau: computeDistinctCountMetric("wau", events, dimension, (d) => activeWithinDays(d, config, asOfIso, 7)),
    mau: computeDistinctCountMetric("mau", events, dimension, (d) => activeWithinDays(d, config, asOfIso, 30)),
  };
}

/** DAU / MAU — a real ratio of the two counts above, app-wide. */
export function computeStickiness(events: EventLike[], config: AppMetricConfig, asOfIso: string): MetricValue {
  const dau = computeDistinctCountMetric("dau", events, "app", (d) => activeWithinDays(d, config, asOfIso, 1))[0];
  const mau = computeDistinctCountMetric("mau", events, "app", (d) => activeWithinDays(d, config, asOfIso, 30))[0];
  const mauCount = mau?.value ?? 0;
  return {
    metric: "stickiness",
    breakdown: {},
    value: mauCount > 0 ? (dau?.value ?? 0) / mauCount : null,
    n: mauCount,
    ci: null, // ratio of two counts over overlapping windows, not a binomial proportion — no CI form applies
    sufficientData: hasSufficientData(mauCount),
  };
}

/** sessions / active users, per week — mean sessions-per-device over the
 * whole input window (caller pre-filters `events` to one week if a
 * per-week series is needed; this function itself is window-agnostic). */
export function computeSessionsPerUser(
  events: EventLike[],
  dimension: BreakdownDimension = "app",
): MetricValue[] {
  return computeMeanMetric("sessions_per_user", events, dimension, (d) => {
    const sessionCount = countOfType(d, "session_start");
    return sessionCount > 0 ? sessionCount : null;
  });
}

/** users using `featureEventType` / active users, broken down. */
export function computeFeatureAdoption(
  events: EventLike[],
  featureEventType: string,
  dimension: BreakdownDimension = "app",
): MetricValue[] {
  return computeRateMetric(
    `feature_adoption:${featureEventType}`,
    events,
    dimension,
    () => true,
    (d) => hasEventType(d, featureEventType),
  );
}

/** core actions per active user per week — mean over the input window,
 * caller passes one week's worth of events for a true "per week" figure. */
export function computeCoreActionFrequency(
  events: EventLike[],
  config: AppMetricConfig,
  dimension: BreakdownDimension = "app",
): MetricValue[] {
  return computeMeanMetric("core_action_frequency", events, dimension, (d) => {
    const count = config.coreActions.reduce((a, type) => a + countOfType(d, type), 0);
    return count > 0 ? count : null;
  });
}
