/**
 * Generic, reusable KPI-computation primitives (docs/closed-loop-spec.md
 * §4.1, §4.3). Most of the ~45 metrics in the spec's table reduce to one of
 * three shapes — a rate (successes/total), a distinct-count, or a mean —
 * so these three do the real work and every individual KPI in
 * `*-kpis.ts` is a short, mostly-declarative call into one of them. Pure.
 */

import { hasSufficientData, meanConfidenceInterval, wilsonScoreInterval } from "./confidence";
import {
  BreakdownDimension,
  EventLike,
  MetricValue,
  ResolvedBreakdown,
  UNKNOWN_BUCKET,
} from "./types";
import { groupDevicesByDimension, resolveAllDeviceBreakdowns } from "./breakdown";

/** All devices present in `events`, grouped by `dimension` — the shared
 * first step every metric function below starts from. */
export function groupAllDevices(
  events: EventLike[],
  dimension: BreakdownDimension,
): { breakdowns: Map<string, ResolvedBreakdown>; groups: Map<string, string[]> } {
  const breakdowns = resolveAllDeviceBreakdowns(events);
  const deviceIds = new Set(events.map((e) => e.deviceId));
  const groups = groupDevicesByDimension(deviceIds, breakdowns, dimension);
  return { breakdowns, groups };
}

function toMetricValue(
  metric: string,
  dimension: BreakdownDimension,
  key: string,
  value: number | null,
  n: number,
  ci: [number, number] | null,
): MetricValue {
  return {
    metric,
    breakdown: dimension === "app" ? {} : { [dimension]: key },
    value,
    n,
    ci,
    sufficientData: hasSufficientData(n),
  };
}

/**
 * A rate metric: `|{devices meeting numeratorPredicate}| / |{devices
 * meeting denominatorPredicate}|`, broken down by `dimension`, with a
 * Wilson CI. Both predicates run over one device's full event list, so a
 * numerator that depends on a denominator-scoped window (e.g. "activated
 * within 24h of signup") is expressible directly.
 */
export function computeRateMetric(
  metric: string,
  events: EventLike[],
  dimension: BreakdownDimension,
  denominatorPredicate: (deviceEvents: EventLike[]) => boolean,
  numeratorPredicate: (deviceEvents: EventLike[]) => boolean,
): MetricValue[] {
  const { breakdowns, groups } = groupAllDevices(events, dimension);
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }

  const results: MetricValue[] = [];
  for (const [key, deviceIds] of groups) {
    const denomDevices = deviceIds.filter((d) => denominatorPredicate(byDevice.get(d) ?? []));
    const total = denomDevices.length;
    if (total === 0) {
      results.push(toMetricValue(metric, dimension, key, null, 0, null));
      continue;
    }
    const successes = denomDevices.filter((d) => numeratorPredicate(byDevice.get(d) ?? [])).length;
    const value = successes / total;
    results.push(toMetricValue(metric, dimension, key, value, total, wilsonScoreInterval(successes, total)));
  }
  void breakdowns;
  return results;
}

/** A distinct-count metric: `|{devices meeting predicate}|`, broken down.
 * No CI (a count isn't a proportion or a sample mean — spec §4.3's DAU/WAU/
 * MAU are reported as raw counts, not rates). */
export function computeDistinctCountMetric(
  metric: string,
  events: EventLike[],
  dimension: BreakdownDimension,
  predicate: (deviceEvents: EventLike[]) => boolean,
): MetricValue[] {
  const { groups } = groupAllDevices(events, dimension);
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const results: MetricValue[] = [];
  for (const [key, deviceIds] of groups) {
    const count = deviceIds.filter((d) => predicate(byDevice.get(d) ?? [])).length;
    results.push(toMetricValue(metric, dimension, key, count, deviceIds.length, null));
  }
  return results;
}

/** A per-device mean metric (e.g. sessions per user, ARPU): `valueFn` maps
 * one device's events to a number (or `null` to exclude that device from
 * the mean entirely — e.g. ARPU should divide by *active* users, not every
 * device that ever existed). Reports a normal-approximation CI. */
export function computeMeanMetric(
  metric: string,
  events: EventLike[],
  dimension: BreakdownDimension,
  valueFn: (deviceEvents: EventLike[]) => number | null,
): MetricValue[] {
  const { groups } = groupAllDevices(events, dimension);
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const results: MetricValue[] = [];
  for (const [key, deviceIds] of groups) {
    const values = deviceIds
      .map((d) => valueFn(byDevice.get(d) ?? []))
      .filter((v): v is number => v !== null);
    if (values.length === 0) {
      results.push(toMetricValue(metric, dimension, key, null, 0, null));
      continue;
    }
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    results.push(toMetricValue(metric, dimension, key, avg, values.length, meanConfidenceInterval(values)));
  }
  return results;
}

/** Simple helper: does this device have >= `count` events of `type`
 * within `withinHours` of its first event? (spec §4.2's `activation`
 * shape). Pure, reused by activation rate and several others. */
export function meetsCountedEventThreshold(
  deviceEvents: EventLike[],
  eventType: string,
  count: number,
  withinHours?: number,
): boolean {
  if (deviceEvents.length === 0) return false;
  const sorted = [...deviceEvents].sort((a, b) => a.at.localeCompare(b.at));
  const anchorMs = new Date(sorted[0]!.at).getTime();
  const matches = sorted.filter((e) => {
    if (e.type !== eventType) return false;
    if (withinHours === undefined) return true;
    const deltaHours = (new Date(e.at).getTime() - anchorMs) / (1000 * 60 * 60);
    return deltaHours <= withinHours;
  });
  return matches.length >= count;
}

export function countOfType(deviceEvents: EventLike[], eventType: string): number {
  return deviceEvents.filter((e) => e.type === eventType).length;
}

export function hasEventType(deviceEvents: EventLike[], eventType: string): boolean {
  return deviceEvents.some((e) => e.type === eventType);
}

export const UNKNOWN = UNKNOWN_BUCKET;
