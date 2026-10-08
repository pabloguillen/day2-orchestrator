import { describe, expect, test } from "bun:test";
import { computeSpendBreakdown, renderBudgetSummary, type BudgetConfig, type SpendLedgerEntry, type SpendRequest } from "./spend-governance";

const config: BudgetConfig = { monthlyBudgetUsd: 200, periodStart: "2026-09-01T00:00:00.000Z", killSwitch: false };

function entry(r: Partial<SpendRequest>, allowed = true): SpendLedgerEntry {
  const request: SpendRequest = {
    id: r.id ?? `id-${Math.random()}`,
    category: r.category ?? "social_content",
    amountUsd: r.amountUsd ?? 10,
    description: "t",
    requestedAt: r.requestedAt ?? "2026-09-10T12:00:00.000Z",
  };
  return {
    timestamp: request.requestedAt,
    request,
    decision: allowed
      ? { allowed: true, reason: "ok", remainingMonthlyUsd: 0, remainingDailyUsd: null }
      : { allowed: false, reason: "no", remainingMonthlyUsd: 0, remainingDailyUsd: null },
  };
}

describe("computeSpendBreakdown", () => {
  const now = new Date("2026-09-10T18:00:00.000Z");

  test("agrees with renderBudgetSummary's spent figure and percentage", () => {
    const ledger = [entry({ amountUsd: 12.5 }), entry({ amountUsd: 30, category: "seo_content" })];
    const b = computeSpendBreakdown(config, ledger, now);
    expect(b.spentUsd).toBe(42.5);
    expect(b.pct).toBe(21);
    expect(b.remainingUsd).toBe(157.5);
    expect(renderBudgetSummary(config, ledger)).toContain("$42.50 of $200.00 used this month (21%)");
  });

  test("never counts denied requests or replayed ids as spend", () => {
    const ledger = [
      entry({ id: "a", amountUsd: 10 }),
      entry({ id: "a", amountUsd: 10 }),
      entry({ id: "b", amountUsd: 99 }, false),
    ];
    const b = computeSpendBreakdown(config, ledger, now);
    expect(b.spentUsd).toBe(10);
    expect(b.byDay.at(-1)).toEqual({ date: "2026-09-10", amountUsd: 10 });
  });

  test("excludes spend outside the current budget period from the monthly total", () => {
    const ledger = [entry({ amountUsd: 50, requestedAt: "2026-08-31T23:00:00.000Z" }), entry({ amountUsd: 5 })];
    expect(computeSpendBreakdown(config, ledger, now).spentUsd).toBe(5);
  });

  test("byCategory is sorted largest first", () => {
    const ledger = [entry({ amountUsd: 3, category: "aso" }), entry({ amountUsd: 20, category: "seo_content" })];
    expect(computeSpendBreakdown(config, ledger, now).byCategory.map((c) => c.category)).toEqual(["seo_content", "aso"]);
  });

  test("byDay is zero-filled, oldest first, ending today", () => {
    const ledger = [entry({ amountUsd: 7, requestedAt: "2026-09-08T09:00:00.000Z" })];
    const b = computeSpendBreakdown(config, ledger, now, 4);
    expect(b.byDay).toEqual([
      { date: "2026-09-07", amountUsd: 0 },
      { date: "2026-09-08", amountUsd: 7 },
      { date: "2026-09-09", amountUsd: 0 },
      { date: "2026-09-10", amountUsd: 0 },
    ]);
  });

  test("reports the kill switch and handles a zero budget without dividing by zero", () => {
    const b = computeSpendBreakdown({ ...config, monthlyBudgetUsd: 0, killSwitch: true }, [], now);
    expect(b.pct).toBe(0);
    expect(b.killSwitch).toBe(true);
    expect(b.remainingUsd).toBe(0);
  });
});
