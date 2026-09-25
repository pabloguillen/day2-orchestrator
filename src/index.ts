import { resolve } from "node:path";
import { runPipeline } from "./pipeline";
import { fetchLatestUnresolvedIssue } from "./sources/sentry";
import { loadManualReport } from "./sources/manual";
import type { BugReport } from "./types";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    manualReportFile: get("--manual-report"),
    sentryOrg: get("--sentry-org"),
    sentryProject: get("--sentry-project"),
  };
}

async function main() {
  const { repo, manualReportFile, sentryOrg, sentryProject } = parseArgs();

  if (!repo) {
    console.error("Usage: bun run fix --repo <path> (--manual-report <file> | --sentry-org <org> --sentry-project <project>)");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "[day2] No ANTHROPIC_API_KEY set — falling back to the local Claude Code login " +
        "(Max subscription). Fine for manual/low-volume runs like this one; switch to a " +
        "metered API key before this runs unattended on a schedule — see README.md.",
    );
  }

  const cwd = resolve(repo);
  const stateFile = resolve(cwd, ".day2-processed.json");

  let report: BugReport | null = null;
  if (manualReportFile) {
    report = loadManualReport(resolve(manualReportFile));
  } else if (sentryOrg && sentryProject) {
    report = await fetchLatestUnresolvedIssue(sentryOrg, sentryProject);
  } else {
    console.error("Provide either --manual-report <file> or --sentry-org + --sentry-project.");
    process.exit(1);
  }

  if (!report) {
    console.log("[day2] No signal to act on.");
    return;
  }

  const result = await runPipeline(cwd, report, stateFile);
  console.log(`[day2] Result: ${JSON.stringify(result, null, 2)}`);

  if (result.status !== "pr_opened" && result.status !== "already_processed") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[day2] Fatal error:", err);
  process.exit(1);
});
