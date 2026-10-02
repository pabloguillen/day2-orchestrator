/**
 * Acquisition + Virality domains (docs/closed-loop-spec.md §4.3). Mixed
 * data sources: CTR/CPC/CPI read `SpendIngestRow[]` (external-ingest.ts,
 * M1) since app events never see ad-platform impressions/clicks; CAC joins
 * ingest spend against real app events (who actually landed); the rest are
 * purely event-based.
 */

import type { SpendIngestRow } from "../external-ingest";
import { computeRateMetric, countOfType, hasEventType } from "./core";
import { hasSufficientData, wilsonScoreInterval } from "./confidence";
import { EventLike, MetricValue, BreakdownDimension } from "./types";

const PAID_CHANNELS = new Set(["paid_social", "paid_search"]);

function groupSpendRowsBy(rows: SpendIngestRow[], keyFn: (r: SpendIngestRow) => string): Map<string, SpendIngestRow[]> {
  const groups = new Map<string, SpendIngestRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function sum(rows: SpendIngestRow[], field: "spendUsd" | "impressions" | "clicks"): number {
  return rows.reduce((a, r) => a + r[field], 0);
}

function ratioMetric(metric: string, key: string, numerator: number, denominator: number): MetricValue {
  const value = denominator > 0 ? numerator / denominator : null;
  return {
    metric,
    breakdown: { arm: key },
    value,
    n: denominator,
    // A spend-derived ratio isn't a per-user proportion or sample mean —
    // no CI computed for it (disclosed, not silently omitted): spend/click
    // totals from an ad platform are aggregate counts, not a sample of
    // independent trials this project has a principled interval for.
    ci: null,
    sufficientData: hasSufficientData(denominator),
  };
}

/** clicks / impressions, per arm. */
export function computeCtr(rows: SpendIngestRow[]): MetricValue[] {
  const byArm = groupSpendRowsBy(rows, (r) => r.armId);
  return [...byArm.entries()].map(([arm, armRows]) => {
    const clicks = sum(armRows, "clicks");
    const impressions = sum(armRows, "impressions");
    const value = impressions > 0 ? clicks / impressions : null;
    return {
      metric: "ctr",
      breakdown: { arm },
      value,
      n: impressions,
      ci: impressions > 0 ? wilsonScoreInterval(clicks, impressions) : null,
      sufficientData: hasSufficientData(impressions),
    };
  });
}

/** spend / clicks, per arm. */
export function computeCpc(rows: SpendIngestRow[]): MetricValue[] {
  const byArm = groupSpendRowsBy(rows, (r) => r.armId);
  return [...byArm.entries()].map(([arm, armRows]) => ratioMetric("cpc", arm, sum(armRows, "spendUsd"), sum(armRows, "clicks")));
}

/** spend / (installs, when the ingest row carries them — mobile; else real
 * `acquisition_landing` event count for that arm — web, expense-buddy's
 * actual case today). Spec §4.3: "CPI | spend / installs (mobile) or
 * landings (web)". */
export function computeCpi(rows: SpendIngestRow[], events: EventLike[]): MetricValue[] {
  const byArm = groupSpendRowsBy(rows, (r) => r.armId);
  const landingsByArm = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "acquisition_landing") continue;
    const arm = e.acquisition?.armKey ?? "unattributed";
    landingsByArm.set(arm, (landingsByArm.get(arm) ?? 0) + 1);
  }
  return [...byArm.entries()].map(([arm, armRows]) => {
    const installsTotal = armRows.reduce((a, r) => a + (r.installs ?? 0), 0);
    const denom = installsTotal > 0 ? installsTotal : (landingsByArm.get(arm) ?? 0);
    return ratioMetric("cpi", arm, sum(armRows, "spendUsd"), denom);
  });
}

/** signups / acquisition_landing, broken down by `dimension`. */
export function computeLandingToSignup(events: EventLike[], dimension: BreakdownDimension = "arm"): MetricValue[] {
  return computeRateMetric(
    "landing_to_signup",
    events,
    dimension,
    (d) => hasEventType(d, "acquisition_landing"),
    (d) => hasEventType(d, "signup"),
  );
}

/** Real devices attributed to each arm, from events — the "new users from
 * paid arms" a CAC calculation needs, independent of whatever the ad
 * platform itself reports (platform-reported installs can overcount —
 * spec's whole "closed loop" thesis is that this joins real app-side
 * signal against ad-platform spend, not trust the platform's own count). */
function realNewUsersByArm(events: EventLike[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== "acquisition_landing") continue;
    const arm = e.acquisition?.armKey ?? "unattributed";
    const set = seen.get(arm) ?? new Set<string>();
    set.add(e.deviceId);
    seen.set(arm, set);
  }
  const result = new Map<string, number>();
  for (const [arm, devices] of seen) result.set(arm, devices.size);
  return result;
}

/** paid spend / new users from paid arms — arm-level, then summed for the
 * blended paid figure. Only arms whose channel resolves paid (via the
 * events' own `acquisition.channel`, not guessed from the arm string). */
export function computeCacPaid(rows: SpendIngestRow[], events: EventLike[]): MetricValue {
  const channelByArm = new Map<string, string>();
  for (const e of events) {
    if (e.type === "acquisition_landing" && e.acquisition?.armKey && e.acquisition.channel) {
      channelByArm.set(e.acquisition.armKey, e.acquisition.channel);
    }
  }
  const newUsersByArm = realNewUsersByArm(events);
  let totalPaidSpend = 0;
  let totalPaidUsers = 0;
  for (const row of rows) {
    if (!PAID_CHANNELS.has(channelByArm.get(row.armId) ?? "")) continue;
    totalPaidSpend += row.spendUsd;
  }
  for (const [arm, count] of newUsersByArm) {
    if (PAID_CHANNELS.has(channelByArm.get(arm) ?? "")) totalPaidUsers += count;
  }
  return ratioMetric("cac_paid", "paid", totalPaidSpend, totalPaidUsers);
}

/** total acquisition spend / all new users (any channel). */
export function computeCacBlended(rows: SpendIngestRow[], events: EventLike[]): MetricValue {
  const totalSpend = sum(rows, "spendUsd");
  const newUsersByArm = realNewUsersByArm(events);
  const totalUsers = [...newUsersByArm.values()].reduce((a, b) => a + b, 0);
  return ratioMetric("cac_blended", "app", totalSpend, totalUsers);
}

/** new users from organic channels / all new users. */
export function computeOrganicShare(events: EventLike[]): MetricValue {
  const landings = events.filter((e) => e.type === "acquisition_landing");
  const uniqueDevices = new Map<string, string>(); // deviceId -> channel
  for (const e of landings) {
    if (!uniqueDevices.has(e.deviceId)) uniqueDevices.set(e.deviceId, e.acquisition?.channel ?? "unknown");
  }
  const total = uniqueDevices.size;
  const organic = [...uniqueDevices.values()].filter((c) => !PAID_CHANNELS.has(c)).length;
  return {
    metric: "organic_share",
    breakdown: {},
    value: total > 0 ? organic / total : null,
    n: total,
    ci: total > 0 ? wilsonScoreInterval(organic, total) : null,
    sufficientData: hasSufficientData(total),
  };
}

// ---------------------------------------------------------------------------
// Virality
// ---------------------------------------------------------------------------

/** users with >=1 referral_shared / active users, broken down. "Active"
 * matches the app's own `active_user` config elsewhere in this module set —
 * here approximated as "has any event at all" to keep this function
 * self-contained; `computeReferralRate` in engagement-aware call sites
 * should prefer passing only already-filtered active-user events if a
 * stricter definition is needed. */
export function computeReferralRate(events: EventLike[], dimension: BreakdownDimension = "app"): MetricValue[] {
  return computeRateMetric(
    "referral_rate",
    events,
    dimension,
    () => true,
    (d) => hasEventType(d, "referral_shared"),
  );
}

/** invites per user * invite acceptance rate. */
export function computeKFactor(events: EventLike[]): MetricValue {
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const devices = [...byDevice.keys()];
  const n = devices.length;
  if (n === 0) return { metric: "k_factor", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };

  let totalInvitesSent = 0;
  let totalInvitesAccepted = 0;
  for (const deviceEvents of byDevice.values()) {
    totalInvitesSent += countOfType(deviceEvents, "invite_sent");
    totalInvitesAccepted += countOfType(deviceEvents, "invite_accepted");
  }
  const invitesPerUser = totalInvitesSent / n;
  const acceptanceRate = totalInvitesSent > 0 ? totalInvitesAccepted / totalInvitesSent : 0;
  return {
    metric: "k_factor",
    breakdown: {},
    value: invitesPerUser * acceptanceRate,
    n,
    ci: null, // a product of two derived rates — no single-parameter CI form used here, disclosed not computed
    sufficientData: hasSufficientData(n) && totalInvitesSent > 0,
  };
}
