import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { DEFAULT_AUTONOMY_CONFIG } from "./autonomy";
import { maybeAutoRelease } from "./release";
import type { AutonomyConfig, ChangeForAutonomy } from "./types";

/**
 * CLI entrypoint for `maybeAutoRelease()` — the autonomy-gated release path.
 * Exists because nothing currently calls it: `canary-cli.ts` only exposes
 * the unconditional `runCanaryRelease()`. This makes the gated path
 * invokable, but deliberately doesn't decide *when* it runs — no GitHub
 * Actions workflow, cron, or git hook triggers this. That's a hosting/
 * trigger decision left for the user (see COORDINATION.md W5). Until such a
 * trigger exists, this is invoked by hand, same as `canary` today.
 *
 * With no `.day2-autonomy.json` in the target repo, this always falls back
 * to `DEFAULT_AUTONOMY_CONFIG` (L2 everywhere), so `maybeAutoRelease` always
 * defers to a human — invoking this CLI is safe by default even before any
 * autonomy config exists.
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
    sourceId: get("--source-id"),
    filesChanged: get("--files-changed"),
    bugfix: args.includes("--bugfix"),
    verifierApproved: args.includes("--verifier-approved"),
    ciPassed: args.includes("--ci-passed"),
    sentryOrg: get("--sentry-org"),
    sentryProject: get("--sentry-project"),
    workerName: get("--worker-name"),
    canaryPercent: get("--canary-percent"),
    monitorMinutes: get("--monitor-minutes"),
    errorThreshold: get("--error-threshold"),
    auditFile: get("--audit-file"),
    dryRun: args.includes("--dry-run"),
  };
}

/** Derives the changed-files list from the commit itself when the caller
 * doesn't supply one — a merge trigger typically only knows the SHA, not
 * the diff. Read-only; requires the SHA to already exist in `repoPath`. */
export async function deriveFilesChanged(repoPath: string, sha: string): Promise<string[]> {
  const output = await $`git diff-tree --no-commit-id --name-only -r ${sha}`.cwd(repoPath).text();
  return output.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function loadAutonomyConfig(repoPath: string): AutonomyConfig {
  const configPath = resolve(repoPath, ".day2-autonomy.json");
  if (!existsSync(configPath)) return DEFAULT_AUTONOMY_CONFIG;
  const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  return parsed as AutonomyConfig;
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo || !opts.sha || !opts.sentryOrg || !opts.sentryProject || !opts.workerName) {
    console.error(
      "Usage: bun run auto-release -- --repo <path> --sha <merged-commit-sha> " +
        "--sentry-org <org> --sentry-project <project> --worker-name <cloudflare-worker-name> " +
        "[--source-id <id>] [--files-changed a.ts,b.ts] [--bugfix] [--verifier-approved] [--ci-passed] " +
        "[--canary-percent 5] [--monitor-minutes 15] [--error-threshold 0] [--audit-file path] [--dry-run]\n\n" +
        "Decision-only by default: with no .day2-autonomy.json in --repo, this always defers to a " +
        "human (L2) — see COORDINATION.md W5 for why nothing triggers this automatically yet.",
    );
    process.exit(1);
  }
  if (!process.env.SENTRY_AUTH_TOKEN) {
    console.error("SENTRY_AUTH_TOKEN must be set — the guardrail can't check for canary errors without it.");
    process.exit(1);
  }

  const repoPath = resolve(opts.repo);
  const filesChanged = opts.filesChanged
    ? opts.filesChanged.split(",").map((f) => f.trim()).filter(Boolean)
    : await deriveFilesChanged(repoPath, opts.sha);

  const change: ChangeForAutonomy = {
    sourceId: opts.sourceId ?? opts.sha,
    filesChanged,
    isBugfix: opts.bugfix,
    verifierApproved: opts.verifierApproved,
    ciPassed: opts.ciPassed,
  };

  const config = loadAutonomyConfig(repoPath);

  const { decision, result } = await maybeAutoRelease(
    change,
    {
      repoPath,
      sha: opts.sha,
      sentryOrg: opts.sentryOrg,
      sentryProject: opts.sentryProject,
      workerName: opts.workerName,
      canaryPercent: opts.canaryPercent ? Number(opts.canaryPercent) : undefined,
      monitorMinutes: opts.monitorMinutes ? Number(opts.monitorMinutes) : undefined,
      errorThreshold: opts.errorThreshold ? Number(opts.errorThreshold) : undefined,
      dryRun: opts.dryRun,
    },
    config,
    opts.auditFile ?? "day2-autonomy-audit.jsonl",
  );

  console.log(
    `[day2-auto-release] Decision: ${decision.autoShip ? "AUTO-SHIP" : "HUMAN REQUIRED"} ` +
      `(level ${decision.level}, area "${decision.area}")\n[day2-auto-release] ${decision.reason}`,
  );
  if (result) {
    console.log(`[day2-auto-release] Release result: ${JSON.stringify(result, null, 2)}`);
    if (result.status === "smoke_check_failed" || result.status === "rolled_back") {
      process.exitCode = 1;
    }
  }
}

// Guarded so importing this module for its exported helpers (e.g. from
// tests) doesn't also run the CLI — canary-cli.ts/index.ts don't need this
// guard since no test file imports them, but auto-release-cli.test.ts does.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-auto-release] Fatal error:", err);
    process.exit(1);
  });
}
