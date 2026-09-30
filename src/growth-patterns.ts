import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AppStage } from "./growth-strategy";

/**
 * Step 4 (self-distributing) extension — category/stage-aware proven-
 * pattern and stage-matched-comparable research (COORDINATION.md W45).
 *
 * User-directed, post-plan enhancement: replicate tryholo.ai-level
 * creative grounding ("trained on 10M+ creative assets, 19,000+ top-
 * performing ads") without their subscription or any model training.
 * Real research into how tryholo actually works (their own public docs/
 * marketing) found two parts: a website-scrape-derived "Brand DNA"
 * (already replicated by Component 5's mandatory `toneOfVoice`/
 * `styleGuide` grounding) fused with a large proprietary corpus of real
 * ad performance data — the actual moat, not model quality, and
 * explicitly NOT used to fine-tune anything ("your brand data never
 * trains Holo's models" — their own words, i.e. retrieval/context, not
 * per-customer training).
 *
 * This file replaces "raw scraped volume" with a small, curated,
 * *verified* library instead — every entry tagged with a real
 * `EvidenceStrength` so confidence is never overstated (a 60-day-old
 * still-running ad is a real but weaker signal than a platform's own
 * published performance ranking; the type says so explicitly rather than
 * presenting both with equal confidence). Every source is free/public —
 * zero cash cost, matching the user's own framing that engineering/agent
 * time is the free resource here, not data-licensing money.
 *
 * Two real refinements the user required before this was built:
 *   1. Category-awareness — a pattern proven for a gen-z social app isn't
 *      evidence for a B2B SaaS tool. `category` is a plain caller-supplied
 *      string (same convention `competitor-feed.ts`'s `researchCompetitor-
 *      Features(category)` already established), not inferred internally.
 *   2. Stage-awareness — reuses Component 2's real `AppStage` directly.
 *      `researchStageComparables` doesn't ask "what does this successful
 *      company do now," it asks "what did they do when they were at this
 *      app's current stage" — sourced via Wayback Machine snapshots of
 *      their OWN early site (concrete, dated, hard to fake) plus "how I
 *      got my first N users"-style founder interviews, never their
 *      current mature-company playbook.
 *
 * Both new types are consumed the exact same way `CompetitorAngleInsight`/
 * `SocialTrendInsight` already are: fed as plain, pre-resolved arrays into
 * `growth-creative.ts`'s `generateCreatives` (extending its existing
 * `untrustedResearchBlock` wrapper — this is live web research, same
 * threat model, not `ai-slop-patterns.ts`'s own hardcoded/trusted list)
 * and `growth-strategy.ts`'s `deriveGrowthStrategy` (`stageComparables`
 * only — cited in rationale, never overriding a stage-based hard rule,
 * same discipline `competitorAngles`/`trendInsights` already established
 * there). This file itself does no wiring — it only researches and
 * parses.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 20;
const MAX_BUDGET_USD = 1;

// ---------------------------------------------------------------------------
// Proven content/ad patterns
// ---------------------------------------------------------------------------

/** How strong the "this actually performed well" claim is — never
 * presented as uniform confidence. Ranked here roughly strongest-first,
 * though the type itself carries no ordering; `platform_ranked` (the
 * platform's own internal performance ranking, e.g. TikTok Creative
 * Center's Top Ads) and `published_case_study` (a platform/brand's own
 * disclosed real results) are first-party and verified. `award_judged`
 * (Cannes Lions, Clios, Ads of the World) is judged by a real panel but
 * measures craft, not necessarily performance. `longevity_proxy` (an ad
 * still running after 30-90+ days in a public ad library) is a real,
 * honest, derivable-for-free signal, but an inference, not a platform-
 * confirmed number — weakest of the four, still genuinely evidence. */
export type EvidenceStrength = "platform_ranked" | "published_case_study" | "award_judged" | "longevity_proxy";

export type ProvenPattern = {
  id: string;
  category: string;
  description: string;
  examples: string[];
  evidenceStrength: EvidenceStrength;
  source: string;
};

const PATTERN_RESULT_MARKER = "PROVEN_PATTERNS_JSON:";
const EVIDENCE_STRENGTH_VALUES = new Set(["platform_ranked", "published_case_study", "award_judged", "longevity_proxy"]);

function buildPatternResearchPrompt(category: string): string {
  return `You are researching real, verifiably high-performing content/ad
patterns specifically for the "${category}" category — not generic
marketing advice, patterns with real evidence behind them.

Use web search across these specific, free, public sources:
- TikTok Creative Center's own Top Ads dashboard (ads.tiktok.com/business/
  creativecenter) — TikTok's own first-party performance ranking, filterable
  by industry/region.
- Meta Ad Library (facebook.com/ads/library) — an ad still running for
  30-90+ days in this category is a real, honest signal an advertiser kept
  paying for it because it worked (a real but inferred proxy, not a
  platform-confirmed number — label it as such).
- Judged award archives (Cannes Lions Shortlist, Clio Awards, Ads of the
  World) — real industry-panel-judged creative, craft-quality evidence.
- Platform-published case studies (Meta/TikTok/Google's own "success
  stories" pages) — real, disclosed results, first-party.

For each real pattern you find, extract the DISTILLED, reusable pattern
(the structural "why it works" — a hook type, a format, a pacing choice,
an angle), not just a description of one specific ad. Classify its
evidence honestly using exactly one of: "platform_ranked" (a platform's
own internal performance ranking), "published_case_study" (a platform/
brand's own disclosed real results), "award_judged" (a real judged award),
"longevity_proxy" (inferred from an ad still running after 30+ days — say
so explicitly, don't overstate this as confirmed performance). Cite a
real, checkable source for each — never invent one. Find 3-6 real patterns;
report fewer if you can't verify that many — don't pad.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${PATTERN_RESULT_MARKER}
[{"description": "...", "examples": ["...", "..."], "evidenceStrength": "platform_ranked"|"published_case_study"|"award_judged"|"longevity_proxy", "source": "..."}, ...]

Each object needs all four fields; \`examples\` should have 1-3 concrete
illustrations. An empty array (${PATTERN_RESULT_MARKER}\n[]) is a legitimate,
honest answer if you genuinely couldn't verify anything worth reporting.`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** Pure, unit-tested. Fails closed to `[]`, same discipline as every other
 * research parser in this codebase — "couldn't extract anything
 * trustworthy" and "genuinely found nothing" look identical to a caller.
 * `id` is derived (slugified description), not requested from the agent —
 * one less thing it can get wrong or collide on across separate calls. */
export function parseProvenPatterns(finalText: string, category: string): ProvenPattern[] {
  const markerIndex = finalText.indexOf(PATTERN_RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + PATTERN_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is { description: string; examples: string[]; evidenceStrength: EvidenceStrength; source: string } => {
      if (typeof item !== "object" || item === null) return false;
      const { description, examples, evidenceStrength, source } = item as Record<string, unknown>;
      return (
        typeof description === "string" &&
        description.trim().length > 0 &&
        Array.isArray(examples) &&
        examples.length > 0 &&
        examples.every((e) => typeof e === "string" && e.trim().length > 0) &&
        typeof evidenceStrength === "string" &&
        EVIDENCE_STRENGTH_VALUES.has(evidenceStrength) &&
        typeof source === "string" &&
        source.trim().length > 0
      );
    })
    .map((item) => ({
      id: slugify(item.description),
      category,
      description: item.description,
      examples: item.examples,
      evidenceStrength: item.evidenceStrength,
      source: item.source,
    }));
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live
 * (same idiom as `researchCompetitorFeatures`/`researchToolCandidates`).
 * WebSearch/WebFetch only, no sandbox/Bash/filesystem. */
export async function researchProvenPatterns(category: string): Promise<ProvenPattern[]> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildPatternResearchPrompt(category),
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
  return parseProvenPatterns(finalText, category);
}

// ---------------------------------------------------------------------------
// Stage-matched comparable companies
// ---------------------------------------------------------------------------

export type StageComparableInsight = {
  /** Real, named company — never made up. */
  company: string;
  category: string;
  observedStage: AppStage;
  /** Approximate real date/period this observation is from, e.g. "2013"
   * or "early 2015" — never fabricated precision the source doesn't
   * support. */
  approxDate: string;
  strategy: string;
  /** The concrete evidence this is grounded in — e.g. "Wayback Machine
   * snapshot of their homepage from that period" or "founder interview
   * describing their first 100 users" — not just a restatement of
   * `strategy`. */
  evidence: string;
  source: string;
};

const COMPARABLE_RESULT_MARKER = "STAGE_COMPARABLES_JSON:";

/** Human-readable stage description for the research prompt — mirrors
 * `growth-strategy.ts`'s own real stage boundaries (`TRACTION_MIN_USERS`/
 * `GROWTH_MIN_USERS`) so the agent is asked about a genuinely equivalent
 * period, not a vague "early days." */
const STAGE_DESCRIPTIONS: Record<AppStage, string> = {
  launch: "just launched, under ~100 users, pre-product-market-fit",
  traction: "early traction, roughly 100-5,000 users, still proving what works",
  growth: "meaningful scale, 5,000+ active users, past initial product-market-fit",
  scale: "large, established scale — well past the point most startups' 'early days' stories cover",
};

function buildComparableResearchPrompt(category: string, targetStage: AppStage): string {
  return `You are researching real, now-successful companies in the "${category}"
category, specifically to find what THEIR growth/marketing/content
strategy looked like when THEY were at this stage: ${STAGE_DESCRIPTIONS[targetStage]}.

This is explicitly NOT about what these companies do now as mature,
well-funded businesses — a big-budget current campaign from a company
with millions of users is not useful evidence for an app at this stage.
Find 2-4 real, named companies and research their EARLY-STAGE strategy
specifically, using sources like:
- The Wayback Machine (web.archive.org) — pull an actual archived snapshot
  of the company's OWN website/landing page from around the period when
  they were at this stage, and describe what it actually said/looked like.
  This is the strongest, most concrete evidence available here — prefer it.
- "How I got my first users" / early-growth founder interviews and case
  studies (e.g. Indie Hackers, Lenny's Newsletter, YC's own blog,
  first-hand founder retrospectives) that explicitly describe this period.

For each, report the real company name, the approximate real date/period
of the observation, the concrete strategy/tactic they used at that stage,
and the specific evidence you found it in (not just a restatement of the
strategy — name the actual snapshot/interview/article). Cite a real,
checkable source — never invent one, and never guess at a Wayback Machine
URL you didn't actually retrieve. If you can't find enough real,
verifiable examples at this specific stage, report fewer than 4 rather
than padding with speculation or with their current, later-stage strategy.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${COMPARABLE_RESULT_MARKER}
[{"company": "...", "approxDate": "...", "strategy": "...", "evidence": "...", "source": "..."}, ...]

Each object needs all five fields as non-empty strings. An empty array
(${COMPARABLE_RESULT_MARKER}\n[]) is a legitimate, honest answer if you
genuinely couldn't verify anything worth reporting at this specific stage
— don't fabricate entries just to have output.`;
}

/** Pure, unit-tested. Fails closed to `[]`, same discipline as every
 * other research parser here. `category`/`observedStage` are stamped from
 * the caller's own request, not re-parsed from agent output — the agent
 * was asked about one specific category/stage; echoing back what was
 * asked for is more honest than trusting the model to repeat it exactly. */
export function parseStageComparables(finalText: string, category: string, observedStage: AppStage): StageComparableInsight[] {
  const markerIndex = finalText.indexOf(COMPARABLE_RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + COMPARABLE_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is { company: string; approxDate: string; strategy: string; evidence: string; source: string } => {
      if (typeof item !== "object" || item === null) return false;
      const { company, approxDate, strategy, evidence, source } = item as Record<string, unknown>;
      return (
        typeof company === "string" &&
        company.trim().length > 0 &&
        typeof approxDate === "string" &&
        approxDate.trim().length > 0 &&
        typeof strategy === "string" &&
        strategy.trim().length > 0 &&
        typeof evidence === "string" &&
        evidence.trim().length > 0 &&
        typeof source === "string" &&
        source.trim().length > 0
      );
    })
    .map((item) => ({
      company: item.company,
      category,
      observedStage,
      approxDate: item.approxDate,
      strategy: item.strategy,
      evidence: item.evidence,
      source: item.source,
    }));
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live.
 * WebSearch/WebFetch only (Wayback Machine snapshots are just URLs,
 * fetchable the same way as any other page — no special tooling needed). */
export async function researchStageComparables(category: string, targetStage: AppStage): Promise<StageComparableInsight[]> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildComparableResearchPrompt(category, targetStage),
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
  return parseStageComparables(finalText, category, targetStage);
}
