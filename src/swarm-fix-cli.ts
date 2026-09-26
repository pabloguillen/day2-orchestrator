import { resolve } from "node:path";
import { runPipeline } from "./pipeline";
import { swarmFailuresToBugReports } from "./sources/swarm";
import { runSwarm } from "./swarm";

/**
 * Closes the loop W13's own "not built" note flagged (COORDINATION.md
 * W17): runs swarm v1 against a preview URL, and feeds every failure
 * straight into the real healing pipeline (`runPipeline` — reproduce-first,
 * fix, independent-verify, PR) as its own `BugReport`, instead of a human
 * reading swarm output and hand-writing reports the way W15 did once.
 *
 * Deliberately a separate, explicitly-invoked CLI, not something
 * `canary-cli.ts` calls automatically on a `swarm_check_failed` — running
 * the actual healing pipeline costs real agent turns and money per finding
 * (see agent.ts's own per-run cost note), and turning a pre-release gate
 * into an unconditional cascade of paid pipeline runs is a choice an
 * operator should make deliberately, not something that happens by default
 * every time a canary release is blocked.
 *
 * Runs reports sequentially, not via Promise.all — bounds concurrent
 * agent/API load and keeps output readable, at the cost of wall-clock time
 * proportional to the number of failures (usually a handful).
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    sha: get("--sha"),
    previewUrl: get("--preview-url"),
    dryRun: args.includes("--dry-run"),
  };
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo || !opts.sha || !opts.previewUrl) {
    console.error(
      "Usage: bun run swarm-fix -- --repo <path> --sha <commit-under-test> " +
        "--preview-url <preview-url> [--dry-run]\n\n" +
        "Runs swarm v1 against --preview-url and feeds every failure into the real " +
        "healing pipeline as its own bug report. --dry-run runs the swarm and shows " +
        "what reports *would* be filed, without invoking the pipeline.",
    );
    process.exit(1);
  }

  const cwd = resolve(opts.repo);
  const stateFile = resolve(cwd, ".day2-processed.json");

  console.log(`[day2-swarm-fix] Running swarm v1 against ${opts.previewUrl}...`);
  const swarm = await runSwarm(opts.previewUrl);
  for (const r of swarm.results) {
    console.log(`[day2-swarm-fix]   ${r.persona}: ${r.passed ? "PASS" : "FAIL"} — ${r.summary}`);
  }

  const reports = swarmFailuresToBugReports(swarm.results, { sha: opts.sha, previewUrl: opts.previewUrl });
  if (reports.length === 0) {
    console.log("[day2-swarm-fix] Swarm found nothing to file — no bug reports generated.");
    return;
  }

  console.log(`[day2-swarm-fix] ${reports.length} failure(s) → ${reports.length} bug report(s).`);
  if (opts.dryRun) {
    console.log(JSON.stringify(reports, null, 2));
    console.log("[day2-swarm-fix] --dry-run: not invoking the healing pipeline.");
    return;
  }

  let anyFailed = false;
  for (const report of reports) {
    console.log(`[day2-swarm-fix] Filing: ${report.title}`);
    const result = await runPipeline(cwd, report, stateFile);
    console.log(`[day2-swarm-fix]   Result: ${JSON.stringify(result, null, 2)}`);
    if (result.status !== "pr_opened" && result.status !== "already_processed") {
      anyFailed = true;
    }
  }
  if (anyFailed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[day2-swarm-fix] Fatal error:", err);
  process.exit(1);
});
