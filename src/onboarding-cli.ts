import { resolve } from "node:path";
import { renderAppProfilePlainLanguage, scanAppProfile } from "./onboarding";

/**
 * CLI entrypoint for the onboarding app-understanding scan (COORDINATION.md
 * W18). Read-only against --repo: never writes to the target repo, since
 * "confirm what the runtime learned" is a human-review step in the source
 * doc, not something that should silently persist state before the owner
 * has seen and corrected it.
 *
 * Not yet wired into package.json's `scripts` — orchestrator/package.json
 * had real uncommitted changes from another in-progress workstream (W17)
 * at the time this was built; adding a script entry there right now risked
 * clobbering that work. Invoke directly:
 *   bun run src/onboarding-cli.ts --repo <path> [--sentry-org <org> --sentry-project <project>]
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

async function main() {
  const { repo, sentryOrg, sentryProject } = parseArgs();
  if (!repo) {
    console.error(
      "Usage: bun run src/onboarding-cli.ts --repo <path> [--sentry-org <org> --sentry-project <project>]",
    );
    process.exit(1);
  }

  const repoPath = resolve(repo);
  const sentry = sentryOrg && sentryProject ? { org: sentryOrg, project: sentryProject } : undefined;

  const result = await scanAppProfile(repoPath, sentry);
  if (!result.ok) {
    console.error(`[day2-onboarding] Scan failed: ${result.reason}`);
    process.exit(1);
  }

  console.log(renderAppProfilePlainLanguage(result.profile));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-onboarding] Fatal error:", err);
    process.exit(1);
  });
}
