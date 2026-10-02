import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveDataSparsity,
  findSweep,
  geoPatternToCandidate,
  integrateCandidate,
  isSweepFresh,
  loadPatternLibrary,
  organicPatternToCandidate,
  provenPatternToCandidate,
  recordSweep,
  savePatternLibrary,
  stageComparableToCandidate,
} from "./pattern-library";
import type { PatternLibrary, SweepRecord } from "./pattern-library";
import type { GeoPattern } from "./growth-geo";
import type { OrganicPattern, ProvenPattern, StageComparableInsight } from "./growth-patterns";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "day2-pattern-library-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function emptyLibrary(): PatternLibrary {
  return { patterns: [], sweeps: [], updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("loadPatternLibrary / savePatternLibrary", () => {
  test("returns an empty library when no file exists yet", () => {
    withTmpDir((dir) => {
      const lib = loadPatternLibrary(join(dir, ".day2-pattern-library.json"));
      expect(lib.patterns).toEqual([]);
      expect(lib.sweeps).toEqual([]);
    });
  });

  test("round-trips a real library with a real pattern and sweep", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-pattern-library.json");
      const library: PatternLibrary = {
        patterns: [
          {
            id: "p1",
            description: "d",
            mechanism: "m",
            mechanismDependsOn: ["platform"],
            observations: [{ sourceId: "s1", sourceDescription: "sd", context: { categories: ["cat"], platforms: ["tiktok"] }, rawEvidenceTag: "platform_trending" }],
            counterEvidence: [],
            counterEvidenceChecked: true,
            tier: "single_observation",
            evidenceBasis: "first_party",
            lastValidatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sweeps: [{ category: "cat", researchType: "organic", lastSweptAt: "2026-01-01T00:00:00.000Z", dataSparsity: "adequate", patternsFound: 3 }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      savePatternLibrary(path, library);
      expect(loadPatternLibrary(path)).toEqual(library);
    });
  });

  test("throws on invalid JSON rather than silently overwriting", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-pattern-library.json");
      writeFileSync(path, "not json");
      expect(() => loadPatternLibrary(path)).toThrow();
    });
  });

  test("throws on JSON that doesn't look like a valid library", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-pattern-library.json");
      writeFileSync(path, JSON.stringify({ foo: "bar" }));
      expect(() => loadPatternLibrary(path)).toThrow();
    });
  });

  test("throws when a sweep's dataSparsity is outside the closed set", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-pattern-library.json");
      writeFileSync(path, JSON.stringify({ patterns: [], sweeps: [{ category: "c", researchType: "organic", lastSweptAt: "x", dataSparsity: "kinda", patternsFound: 1 }], updatedAt: "x" }));
      expect(() => loadPatternLibrary(path)).toThrow();
    });
  });
});

describe("findSweep", () => {
  test("finds a sweep matching both category and researchType", () => {
    const library: PatternLibrary = {
      ...emptyLibrary(),
      sweeps: [{ category: "finance", researchType: "organic", lastSweptAt: "2026-01-01T00:00:00.000Z", dataSparsity: "adequate", patternsFound: 3 }],
    };
    expect(findSweep(library, "finance", "organic")?.patternsFound).toBe(3);
  });

  test("returns undefined when category matches but researchType doesn't", () => {
    const library: PatternLibrary = {
      ...emptyLibrary(),
      sweeps: [{ category: "finance", researchType: "organic", lastSweptAt: "2026-01-01T00:00:00.000Z", dataSparsity: "adequate", patternsFound: 3 }],
    };
    expect(findSweep(library, "finance", "proven")).toBeUndefined();
  });
});

describe("isSweepFresh", () => {
  test("an absent sweep is never fresh", () => {
    expect(isSweepFresh(undefined, new Date("2026-01-01T00:00:00.000Z"), 30)).toBe(false);
  });

  test("a sweep within the freshness window is fresh", () => {
    const sweep: SweepRecord = { category: "c", researchType: "organic", lastSweptAt: "2026-01-01T00:00:00.000Z", dataSparsity: "adequate", patternsFound: 3 };
    const now = new Date("2026-01-05T00:00:00.000Z");
    expect(isSweepFresh(sweep, now, 14)).toBe(true);
  });

  test("a sweep past the freshness window is not fresh", () => {
    const sweep: SweepRecord = { category: "c", researchType: "organic", lastSweptAt: "2026-01-01T00:00:00.000Z", dataSparsity: "adequate", patternsFound: 3 };
    const now = new Date("2026-02-01T00:00:00.000Z");
    expect(isSweepFresh(sweep, now, 14)).toBe(false);
  });
});

describe("deriveDataSparsity", () => {
  test("below the threshold is thin", () => {
    expect(deriveDataSparsity(0)).toBe("thin");
    expect(deriveDataSparsity(1)).toBe("thin");
  });

  test("at or above the threshold is adequate", () => {
    expect(deriveDataSparsity(2)).toBe("adequate");
    expect(deriveDataSparsity(6)).toBe("adequate");
  });
});

describe("recordSweep", () => {
  test("replaces an existing sweep for the same category+researchType rather than duplicating it", () => {
    const library: PatternLibrary = {
      ...emptyLibrary(),
      sweeps: [{ category: "finance", researchType: "organic", lastSweptAt: "2026-01-01T00:00:00.000Z", dataSparsity: "thin", patternsFound: 1 }],
    };
    const updated = recordSweep(
      library,
      { category: "finance", researchType: "organic", lastSweptAt: "2026-02-01T00:00:00.000Z", dataSparsity: "adequate", patternsFound: 5 },
      "2026-02-01T00:00:00.000Z",
    );
    expect(updated.sweeps).toHaveLength(1);
    expect(updated.sweeps[0]!.patternsFound).toBe(5);
  });

  test("leaves sweeps for other category/researchType combinations untouched", () => {
    const library: PatternLibrary = {
      ...emptyLibrary(),
      sweeps: [{ category: "finance", researchType: "organic", lastSweptAt: "2026-01-01T00:00:00.000Z", dataSparsity: "thin", patternsFound: 1 }],
    };
    const updated = recordSweep(
      library,
      { category: "b2b-saas", researchType: "geo", lastSweptAt: "2026-02-01T00:00:00.000Z", dataSparsity: "adequate", patternsFound: 4 },
      "2026-02-01T00:00:00.000Z",
    );
    expect(updated.sweeps).toHaveLength(2);
  });
});

describe("candidate adapters", () => {
  test("provenPatternToCandidate carries category and platforms into context", () => {
    const p: ProvenPattern = {
      id: "x", category: "finance", description: "d", examples: ["e"], evidenceStrength: "platform_ranked",
      source: "https://example.com", platforms: ["tiktok"], mechanism: "m", mechanismDependsOn: ["platform"],
    };
    const candidate = provenPatternToCandidate(p);
    expect(candidate.context).toEqual({ categories: ["finance"], platforms: ["tiktok"] });
    expect(candidate.rawEvidenceTag).toBe("platform_ranked");
  });

  test("organicPatternToCandidate carries category and platforms into context", () => {
    const p: OrganicPattern = {
      id: "x", category: "finance", description: "d", examples: ["e"], evidenceStrength: "platform_trending",
      source: "https://example.com", mechanism: "m", mechanismDependsOn: [], platforms: ["tiktok"],
    };
    const candidate = organicPatternToCandidate(p);
    expect(candidate.context.platforms).toEqual(["tiktok"]);
  });

  test("geoPatternToCandidate carries category and platforms into context", () => {
    const p: GeoPattern = {
      id: "x", category: "finance", description: "d", evidenceStrength: "industry_published",
      source: "https://example.com", mechanism: "m", mechanismDependsOn: [], platforms: ["chatgpt"],
    };
    const candidate = geoPatternToCandidate(p);
    expect(candidate.context.platforms).toEqual(["chatgpt"]);
  });

  test("stageComparableToCandidate carries stage into context and tags the comparable-research evidence type", () => {
    const p: StageComparableInsight = {
      company: "Notion", category: "productivity", observedStage: "launch", approxDate: "2016",
      strategy: "s", evidence: "e", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [],
    };
    const candidate = stageComparableToCandidate(p);
    expect(candidate.context.stage).toBe("launch");
    expect(candidate.rawEvidenceTag).toBe("comparable_company_research");
    expect(candidate.sourceDescription).toContain("Notion");
  });
});

describe("integrateCandidate", () => {
  const baseCandidate = {
    description: "Answer-first content gets cited more",
    mechanism: "Matches how AI search extracts snippets",
    mechanismDependsOn: ["platform"] as const,
    rawEvidenceTag: "industry_published",
    sourceDescription: "https://example.com",
    context: { categories: ["finance"], platforms: ["chatgpt"] },
  };

  test("creates a new single_observation pattern when nothing matches", () => {
    const library = integrateCandidate(emptyLibrary(), { ...baseCandidate, mechanismDependsOn: [...baseCandidate.mechanismDependsOn] }, { checked: true, evidence: [] }, null, "2026-01-01T00:00:00.000Z");
    expect(library.patterns).toHaveLength(1);
    expect(library.patterns[0]!.tier).toBe("single_observation");
    expect(library.patterns[0]!.counterEvidenceChecked).toBe(true);
  });

  test("merges into an existing pattern when matched, upgrading tier on real cross-context replication", () => {
    const first = integrateCandidate(emptyLibrary(), { ...baseCandidate, mechanismDependsOn: [...baseCandidate.mechanismDependsOn] }, { checked: true, evidence: [] }, null, "2026-01-01T00:00:00.000Z");
    const existingId = first.patterns[0]!.id;
    const second = integrateCandidate(
      first,
      { ...baseCandidate, mechanismDependsOn: [...baseCandidate.mechanismDependsOn], context: { categories: ["finance"], platforms: ["perplexity"] } },
      { checked: true, evidence: [] },
      existingId,
      "2026-02-01T00:00:00.000Z",
    );
    expect(second.patterns).toHaveLength(1);
    expect(second.patterns[0]!.tier).toBe("replicated_cross_context");
    expect(second.patterns[0]!.observations).toHaveLength(2);
  });

  test("a direct_contradiction caps a newly-created pattern's tier immediately", () => {
    const library = integrateCandidate(
      emptyLibrary(),
      { ...baseCandidate, mechanismDependsOn: [...baseCandidate.mechanismDependsOn] },
      { checked: true, evidence: [{ severity: "direct_contradiction", description: "failed elsewhere", source: "https://example.com" }] },
      null,
      "2026-01-01T00:00:00.000Z",
    );
    expect(library.patterns[0]!.tier).toBe("single_observation");
    expect(library.patterns[0]!.counterEvidence).toHaveLength(1);
  });

  test("falls back to creating a new pattern if a matchedPatternId doesn't actually exist in the library", () => {
    const library = integrateCandidate(emptyLibrary(), { ...baseCandidate, mechanismDependsOn: [...baseCandidate.mechanismDependsOn] }, { checked: true, evidence: [] }, "nonexistent-id", "2026-01-01T00:00:00.000Z");
    expect(library.patterns).toHaveLength(1);
  });

  test("updatedAt reflects the real call time, not a stale value", () => {
    const library = integrateCandidate(emptyLibrary(), { ...baseCandidate, mechanismDependsOn: [...baseCandidate.mechanismDependsOn] }, { checked: true, evidence: [] }, null, "2026-03-01T00:00:00.000Z");
    expect(library.updatedAt).toBe("2026-03-01T00:00:00.000Z");
  });
});
