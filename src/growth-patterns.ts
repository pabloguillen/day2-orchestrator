import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AppStage } from "./growth-strategy";
import { isValidMechanismDependsOn } from "./pattern-transferability";
import type { ContextDimension } from "./pattern-transferability";

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
  /** Why this would transfer to a different app, stated separately from
   * what was observed (docs/distribution-intelligence.md, "Stage 1").
   * Required at generation time — only the agent that found the pattern
   * can reason about why it thinks it worked. */
  mechanism: string;
  /** Which context dimensions the mechanism itself claims matter — drives
   * `pattern-transferability.ts`'s tier computation. */
  mechanismDependsOn: ContextDimension[];
  /** Empty when not tied to any one platform — required so "platform" can
   * actually be checked as a `mechanismDependsOn` dimension; without a
   * real value here that dimension would be vacuously unsatisfiable. */
  platforms: string[];
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

Also report which specific platform(s), if any, this pattern is tied to
(e.g. ["tiktok"], or [] if it isn't platform-specific). Then state,
separately from what you observed: WHY would this actually transfer to a
different app (the real causal mechanism, not just "it performed well") —
a mechanism naming a specific platform algorithm or cultural moment is
itself telling you this pattern is context-bound, say so rather than
implying it's timeless. Then classify which context dimensions your own
stated mechanism depends on, from exactly this set: "category" (specific
to this kind of app), "platform" (specific to this distribution channel/
algorithm), "stage" (specific to how established the company was), "era"
(specific to a particular moment in time). Use an empty array only if
you're confident the mechanism is genuinely general — don't default to
empty just to avoid the question.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${PATTERN_RESULT_MARKER}
[{"description": "...", "examples": ["...", "..."], "evidenceStrength": "platform_ranked"|"published_case_study"|"award_judged"|"longevity_proxy", "source": "...", "platforms": ["..."], "mechanism": "...", "mechanismDependsOn": ["category"|"platform"|"stage"|"era", ...]}, ...]

Each object needs all seven fields; \`examples\` should have 1-3 concrete
illustrations, \`platforms\`/\`mechanismDependsOn\` may be empty arrays. An
empty top-level array (${PATTERN_RESULT_MARKER}\n[]) is a legitimate,
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
    .filter((item): item is { description: string; examples: string[]; evidenceStrength: EvidenceStrength; source: string; mechanism: string; mechanismDependsOn: ContextDimension[]; platforms: string[] } => {
      if (typeof item !== "object" || item === null) return false;
      const { description, examples, evidenceStrength, source, mechanism, mechanismDependsOn, platforms } = item as Record<string, unknown>;
      return (
        typeof description === "string" &&
        description.trim().length > 0 &&
        Array.isArray(examples) &&
        examples.length > 0 &&
        examples.every((e) => typeof e === "string" && e.trim().length > 0) &&
        typeof evidenceStrength === "string" &&
        EVIDENCE_STRENGTH_VALUES.has(evidenceStrength) &&
        typeof source === "string" &&
        source.trim().length > 0 &&
        typeof mechanism === "string" &&
        mechanism.trim().length > 0 &&
        isValidMechanismDependsOn(mechanismDependsOn) &&
        Array.isArray(platforms) &&
        platforms.every((p) => typeof p === "string")
      );
    })
    .map((item) => ({
      id: slugify(item.description),
      category,
      description: item.description,
      platforms: item.platforms,
      examples: item.examples,
      evidenceStrength: item.evidenceStrength,
      source: item.source,
      mechanism: item.mechanism,
      mechanismDependsOn: item.mechanismDependsOn,
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
  /** Empty when the strategy wasn't tied to any one distribution
   * channel. */
  platforms: string[];
  mechanism: string;
  mechanismDependsOn: ContextDimension[];
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

Also report which specific distribution platform(s), if any, this
strategy was tied to (e.g. ["tiktok"], or [] if it wasn't platform-
specific — a founder-led content/trust strategy isn't tied to one
channel). Then state WHY this worked, separately from what they did — a
mechanism naming a specific platform algorithm or cultural moment is
itself telling you this is context-bound, say so rather than implying
it's timeless — and classify which context dimensions that mechanism
depends on, from exactly this set: "category", "platform", "stage", "era".
Use an empty array only if you're confident the mechanism is genuinely
general.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${COMPARABLE_RESULT_MARKER}
[{"company": "...", "approxDate": "...", "strategy": "...", "evidence": "...", "source": "...", "platforms": ["..."], "mechanism": "...", "mechanismDependsOn": ["category"|"platform"|"stage"|"era", ...]}, ...]

Each object needs all seven fields (\`platforms\`/\`mechanismDependsOn\` may
be empty arrays, the rest non-empty strings). An empty top-level array
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
    .filter((item): item is { company: string; approxDate: string; strategy: string; evidence: string; source: string; platforms: string[]; mechanism: string; mechanismDependsOn: ContextDimension[] } => {
      if (typeof item !== "object" || item === null) return false;
      const { company, approxDate, strategy, evidence, source, platforms, mechanism, mechanismDependsOn } = item as Record<string, unknown>;
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
        source.trim().length > 0 &&
        Array.isArray(platforms) &&
        platforms.every((p) => typeof p === "string") &&
        typeof mechanism === "string" &&
        mechanism.trim().length > 0 &&
        isValidMechanismDependsOn(mechanismDependsOn)
      );
    })
    .map((item) => ({
      company: item.company,
      category,
      observedStage,
      approxDate: item.approxDate,
      strategy: item.strategy,
      evidence: item.evidence,
      platforms: item.platforms,
      mechanism: item.mechanism,
      mechanismDependsOn: item.mechanismDependsOn,
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

// ---------------------------------------------------------------------------
// Organic (unpaid) content/campaign patterns
// ---------------------------------------------------------------------------

/**
 * User-directed extension (COORDINATION.md, post-W45): `researchProvenPatterns`
 * above is paid-ads-only by construction — TikTok Creative Center's Top Ads
 * and Meta Ad Library both have zero visibility into unpaid, organic posts,
 * no matter how the prompt is tuned. This is a genuinely different research
 * problem, not a harder version of the same one, so it gets its own
 * evidence taxonomy rather than overloading `EvidenceStrength` (a paid ad
 * "still running after 30+ days" has no organic equivalent — there's no
 * "someone kept paying for it" signal to proxy from).
 *
 * Real, disclosed scope limit, not an oversight: this deliberately does NOT
 * attempt to browse Instagram/Facebook/Twitter(X)/Reddit/XiaoHongShu
 * accounts directly. The only mechanisms that actually reach those
 * platforms' organic content (confirmed by research into a real tool that
 * does this, github.com/Panniantong/Agent-Reach) all ride on a real
 * person's own already-logged-in browser session (a cookie export, or
 * driving their real Chrome) — which is automated access under every one
 * of those platforms' own Terms of Service regardless of whether the
 * account is personal, carries real account-suspension risk, and — even
 * setting risk aside — doesn't fit a multi-tenant product at all: day2
 * would have to ask every app owner to hand over their personal social
 * session, a materially worse trust ask than anything else this project
 * asks for (compare the GitHub Connect flow, which reuses the operator's
 * own `gh` session for actions on *their own repo*, not automated browsing
 * of a third party's platform against its rules).
 *
 * What's real, public, and safe instead: TikTok's own Trends section
 * (hashtags/creators/videos — confirmed signed-out-accessible, distinct
 * from the login-gated Top Ads/search Component this file's other function
 * already works around), YouTube (organic "how I grew this app"/review/
 * tutorial content — public video pages and subtitles, no login), and the
 * same secondary-source case-study/founder-interview discovery
 * `researchStageComparables` already relies on.
 */
export type OrganicEvidenceStrength = "platform_trending" | "published_case_study" | "creator_public_metrics";

export type OrganicPattern = {
  id: string;
  category: string;
  description: string;
  examples: string[];
  evidenceStrength: OrganicEvidenceStrength;
  source: string;
  mechanism: string;
  mechanismDependsOn: ContextDimension[];
  platforms: string[];
};

const ORGANIC_PATTERN_RESULT_MARKER = "ORGANIC_PATTERNS_JSON:";
const ORGANIC_EVIDENCE_STRENGTH_VALUES = new Set(["platform_trending", "published_case_study", "creator_public_metrics"]);

function buildOrganicPatternResearchPrompt(category: string): string {
  return `You are researching real, verifiably successful ORGANIC (unpaid) content
and campaign patterns specifically for the "${category}" category — not paid
ads, not generic marketing advice, patterns with real evidence behind them.

Use web search across these specific, free, public sources ONLY:
- TikTok's own Trends page (tiktok.com/business/creativecenter, the
  "Trends" section — hashtags, creators, and videos) — public, signed-out
  data about what's genuinely trending, not a paid-ad ranking.
- YouTube — real organic app-marketing content: "how I got my first users"
  videos, app review/tutorial videos, creator case studies. Use video
  titles, descriptions, and public view/engagement counts as shown on the
  public page.
- Organic-specific case-study roundups and founder retrospectives (Social
  Media Examiner, Buffer, Later, HubSpot's own blog, Indie Hackers, Lenny's
  Newsletter) — real, disclosed organic growth tactics and results.

Do NOT attempt to browse or search Instagram, Facebook, Twitter/X, Reddit,
or XiaoHongShu directly — none of those have a public, unauthenticated
access path, and this research must never rely on a logged-in session.

For each real pattern you find, extract the DISTILLED, reusable pattern
(the structural "why it works" — a format, a posting cadence, a hook,
an organic distribution mechanic), not just a description of one specific
post. Classify its evidence honestly using exactly one of: "platform_trending"
(TikTok's own public Trends page), "published_case_study" (a platform/
publication's own disclosed real organic results), "creator_public_metrics"
(specific, actually-visible public engagement numbers on a named creator's
post — say so explicitly if you couldn't verify real numbers this way).
Cite a real, checkable source for each — never invent one. Find 3-6 real
patterns; report fewer if you can't verify that many — don't pad.

Also report which specific platform(s) this was actually observed on
(e.g. ["tiktok"], ["youtube"] — rarely empty for organic patterns, since
they're almost always tied to where the content lives). Then state,
separately from what you observed: WHY would this actually transfer to a
different app — a mechanism naming a specific platform algorithm or
cultural moment is itself telling you this pattern is context-bound, say
so rather than implying it's timeless. Then classify which context
dimensions your own stated mechanism depends on, from exactly this set:
"category" (specific to this kind of app), "platform" (specific to this
distribution channel/algorithm), "stage" (specific to how established the
company was), "era" (specific to a particular moment in time). Use an
empty array only if you're confident the mechanism is genuinely general —
don't default to empty just to avoid the question.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${ORGANIC_PATTERN_RESULT_MARKER}
[{"description": "...", "examples": ["...", "..."], "evidenceStrength": "platform_trending"|"published_case_study"|"creator_public_metrics", "source": "...", "platforms": ["..."], "mechanism": "...", "mechanismDependsOn": ["category"|"platform"|"stage"|"era", ...]}, ...]

Each object needs all seven fields; \`examples\` should have 1-3 concrete
illustrations, \`platforms\`/\`mechanismDependsOn\` may be empty arrays. An
empty top-level array (${ORGANIC_PATTERN_RESULT_MARKER}\n[]) is a legitimate,
honest answer if you genuinely couldn't verify anything worth reporting.`;
}

/** Pure, unit-tested. Same fail-closed discipline as `parseProvenPatterns`. */
export function parseOrganicPatterns(finalText: string, category: string): OrganicPattern[] {
  const markerIndex = finalText.indexOf(ORGANIC_PATTERN_RESULT_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + ORGANIC_PATTERN_RESULT_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is { description: string; examples: string[]; evidenceStrength: OrganicEvidenceStrength; source: string; mechanism: string; mechanismDependsOn: ContextDimension[]; platforms: string[] } => {
      if (typeof item !== "object" || item === null) return false;
      const { description, examples, evidenceStrength, source, mechanism, mechanismDependsOn, platforms } = item as Record<string, unknown>;
      return (
        typeof description === "string" &&
        description.trim().length > 0 &&
        Array.isArray(examples) &&
        examples.length > 0 &&
        examples.every((e) => typeof e === "string" && e.trim().length > 0) &&
        typeof evidenceStrength === "string" &&
        ORGANIC_EVIDENCE_STRENGTH_VALUES.has(evidenceStrength) &&
        typeof source === "string" &&
        source.trim().length > 0 &&
        typeof mechanism === "string" &&
        mechanism.trim().length > 0 &&
        isValidMechanismDependsOn(mechanismDependsOn) &&
        Array.isArray(platforms) &&
        platforms.every((p) => typeof p === "string")
      );
    })
    .map((item) => ({
      id: slugify(item.description),
      category,
      description: item.description,
      platforms: item.platforms,
      examples: item.examples,
      evidenceStrength: item.evidenceStrength,
      source: item.source,
      mechanism: item.mechanism,
      mechanismDependsOn: item.mechanismDependsOn,
    }));
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live.
 * WebSearch/WebFetch only, same tool restriction as every other research
 * function in this file — no Bash, no browser automation, no session/
 * cookie access of any kind. */
export async function researchOrganicPatterns(category: string): Promise<OrganicPattern[]> {
  let finalText = "";
  let isError = false;

  try {
    for await (const message of query({
      prompt: buildOrganicPatternResearchPrompt(category),
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
  return parseOrganicPatterns(finalText, category);
}
