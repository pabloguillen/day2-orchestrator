import { describe, expect, test } from "bun:test";
import {
  addObservation,
  applyCounterEvidenceCap,
  deriveEvidenceBasis,
  deriveRawTier,
  deriveStalenessRisk,
  deriveTier,
  isCrossContextReplication,
  newPatternFromObservation,
  parseCounterEvidence,
  parsePatternMatch,
  renderPatternSummary,
  renderTransferabilityTier,
  shortlistCandidates,
} from "./pattern-transferability";
import type { PatternContext, SourceObservation } from "./pattern-transferability";

const COUNTER_MARKER = "COUNTER_EVIDENCE_JSON:";
const MATCH_MARKER = "PATTERN_MATCH_JSON:";

function ctx(overrides: Partial<PatternContext> = {}): PatternContext {
  return { categories: ["consumer-finance"], platforms: ["tiktok"], ...overrides };
}

function obs(context: PatternContext, rawEvidenceTag = "platform_trending"): SourceObservation {
  return { sourceId: "s1", sourceDescription: "d", context, rawEvidenceTag };
}

describe("isCrossContextReplication", () => {
  test("two observations sharing the only dependency dimension are NOT cross-context", () => {
    const a = ctx({ platforms: ["tiktok"] });
    const b = ctx({ categories: ["b2b-saas"], platforms: ["tiktok"] });
    expect(isCrossContextReplication(a, b, ["platform"])).toBe(false);
  });

  test("two observations differing on the only dependency dimension ARE cross-context", () => {
    const a = ctx({ platforms: ["tiktok"] });
    const b = ctx({ platforms: ["youtube"] });
    expect(isCrossContextReplication(a, b, ["platform"])).toBe(true);
  });

  test("differing on a dimension NOT in mechanismDependsOn doesn't count as cross-context", () => {
    const a = ctx({ categories: ["consumer-finance"], platforms: ["tiktok"] });
    const b = ctx({ categories: ["b2b-saas"], platforms: ["tiktok"] });
    // category differs, but the mechanism only depends on platform, and platform matches
    expect(isCrossContextReplication(a, b, ["platform"])).toBe(false);
  });

  test("an empty mechanismDependsOn (fully general claim) always counts as cross-context", () => {
    const a = ctx();
    const b = ctx();
    expect(isCrossContextReplication(a, b, [])).toBe(true);
  });

  test("requires ALL dependency dimensions to overlap, not just one of several", () => {
    const a = ctx({ platforms: ["tiktok"], stage: "traction" });
    const b = ctx({ platforms: ["tiktok"], stage: "growth" });
    // platform matches but stage doesn't — still cross-context since not EVERY dependency dimension overlaps
    expect(isCrossContextReplication(a, b, ["platform", "stage"])).toBe(true);
  });

  test("era dependency: same era is same-context, different era is cross-context", () => {
    const a = ctx({ era: "2023_2024" });
    const b = ctx({ era: "2023_2024" });
    const c = ctx({ era: "2025_plus" });
    expect(isCrossContextReplication(a, b, ["era"])).toBe(false);
    expect(isCrossContextReplication(a, c, ["era"])).toBe(true);
  });

  test("missing stage/era on either side counts as non-overlapping (cross-context) for that dimension", () => {
    const a = ctx({ stage: "traction" });
    const b = ctx({}); // no stage set
    expect(isCrossContextReplication(a, b, ["stage"])).toBe(true);
  });
});

describe("deriveRawTier", () => {
  test("a single observation is always single_observation", () => {
    expect(deriveRawTier([obs(ctx())], ["platform"])).toBe("single_observation");
  });

  test("two observations sharing every dependency dimension yield replicated_same_context", () => {
    const observations = [obs(ctx({ platforms: ["tiktok"] })), obs(ctx({ categories: ["other"], platforms: ["tiktok"] }))];
    expect(deriveRawTier(observations, ["platform"])).toBe("replicated_same_context");
  });

  test("two observations differing on a dependency dimension yield replicated_cross_context", () => {
    const observations = [obs(ctx({ platforms: ["tiktok"] })), obs(ctx({ platforms: ["youtube"] }))];
    expect(deriveRawTier(observations, ["platform"])).toBe("replicated_cross_context");
  });

  test("three same-context observations plus one cross-context one still yields cross_context (any pair is enough)", () => {
    const observations = [
      obs(ctx({ platforms: ["tiktok"] })),
      obs(ctx({ platforms: ["tiktok"] })),
      obs(ctx({ platforms: ["youtube"] })),
    ];
    expect(deriveRawTier(observations, ["platform"])).toBe("replicated_cross_context");
  });

  test("zero observations defaults to single_observation rather than throwing", () => {
    expect(deriveRawTier([], ["platform"])).toBe("single_observation");
  });
});

describe("applyCounterEvidenceCap / deriveTier", () => {
  test("a direct_contradiction caps an otherwise cross-context tier down to single_observation", () => {
    const capped = applyCounterEvidenceCap("replicated_cross_context", [
      { severity: "direct_contradiction", description: "it failed for Co X", source: "https://example.com" },
    ]);
    expect(capped).toBe("single_observation");
  });

  test("a contextual_caveat does NOT cap the tier", () => {
    const capped = applyCounterEvidenceCap("replicated_cross_context", [
      { severity: "contextual_caveat", description: "didn't translate to B2B", source: "https://example.com" },
    ]);
    expect(capped).toBe("replicated_cross_context");
  });

  test("expert_skepticism does NOT cap the tier", () => {
    const capped = applyCounterEvidenceCap("replicated_same_context", [
      { severity: "expert_skepticism", description: "an analyst thinks it's overrated", source: "https://example.com" },
    ]);
    expect(capped).toBe("replicated_same_context");
  });

  test("no counter-evidence at all leaves the raw tier untouched", () => {
    expect(applyCounterEvidenceCap("replicated_cross_context", [])).toBe("replicated_cross_context");
  });

  test("deriveTier composes raw-tier derivation with the counter-evidence cap", () => {
    const observations = [obs(ctx({ platforms: ["tiktok"] })), obs(ctx({ platforms: ["youtube"] }))];
    const tier = deriveTier(observations, ["platform"], [
      { severity: "direct_contradiction", description: "x", source: "https://example.com" },
    ]);
    expect(tier).toBe("single_observation");
  });
});

describe("deriveEvidenceBasis", () => {
  test("all first-party observations yield first_party", () => {
    const observations = [obs(ctx(), "platform_ranked"), obs(ctx(), "published_case_study")];
    expect(deriveEvidenceBasis(observations)).toBe("first_party");
  });

  test("all inferred observations yield inferred_only", () => {
    const observations = [obs(ctx(), "longevity_proxy"), obs(ctx(), "longevity_proxy")];
    expect(deriveEvidenceBasis(observations)).toBe("inferred_only");
  });

  test("a mix yields mixed", () => {
    const observations = [obs(ctx(), "platform_ranked"), obs(ctx(), "longevity_proxy")];
    expect(deriveEvidenceBasis(observations)).toBe("mixed");
  });

  test("zero observations defaults to inferred_only, the most conservative label", () => {
    expect(deriveEvidenceBasis([])).toBe("inferred_only");
  });

  test("every real raw evidence tag across the codebase's research functions is treated as first-party except longevity_proxy", () => {
    const tags = ["platform_ranked", "published_case_study", "award_judged", "platform_trending", "creator_public_metrics", "industry_published", "platform_documented"];
    for (const tag of tags) {
      expect(deriveEvidenceBasis([obs(ctx(), tag)])).toBe("first_party");
    }
    expect(deriveEvidenceBasis([obs(ctx(), "longevity_proxy")])).toBe("inferred_only");
  });
});

describe("deriveStalenessRisk", () => {
  test("era or platform dependency means high staleness risk", () => {
    expect(deriveStalenessRisk(["era"])).toBe("high");
    expect(deriveStalenessRisk(["platform"])).toBe("high");
    expect(deriveStalenessRisk(["platform", "category"])).toBe("high");
  });

  test("category or stage dependency alone (no era/platform) means medium risk", () => {
    expect(deriveStalenessRisk(["category"])).toBe("medium");
    expect(deriveStalenessRisk(["stage"])).toBe("medium");
  });

  test("no dependencies at all (fully general claim) means low risk", () => {
    expect(deriveStalenessRisk([])).toBe("low");
  });
});

describe("newPatternFromObservation / addObservation", () => {
  test("a new pattern starts at single_observation with evidence basis derived from its one observation", () => {
    const pattern = newPatternFromObservation("p1", "desc", "mech", ["platform"], obs(ctx(), "platform_ranked"), [], true, "2026-01-01T00:00:00.000Z");
    expect(pattern.tier).toBe("single_observation");
    expect(pattern.evidenceBasis).toBe("first_party");
    expect(pattern.observations).toHaveLength(1);
  });

  test("adding a cross-context observation upgrades the tier and re-derives evidence basis", () => {
    const pattern = newPatternFromObservation("p1", "desc", "mech", ["platform"], obs(ctx({ platforms: ["tiktok"] }), "platform_ranked"), [], true, "2026-01-01T00:00:00.000Z");
    const updated = addObservation(pattern, obs(ctx({ platforms: ["youtube"] }), "longevity_proxy"), [], "2026-02-01T00:00:00.000Z");
    expect(updated.tier).toBe("replicated_cross_context");
    expect(updated.evidenceBasis).toBe("mixed");
    expect(updated.observations).toHaveLength(2);
    expect(updated.lastValidatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("adding an observation with new counter-evidence merges it and can cap the tier", () => {
    const pattern = newPatternFromObservation("p1", "desc", "mech", ["platform"], obs(ctx({ platforms: ["tiktok"] })), [], true, "2026-01-01T00:00:00.000Z");
    const updated = addObservation(
      pattern,
      obs(ctx({ platforms: ["youtube"] })),
      [{ severity: "direct_contradiction", description: "failed elsewhere", source: "https://example.com" }],
      "2026-02-01T00:00:00.000Z",
    );
    expect(updated.tier).toBe("single_observation"); // would have been cross_context without the contradiction
    expect(updated.counterEvidence).toHaveLength(1);
  });
});

describe("renderTransferabilityTier", () => {
  test("each tier renders distinct, calibrated language", () => {
    const single = renderTransferabilityTier("single_observation");
    const same = renderTransferabilityTier("replicated_same_context");
    const cross = renderTransferabilityTier("replicated_cross_context");
    expect(single).toContain("not yet a proven pattern");
    expect(same).toContain("not yet confirmed to generalize");
    expect(cross).toContain("strongest tier");
    expect(new Set([single, same, cross]).size).toBe(3);
  });
});

describe("renderPatternSummary", () => {
  test("surfaces tier, evidence basis, and mechanism together", () => {
    const pattern = newPatternFromObservation("p1", "real desc", "real mechanism", [], obs(ctx(), "platform_ranked"), [], true, "2026-01-01T00:00:00.000Z");
    const rendered = renderPatternSummary(pattern);
    expect(rendered).toContain("real desc");
    expect(rendered).toContain("real mechanism");
    expect(rendered).toContain("first_party");
    expect(rendered).toContain("Counter-evidence: checked, none found.");
  });

  test("distinguishes 'never checked' from 'checked, none found'", () => {
    const neverChecked = newPatternFromObservation("p1", "d", "m", [], obs(ctx()), [], false, "2026-01-01T00:00:00.000Z");
    expect(renderPatternSummary(neverChecked)).toContain("Counter-evidence: not yet checked.");
  });

  test("shows real counter-evidence with its severity and source", () => {
    const pattern = newPatternFromObservation(
      "p1", "d", "m", [], obs(ctx()),
      [{ severity: "contextual_caveat", description: "doesn't work for B2B", source: "https://example.com" }],
      true, "2026-01-01T00:00:00.000Z",
    );
    const rendered = renderPatternSummary(pattern);
    expect(rendered).toContain("contextual_caveat");
    expect(rendered).toContain("doesn't work for B2B");
    expect(rendered).toContain("https://example.com");
  });

  test("surfaces staleness risk only when it's not low", () => {
    const stale = newPatternFromObservation("p1", "d", "m", ["era"], obs(ctx()), [], true, "2026-01-01T00:00:00.000Z");
    const notStale = newPatternFromObservation("p2", "d", "m", [], obs(ctx()), [], true, "2026-01-01T00:00:00.000Z");
    expect(renderPatternSummary(stale)).toContain("Staleness risk: high");
    expect(renderPatternSummary(notStale)).not.toContain("Staleness risk");
  });
});

describe("parseCounterEvidence", () => {
  test("parses a well-formed array and marks it checked", () => {
    const text = `${COUNTER_MARKER}\n${JSON.stringify([
      { severity: "direct_contradiction", description: "it failed", source: "https://example.com" },
    ])}`;
    const result = parseCounterEvidence(text, false);
    expect(result.checked).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.severity).toBe("direct_contradiction");
  });

  test("an honest empty array is checked:true, evidence:[]", () => {
    const result = parseCounterEvidence(`${COUNTER_MARKER}\n[]`, false);
    expect(result).toEqual({ checked: true, evidence: [] });
  });

  test("agent error means checked:false, distinct from a clean empty search", () => {
    expect(parseCounterEvidence("anything", true)).toEqual({ checked: false, evidence: [] });
  });

  test("no marker means checked:false", () => {
    expect(parseCounterEvidence("no marker here", false)).toEqual({ checked: false, evidence: [] });
  });

  test("malformed JSON means checked:false", () => {
    expect(parseCounterEvidence(`${COUNTER_MARKER}\nnot json {{{`, false)).toEqual({ checked: false, evidence: [] });
  });

  test("rejects a severity outside the closed set but keeps valid entries", () => {
    const text = `${COUNTER_MARKER}\n${JSON.stringify([
      { severity: "made_up_severity", description: "x", source: "https://example.com" },
      { severity: "expert_skepticism", description: "valid", source: "https://example.com" },
    ])}`;
    const result = parseCounterEvidence(text, false);
    expect(result.checked).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.description).toBe("valid");
  });
});

describe("parsePatternMatch", () => {
  test("parses a real matched id", () => {
    const text = `${MATCH_MARKER}\n${JSON.stringify({ matchedPatternId: "payday-routine" })}`;
    expect(parsePatternMatch(text)).toBe("payday-routine");
  });

  test("an honest explicit null is a legitimate result", () => {
    expect(parsePatternMatch(`${MATCH_MARKER}\n${JSON.stringify({ matchedPatternId: null })}`)).toBeNull();
  });

  test("no marker fails closed to null", () => {
    expect(parsePatternMatch("nothing here")).toBeNull();
  });

  test("malformed JSON fails closed to null", () => {
    expect(parsePatternMatch(`${MATCH_MARKER}\nnot json {{{`)).toBeNull();
  });
});

describe("shortlistCandidates", () => {
  test("ranks existing patterns by real keyword overlap with the candidate description", () => {
    const existing = [
      { id: "a", description: "founder-led teach-dont-sell content marketing builds trust", mechanism: "m" },
      { id: "b", description: "answer-first paragraph structure for AI search citation", mechanism: "m" },
    ];
    const shortlist = shortlistCandidates("teach dont sell content builds real trust with buyers", existing);
    expect(shortlist[0]!.id).toBe("a");
  });

  test("excludes patterns with zero real keyword overlap", () => {
    const existing = [{ id: "a", description: "completely unrelated topic about something else entirely", mechanism: "m" }];
    const shortlist = shortlistCandidates("teach dont sell content builds trust", existing);
    expect(shortlist).toEqual([]);
  });

  test("respects the limit parameter", () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, description: "shared keyword pattern content", mechanism: "m" }));
    expect(shortlistCandidates("shared keyword pattern content", existing, 3)).toHaveLength(3);
  });
});
