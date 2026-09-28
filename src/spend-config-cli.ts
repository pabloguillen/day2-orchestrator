import { resolve } from "node:path";
import {
  GROWTH_CONFIG_FILENAME,
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
import { loadSpendLedger, renderBudgetSummary, type SpendCategory } from "./spend-governance";

/**
 * CLI for the app owner's one and only Step 4 config surface — budget,
 * caps, KPI goals, and the website opt-in (docs/step4-self-distributing-plan.md,
 * COORDINATION.md W37). Deliberately does NOT expose anything about MCP
 * tool bindings — that config is platform-level (`growth-tools-config.ts`),
 * never owner-facing, per this stage's own disclosed correction.
 *
 * Default mode (no mutating flag) is read-only: prints the current config
 * in plain language, plus real spend-to-date if a ledger file exists —
 * matching `autonomy-config-cli.ts`'s own read-by-default shape.
 *
 * Usage:
 *   bun run src/spend-config-cli.ts --repo <path>
 *   bun run src/spend-config-cli.ts --repo <path> --set-budget <amount>
 *   bun run src/spend-config-cli.ts --repo <path> --kill-switch <on|off>
 *   bun run src/spend-config-cli.ts --repo <path> --set-daily-cap <amount|off>
 *   bun run src/spend-config-cli.ts --repo <path> --set-category-cap <category> <amount>
 *   bun run src/spend-config-cli.ts --repo <path> --set-kpi-goal <metric> <target> [--by-date <date>]
 *   bun run src/spend-config-cli.ts --repo <path> --remove-kpi-goal <metric>
 *   bun run src/spend-config-cli.ts --repo <path> --website <on|off> [--template <preference>]
 *   [--ledger-file <path>] (default: day2-spend-ledger.jsonl, for the read-only spend summary)
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    setBudget: get("--set-budget"),
    killSwitch: get("--kill-switch"),
    setDailyCap: get("--set-daily-cap"),
    setCategoryCap: get("--set-category-cap"),
    categoryCapAmount: args.includes("--set-category-cap")
      ? args[args.indexOf("--set-category-cap") + 2]
      : undefined,
    setKpiGoal: get("--set-kpi-goal"),
    kpiGoalTarget: args.includes("--set-kpi-goal") ? args[args.indexOf("--set-kpi-goal") + 2] : undefined,
    byDate: get("--by-date"),
    removeKpiGoal: get("--remove-kpi-goal"),
    website: get("--website"),
    template: get("--template"),
    ledgerFile: get("--ledger-file"),
  };
}

function usage(): never {
  console.error(
    "Usage: bun run src/spend-config-cli.ts --repo <path>\n" +
      "         [--set-budget <amount>] [--kill-switch <on|off>]\n" +
      "         [--set-daily-cap <amount|off>]\n" +
      "         [--set-category-cap <category> <amount>]\n" +
      "         [--set-kpi-goal <metric> <target> [--by-date <date>]] [--remove-kpi-goal <metric>]\n" +
      "         [--website <on|off> [--template <preference>]]\n" +
      "         [--ledger-file <path>]\n\n" +
      "No mutating flag: prints the current config, plus real spend-to-date if a ledger exists (read-only).",
  );
  process.exit(1);
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo) usage();
  const configPath = resolve(opts.repo, GROWTH_CONFIG_FILENAME);
  let config = loadGrowthConfig(configPath);
  let mutated = false;

  if (opts.setBudget !== undefined) {
    const amount = Number(opts.setBudget);
    if (!Number.isFinite(amount) || amount < 0) usage();
    config = setMonthlyBudget(config, amount);
    mutated = true;
    console.log(`[day2-budget] Monthly budget set to $${amount.toFixed(2)}.`);
  }

  if (opts.killSwitch !== undefined) {
    if (opts.killSwitch !== "on" && opts.killSwitch !== "off") usage();
    config = setKillSwitch(config, opts.killSwitch === "on");
    mutated = true;
    console.log(
      opts.killSwitch === "on"
        ? "[day2-budget] Kill switch is now ON — all growth spend is paused."
        : "[day2-budget] Kill switch is now off.",
    );
  }

  if (opts.setDailyCap !== undefined) {
    if (opts.setDailyCap === "off") {
      config = setDailyCap(config, undefined);
      mutated = true;
      console.log("[day2-budget] Daily cap removed.");
    } else {
      const amount = Number(opts.setDailyCap);
      if (!Number.isFinite(amount) || amount < 0) usage();
      config = setDailyCap(config, amount);
      mutated = true;
      console.log(`[day2-budget] Daily cap set to $${amount.toFixed(2)}.`);
    }
  }

  if (opts.setCategoryCap !== undefined) {
    const amount = Number(opts.categoryCapAmount);
    if (!Number.isFinite(amount) || amount < 0) usage();
    config = setCategoryCap(config, opts.setCategoryCap as SpendCategory, amount);
    mutated = true;
    console.log(`[day2-budget] "${opts.setCategoryCap}" category cap set to $${amount.toFixed(2)}.`);
  }

  if (opts.setKpiGoal !== undefined) {
    const target = Number(opts.kpiGoalTarget);
    if (!Number.isFinite(target)) usage();
    config = setKpiGoal(config, { metric: opts.setKpiGoal, target, ...(opts.byDate ? { byDate: opts.byDate } : {}) });
    mutated = true;
    console.log(`[day2-budget] KPI goal "${opts.setKpiGoal}" → ${target}${opts.byDate ? ` by ${opts.byDate}` : ""} saved.`);
  }

  if (opts.removeKpiGoal !== undefined) {
    config = removeKpiGoal(config, opts.removeKpiGoal);
    mutated = true;
    console.log(`[day2-budget] KPI goal "${opts.removeKpiGoal}" removed.`);
  }

  if (opts.website !== undefined) {
    if (opts.website !== "on" && opts.website !== "off") usage();
    config = setWebsiteEnabled(config, opts.website === "on", opts.template);
    mutated = true;
    console.log(
      opts.website === "on"
        ? "[day2-budget] Marketing website enabled — day2 will generate a grounded preview once a website_generation tool binding is connected."
        : "[day2-budget] Marketing website disabled.",
    );
  }

  if (mutated) {
    saveGrowthConfig(configPath, config);
    return;
  }

  console.log(renderGrowthConfigSummary(config));
  const ledgerFile = opts.ledgerFile ?? "day2-spend-ledger.jsonl";
  const ledger = loadSpendLedger(ledgerFile);
  if (ledger.length > 0) {
    console.log("");
    console.log(renderBudgetSummary(config.budget, ledger));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-budget] Fatal error:", err);
    process.exit(1);
  });
}
