import { resolve } from "node:path";
import {
  decideTrendCampaignAction,
  evaluateTrendFit,
  loadTrendCampaignConfig,
  TREND_CAMPAIGN_CONFIG_FILENAME,
} from "./growth-trend-campaigns";
import { isTrendExpired, researchCurrentTrends, type TrendSignal } from "./growth-trends";
import { APP_PROFILE_FILENAME, loadAppProfile } from "./onboarding";

/**
 * CLI for Step 4's ad hoc trend-triggered campaign gate
 * (growth-trend-campaigns.ts) — previously real, fully unit-tested fit/
 * gating decision logic with zero caller anywhere in the codebase.
 *
 * `growth-trends.ts` (trend DETECTION) has no existing CLI and no on-disk
 * persistence for a `TrendSignal[]` result — confirmed by reading it in
 * full: unlike `FormatRecurrenceLog` (which does have
 * `loadFormatRecurrenceLog`/`saveFormatRecurrenceLog`), `researchCurrentTrends`
 * only ever returns its result in memory, nothing writes it to disk. So
 * this CLI chains the real thing end to end rather than reading a
 * nonexistent persisted format: it calls `researchCurrentTrends` itself
 * first (a real, live agent + Playwright + YouTube/Reddit API call), then
 * feeds each real signal straight into `evaluateTrendFit` +
 * `decideTrendCampaignAction` — the actual fit/gating decision this task is
 * about giving a caller.
 *
 * Deliberately NOT wired here: `canSubstituteTrendPost`. That check needs a
 * real count of posts already made this week in the target channel, which
 * would have to come from cross-referencing `growth-feed.ts`'s real audit
 * trail against `growth-strategy.ts`'s `ChannelAllocation.frequencyPerWeek`
 * — a concern for whichever future orchestration step actually performs the
 * post (Phase 2, explicitly deferred per this file's own header), not this
 * fit/gating CLI.
 *
 * Usage:
 *   bun run src/growth-trend-campaigns-cli.ts --repo <path> --category <category>
 *     [--trend-config-file path] [--now <iso-date>]
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    category: get("--category"),
    trendConfigFile: get("--trend-config-file"),
    now: get("--now"),
  };
}

/**
 * Pure — the one real piece of decision logic this CLI itself owns (every
 * other decision lives in `growth-trend-campaigns.ts`, already unit-tested
 * there). Skips already-expired trends BEFORE spending a real agent call on
 * `evaluateTrendFit` for them: `decideTrendCampaignAction` would reach the
 * same "skip" verdict for an expired trend anyway (it checks
 * `isTrendExpired` first), but only after paying for a fit evaluation it
 * never needed.
 */
export function selectTrendsWorthEvaluating(trends: TrendSignal[], now: Date): TrendSignal[] {
  return trends.filter((t) => !isTrendExpired(t, now));
}

function usage(): never {
  console.error(
    "Usage: bun run src/growth-trend-campaigns-cli.ts --repo <path> --category <category>\n" +
      "         [--trend-config-file path] [--now <iso-date>]",
  );
  process.exit(1);
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo || !opts.category) usage();

  const repoPath = resolve(opts.repo);
  const profilePath = resolve(repoPath, APP_PROFILE_FILENAME);
  const appProfile = loadAppProfile(profilePath);
  if (!appProfile) {
    console.error(`[day2-trend-campaigns] No reviewed app profile found at ${profilePath} — run onboarding-cli.ts first.`);
    process.exit(1);
  }

  const trendConfig = loadTrendCampaignConfig(resolve(repoPath, opts.trendConfigFile ?? TREND_CAMPAIGN_CONFIG_FILENAME));
  const now = opts.now ? new Date(opts.now) : new Date();

  console.log(`[day2-trend-campaigns] Researching current trends for "${opts.category}"...`);
  const trends = await researchCurrentTrends(opts.category);
  const active = selectTrendsWorthEvaluating(trends, now);

  if (active.length === 0) {
    console.log(`[day2-trend-campaigns] No active, currently-relevant trends found for "${opts.category}" this run.`);
    return;
  }

  for (const trend of active) {
    const fit = await evaluateTrendFit(trend, appProfile);
    const decision = decideTrendCampaignAction(trend, fit, trendConfig.autoPostOptIn, now);
    console.log(`\n- [${trend.platform}] ${trend.description} (format: ${trend.format}, source: ${trend.source})`);
    console.log(`  Fit: ${fit.fits ? "fits" : "does not fit"} — ${fit.reason}`);
    console.log(`  Decision: ${decision.action} — ${decision.reason}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-trend-campaigns] Fatal error:", err);
    process.exit(1);
  });
}
