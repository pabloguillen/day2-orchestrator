import { dirname, resolve } from "node:path";
import { loadAppsRegistry } from "./apps-registry";
import { loadBacklog } from "./backlog";
import { backlogFile, syncAppTrackers, tick } from "./backlog-work";
import { INTEGRATIONS_FILENAME } from "./backlog-trackers";
import { appsRegistryPath } from "./day2-paths";
import { gatherSignalsForApp } from "./health-scout-cli";

/**
 * Keeps every app's backlog moving — meant to run on a schedule (e.g. every
 * 15 minutes via cron/launchd):
 *
 *   bun run backlog tick            # all apps
 *   bun run backlog tick --app <id> # one app
 *   bun run backlog tick --no-start # import, rank, sync, but start nothing
 *
 * Each pass imports new Sentry/health/proposal findings, re-ranks, picks up
 * merged or closed PRs, syncs JIRA/Linear, and — within the owner's
 * "Start on its own" and in-progress limit — starts work. All agent work is
 * paid from the account's credits like everything else.
 */
async function main(args: string[]): Promise<void> {
  if (args[0] !== "tick") throw new Error("Usage: bun run backlog tick [--app <id>] [--no-start]");
  const only = args.includes("--app") ? args[args.indexOf("--app") + 1] : undefined;
  const startWork = !args.includes("--no-start");
  const integrations = resolve(dirname(appsRegistryPath()), INTEGRATIONS_FILENAME);
  for (const app of loadAppsRegistry(appsRegistryPath()).apps) {
    if (only && app.id !== only) continue;
    const sentry = loadBacklog(backlogFile(app)).settings.sentry;
    const report = await tick(app, {
      startWork,
      gatherSignals: () =>
        gatherSignalsForApp({
          id: app.id,
          appBaseUrl: app.appBaseUrl,
          ...(sentry && process.env.SENTRY_AUTH_TOKEN ? { sentryOrg: sentry.org, sentryProject: sentry.project } : {}),
        }),
    });
    const sync = await syncAppTrackers(app, integrations);
    console.log(
      `[day2-backlog] ${app.name}: ${report.created.length} new, ${report.updated.length} updated, ${report.reranked} re-ranked, ` +
        `${report.reconciled.length} PRs settled, ${report.started.length} started${sync.length ? ` · ${sync.join(" · ")}` : ""}`,
    );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
