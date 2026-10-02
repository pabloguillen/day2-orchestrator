import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPipeline } from "./pipeline";
import { fetchFrictionSignals } from "./sources/interaction-friction-signals";
import { fetchUnresolvedIssuesAsSignals } from "./sources/sentry-signals";
import { clusterSignals } from "./signals/cluster";
import { reportToBugReport } from "./signals/report-to-bug-report";
import type { Signal } from "./signals/types";

/**
 * Day2's standing health-signal scout (COORDINATION.md health-signals-scouts
 * workstream) — the PostHog-equivalent capability this project didn't have:
 * a scheduled, production-facing scan across every real signal source
 * (error tracking, real interaction-friction telemetry), clustered into
 * prioritized reports, filed into the SAME healing pipeline every other
 * bug source already feeds. Deliberately *not* gated to pre-release, unlike
 * swarm v1 (`swarm-fix-cli.ts`) — this is meant to run on a schedule
 * against live production, the standing-scout half PostHog's docs describe
 * ("most runs close out having found nothing worth your attention, and
 * that's the scout working").
 *
 * Multi-app by construction: takes a list of apps, not one hardcoded repo —
 * day2 general, not an expense-buddy-specific tool. `--apps <path>` points
 * at a JSON file of `AppScoutConfig[]`; this is deliberately day2's own
 * minimal shape rather than importing the in-flight `apps-registry.ts`
 * (COORDINATION.md: uncommitted, still forming) — once that registry
 * merges, the natural next step is reading apps from `.day2-apps.json`
 * directly instead of a separate file, but this shouldn't block on
 * someone else's unmerged work landing first.
 */

export type AppScoutConfig = {
  id: string;
  /** Needed only for --file mode (running the healing pipeline needs a
   * real local checkout to open a PR against). Signal-gathering alone
   * (friction/Sentry) doesn't need this. */
  repoPath?: string;
  appBaseUrl?: string;
  sentryOrg?: string;
  sentryProject?: string;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    apps: get("--apps"),
    // Single-app convenience, for trying this against one app without
    // writing a config file first.
    appId: get("--app-id"),
    repoPath: get("--repo"),
    appBaseUrl: get("--app-base-url"),
    sentryOrg: get("--sentry-org"),
    sentryProject: get("--sentry-project"),
    dryRun: args.includes("--dry-run"),
  };
}

export function loadAppConfigs(opts: ReturnType<typeof parseArgs>): AppScoutConfig[] {
  if (opts.apps) {
    const parsed = JSON.parse(readFileSync(resolve(opts.apps), "utf-8"));
    if (!Array.isArray(parsed)) {
      throw new Error(`${opts.apps} must contain a JSON array of app configs.`);
    }
    return parsed as AppScoutConfig[];
  }
  if (opts.appId) {
    return [
      {
        id: opts.appId,
        repoPath: opts.repoPath,
        appBaseUrl: opts.appBaseUrl,
        sentryOrg: opts.sentryOrg,
        sentryProject: opts.sentryProject,
      },
    ];
  }
  return [];
}

async function gatherSignalsForApp(app: AppScoutConfig): Promise<Signal[]> {
  const signals: Signal[] = [];

  if (app.appBaseUrl) {
    try {
      signals.push(...(await fetchFrictionSignals(app.id, app.appBaseUrl)));
    } catch (err) {
      console.warn(`[day2-health-scout] ${app.id}: friction-signal fetch failed: ${err}`);
    }
  }
  if (app.sentryOrg && app.sentryProject) {
    try {
      signals.push(...(await fetchUnresolvedIssuesAsSignals(app.id, app.sentryOrg, app.sentryProject)));
    } catch (err) {
      console.warn(`[day2-health-scout] ${app.id}: Sentry fetch failed: ${err}`);
    }
  }
  return signals;
}

async function main() {
  const opts = parseArgs();
  const apps = loadAppConfigs(opts);
  if (apps.length === 0) {
    console.error(
      "Usage: bun run health-scout -- --apps <apps.json> [--dry-run]\n" +
        "   or: bun run health-scout -- --app-id <id> [--repo <path>] [--app-base-url <url>] " +
        "[--sentry-org <org>] [--sentry-project <project>] [--dry-run]\n\n" +
        "Scans every configured app for real error-tracking and interaction-friction " +
        "signals, clusters them into prioritized reports, and (without --dry-run) files " +
        "actionable ones through the real healing pipeline.",
    );
    process.exit(1);
  }

  const allSignals: Signal[] = [];
  for (const app of apps) {
    console.log(`[day2-health-scout] Scanning ${app.id}...`);
    allSignals.push(...(await gatherSignalsForApp(app)));
  }

  console.log(`[day2-health-scout] ${allSignals.length} real signal(s) collected across ${apps.length} app(s).`);
  const reports = clusterSignals(allSignals);
  if (reports.length === 0) {
    console.log("[day2-health-scout] Nothing worth your attention — the scout is working.");
    return;
  }

  for (const r of reports) {
    console.log(
      `[day2-health-scout]   ${r.priority} ${r.actionable ? "[actionable]" : "[needs input]"}: ${r.title}`,
    );
  }

  const actionableReports = reports.filter((r) => r.actionable);
  if (opts.dryRun) {
    console.log(JSON.stringify({ reports, bugReports: actionableReports.map(reportToBugReport) }, null, 2));
    console.log("[day2-health-scout] --dry-run: not invoking the healing pipeline.");
    return;
  }

  if (actionableReports.length === 0) {
    console.log("[day2-health-scout] No actionable reports to file — the rest need a human look.");
    return;
  }

  let anyFailed = false;
  for (const report of actionableReports) {
    const app = apps.find((a) => a.id === report.appId);
    if (!app?.repoPath) {
      console.warn(`[day2-health-scout] Skipping "${report.title}" — no --repo/repoPath configured for ${report.appId}.`);
      continue;
    }
    const bugReport = reportToBugReport(report);
    const cwd = resolve(app.repoPath);
    const stateFile = resolve(cwd, ".day2-processed.json");
    console.log(`[day2-health-scout] Filing: ${bugReport.title}`);
    const result = await runPipeline(cwd, bugReport, stateFile);
    console.log(`[day2-health-scout]   Result: ${JSON.stringify(result, null, 2)}`);
    if (result.status !== "pr_opened" && result.status !== "already_processed") {
      anyFailed = true;
    }
  }
  if (anyFailed) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-health-scout] Fatal error:", err);
    process.exit(1);
  });
}
