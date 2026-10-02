/**
 * Retention domain (docs/closed-loop-spec.md §4.3). Purely event-based.
 * "Dn retention" is relative to each device's own first-seen date, not an
 * absolute calendar date — the standard cohort-retention definition.
 */

import { hasSufficientData, wilsonScoreInterval } from "./confidence";
import { AppMetricConfig, BreakdownDimension, EventLike, MetricValue } from "./types";
import { groupAllDevices } from "./core";

function byDeviceMap(events: EventLike[]): Map<string, EventLike[]> {
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  return byDevice;
}

/** True if the device has a real active-user event on day `n` (±1 day)
 * after its own first-seen event — spec §4.3: "users active on day n (±1)
 * / cohort size". `asOfIso` bounds how far the observation window extends
 * (a device only 3 days old can't yet be judged for D7 — excluded from
 * both numerator and denominator, not counted as churned). */
function eligibleForWindow(firstSeenIso: string, n: number, asOfIso: string): boolean {
  const dayMs = 24 * 60 * 60 * 1000;
  const observedThrough = (new Date(asOfIso).getTime() - new Date(firstSeenIso).getTime()) / dayMs;
  return observedThrough >= n - 1;
}

/**
 * `sortedDeviceEvents` must be pre-sorted ascending with `sortedDeviceEvents[0]`
 * being the device's real first-touch/anchor event. That anchor event is
 * never itself eligible to count as "returning" on day n — the naive ±1 day
 * window around day n's target otherwise overlaps day 0 (the anchor's own
 * day), which would make every device trivially "D1-retained" just for
 * having signed up, the bug this split specifically guards against. Only
 * events strictly after the anchor are considered. */
function activeOnDay(sortedDeviceEvents: EventLike[], config: AppMetricConfig, n: number): boolean {
  const dayMs = 24 * 60 * 60 * 1000;
  const firstMs = new Date(sortedDeviceEvents[0]!.at).getTime();
  const targetMs = firstMs + n * dayMs;
  return sortedDeviceEvents.slice(1).some((e) => {
    if (e.type !== config.activeUser.event) return false;
    const deltaDays = Math.abs(new Date(e.at).getTime() - targetMs) / dayMs;
    return deltaDays <= 1;
  });
}

/** Dn retention for each window in `config.retentionWindowsDays` (default
 * [1, 7, 30]), broken down by `dimension`. Only devices old enough to be
 * observed for a given window count toward that window's denominator —
 * never penalizes a genuinely-too-new device as "not retained". */
export function computeRetention(
  events: EventLike[],
  config: AppMetricConfig,
  asOfIso: string,
  dimension: BreakdownDimension = "cohort",
): Record<number, MetricValue[]> {
  const byDevice = byDeviceMap(events);
  const { groups } = groupAllDevices(events, dimension);
  const result: Record<number, MetricValue[]> = {};

  for (const n of config.retentionWindowsDays) {
    const values: MetricValue[] = [];
    for (const [key, deviceIds] of groups) {
      let eligible = 0;
      let retained = 0;
      for (const deviceId of deviceIds) {
        const deviceEvents = byDevice.get(deviceId) ?? [];
        const sorted = [...deviceEvents].sort((a, b) => a.at.localeCompare(b.at));
        const first = sorted[0];
        if (!first) continue;
        if (!eligibleForWindow(first.at, n, asOfIso)) continue;
        eligible++;
        if (activeOnDay(sorted, config, n)) retained++;
      }
      values.push({
        metric: `d${n}_retention`,
        breakdown: dimension === "app" ? {} : { [dimension]: key },
        value: eligible > 0 ? retained / eligible : null,
        n: eligible,
        ci: eligible > 0 ? wilsonScoreInterval(retained, eligible) : null,
        sufficientData: hasSufficientData(eligible),
      });
    }
    result[n] = values;
  }
  return result;
}

/** users active last period, not this period / active last period.
 * `periodDays` defines what a "period" is (e.g. 7 for weekly churn). Both
 * periods are windows ending at `asOfIso` and `asOfIso - periodDays`. */
export function computeChurnRate(
  events: EventLike[],
  config: AppMetricConfig,
  asOfIso: string,
  periodDays: number,
): MetricValue {
  const byDevice = byDeviceMap(events);
  const dayMs = 24 * 60 * 60 * 1000;
  const asOfMs = new Date(asOfIso).getTime();
  const lastPeriodStart = asOfMs - 2 * periodDays * dayMs;
  const lastPeriodEnd = asOfMs - periodDays * dayMs;

  let activeLastPeriod = 0;
  let churned = 0;
  for (const deviceEvents of byDevice.values()) {
    const wasActiveLastPeriod = deviceEvents.some((e) => {
      if (e.type !== config.activeUser.event) return false;
      const t = new Date(e.at).getTime();
      return t >= lastPeriodStart && t < lastPeriodEnd;
    });
    if (!wasActiveLastPeriod) continue;
    activeLastPeriod++;
    const activeThisPeriod = deviceEvents.some((e) => {
      if (e.type !== config.activeUser.event) return false;
      const t = new Date(e.at).getTime();
      return t >= lastPeriodEnd && t <= asOfMs;
    });
    if (!activeThisPeriod) churned++;
  }
  return {
    metric: "churn_rate",
    breakdown: {},
    value: activeLastPeriod > 0 ? churned / activeLastPeriod : null,
    n: activeLastPeriod,
    ci: activeLastPeriod > 0 ? wilsonScoreInterval(churned, activeLastPeriod) : null,
    sufficientData: hasSufficientData(activeLastPeriod),
  };
}

/** users returning after >=30 inactive days / inactive pool. "Inactive
 * pool" = devices with a real gap of >=30 days between two active-user
 * events anywhere in their history, as observed by `asOfIso`. "Returning"
 * = that gap was eventually followed by another active-user event (i.e.
 * the device wasn't simply asked about mid-gap). */
export function computeResurrectionRate(events: EventLike[], config: AppMetricConfig, asOfIso: string): MetricValue {
  const byDevice = byDeviceMap(events);
  const dayMs = 24 * 60 * 60 * 1000;
  const asOfMs = new Date(asOfIso).getTime();
  let inactivePool = 0;
  let resurrected = 0;

  for (const deviceEvents of byDevice.values()) {
    const activeTimes = deviceEvents
      .filter((e) => e.type === config.activeUser.event)
      .map((e) => new Date(e.at).getTime())
      .sort((a, b) => a - b);
    if (activeTimes.length === 0) continue;

    let wasEverInactivePool = false;
    let didResurrect = false;
    // A 30+ day gap between two real active events: this device went dark
    // and the later event is a genuine return — credits both the pool and
    // the resurrection.
    for (let i = 1; i < activeTimes.length; i++) {
      const gapDays = (activeTimes[i]! - activeTimes[i - 1]!) / dayMs;
      if (gapDays >= 30) {
        wasEverInactivePool = true;
        didResurrect = true;
      }
    }
    // Currently silent >=30 days as of `asOfIso` with no return yet — still
    // in the pool, but not (yet) resurrected. Without this check every
    // device with zero gaps in its (possibly very short) history would
    // never enter the pool at all, silently ignoring the far more common
    // real case: a device that went quiet and simply hasn't come back.
    const silentTailDays = (asOfMs - activeTimes[activeTimes.length - 1]!) / dayMs;
    if (silentTailDays >= 30) wasEverInactivePool = true;

    if (wasEverInactivePool) {
      inactivePool++;
      if (didResurrect) resurrected++;
    }
  }
  return {
    metric: "resurrection_rate",
    breakdown: {},
    value: inactivePool > 0 ? resurrected / inactivePool : null,
    n: inactivePool,
    ci: inactivePool > 0 ? wilsonScoreInterval(resurrected, inactivePool) : null,
    sufficientData: hasSufficientData(inactivePool),
  };
}
