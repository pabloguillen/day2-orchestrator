import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

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
 *
 * Step 4 (self-distributing), Component 5 additive extension (COORDINATION.md
 * W42, docs/step4-self-distributing-plan.md) — `CompetitorAngleInsight`/
 * `researchCompetitorDistributionAngles` and `SocialTrendInsight`/
 * `researchSocialTrends` below. `CompetitorInsight` above stays exactly
 * as-is for the Step 3 evolution engine — this is a genuinely different
 * question (distribution/marketing angle and channel, not product feature)
 * with its own shape, not a rename or a widening of the existing type.
 * `growth-strategy.ts` (Component 2) originally defined local stand-ins
 * for these two types, disclosed at the time as "Component 5 should
 * absorb these when it lands" — this is that landing; `growth-strategy.ts`
 * now imports the real versions from here instead.
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

// ---------------------------------------------------------------------------
// Step 4 Component 5 additive extension
// ---------------------------------------------------------------------------

export type CompetitorAngleInsight = {
  /** Real, named competitor — never a made-up or generic placeholder. */
  competitor: string;
  /** The specific distribution/marketing angle observed — e.g. "leads with
   * a free-tier hook in TikTok ads", not a product feature. */
  angle: string;
  /** The channel this angle was observed on (e.g. "paid_ads", "social_content") —
   * a free-form string, not `GrowthChannel`/`SpendCategory`, since a
   * research agent describing what it found shouldn't be constrained to
   * this codebase's own internal channel taxonomy. */
  channel: string;
  relevance: string;
  source: string;
};

const ANGLE_RESULT_MARKER = "COMPETITOR_ANGLES_JSON:";

function buildAngleResearchPrompt(category: string): string {
  return `You are researching real competing products for a "${category}" app,
to inform how a growth strategy positions and markets against them (you are
not proposing anything yourself — just gathering real, verifiable
information about how they actually go to market).

Using web search, find 3-5 real, currently-existing, named products in this
category. For each one, note ONE concrete, specific DISTRIBUTION or
MARKETING angle they use — not a product feature, but how they position
themselves, what hook or offer they lead with, and on which channel you
found evidence of it (their own site, an ad library, a review mentioning
their marketing, app store listing copy, etc.). Cite a real URL for each —
never invent a URL or an angle you didn't actually find evidence for. If you
can't find enough real, verifiable angles, report fewer than 5 rather than
padding the list with anything unverified.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${ANGLE_RESULT_MARKER}
[{"competitor": "...", "angle": "...", "channel": "...", "relevance": "...", "source": "..."}, ...]

Each object needs all five fields as non-empty strings. An empty array
(${ANGLE_RESULT_MARKER}\n[]) is a legitimate, honest answer if you genuinely
couldn't verify anything worth reporting — don't fabricate entries just to
have output.`;
}

/** Pure, unit-tested. Same fail-closed-to-`[]` discipline as
 * `parseCompetitorInsights`. */
export function parseCompetitorAngleInsights(finalText: string): CompetitorAngleInsight[] {
  const markerIndex = finalText.indexOf(ANGLE_RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + ANGLE_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter((item): item is CompetitorAngleInsight => {
    if (typeof item !== "object" || item === null) return false;
    const { competitor, angle, channel, relevance, source } = item as Record<string, unknown>;
    return (
      typeof competitor === "string" &&
      competitor.trim().length > 0 &&
      typeof angle === "string" &&
      angle.trim().length > 0 &&
      typeof channel === "string" &&
      channel.trim().length > 0 &&
      typeof relevance === "string" &&
      relevance.trim().length > 0 &&
      typeof source === "string" &&
      source.trim().length > 0
    );
  });
}

/** Thin, agent-invoking wrapper — zero unit coverage on the agent call
 * itself, validated only live (same idiom as `researchCompetitorFeatures`).
 * `mcpServers` is the plan's own "optionally MCP-upgraded via Component 4's
 * `competitor_research` binding (real, verified: Foreplay.co)" — when
 * Component 4 has a real, enabled `competitor_research` binding for this
 * app, pass `buildMcpServersOption(config, ["competitor_research"])` here
 * and the agent gains that vendor's own tools alongside WebSearch/WebFetch;
 * omitted (the default — day2's platform tool registry ships empty,
 * `bindings: []`), this is zero-dependency, matching the plan's own
 * "none required" posture for research domains. */
export async function researchCompetitorDistributionAngles(
  category: string,
  mcpServers?: Record<string, McpServerConfig>,
): Promise<CompetitorAngleInsight[]> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildAngleResearchPrompt(category),
      options: {
        model: MODEL,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        persistSession: false,
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        tools: ["WebSearch", "WebFetch"],
        ...(mcpServers ? { mcpServers } : {}),
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
  return parseCompetitorAngleInsights(finalText);
}

export type SocialTrendInsight = {
  platform: "tiktok" | "instagram" | "other";
  trend: string;
  format: string;
  relevance: string;
  source: string;
};

const TREND_RESULT_MARKER = "SOCIAL_TRENDS_JSON:";
const KNOWN_PLATFORMS = new Set(["tiktok", "instagram", "other"]);

function buildTrendResearchPrompt(category: string, platforms: string[]): string {
  const platformList = platforms.join(", ");
  return `You are researching what's currently trending on ${platformList} that could
be relevant to marketing a "${category}" app — genuinely current trends
(formats, hooks, sounds/memes if relevant), not evergreen platform advice.

Using web search, find 2-5 real, currently-relevant trends on these
platforms. For each one, note the specific FORMAT (e.g. "day-in-the-life",
"before/after reveal", "duet/stitch response", "talking-head hook + text
overlay") and why it's genuinely relevant to this specific app category —
not just "video is popular." Cite a real, checkable source for each
(a real article, the platform's own trend page, a creator/campaign example)
— never invent one. If you can't find enough real, currently-relevant
trends, report fewer than 5 rather than padding the list.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${TREND_RESULT_MARKER}
[{"platform": "tiktok"|"instagram"|"other", "trend": "...", "format": "...", "relevance": "...", "source": "..."}, ...]

Each object needs all five fields; "platform" must be exactly one of those
three values. An empty array (${TREND_RESULT_MARKER}\n[]) is a legitimate,
honest answer if you genuinely couldn't verify anything worth reporting —
don't fabricate entries just to have output.`;
}

/** Pure, unit-tested. Same fail-closed-to-`[]` discipline as the other
 * parsers in this file, plus a closed-set check on `platform`. */
export function parseSocialTrendInsights(finalText: string): SocialTrendInsight[] {
  const markerIndex = finalText.indexOf(TREND_RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + TREND_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter((item): item is SocialTrendInsight => {
    if (typeof item !== "object" || item === null) return false;
    const { platform, trend, format, relevance, source } = item as Record<string, unknown>;
    return (
      typeof platform === "string" &&
      KNOWN_PLATFORMS.has(platform) &&
      typeof trend === "string" &&
      trend.trim().length > 0 &&
      typeof format === "string" &&
      format.trim().length > 0 &&
      typeof relevance === "string" &&
      relevance.trim().length > 0 &&
      typeof source === "string" &&
      source.trim().length > 0
    );
  });
}

/** Thin, agent-invoking wrapper, WebSearch/WebFetch only — the plan's own
 * `social_trend_research` domain is "deliberately zero-dependency by
 * default," no MCP upgrade path needed here (unlike competitor angle
 * research, which Foreplay specifically serves). */
export async function researchSocialTrends(category: string, platforms: string[]): Promise<SocialTrendInsight[]> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildTrendResearchPrompt(category, platforms),
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
  return parseSocialTrendInsights(finalText);
}
