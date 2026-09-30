import { describe, expect, test } from "bun:test";
import { parseProvenPatterns, parseStageComparables } from "./growth-patterns";

const PATTERN_MARKER = "PROVEN_PATTERNS_JSON:";
const COMPARABLE_MARKER = "STAGE_COMPARABLES_JSON:";

describe("parseProvenPatterns", () => {
  test("parses a well-formed pattern array and stamps category + derives id", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      {
        description: "Opens with a real user pain-point stated bluntly, no setup",
        examples: ["\"I kept losing track of my spending.\""],
        evidenceStrength: "platform_ranked",
        source: "https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en",
      },
    ])}`;
    const result = parseProvenPatterns(text, "consumer personal-finance utility");
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("consumer personal-finance utility");
    expect(result[0]!.id).toBe("opens-with-a-real-user-pain-point-stated-bluntly-no-setup");
    expect(result[0]!.evidenceStrength).toBe("platform_ranked");
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
      { description: "x", examples: ["y"], evidenceStrength: "trust-me-bro", source: "https://example.com" },
    ])}`;
    expect(parseProvenPatterns(text, "b2b saas")).toEqual([]);
  });

  test("drops entries with an empty examples array but keeps valid ones", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "valid one", examples: ["real example"], evidenceStrength: "award_judged", source: "https://example.com" },
      { description: "invalid, no examples", examples: [], evidenceStrength: "award_judged", source: "https://example.com" },
    ])}`;
    const result = parseProvenPatterns(text, "b2b saas");
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe("valid one");
  });

  test("all four evidenceStrength values are individually accepted", () => {
    for (const evidenceStrength of ["platform_ranked", "published_case_study", "award_judged", "longevity_proxy"]) {
      const text = `${PATTERN_MARKER}\n${JSON.stringify([
        { description: "d", examples: ["e"], evidenceStrength, source: "https://example.com" },
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
      },
    ])}`;
    const result = parseStageComparables(text, "productivity saas", "launch");
    expect(result).toHaveLength(1);
    expect(result[0]!.company).toBe("Notion");
    expect(result[0]!.category).toBe("productivity saas");
    expect(result[0]!.observedStage).toBe("launch");
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
      { company: "Real Co", approxDate: "2015", strategy: "x", evidence: "a real snapshot", source: "https://example.com" },
      { company: "Missing Evidence Co", approxDate: "2015", strategy: "x", source: "https://example.com" },
    ])}`;
    const result = parseStageComparables(text, "cat", "growth");
    expect(result).toHaveLength(1);
    expect(result[0]!.company).toBe("Real Co");
  });

  test("every AppStage value round-trips correctly through observedStage", () => {
    for (const stage of ["launch", "traction", "growth", "scale"] as const) {
      const text = `${COMPARABLE_MARKER}\n${JSON.stringify([
        { company: "Co", approxDate: "2020", strategy: "s", evidence: "e", source: "https://example.com" },
      ])}`;
      const result = parseStageComparables(text, "cat", stage);
      expect(result[0]!.observedStage).toBe(stage);
    }
  });
});
