import { describe, expect, test } from "bun:test";
import {
  buildFormatTagForPattern,
  patternIdFromFormatTag,
  renderCrossChannelSuggestions,
  suggestCrossChannelPatterns,
} from "./growth-cross-channel";
import type { AllocatorState, ArmStats } from "./growth-allocator";

describe("buildFormatTagForPattern / patternIdFromFormatTag", () => {
  test("round-trips a real pattern id", () => {
    const tag = buildFormatTagForPattern("payday-routine-format", "v1");
    expect(patternIdFromFormatTag(tag)).toBe("payday-routine-format");
  });

  test("returns undefined for a plain, manually-authored format tag", () => {
    expect(patternIdFromFormatTag("15s-vertical-product-demo")).toBeUndefined();
  });

  test("returns undefined for an empty-prefix tag", () => {
    expect(patternIdFromFormatTag("::v1")).toBeUndefined();
  });
});

function arm(channel: string, formatTag: string, attempts: number, successes: number, assetType: "text" | "image" | "video" = "text"): ArmStats {
  return { arm: { channel: channel as any, assetType, formatTag }, attempts, successes, spendUsd: attempts * 2 };
}

describe("suggestCrossChannelPatterns", () => {
  test("suggests a pattern that's a real, sufficiently-observed, above-average winner in another channel", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [
        arm("paid_ads", buildFormatTagForPattern("payday-routine", "v1"), 10, 8), // 80% win rate
        arm("paid_ads", "generic-banner", 10, 2), // 20% win rate — drags the average down
      ],
    };
    const suggestions = suggestCrossChannelPatterns(state, "social_content" as any);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.patternId).toBe("payday-routine");
    expect(suggestions[0]!.suggestedForChannel).toBe("social_content");
    expect(suggestions[0]!.provenIn[0]!.channel).toBe("paid_ads");
  });

  test("does not suggest an arm below MIN_ARM_OBSERVATIONS, regardless of win rate", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [arm("paid_ads", buildFormatTagForPattern("too-early", "v1"), 2, 2)],
    };
    expect(suggestCrossChannelPatterns(state, "social_content" as any)).toEqual([]);
  });

  test("does not suggest a pattern already tried in the target channel", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [
        arm("paid_ads", buildFormatTagForPattern("payday-routine", "v1"), 10, 8),
        arm("paid_ads", "generic-banner", 10, 2),
        arm("social_content", buildFormatTagForPattern("payday-routine", "v2"), 5, 1),
      ],
    };
    expect(suggestCrossChannelPatterns(state, "social_content" as any)).toEqual([]);
  });

  test("never suggests a pattern back into the same channel it already won in", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [arm("paid_ads", buildFormatTagForPattern("payday-routine", "v1"), 10, 8)],
    };
    expect(suggestCrossChannelPatterns(state, "paid_ads" as any)).toEqual([]);
  });

  test("ignores arms with no decodable patternId (manually-authored formats)", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [arm("paid_ads", "hand-authored-format", 10, 9)],
    };
    expect(suggestCrossChannelPatterns(state, "social_content" as any)).toEqual([]);
  });

  test("does not suggest a pattern performing at or below its own channel's average", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [
        arm("paid_ads", buildFormatTagForPattern("mediocre", "v1"), 10, 3),
        arm("paid_ads", "other-format", 10, 5), // average of (0.3+0.5)/2 = 0.4, mediocre at 0.3 is below it
      ],
    };
    expect(suggestCrossChannelPatterns(state, "social_content" as any)).toEqual([]);
  });

  test("aggregates multiple provenIn channels for the same winning pattern", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [
        arm("paid_ads", buildFormatTagForPattern("payday-routine", "v1"), 10, 8),
        arm("paid_ads", "other", 10, 1),
        arm("seo_content", buildFormatTagForPattern("payday-routine", "v2"), 6, 5),
        arm("seo_content", "other2", 6, 1),
      ],
    };
    const suggestions = suggestCrossChannelPatterns(state, "social_content" as any);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.provenIn).toHaveLength(2);
  });

  test("sorts suggestions by strongest real win rate first", () => {
    const state: AllocatorState = {
      updatedAt: "2026-10-01T00:00:00.000Z",
      arms: [
        arm("paid_ads", buildFormatTagForPattern("strong", "v1"), 10, 9),
        arm("paid_ads", buildFormatTagForPattern("weaker", "v1"), 10, 6),
        arm("paid_ads", "baseline", 10, 1),
      ],
    };
    const suggestions = suggestCrossChannelPatterns(state, "social_content" as any);
    expect(suggestions.map((s) => s.patternId)).toEqual(["strong", "weaker"]);
  });
});

describe("renderCrossChannelSuggestions", () => {
  test("renders an honest empty state", () => {
    expect(renderCrossChannelSuggestions([])).toContain("No cross-channel pattern suggestions yet");
  });

  test("renders real pattern id, channel, and win rate for a real suggestion", () => {
    const rendered = renderCrossChannelSuggestions([
      {
        patternId: "payday-routine",
        provenIn: [{ channel: "paid_ads" as any, attempts: 10, successes: 8, winRate: 0.8 }],
        suggestedForChannel: "social_content" as any,
        reason: "test reason",
      },
    ]);
    expect(rendered).toContain("payday-routine");
    expect(rendered).toContain("social_content");
    expect(rendered).toContain("80%");
    expect(rendered).toContain("paid_ads");
  });
});
