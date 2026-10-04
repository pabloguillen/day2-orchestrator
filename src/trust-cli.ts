import { resolve } from "node:path";
import { AUTONOMY_CONFIG_FILENAME, loadAutonomyConfig } from "./autonomy-config";
import { loadAuditEntries } from "./owner-feed";
import { computeTrackRecord, loadAutonomyOutcomes, proposeLevelUp } from "./trust";

/**
 * Read-only: "has any area earned more trust than it's configured for?" —
 * the plain-language surface for trust.ts's track-record computation.
 * Never writes `.day2-autonomy.json` itself; a suggestion here is something
 * for a human to act on via autonomy-config-cli.ts, same division of labor
 * autonomy-config-cli.ts already draws between previewing and applying.
 *
 * Usage:
 *   bun run src/trust-cli.ts --repo <path> [--audit-file <path>] [--outcome-file <path>]
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    auditFile: get("--audit-file") ?? "day2-autonomy-audit.jsonl",
    outcomeFile: get("--outcome-file") ?? "day2-autonomy-outcomes.jsonl",
  };
}

function main() {
  const opts = parseArgs();
  if (!opts.repo) {
    console.error("Usage: bun run src/trust-cli.ts --repo <path> [--audit-file <path>] [--outcome-file <path>]");
    process.exit(1);
  }

  const config = loadAutonomyConfig(resolve(opts.repo, AUTONOMY_CONFIG_FILENAME));
  const decisions = loadAuditEntries(opts.auditFile);
  const outcomes = loadAutonomyOutcomes(opts.outcomeFile);

  if (config.areas.length === 0) {
    console.log("No areas configured in .day2-autonomy.json — nothing to evaluate.");
    return;
  }

  const suggestions = config.areas
    .map((area) => proposeLevelUp(computeTrackRecord(decisions, outcomes, area.area), area.level))
    .filter((s) => s !== null);

  if (suggestions.length === 0) {
    console.log("No area's track record currently clears the bar for a level-up suggestion.");
    return;
  }

  for (const s of suggestions) {
    console.log(`[day2-trust] ${s!.area}: ${s!.reason}`);
  }
}

if (import.meta.main) {
  main();
}
