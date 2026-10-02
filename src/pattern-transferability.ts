import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AppStage } from "./growth-strategy";

/**
 * Tier 0 epistemic core (docs/distribution-intelligence.md, "The Tier 0
 * algorithm") — the layer that decides how much a cross-app research
 * finding should actually be trusted, separate from whether the finding
 * itself is real.
 *
 * The problem this file exists to solve: `growth-patterns.ts`'s
 * `EvidenceStrength`/`OrganicEvidenceStrength` and `growth-geo.ts`'s
 * `GeoEvidenceStrength` all measure ONE axis — how directly observable a
 * single instance is (is this really a platform ranking, is this ad
 * really still running). None of them answer a completely different
 * question: would this pattern hold for a DIFFERENT app, in a DIFFERENT
 * context? Treating "evidence this one company did X" as equivalent to "X
 * works" is the inference failure this file is built against —
 * survivorship bias (the companies that tried the same tactic and failed
 * are invisible by default), confounding (successful companies differ on
 * dozens of dimensions at once, not just the one tactic highlighted),
 * narrator bias (a founder retrospective has every incentive to tell a
 * clean causal story), and context-boundedness (a tactic tied to one
 * platform's algorithm at one moment is not a timeless principle).
 *
 * Source-agnostic by design: wraps observations from ANY of
 * `growth-patterns.ts`'s `ProvenPattern`/`OrganicPattern`/
 * `StageComparableInsight` or `growth-geo.ts`'s `GeoPattern` without
 * importing their types — what's modeled here (does this generalize
 * across independent instances) is orthogonal to which research function
 * produced the underlying instance.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 15;
const MAX_BUDGET_USD = 0.5;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type ContextDimension = "category" | "platform" | "stage" | "era";
/** Shared validation set — every research function's parser (growth-
 * patterns.ts, growth-geo.ts) validates its agent-supplied
 * `mechanismDependsOn` array against this same list, so "which dimensions
 * are even recognized" has exactly one source of truth. */
export const CONTEXT_DIMENSIONS: readonly ContextDimension[] = ["category", "platform", "stage", "era"];
export type Era = "pre_2023" | "2023_2024" | "2025_plus";

export type PatternContext = {
  categories: string[];
  /** Empty when the pattern is platform-agnostic. */
  platforms: string[];
  stage?: AppStage;
  era?: Era;
};

/** Raw per-observation evidence tag, carried over from whichever research
 * function produced it (`EvidenceStrength`/`OrganicEvidenceStrength`/
 * `GeoEvidenceStrength`, or a plain descriptive string for a
 * `StageComparableInsight`, which has no such tag of its own). This file
 * only needs to classify it first-party vs. inferred — never re-derives
 * the tag itself. */
export type SourceObservation = {
  sourceId: string;
  sourceDescription: string;
  context: PatternContext;
  rawEvidenceTag: string;
};

export type CounterEvidenceSeverity = "direct_contradiction" | "contextual_caveat" | "expert_skepticism";

export type CounterEvidence = {
  severity: CounterEvidenceSeverity;
  description: string;
  source: string;
};

export type EvidenceBasis = "first_party" | "mixed" | "inferred_only";
export type TransferabilityTier = "single_observation" | "replicated_same_context" | "replicated_cross_context";
export type StalenessRisk = "low" | "medium" | "high";

export type TransferablePattern = {
  id: string;
  /** The distilled, structural claim — "why it works," not "what one
   * company did." */
  description: string;
  /** Required. Forces every pattern to state WHY it would transfer,
   * separately from WHAT was observed. */
  mechanism: string;
  /** Which context dimensions the STATED mechanism itself claims matter —
   * drives Stage 4's context-overlap computation. A mechanism naming a
   * specific platform/moment is itself the signal that a pattern is
   * context-bound; this field is what makes that distinction computable
   * instead of buried in prose. */
  mechanismDependsOn: ContextDimension[];
  observations: SourceObservation[];
  counterEvidence: CounterEvidence[];
  /** Distinguishes "checked, found nothing" from "never checked" — only
   * the former should ever contribute to confidence (Stage 2). */
  counterEvidenceChecked: boolean;
  tier: TransferabilityTier;
  evidenceBasis: EvidenceBasis;
  lastValidatedAt: string;
};

// ---------------------------------------------------------------------------
// Stage 4 — tier computation
// ---------------------------------------------------------------------------

/** Shared validation, reused by every research function's parser
 * (growth-patterns.ts, growth-geo.ts) so "is this a well-formed
 * mechanismDependsOn array" has exactly one implementation. An empty
 * array is valid — it's the honest encoding of "this mechanism is claimed
 * to be fully general." */
export function isValidMechanismDependsOn(value: unknown): value is ContextDimension[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && (CONTEXT_DIMENSIONS as readonly string[]).includes(v));
}

function contextsOverlapOnDependencies(a: PatternContext, b: PatternContext, dependsOn: ContextDimension[]): boolean {
  for (const dim of dependsOn) {
    if (dim === "category") {
      if (!a.categories.some((c) => b.categories.includes(c))) return false;
    } else if (dim === "platform") {
      if (!(a.platforms.length > 0 && b.platforms.length > 0 && a.platforms.some((p) => b.platforms.includes(p)))) return false;
    } else if (dim === "stage") {
      if (a.stage === undefined || b.stage === undefined || a.stage !== b.stage) return false;
    } else if (dim === "era") {
      if (a.era === undefined || b.era === undefined || a.era !== b.era) return false;
    }
  }
  return true;
}

/**
 * Pure, unit-tested — the heart of the dependency-aware version of Stage
 * 4. A dimension not in `mechanismDependsOn` is irrelevant to this check
 * by construction: two observations differing only on a dimension the
 * mechanism never claimed mattered don't prove anything either way. An
 * EMPTY `mechanismDependsOn` (a mechanism asserted as fully general, no
 * claimed dependency at all) means every real pair counts as
 * cross-context, since there's no stated dimension left for them to
 * share — the strongest possible claim gets the strongest possible test.
 */
export function isCrossContextReplication(a: PatternContext, b: PatternContext, mechanismDependsOn: ContextDimension[]): boolean {
  if (mechanismDependsOn.length === 0) return true;
  return !contextsOverlapOnDependencies(a, b, mechanismDependsOn);
}

/**
 * Pure, unit-tested. A single observation is always `single_observation`
 * — tier is earned by replication, never self-asserted. Two or more
 * observations that differ on at least one dimension the mechanism itself
 * claims matters earn `replicated_cross_context`, the strongest tier,
 * precisely because convergence despite a changed relevant dimension is
 * what rules out "it's just what this category/platform/stage/era does."
 * Observations that always share every dependency dimension, no matter
 * how many of them, only ever reach `replicated_same_context`.
 */
export function deriveRawTier(observations: SourceObservation[], mechanismDependsOn: ContextDimension[]): TransferabilityTier {
  if (observations.length <= 1) return "single_observation";
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      if (isCrossContextReplication(observations[i]!.context, observations[j]!.context, mechanismDependsOn)) {
        return "replicated_cross_context";
      }
    }
  }
  return "replicated_same_context";
}

// ---------------------------------------------------------------------------
// Stage 2 — counter-evidence hard cap
// ---------------------------------------------------------------------------

/**
 * Pure, unit-tested. A hard decision rule, not a soft weight: a real,
 * cited counter-example of the SAME tactic failing caps a pattern at
 * `single_observation` regardless of how much confirming replication
 * exists elsewhere — a known counter-example disqualifies high
 * confidence, it doesn't average out against it. `contextual_caveat`/
 * `expert_skepticism` never cap the tier (they narrow context / attach a
 * caveat instead — the caller's job, not this function's).
 */
export function applyCounterEvidenceCap(rawTier: TransferabilityTier, counterEvidence: CounterEvidence[]): TransferabilityTier {
  const hasDirectContradiction = counterEvidence.some((c) => c.severity === "direct_contradiction");
  return hasDirectContradiction ? "single_observation" : rawTier;
}

export function deriveTier(
  observations: SourceObservation[],
  mechanismDependsOn: ContextDimension[],
  counterEvidence: CounterEvidence[],
): TransferabilityTier {
  return applyCounterEvidenceCap(deriveRawTier(observations, mechanismDependsOn), counterEvidence);
}

// ---------------------------------------------------------------------------
// Stage 5 — evidence directness (a second, orthogonal axis)
// ---------------------------------------------------------------------------

/** The one raw evidence tag across every research function in this
 * codebase that means "inferred from a proxy signal," not "directly
 * observed." Everything else (`platform_ranked`, `published_case_study`,
 * `award_judged`, `platform_trending`, `creator_public_metrics`,
 * `industry_published`, `platform_documented`, and a plain
 * `StageComparableInsight` narrative) is a genuinely observed fact, even
 * when it's weak evidence of GENERALIZABILITY (that's tier's job, a
 * separate axis) — `longevity_proxy` alone is an inference about the
 * instance itself ("still running" implies "probably working," never
 * confirmed). */
const INFERRED_EVIDENCE_TAGS = new Set(["longevity_proxy"]);

/** Pure, unit-tested. Tier and evidence basis never collapse into one
 * number — a `replicated_cross_context` pattern built entirely from
 * inferred proxies is a different claim than one backed by first-party
 * sources, and both facts should be visible, not averaged away. */
export function deriveEvidenceBasis(observations: SourceObservation[]): EvidenceBasis {
  if (observations.length === 0) return "inferred_only";
  const firstParty = observations.filter((o) => !INFERRED_EVIDENCE_TAGS.has(o.rawEvidenceTag)).length;
  if (firstParty === observations.length) return "first_party";
  if (firstParty === 0) return "inferred_only";
  return "mixed";
}

// ---------------------------------------------------------------------------
// Stage 7 — freshness and decay
// ---------------------------------------------------------------------------

/** Pure, unit-tested. Derived directly from `mechanismDependsOn`, not a
 * separate judgment call: a mechanism that claims platform or era
 * dependency is explicitly claiming it could stop being true as the
 * platform/moment changes, so it decays fast. A mechanism asserted as
 * fully general (no stated dependency) decays slowly — there's no stated
 * reason it would go stale, though real counter-evidence could still
 * surface later via a fresh adversarial pass. */
export function deriveStalenessRisk(mechanismDependsOn: ContextDimension[]): StalenessRisk {
  if (mechanismDependsOn.includes("era") || mechanismDependsOn.includes("platform")) return "high";
  if (mechanismDependsOn.includes("category") || mechanismDependsOn.includes("stage")) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Pattern construction / mutation
// ---------------------------------------------------------------------------

export function newPatternFromObservation(
  id: string,
  description: string,
  mechanism: string,
  mechanismDependsOn: ContextDimension[],
  observation: SourceObservation,
  counterEvidence: CounterEvidence[],
  counterEvidenceChecked: boolean,
  now: string,
): TransferablePattern {
  return {
    id,
    description,
    mechanism,
    mechanismDependsOn,
    observations: [observation],
    counterEvidence,
    counterEvidenceChecked,
    tier: deriveTier([observation], mechanismDependsOn, counterEvidence),
    evidenceBasis: deriveEvidenceBasis([observation]),
    lastValidatedAt: now,
  };
}

/** Pure. Appending a new independent observation always re-derives tier
 * and evidence basis from the real, now-larger set — never incremented by
 * hand, so neither can silently drift out of sync with what they're
 * computed from. Counter-evidence found on the new observation's own
 * adversarial pass is merged in, never discarded. */
export function addObservation(
  pattern: TransferablePattern,
  observation: SourceObservation,
  newCounterEvidence: CounterEvidence[],
  now: string,
): TransferablePattern {
  const observations = [...pattern.observations, observation];
  const counterEvidence = [...pattern.counterEvidence, ...newCounterEvidence];
  return {
    ...pattern,
    observations,
    counterEvidence,
    tier: deriveTier(observations, pattern.mechanismDependsOn, counterEvidence),
    evidenceBasis: deriveEvidenceBasis(observations),
    lastValidatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Plain-language, matching every other render function's no-jargon style
 * — deliberately calibrated per tier, since the whole point is that these
 * should never read as equally confident. */
export function renderTransferabilityTier(tier: TransferabilityTier): string {
  switch (tier) {
    case "single_observation":
      return "A single example — worth testing cheaply, not yet a proven pattern. One company's story, told in hindsight, is not evidence it would work for a different app.";
    case "replicated_same_context":
      return "Observed independently across multiple sources in the same category/platform/stage/era — a real pattern for apps like this one, but not yet confirmed to generalize beyond this specific context.";
    case "replicated_cross_context":
      return "Observed independently across sources that differ on a dimension the mechanism itself claims matters, converging anyway — the strongest tier this system assigns, because it held despite the context changing.";
  }
}

/** Plain-language, full pattern summary — always surfaces tier, evidence
 * basis, and any counter-evidence together, never collapsed into one
 * score (Stage 8's honesty requirement). */
export function renderPatternSummary(pattern: TransferablePattern): string {
  const lines: string[] = [
    `"${pattern.description}" (${pattern.observations.length} observation${pattern.observations.length === 1 ? "" : "s"})`,
    `Mechanism: ${pattern.mechanism}`,
    renderTransferabilityTier(pattern.tier),
    `Evidence basis: ${pattern.evidenceBasis}.`,
  ];
  if (!pattern.counterEvidenceChecked) {
    lines.push("Counter-evidence: not yet checked.");
  } else if (pattern.counterEvidence.length === 0) {
    lines.push("Counter-evidence: checked, none found.");
  } else {
    for (const ce of pattern.counterEvidence) {
      lines.push(`Counter-evidence (${ce.severity}): ${ce.description} — ${ce.source}`);
    }
  }
  const staleness = deriveStalenessRisk(pattern.mechanismDependsOn);
  if (staleness !== "low") {
    lines.push(`Staleness risk: ${staleness} (last validated ${pattern.lastValidatedAt}).`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stage 2 — adversarial / disconfirming research pass
// ---------------------------------------------------------------------------

const COUNTER_EVIDENCE_MARKER = "COUNTER_EVIDENCE_JSON:";
const COUNTER_EVIDENCE_SEVERITIES = new Set(["direct_contradiction", "contextual_caveat", "expert_skepticism"]);

function buildCounterEvidencePrompt(candidate: { description: string; mechanism: string }, category: string): string {
  return `You are an adversarial reviewer trying to REFUTE a growth pattern someone else
found, for the "${category}" category — you have no stake in it being right,
only in finding the truth if it's wrong or overstated.

Pattern to refute:
Description: ${candidate.description}
Claimed mechanism: ${candidate.mechanism}

Search specifically for:
1. A real, named company or creator that tried the SAME or a very similar
   tactic and explicitly said it did NOT work, or it backfired.
2. Real industry/expert critique arguing this tactic is overrated, doesn't
   generalize, or is specific to a narrow moment/platform.
3. Evidence this is already known to be era- or platform-specific — e.g.
   it depended on an algorithm change, a cultural moment, or a platform
   feature that no longer exists.

Useful genres to check specifically, since failures are rarely
self-reported the way successes are: startup-postmortem sites (Failory,
CB Insights' failure retrospectives), "what didn't work" threads (Indie
Hackers), and any academic/industry-research piece that states the
boundary conditions under which an effect like this does NOT hold.

Classify each real thing you find as exactly one of: "direct_contradiction"
(a real case of the same tactic failing), "contextual_caveat" (works in
one context, explicitly doesn't translate to another), "expert_skepticism"
(a real critique, no concrete counter-example). Cite a real, checkable
source for each — never invent one.

When finished, end your final message with exactly this marker on its own
line, followed by a JSON array (and nothing else after it):
${COUNTER_EVIDENCE_MARKER}
[{"severity": "direct_contradiction"|"contextual_caveat"|"expert_skepticism", "description": "...", "source": "..."}, ...]

An empty array (${COUNTER_EVIDENCE_MARKER}\n[]) is a legitimate, honest
result if you genuinely searched and found nothing worth reporting — don't
invent counter-evidence just to seem balanced.`;
}

/** Pure, unit-tested. Fails closed to an empty array AND `checked: false`
 * on any parse failure — distinct from a genuine empty search result
 * (`checked: true, evidence: []`), since only a confirmed, completed
 * search should ever count as "checked and clean." */
export function parseCounterEvidence(finalText: string, isError: boolean): { checked: boolean; evidence: CounterEvidence[] } {
  if (isError) return { checked: false, evidence: [] };

  const markerIndex = finalText.indexOf(COUNTER_EVIDENCE_MARKER);
  if (markerIndex === -1) return { checked: false, evidence: [] };

  const jsonText = finalText.slice(markerIndex + COUNTER_EVIDENCE_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { checked: false, evidence: [] };
  }
  if (!Array.isArray(parsed)) return { checked: false, evidence: [] };

  const evidence = parsed.filter((item): item is CounterEvidence => {
    if (typeof item !== "object" || item === null) return false;
    const { severity, description, source } = item as Record<string, unknown>;
    return (
      typeof severity === "string" &&
      COUNTER_EVIDENCE_SEVERITIES.has(severity) &&
      typeof description === "string" &&
      description.trim().length > 0 &&
      typeof source === "string" &&
      source.trim().length > 0
    );
  });
  return { checked: true, evidence };
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only
 * live. A fresh, independent `query()` call that never shares context
 * with whatever found the original pattern, same safety-rail-4 precedent
 * as `checkTruthfulClaims`. WebSearch/WebFetch only. */
export async function findCounterEvidence(
  candidate: { description: string; mechanism: string },
  category: string,
): Promise<{ checked: boolean; evidence: CounterEvidence[] }> {
  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildCounterEvidencePrompt(candidate, category),
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
  return parseCounterEvidence(finalText, isError);
}

// ---------------------------------------------------------------------------
// Stage 3 — matching against the existing library
// ---------------------------------------------------------------------------

export type ExistingPatternSummary = { id: string; description: string; mechanism: string };

const MATCH_MARKER = "PATTERN_MATCH_JSON:";

function buildMatchPrompt(candidate: { description: string; mechanism: string }, existing: ExistingPatternSummary[]): string {
  const list = existing.map((p) => `- id "${p.id}": ${p.description}\n  Mechanism: ${p.mechanism}`).join("\n");
  return `You are deciding whether a newly-found growth pattern describes the SAME
underlying structural mechanism as one already in a pattern library — not
whether they're superficially about the same topic, whether the actual
causal claim is the same.

New pattern:
Description: ${candidate.description}
Mechanism: ${candidate.mechanism}

Candidate existing patterns (already shortlisted as plausibly related):
${list || "(none shortlisted)"}

A match means: if you had to bet, is the new pattern really the SAME
underlying mechanism observed again (possibly different words, a
different company, a different category), or a genuinely different
pattern that happens to sound similar on the surface? Two patterns that
both mention "social proof," say, are not automatically the same mechanism
— don't match them just because both cite a similar-sounding keyword. Err
toward NOT matching when genuinely unsure — a false merge corrupts the
replication count more than a missed merge costs.

When finished, end your final message with exactly this marker on its own
line, followed by JSON (and nothing else after it):
${MATCH_MARKER}
{"matchedPatternId": "<id>"} or {"matchedPatternId": null}`;
}

/** Pure, unit-tested. Fails closed to `null` (no match) — an unparseable
 * response must never be treated as a confident match. */
export function parsePatternMatch(finalText: string): string | null {
  const markerIndex = finalText.indexOf(MATCH_MARKER);
  if (markerIndex === -1) return null;
  const jsonText = finalText.slice(markerIndex + MATCH_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const id = (parsed as Record<string, unknown>).matchedPatternId;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

/** Pure, unit-tested. The cheap keyword pre-filter ahead of the LLM match
 * call — shortlists existing patterns sharing at least one real word (3+
 * chars, to skip stopword-ish noise) with the candidate's own description,
 * so the LLM call only ever compares against plausibly-related entries,
 * not the whole library. */
export function shortlistCandidates(
  candidateDescription: string,
  existing: ExistingPatternSummary[],
  limit: number = 5,
): ExistingPatternSummary[] {
  const words = new Set(candidateDescription.toLowerCase().split(/\W+/).filter((w) => w.length >= 3));
  const scored = existing
    .map((p) => {
      const pWords = p.description.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
      const overlap = pWords.filter((w) => words.has(w)).length;
      return { pattern: p, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, limit).map((s) => s.pattern);
}

/** Thin, agent-invoking wrapper — zero unit coverage, validated only
 * live. Pure text in/out, no tools — a judgment call over already-known
 * text, not a research task. */
export async function matchToExistingPattern(
  candidate: { description: string; mechanism: string },
  existing: ExistingPatternSummary[],
): Promise<string | null> {
  const shortlist = shortlistCandidates(candidate.description, existing);
  if (shortlist.length === 0) return null;

  let finalText = "";
  let isError = false;
  try {
    for await (const message of query({
      prompt: buildMatchPrompt(candidate, shortlist),
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
  if (isError) return null;
  return parsePatternMatch(finalText);
}
