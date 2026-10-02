import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canSubstituteTrendPost,
  decideTrendCampaignAction,
  loadTrendCampaignConfig,
  parseTrendFitVerdict,
  saveTrendCampaignConfig,
  setTrendAutoPostOptIn,
} from "./growth-trend-campaigns";
import type { TrendFitVerdict } from "./growth-trend-campaigns";
import type { TrendSignal } from "./growth-trends";

const FIT_MARKER = "TREND_FIT_JSON:";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "day2-trend-campaign-config-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

describe("parseTrendFitVerdict", () => {
  test("parses a well-formed fitting verdict", () => {
    const text = `${FIT_MARKER}\n${JSON.stringify({ fits: true, reason: "tone matches" })}`;
    const result = parseTrendFitVerdict(text, trend());
    expect(result.trendId).toBe("pov-format-x");
    expect(result.fits).toBe(true);
    expect(result.reason).toBe("tone matches");
  });

  test("parses a well-formed non-fitting verdict", () => {
    const text = `${FIT_MARKER}\n${JSON.stringify({ fits: false, reason: "off brand" })}`;
    expect(parseTrendFitVerdict(text, trend()).fits).toBe(false);
  });

  test("no marker fails closed to fits: false", () => {
    expect(parseTrendFitVerdict("nothing here", trend()).fits).toBe(false);
  });

  test("malformed JSON fails closed to fits: false", () => {
    expect(parseTrendFitVerdict(`${FIT_MARKER}\nnot json`, trend()).fits).toBe(false);
  });

  test("a non-object payload fails closed to fits: false", () => {
    expect(parseTrendFitVerdict(`${FIT_MARKER}\n${JSON.stringify([1, 2])}`, trend()).fits).toBe(false);
  });

  test("a missing reason fails closed to fits: false", () => {
    const text = `${FIT_MARKER}\n${JSON.stringify({ fits: true })}`;
    expect(parseTrendFitVerdict(text, trend()).fits).toBe(false);
  });

  test("an empty reason string fails closed to fits: false", () => {
    const text = `${FIT_MARKER}\n${JSON.stringify({ fits: true, reason: "" })}`;
    expect(parseTrendFitVerdict(text, trend()).fits).toBe(false);
  });
});

describe("loadTrendCampaignConfig / saveTrendCampaignConfig", () => {
  test("defaults to autoPostOptIn: false when no file exists yet", () => {
    withTmpDir((dir) => {
      const config = loadTrendCampaignConfig(join(dir, ".day2-trend-campaign-config.json"));
      expect(config.autoPostOptIn).toBe(false);
    });
  });

  test("round-trips a real config", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-trend-campaign-config.json");
      saveTrendCampaignConfig(path, { autoPostOptIn: true });
      expect(loadTrendCampaignConfig(path)).toEqual({ autoPostOptIn: true });
    });
  });

  test("throws on invalid JSON rather than silently overwriting", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-trend-campaign-config.json");
      writeFileSync(path, "not json");
      expect(() => loadTrendCampaignConfig(path)).toThrow();
    });
  });

  test("throws on JSON that doesn't look like a valid config", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-trend-campaign-config.json");
      writeFileSync(path, JSON.stringify({ foo: "bar" }));
      expect(() => loadTrendCampaignConfig(path)).toThrow();
    });
  });
});

describe("setTrendAutoPostOptIn", () => {
  test("updates without mutating the original config", () => {
    const config = { autoPostOptIn: false };
    const next = setTrendAutoPostOptIn(config, true);
    expect(config.autoPostOptIn).toBe(false);
    expect(next.autoPostOptIn).toBe(true);
  });
});

describe("decideTrendCampaignAction", () => {
  function fit(overrides: Partial<TrendFitVerdict> = {}): TrendFitVerdict {
    return { trendId: "pov-format-x", fits: true, reason: "tone matches", ...overrides };
  }

  test("skips an already-expired trend regardless of fit", () => {
    const now = new Date("2026-01-20T00:00:00.000Z");
    const decision = decideTrendCampaignAction(trend(), fit(), true, now);
    expect(decision.action).toBe("skip");
    expect(decision.reason).toContain("relevance window");
  });

  test("skips a trend that doesn't fit, even with auto-post opted in", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const decision = decideTrendCampaignAction(trend(), fit({ fits: false, reason: "off brand" }), true, now);
    expect(decision.action).toBe("skip");
    expect(decision.reason).toContain("off brand");
  });

  test("auto_post when it fits, is still relevant, and auto-post is opted in", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const decision = decideTrendCampaignAction(trend(), fit(), true, now);
    expect(decision.action).toBe("auto_post");
  });

  test("notify_for_approval when it fits and is still relevant but auto-post is not opted in", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const decision = decideTrendCampaignAction(trend(), fit(), false, now);
    expect(decision.action).toBe("notify_for_approval");
  });

  test("never returns auto_post for a fitting trend without the opt-in", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const decision = decideTrendCampaignAction(trend(), fit(), false, now);
    expect(decision.action).not.toBe("auto_post");
  });
});

describe("canSubstituteTrendPost", () => {
  test("true when this week's budgeted slots aren't used up yet", () => {
    expect(canSubstituteTrendPost(1, 3)).toBe(true);
  });

  test("false once this week's budgeted slots are already used up", () => {
    expect(canSubstituteTrendPost(3, 3)).toBe(false);
  });

  test("false when already over budget", () => {
    expect(canSubstituteTrendPost(5, 3)).toBe(false);
  });

  test("false when the channel has zero budgeted slots this week", () => {
    expect(canSubstituteTrendPost(0, 0)).toBe(false);
  });
});
