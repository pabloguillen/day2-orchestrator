import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";

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

const DENIED_ENV_VARS = ["SENTRY_AUTH_TOKEN", "SENTRY_REGION_URL", "ANTHROPIC_API_KEY"];
const home = homedir();
const DENIED_READ_PATHS = [
  `${home}/.ssh`,
  `${home}/.aws`,
  `${home}/.claude`,
  `${home}/.config/gh`,
  `${home}/.netrc`,
  `${home}/.npmrc`,
  `${home}/.docker`,
  `${home}/.gnupg`,
];

export type FeatureProposal = {
  title: string;
  rationale: string;
  observedEvidence: string;
  proposedContract: string;
  openQuestions: string[];
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
  | { status: "parse_failed"; reason: string };

function buildProposalPrompt(appBaseUrl: string, deviceIds: string[]): string {
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

When finished, end your final message with a line reading exactly PROPOSAL_JSON: followed
immediately by a single fenced \`\`\`json code block. If you have a real proposal, the block must
contain exactly this shape:

{
  "title": "short, plain-language feature name",
  "rationale": "why this feature, grounded in what you actually observed",
  "observedEvidence": "the specific real data points from the profiles you fetched that support this",
  "proposedContract": "a typed contract sketch for the building block, in the same style as docs/step2-self-adapting-spec.md §3 (fields + types)",
  "openQuestions": ["anything a human reviewer should resolve before building this"]
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

  return {
    status: "proposed",
    proposal: {
      title: p.title,
      rationale: p.rationale,
      observedEvidence: p.observedEvidence,
      proposedContract: p.proposedContract,
      openQuestions: p.openQuestions as string[],
    },
  };
}

async function runProposalAgent(appBaseUrl: string, deviceIds: string[]): Promise<{ finalText: string; isError: boolean }> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildProposalPrompt(appBaseUrl, deviceIds),
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
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          failIfUnavailable: true,
          credentials: {
            envVars: DENIED_ENV_VARS.map((name) => ({ name, mode: "deny" as const })),
          },
          filesystem: { denyRead: DENIED_READ_PATHS },
        },
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

export async function proposeFeature(appBaseUrl: string, deviceIds: string[]): Promise<ProposalResult> {
  const { finalText, isError } = await runProposalAgent(appBaseUrl, deviceIds);
  return parseFeatureProposal(finalText, isError);
}
