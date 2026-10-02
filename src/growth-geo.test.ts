import { describe, expect, test } from "bun:test";
import {
  parseGeoGenerationResult,
  parseGeoGroundingVerdict,
  parseGeoPatterns,
} from "./growth-geo";
import type { GeoAnswer } from "./growth-geo";

const PATTERN_MARKER = "GEO_PATTERNS_JSON:";
const ANSWER_MARKER = "GEO_ANSWERS_JSON:";
const GROUNDING_MARKER = "GEO_GROUNDING_JSON:";

describe("parseGeoPatterns", () => {
  test("parses a well-formed pattern array and derives id", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      {
        description: "Answer-first paragraph structure",
        evidenceStrength: "industry_published",
        source: "https://searchengineland.com/geo-guide",
        platforms: ["chatgpt"],
        mechanism: "Leading with a direct answer matches how AI search engines extract citable snippets.",
        mechanismDependsOn: ["platform"],
      },
    ])}`;
    const result = parseGeoPatterns(text, "consumer finance");
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("consumer finance");
    expect(result[0]!.id).toBe("answer-first-paragraph-structure");
    expect(result[0]!.evidenceStrength).toBe("industry_published");
    expect(result[0]!.platforms).toEqual(["chatgpt"]);
    expect(result[0]!.mechanismDependsOn).toEqual(["platform"]);
  });

  test("an honest empty array is a legitimate result", () => {
    expect(parseGeoPatterns(`${PATTERN_MARKER}\n[]`, "b2b saas")).toEqual([]);
  });

  test("no marker fails closed to an empty array", () => {
    expect(parseGeoPatterns("nothing here", "b2b saas")).toEqual([]);
  });

  test("rejects an evidenceStrength outside the GEO-specific closed set", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", evidenceStrength: "platform_ranked", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: [] },
    ])}`;
    // "platform_ranked" is a real EvidenceStrength value from growth-patterns.ts's
    // paid-ad taxonomy — deliberately rejected here, different claim entirely.
    expect(parseGeoPatterns(text, "b2b saas")).toEqual([]);
  });

  test("rejects an entry with an empty mechanism", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", evidenceStrength: "industry_published", source: "https://example.com", platforms: [], mechanism: "", mechanismDependsOn: [] },
    ])}`;
    expect(parseGeoPatterns(text, "b2b saas")).toEqual([]);
  });

  test("rejects an entry with an invalid mechanismDependsOn value", () => {
    const text = `${PATTERN_MARKER}\n${JSON.stringify([
      { description: "x", evidenceStrength: "industry_published", source: "https://example.com", platforms: [], mechanism: "m", mechanismDependsOn: ["vibes"] },
    ])}`;
    expect(parseGeoPatterns(text, "b2b saas")).toEqual([]);
  });
});

describe("parseGeoGenerationResult", () => {
  test("parses a well-formed generated result", () => {
    const text = `${ANSWER_MARKER}\n${JSON.stringify({
      status: "generated",
      answers: [{ question: "What's the best way to track shared expenses?", answer: "Log each expense and split by category.", groundedIn: ["featureMap"] }],
    })}`;
    const result = parseGeoGenerationResult(text);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.answers).toHaveLength(1);
      expect(result.answers[0]!.groundedIn).toEqual(["featureMap"]);
    }
  });

  test("an honest no_content_worth_generating is a legitimate result", () => {
    const text = `${ANSWER_MARKER}\n${JSON.stringify({ status: "no_content_worth_generating", reason: "feature map too thin" })}`;
    const result = parseGeoGenerationResult(text);
    expect(result).toEqual({ status: "no_content_worth_generating", reason: "feature map too thin" });
  });

  test("no marker fails closed to no_content_worth_generating", () => {
    expect(parseGeoGenerationResult("nothing here").status).toBe("no_content_worth_generating");
  });

  test("malformed JSON fails closed", () => {
    expect(parseGeoGenerationResult(`${ANSWER_MARKER}\nnot json {{{`).status).toBe("no_content_worth_generating");
  });

  test("drops malformed answer entries but keeps valid ones", () => {
    const text = `${ANSWER_MARKER}\n${JSON.stringify({
      status: "generated",
      answers: [
        { question: "valid?", answer: "yes", groundedIn: ["purpose"] },
        { question: "missing answer", groundedIn: ["purpose"] },
      ],
    })}`;
    const result = parseGeoGenerationResult(text);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.answers).toHaveLength(1);
      expect(result.answers[0]!.question).toBe("valid?");
    }
  });

  test("falls back to no_content_worth_generating when every answer is malformed", () => {
    const text = `${ANSWER_MARKER}\n${JSON.stringify({ status: "generated", answers: [{ question: "" }] })}`;
    expect(parseGeoGenerationResult(text).status).toBe("no_content_worth_generating");
  });
});

describe("parseGeoGroundingVerdict", () => {
  const sampleAnswer: GeoAnswer = { question: "q", answer: "a", groundedIn: ["purpose"] };

  test("parses a passing verdict", () => {
    const text = `${GROUNDING_MARKER}\n${JSON.stringify({ grounded: true, issues: [] })}`;
    const result = parseGeoGroundingVerdict(text, sampleAnswer);
    expect(result.grounded).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.answer).toBe(sampleAnswer);
  });

  test("parses a failing verdict with real issues", () => {
    const text = `${GROUNDING_MARKER}\n${JSON.stringify({ grounded: false, issues: ["claims a feature not in featureMap"] })}`;
    const result = parseGeoGroundingVerdict(text, sampleAnswer);
    expect(result.grounded).toBe(false);
    expect(result.issues).toEqual(["claims a feature not in featureMap"]);
  });

  test("fails closed to grounded:false when no marker is present — unlike research parsers, this must never default to passing", () => {
    const result = parseGeoGroundingVerdict("no marker here", sampleAnswer);
    expect(result.grounded).toBe(false);
  });

  test("fails closed to grounded:false on malformed JSON", () => {
    const result = parseGeoGroundingVerdict(`${GROUNDING_MARKER}\nnot json {{{`, sampleAnswer);
    expect(result.grounded).toBe(false);
  });

  test("fails closed to grounded:false on an invalid shape", () => {
    const text = `${GROUNDING_MARKER}\n${JSON.stringify({ grounded: "yes" })}`;
    expect(parseGeoGroundingVerdict(text, sampleAnswer).grounded).toBe(false);
  });
});
