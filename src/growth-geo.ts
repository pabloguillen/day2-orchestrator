import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AppProfile } from "./onboarding";
import { isValidMechanismDependsOn } from "./pattern-transferability";
import type { ContextDimension } from "./pattern-transferability";

/**
 * Step 4 (self-distributing) extension — GEO (generative-engine
 * optimization): grounded content aimed at being cited inside AI-search
 * answers (ChatGPT, Claude, Gemini, Perplexity), not just ranked by
 * classic search engines (user-directed: "What we can learn from
 * Revnu... add GEO as a sibling to seo_content").
 *
 * Deliberately NOT a new `GrowthChannel`/`GrowthCapability` — GEO content
 * is the same kind of asset `seo_content` already covers (free, organic,
 * text-based), just shaped differently (a direct-answer Q&A block instead
 * of a long-form article), and it reuses the exact same Tier 0 philosophy
 * already established for creative generation: Claude + real app grounding,
 * zero external vendor, zero markup. No new infrastructure, a new content
 * shape and a new research angle.
 *
 * Two-stage, same discipline as `growth-creative.ts`'s generate-then-
 * independently-verify split: `generateGeoAnswers` writes Q&A content
 * grounded in the real, scanned `AppProfile`; `checkGeoGrounding` is a
 * fresh, independent agent call that never shares state with the one that
 * wrote it, checking each answer against the same real grounding — same
 * safety rail 4 precedent `checkTruthfulClaims` already established, since
 * ungrounded-but-confident "facts" are exactly what gets an app *mis*cited
 * by an AI answer engine, arguably worse than not being cited at all.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 20;
const MAX_BUDGET_USD = 1;

// ---------------------------------------------------------------------------
// Research: what gets cited by AI answer engines
// ---------------------------------------------------------------------------

/** Distinct from `EvidenceStrength`/`OrganicEvidenceStrength` — GEO's own
 * evidence is about content STRUCTURE (what format gets cited), not about
 * a specific creative's measured performance. Reusing either existing
 * taxonomy would misrepresent what's actually being claimed here. */
export type GeoEvidenceStrength = "industry_published" | "platform_documented";

export type GeoPattern = {
  id: string;
  category: string;
  /** The structural pattern, e.g. "a direct one-sentence answer in the
   * first paragraph, before any elaboration." */
  description: string;
  evidenceStrength: GeoEvidenceStrength;
  source: string;
  mechanism: string;
  mechanismDependsOn: ContextDimension[];
  /** Which AI-search platform(s) this was observed on, e.g. ["chatgpt"] —
   * empty when the finding is about citation behavior generally, not one
   * engine specifically. */
  platforms: string[];
};

const GEO_PATTERN_MARKER = "GEO_PATTERNS_JSON:";
const GEO_EVIDENCE_VALUES = new Set(["industry_published", "platform_documented"]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function buildGeoPatternPrompt(category: string): string {
  return `You are researching real, evidence-backed patterns for getting content
CITED inside AI search-answer engines (ChatGPT, Claude, Gemini, Perplexity)
— "generative engine optimization" (GEO) — specifically for the
"${category}" category.

Use web search across these specific, free, public sources:
- Published GEO/AI-search-visibility research and guides from recognized
  SEO industry publications (Search Engine Land, Ahrefs' own blog, Moz,
  Search Engine Journal) — real, disclosed findings about what content
  structure actually gets cited.
- Any AI-search platform's own public documentation about how it selects
  and cites sources (e.g. OpenAI's, Google's, or Perplexity's own
  published guidance, if it exists).

For each real pattern you find, extract the DISTILLED, reusable structural
pattern (not category-specific advice) — e.g. "answer-first" paragraph
structure, FAQ/schema markup, explicit comparison tables, numbered
step-by-step instructions. Classify its evidence honestly using exactly
one of: "industry_published" (a named publication's own research/finding),
"platform_documented" (an AI-search platform's own published guidance).
Cite a real, checkable source for each — never invent one. Find 2-5 real
patterns; report fewer if you can't verify that many — don't pad.

Also report which specific AI-search platform(s), if any, this was
observed on (e.g. ["chatgpt"], or [] if it's about citation behavior
generally). Then state, separately from what you observed: WHY would this
actually transfer to a different app's content — a mechanism naming one
specific platform's current citation behavior is itself telling you this
pattern is context-bound, say so rather than implying it's timeless. Then
classify which context dimensions your own stated mechanism depends on,
from exactly this set: "category" (specific to this kind of app/query),
"platform" (specific to one AI-search engine's current behavior), "stage"
(rarely relevant here), "era" (specific to how these engines work right
now). Use an empty array only if you're confident the mechanism is
genuinely general.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${GEO_PATTERN_MARKER}
[{"description": "...", "evidenceStrength": "industry_published"|"platform_documented", "source": "...", "platforms": ["..."], "mechanism": "...", "mechanismDependsOn": ["category"|"platform"|"stage"|"era", ...]}, ...]

Each object needs all six fields (\`platforms\`/\`mechanismDependsOn\` may be
empty arrays). An empty top-level array (${GEO_PATTERN_MARKER}\n[]) is a
legitimate, honest answer if you genuinely couldn't verify anything worth
reporting.`;
}

/** Pure, unit-tested. Same fail-closed discipline as every other research
 * parser in this codebase. */
export function parseGeoPatterns(finalText: string, category: string): GeoPattern[] {
  const markerIndex = finalText.indexOf(GEO_PATTERN_MARKER);
  if (markerIndex === -1) return [];

  const jsonText = finalText.slice(markerIndex + GEO_PATTERN_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is { description: string; evidenceStrength: GeoEvidenceStrength; source: string; mechanism: string; mechanismDependsOn: ContextDimension[]; platforms: string[] } => {
      if (typeof item !== "object" || item === null) return false;
      const { description, evidenceStrength, source, mechanism, mechanismDependsOn, platforms } = item as Record<string, unknown>;
      return (
        typeof description === "string" &&
        description.trim().length > 0 &&
        typeof evidenceStrength === "string" &&
        GEO_EVIDENCE_VALUES.has(evidenceStrength) &&
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
      evidenceStrength: item.evidenceStrength,
      source: item.source,
      mechanism: item.mechanism,
      mechanismDependsOn: item.mechanismDependsOn,
      platforms: item.platforms,
    }));
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live.
 * WebSearch/WebFetch only. */
export async function researchGeoPatterns(category: string): Promise<GeoPattern[]> {
  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildGeoPatternPrompt(category),
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
  return parseGeoPatterns(finalText, category);
}

// ---------------------------------------------------------------------------
// Generation: grounded Q&A content
// ---------------------------------------------------------------------------

export type GeoAnswer = {
  question: string;
  answer: string;
  /** Which real `AppProfile` facts this answer actually draws from — e.g.
   * "featureMap", "businessModel" — so a grounding check can verify
   * against exactly those fields, not the whole profile diffusely. */
  groundedIn: string[];
};

export type GeoGenerationResult =
  | { status: "generated"; answers: GeoAnswer[] }
  | { status: "no_content_worth_generating"; reason: string };

const GEO_ANSWER_MARKER = "GEO_ANSWERS_JSON:";

function buildGeoGenerationPrompt(appProfile: AppProfile, patterns: GeoPattern[]): string {
  const patternNotes = patterns.length > 0
    ? `\nStructural patterns known to get cited by AI search engines (apply what's genuinely relevant, don't force all of them):\n${patterns.map((p) => `- ${p.description} (${p.evidenceStrength}, ${p.source})`).join("\n")}\n`
    : "";
  return `You are writing GEO (generative-engine optimization) content for a real app —
direct-answer Q&A blocks meant to be accurately cited by AI search engines
(ChatGPT, Claude, Gemini, Perplexity), not ad copy.

Real app grounding (the ONLY source of truth — never state anything about
the app beyond what's here):
- Purpose: ${appProfile.purpose}
- Target users: ${appProfile.targetUsers}
- Real features: ${appProfile.featureMap.join(", ")}
- Business model: ${appProfile.businessModel ?? "not established — do not invent pricing or a business model"}
${appProfile.brand ? `- Audience in their own words: ${appProfile.brand.audience.primary}${appProfile.brand.audience.painPoints.length ? `; pain points: ${appProfile.brand.audience.painPoints.join("; ")}` : ""}\n` : ""}${patternNotes}
Write 3-6 real question-and-answer pairs a genuine prospective user might
ask an AI assistant about this category (e.g. "what's the best way to
track shared expenses") where this app's REAL features are a genuinely
accurate, helpful answer. Each answer should be direct and lead with the
answer itself (per the structural patterns above, where relevant), 1-3
sentences. For each answer, list exactly which real grounding fields above
it actually draws from in \`groundedIn\`.

If the real app grounding genuinely doesn't support any question worth
answering this way (e.g. feature map is empty), say so honestly rather
than padding with generic content.

When finished, end your final message with exactly this marker on its own
line, followed by JSON (and nothing else after it):
${GEO_ANSWER_MARKER}
{"status": "generated", "answers": [{"question": "...", "answer": "...", "groundedIn": ["featureMap"]}, ...]}
or
${GEO_ANSWER_MARKER}
{"status": "no_content_worth_generating", "reason": "..."}`;
}

/** Pure, unit-tested. Fails closed to `no_content_worth_generating` on any
 * parse failure — an unparseable result must never silently become
 * "nothing to generate" being treated as success with zero answers vs. a
 * real failure being hidden. */
export function parseGeoGenerationResult(finalText: string): GeoGenerationResult {
  const markerIndex = finalText.indexOf(GEO_ANSWER_MARKER);
  if (markerIndex === -1) {
    return { status: "no_content_worth_generating", reason: "could not parse a result from the agent's output" };
  }
  const jsonText = finalText.slice(markerIndex + GEO_ANSWER_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { status: "no_content_worth_generating", reason: "malformed JSON after result marker" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "no_content_worth_generating", reason: "result was not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.status === "no_content_worth_generating") {
    return { status: "no_content_worth_generating", reason: typeof obj.reason === "string" ? obj.reason : "not specified" };
  }
  if (obj.status !== "generated" || !Array.isArray(obj.answers)) {
    return { status: "no_content_worth_generating", reason: "result had an invalid shape" };
  }
  const answers = (obj.answers as unknown[]).filter((item): item is GeoAnswer => {
    if (typeof item !== "object" || item === null) return false;
    const { question, answer, groundedIn } = item as Record<string, unknown>;
    return (
      typeof question === "string" && question.trim().length > 0 &&
      typeof answer === "string" && answer.trim().length > 0 &&
      Array.isArray(groundedIn) && groundedIn.every((g) => typeof g === "string")
    );
  });
  if (answers.length === 0) {
    return { status: "no_content_worth_generating", reason: "no valid answers survived parsing" };
  }
  return { status: "generated", answers };
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only live.
 * Pure text in/out, no tools — same as `generateCreatives` for the
 * text-only (no screenshot/video) path. */
export async function generateGeoAnswers(appProfile: AppProfile, patterns: GeoPattern[] = []): Promise<GeoGenerationResult> {
  if (!appProfile.purpose || appProfile.featureMap.length === 0) {
    return { status: "no_content_worth_generating", reason: "mandatory grounding missing: purpose and/or featureMap were never scanned for this app" };
  }
  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildGeoGenerationPrompt(appProfile, patterns),
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
  if (isError) return { status: "no_content_worth_generating", reason: `agent run failed: ${finalText}` };
  return parseGeoGenerationResult(finalText);
}

// ---------------------------------------------------------------------------
// Independent grounding check (safety rail 4's GEO-shaped equivalent)
// ---------------------------------------------------------------------------

export type GeoGroundingVerdict = {
  answer: GeoAnswer;
  grounded: boolean;
  issues: string[];
};

const GEO_GROUNDING_MARKER = "GEO_GROUNDING_JSON:";

function buildGeoGroundingPrompt(answer: GeoAnswer, appProfile: AppProfile): string {
  return `You are an independent fact-checker reviewing GEO (AI-search-answer) content
you did NOT write, before it's allowed to publish. This content is meant
to be cited by AI assistants as an accurate answer — an ungrounded but
confident-sounding answer is worse than no answer, since it gets the app
mis-cited.

Real app grounding (the ONLY source of truth):
- Purpose: ${appProfile.purpose}
- Target users: ${appProfile.targetUsers}
- Real features: ${appProfile.featureMap.join(", ")}
- Business model: ${appProfile.businessModel ?? "not established"}

Content to check:
Question: ${answer.question}
Answer: ${answer.answer}
Claimed grounding: ${answer.groundedIn.join(", ") || "(none listed)"}

Verify the answer against the real app grounding above. Flag anything that
overstates, misrepresents, or isn't actually supported by a real
feature/fact.

When finished, end your final message with exactly this marker on its own
line, followed by JSON (and nothing else after it):
${GEO_GROUNDING_MARKER}
{"grounded": true|false, "issues": ["..."]}

An empty \`issues\` array with \`grounded: true\` is the correct, honest
result when nothing is actually wrong — don't invent issues to seem
thorough.`;
}

/** Pure, unit-tested. Fails closed to `grounded: false` on any parse
 * failure — same direction as `parseClaimCheckVerdict`: an unreadable
 * verdict must never be treated as a passing one. */
export function parseGeoGroundingVerdict(finalText: string, answer: GeoAnswer): GeoGroundingVerdict {
  const markerIndex = finalText.indexOf(GEO_GROUNDING_MARKER);
  if (markerIndex === -1) {
    return { answer, grounded: false, issues: ["could not parse a grounding verdict from the agent's output"] };
  }
  const jsonText = finalText.slice(markerIndex + GEO_GROUNDING_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { answer, grounded: false, issues: ["malformed JSON after grounding-check result marker"] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { answer, grounded: false, issues: ["grounding-check result was not a JSON object"] };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.grounded !== "boolean" || !Array.isArray(obj.issues) || !obj.issues.every((i) => typeof i === "string")) {
    return { answer, grounded: false, issues: ["grounding-check result had an invalid shape"] };
  }
  return { answer, grounded: obj.grounded, issues: obj.issues as string[] };
}

/** Thin, agent-invoking wrapper — a fresh, independent `query()` call that
 * never shares state with `generateGeoAnswers`, same safety-rail-4
 * precedent as `checkTruthfulClaims`. Pure text in/out, no tools. */
export async function checkGeoGrounding(answer: GeoAnswer, appProfile: AppProfile): Promise<GeoGroundingVerdict> {
  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildGeoGroundingPrompt(answer, appProfile),
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
  if (isError) return { answer, grounded: false, issues: [`agent run failed: ${finalText}`] };
  return parseGeoGroundingVerdict(finalText, answer);
}
