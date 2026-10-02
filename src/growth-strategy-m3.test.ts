/**
 * Closed-loop M3 additions to growth-strategy.ts (docs/closed-loop-spec.md
 * §9) — kept in a separate test file from growth-strategy.test.ts so W39's
 * own existing suite stays visibly untouched.
 */

import { describe, expect, test } from "bun:test";
import {
  deriveStageSignalsFromMetrics,
  evaluateCohortSpendUnlock,
  scoreProposalAgainstStageGoals,
  STAGE_GOALS,
} from "./growth-strategy";
import type { EventLike } from "./metrics";

describe("deriveStageSignalsFromMetrics", () => {
  test("computes real activeUsers/retentionSignal from real events via the metric layer", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" }, // first touch
      { type: "session_start", at: "2026-10-01T00:00:00.000Z", deviceId: "d1" }, // returns exactly day 30 -> D30 retained
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d2" }, // first touch, same cohort
      { type: "session_start", at: "2026-09-29T00:00:00.000Z", deviceId: "d2" }, // returns day 28 -> MAU-active but outside D30's +-1 day window, not retained
    ];
    // Both devices are exactly 30 days old as of this instant (real D30
    // eligibility) and both have a recent-enough event to stay MAU-active.
    const signals = deriveStageSignalsFromMetrics(events, "2026-10-01T00:00:00.000Z");
    expect(signals.activeUsers).toBe(2);
    expect(signals.retentionSignal).not.toBeNull();
  });

  test("an empty event stream reports zero active users and null retention, not a crash", () => {
    const signals = deriveStageSignalsFromMetrics([], "2026-10-05T00:00:00.000Z");
    expect(signals.activeUsers).toBe(0);
    expect(signals.retentionSignal).toBeNull();
  });
});

describe("STAGE_GOALS", () => {
  test("every stage has at least one target KPI and one guardrail", () => {
    for (const stage of ["launch", "traction", "growth", "scale"] as const) {
      expect(STAGE_GOALS[stage].targetKpis.length).toBeGreaterThan(0);
      expect(STAGE_GOALS[stage].guardrailKpis.length).toBeGreaterThan(0);
    }
  });
});

describe("scoreProposalAgainstStageGoals", () => {
  test("accepts a real improvement to a stage's target KPI with no guardrail regression", () => {
    const result = scoreProposalAgainstStageGoals({
      stage: "launch",
      targetKpiDeltas: { activation_rate: 0.05 },
      guardrailKpiDeltas: { crash_free_sessions: 0.01 },
    });
    expect(result.accepted).toBe(true);
  });

  test("rejects a proposal that doesn't touch any target KPI, even with clean guardrails", () => {
    const result = scoreProposalAgainstStageGoals({
      stage: "launch",
      targetKpiDeltas: {},
      guardrailKpiDeltas: {},
    });
    expect(result.accepted).toBe(false);
    expect(result.improvesTargetKpi).toBe(false);
  });

  test("rejects a proposal that improves the target KPI but regresses a guardrail beyond the 5% default tolerance", () => {
    const result = scoreProposalAgainstStageGoals({
      stage: "launch",
      targetKpiDeltas: { activation_rate: 0.1 },
      guardrailKpiDeltas: { crash_free_sessions: -0.08 }, // 8% worse, over the 5% bar
    });
    expect(result.accepted).toBe(false);
    expect(result.violatedGuardrails).toContain("crash_free_sessions");
  });

  test("a guardrail regression within tolerance doesn't block acceptance", () => {
    const result = scoreProposalAgainstStageGoals({
      stage: "launch",
      targetKpiDeltas: { activation_rate: 0.1 },
      guardrailKpiDeltas: { crash_free_sessions: -0.03 }, // within the 5% default tolerance
    });
    expect(result.accepted).toBe(true);
  });

  test("a guardrail with no supplied delta is never treated as a violation", () => {
    const result = scoreProposalAgainstStageGoals({
      stage: "launch",
      targetKpiDeltas: { activation_rate: 0.1 },
      guardrailKpiDeltas: {}, // error_rate untouched — not a violation
    });
    expect(result.accepted).toBe(true);
    expect(result.violatedGuardrails).toEqual([]);
  });

  test("a custom tolerance overrides the 5% default", () => {
    const result = scoreProposalAgainstStageGoals(
      { stage: "launch", targetKpiDeltas: { activation_rate: 0.1 }, guardrailKpiDeltas: { crash_free_sessions: -0.03 } },
      0.01, // stricter — 3% regression now exceeds it
    );
    expect(result.accepted).toBe(false);
  });
});

describe("evaluateCohortSpendUnlock", () => {
  test("launch stage never unlocks, regardless of how good cohort retention is (safety rail 1)", () => {
    const result = evaluateCohortSpendUnlock("launch", 0.9);
    expect(result.unlocked).toBe(false);
  });

  test("traction unlocks once a cohort clears the real 0.2 threshold (W39's own precedent)", () => {
    expect(evaluateCohortSpendUnlock("traction", 0.25).unlocked).toBe(true);
    expect(evaluateCohortSpendUnlock("traction", 0.15).unlocked).toBe(false);
  });

  test("no real retention data yet fails closed, never guessed as unlocked", () => {
    const result = evaluateCohortSpendUnlock("traction", null);
    expect(result.unlocked).toBe(false);
    expect(result.reason).toContain("No real retention data");
  });

  test("growth and scale use their own, higher thresholds", () => {
    expect(evaluateCohortSpendUnlock("growth", 0.22).unlocked).toBe(false);
    expect(evaluateCohortSpendUnlock("growth", 0.3).unlocked).toBe(true);
    expect(evaluateCohortSpendUnlock("scale", 0.28).unlocked).toBe(false);
    expect(evaluateCohortSpendUnlock("scale", 0.35).unlocked).toBe(true);
  });
});
