import { describe, expect, test } from "bun:test";
import type { AppProfile } from "./onboarding";
import type { BudgetConfig } from "./spend-governance";
import { deriveAppStage, deriveGrowthStrategy, renderGrowthStrategySummary } from "./growth-strategy";
import type { CompetitorAngleInsight, SocialTrendInsight } from "./growth-strategy";

function makeAppProfile(overrides: Partial<AppProfile> = {}): AppProfile {
  return {
    purpose: "Track personal expenses",
    targetUsers: "Budget-conscious individuals",
    featureMap: ["expense entry", "categorization"],
    styleGuide: null,
    toneOfVoice: "friendly",
    businessModel: null,
    caveats: [],
    competitors: null,
    currentState: null,
    currentStateCaveat: "not scanned",
    scannedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeBudget(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    monthlyBudgetUsd: 200,
    periodStart: "2026-09-01",
    killSwitch: false,
    ...overrides,
  };
}

describe("deriveAppStage", () => {
  test("below 100 active users is launch", () => {
    const { stage, basis } = deriveAppStage({ activeUsers: 0, retentionSignal: null });
    expect(stage).toBe("launch");
    expect(basis).toContain("0 active users");
  });

  test("99 active users is still launch (boundary)", () => {
    expect(deriveAppStage({ activeUsers: 99, retentionSignal: null }).stage).toBe("launch");
  });

  test("100 active users is traction (boundary)", () => {
    expect(deriveAppStage({ activeUsers: 100, retentionSignal: null }).stage).toBe("traction");
  });

  test("4999 active users is still traction (boundary)", () => {
    expect(deriveAppStage({ activeUsers: 4999, retentionSignal: null }).stage).toBe("traction");
  });

  test("5000 active users is growth (boundary)", () => {
    expect(deriveAppStage({ activeUsers: 5000, retentionSignal: null }).stage).toBe("growth");
  });

  test("basis names the real observed count, not a rounded/generic value", () => {
    const { basis } = deriveAppStage({ activeUsers: 250, retentionSignal: null });
    expect(basis).toContain("250");
  });
});

describe("deriveGrowthStrategy — launch stage lockout", () => {
  test("paid_ads is never allocated in launch stage regardless of budget size", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget({ monthlyBudgetUsd: 100_000 }),
      makeAppProfile(),
      { activeUsers: 5, retentionSignal: null },
      [],
    );
    expect(strategy.stage).toBe("launch");
    expect(strategy.paidAcquisitionUnlocked).toBe(false);
    expect(strategy.allocations.some((a) => a.channel === "paid_ads")).toBe(false);
    expect(strategy.allocations.every((a) => a.budgetUsd === 0)).toBe(true);
  });

  test("launch-stage unlockBasis cites safety rail 1 explicitly", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget(),
      makeAppProfile(),
      { activeUsers: 10, retentionSignal: 0.9 },
      [],
    );
    expect(strategy.unlockBasis).toMatch(/safety rail 1/i);
    expect(strategy.paidAcquisitionUnlocked).toBe(false);
  });
});

describe("deriveGrowthStrategy — traction stage retention gate", () => {
  test("paid_ads stays locked below the retention threshold even with active users in range", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget(),
      makeAppProfile(),
      { activeUsers: 500, retentionSignal: 0.05 },
      [],
    );
    expect(strategy.stage).toBe("traction");
    expect(strategy.paidAcquisitionUnlocked).toBe(false);
    expect(strategy.allocations.some((a) => a.channel === "paid_ads")).toBe(false);
  });

  test("paid_ads unlocks at/above the retention threshold", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget({ monthlyBudgetUsd: 1000 }),
      makeAppProfile(),
      { activeUsers: 500, retentionSignal: 0.2 },
      [],
    );
    expect(strategy.paidAcquisitionUnlocked).toBe(true);
    const paidAds = strategy.allocations.find((a) => a.channel === "paid_ads");
    expect(paidAds).toBeDefined();
    expect(paidAds!.budgetUsd).toBeGreaterThan(0);
  });

  test("null retention signal locks paid_ads and says so honestly (not treated as 0 or as unlocked)", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget(),
      makeAppProfile(),
      { activeUsers: 500, retentionSignal: null },
      [],
    );
    expect(strategy.paidAcquisitionUnlocked).toBe(false);
    expect(strategy.unlockBasis).toMatch(/not yet observable/i);
  });
});

describe("deriveGrowthStrategy — unverifiable LTV basis at growth/scale", () => {
  test("growth-stage paid_ads rationale flags LTV > CAC as unverifiable when businessModel is null", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget({ monthlyBudgetUsd: 5000 }),
      makeAppProfile({ businessModel: null }),
      { activeUsers: 6000, retentionSignal: 0.5 },
      [],
    );
    expect(strategy.stage).toBe("growth");
    const paidAds = strategy.allocations.find((a) => a.channel === "paid_ads");
    expect(paidAds!.rationale).toMatch(/UNVERIFIABLE/);
    expect(paidAds!.rationale).toMatch(/no billing\/payment\/pricing code/i);
  });

  test("growth-stage rationale still flags unverifiable even when onboarding recorded a business model", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget({ monthlyBudgetUsd: 5000 }),
      makeAppProfile({ businessModel: "freemium subscription" }),
      { activeUsers: 6000, retentionSignal: 0.5 },
      [],
    );
    const paidAds = strategy.allocations.find((a) => a.channel === "paid_ads");
    expect(paidAds!.rationale).toMatch(/UNVERIFIABLE/);
    expect(paidAds!.rationale).toContain("freemium subscription");
  });
});

describe("deriveGrowthStrategy — competitor and trend citation", () => {
  test("competitor angle insights are cited in competitorSignal, not silently dropped", () => {
    const angles: CompetitorAngleInsight[] = [
      {
        competitor: "YNAB",
        angle: "Zero-based budgeting onboarding flow",
        channel: "social_content",
        relevance: "expense-buddy has no equivalent onboarding hook",
        source: "https://ynab.com",
      },
    ];
    const strategy = deriveGrowthStrategy(
      makeBudget(),
      makeAppProfile(),
      { activeUsers: 10, retentionSignal: null },
      [],
      angles,
    );
    expect(strategy.competitorSignal).toContain("YNAB");
    expect(strategy.competitorSignal).toContain("Zero-based budgeting onboarding flow");
  });

  test("no competitor insights means competitorSignal is undefined, not an empty-string fabrication", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget(),
      makeAppProfile(),
      { activeUsers: 10, retentionSignal: null },
      [],
    );
    expect(strategy.competitorSignal).toBeUndefined();
  });

  test("social trend insights inform (are cited in) the traction-stage social_content rationale", () => {
    const trends: SocialTrendInsight[] = [
      {
        platform: "tiktok",
        trend: "budget-check-in duets",
        format: "short-form talking-head",
        relevance: "matches expense-buddy's daily-check-in feature",
      },
    ];
    const strategy = deriveGrowthStrategy(
      makeBudget({ monthlyBudgetUsd: 1000 }),
      makeAppProfile(),
      { activeUsers: 500, retentionSignal: 0.5 },
      [],
      [],
      trends,
    );
    const social = strategy.allocations.find((a) => a.channel === "social_content");
    expect(social!.rationale).toContain("tiktok/short-form talking-head");
  });
});

describe("deriveGrowthStrategy — output completeness", () => {
  test("kpiGoals pass through unmodified", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget(),
      makeAppProfile(),
      { activeUsers: 10, retentionSignal: null },
      [{ metric: "weekly_active_users", target: 50 }],
    );
    expect(strategy.kpiGoals).toEqual([{ metric: "weekly_active_users", target: 50 }]);
  });

  test("referral_loops is always present and always free across every stage", () => {
    for (const activeUsers of [5, 500, 6000]) {
      const strategy = deriveGrowthStrategy(
        makeBudget({ monthlyBudgetUsd: 1000 }),
        makeAppProfile(),
        { activeUsers, retentionSignal: 0.5 },
        [],
      );
      const referral = strategy.allocations.find((a) => a.channel === "referral_loops");
      expect(referral).toBeDefined();
      expect(referral!.budgetUsd).toBe(0);
    }
  });

  test("renderGrowthStrategySummary includes stage, lock status, and every allocation channel", () => {
    const strategy = deriveGrowthStrategy(
      makeBudget({ monthlyBudgetUsd: 100 }),
      makeAppProfile(),
      { activeUsers: 5, retentionSignal: null },
      [],
    );
    const summary = renderGrowthStrategySummary(strategy);
    expect(summary).toContain("Stage: launch");
    expect(summary).toContain("locked");
    for (const a of strategy.allocations) {
      expect(summary).toContain(a.channel);
    }
  });
});
