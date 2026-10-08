import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AppProfile } from "./onboarding";
import { renderBrandBrief } from "./brand-dna";
import { isTrendExpired, type TrendSignal } from "./growth-trends";

/**
 * Ad hoc trend-triggered campaigns (docs/distribution-intelligence.md,
 * "when a trend is detected this could also ad hoc lead to a promotion
 * campaign of an app — not saying every app jumps on the same trend;
 * just when it fits").
 *
 * This is a separate, event-triggered path, not folded into the regular
 * allocator cycle (`growth-allocator.ts`) — a trend's whole value is its
 * window (`TrendSignal.relevanceWindowDays`, see `growth-trends.ts`), and
 * waiting for the next scheduled allocator pass could mean posting into
 * a dead trend. But "fast" must never mean "unsafe": once a trend is
 * judged to fit and worth acting on, it still has to flow through the
 * SAME downstream safety pipeline every other piece of growth content
 * does — `checkTruthfulClaims`/`checkAuthenticity` (`growth-creative.ts`)
 * and spend governance (`spend-governance.ts`) — this file does not
 * reimplement or bypass any of that; it only decides WHETHER and HOW
 * fast a trend-driven creative gets to those existing gates.
 *
 * Deliberately NOT built here: the actual posting call, or a
 * `growth-config.ts` field for the opt-in. `evaluateTrendFit`/
 * `decideTrendCampaignAction` are pure decision logic; wiring a decision
 * of `"auto_post"` into a real `performLiveAction` call is explicitly
 * Phase 2 (real external spend/posting), already deferred pending its
 * own separate go-ahead. The opt-in flag gets its own small, additive,
 * file-backed config here (`TrendCampaignConfig`) rather than a new field
 * on the shared `growth-config.ts`'s `GrowthConfig` — same
 * collision-avoidance discipline as `growth-winback.ts`/`growth-digest.ts`
 * choosing their own state files instead of editing a file the parallel
 * session actively commits to.
 *
 * Anti-spam is cadence SUBSTITUTION, not addition: `canSubstituteTrendPost`
 * only allows a trend post to consume a slot the channel's
 * `frequencyPerWeek` (`growth-strategy.ts`) already budgeted this week,
 * never an extra post stacked on top of it.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 15;
const MAX_BUDGET_USD = 0.5;

// ---------------------------------------------------------------------------
// Fit evaluation
// ---------------------------------------------------------------------------

export type TrendFitVerdict = {
  trendId: string;
  fits: boolean;
  reason: string;
};

const TREND_FIT_MARKER = "TREND_FIT_JSON:";

function buildTrendFitPrompt(trend: TrendSignal, appProfile: AppProfile): string {
  return `You are deciding whether a currently-trending content format is actually
worth this specific app jumping on, or whether it would be a forced,
off-brand stretch. Default to NOT fitting — most trends don't fit most
apps, and a trend that reads as a forced tie-in costs more credibility
than skipping it.

Real app grounding (the ONLY source of truth):
- Purpose: ${appProfile.purpose}
- Target users: ${appProfile.targetUsers}
- Tone of voice: ${appProfile.toneOfVoice ?? "not established"}
- Business model: ${appProfile.businessModel ?? "not established"}
- Visual style: ${appProfile.styleGuide ? `${appProfile.styleGuide.framework}, colors ${appProfile.styleGuide.colors.join(", ")}` : "not established"}
${appProfile.brand ? `\n${renderBrandBrief(appProfile.brand, "social")}\n` : ""}
The trend:
- Description: ${trend.description}
- Structural format: ${trend.format}
- Platform: ${trend.platform}

Judge honestly whether this specific app, with this specific tone and
these specific target users, can execute this trend format in a way that
feels native rather than forced. When finished, end your final message
with exactly this marker on its own line, followed by JSON (and nothing
else after it):
${TREND_FIT_MARKER}
{"fits": true|false, "reason": "..."}`;
}

/** Pure, unit-tested. Fails closed to `fits: false` — an unparseable
 * verdict must never be silently treated as "go ahead," same direction
 * as `parseGeoGroundingVerdict`/`parseClaimCheckVerdict`. */
export function parseTrendFitVerdict(finalText: string, trend: TrendSignal): TrendFitVerdict {
  const markerIndex = finalText.indexOf(TREND_FIT_MARKER);
  if (markerIndex === -1) {
    return { trendId: trend.id, fits: false, reason: "could not parse a fit verdict from the agent's output" };
  }
  const jsonText = finalText.slice(markerIndex + TREND_FIT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { trendId: trend.id, fits: false, reason: "malformed JSON after fit-verdict marker" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { trendId: trend.id, fits: false, reason: "fit-verdict result was not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.fits !== "boolean" || typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    return { trendId: trend.id, fits: false, reason: "fit-verdict result had an invalid shape" };
  }
  return { trendId: trend.id, fits: obj.fits, reason: obj.reason };
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only
 * live. Pure text in/out, no tools, grounded entirely in the real,
 * already-scanned `AppProfile`. */
export async function evaluateTrendFit(trend: TrendSignal, appProfile: AppProfile): Promise<TrendFitVerdict> {
  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildTrendFitPrompt(trend, appProfile),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: [],
      },
    })) {
      if (message.type === "result") {
        finalText = message.result ?? "";
        isError = Boolean(message.is_error);
      }
    }
  } catch (err) {
    isError = true;
    finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
  }
  if (isError) return { trendId: trend.id, fits: false, reason: `agent run failed: ${finalText}` };
  return parseTrendFitVerdict(finalText, trend);
}

// ---------------------------------------------------------------------------
// Opt-in config (own small file — see header comment)
// ---------------------------------------------------------------------------

export type TrendCampaignConfig = { autoPostOptIn: boolean };

export const TREND_CAMPAIGN_CONFIG_FILENAME = ".day2-trend-campaign-config.json";

export function loadTrendCampaignConfig(path: string): TrendCampaignConfig {
  if (!existsSync(path)) return { autoPostOptIn: false };
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null || typeof raw.autoPostOptIn !== "boolean") {
    throw new Error(`${path} exists but doesn't look like a valid trend-campaign config — refusing to guess or overwrite it.`);
  }
  return { autoPostOptIn: raw.autoPostOptIn };
}

export function saveTrendCampaignConfig(path: string, config: TrendCampaignConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function setTrendAutoPostOptIn(config: TrendCampaignConfig, autoPostOptIn: boolean): TrendCampaignConfig {
  return { ...config, autoPostOptIn };
}

// ---------------------------------------------------------------------------
// Campaign gating
// ---------------------------------------------------------------------------

export type TrendCampaignDecision =
  | { action: "skip"; reason: string }
  | { action: "auto_post"; reason: string }
  | { action: "notify_for_approval"; reason: string };

/** Pure, unit-tested. Never silently posts and never silently skips a
 * fitting, still-relevant trend — without the explicit opt-in, the only
 * paths are "skip" (genuinely doesn't apply) or "notify_for_approval"
 * (a real high-priority notification, left to the owner-feed layer to
 * actually surface — this function just decides which of the three it
 * is). */
export function decideTrendCampaignAction(trend: TrendSignal, fit: TrendFitVerdict, autoPostOptIn: boolean, now: Date): TrendCampaignDecision {
  if (isTrendExpired(trend, now)) {
    return { action: "skip", reason: `trend "${trend.description}" has already passed its ${trend.relevanceWindowDays}-day relevance window` };
  }
  if (!fit.fits) {
    return { action: "skip", reason: `doesn't fit this app's positioning: ${fit.reason}` };
  }
  if (autoPostOptIn) {
    return { action: "auto_post", reason: `fits (${fit.reason}) and auto-post is opted in` };
  }
  return { action: "notify_for_approval", reason: `fits (${fit.reason}) but auto-post isn't opted in — needs explicit approval` };
}

/** Pure, unit-tested. Cadence SUBSTITUTION, not addition — true only when
 * this week's already-budgeted `frequencyPerWeek` slots for the channel
 * (`ChannelAllocation`, `growth-strategy.ts`) aren't already used up; a
 * trend post consumes a slot that was going to happen anyway rather than
 * stacking an extra post on top of it. */
export function canSubstituteTrendPost(postsAlreadyMadeThisWeek: number, frequencyPerWeek: number): boolean {
  return postsAlreadyMadeThisWeek < frequencyPerWeek;
}
