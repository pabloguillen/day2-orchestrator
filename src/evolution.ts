import { query } from "@anthropic-ai/claude-agent-sdk";
import { sandboxConfig } from "./agent-sandbox";
import type { CompetitorInsight } from "./competitor-feed";

/**
 * Evolution engine — proposal generation only, not autonomous shipping
 * (COORDINATION.md W32, Step 3 Component 3 — docs/step3-self-evolving-plan.md).
 *
 * Explicit scope decision from the plan, restated here since it's the
 * load-bearing safety property of this whole component: "Generating
 * genuinely new features/flows" is a categorically bigger leap in autonomy
 * than anything else this project has shipped (bug fixes, or varying among
 * already-human-built, already-verified UI blocks). This agent produces a
 * written `FeatureProposal` — rationale, evidence, a contract sketch — for
 * a human to evaluate. It never writes, merges, or ships code itself.
 *
 * Cross-repo note: `PerUserModel`/`StoredEvent` are defined in
 * `expense-buddy/src/server.ts`, not importable here — orchestrator's Bun
 * CLI and expense-buddy's Cloudflare Worker are separate deployable units
 * (the same boundary Component 2 hit, see experiments.ts). Rather than
 * duplicate those types speculatively, the agent fetches real per-device
 * profiles live via HTTP from the deployed app's own `/api/day2-profile`
 * endpoint — the same "agent explores real, live infrastructure itself"
 * pattern `swarm.ts`'s personas and `onboarding.ts`'s scan already use.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 30;
const MAX_BUDGET_USD = 1.5;

export type FeatureProposal = {
  title: string;
  rationale: string;
  observedEvidence: string;
  proposedContract: string;
  openQuestions: string[];
  /** Optional, and deliberately separate from `observedEvidence` — that
   * field is specifically the real per-user data that justifies this
   * proposal; this one is market context from Component 4's competitor
   * feed (docs/step3-self-evolving-plan.md), supporting evidence at most,
   * never the primary justification. Absent whenever no supplied insight
   * was genuinely relevant to the pattern actually observed — "nothing
   * relevant" is honest, not a reason to force a citation in. */
  competitorContext?: string;
};

/** Richer than the plan's own `FeatureProposal | null` sketch, on purpose:
 * "the agent found nothing worth proposing" (a legitimate, expected
 * outcome — most runs against thin data should end here) and "the agent's
 * output was unusable" (a real failure) need different handling by a
 * caller, and collapsing both to `null` would hide which one happened.
 * Matches this project's own `ScanResult`/`CanaryReleaseResult`-style
 * discriminated-union convention elsewhere. */
export type ProposalResult =
  | { status: "proposed"; proposal: FeatureProposal }
  | { status: "no_proposal" }
  | { status: "parse_failed"; reason: string }
  | { status: "already_rejected"; proposal: FeatureProposal; previousRejection: RejectedProposal };

/** A human's past decision not to build a proposal — the memory
 * `proposeFeature` needs so the same idea doesn't get proposed again every
 * time the same usage pattern is still present in the data. Recorded via
 * `proposals.ts::recordRejection`; defined here (not there) since
 * `proposals.ts` already depends on this file for `FeatureProposal` and a
 * dependency the other way would be circular. */
export type RejectedProposal = {
  title: string;
  reason: string;
  rejectedAt: string;
};

/** Case-insensitive, trimmed exact match — simple and disclosed rather than
 * a fuzzy-similarity heuristic, matching this project's general preference
 * for a plain rule a human can reason about over one that could misfire in
 * either direction with no real data yet to tune it against. */
export function isAlreadyRejected(
  title: string,
  rejectedProposals: RejectedProposal[],
): RejectedProposal | undefined {
  const normalized = title.trim().toLowerCase();
  return rejectedProposals.find((r) => r.title.trim().toLowerCase() === normalized);
}

function buildCompetitorContextBlock(competitorInsights: CompetitorInsight[]): string {
  if (competitorInsights.length === 0) return "";
  const entries = competitorInsights
    .map((i) => `- ${i.competitor}: ${i.feature} (relevance: ${i.relevance}, source: ${i.source})`)
    .join("\n");
  return `\nFor context only — real features from competing products (Component 4's competitor
feed), NOT a substitute for real per-user evidence:
${entries}

Only cite one of these (via the optional "competitorContext" field below) if it's genuinely
relevant to a pattern you actually found in the real per-user data above. The core justification
for any proposal must always come from the real profiles you fetched — never propose a feature
just because a competitor has it, with no matching real usage pattern behind it. Omit
"competitorContext" entirely if none of these are actually relevant.\n`;
}

function buildRejectedProposalsBlock(rejectedProposals: RejectedProposal[]): string {
  if (rejectedProposals.length === 0) return "";
  const entries = rejectedProposals
    .map((r) => `- "${r.title}" — a human already rejected this: ${r.reason}`)
    .join("\n");
  return `
A human has already reviewed and rejected these specific proposals before. Do NOT propose any of
these again, even if the data still shows the same underlying pattern — a rejection stands until a
human reverses it, it doesn't expire just because the evidence recurs:
${entries}
`;
}

function buildProposalPrompt(
  appBaseUrl: string,
  deviceIds: string[],
  competitorInsights: CompetitorInsight[] = [],
  rejectedProposals: RejectedProposal[] = [],
): string {
  return `You are the evolution engine's proposal generator for a small production app (a personal
expense tracker). Your job is to notice a real, repeated, currently-unserved usage pattern and
propose ONE concrete new feature for a human to review — you never write or ship code yourself.

The app already serves these adaptive variants (per its per-user model) — do NOT re-propose any
of these, they already exist:
- Established users (2+ sessions, or ever overrode a form default) get bulk-select-and-delete on
  the expense list, instead of the novice default.
- Users spending across 2+ categories get a category-breakdown view of their spending, instead of
  just a total.
- Users who manually view their weekly report 3 Fridays in a row get it shown automatically
  ("habits" signal, the app's own "Chloe" pattern).
${buildRejectedProposalsBlock(rejectedProposals)}
Fetch the real per-user profile for each of these device IDs (a GET request, no auth needed):
${deviceIds.map((id) => `${appBaseUrl}/api/day2-profile?deviceId=${id}`).join("\n")}

Each profile includes: skillLevel (+ basis), sessionCount, everOverriddenDefaults,
categoryDistribution, and primaryGoal/habits/statedPreferences (each null unless genuinely
observed, with a basis string explaining why). Use \`curl\` to fetch each one for real — don't
guess or assume what they contain.

Look across all of these real profiles for a genuine pattern that isn't already served by the
three variants listed above. If you find one, worth proposing a new feature for it. Be honest: if
the data is too thin, too synthetic, or doesn't show a real repeated pattern, say so and propose
nothing — a null result is a legitimate, expected outcome, not a failure on your part.
${buildCompetitorContextBlock(competitorInsights)}

When finished, end your final message with a line reading exactly PROPOSAL_JSON: followed
immediately by a single fenced \`\`\`json code block. If you have a real proposal, the block must
contain exactly this shape:

{
  "title": "short, plain-language feature name",
  "rationale": "why this feature, grounded in what you actually observed",
  "observedEvidence": "the specific real data points from the profiles you fetched that support this",
  "proposedContract": "a typed contract sketch for the building block, in the same style as docs/step2-self-adapting-spec.md §3 (fields + types)",
  "openQuestions": ["anything a human reviewer should resolve before building this"],
  "competitorContext": "OPTIONAL — only include this key at all if one of the competitor items above is genuinely relevant to the real pattern you found; omit the key entirely otherwise, don't set it to null or an empty string"
}

If you found nothing worth proposing, the block must contain exactly: null`;
}

/** Pure and separately tested: fail-closed on agent error or malformed
 * output, distinguishes an honest "nothing to propose" from a parse
 * failure rather than collapsing both to the same outcome. */
export function parseFeatureProposal(finalText: string, isError: boolean): ProposalResult {
  if (isError) {
    return { status: "parse_failed", reason: `agent run errored: ${finalText.slice(0, 500)}` };
  }

  const markerIndex = finalText.indexOf("PROPOSAL_JSON:");
  if (markerIndex === -1) {
    return { status: "parse_failed", reason: "no PROPOSAL_JSON: marker in the agent's final message" };
  }

  const afterMarker = finalText.slice(markerIndex);
  const fenceMatch = afterMarker.match(/```json\s*([\s\S]*?)```/);
  const rawBlock = fenceMatch ? fenceMatch[1].trim() : afterMarker.slice("PROPOSAL_JSON:".length).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlock);
  } catch {
    return { status: "parse_failed", reason: `PROPOSAL_JSON block was not valid JSON: ${rawBlock.slice(0, 200)}` };
  }

  if (parsed === null) {
    return { status: "no_proposal" };
  }

  if (typeof parsed !== "object") {
    return { status: "parse_failed", reason: "PROPOSAL_JSON was neither null nor an object" };
  }
  const p = parsed as Record<string, unknown>;

  if (typeof p.title !== "string" || !p.title.trim()) {
    return { status: "parse_failed", reason: "proposal missing a non-empty title" };
  }
  if (typeof p.rationale !== "string" || !p.rationale.trim()) {
    return { status: "parse_failed", reason: "proposal missing a non-empty rationale" };
  }
  if (typeof p.observedEvidence !== "string" || !p.observedEvidence.trim()) {
    return { status: "parse_failed", reason: "proposal missing non-empty observedEvidence" };
  }
  if (typeof p.proposedContract !== "string" || !p.proposedContract.trim()) {
    return { status: "parse_failed", reason: "proposal missing a non-empty proposedContract" };
  }
  if (!Array.isArray(p.openQuestions) || !p.openQuestions.every((q) => typeof q === "string")) {
    return { status: "parse_failed", reason: "proposal's openQuestions must be an array of strings" };
  }
  if (p.competitorContext !== undefined && (typeof p.competitorContext !== "string" || !p.competitorContext.trim())) {
    return {
      status: "parse_failed",
      reason: "proposal's competitorContext, if present, must be a non-empty string (omit the key entirely if not relevant)",
    };
  }

  return {
    status: "proposed",
    proposal: {
      title: p.title,
      rationale: p.rationale,
      observedEvidence: p.observedEvidence,
      proposedContract: p.proposedContract,
      openQuestions: p.openQuestions as string[],
      ...(typeof p.competitorContext === "string" ? { competitorContext: p.competitorContext } : {}),
    },
  };
}

async function runProposalAgent(
  appBaseUrl: string,
  deviceIds: string[],
  competitorInsights: CompetitorInsight[],
  rejectedProposals: RejectedProposal[],
): Promise<{ finalText: string; isError: boolean }> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildProposalPrompt(appBaseUrl, deviceIds, competitorInsights, rejectedProposals),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        // Fetch-and-reason only — no file access needed for this task, so
        // none is granted. `Bash` here is used exclusively for `curl`
        // against the app's own public, unauthenticated read endpoints.
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

  return { finalText, isError };
}

export async function proposeFeature(
  appBaseUrl: string,
  deviceIds: string[],
  competitorInsights: CompetitorInsight[] = [],
  rejectedProposals: RejectedProposal[] = [],
): Promise<ProposalResult> {
  const { finalText, isError } = await runProposalAgent(appBaseUrl, deviceIds, competitorInsights, rejectedProposals);
  const result = parseFeatureProposal(finalText, isError);
  // Deterministic backstop, not just a prompt instruction: the agent is
  // told not to re-propose a rejected idea, but a prompt is a request, not
  // a guarantee. If it still produces one — same title, data pattern still
  // present — catch it here rather than silently re-surfacing something a
  // human already said no to.
  if (result.status === "proposed") {
    const previousRejection = isAlreadyRejected(result.proposal.title, rejectedProposals);
    if (previousRejection) {
      return { status: "already_rejected", proposal: result.proposal, previousRejection };
    }
  }
  return result;
}
