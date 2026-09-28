import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BudgetConfig, GrowthConfig, KpiGoal, SpendCategory } from "./spend-governance";

/**
 * Step 4 (self-distributing), Component 1 — plain-language authoring for
 * `.day2-budget.json`, the owner's one and only config surface in this
 * whole system (docs/step4-self-distributing-plan.md). Same split as
 * `autonomy-config.ts` vs `autonomy.ts`: this file is CRUD + rendering,
 * `spend-governance.ts` keeps the actual spend math untouched by any of it.
 *
 * Deliberately narrow, matching the corrected plan: the owner configures
 * budget, caps, KPI goals, and the website opt-in — nothing about which MCP
 * tools exist or how they're wired (that's `growth-tools-config.ts`, a
 * platform-level file the owner never sees, per COORDINATION.md W37's
 * disclosed correction).
 */

export const GROWTH_CONFIG_FILENAME = ".day2-budget.json";

function firstOfMonthUtc(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Safe-by-construction default: a monthly budget of $0 means `evaluateSpend`
 * denies everything on the monthly-total check, same "real infra, zero real
 * behavior change" precedent as `ACTIVE_EXPERIMENTS: []`/`bindings: []`
 * elsewhere in this stage. */
function defaultGrowthConfig(): GrowthConfig {
  return {
    budget: { monthlyBudgetUsd: 0, periodStart: firstOfMonthUtc(new Date()), killSwitch: false },
    kpiGoals: [],
    website: { enabled: false },
  };
}

function isValidGrowthConfig(value: unknown): value is GrowthConfig {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const b = o.budget as Record<string, unknown> | undefined;
  if (
    !b ||
    typeof b.monthlyBudgetUsd !== "number" ||
    typeof b.periodStart !== "string" ||
    typeof b.killSwitch !== "boolean"
  ) {
    return false;
  }
  if (!Array.isArray(o.kpiGoals)) return false;
  const w = o.website as Record<string, unknown> | undefined;
  if (!w || typeof w.enabled !== "boolean") return false;
  return true;
}

export function loadGrowthConfig(path: string): GrowthConfig {
  if (!existsSync(path)) return defaultGrowthConfig();
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but isn't valid JSON — fix or remove it by hand before using this tool.`);
  }
  if (!isValidGrowthConfig(parsed)) {
    throw new Error(`${path} exists but doesn't look like a valid budget config — refusing to guess or overwrite it.`);
  }
  return parsed;
}

export function saveGrowthConfig(path: string, config: GrowthConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function setMonthlyBudget(config: GrowthConfig, monthlyBudgetUsd: number): GrowthConfig {
  return { ...config, budget: { ...config.budget, monthlyBudgetUsd } };
}

export function setKillSwitch(config: GrowthConfig, killSwitch: boolean): GrowthConfig {
  return { ...config, budget: { ...config.budget, killSwitch } };
}

export function setDailyCap(config: GrowthConfig, dailyCapUsd: number | undefined): GrowthConfig {
  const budget: BudgetConfig = { ...config.budget };
  if (dailyCapUsd === undefined) delete budget.dailyCapUsd;
  else budget.dailyCapUsd = dailyCapUsd;
  return { ...config, budget };
}

export function setCategoryCap(config: GrowthConfig, category: SpendCategory, capUsd: number): GrowthConfig {
  return {
    ...config,
    budget: {
      ...config.budget,
      perCategoryCapUsd: { ...config.budget.perCategoryCapUsd, [category]: capUsd },
    },
  };
}

/** Adds a new KPI goal or replaces an existing one with the same metric. */
export function setKpiGoal(config: GrowthConfig, goal: KpiGoal): GrowthConfig {
  return { ...config, kpiGoals: [...config.kpiGoals.filter((g) => g.metric !== goal.metric), goal] };
}

export function removeKpiGoal(config: GrowthConfig, metric: string): GrowthConfig {
  return { ...config, kpiGoals: config.kpiGoals.filter((g) => g.metric !== metric) };
}

/** Component 7's owner opt-in — deliberately the one other lever the owner
 * has in this whole system, per the plan's own reasoning: a persistent,
 * visible artifact is a bigger commitment than a single post or ad, so it
 * doesn't default on just because budget exists. */
export function setWebsiteEnabled(config: GrowthConfig, enabled: boolean, templatePreference?: string): GrowthConfig {
  return {
    ...config,
    website: { enabled, ...(templatePreference ? { templatePreference } : {}) },
  };
}

/** Plain-language, read-only rendering of the config itself (not real
 * spend-to-date — that's `spend-governance.ts`'s `renderBudgetSummary`,
 * which needs a real ledger and is composed alongside this by the CLI). */
export function renderGrowthConfigSummary(config: GrowthConfig): string {
  const lines: string[] = [];
  lines.push(`Monthly budget: $${config.budget.monthlyBudgetUsd.toFixed(2)}, period starting ${config.budget.periodStart.slice(0, 10)}.`);
  lines.push(config.budget.killSwitch ? "Kill switch: ON — all growth spend is paused." : "Kill switch: off.");
  if (config.budget.dailyCapUsd !== undefined) {
    lines.push(`Daily cap: $${config.budget.dailyCapUsd.toFixed(2)}.`);
  }
  const categoryCaps = Object.entries(config.budget.perCategoryCapUsd ?? {});
  if (categoryCaps.length > 0) {
    lines.push("Per-category caps:");
    for (const [category, cap] of categoryCaps) {
      lines.push(`  - ${category}: $${(cap as number).toFixed(2)}`);
    }
  }
  lines.push(
    config.kpiGoals.length === 0
      ? "No KPI goals configured yet."
      : `KPI goals: ${config.kpiGoals.map((g) => `${g.metric} → ${g.target}${g.byDate ? ` by ${g.byDate}` : ""}`).join("; ")}.`,
  );
  lines.push(
    config.website.enabled
      ? `Marketing website: enabled${config.website.templatePreference ? ` (template preference: ${config.website.templatePreference})` : ""}.`
      : "Marketing website: not enabled.",
  );
  return lines.join("\n");
}
