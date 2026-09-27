import { describe, expect, test } from "bun:test";
import { parseCompetitorInsights } from "./competitor-feed";

const MARKER = "COMPETITOR_INSIGHTS_JSON:";

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
