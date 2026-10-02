import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AppStage } from "./growth-strategy";
import {
  addObservation,
  findCounterEvidence,
  matchToExistingPattern,
  newPatternFromObservation,
  type ContextDimension,
  type PatternContext,
  type TransferablePattern,
} from "./pattern-transferability";
import { researchGeoPatterns } from "./growth-geo";
import { researchOrganicPatterns, researchProvenPatterns, researchStageComparables } from "./growth-patterns";
import type { GeoPattern } from "./growth-geo";
import type { OrganicPattern, ProvenPattern, StageComparableInsight } from "./growth-patterns";

/**
 * Platform-level, persistent, category-indexed pattern library
 * (docs/distribution-intelligence.md, Phase 1 "Bootstrap Tier 0") — the
 * orchestration layer tying Stages 1-5 together: check the shared library
 * first; only research live (and pay the real agent cost) when a
 * category/research-type combination hasn't been checked recently.
 *
 * Platform-level, not per-app — same class of file as
 * `growth-tools-config.ts`'s `.day2-platform-tools.json`: every app day2
 * powers shares ONE library, because the whole point is that a research
 * pass run for one customer's category benefits every other customer in
 * or near that category, immediately, including the very first customer
 * in a category nobody's asked about yet (the proactive-seeding use case,
 * see `seed-pattern-library-cli.ts`).
 *
 * This is the piece that directly answers "users need immediate benefit,
 * compounding can't wait years to start" — the library is what makes a
 * brand-new customer's first session show real, tiered research instead
 * of a blank slate, while every subsequent research pass for ANY customer
 * makes the shared asset richer for all of them.
 */

export type ResearchType = "proven" | "organic" | "geo" | "stage_comparable";

/** Disclosed judgment calls, not derived from anything — organic/GEO
 * research is explicitly flagged in docs/distribution-intelligence.md as
 * thinner and faster-moving than paid-ad research, so it's re-checked
 * more often; stage-comparable research (how a company behaved years ago)
 * is the slowest-moving by nature. */
const DEFAULT_FRESHNESS_DAYS: Record<ResearchType, number> = {
  proven: 30,
  organic: 14,
  geo: 30,
  stage_comparable: 90,
};

export type DataSparsity = "thin" | "adequate";

/** Threshold below which a sweep is honestly flagged `thin` rather than
 * silently presented as a complete picture — a disclosed judgment call,
 * matching docs/distribution-intelligence.md's "say so rather than paper
 * over it" requirement for organic content's real data-sparsity problem. */
const SPARSE_PATTERN_COUNT_THRESHOLD = 2;

export type SweepRecord = {
  category: string;
  researchType: ResearchType;
  lastSweptAt: string;
  dataSparsity: DataSparsity;
  patternsFound: number;
};

export type PatternLibrary = {
  patterns: TransferablePattern[];
  sweeps: SweepRecord[];
  updatedAt: string;
};

export const PATTERN_LIBRARY_FILENAME = ".day2-pattern-library.json";

function defaultPatternLibrary(): PatternLibrary {
  return { patterns: [], sweeps: [], updatedAt: new Date(0).toISOString() };
}

function isValidPatternContext(value: unknown): value is PatternContext {
  if (typeof value !== "object" || value === null) return false;
  const { categories, platforms } = value as Record<string, unknown>;
  return (
    Array.isArray(categories) &&
    categories.every((c) => typeof c === "string") &&
    Array.isArray(platforms) &&
    platforms.every((p) => typeof p === "string")
  );
}

function isValidPattern(value: unknown): value is TransferablePattern {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.description === "string" &&
    typeof p.mechanism === "string" &&
    Array.isArray(p.mechanismDependsOn) &&
    Array.isArray(p.observations) &&
    p.observations.every(
      (o) =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as Record<string, unknown>).sourceId === "string" &&
        isValidPatternContext((o as Record<string, unknown>).context),
    ) &&
    Array.isArray(p.counterEvidence) &&
    typeof p.counterEvidenceChecked === "boolean" &&
    typeof p.tier === "string" &&
    typeof p.evidenceBasis === "string" &&
    typeof p.lastValidatedAt === "string"
  );
}

function isValidSweep(value: unknown): value is SweepRecord {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.category === "string" &&
    typeof s.researchType === "string" &&
    typeof s.lastSweptAt === "string" &&
    (s.dataSparsity === "thin" || s.dataSparsity === "adequate") &&
    typeof s.patternsFound === "number"
  );
}

export function loadPatternLibrary(path: string): PatternLibrary {
  if (!existsSync(path)) return defaultPatternLibrary();
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but isn't valid JSON — fix or remove it by hand before using this tool.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} exists but doesn't look like a valid pattern library — refusing to guess or overwrite it.`);
  }
  const lib = parsed as Record<string, unknown>;
  if (
    !Array.isArray(lib.patterns) ||
    !lib.patterns.every(isValidPattern) ||
    !Array.isArray(lib.sweeps) ||
    !lib.sweeps.every(isValidSweep) ||
    typeof lib.updatedAt !== "string"
  ) {
    throw new Error(`${path} exists but doesn't look like a valid pattern library — refusing to guess or overwrite it.`);
  }
  return parsed as PatternLibrary;
}

export function savePatternLibrary(path: string, library: PatternLibrary): void {
  writeFileSync(path, `${JSON.stringify(library, null, 2)}\n`);
}

export function findSweep(library: PatternLibrary, category: string, researchType: ResearchType): SweepRecord | undefined {
  return library.sweeps.find((s) => s.category === category && s.researchType === researchType);
}

/** Pure, unit-tested. An absent sweep is never fresh — "never checked" and
 * "checked a long time ago" both mean "research live now," distinguished
 * only by whether a sweep record exists at all. */
export function isSweepFresh(sweep: SweepRecord | undefined, now: Date, maxAgeDays: number): boolean {
  if (!sweep) return false;
  const ageMs = now.getTime() - new Date(sweep.lastSweptAt).getTime();
  return ageMs < maxAgeDays * 24 * 60 * 60 * 1000;
}

export function deriveDataSparsity(patternsFound: number): DataSparsity {
  return patternsFound < SPARSE_PATTERN_COUNT_THRESHOLD ? "thin" : "adequate";
}

/** Pure. Replaces any existing sweep for the same (category, researchType)
 * — a library only ever tracks the MOST RECENT sweep per combination, not
 * a growing history of every past check. */
export function recordSweep(library: PatternLibrary, sweep: SweepRecord, now: string): PatternLibrary {
  const sweeps = [...library.sweeps.filter((s) => !(s.category === sweep.category && s.researchType === sweep.researchType)), sweep];
  return { ...library, sweeps, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Normalizing each research function's output into a common candidate shape
// ---------------------------------------------------------------------------

export type RawCandidate = {
  description: string;
  mechanism: string;
  mechanismDependsOn: ContextDimension[];
  rawEvidenceTag: string;
  sourceDescription: string;
  context: PatternContext;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

export function provenPatternToCandidate(p: ProvenPattern): RawCandidate {
  return {
    description: p.description,
    mechanism: p.mechanism,
    mechanismDependsOn: p.mechanismDependsOn,
    rawEvidenceTag: p.evidenceStrength,
    sourceDescription: p.source,
    context: { categories: [p.category], platforms: p.platforms },
  };
}

export function organicPatternToCandidate(p: OrganicPattern): RawCandidate {
  return {
    description: p.description,
    mechanism: p.mechanism,
    mechanismDependsOn: p.mechanismDependsOn,
    rawEvidenceTag: p.evidenceStrength,
    sourceDescription: p.source,
    context: { categories: [p.category], platforms: p.platforms },
  };
}

export function geoPatternToCandidate(p: GeoPattern): RawCandidate {
  return {
    description: p.description,
    mechanism: p.mechanism,
    mechanismDependsOn: p.mechanismDependsOn,
    rawEvidenceTag: p.evidenceStrength,
    sourceDescription: p.source,
    context: { categories: [p.category], platforms: p.platforms },
  };
}

/** `StageComparableInsight` has no raw evidence-strength tag of its own
 * (it's always a company-research narrative, not a platform/award/
 * longevity classification) — tagged `"comparable_company_research"`,
 * which `deriveEvidenceBasis` (pattern-transferability.ts) treats as
 * first-party (not in the inferred set), matching its real nature: a
 * Wayback Machine snapshot or founder interview is a directly observed
 * fact, not a proxy inference. */
export function stageComparableToCandidate(p: StageComparableInsight): RawCandidate {
  return {
    description: p.strategy,
    mechanism: p.mechanism,
    mechanismDependsOn: p.mechanismDependsOn,
    rawEvidenceTag: "comparable_company_research",
    sourceDescription: `${p.company} (${p.approxDate}): ${p.evidence} — ${p.source}`,
    context: { categories: [p.category], platforms: p.platforms, stage: p.observedStage },
  };
}

// ---------------------------------------------------------------------------
// Stages 2-3-4-5, tied together: integrate one candidate into the library
// ---------------------------------------------------------------------------

/** Pure given already-computed counter-evidence and match result — the
 * actual agent calls (`findCounterEvidence`, `matchToExistingPattern`)
 * happen in `ingestCandidate` below, kept separate here so the merge
 * decision itself is independently testable without a live agent. */
export function integrateCandidate(
  library: PatternLibrary,
  candidate: RawCandidate,
  counterEvidence: { checked: boolean; evidence: Array<TransferablePattern["counterEvidence"][number]> },
  matchedPatternId: string | null,
  now: string,
): PatternLibrary {
  const observation = {
    sourceId: slugify(candidate.sourceDescription),
    sourceDescription: candidate.sourceDescription,
    context: candidate.context,
    rawEvidenceTag: candidate.rawEvidenceTag,
  };

  if (matchedPatternId) {
    const existing = library.patterns.find((p) => p.id === matchedPatternId);
    if (existing) {
      const updated = addObservation(existing, observation, counterEvidence.evidence, now);
      return {
        ...library,
        patterns: library.patterns.map((p) => (p.id === matchedPatternId ? updated : p)),
        updatedAt: now,
      };
    }
  }

  const newPattern = newPatternFromObservation(
    slugify(candidate.description),
    candidate.description,
    candidate.mechanism,
    candidate.mechanismDependsOn,
    observation,
    counterEvidence.evidence,
    counterEvidence.checked,
    now,
  );
  return { ...library, patterns: [...library.patterns, newPattern], updatedAt: now };
}

/** Thin, agent-invoking wrapper around `integrateCandidate` — runs the
 * real Stage 2 (adversarial) and Stage 3 (matching) agent calls for one
 * candidate, then applies the pure merge logic. Zero unit coverage by
 * nature, validated only live. */
export async function ingestCandidate(library: PatternLibrary, candidate: RawCandidate, category: string, now: string): Promise<PatternLibrary> {
  const counterEvidence = await findCounterEvidence({ description: candidate.description, mechanism: candidate.mechanism }, category);
  const existingSummaries = library.patterns.map((p) => ({ id: p.id, description: p.description, mechanism: p.mechanism }));
  const matchedPatternId = await matchToExistingPattern({ description: candidate.description, mechanism: candidate.mechanism }, existingSummaries);
  return integrateCandidate(library, candidate, counterEvidence, matchedPatternId, now);
}

// ---------------------------------------------------------------------------
// The orchestration entry point — "check library first, else research live"
// ---------------------------------------------------------------------------

export type GetOrResearchResult = { library: PatternLibrary; patterns: TransferablePattern[]; freshlyResearched: boolean };

/** The one function everything else in this file exists to support. Checks
 * the shared library first; if the (category, researchType) sweep is
 * fresh, returns the already-known patterns at zero cost and zero
 * latency. Otherwise researches live, runs every new candidate through
 * the real Stage 2/3 pipeline, records the sweep (with an honest
 * `dataSparsity` flag), and persists the updated library before
 * returning. `targetStage` is only used for `researchType: "stage_comparable"`. */
export async function getOrResearchPatterns(
  libraryPath: string,
  category: string,
  researchType: ResearchType,
  now: Date = new Date(),
  targetStage?: AppStage,
): Promise<GetOrResearchResult> {
  let library = loadPatternLibrary(libraryPath);
  const sweep = findSweep(library, category, researchType);
  const nowIso = now.toISOString();

  if (isSweepFresh(sweep, now, DEFAULT_FRESHNESS_DAYS[researchType])) {
    const patterns = library.patterns.filter((p) => p.observations.some((o) => o.context.categories.includes(category)));
    return { library, patterns, freshlyResearched: false };
  }

  let candidates: RawCandidate[];
  if (researchType === "proven") {
    candidates = (await researchProvenPatterns(category)).map(provenPatternToCandidate);
  } else if (researchType === "organic") {
    candidates = (await researchOrganicPatterns(category)).map(organicPatternToCandidate);
  } else if (researchType === "geo") {
    candidates = (await researchGeoPatterns(category)).map(geoPatternToCandidate);
  } else {
    if (!targetStage) throw new Error('getOrResearchPatterns: targetStage is required for researchType "stage_comparable".');
    candidates = (await researchStageComparables(category, targetStage)).map(stageComparableToCandidate);
  }

  for (const candidate of candidates) {
    library = await ingestCandidate(library, candidate, category, nowIso);
  }

  library = recordSweep(
    library,
    { category, researchType, lastSweptAt: nowIso, dataSparsity: deriveDataSparsity(candidates.length), patternsFound: candidates.length },
    nowIso,
  );
  savePatternLibrary(libraryPath, library);

  const patterns = library.patterns.filter((p) => p.observations.some((o) => o.context.categories.includes(category)));
  return { library, patterns, freshlyResearched: true };
}
