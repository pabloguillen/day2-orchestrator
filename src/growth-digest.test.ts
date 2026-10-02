import { describe, expect, test } from "bun:test";
import { renderDigest } from "./growth-digest";
import type { DigestData } from "./growth-digest";
import type { AuditEntry } from "./owner-feed";
import type { GrowthActionRecord } from "./growth-feed";

function emptyData(): DigestData {
  return { auditEntries: [], growthActions: [], proposals: [], pendingApprovals: [] };
}

const sampleAudit: AuditEntry = {
  timestamp: "2026-09-30T10:00:00.000Z",
  sourceId: "s1",
  area: "ui-fixes",
  filesChanged: ["a.ts"],
  level: "L3",
  autoShip: true,
  reason: "verified low-risk",
};

const sampleGrowthAction: GrowthActionRecord = {
  timestamp: "2026-09-30T10:00:00.000Z",
  creativeId: "c1",
  strategy: { stage: "traction", channel: "social_content" },
  arm: { channel: "social_content", assetType: "text", formatTag: "tip" },
  toolUsed: null,
  frequency: "weekly",
  spend: { requested: 12, allowed: true, runningMonthlyTotalUsd: 45, monthlyBudgetUsd: 200 },
  claimsCheck: { creative: { arm: { channel: "social_content", assetType: "text", formatTag: "tip" }, segment: "s", headline: "h", body: "b", claimsCheckedAgainst: [] }, truthful: true, issues: [] },
  authenticityCheck: { creative: { arm: { channel: "social_content", assetType: "text", formatTag: "tip" }, segment: "s", headline: "h", body: "b", claimsCheckedAgainst: [] }, readsAsGeneric: false, matchedPatterns: [], suggestion: "" },
  executionResult: "simulated_stopped_before_live_action",
};

describe("renderDigest", () => {
  test("a fully quiet period says so honestly", () => {
    const digest = renderDigest("expense-buddy", "daily", emptyData());
    expect(digest).toContain("Nothing happened today — quiet period.");
    expect(digest).toContain("No code changes today.");
    expect(digest).toContain("No growth actions today.");
  });

  test("weekly period uses 'this week' phrasing, not 'today'", () => {
    const digest = renderDigest("expense-buddy", "weekly", emptyData());
    expect(digest).toContain("this week");
    expect(digest).not.toContain("today");
  });

  test("counts auto-shipped vs needs-review correctly from real audit entries", () => {
    const digest = renderDigest("expense-buddy", "daily", {
      ...emptyData(),
      auditEntries: [sampleAudit, { ...sampleAudit, autoShip: false }],
    });
    expect(digest).toContain("2 changes today: 1 shipped automatically, 1 waiting on your review.");
  });

  test("singular phrasing for exactly one change", () => {
    const digest = renderDigest("expense-buddy", "daily", { ...emptyData(), auditEntries: [sampleAudit] });
    expect(digest).toContain("1 change today: 1 shipped automatically, 0 waiting on your review.");
  });

  test("sums real spend only from allowed requests, across executed/simulated/blocked counts", () => {
    const blocked: GrowthActionRecord = { ...sampleGrowthAction, executionResult: "blocked_by_budget", spend: { ...sampleGrowthAction.spend, allowed: false } };
    const executed: GrowthActionRecord = { ...sampleGrowthAction, executionResult: "executed", spend: { ...sampleGrowthAction.spend, requested: 8, allowed: true } };
    const digest = renderDigest("expense-buddy", "daily", {
      ...emptyData(),
      growthActions: [sampleGrowthAction, blocked, executed],
    });
    expect(digest).toContain("3 growth actions today ($20.00 spent): 1 real, 1 simulated, 1 blocked.");
  });

  test("mentions pending approvals only when there are real ones", () => {
    const withApprovals = renderDigest("expense-buddy", "daily", {
      ...emptyData(),
      pendingApprovals: [{ number: 1, title: "t", branch: "b", url: "u", whatHappened: "x", whatChanged: "y", evidence: "z", filesChanged: [], defaultAction: "auto-apply", defaultReason: "r" }],
    });
    expect(withApprovals).toContain("1 pending approval waiting on you.");
    expect(renderDigest("expense-buddy", "daily", emptyData())).not.toContain("pending approval");
  });

  test("includes the real app name in the header", () => {
    expect(renderDigest("my-real-app", "daily", emptyData())).toContain("*my-real-app — daily digest*");
  });
});
