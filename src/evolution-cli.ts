import { resolve } from "node:path";
import { researchCompetitorFeatures } from "./competitor-feed";
import { proposeFeature } from "./evolution";
import { listProposals, listRejections, recordProposal, recordRejection, renderProposalCard } from "./proposals";

/**
 * CLI for the evolution engine's proposal generator (COORDINATION.md W32).
 *
 * Usage:
 *   bun run src/evolution-cli.ts --list [--proposals-file path]
 *   bun run src/evolution-cli.ts --app-url <url> --device-ids a,b,c
 *     [--research-competitors <category>] [--proposals-file path] [--rejections-file path]
 *   bun run src/evolution-cli.ts --reject "<title>" --reason "<why>" [--rejections-file path]
 *
 * `--list` (read-only) prints every previously recorded proposal. Running
 * against real device IDs never writes or ships code — a proposal, if any,
 * is only ever appended to the proposals file for a human to read later.
 *
 * `--reject` records a human's decision not to build a proposal, by exact
 * title — the memory that was previously entirely missing: without it,
 * nothing stopped the same idea from resurfacing every run the underlying
 * usage pattern was still present in the data. A real run always loads
 * this file first and passes it through, both as a prompt instruction and
 * as a deterministic backstop in `proposeFeature` itself.
 *
 * `--research-competitors <category>` is opt-in and separate from the core
 * run (COORDINATION.md W33/docs/step3-self-evolving-plan.md) — it spends
 * real money on a real web-research pass every time, so it's never run
 * silently by default. When given, its insights are supporting context
 * only; the proposal (if any) must still be grounded in the real per-user
 * data `proposeFeature` fetches regardless.
 */

const DEFAULT_PROPOSALS_FILE = "day2-proposals.jsonl";
const DEFAULT_REJECTIONS_FILE = "day2-proposal-rejections.jsonl";

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
    rejectionsFile: get("--rejections-file"),
    researchCompetitors: get("--research-competitors"),
    reject: get("--reject"),
    reason: get("--reason"),
  };
}

async function main() {
  const { list, appUrl, deviceIds, proposalsFile, rejectionsFile, researchCompetitors, reject, reason } = parseArgs();
  const file = resolve(proposalsFile ?? DEFAULT_PROPOSALS_FILE);
  const rejectionsPath = resolve(rejectionsFile ?? DEFAULT_REJECTIONS_FILE);

  if (reject) {
    if (!reason) {
      console.error('Usage: bun run src/evolution-cli.ts --reject "<title>" --reason "<why>" [--rejections-file path]');
      process.exit(1);
    }
    recordRejection(rejectionsPath, reject, reason);
    console.log(`[day2-evolution] Recorded rejection of "${reject}" to ${rejectionsPath}. It will not be proposed again.`);
    return;
  }

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
      "Usage: bun run src/evolution-cli.ts --app-url <url> --device-ids a,b,c\n" +
        "         [--research-competitors <category>] [--proposals-file path]\n" +
        "       bun run src/evolution-cli.ts --list [--proposals-file path]",
    );
    process.exit(1);
  }

  let competitorInsights: Awaited<ReturnType<typeof researchCompetitorFeatures>> = [];
  if (researchCompetitors) {
    console.log(`[day2-evolution] Researching competitors in "${researchCompetitors}"...`);
    competitorInsights = await researchCompetitorFeatures(researchCompetitors);
    console.log(`[day2-evolution] Found ${competitorInsights.length} competitor insight(s).`);
  }

  const ids = deviceIds.split(",").map((id) => id.trim()).filter(Boolean);
  const rejections = listRejections(rejectionsPath);
  const result = await proposeFeature(appUrl, ids, competitorInsights, rejections);

  if (result.status === "no_proposal") {
    console.log("[day2-evolution] No proposal — the agent found nothing worth proposing in this data. Not a failure.");
    return;
  }
  if (result.status === "parse_failed") {
    console.error(`[day2-evolution] Could not produce a usable proposal: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  if (result.status === "already_rejected") {
    console.log(
      `[day2-evolution] Not surfacing "${result.proposal.title}" — a human already rejected this ` +
        `(${result.previousRejection.rejectedAt}): ${result.previousRejection.reason}`,
    );
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
