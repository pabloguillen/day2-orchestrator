import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AppProfile } from "./onboarding";
import type { WebsiteConfig } from "./spend-governance";
import type { ToolBinding } from "./growth-tools-config";

/**
 * Step 4 (self-distributing), Component 7 — optional marketing website
 * (COORDINATION.md W44, docs/step4-self-distributing-plan.md).
 *
 * Owner opt-in only (`GrowthConfig.website.enabled`, default `false`, per
 * Component 1's `defaultGrowthConfig`) — the lowest-priority, most
 * separable component in the plan, built last on purpose.
 *
 * `toolBinding` plays the exact same role here as `growth-execution.ts`'s
 * own `ChannelExecutionOptions.toolBinding`: the caller resolves it via
 * Component 4's `resolveBindings` (+ optionally `selectBestFitBinding`)
 * before calling this function, so by the time it arrives here it's
 * already known `enabled` and — since `website_generation` is one of the
 * three identity-bearing capabilities (safety rail 5) — already known to
 * have a real `connectedAccountRef`. This function never re-checks either;
 * `undefined` is the only signal it needs, meaning "nothing resolved."
 *
 * **Cost note, per the plan's own flag**: the agent-generation cost below
 * (`costUsd` on the `generated` result) is a normal one-off cost, same
 * shape as every other agent call in this codebase. Real website HOSTING
 * would be a recurring cost with no equivalent in `spend-governance.ts`'s
 * one-off `SpendRequest` shape — deliberately not forced into it here.
 * Flagged in the plan's own Open Questions (#4) as needing a dedicated
 * design, not solved by this component.
 *
 * **MCP-upgrade honesty note**, same disclosure Components 4 and 5 already
 * made for their own optional-MCP paths: `toolBinding.serverConfig` is
 * wired into the generation call's `mcpServers` option structurally, but
 * day2's platform tool registry ships empty (`bindings: []`) — there is no
 * real Framer/Juno credential anywhere in this environment, so the
 * "a real, connected tool produces a real live preview URL" branch below
 * is real code, not live-tested against a genuine vendor. Live-validation
 * uses a fixture `ToolBinding` to prove the *generation* path is real and
 * grounded — not to fake a working vendor connection.
 *
 * **Disclosed necessary addition, same class of gap Components 3/4/5 all
 * hit**: the plan's literal `generated` result snippet has no field to
 * hold the actual generated page content — only `previewRef`. Without one,
 * real generated copy would be silently discarded every time no live tool
 * URL exists (the honest, expected default in this environment), which is
 * real information loss, not brevity. Added `pageContent: string`.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 20;
const MAX_BUDGET_USD = 2;

export type WebsiteGenerationResult =
  | { status: "generated"; previewRef: string; templateUsed: string; pageContent: string; costUsd: number }
  | { status: "not_enabled" }
  | { status: "blocked_by_unconnected_account" }
  | { status: "generation_failed"; reason: string };

const GENERATION_MARKER = "WEBSITE_GENERATION_JSON:";

function buildGenerationPrompt(appProfile: AppProfile, websiteConfig: WebsiteConfig): string {
  const styleGuide = appProfile.styleGuide;
  const templateNote = websiteConfig.templatePreference
    ? `The owner has a template preference: "${websiteConfig.templatePreference}" — use it if it makes sense for this app, but don't force a bad fit just to honor the label.`
    : "No template preference was given — pick whatever real, named template style genuinely fits this app and report which one.";

  const toolNote = `A website-generation/publishing tool is connected via MCP. If it actually
responds and gives you a real, live preview URL, use it and put that real
URL in \`previewRef\`. If it doesn't respond, or you have no way to verify a
URL it gives you is real, do NOT invent or guess one — instead write the
real page content directly (this is still a genuine, useful deliverable —
grounded real copy, not a placeholder) and set \`previewRef\` to a short,
honest note that no live preview exists yet (e.g. "no live preview — the
connected tool did not return a verifiable URL"), never a fabricated URL.`;

  return `You are writing a one-page marketing website for a small, real app —
grounded entirely in its real, already-scanned profile below. This is the
owner's own opt-in marketing site (they explicitly enabled this), not a
paid ad — write it accordingly: informative and true, not hard-sell.

App grounding (the ONLY source of truth — never invent a feature, claim, or
capability not implied by this):
- Purpose: ${appProfile.purpose}
- Target users: ${appProfile.targetUsers}
- Real features: ${appProfile.featureMap.join(", ")}
- Tone of voice: ${appProfile.toneOfVoice}
- Visual style: ${styleGuide!.framework}, color palette ${styleGuide!.colors.join(", ")}

${templateNote}

Write real section content for a single marketing page: a hero headline +
subhead, a short "what it does" section, a real feature list drawn only
from the grounding above, and a single call-to-action line. Ground every
claim in the real app profile — the same discipline as any other creative
in this system.

${toolNote}

When finished, end your final message with exactly this marker on its own
line, followed by JSON (and nothing else after it):
${GENERATION_MARKER}
{"status": "generated", "pageContent": "...", "templateUsed": "...", "previewRef": "..."}
or
{"status": "generation_failed", "reason": "..."}

\`pageContent\` should be the full real section content as readable text
(not HTML), specific enough to actually build a page from. \`templateUsed\`
should name the real template style you used. Use "generation_failed" only
if the grounding above is genuinely too thin to write anything honest and
specific — that's a legitimate outcome, don't pad instead.`;
}

type RawGenerationResult =
  | { status: "generated"; pageContent: string; templateUsed: string; previewRef: string }
  | { status: "generation_failed"; reason: string };

function isValidRawGenerated(value: unknown): value is Extract<RawGenerationResult, { status: "generated" }> {
  if (typeof value !== "object" || value === null) return false;
  const { pageContent, templateUsed, previewRef } = value as Record<string, unknown>;
  return (
    typeof pageContent === "string" &&
    pageContent.trim().length > 0 &&
    typeof templateUsed === "string" &&
    templateUsed.trim().length > 0 &&
    typeof previewRef === "string" &&
    previewRef.trim().length > 0
  );
}

/** Pure, unit-tested. Fails closed to `generation_failed` on any parse
 * issue — an unreadable agent response must never be reported as a
 * successful "generated" result. */
export function parseWebsiteGenerationResult(finalText: string, costUsd: number): WebsiteGenerationResult {
  const markerIndex = finalText.indexOf(GENERATION_MARKER);
  if (markerIndex === -1) {
    return { status: "generation_failed", reason: "no result marker found in agent output" };
  }
  const jsonText = finalText.slice(markerIndex + GENERATION_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { status: "generation_failed", reason: "malformed JSON after result marker" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "generation_failed", reason: "result was not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.status === "generation_failed") {
    return {
      status: "generation_failed",
      reason: typeof obj.reason === "string" && obj.reason.trim().length > 0 ? obj.reason : "no reason given",
    };
  }

  if (obj.status !== "generated" || !isValidRawGenerated(obj)) {
    return { status: "generation_failed", reason: "result had neither a valid \"generated\" nor \"generation_failed\" shape" };
  }

  return {
    status: "generated",
    previewRef: obj.previewRef,
    templateUsed: obj.templateUsed,
    pageContent: obj.pageContent,
    costUsd,
  };
}

/**
 * Thin, agent-invoking wrapper. Fails closed BEFORE ever calling the agent
 * for the three real preconditions: owner opt-in, a connected tool, and
 * mandatory grounding — same discipline `generateCreatives` (Component 5)
 * established for its own mandatory-grounding gate.
 */
export async function generateMarketingWebsite(
  appProfile: AppProfile,
  websiteConfig: WebsiteConfig,
  toolBinding: ToolBinding | undefined,
): Promise<WebsiteGenerationResult> {
  if (!websiteConfig.enabled) {
    return { status: "not_enabled" };
  }
  if (!toolBinding) {
    return { status: "blocked_by_unconnected_account" };
  }
  if (!appProfile.toneOfVoice || !appProfile.styleGuide) {
    return {
      status: "generation_failed",
      reason: "mandatory grounding missing: toneOfVoice and/or styleGuide were never scanned for this app",
    };
  }

  let finalText = "";
  let isError = false;
  let costUsd = 0;

  try {
    for await (const message of query({
      prompt: buildGenerationPrompt(appProfile, websiteConfig),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: [],
        mcpServers: { [toolBinding.mcpServerName]: toolBinding.serverConfig },
      },
    })) {
      if (message.type === "result") {
        finalText = message.result ?? "";
        isError = Boolean(message.is_error);
        costUsd = message.total_cost_usd ?? 0;
      }
    }
  } catch (err) {
    isError = true;
    finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
  }

  if (isError) return { status: "generation_failed", reason: `agent run failed: ${finalText}` };
  return parseWebsiteGenerationResult(finalText, costUsd);
}
