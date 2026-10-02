import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Arm } from "./growth-allocator";
import {
  executeChannelAction,
  reconcileOutcomes,
  reconcileOutcomesIntoAllocator,
  type AcquisitionEvent,
  type ActivationEvent,
  type ChannelExecutionOptions,
  type GrowthActionRecordForReconciliation,
} from "./growth-execution";
import type { Creative } from "./growth-creative";
import type { ToolBinding } from "./growth-tools-config";
import type { BudgetConfig, SpendLedgerEntry, SpendRequest } from "./spend-governance";

const arm: Arm = { channel: "social_content", assetType: "text", formatTag: "text-post" };

const creative: Creative = {
  arm,
  segment: "all-users",
  headline: "Real headline",
  body: "Real body copy",
  claimsCheckedAgainst: ["expense-buddy is a free, local-only expense tracker"],
  costUsd: 0,
};

const truthfulClaims = { creative, truthful: true, issues: [] };
const notGeneric = { creative, readsAsGeneric: false, matchedPatterns: [], suggestion: "" };

const budget: BudgetConfig = { monthlyBudgetUsd: 200, periodStart: "2026-09-01T00:00:00.000Z", killSwitch: false };

function spendReq(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    id: "req-1",
    category: "social_content",
    amountUsd: 5,
    description: "test",
    requestedAt: "2026-09-05T10:00:00.000Z",
    ...overrides,
  };
}

function baseOptions(overrides: Partial<ChannelExecutionOptions> = {}): ChannelExecutionOptions {
  return {
    creative,
    claimsCheck: truthfulClaims,
    authenticityCheck: notGeneric,
    spendRequest: spendReq(),
    budget,
    ledger: [],
    consecutiveGenericFlags: 0,
    ...overrides,
  };
}

describe("executeChannelAction — ordering and gates", () => {
  test("blocks on an untruthful claims check before anything else, even with plenty of budget", async () => {
    const result = await executeChannelAction(
      baseOptions({ claimsCheck: { ...truthfulClaims, truthful: false, issues: ["overstates a feature"] } }),
    );
    expect(result.status).toBe("blocked_by_claims_check");
  });

  test("blocks on a fabricated testimonial identity even if truthful is otherwise true", async () => {
    const result = await executeChannelAction(
      baseOptions({ claimsCheck: { ...truthfulClaims, fabricatesTestimonialIdentity: true } }),
    );
    expect(result.status).toBe("blocked_by_claims_check");
  });

  test("a single generic flag does not block (safety rail 6: blocks on repeated, not first)", async () => {
    const result = await executeChannelAction(
      baseOptions({ authenticityCheck: { ...notGeneric, readsAsGeneric: true }, consecutiveGenericFlags: 0 }),
    );
    expect(result.status).not.toBe("blocked_by_authenticity_check");
  });

  test("a second consecutive generic flag blocks", async () => {
    const result = await executeChannelAction(
      baseOptions({ authenticityCheck: { ...notGeneric, readsAsGeneric: true }, consecutiveGenericFlags: 1 }),
    );
    expect(result.status).toBe("blocked_by_authenticity_check");
  });

  test("blocks with blocked_by_unconnected_account when a capability is required but no binding resolved", async () => {
    const result = await executeChannelAction(
      baseOptions({ requiredCapability: "ad_platform", toolBinding: undefined }),
    );
    expect(result).toEqual({ status: "blocked_by_unconnected_account", capability: "ad_platform" });
  });

  test("no capability required and no binding — organic action, not blocked", async () => {
    const result = await executeChannelAction(baseOptions({ requiredCapability: undefined, toolBinding: undefined }));
    expect(result.status).not.toBe("blocked_by_unconnected_account");
  });

  test("blocks with blocked_by_budget when the spend would exceed budget, carrying the real spendDecision", async () => {
    const result = await executeChannelAction(
      baseOptions({ spendRequest: spendReq({ amountUsd: 1000 }), budget: { ...budget, monthlyBudgetUsd: 10 } }),
    );
    expect(result.status).toBe("blocked_by_budget");
    if (result.status === "blocked_by_budget") {
      expect(result.spendDecision.allowed).toBe(false);
    }
  });

  test("real, already-committed spend in the ledger correctly reduces what a later action can spend", async () => {
    const ledger: SpendLedgerEntry[] = [
      {
        timestamp: "2026-09-05T09:00:00.000Z",
        request: spendReq({ id: "already-spent", amountUsd: 195 }),
        decision: { allowed: true, reason: "ok", remainingMonthlyUsd: 5, remainingDailyUsd: null },
      },
    ];
    const result = await executeChannelAction(baseOptions({ ledger, spendRequest: spendReq({ id: "req-2", amountUsd: 10 }) }));
    expect(result.status).toBe("blocked_by_budget");
  });

  test("blocks with blocked_by_tool_policy when the resolved binding has an always_deny policy", async () => {
    const binding: ToolBinding = {
      capability: "creative_generation",
      mcpServerName: "some-tool",
      serverConfig: { command: "some-tool-mcp" },
      allowedTools: ["generate"],
      toolPolicy: [{ name: "generate", permission_policy: "always_deny" }],
      enabled: true,
    };
    const result = await executeChannelAction(
      baseOptions({ requiredCapability: "creative_generation", toolBinding: binding }),
    );
    expect(result.status).toBe("blocked_by_tool_policy");
  });

  test("default (no allowLiveAction): simulated_stopped_before_live_action, carrying the real would-spend amount and target", async () => {
    const binding: ToolBinding = {
      capability: "creative_generation",
      mcpServerName: "tryholo",
      serverConfig: { command: "tryholo-mcp" },
      allowedTools: ["generate"],
      enabled: true,
    };
    const result = await executeChannelAction(
      baseOptions({ requiredCapability: "creative_generation", toolBinding: binding, spendRequest: spendReq({ amountUsd: 7.5 }) }),
    );
    expect(result).toMatchObject({ status: "simulated_stopped_before_live_action", wouldSpendUsd: 7.5, wouldPublishTo: "tryholo" });
  });

  test("organic action with no tool binding: simulated result names it explicitly as organic", async () => {
    const result = await executeChannelAction(baseOptions());
    expect(result).toMatchObject({ status: "simulated_stopped_before_live_action", wouldPublishTo: "(organic — no external tool)" });
  });

  test("allowLiveAction: true is a real, reachable code path but honestly reports nothing real is wired up yet", async () => {
    const result = await executeChannelAction(baseOptions({ allowLiveAction: true }));
    expect(result.status).toBe("execution_failed");
    if (result.status === "execution_failed") {
      expect(result.reason).toMatch(/not implemented/i);
    }
  });

  test("every gate before allowLiveAction still applies even when allowLiveAction is true", async () => {
    const result = await executeChannelAction(
      baseOptions({ allowLiveAction: true, claimsCheck: { ...truthfulClaims, truthful: false, issues: ["x"] } }),
    );
    expect(result.status).toBe("blocked_by_claims_check");
  });
});

describe("executeChannelAction — closed loop M5, armLaunchGate", () => {
  test("undefined armLaunchGate (the default — an already-cleared arm) never blocks anything new", async () => {
    const result = await executeChannelAction(baseOptions());
    expect(result.status).not.toBe("blocked_by_arm_launch_gate");
  });

  test("a real blocked armLaunchGate result blocks before spend is ever evaluated", async () => {
    const gateResult = {
      allowed: false as const,
      reason: "broken_path" as const,
      reachabilityVerdict: {
        reachedActivationWithinSteps: false,
        stepsToActivation: null,
        maxSteps: 10,
        errorsSeen: [],
        accessibilityIssues: [],
        isError: false,
        summary: "Did not reach activation within 10 steps.",
        costUsd: 0.02,
      },
    };
    const result = await executeChannelAction(baseOptions({ armLaunchGate: gateResult }));
    expect(result.status).toBe("blocked_by_arm_launch_gate");
    if (result.status !== "blocked_by_arm_launch_gate") throw new Error("unreachable");
    expect(result.gateResult).toBe(gateResult);
  });

  test("an allowed armLaunchGate result never blocks — real spend evaluation proceeds normally", async () => {
    const result = await executeChannelAction(baseOptions({ armLaunchGate: { allowed: true } }));
    expect(result.status).not.toBe("blocked_by_arm_launch_gate");
  });

  test("armLaunchGate is checked before budget — a blocked arm never even reaches evaluateSpend", async () => {
    const gateResult = {
      allowed: false as const,
      reason: "unsupported_claims" as const,
      claimsVerdict: truthfulClaims, // shape only matters for typing here
    };
    const tinyBudget: BudgetConfig = { monthlyBudgetUsd: 10000, periodStart: "2026-09-01T00:00:00.000Z", killSwitch: false };
    const result = await executeChannelAction(baseOptions({ armLaunchGate: gateResult, budget: tinyBudget }));
    expect(result.status).toBe("blocked_by_arm_launch_gate"); // not blocked_by_budget, even with a huge budget available
  });
});

const goodArm: Arm = { channel: "paid_ads", assetType: "video", videoFormat: "ugc", formatTag: "ugc-testimonial-video-ad" };

function record(overrides: Partial<GrowthActionRecordForReconciliation> = {}): GrowthActionRecordForReconciliation {
  return { creativeId: "creative-1", arm: goodArm, executionResult: "executed", spendRequested: 12, ...overrides };
}

describe("reconcileOutcomes — pure core", () => {
  const emptyState = { arms: [], updatedAt: "2026-09-01T00:00:00.000Z" };

  test("attributes a success when a real activation follows a real landing within the window", () => {
    const acquisition: AcquisitionEvent = { creativeId: "creative-1", armKey: "x", deviceId: "d1", landedAt: "2026-09-05T00:00:00.000Z" };
    const activation: ActivationEvent = { deviceId: "d1", occurredAt: "2026-09-06T00:00:00.000Z" };
    const result = reconcileOutcomes(emptyState, [record()], [acquisition], [activation]);
    expect(result.reconciledCreativeIds).toEqual(["creative-1"]);
    expect(result.state.arms).toHaveLength(1);
    expect(result.state.arms[0]).toMatchObject({ attempts: 1, successes: 1, spendUsd: 12 });
  });

  test("attributes a failure (no activation, or outside the window) without inventing a success", () => {
    const acquisition: AcquisitionEvent = { creativeId: "creative-1", armKey: "x", deviceId: "d1", landedAt: "2026-09-05T00:00:00.000Z" };
    const tooLate: ActivationEvent = { deviceId: "d1", occurredAt: "2026-10-01T00:00:00.000Z" }; // > 14 days later
    const result = reconcileOutcomes(emptyState, [record()], [acquisition], [tooLate]);
    expect(result.state.arms[0]).toMatchObject({ attempts: 1, successes: 0 });
  });

  test("activation for a different device doesn't count", () => {
    const acquisition: AcquisitionEvent = { creativeId: "creative-1", armKey: "x", deviceId: "d1", landedAt: "2026-09-05T00:00:00.000Z" };
    const otherDevice: ActivationEvent = { deviceId: "d2", occurredAt: "2026-09-06T00:00:00.000Z" };
    const result = reconcileOutcomes(emptyState, [record()], [acquisition], [otherDevice]);
    expect(result.state.arms[0]).toMatchObject({ successes: 0 });
  });

  test("skips a record with no real acquisition signal yet — leaves it for the next run, doesn't fabricate a failure", () => {
    const result = reconcileOutcomes(emptyState, [record()], [], []);
    expect(result.reconciledCreativeIds).toEqual([]);
    expect(result.state.arms).toEqual([]);
  });

  test("skips non-executed records entirely — a simulated action never ran, nothing real to reconcile", () => {
    const rec = record({ executionResult: "simulated_stopped_before_live_action" });
    const acquisition: AcquisitionEvent = { creativeId: "creative-1", armKey: "x", deviceId: "d1", landedAt: "2026-09-05T00:00:00.000Z" };
    const result = reconcileOutcomes(emptyState, [rec], [acquisition], []);
    expect(result.reconciledCreativeIds).toEqual([]);
    expect(result.state.arms).toEqual([]);
  });

  test("idempotent: a creativeId already in reconciledCreativeIds is never processed again, even with new matching events", () => {
    const stateWithHistory = { arms: [], updatedAt: "x", reconciledCreativeIds: ["creative-1"] };
    const acquisition: AcquisitionEvent = { creativeId: "creative-1", armKey: "x", deviceId: "d1", landedAt: "2026-09-05T00:00:00.000Z" };
    const activation: ActivationEvent = { deviceId: "d1", occurredAt: "2026-09-06T00:00:00.000Z" };
    const result = reconcileOutcomes(stateWithHistory, [record()], [acquisition], [activation]);
    expect(result.reconciledCreativeIds).toEqual([]);
    expect(result.state.arms).toEqual([]);
  });

  test("processes multiple distinct records independently, accumulating reconciledCreativeIds", () => {
    const recordB = record({ creativeId: "creative-2" });
    const acquisitionA: AcquisitionEvent = { creativeId: "creative-1", armKey: "x", deviceId: "d1", landedAt: "2026-09-05T00:00:00.000Z" };
    const acquisitionB: AcquisitionEvent = { creativeId: "creative-2", armKey: "x", deviceId: "d2", landedAt: "2026-09-05T00:00:00.000Z" };
    const result = reconcileOutcomes({ arms: [], updatedAt: "x" }, [record(), recordB], [acquisitionA, acquisitionB], []);
    expect(result.reconciledCreativeIds.sort()).toEqual(["creative-1", "creative-2"]);
  });
});

describe("reconcileOutcomesIntoAllocator — file wrapper", () => {
  test("round-trips through a real allocator state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-reconcile-"));
    try {
      const statePath = join(dir, "state.json");
      const acquisition: AcquisitionEvent = { creativeId: "creative-1", armKey: "x", deviceId: "d1", landedAt: "2026-09-05T00:00:00.000Z" };
      const activation: ActivationEvent = { deviceId: "d1", occurredAt: "2026-09-06T00:00:00.000Z" };
      const { state, reconciledCreativeIds } = reconcileOutcomesIntoAllocator([record()], statePath, [acquisition], [activation]);
      expect(reconciledCreativeIds).toEqual(["creative-1"]);
      expect(state.arms[0]).toMatchObject({ successes: 1, attempts: 1 });

      // A second run against the same file, same events — idempotent, real file re-read.
      const second = reconcileOutcomesIntoAllocator([record()], statePath, [acquisition], [activation]);
      expect(second.reconciledCreativeIds).toEqual([]);
      expect(second.state.arms).toHaveLength(1); // not double-recorded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
