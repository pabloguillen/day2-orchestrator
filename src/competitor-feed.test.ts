import { describe, expect, test } from "bun:test";
import { parseCompetitorAngleInsights, parseCompetitorInsights, parseSocialTrendInsights } from "./competitor-feed";

const MARKER = "COMPETITOR_INSIGHTS_JSON:";
const ANGLE_MARKER = "COMPETITOR_ANGLES_JSON:";
const TREND_MARKER = "SOCIAL_TRENDS_JSON:";

describe("parseCompetitorInsights", () => {
  test("parses a well-formed array of insights", () => {
    const text = `Some research notes here.\n\n${MARKER}\n[{"competitor": "YNAB", "feature": "envelope-style category budgets", "relevance": "expense-buddy has no budgeting concept beyond a single monthly total", "source": "https://www.ynab.com/features"}]`;
    const result = parseCompetitorInsights(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.competitor).toBe("YNAB");
  });

  test("an honest empty array is a legitimate result, not a failure", () => {
    const text = `Couldn't find anything verifiable.\n\n${MARKER}\n[]`;
    expect(parseCompetitorInsights(text)).toEqual([]);
  });

  test("no marker at all fails closed to an empty array", () => {
    expect(parseCompetitorInsights("just some rambling text with no marker")).toEqual([]);
  });

  test("malformed JSON after the marker fails closed to an empty array", () => {
    const text = `${MARKER}\nthis is not valid json at all {{{`;
    expect(parseCompetitorInsights(text)).toEqual([]);
  });

  test("non-array JSON after the marker fails closed to an empty array", () => {
    const text = `${MARKER}\n{"competitor": "YNAB"}`;
    expect(parseCompetitorInsights(text)).toEqual([]);
  });

  test("drops individual malformed entries but keeps the valid ones in the same batch", () => {
    const text = `${MARKER}\n[
      {"competitor": "YNAB", "feature": "envelope budgets", "relevance": "real gap", "source": "https://ynab.com"},
      {"competitor": "Copilot Money", "feature": ""},
      {"competitor": "", "feature": "x", "relevance": "y", "source": "z"},
      "not even an object"
    ]`;
    const result = parseCompetitorInsights(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.competitor).toBe("YNAB");
  });

  test("only content after the marker is parsed as JSON — earlier prose is ignored, not treated as invalid JSON", () => {
    const text = `I found several apps worth noting: YNAB, Copilot Money, and Monarch.\n\n${MARKER}\n[{"competitor": "Monarch", "feature": "shared household budgeting", "relevance": "expense-buddy is single-device only", "source": "https://www.monarchmoney.com"}]`;
    const result = parseCompetitorInsights(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.competitor).toBe("Monarch");
  });
});

describe("parseCompetitorAngleInsights", () => {
  test("parses a well-formed array of angle insights", () => {
    const text = `${ANGLE_MARKER}\n[{"competitor": "YNAB", "angle": "leads with a free 34-day trial hook", "channel": "paid_ads", "relevance": "expense-buddy has no trial-gated messaging", "source": "https://www.ynab.com"}]`;
    const result = parseCompetitorAngleInsights(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.angle).toBe("leads with a free 34-day trial hook");
    expect(result[0]!.channel).toBe("paid_ads");
  });

  test("an honest empty array is a legitimate result, not a failure", () => {
    expect(parseCompetitorAngleInsights(`${ANGLE_MARKER}\n[]`)).toEqual([]);
  });

  test("no marker fails closed to an empty array", () => {
    expect(parseCompetitorAngleInsights("no marker in this text")).toEqual([]);
  });

  test("malformed JSON fails closed to an empty array", () => {
    expect(parseCompetitorAngleInsights(`${ANGLE_MARKER}\nnot json {{{`)).toEqual([]);
  });

  test("drops entries missing a required field (channel) but keeps valid ones", () => {
    const text = `${ANGLE_MARKER}\n[
      {"competitor": "YNAB", "angle": "a", "channel": "social_content", "relevance": "b", "source": "c"},
      {"competitor": "Copilot Money", "angle": "a", "relevance": "b", "source": "c"}
    ]`;
    const result = parseCompetitorAngleInsights(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.competitor).toBe("YNAB");
  });
});

describe("parseSocialTrendInsights", () => {
  test("parses a well-formed array of trend insights", () => {
    const text = `${TREND_MARKER}\n[{"platform": "tiktok", "trend": "budget-check-in duets", "format": "talking-head + text overlay", "relevance": "matches a daily-check-in feature", "source": "https://example.com/trend"}]`;
    const result = parseSocialTrendInsights(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.platform).toBe("tiktok");
  });

  test("an honest empty array is a legitimate result, not a failure", () => {
    expect(parseSocialTrendInsights(`${TREND_MARKER}\n[]`)).toEqual([]);
  });

  test("no marker fails closed to an empty array", () => {
    expect(parseSocialTrendInsights("no marker in this text")).toEqual([]);
  });

  test("rejects a platform value outside the closed set", () => {
    const text = `${TREND_MARKER}\n[{"platform": "facebook", "trend": "a", "format": "b", "relevance": "c", "source": "d"}]`;
    expect(parseSocialTrendInsights(text)).toEqual([]);
  });

  test("accepts platform \"other\" as a legitimate closed-set value", () => {
    const text = `${TREND_MARKER}\n[{"platform": "other", "trend": "a", "format": "b", "relevance": "c", "source": "d"}]`;
    const result = parseSocialTrendInsights(text);
    expect(result).toHaveLength(1);
  });
});
