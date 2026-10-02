/**
 * Quality + Satisfaction domains (docs/closed-loop-spec.md §4.3). Mixed
 * sources: crash-free sessions/error rate/latency/rage-clicks are event-
 * based (session-grained, via the envelope's `sessionId` — spec §2.1);
 * store rating/review sentiment/support tickets need ingest sources M1
 * didn't build (out of its stated "one ad platform + payments" scope) —
 * real, tested functions over a real structural input type, honestly
 * disclosed as having no live connection yet, same posture
 * `external-ingest.ts`'s named platform adapters already established.
 */

import { hasSufficientData, wilsonScoreInterval } from "./confidence";
import { EventLike, MetricValue } from "./types";

// ---------------------------------------------------------------------------
// Quality — session-grained, via envelope sessionId
// ---------------------------------------------------------------------------

function groupBySession(events: EventLike[]): Map<string, EventLike[]> {
  const bySession = new Map<string, EventLike[]>();
  for (const e of events) {
    if (!e.sessionId) continue; // pre-M1 or unattributed events can't join a session
    const list = bySession.get(e.sessionId);
    if (list) list.push(e);
    else bySession.set(e.sessionId, [e]);
  }
  return bySession;
}

/** sessions without a `crash` / sessions — only over events that actually
 * carry a `sessionId` (spec §2.1's envelope field, M1). `n` honestly
 * reflects how many real sessions could be identified, not total events. */
export function computeCrashFreeSessions(events: EventLike[]): MetricValue {
  const bySession = groupBySession(events);
  const total = bySession.size;
  if (total === 0) return { metric: "crash_free_sessions", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const crashFree = [...bySession.values()].filter((sessionEvents) => !sessionEvents.some((e) => e.type === "crash")).length;
  return {
    metric: "crash_free_sessions",
    breakdown: {},
    value: crashFree / total,
    n: total,
    ci: wilsonScoreInterval(crashFree, total),
    sufficientData: hasSufficientData(total),
  };
}

/** error events / sessions. */
export function computeErrorRate(events: EventLike[]): MetricValue {
  const bySession = groupBySession(events);
  const total = bySession.size;
  if (total === 0) return { metric: "error_rate", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const errorCount = events.filter((e) => e.type === "error" && e.sessionId).length;
  return {
    metric: "error_rate",
    breakdown: {},
    value: errorCount / total,
    n: total,
    ci: null, // errors-per-session can exceed 1 — not a bounded proportion, no Wilson CI applies
    sufficientData: hasSufficientData(total),
  };
}

/** p95 of a numeric field inside `perf_sample`'s metadata (e.g.
 * `{ metric: "load_time_ms", value: 812 }`) — `metricName` selects which
 * one. Pure percentile over real samples, nearest-rank method. */
export function computeP95(events: EventLike[], metricName: string): MetricValue {
  const samples = events
    .filter((e) => e.type === "perf_sample")
    .map((e) => (e.metadata as { metric?: string; value?: number } | null))
    .filter((m): m is { metric: string; value: number } => !!m && m.metric === metricName && typeof m.value === "number")
    .map((m) => m.value)
    .sort((a, b) => a - b);
  const n = samples.length;
  if (n === 0) return { metric: `p95:${metricName}`, breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const rank = Math.min(n - 1, Math.ceil(0.95 * n) - 1);
  return {
    metric: `p95:${metricName}`,
    breakdown: {},
    value: samples[rank]!,
    n,
    ci: null, // a percentile, not a mean or proportion — no CI form applied here
    sufficientData: hasSufficientData(n),
  };
}

/** A real, structured incident record — no live ingest source exists yet
 * (Sentry issues aren't piped into a structured stream anywhere in this
 * codebase today); this type is what such a source would need to produce. */
export type IncidentRecord = {
  detectedAt: string;
  fixedLiveAt: string | null;
  /** True if a pre-release gate (swarm v1, calibration, CI) would have
   * caught this before it shipped — false means it escaped every real gate
   * this project has built. */
  caughtByGate: boolean;
};

/** incidents after release not caught by gates / total incidents. */
export function computeEscapedDefects(incidents: IncidentRecord[]): MetricValue {
  const n = incidents.length;
  if (n === 0) return { metric: "escaped_defects", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const escaped = incidents.filter((i) => !i.caughtByGate).length;
  return {
    metric: "escaped_defects",
    breakdown: {},
    value: escaped / n,
    n,
    ci: wilsonScoreInterval(escaped, n),
    sufficientData: hasSufficientData(n),
  };
}

/** Mean hours from incident detection to a real fix going live — only over
 * incidents that actually have a `fixedLiveAt` (still-open incidents are
 * excluded from the mean, not treated as instant fixes). */
export function computeMeanTimeToFixHours(incidents: IncidentRecord[]): MetricValue {
  const durations = incidents
    .filter((i): i is IncidentRecord & { fixedLiveAt: string } => i.fixedLiveAt !== null)
    .map((i) => (new Date(i.fixedLiveAt).getTime() - new Date(i.detectedAt).getTime()) / (1000 * 60 * 60));
  const n = durations.length;
  if (n === 0) return { metric: "mean_time_to_fix_hours", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  return {
    metric: "mean_time_to_fix_hours",
    breakdown: {},
    value: durations.reduce((a, b) => a + b, 0) / n,
    n,
    ci: null,
    sufficientData: hasSufficientData(n),
  };
}

// ---------------------------------------------------------------------------
// Satisfaction
// ---------------------------------------------------------------------------

/** A real app-store review row — spec §2.3's "App stores | rating, review
 * count, review text". No live ingest adapter exists yet, same disclosed
 * gap as `IncidentRecord` above. */
export type ReviewRow = { at: string; rating: number; text?: string };

/** Rolling average over the last `windowDays` (default 30, per spec). */
export function computeStoreRating(reviews: ReviewRow[], asOfIso: string, windowDays = 30): MetricValue {
  const cutoff = new Date(asOfIso).getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = reviews.filter((r) => new Date(r.at).getTime() >= cutoff);
  const n = inWindow.length;
  if (n === 0) return { metric: "store_rating", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  return {
    metric: "store_rating",
    breakdown: {},
    value: inWindow.reduce((a, r) => a + r.rating, 0) / n,
    n,
    ci: null,
    sufficientData: hasSufficientData(n),
  };
}

/** Share of negative reviews (rating <= 2 of 5, the conventional cutoff),
 * last `windowDays`. */
export function computeReviewSentiment(reviews: ReviewRow[], asOfIso: string, windowDays = 30): MetricValue {
  const cutoff = new Date(asOfIso).getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = reviews.filter((r) => new Date(r.at).getTime() >= cutoff);
  const n = inWindow.length;
  if (n === 0) return { metric: "review_sentiment_negative_share", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const negative = inWindow.filter((r) => r.rating <= 2).length;
  return {
    metric: "review_sentiment_negative_share",
    breakdown: {},
    value: negative / n,
    n,
    ci: wilsonScoreInterval(negative, n),
    sufficientData: hasSufficientData(n),
  };
}

/** A real support-ticket row — spec §2.3's "Support tool (if connected) |
 * tickets, tags". No live ingest adapter exists yet. */
export type SupportTicketRow = { at: string; deviceOrUserId?: string; tags?: string[] };

export function computeTicketsPerActiveUser(tickets: SupportTicketRow[], activeUserCount: number): MetricValue {
  return {
    metric: "tickets_per_active_user",
    breakdown: {},
    value: activeUserCount > 0 ? tickets.length / activeUserCount : null,
    n: activeUserCount,
    ci: null,
    sufficientData: hasSufficientData(activeUserCount),
  };
}

/** rage_click events / sessions. */
export function computeRageClicksPerSession(events: EventLike[]): MetricValue {
  const bySession = groupBySession(events);
  const total = bySession.size;
  if (total === 0) return { metric: "rage_clicks_per_session", breakdown: {}, value: null, n: 0, ci: null, sufficientData: false };
  const rageClickCount = events.filter((e) => e.type === "rage_click" && e.sessionId).length;
  return {
    metric: "rage_clicks_per_session",
    breakdown: {},
    value: rageClickCount / total,
    n: total,
    ci: null,
    sufficientData: hasSufficientData(total),
  };
}
