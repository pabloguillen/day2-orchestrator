import { query } from "@anthropic-ai/claude-agent-sdk";
import { sandboxConfig } from "./agent-sandbox";

/**
 * Step 4 (self-distributing) extension — retention/win-back segment
 * derivation (user-directed: "What we can learn from Revnu... retention/
 * win-back as an action, not just a signal").
 *
 * `growth-strategy.ts`'s `StageSignals.retentionSignal` already exists, but
 * only ever *gates* whether `paid_ads` unlocks — day2 can see aggregate
 * churn risk, but had no way to *act* on an at-risk individual. This file
 * closes that gap, deliberately narrowly: it derives a real, grounded,
 * plain-language audience *segment* from real per-device data — it does
 * NOT generate creative itself. `growth-creative.ts`'s `generateCreatives`
 * already takes an arbitrary `segment: string`, already runs every
 * creative through the independent claims/authenticity checks, and
 * already has no notion of "channel" baked into segment meaning — a
 * win-back campaign is just a `generateCreatives` call with this file's
 * segment description as the `segment` argument and an existing channel
 * (`paid_ads` as a retargeting audience, or `social_content`) as the arm's
 * `channel`. No new `GrowthChannel`, no new `GrowthCapability`, no
 * duplicated creative-generation/safety-check pipeline — reuse, not a
 * parallel system.
 *
 * Same cross-repo boundary `evolution.ts` already established:
 * `PerUserModel` lives in expense-buddy's own Cloudflare Worker, not
 * importable here. The agent fetches real per-device profiles live via
 * `/api/day2-profile?deviceId=`, the same endpoint and the same
 * "agent explores real, live infrastructure itself via Bash/curl" pattern
 * `evolution.ts`'s `proposeFeature` already uses — not duplicated as a
 * separate TypeScript fetch helper, since the real value here (same as
 * there) is an agent reading several real profiles and finding the actual
 * pattern, not a mechanical field extraction.
 *
 * Identifying which `deviceIds` are actually at churn risk is deliberately
 * left to the caller, not invented here — no "days since last session"
 * field is confirmed to exist on the real per-device profile endpoint, and
 * guessing at one would mean inventing a churn signal this project can't
 * actually verify. `growth-strategy.ts`'s real, already-fetched
 * `retentionSignal` (the fraction of established devices) remains the one
 * confirmed, aggregate-level retention signal; a future, explicitly
 * verified addition to the app's own stats endpoint would be the honest
 * way to get a real per-device recency signal, not assumed here.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 30;
const MAX_BUDGET_USD = 1;

export type ChurnRiskSegment = {
  /** Plain-language, grounded description — fed directly as `segment` into
   * `generateCreatives`. E.g. "Established users who logged expenses
   * weekly for 3+ weeks, then stopped entirely for 10+ days." */
  description: string;
  /** Exactly the device IDs the caller supplied — echoed back, not
   * re-derived, so a caller always knows which real devices this segment
   * is actually grounded in. */
  deviceIds: string[];
  /** What in the real per-device data supports this segment — e.g. "3 of
   * 4 profiles show sessionCount >= 3 and a categoryDistribution with 2+
   * categories, consistent with an established user, not a new one." */
  basis: string;
};

const SEGMENT_RESULT_MARKER = "CHURN_RISK_SEGMENT_JSON:";

function buildSegmentPrompt(appBaseUrl: string, deviceIds: string[]): string {
  return `You are deriving a real, grounded win-back audience segment for a small
production app (a personal expense tracker), from real per-device data —
not inventing a persona.

Fetch the real per-user profile for each of these device IDs (a GET
request, no auth needed), using \`curl\`:
${deviceIds.map((id) => `${appBaseUrl}/api/day2-profile?deviceId=${id}`).join("\n")}

Each profile includes: skillLevel (+ basis), sessionCount,
everOverriddenDefaults, categoryDistribution, and primaryGoal/habits/
statedPreferences (each null unless genuinely observed, with a basis
string). These device IDs were already identified as at churn-risk by the
caller — your job is NOT to judge whether they're at risk, only to find
what, if anything, these real profiles have genuinely in common, so a
win-back message can be grounded in something real about them rather than
generic ("come back!") copy.

Look for a real shared pattern: e.g. they were established users
(sessionCount >= 2, or everOverriddenDefaults) with a clear category focus,
or they shared a primaryGoal/habit. If the real profiles genuinely don't
share anything beyond "they exist," say so honestly — don't invent a
pattern that isn't there.

When finished, end your final message with exactly this marker on its own
line, followed by a single JSON object (and nothing else after it):
${SEGMENT_RESULT_MARKER}
{"description": "...", "basis": "..."}

If the real profiles share no real pattern worth grounding a message in,
respond with:
${SEGMENT_RESULT_MARKER}
null`;
}

/** Pure, unit-tested. Fails closed to `null` — a malformed response, an
 * explicit `null` (no real shared pattern), and "the agent errored" all
 * look the same to a caller: no segment worth campaigning against,
 * matching every other research parser's "don't fabricate when there's
 * nothing real to report" discipline in this codebase. */
export function parseChurnRiskSegment(finalText: string, deviceIds: string[]): ChurnRiskSegment | null {
  const markerIndex = finalText.indexOf(SEGMENT_RESULT_MARKER);
  if (markerIndex === -1) return null;

  const jsonText = finalText.slice(markerIndex + SEGMENT_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object") return null;

  const { description, basis } = parsed as Record<string, unknown>;
  if (typeof description !== "string" || description.trim().length === 0) return null;
  if (typeof basis !== "string" || basis.trim().length === 0) return null;

  return { description, basis, deviceIds };
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live.
 * Bash + sandbox only, same idiom as `evolution.ts`'s `proposeFeature` —
 * the agent fetches real profiles itself via curl, no separate fetch
 * helper. */
export async function deriveWinbackSegment(appBaseUrl: string, atRiskDeviceIds: string[]): Promise<ChurnRiskSegment | null> {
  if (atRiskDeviceIds.length === 0) return null;

  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildSegmentPrompt(appBaseUrl, atRiskDeviceIds),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: ["Bash"],
        sandbox: sandboxConfig(),
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

  if (isError) return null;
  return parseChurnRiskSegment(finalText, atRiskDeviceIds);
}

/** Plain-language rendering, matching every other summary function's
 * no-jargon style in this codebase. */
export function renderChurnRiskSegment(segment: ChurnRiskSegment): string {
  return [
    `Win-back segment (${segment.deviceIds.length} device${segment.deviceIds.length === 1 ? "" : "s"}): ${segment.description}`,
    `Basis: ${segment.basis}`,
  ].join("\n");
}
