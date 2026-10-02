import { describe, expect, test } from "bun:test";
import {
  computeChangeSuccessRate,
  computeComputeCostPerActiveUser,
  computeOwnerUndoRate,
  computeProposalApprovalRate,
  computeRollbackRate,
  type AutoAppliedChangeRecord,
  type ProposalRecord,
  type ReleaseRecord,
} from "./day2-kpis";

describe("computeChangeSuccessRate", () => {
  const asOf = "2026-09-30T00:00:00.000Z";

  test("only judges releases old enough (>=30 days) to have proven themselves", () => {
    const releases: ReleaseRecord[] = [
      { shippedAt: "2026-08-01T00:00:00.000Z", rolledBack: false }, // 60 days old — eligible, still live
      { shippedAt: "2026-08-15T00:00:00.000Z", rolledBack: true }, // 46 days old — eligible, rolled back
      { shippedAt: "2026-09-25T00:00:00.000Z", rolledBack: false }, // 5 days old — too new to judge
    ];
    const result = computeChangeSuccessRate(releases, asOf);
    expect(result.n).toBe(2); // the 5-day-old release excluded
    expect(result.value).toBeCloseTo(0.5, 5);
  });
});

describe("computeRollbackRate", () => {
  test("counts every release regardless of age, unlike change success rate", () => {
    const releases: ReleaseRecord[] = [
      { shippedAt: "2026-09-29T00:00:00.000Z", rolledBack: true }, // 1 day old, still counts here
      { shippedAt: "2026-09-01T00:00:00.000Z", rolledBack: false },
    ];
    const result = computeRollbackRate(releases);
    expect(result.n).toBe(2);
    expect(result.value).toBeCloseTo(0.5, 5);
  });
});

describe("computeProposalApprovalRate", () => {
  test("excludes still-pending proposals from the denominator, doesn't count them as rejected", () => {
    const proposals: ProposalRecord[] = [
      { proposedAt: "t0", approved: true },
      { proposedAt: "t0", approved: false },
      { proposedAt: "t0", approved: null }, // still pending
    ];
    const result = computeProposalApprovalRate(proposals);
    expect(result.n).toBe(2);
    expect(result.value).toBeCloseTo(0.5, 5);
  });
});

describe("computeOwnerUndoRate", () => {
  test("real undos / auto-applied changes", () => {
    const changes: AutoAppliedChangeRecord[] = [
      { appliedAt: "t0", undone: true },
      { appliedAt: "t0", undone: false },
      { appliedAt: "t0", undone: false },
    ];
    const result = computeOwnerUndoRate(changes);
    expect(result.value).toBeCloseTo(1 / 3, 5);
  });
});

describe("computeComputeCostPerActiveUser", () => {
  test("real cost / MAU ratio", () => {
    const result = computeComputeCostPerActiveUser(50, 200);
    expect(result.value).toBeCloseTo(0.25, 5);
  });

  test("zero active users reports null, not a divide-by-zero artifact", () => {
    const result = computeComputeCostPerActiveUser(50, 0);
    expect(result.value).toBeNull();
  });
});
