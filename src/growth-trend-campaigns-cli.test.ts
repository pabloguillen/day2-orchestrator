import { describe, expect, test } from "bun:test";
import { selectTrendsWorthEvaluating } from "./growth-trend-campaigns-cli";
import type { TrendSignal } from "./growth-trends";

function trend(overrides: Partial<TrendSignal> = {}): TrendSignal {
  return {
    id: "pov-format-x",
    description: "POV: your budget app just caught this for you",
    format: "pov-format",
    platform: "tiktok",
    detectedAt: "2026-01-01T00:00:00.000Z",
    relevanceWindowDays: 7,
    source: "tiktok.com/business/creativecenter",
    ...overrides,
  };
}

describe("selectTrendsWorthEvaluating", () => {
  test("keeps a trend still inside its relevance window", () => {
    const now = new Date("2026-01-05T00:00:00.000Z");
    expect(selectTrendsWorthEvaluating([trend()], now)).toHaveLength(1);
  });

  test("drops a trend past its relevance window, before any fit call would be made", () => {
    const now = new Date("2026-01-20T00:00:00.000Z");
    expect(selectTrendsWorthEvaluating([trend()], now)).toEqual([]);
  });

  test("filters a mixed list down to only still-active trends", () => {
    const now = new Date("2026-01-05T00:00:00.000Z");
    const trends = [
      trend({ id: "active", detectedAt: "2026-01-04T00:00:00.000Z" }),
      trend({ id: "expired", detectedAt: "2025-12-01T00:00:00.000Z" }),
    ];
    const result = selectTrendsWorthEvaluating(trends, now);
    expect(result.map((t) => t.id)).toEqual(["active"]);
  });

  test("empty input returns empty output", () => {
    expect(selectTrendsWorthEvaluating([], new Date())).toEqual([]);
  });
});
