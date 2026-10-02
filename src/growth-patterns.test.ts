import { describe, expect, test } from "bun:test";
import { parseOrganicPatterns, parseProvenPatterns, parseStageComparables } from "./growth-patterns";

const PATTERN_MARKER = "PROVEN_PATTERNS_JSON:";
const COMPARABLE_MARKER = "STAGE_COMPARABLES_JSON:";
const ORGANIC_MARKER = "ORGANIC_PATTERNS_JSON:";

describe("parseProvenPatterns", () => {
  test("parses a well-formed pattern array and stamps category + derives id", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      {
        description: "Opens with a real user pain-point stated bluntly, no setup",
        examples: ["\"I kept losing track of my spending.\""],
        evidenceStrength: "platform_ranked",
        source: "https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en",
        platforms: ["tiktok"],
        mechanism: "Leading with a relatable pain point reduces perceived risk before any pitch.",
        mechanismDependsOn: [],
      },
    ])}`;
    const result = parseProvenPatterns(text, "consumer personal-finance utility");
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("consumer personal-finance utility");
    expect(result[0]!.id).toBe("opens-with-a-real-user-pain-point-stated-bluntly-no-setup");
    expect(result[0]!.evidenceStrength).toBe("platform_ranked");
    expect(result[0]!.platforms).toEqual(["tiktok"]);
    expect(result[0]!.mechanism).toContain("relatable pain point");
    expect(result[0]!.mechanismDependsOn).toEqual([]);
  });

  test("an honest empty array is a legitimate result, not a failure", () => {
    expect(parseProvenPatterns(`${PATTERN_MARKER}\n[]`, "b2b saas")).toEqual([]);
  });

  test("no marker fails closed to an empty array", () => {
    expect(parseProvenPatterns("no marker here", "b2b saas")).toEqual([]);
  });

  test("malformed JSON fails closed to an empty array", () => {
    expect(parseProvenPatterns(`${PATTERN_MARKER}\nnot json {{{`, "b2b saas")).toEqual([]);
  });

  test("rejects an evidenceStrength value outside the closed set", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "trust-me-bro", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    expect(parseProvenPatterns(text, "b2b saas")).toEqual([]);
  });

  test("rejects an entry with an empty mechanism", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "award_judged", source: "https://example.com", platforms: [], mechanism: "   ", mechanismDependsOn: [] },
    ])}`;
    expect(parseProvenPatterns(text, "b2b saas")).toEqual([]);
  });

  test("rejects an entry with a mechanismDependsOn value outside the closed set", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "award_judged", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: ["vibes"] },
    ])}`;
    expect(parseProvenPatterns(text, "b2b saas")).toEqual([]);
  });

  test("rejects an entry with a non-string platforms entry", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "award_judged", source: "https://example.com", platforms: [123], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    expect(parseProvenPatterns(text, "b2b saas")).toEqual([]);
  });

  test("accepts a real mechanismDependsOn combination", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "award_judged", source: "https://example.com", platforms: ["tiktok"], mechanism: "m", mechanismDependsOn: ["platform", "era"] },
    ])}`;
    const result = parseProvenPatterns(text, "cat");
    expect(result[0]!.mechanismDependsOn).toEqual(["platform", "era"]);
  });

  test("drops entries with an empty examples array but keeps valid ones", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "valid one", examples: ["real example"], evidenceStrength: "award_judged", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
      { description: "invalid, no examples", examples: [], evidenceStrength: "award_judged", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    const result = parseProvenPatterns(text, "b2b saas");
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("valid one");
  });

  test("all four evidenceStrength values are individually accepted", () => {
    for (const evidenceStrength of ["platform_ranked", "published_case_study", "award_judged", "longevity_proxy"]) {
      const text = `${PATTERN_MARKER}\n${JSON.stringify([
        { description: "d", examples: ["e"], evidenceStrength, source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
      ])}`;
      const result = parseProvenPatterns(text, "cat");
      expect(result).toHaveLength(1);
      expect(result[0]!.evidenceStrength).toBe(evidenceStrength as any);
    }
  });
});

describe("parseStageComparables", () => {
  test("parses a well-formed comparable array and stamps category + observedStage", () => {
    const text = `${COMPARABLE_MARKER}\n${JSON.stringify([
      {
        company: "Notion",
        approxDate: "2016",
        strategy: "Founder-led content marketing on a personal blog before any paid channel",
        evidence: "Wayback Machine snapshot of notion.so from mid-2016",
        source: "https://web.archive.org/web/2016*/notion.so",
        platforms: [],
        mechanism: "Authority built through teaching, not selling, lowers buyer skepticism before any pitch.",
        mechanismDependsOn: [],
      },
    ])}`;
    const result = parseStageComparables(text, "productivity saas", "launch");
    expect(result).toHaveLength(1);
    expect(result[0]!.company).toBe("Notion");
    expect(result[0]!.category).toBe("productivity saas");
    expect(result[0]!.observedStage).toBe("launch");
    expect(result[0]!.platforms).toEqual([]);
    expect(result[0]!.mechanism).toContain("Authority built");
  });

  test("an honest empty array is a legitimate result, not a failure", () => {
    expect(parseStageComparables(`${COMPARABLE_MARKER}\n[]`, "cat", "traction")).toEqual([]);
  });

  test("no marker fails closed to an empty array", () => {
    expect(parseStageComparables("no marker here", "cat", "traction")).toEqual([]);
  });

  test("malformed JSON fails closed to an empty array", () => {
    expect(parseStageComparables(`${COMPARABLE_MARKER}\nnot json {{{`, "cat", "traction")).toEqual([]);
  });

  test("drops entries missing a required field (evidence) but keeps valid ones", () => {
    const text = `${COMPARABLE_MARKER}\n${JSON.stringify([
      { company: "Real Co", approxDate: "2015", strategy: "x", evidence: "a real snapshot", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
      { company: "Missing Evidence Co", approxDate: "2015", strategy: "x", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    const result = parseStageComparables(text, "cat", "growth");
    expect(result).toHaveLength(1);
    expect(result[0]!.company).toBe("Real Co");
  });

  test("drops an entry with a non-empty-string platform list entry", () => {
    const text = `${COMPARABLE_MARKER}\n${JSON.stringify([
      { company: "Co", approxDate: "2020", strategy: "s", evidence: "e", source: "https://example.com", platforms: [123], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    expect(parseStageComparables(text, "cat", "growth")).toEqual([]);
  });

  test("accepts a real, non-empty platforms list", () => {
    const text = `${COMPARABLE_MARKER}\n${JSON.stringify([
      { company: "Co", approxDate: "2020", strategy: "s", evidence: "e", source: "https://example.com", platforms: ["tiktok"], mechanism: "m", mechanismDependsOn: ["platform"] },
    ])}`;
    const result = parseStageComparables(text, "cat", "growth");
    expect(result[0]!.platforms).toEqual(["tiktok"]);
    expect(result[0]!.mechanismDependsOn).toEqual(["platform"]);
  });

  test("every AppStage value round-trips correctly through observedStage", () => {
    for (const stage of ["launch", "traction", "growth", "scale"] as const) {
      const text = `${COMPARABLE_MARKER}\n${JSON.stringify([
        { company: "Co", approxDate: "2020", strategy: "s", evidence: "e", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
      ])}`;
      const result = parseStageComparables(text, "cat", stage);
      expect(result[0]!.observedStage).toBe(stage);
    }
  });
});

describe("parseOrganicPatterns", () => {
  test("parses a well-formed organic pattern array and stamps category + derives id", () => {
    const text = `${ORGANIC_MARKER}\n${JSON.stringify([
      {
        description: "Day-in-the-life screen recording with real on-screen captions, no voiceover",
        examples: ["A budgeting app's TikTok showing a real 30-second expense-logging session"],
        evidenceStrength: "platform_trending",
        source: "https://tiktok.com/business/creativecenter/inspiration/trends/pc/en",
        platforms: ["tiktok"],
        mechanism: "Real screen-capture reads as authentic, unscripted proof rather than an ad.",
        mechanismDependsOn: ["platform"],
      },
    ])}`;
    const result = parseOrganicPatterns(text, "consumer personal-finance utility");
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("consumer personal-finance utility");
    expect(result[0]!.id).toBe("day-in-the-life-screen-recording-with-real-on-screen-caption");
    expect(result[0]!.evidenceStrength).toBe("platform_trending");
    expect(result[0]!.platforms).toEqual(["tiktok"]);
    expect(result[0]!.mechanismDependsOn).toEqual(["platform"]);
  });

  test("an honest empty array is a legitimate result, not a failure", () => {
    expect(parseOrganicPatterns(`${ORGANIC_MARKER}\n[]`, "b2b saas")).toEqual([]);
  });

  test("no marker fails closed to an empty array", () => {
    expect(parseOrganicPatterns("no marker here", "b2b saas")).toEqual([]);
  });

  test("malformed JSON fails closed to an empty array", () => {
    expect(parseOrganicPatterns(`${ORGANIC_MARKER}\nnot json {{{`, "b2b saas")).toEqual([]);
  });

  test("rejects an evidenceStrength value outside the organic-specific closed set", () => {
    const text = `${ORGANIC_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "platform_ranked", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    // "platform_ranked" is a real EvidenceStrength value for PAID ads — deliberately
    // rejected here since it would misrepresent an organic pattern's evidence.
    expect(parseOrganicPatterns(text, "b2b saas")).toEqual([]);
  });

  test("rejects an entry with a missing mechanismDependsOn", () => {
    const text = `${ORGANIC_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "platform_trending", source: "https://example.com", platforms: [], mechanism: "m" },
    ])}`;
    expect(parseOrganicPatterns(text, "b2b saas")).toEqual([]);
  });

  test("rejects an entry with a missing platforms field", () => {
    const text = `${ORGANIC_MARKER}\n${JSON.stringify([
      { description: "x", examples: ["y"], evidenceStrength: "platform_trending", source: "https://example.com", mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    expect(parseOrganicPatterns(text, "b2b saas")).toEqual([]);
  });

  test("drops entries with an empty examples array but keeps valid ones", () => {
    const text = `${ORGANIC_MARKER}\n${JSON.stringify([
      { description: "valid one", examples: ["real example"], evidenceStrength: "creator_public_metrics", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
      { description: "invalid, no examples", examples: [], evidenceStrength: "creator_public_metrics", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    const result = parseOrganicPatterns(text, "b2b saas");
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("valid one");
  });

  test("every organic EvidenceStrength value is accepted", () => {
    for (const strength of ["platform_trending", "published_case_study", "creator_public_metrics"] as const) {
      const text = `${ORGANIC_MARKER}\n${JSON.stringify([
        { description: "d", examples: ["e"], evidenceStrength: strength, source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
      ])}`;
      const result = parseOrganicPatterns(text, "cat");
      expect(result[0]!.evidenceStrength).toBe(strength);
    }
  });
});
