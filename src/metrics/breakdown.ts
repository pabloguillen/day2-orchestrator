/**
 * Cohort/segment/variant resolution and grouping (docs/closed-loop-spec.md
 * §5). Pure — takes real events, returns real groupings, no I/O.
 */

import {
  BreakdownDimension,
  EventLike,
  ResolvedBreakdown,
  UNATTRIBUTED_ARM,
  UNKNOWN_BUCKET,
} from "./types";

/** ISO week, e.g. "2026-W40" — ISO 8601 week-numbering (Monday-start,
 * week 1 contains the year's first Thursday). Pure, deterministic given an
 * ISO date string. */
export function isoWeek(dateIso: string): string {
  const d = new Date(dateIso);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of this week decides the ISO year (ISO 8601 rule).
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/** Per-device resolved breakdown, computed once from that device's full
 * event history (not per-event) — spec §5: cohort/arm/channel come from
 * the device's real first touch, segment from the caller-supplied resolver
 * (per-user model, evaluated fresh, not a stale per-event stamp — see
 * `types.ts`'s `EventLike.segmentId` doc comment), variant/app_version/
 * platform from the device's most recent event that carries them. */
export function resolveDeviceBreakdown(deviceEvents: EventLike[]): ResolvedBreakdown {
  const sorted = [...deviceEvents].sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0];
  const armKey = first?.acquisition?.armKey;
  const channel = first?.acquisition?.channel ?? UNKNOWN_BUCKET;
  const arm = armKey ?? UNATTRIBUTED_ARM;
  const cohort = `${armKey ?? channel}@${first ? isoWeek(first.at) : UNKNOWN_BUCKET}`;

  // Latest non-undefined value for fields that can legitimately change
  // over a device's lifetime (app updates, segment re-classification,
  // an experiment assignment changing between runs).
  let segment: string | undefined;
  let appVersion: string | undefined;
  let platform: string | undefined;
  let variantEntries: Record<string, string> | undefined;
  for (const e of sorted) {
    if (e.segmentId) segment = e.segmentId;
    if (e.appVersion) appVersion = e.appVersion;
    if (e.platform) platform = e.platform;
    if (e.variants) variantEntries = e.variants;
  }

  // `variant` collapses to a single string for the breakdown dimension —
  // real multi-experiment devices report one variant string per active
  // experiment key, joined, so "which variant" stays answerable without a
  // second dimension per experiment. Empty when no experiment is active,
  // matching every other "(none)" default here (spec's own default state:
  // ACTIVE_EXPERIMENTS is empty today).
  const variant = variantEntries
    ? Object.entries(variantEntries)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(",")
    : UNKNOWN_BUCKET;

  return {
    app: "app",
    cohort,
    arm,
    channel,
    segment: segment ?? UNKNOWN_BUCKET,
    variant,
    app_version: appVersion ?? UNKNOWN_BUCKET,
    platform: platform ?? UNKNOWN_BUCKET,
  };
}

/** Resolves every device present across `events` in one pass. */
export function resolveAllDeviceBreakdowns(events: EventLike[]): Map<string, ResolvedBreakdown> {
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const result = new Map<string, ResolvedBreakdown>();
  for (const [deviceId, deviceEvents] of byDevice) {
    result.set(deviceId, resolveDeviceBreakdown(deviceEvents));
  }
  return result;
}

/** Groups a device-id set by one breakdown dimension's resolved value —
 * `dimension: "app"` always produces one bucket (`{app: [...all devices]}`),
 * matching "every metric is computable at grain app × day" (spec §4.1)
 * as the ungrouped default. */
export function groupDevicesByDimension(
  deviceIds: Iterable<string>,
  breakdowns: Map<string, ResolvedBreakdown>,
  dimension: BreakdownDimension,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const deviceId of deviceIds) {
    const resolved = breakdowns.get(deviceId);
    const key = resolved ? resolved[dimension] : UNKNOWN_BUCKET;
    const list = groups.get(key);
    if (list) list.push(deviceId);
    else groups.set(key, [deviceId]);
  }
  return groups;
}

/**
 * Pooling for sparse cohorts (spec §5: "arm -> channel x creative angle ->
 * channel -> app default. Each level up is marked as borrowed."). v1 only
 * has "channel" and "app" to fall back to within a single app's own data —
 * `armKey` already carries no separate "creative angle" dimension distinct
 * from itself in this codebase (`growth-allocator.ts`'s `armKey()` already
 * encodes format/channel/angle into one string), and cross-app priors
 * ("similar apps on the platform") are honestly unbuildable today: day2
 * powers exactly one real app (expense-buddy), same "not real multi-tenancy
 * yet" disclosure `growth-tools-config.ts`'s own `GrowthToolsConfig` already
 * makes. Returns the pooling level actually used, never silent. */
export type PooledCohort = { level: "arm" | "channel" | "app"; key: string; borrowed: boolean };

export function poolCohortIfSparse(
  armKey: string,
  channel: string,
  armDeviceCount: number,
  channelDeviceCount: number,
  minN: number,
): PooledCohort {
  if (armDeviceCount >= minN) return { level: "arm", key: armKey, borrowed: false };
  if (channelDeviceCount >= minN) return { level: "channel", key: channel, borrowed: true };
  return { level: "app", key: "app", borrowed: true };
}
