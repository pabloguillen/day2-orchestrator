import { resolve } from "node:path";
import { proposeFeature } from "./evolution";
import { listProposals, recordProposal, renderProposalCard } from "./proposals";

/**
 * CLI for the evolution engine's proposal generator (COORDINATION.md W32).
 *
 * Usage:
 *   bun run src/evolution-cli.ts --list [--proposals-file path]
 *   bun run src/evolution-cli.ts --app-url <url> --device-ids a,b,c [--proposals-file path]
 *
 * `--list` (read-only) prints every previously recorded proposal. Running
 * against real device IDs never writes or ships code — a proposal, if any,
 * is only ever appended to the proposals file for a human to read later.
 */

const DEFAULT_PROPOSALS_FILE = "day2-proposals.jsonl";

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    list: args.includes("--list"),
    appUrl: get("--app-url"),
    deviceIds: get("--device-ids"),
    proposalsFile: get("--proposals-file"),
  };
}

async function main() {
  const { list, appUrl, deviceIds, proposalsFile } = parseArgs();
  const file = resolve(proposalsFile ?? DEFAULT_PROPOSALS_FILE);

  if (list) {
    const proposals = listProposals(file);
    if (proposals.length === 0) {
      console.log("[day2-evolution] No proposals recorded yet.");
      return;
    }
    for (const p of proposals) {
      console.log(renderProposalCard(p));
      console.log("\n" + "=".repeat(60) + "\n");
    }
    return;
  }

  if (!appUrl || !deviceIds) {
    console.error(
      "Usage: bun run src/evolution-cli.ts --app-url <url> --device-ids a,b,c [--proposals-file path]\n" +
        "       bun run src/evolution-cli.ts --list [--proposals-file path]",
    );
    process.exit(1);
  }

  const ids = deviceIds.split(",").map((id) => id.trim()).filter(Boolean);
  const result = await proposeFeature(appUrl, ids);

  if (result.status === "no_proposal") {
    console.log("[day2-evolution] No proposal — the agent found nothing worth proposing in this data. Not a failure.");
    return;
  }
  if (result.status === "parse_failed") {
    console.error(`[day2-evolution] Could not produce a usable proposal: ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  recordProposal(file, result.proposal);
  console.log(renderProposalCard(result.proposal));
  console.log(`\n[day2-evolution] Recorded to ${file}. Not built, not shipped — a human decides what happens next.`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-evolution] Fatal error:", err);
    process.exit(1);
  });
}
