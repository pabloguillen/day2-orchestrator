import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGrowthConfig,
  removeKpiGoal,
  renderGrowthConfigSummary,
  saveGrowthConfig,
  setCategoryCap,
  setDailyCap,
  setKillSwitch,
  setKpiGoal,
  setMonthlyBudget,
  setWebsiteEnabled,
} from "./growth-config";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "day2-growth-config-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadGrowthConfig", () => {
  test("returns a safe default (zero budget, kill switch off, website disabled) when no file exists", () => {
    withTempDir((dir) => {
      const config = loadGrowthConfig(join(dir, ".day2-budget.json"));
      expect(config.budget.monthlyBudgetUsd).toBe(0);
      expect(config.budget.killSwitch).toBe(false);
      expect(config.kpiGoals).toEqual([]);
      expect(config.website.enabled).toBe(false);
    });
  });

  test("round-trips a saved config", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-budget.json");
      const original = setMonthlyBudget(loadGrowthConfig(path), 250);
      saveGrowthConfig(path, original);
      const reloaded = loadGrowthConfig(path);
      expect(reloaded).toEqual(original);
    });
  });

  test("throws rather than silently overwriting invalid JSON", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-budget.json");
      writeFileSync(path, "{ not valid json");
      expect(() => loadGrowthConfig(path)).toThrow();
    });
  });

  test("throws rather than guessing at a malformed-but-valid-JSON file", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-budget.json");
      writeFileSync(path, JSON.stringify({ notABudgetConfig: true }));
      expect(() => loadGrowthConfig(path)).toThrow();
    });
  });
});

describe("setters", () => {
  test("setMonthlyBudget / setKillSwitch / setDailyCap only touch what they say", () => {
    let config = loadGrowthConfig("/tmp/day2-growth-config-does-not-exist.json");
    config = setMonthlyBudget(config, 300);
    config = setKillSwitch(config, true);
    config = setDailyCap(config, 20);
    expect(config.budget.monthlyBudgetUsd).toBe(300);
    expect(config.budget.killSwitch).toBe(true);
    expect(config.budget.dailyCapUsd).toBe(20);

    config = setDailyCap(config, undefined);
    expect(config.budget.dailyCapUsd).toBeUndefined();
  });

  test("setCategoryCap merges into perCategoryCapUsd without clobbering other categories", () => {
    let config = loadGrowthConfig("/tmp/day2-growth-config-does-not-exist.json");
    config = setCategoryCap(config, "paid_ads", 50);
    config = setCategoryCap(config, "seo_content", 30);
    expect(config.budget.perCategoryCapUsd).toEqual({ paid_ads: 50, seo_content: 30 });
  });

  test("setKpiGoal adds a new goal or replaces an existing one by metric name", () => {
    let config = loadGrowthConfig("/tmp/day2-growth-config-does-not-exist.json");
    config = setKpiGoal(config, { metric: "activation_rate", target: 0.3 });
    config = setKpiGoal(config, { metric: "referrals", target: 10 });
    expect(config.kpiGoals).toHaveLength(2);

    config = setKpiGoal(config, { metric: "activation_rate", target: 0.5, byDate: "2026-12-31" });
    expect(config.kpiGoals).toHaveLength(2);
    expect(config.kpiGoals.find((g) => g.metric === "activation_rate")).toEqual({
      metric: "activation_rate",
      target: 0.5,
      byDate: "2026-12-31",
    });
  });

  test("removeKpiGoal removes only the named goal", () => {
    let config = loadGrowthConfig("/tmp/day2-growth-config-does-not-exist.json");
    config = setKpiGoal(config, { metric: "a", target: 1 });
    config = setKpiGoal(config, { metric: "b", target: 2 });
    config = removeKpiGoal(config, "a");
    expect(config.kpiGoals).toEqual([{ metric: "b", target: 2 }]);
  });

  test("setWebsiteEnabled toggles the owner opt-in and optional template preference", () => {
    let config = loadGrowthConfig("/tmp/day2-growth-config-does-not-exist.json");
    expect(config.website.enabled).toBe(false);
    config = setWebsiteEnabled(config, true, "minimal");
    expect(config.website).toEqual({ enabled: true, templatePreference: "minimal" });
    config = setWebsiteEnabled(config, false);
    expect(config.website).toEqual({ enabled: false });
  });
});

describe("renderGrowthConfigSummary", () => {
  test("plain-language, no jargon, reflects real config state", () => {
    let config = loadGrowthConfig("/tmp/day2-growth-config-does-not-exist.json");
    config = setMonthlyBudget(config, 200);
    config = setKpiGoal(config, { metric: "weekly_active_devices", target: 50, byDate: "2026-12-01" });
    config = setWebsiteEnabled(config, true);
    const summary = renderGrowthConfigSummary(config);
    expect(summary).toContain("$200.00");
    expect(summary).toContain("weekly_active_devices → 50 by 2026-12-01");
    expect(summary).toContain("Marketing website: enabled");
    expect(summary).toContain("Kill switch: off.");
  });

  test("flags the kill switch prominently when on", () => {
    let config = loadGrowthConfig("/tmp/day2-growth-config-does-not-exist.json");
    config = setKillSwitch(config, true);
    expect(renderGrowthConfigSummary(config)).toMatch(/kill switch: on/i);
  });
});
