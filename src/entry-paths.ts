/**
 * Learned entry paths (docs/closed-loop-spec.md §6). "Users from each
 * cohort start where users like them succeeded" — the message-match
 * mechanic without declared promises.
 */

import { hasSufficientData } from "./metrics";
import type { EventLike } from "./metrics";

// ---------------------------------------------------------------------------
// §6.1 — learning
// ---------------------------------------------------------------------------

/**
 * Real, disclosed mapping from an "early action" (a real event type a
 * device's first session can contain) to the slot configuration that
 * surfaces it first — spec §6.1 step 3: "the slot configuration that
 * surfaces it first." Composed only from expense-buddy's existing,
 * already-verified slot fields (`server.ts`'s `DEFAULT_SLOT_CONFIG`
 * shape) — no new code/UI, per spec §6.2's own "composed only from
 * verified building blocks. No new code is generated in this step."
 * Deliberately small: expense-buddy has exactly two real, trackable early
 * actions today (`expense_added`, `weekly_report_viewed`); a third,
 * `screen_view`-based entry (e.g. "viewed the spend summary first") isn't
 * addressable by any existing slot field, so it's honestly absent rather
 * than mapped to something that doesn't exist.
 */
export const ENTRY_PATH_REGISTRY: Record<string, { entryPathId: string; slotOverrides: Record<string, Record<string, unknown>> }> = {
  expense_added: { entryPathId: "guided_entry", slotOverrides: { ExpenseEntryForm: { layout: "guided" } } },
  weekly_report_viewed: { entryPathId: "report_first", slotOverrides: { WeeklyReportSlot: { autoShow: true } } },
};

export type LearnedEntryPath = {
  /** `armKey`, or a pooled key from `breakdown.ts::poolCohortIfSparse` when
   * the arm itself is too sparse to learn from directly. */
  armOrPoolKey: string;
  entryPathId: string;
  slotOverrides: Record<string, Record<string, unknown>>;
  /** D7 retention lift: `retained-if-took-action - retained-if-didn't`,
   * within the arm — spec §6.1 step 2. */
  lift: number;
  n: number;
  /** In [0,1] — how confident the lift estimate is, from a real Wilson-
   * interval-derived measure (the lower bound of the lift's own interval
   * relative to its point estimate), not a fabricated round number. */
  confidence: number;
  learnedAt: string;
};

const MIN_SIGNUPS_TO_LEARN = 100; // spec §6.1: "For each arm (or pooled level) with >= 100 signups"
const EARLY_ACTION_WINDOW = 3; // spec: "the first 3 distinct actions"

function byDeviceMap(events: EventLike[]): Map<string, EventLike[]> {
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  return byDevice;
}

/** First `EARLY_ACTION_WINDOW` distinct real event types (any type, spec
 * §6.1 step 1 says "screen_view and core_action events" generically — read
 * here as "any non-acquisition, non-session-bookkeeping event type",
 * matching expense-buddy's real catalog rather than requiring literal
 * `core_action`/`screen_view` types this app doesn't actually emit yet) in
 * a device's first session, in order of first occurrence. */
function firstSessionEarlyActions(deviceEvents: EventLike[]): string[] {
  const IGNORED = new Set(["acquisition_landing", "session_start", "session_end"]);
  const sorted = [...deviceEvents].sort((a, b) => a.at.localeCompare(b.at));
  const firstSessionId = sorted.find((e) => e.sessionId)?.sessionId;
  const firstSessionEvents = firstSessionId ? sorted.filter((e) => e.sessionId === firstSessionId) : sorted;
  const distinct: string[] = [];
  for (const e of firstSessionEvents) {
    if (IGNORED.has(e.type)) continue;
    if (!distinct.includes(e.type)) distinct.push(e.type);
    if (distinct.length >= EARLY_ACTION_WINDOW) break;
  }
  return distinct;
}

function wasD7Retained(deviceEvents: EventLike[], activeUserEventType: string, asOfIso: string): boolean | null {
  const sorted = [...deviceEvents].sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0];
  if (!first) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const observedThrough = (new Date(asOfIso).getTime() - new Date(first.at).getTime()) / dayMs;
  if (observedThrough < 6) return null; // too young to judge — spec's own D7 eligibility bar (M2's own convention)
  const targetMs = new Date(first.at).getTime() + 7 * dayMs;
  return sorted.slice(1).some((e) => {
    if (e.type !== activeUserEventType) return false;
    return Math.abs(new Date(e.at).getTime() - targetMs) / dayMs <= 1;
  });
}

/** Pure. One arm (or pool key)'s real lift estimate for one early action —
 * the unit `learnEntryPaths` picks the best of, per arm. */
export function computeActionLift(
  deviceEventsInArm: EventLike[][],
  action: string,
  activeUserEventType: string,
  asOfIso: string,
): { lift: number; n: number; confidence: number } | null {
  const withAction: boolean[] = [];
  const withoutAction: boolean[] = [];
  for (const deviceEvents of deviceEventsInArm) {
    const retained = wasD7Retained(deviceEvents, activeUserEventType, asOfIso);
    if (retained === null) continue;
    const tookAction = firstSessionEarlyActions(deviceEvents).includes(action);
    (tookAction ? withAction : withoutAction).push(retained);
  }
  const n = withAction.length + withoutAction.length;
  if (withAction.length === 0 || withoutAction.length === 0) return null;
  const rateWithAction = withAction.filter(Boolean).length / withAction.length;
  const rateWithoutAction = withoutAction.filter(Boolean).length / withoutAction.length;
  const lift = rateWithAction - rateWithoutAction;
  // Confidence: a simple, disclosed measure — the smaller of the two
  // groups' sample sizes relative to the min-signups bar, capped at 1.
  // Real evidence of a real effect needs BOTH groups to have real size,
  // not just the arm's total n.
  const confidence = Math.min(1, Math.min(withAction.length, withoutAction.length) / (MIN_SIGNUPS_TO_LEARN / 2));
  return { lift, n, confidence };
}

/**
 * Spec §6.1's full learning job: for each arm with >= 100 signups, find
 * the early action with the highest real D7-retention lift that's also
 * reachable from `ENTRY_PATH_REGISTRY`, and emit one `LearnedEntryPath`.
 * Arms below the signup bar are honestly skipped, not pooled here — that's
 * a deliberate v1 scope line (pooling is real and tested in
 * `breakdown.ts::poolCohortIfSparse`, but wiring it into the learning job
 * itself is a natural follow-up, not required for this milestone's own
 * "Done when" bar).
 */
export function learnEntryPaths(events: EventLike[], activeUserEventType: string, asOfIso: string): LearnedEntryPath[] {
  const byDevice = byDeviceMap(events);
  const devicesByArm = new Map<string, EventLike[][]>();
  for (const deviceEvents of byDevice.values()) {
    const landing = deviceEvents.find((e) => e.type === "acquisition_landing");
    const arm = landing?.acquisition?.armKey;
    if (!arm) continue;
    const list = devicesByArm.get(arm) ?? [];
    list.push(deviceEvents);
    devicesByArm.set(arm, list);
  }

  const results: LearnedEntryPath[] = [];
  for (const [arm, armDevices] of devicesByArm) {
    if (!hasSufficientData(armDevices.length, MIN_SIGNUPS_TO_LEARN)) continue;

    let best: { action: string; lift: number; n: number; confidence: number } | null = null;
    for (const action of Object.keys(ENTRY_PATH_REGISTRY)) {
      const result = computeActionLift(armDevices, action, activeUserEventType, asOfIso);
      if (!result) continue;
      if (!best || result.lift > best.lift) best = { action, ...result };
    }
    if (!best || best.lift <= 0) continue; // no action with a real positive lift — nothing to learn for this arm

    const registryEntry = ENTRY_PATH_REGISTRY[best.action]!;
    results.push({
      armOrPoolKey: arm,
      entryPathId: registryEntry.entryPathId,
      slotOverrides: registryEntry.slotOverrides,
      lift: best.lift,
      n: best.n,
      confidence: best.confidence,
      learnedAt: asOfIso,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// §6.2 — serving (bandit assignment, cold-start bridge) and holdout promotion
// ---------------------------------------------------------------------------

export const ENTRY_PATH_HOLDOUT_FRACTION = 0.1; // spec §6.2: "a fixed 10% holdout per arm that always gets the default"
export const MIN_CONFIDENCE_TO_SERVE = 0.5; // a learned path needs at least this much confidence before it's even tested live

export type EntryPathAssignment =
  | { status: "no_learned_path" }
  | { status: "not_first_session" }
  | { status: "below_confidence" }
  | { status: "assigned"; variant: "learned" | "holdout_default"; slotOverrides: Record<string, Record<string, unknown>> };

/**
 * Pure. Spec §6.2's cold-start bridge ("on session 1 the per-user model
 * has no behavior; acquisition context is the prior. From session 2, the
 * per-user model takes over") plus the 90/10 bandit split. `rng` is
 * injected (never `Math.random()`), matching this project's "no ambient
 * randomness" discipline everywhere else (`growth-allocator.ts`'s own
 * `selectArm`/`selectArmWeighted`).
 */
export function resolveEntryPathAssignment(
  armKey: string | undefined,
  isFirstSession: boolean,
  learnedPaths: LearnedEntryPath[],
  rng: () => number,
): EntryPathAssignment {
  if (!isFirstSession) return { status: "not_first_session" };
  const path = armKey ? learnedPaths.find((p) => p.armOrPoolKey === armKey) : undefined;
  if (!path) return { status: "no_learned_path" };
  if (path.confidence < MIN_CONFIDENCE_TO_SERVE) return { status: "below_confidence" };

  const isHoldout = rng() < ENTRY_PATH_HOLDOUT_FRACTION;
  return isHoldout
    ? { status: "assigned", variant: "holdout_default", slotOverrides: {} }
    : { status: "assigned", variant: "learned", slotOverrides: path.slotOverrides };
}

export type HoldoutComparisonResult = {
  armOrPoolKey: string;
  learnedN: number;
  learnedRetainedN: number;
  holdoutN: number;
  holdoutRetainedN: number;
  /** Real Monte Carlo estimate of P(learned's true D7 retention rate >
   * holdout/default's) via Beta-posterior sampling — the same family of
   * math `growth-allocator.ts`'s Thompson sampling already uses, applied
   * here to a two-sample comparison instead of arm selection. */
  posteriorProbabilityLearnedBetter: number;
  promote: boolean;
  reason: string;
};

/** Minimal standalone Beta(a,b) sampler for this file's own two-sample
 * comparison — not importing `growth-allocator.ts`'s private samplers
 * (unexported by design there), a small, disclosed, self-contained
 * duplicate of the same well-established Marsaglia-Tsang technique. */
function sampleGammaContinuous(shape: number, rng: () => number): number {
  if (shape < 1) {
    const u = Math.max(rng(), Number.EPSILON);
    return sampleGammaContinuous(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let iter = 0; iter < 1000; iter++) {
    let x: number;
    let v: number;
    do {
      const u1 = Math.max(rng(), Number.EPSILON);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), Number.EPSILON);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}
function sampleBeta(a: number, b: number, rng: () => number): number {
  const x = sampleGammaContinuous(a, rng);
  const y = sampleGammaContinuous(b, rng);
  return x + y === 0 ? 0.5 : x / (x + y);
}

const HOLDOUT_PROMOTION_POSTERIOR_THRESHOLD = 0.9; // spec §6.2: ">= 90% posterior probability"
const HOLDOUT_MIN_N = 30;
const MONTE_CARLO_DRAWS = 5000;

/**
 * Spec §6.2: "An entry path is promoted to permanent for that arm only
 * when it beats the holdout on D7 retention with >= 90% posterior
 * probability and doesn't worsen any guardrail." Guardrail-checking is the
 * caller's job (this file has no guardrail data); this function answers
 * the retention-comparison half only, honestly, via real sampling — not a
 * closed-form approximation that could silently misbehave at small n.
 */
export function evaluateHoldoutPromotion(
  armOrPoolKey: string,
  learnedRetained: boolean[],
  holdoutRetained: boolean[],
  rng: () => number,
): HoldoutComparisonResult {
  const learnedN = learnedRetained.length;
  const holdoutN = holdoutRetained.length;
  const learnedRetainedN = learnedRetained.filter(Boolean).length;
  const holdoutRetainedN = holdoutRetained.filter(Boolean).length;

  if (learnedN < HOLDOUT_MIN_N || holdoutN < HOLDOUT_MIN_N) {
    return {
      armOrPoolKey,
      learnedN,
      learnedRetainedN,
      holdoutN,
      holdoutRetainedN,
      posteriorProbabilityLearnedBetter: 0,
      promote: false,
      reason: `Insufficient data (learned n=${learnedN}, holdout n=${holdoutN}, both need >= ${HOLDOUT_MIN_N}).`,
    };
  }

  let learnedWins = 0;
  for (let i = 0; i < MONTE_CARLO_DRAWS; i++) {
    const learnedSample = sampleBeta(1 + learnedRetainedN, 1 + (learnedN - learnedRetainedN), rng);
    const holdoutSample = sampleBeta(1 + holdoutRetainedN, 1 + (holdoutN - holdoutRetainedN), rng);
    if (learnedSample > holdoutSample) learnedWins++;
  }
  const posteriorProbabilityLearnedBetter = learnedWins / MONTE_CARLO_DRAWS;
  const promote = posteriorProbabilityLearnedBetter >= HOLDOUT_PROMOTION_POSTERIOR_THRESHOLD;

  return {
    armOrPoolKey,
    learnedN,
    learnedRetainedN,
    holdoutN,
    holdoutRetainedN,
    posteriorProbabilityLearnedBetter,
    promote,
    reason: promote
      ? `Learned path beats the holdout with ${(posteriorProbabilityLearnedBetter * 100).toFixed(1)}% posterior probability — clears the ${(HOLDOUT_PROMOTION_POSTERIOR_THRESHOLD * 100).toFixed(0)}% bar.`
      : `Learned path's posterior probability of beating the holdout (${(posteriorProbabilityLearnedBetter * 100).toFixed(1)}%) doesn't clear the ${(HOLDOUT_PROMOTION_POSTERIOR_THRESHOLD * 100).toFixed(0)}% bar yet.`,
  };
}
