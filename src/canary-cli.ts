import { resolve } from "node:path";
import { runCanaryRelease } from "./release";

/**
 * Explicit CLI entrypoint for the canary release path — deliberately
 * separate from `bun run fix` (the healing pipeline). Today's autonomy
 * level is L2 ("Prepare"), so this is always a human decision to invoke,
 * pointed at a commit the human already merged. See STAGE1.md.
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
    sentryOrg: get("--sentry-org"),
    sentryProject: get("--sentry-project"),
    workerName: get("--worker-name"),
    canaryPercent: get("--canary-percent"),
    monitorMinutes: get("--monitor-minutes"),
    errorThreshold: get("--error-threshold"),
    dryRun: args.includes("--dry-run"),
    skipSwarmCheck: args.includes("--skip-swarm-check"),
  };
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo || !opts.sha || !opts.sentryOrg || !opts.sentryProject || !opts.workerName) {
    console.error(
      "Usage: bun run canary -- --repo <path> --sha <merged-commit-sha> " +
        "--sentry-org <org> --sentry-project <project> --worker-name <cloudflare-worker-name> " +
        "[--canary-percent 5] [--monitor-minutes 15] [--error-threshold 0] [--dry-run] " +
        "[--skip-swarm-check]",
    );
    process.exit(1);
  }
  if (!process.env.SENTRY_AUTH_TOKEN) {
    console.error("SENTRY_AUTH_TOKEN must be set — the guardrail can't check for canary errors without it.");
    process.exit(1);
  }

  const result = await runCanaryRelease({
    repoPath: resolve(opts.repo),
    sha: opts.sha,
    sentryOrg: opts.sentryOrg,
    sentryProject: opts.sentryProject,
    workerName: opts.workerName,
    canaryPercent: opts.canaryPercent ? Number(opts.canaryPercent) : undefined,
    monitorMinutes: opts.monitorMinutes ? Number(opts.monitorMinutes) : undefined,
    errorThreshold: opts.errorThreshold ? Number(opts.errorThreshold) : undefined,
    dryRun: opts.dryRun,
    skipSwarmCheck: opts.skipSwarmCheck,
  });

  console.log(`[day2-release] Result: ${JSON.stringify(result, null, 2)}`);
  if (
    result.status === "smoke_check_failed" ||
    result.status === "swarm_check_failed" ||
    result.status === "rolled_back"
  ) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[day2-release] Fatal error:", err);
  process.exit(1);
});
