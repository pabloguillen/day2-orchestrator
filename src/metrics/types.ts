/**
 * Closed-loop M2 — the metric layer (docs/closed-loop-spec.md §4).
 * "One module owns all KPI definitions. Every loop reads from it."
 *
 * `EventLike` is structural, not imported from `expense-buddy` — same
 * cross-repo discipline `growth-execution.ts::StoredEventLike` established
 * in M1 (COORDINATION.md W47). Matches the real `StoredEvent` shape M1
 * actually produces: `acquisition`/`sessionId`/`platform` are optional
 * (pre-M1 events, or events this app can't attribute, still compute —
 * they just can't be broken down by arm/channel).
 */

export type EventLike = {
  type: string;
  at: string; // ISO 8601
  deviceId: string;
  metadata?: unknown;
  acquisition?: {
    channel?: string;
    armKey?: string;
    campaignId?: string;
    creativeId?: string;
  };
  /** Active config-plane assignments at the time of the event (spec §2.1's
   * `variants`), e.g. `{ entry_path: "invoice_first", exp_42: "B" }`. Not
   * produced anywhere yet as of M1 — every metric handles its absence the
   * same way it handles a device with no acquisition context: reported
   * under `variant: "(none)"`, never dropped. */
  variants?: Record<string, string>;
  /** Current per-user-model segment, if the caller resolved one. Computed
   * at query time by the caller (`resolveSegments`, see below) rather than
   * expected to be stamped on each event — the per-user model can change
   * after an event was recorded, so a stale per-event stamp would be
   * actively misleading for a "what segment is this device in *now*"
   * question, which is what every real use of `segment` in this spec
   * (adaptation targeting, evolution proposals) actually needs. */
  segmentId?: string;
  appVersion?: string;
  platform?: string;
};

/** Per-app metric config (spec §4.2) — set at onboarding, owner confirms or
 * edits. No config file/CLI built in this pass (out of M2's stated scope:
 * "orchestrator/src/metrics/ with per-app config, all KPIs, breakdowns, n
 * and confidence intervals, LTV v1" — the config *shape* is M2's job, an
 * owner-facing authoring surface is not, same split `growth-config.ts` vs.
 * `spend-governance.ts` already established for Step 4). */
export type AppMetricConfig = {
  coreActions: string[];
  activation: { event: string; count: number; withinHours: number };
  activeUser: { event: string; minCount: number };
  retentionWindowsDays: number[];
  paidEvent: string;
  currency: string;
};

/** Real default for expense-buddy, grounded in what actually exists today
 * (docs/step2-self-adapting-spec.md §2, `server.ts`'s real event catalog) —
 * not a generic placeholder. `paidEvent` stays the spec's own default
 * (`subscription_started`) even though expense-buddy has no billing code
 * (`growth-strategy.ts`'s own `unlockBasis` honesty precedent) — every
 * monetization KPI below reports `n: 0`, not a fabricated value, until
 * real payment events exist. */
export const DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG: AppMetricConfig = {
  coreActions: ["expense_added"],
  activation: { event: "expense_added", count: 1, withinHours: 24 },
  activeUser: { event: "session_start", minCount: 1 },
  retentionWindowsDays: [1, 7, 30],
  paidEvent: "subscription_started",
  currency: "USD",
};

export const BREAKDOWN_DIMENSIONS = [
  "app",
  "cohort",
  "arm",
  "channel",
  "segment",
  "variant",
  "app_version",
  "platform",
] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

/** One resolved breakdown key per event — computed once per event by
 * `resolveBreakdownKeys` (breakdown.ts), then every KPI groups by whichever
 * dimension it's asked to break down by. `cohort` combines arm/channel with
 * signup week (spec §5) so it's computed, not read off the event directly. */
export type ResolvedBreakdown = {
  app: "app"; // constant — the ungrouped, whole-app bucket
  cohort: string;
  arm: string;
  channel: string;
  segment: string;
  variant: string;
  app_version: string;
  platform: string;
};

export const UNKNOWN_BUCKET = "(none)";
export const UNATTRIBUTED_ARM = "unattributed";

/** Spec §5: "a metric breakdown is reported as 'insufficient data' below
 * n = 30 users." Applied uniformly by every KPI function below — no metric
 * invents its own threshold. */
export const MIN_N_FOR_CONFIDENT_BREAKDOWN = 30;

/** A single metric value, always carrying its own sample size and (when
 * computable) a confidence interval — spec §4.1: "Metrics with small
 * samples return a value AND a confidence interval and n. Consumers must
 * respect n." `value: null` means genuinely no data (not zero — e.g. a
 * monetization KPI for an app with no payment events yet is `null`, not
 * `0`, matching `growth-strategy.ts`'s own null-vs-zero retention-signal
 * precedent). */
export type MetricValue = {
  metric: string;
  breakdown: Partial<Record<BreakdownDimension, string>>;
  value: number | null;
  n: number;
  ci: [number, number] | null;
  /** True once `n` clears `MIN_N_FOR_CONFIDENT_BREAKDOWN` for this specific
   * breakdown bucket — callers (the diagnosis router, M3) must check this
   * before treating the value as decision-grade, not just check `value !== null`. */
  sufficientData: boolean;
};

export type MetricInputs = {
  events: EventLike[];
  config: AppMetricConfig;
  /** ISO date the computation is "as of" — injected, never `new Date()`
   * (this project's own established discipline: pure functions take time
   * as a parameter, callers stamp it). */
  asOfIso: string;
};
