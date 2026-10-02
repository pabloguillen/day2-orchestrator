import { resolve } from "node:path";
import { fetchPendingChangeCards } from "./approvals";
import { renderDigest, sendSlackDigest, type DigestPeriod } from "./growth-digest";
import { loadGrowthActions } from "./growth-feed";
import { loadAuditEntries } from "./owner-feed";
import { listProposals } from "./proposals";

/**
 * CLI for the push-based digest (COORDINATION.md, user-directed Revnu-
 * inspired extension). Matches `growth-feed-cli.ts`'s on-demand pattern —
 * no scheduler lives here. Meant to be invoked by an operator's own cron
 * job or a GitHub Actions schedule (same relationship `auto-release-cli.ts`
 * has to `auto-release.yml`), with `--webhook-url` or the
 * `DAY2_SLACK_WEBHOOK_URL` env var pointing at a real Slack incoming
 * webhook. With neither set, prints the digest to stdout instead of
 * failing — useful for a dry run / piping into something else.
 *
 * Usage:
 *   bun run src/growth-digest-cli.ts -- --repo <path> --app-name "expense-buddy" [--period daily|weekly] [--webhook-url <url>] [--since <date>]
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const period = get("--period");
  return {
    repo: get("--repo"),
    appName: get("--app-name"),
    period: (period === "weekly" ? "weekly" : "daily") as DigestPeriod,
    webhookUrl: get("--webhook-url") ?? process.env.DAY2_SLACK_WEBHOOK_URL,
    since: get("--since"),
  };
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo || !opts.appName) {
    console.error('Usage: bun run src/growth-digest-cli.ts -- --repo <path> --app-name "expense-buddy" [--period daily|weekly] [--webhook-url <url>] [--since <date>]');
    process.exit(1);
  }

  const repoPath = resolve(opts.repo);
  const defaultSince = new Date(Date.now() - (opts.period === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000);
  const since = opts.since ? new Date(opts.since) : defaultSince;

  const auditEntries = loadAuditEntries(resolve(repoPath, "day2-autonomy-audit.jsonl"), since);
  const growthActions = loadGrowthActions(resolve(repoPath, "day2-growth-actions.jsonl"), since);
  const proposals = listProposals(resolve(repoPath, "day2-proposals.jsonl")).filter((p) => new Date(p.recordedAt) >= since);
  const pendingApprovals = await fetchPendingChangeCards(repoPath).catch(() => []);

  const message = renderDigest(opts.appName, opts.period, { auditEntries, growthActions, proposals, pendingApprovals });

  if (!opts.webhookUrl) {
    console.log(message);
    return;
  }

  const result = await sendSlackDigest(opts.webhookUrl, message);
  if (!result.ok) {
    console.error(`[day2-digest] Failed to send: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("[day2-digest] Sent.");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-digest] Fatal error:", err);
    process.exit(1);
  });
}
