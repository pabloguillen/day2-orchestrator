import { describe, expect, test } from "bun:test";
import {
  computeActionLift,
  evaluateHoldoutPromotion,
  learnEntryPaths,
  resolveEntryPathAssignment,
  ENTRY_PATH_HOLDOUT_FRACTION,
} from "./entry-paths";
import type { EventLike } from "./metrics";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASOF = "2026-10-15T00:00:00.000Z";

/** Builds one device's real event history: lands via `arm`, takes
 * `earlyAction` (or not) in its first session, and — deterministically,
 * based on `retains` — returns for a real D7 active-user event. */
function buildDevice(
  deviceId: string,
  arm: string,
  earlyAction: string | null,
  retains: boolean,
  firstTouchIso: string,
): EventLike[] {
  const events: EventLike[] = [
    {
      type: "acquisition_landing",
      at: firstTouchIso,
      deviceId,
      sessionId: `s-${deviceId}-1`,
      acquisition: { channel: "paid_social", armKey: arm },
    },
    { type: "session_start", at: firstTouchIso, deviceId, sessionId: `s-${deviceId}-1` },
  ];
  if (earlyAction) {
    events.push({ type: earlyAction, at: firstTouchIso, deviceId, sessionId: `s-${deviceId}-1` });
  }
  if (retains) {
    const returnAt = new Date(new Date(firstTouchIso).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    events.push({ type: "session_start", at: returnAt, deviceId, sessionId: `s-${deviceId}-2` });
  }
  return events;
}

describe("computeActionLift", () => {
  test("a real, deliberately-planted lift is measured correctly", () => {
    const devices: EventLike[][] = [];
    // 60 devices that took the action: 45 retained (75%)
    for (let i = 0; i < 60; i++) {
      devices.push(buildDevice(`with-${i}`, "arm-a", "expense_added", i < 45, ASOF));
    }
    // 60 devices that didn't: 15 retained (25%)
    for (let i = 0; i < 60; i++) {
      devices.push(buildDevice(`without-${i}`, "arm-a", null, i < 15, ASOF));
    }
    const result = computeActionLift(devices, "expense_added", "session_start", "2026-10-25T00:00:00.000Z")!;
    expect(result.lift).toBeCloseTo(0.5, 5); // 0.75 - 0.25
    expect(result.n).toBe(120);
  });

  test("returns null when one side has zero devices — no lift is computable", () => {
    const devices = [buildDevice("d1", "arm-a", "expense_added", true, ASOF)];
    const result = computeActionLift(devices, "expense_added", "session_start", "2026-10-25T00:00:00.000Z");
    expect(result).toBeNull();
  });
});

describe("learnEntryPaths — the spec's own M4 'Done when' bar: two arms, two different learned paths", () => {
  test("arm A prefers expense_added, arm B prefers weekly_report_viewed — the learner picks correctly and differently per arm", () => {
    const events: EventLike[] = [];
    // Arm A: 120 devices. Those who add an expense retain far better.
    for (let i = 0; i < 60; i++) events.push(...buildDevice(`a-with-${i}`, "arm-a", "expense_added", i < 48, ASOF)); // 80%
    for (let i = 0; i < 60; i++) events.push(...buildDevice(`a-without-${i}`, "arm-a", "weekly_report_viewed", i < 12, ASOF)); // 20%
    // Arm B: 120 devices. Those who view the weekly report retain far better (the opposite preference).
    for (let i = 0; i < 60; i++) events.push(...buildDevice(`b-with-${i}`, "arm-b", "weekly_report_viewed", i < 48, ASOF)); // 80%
    for (let i = 0; i < 60; i++) events.push(...buildDevice(`b-without-${i}`, "arm-b", "expense_added", i < 12, ASOF)); // 20%

    const learned = learnEntryPaths(events, "session_start", "2026-10-25T00:00:00.000Z");
    const armA = learned.find((p) => p.armOrPoolKey === "arm-a")!;
    const armB = learned.find((p) => p.armOrPoolKey === "arm-b")!;

    expect(armA).toBeDefined();
    expect(armB).toBeDefined();
    expect(armA.entryPathId).toBe("guided_entry"); // expense_added's registered path
    expect(armB.entryPathId).toBe("report_first"); // weekly_report_viewed's registered path
    expect(armA.entryPathId).not.toBe(armB.entryPathId); // the core of the "Done when" bar: DIFFERENT paths per arm
    expect(armA.lift).toBeGreaterThan(0);
    expect(armB.lift).toBeGreaterThan(0);
  });

  test("an arm below the 100-signup bar is skipped entirely, not learned from a too-small sample", () => {
    const events: EventLike[] = [];
    for (let i = 0; i < 10; i++) events.push(...buildDevice(`small-${i}`, "arm-tiny", "expense_added", i < 8, ASOF));
    const learned = learnEntryPaths(events, "session_start", "2026-10-25T00:00:00.000Z");
    expect(learned.find((p) => p.armOrPoolKey === "arm-tiny")).toBeUndefined();
  });

  test("an arm with no real positive lift on any registered action learns nothing for it, rather than fabricating a path", () => {
    const events: EventLike[] = [];
    // 120 devices, retention identical regardless of early action — no real signal.
    for (let i = 0; i < 60; i++) events.push(...buildDevice(`flat-with-${i}`, "arm-flat", "expense_added", i < 30, ASOF));
    for (let i = 0; i < 60; i++) events.push(...buildDevice(`flat-without-${i}`, "arm-flat", null, i < 30, ASOF));
    const learned = learnEntryPaths(events, "session_start", "2026-10-25T00:00:00.000Z");
    expect(learned.find((p) => p.armOrPoolKey === "arm-flat")).toBeUndefined();
  });
});

describe("resolveEntryPathAssignment — cold-start bridge + bandit", () => {
  const learnedPaths = [
    { armOrPoolKey: "arm-a", entryPathId: "guided_entry", slotOverrides: { ExpenseEntryForm: { layout: "guided" } }, lift: 0.5, n: 120, confidence: 1, learnedAt: ASOF },
  ];

  test("only session 1 gets an entry-path override — the cold-start bridge", () => {
    const rng = mulberry32(1);
    expect(resolveEntryPathAssignment("arm-a", false, learnedPaths, rng).status).toBe("not_first_session");
  });

  test("no learned path for this device's arm -> no_learned_path", () => {
    const rng = mulberry32(1);
    expect(resolveEntryPathAssignment("arm-unknown", true, learnedPaths, rng).status).toBe("no_learned_path");
  });

  test("a real 10% holdout split over many draws", () => {
    const rng = mulberry32(42);
    let learnedCount = 0;
    let holdoutCount = 0;
    for (let i = 0; i < 2000; i++) {
      const result = resolveEntryPathAssignment("arm-a", true, learnedPaths, rng);
      if (result.status !== "assigned") throw new Error("expected assigned");
      if (result.variant === "learned") learnedCount++;
      else holdoutCount++;
    }
    const holdoutFraction = holdoutCount / (learnedCount + holdoutCount);
    expect(holdoutFraction).toBeGreaterThan(ENTRY_PATH_HOLDOUT_FRACTION - 0.03);
    expect(holdoutFraction).toBeLessThan(ENTRY_PATH_HOLDOUT_FRACTION + 0.03);
  });

  test("the learned variant carries the real slot overrides; holdout carries none", () => {
    const rng = mulberry32(7);
    let sawLearnedOverrides = false;
    let sawEmptyHoldout = false;
    for (let i = 0; i < 200; i++) {
      const result = resolveEntryPathAssignment("arm-a", true, learnedPaths, rng);
      if (result.status !== "assigned") continue;
      if (result.variant === "learned" && Object.keys(result.slotOverrides).length > 0) sawLearnedOverrides = true;
      if (result.variant === "holdout_default" && Object.keys(result.slotOverrides).length === 0) sawEmptyHoldout = true;
    }
    expect(sawLearnedOverrides).toBe(true);
    expect(sawEmptyHoldout).toBe(true);
  });

  test("below-confidence learned paths are never served", () => {
    const lowConfidence = [{ ...learnedPaths[0]!, confidence: 0.1 }];
    const rng = mulberry32(1);
    expect(resolveEntryPathAssignment("arm-a", true, lowConfidence, rng).status).toBe("below_confidence");
  });
});

describe("evaluateHoldoutPromotion — real Bayesian two-sample comparison", () => {
  test("a genuinely better learned group clears the 90% posterior bar and is reported (the M4 'Done when' holdout-comparison requirement)", () => {
    const rng = mulberry32(99);
    const learned = Array.from({ length: 100 }, (_, i) => i < 65); // 65% retained
    const holdout = Array.from({ length: 100 }, (_, i) => i < 35); // 35% retained — a real, large gap
    const result = evaluateHoldoutPromotion("arm-a", learned, holdout, rng);
    expect(result.posteriorProbabilityLearnedBetter).toBeGreaterThan(0.9);
    expect(result.promote).toBe(true);
  });

  test("two statistically indistinguishable groups do NOT get promoted", () => {
    const rng = mulberry32(5);
    const learned = Array.from({ length: 100 }, (_, i) => i < 50);
    const holdout = Array.from({ length: 100 }, (_, i) => i < 49);
    const result = evaluateHoldoutPromotion("arm-a", learned, holdout, rng);
    expect(result.promote).toBe(false);
  });

  test("insufficient n on either side reports not-promoted without even sampling", () => {
    const rng = mulberry32(1);
    const result = evaluateHoldoutPromotion("arm-a", [true, true], [false], rng);
    expect(result.promote).toBe(false);
    expect(result.reason).toContain("Insufficient data");
  });

  test("is deterministic given the same seeded rng", () => {
    const learned = Array.from({ length: 50 }, (_, i) => i < 30);
    const holdout = Array.from({ length: 50 }, (_, i) => i < 20);
    const r1 = evaluateHoldoutPromotion("arm-a", learned, holdout, mulberry32(123));
    const r2 = evaluateHoldoutPromotion("arm-a", learned, holdout, mulberry32(123));
    expect(r1.posteriorProbabilityLearnedBetter).toBe(r2.posteriorProbabilityLearnedBetter);
  });
});
