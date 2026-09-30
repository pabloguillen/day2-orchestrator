import { resolve } from "node:path";
import { scanAppProfile } from "./onboarding";
import {
  APP_PROFILE_FILENAME,
  PENDING_APP_PROFILE_FILENAME,
  assessDriftSignificance,
  diffAppProfiles,
  loadStoredAppProfile,
  writePendingAppProfile,
} from "./onboarding-rescan";

/**
 * CI-triggered drift detector (COORDINATION.md W46) — meant to run on the
 * same `pull_request: closed` (merged to main) event `auto-release.yml`
 * already listens for, so any change that lands via a normal PR (day2's
 * own, or an external tool's like Lovable, as long as it goes through
 * this repo's GitHub PR flow) gets checked for app-profile drift.
 *
 * Never overwrites the existing, human-reviewed `.day2-app-profile.json`
 * in place — writes any detected drift to `.day2-app-profile.pending.json`
 * instead, for a human to review and promote. Exits with code 0 always
 * (this is a detection signal, never a build failure) — drift is
 * surfaced via stdout and, when running in GitHub Actions,
 * `$GITHUB_STEP_SUMMARY`, not by failing the pipeline.
 *
 * Usage:
 *   bun run src/onboarding-rescan-cli.ts --repo <path> [--sentry-org <org> --sentry-project <project>]
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    sentryOrg: get("--sentry-org"),
    sentryProject: get("--sentry-project"),
  };
}

function usage(): never {
  console.error("Usage: bun run src/onboarding-rescan-cli.ts --repo <path> [--sentry-org <org> --sentry-project <project>]");
  process.exit(1);
}

async function main() {
  const { repo, sentryOrg, sentryProject } = parseArgs();
  if (!repo) usage();

  const repoPath = resolve(repo);
  const sentry = sentryOrg && sentryProject ? { org: sentryOrg, project: sentryProject } : undefined;

  const result = await scanAppProfile(repoPath, sentry);
  if (!result.ok) {
    console.log(`[day2-rescan] Scan failed, nothing to compare: ${result.reason}`);
    return;
  }

  const existingPath = resolve(repoPath, APP_PROFILE_FILENAME);
  const existing = loadStoredAppProfile(existingPath);
  const diffs = diffAppProfiles(existing, result.profile);

  if (diffs.length === 0) {
    console.log("[day2-rescan] No drift detected — app profile still matches the last reviewed scan.");
    return;
  }

  // A null `existing` means "no prior reviewed scan at all" — diffAppProfiles
  // already reports that as its own single diff line; nothing to judge as
  // "just rewording" since there's no prior version to compare wording against,
  // so skip straight to surfacing it rather than calling the significance agent.
  if (existing !== null) {
    const significance = await assessDriftSignificance(diffs, existing, result.profile);
    if (!significance.significant) {
      console.log(
        `[day2-rescan] Raw wording differences found but judged non-substantive — no pending file written.\n` +
          `Reasoning: ${significance.reasoning}`,
      );
      return;
    }
  }

  const pendingPath = resolve(repoPath, PENDING_APP_PROFILE_FILENAME);
  writePendingAppProfile(pendingPath, result.profile);

  const summary = [
    "## day2 app-profile drift detected",
    "",
    "A re-scan found real differences from the last reviewed app profile. Written to " +
      `\`${PENDING_APP_PROFILE_FILENAME}\` for review — the existing, reviewed profile was ` +
      "**not** overwritten automatically.",
    "",
    ...diffs.map((d) => `- ${d}`),
  ].join("\n");

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-rescan] Fatal error:", err);
    process.exit(1);
  });
}
