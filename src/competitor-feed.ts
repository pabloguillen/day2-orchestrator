import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Step 3 (self-evolving), Component 4 — competitor feed
 * (COORDINATION.md W32, docs/step3-self-evolving-plan.md).
 *
 * The first piece in this whole project that needs external web research —
 * everything else has only ever tested/reasoned about expense-buddy's own
 * deployed app. Deliberately a much simpler agent than swarm.ts/
 * calibration.ts's personas: no Bash, no filesystem, no sandbox — it only
 * ever needs to search and read public pages, so it gets exactly those two
 * tools and nothing else.
 *
 * Scope, per the plan: research real, named competing apps in a category
 * and produce structured, cited insights — genuinely useful on its own
 * (real information about real products), but its natural consumer is
 * Component 3's evolution engine (not built yet), which can cite an
 * insight's `feature`/`source` directly in a `FeatureProposal`'s
 * `observedEvidence`. `CompetitorInsight` is intentionally standalone
 * (doesn't import anything from Component 3) so this doesn't have to wait
 * on that component existing first.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 20;
const MAX_BUDGET_USD = 1;

export type CompetitorInsight = {
  /** Real, named product — e.g. "YNAB", "Copilot Money". Never a made-up
   * or generic placeholder. */
  competitor: string;
  /** The specific feature or pattern observed, concrete enough to act on
   * ("one-tap recurring-expense detection"), not a vague category
   * ("good budgeting tools"). */
  feature: string;
  /** Why this might matter for expense-buddy specifically — not just "this
   * is popular," but a concrete connection to a real gap or opportunity. */
  relevance: string;
  /** A real, checkable URL or citation — never fabricated. */
  source: string;
};

const RESULT_MARKER = "COMPETITOR_INSIGHTS_JSON:";

function buildResearchPrompt(category: string): string {
  return `You are researching real competing products for a "${category}" app,
to inform a later feature-proposal process (you are not proposing anything
yourself — just gathering real, verifiable information).

Using web search, find 3-5 real, currently-existing, named products in this
category. For each one, note ONE concrete, specific feature or pattern —
not a vague summary of the whole product — that a small, simple app in this
category doesn't already have and might genuinely benefit from. Cite a real
URL for each (the product's own site, a review, or documentation) — never
invent a URL or a feature you didn't actually find evidence for. If you
can't find enough real, verifiable competitors or features, report fewer
than 5 rather than padding the list with anything unverified.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${RESULT_MARKER}
[{"competitor": "...", "feature": "...", "relevance": "...", "source": "..."}, ...]

Each object needs all four fields as non-empty strings. An empty array
(${RESULT_MARKER}\n[]) is a legitimate, honest answer if you genuinely
couldn't verify anything worth reporting — don't fabricate entries just to
have output.`;
}

/** Pure, unit-tested. Fails closed to an empty array on any parse failure,
 * non-array JSON, or a malformed marker — "couldn't extract anything
 * trustworthy" and "genuinely found nothing" must look the same to a
 * caller, since this is research output a human will read, not something
 * that should ever surface half-parsed garbage as if it were real. Individual
 * malformed *entries* within an otherwise-valid array are dropped rather
 * than invalidating the whole batch — this isn't a safety gate the way
 * calibration.ts's parser is, so partial-but-genuine results are more
 * useful here than an all-or-nothing failure. */
export function parseCompetitorInsights(finalText: string): CompetitorInsight[] {
  const markerIndex = finalText.indexOf(RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter((item): item is CompetitorInsight => {
    if (typeof item !== "object" || item === null) return false;
    const { competitor, feature, relevance, source } = item as Record<string, unknown>;
    return (
      typeof competitor === "string" &&
      competitor.trim().length > 0 &&
      typeof feature === "string" &&
      feature.trim().length > 0 &&
      typeof relevance === "string" &&
      relevance.trim().length > 0 &&
      typeof source === "string" &&
      source.trim().length > 0
    );
  });
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live
 * (same idiom as runPersona/runSkepticCheck). No sandbox/cwd/tempdir needed
 * — this agent never runs a script or touches the filesystem, only
 * WebSearch/WebFetch. */
export async function researchCompetitorFeatures(category: string): Promise<CompetitorInsight[]> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildResearchPrompt(category),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: ["WebSearch", "WebFetch"],
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

  if (isError) return [];
  return parseCompetitorInsights(finalText);
}
