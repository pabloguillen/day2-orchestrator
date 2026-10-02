import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromotionCandidates,
  countIndependentCycles,
  isTrendExpired,
  loadFormatRecurrenceLog,
  parsePromotionMechanism,
  parseTrendSignals,
  recordFormatOccurrence,
  saveFormatRecurrenceLog,
  shouldPromoteFormat,
} from "./growth-trends";
import type { FormatOccurrence, FormatRecurrenceLog, TrendSignal } from "./growth-trends";

const TREND_MARKER = "TREND_SIGNALS_JSON:";
const MECHANISM_MARKER = "PROMOTED_FORMAT_MECHANISM_JSON:";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "day2-format-recurrence-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function occurrence(format: string, detectedAt: string, overrides: Partial<FormatOccurrence> = {}): FormatOccurrence {
  return { format, category: "consumer finance", platform: "tiktok", detectedAt, ...overrides };
}

describe("parseTrendSignals", () => {
  test("parses a well-formed trend array and derives id/format/detectedAt", () => {
    const text = `${TREND_MARKER}\n${JSON.stringify([
      {
        description: "POV: you just realized your budget app tracks this for you",
        format: "POV Format",
        platform: "tiktok",
        relevanceWindowDays: 7,
        source: "tiktok.com/business/creativecenter",
      },
    ])}`;
    const result = parseTrendSignals(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.format).toBe("pov-format");
    expect(result[0]!.platform).toBe("tiktok");
    expect(result[0]!.relevanceWindowDays).toBe(7);
    expect(result[0]!.source).toBe("tiktok.com/business/creativecenter");
    expect(result[0]!.id.length).toBeGreaterThan(0);
    expect(typeof result[0]!.detectedAt).toBe("string");
  });

  test("an honest empty array is a legitimate result", () => {
    expect(parseTrendSignals(`${TREND_MARKER}\n[]`)).toEqual([]);
  });

  test("no marker fails closed to an empty array", () => {
    expect(parseTrendSignals("nothing here")).toEqual([]);
  });

  test("invalid JSON after the marker fails closed to an empty array", () => {
    expect(parseTrendSignals(`${TREND_MARKER}\nnot json`)).toEqual([]);
  });

  test("marker followed by a non-array fails closed to an empty array", () => {
    expect(parseTrendSignals(`${TREND_MARKER}\n${JSON.stringify({ foo: "bar" })}`)).toEqual([]);
  });

  test("rejects an entry missing relevanceWindowDays", () => {
    const text = `${TREND_MARKER}\n${JSON.stringify([
      { description: "x", format: "f", platform: "tiktok", source: "s" },
    ])}`;
    expect(parseTrendSignals(text)).toEqual([]);
  });

  test("rejects an entry with a non-positive relevanceWindowDays", () => {
    const text = `${TREND_MARKER}\n${JSON.stringify([
      { description: "x", format: "f", platform: "tiktok", relevanceWindowDays: 0, source: "s" },
    ])}`;
    expect(parseTrendSignals(text)).toEqual([]);
  });

  test("rejects an entry with an empty description", () => {
    const text = `${TREND_MARKER}\n${JSON.stringify([
      { description: "", format: "f", platform: "tiktok", relevanceWindowDays: 5, source: "s" },
    ])}`;
    expect(parseTrendSignals(text)).toEqual([]);
  });

  test("filters out only the invalid entries, keeping valid ones in a mixed array", () => {
    const text = `${TREND_MARKER}\n${JSON.stringify([
      { description: "valid one", format: "f1", platform: "tiktok", relevanceWindowDays: 5, source: "s" },
      { description: "", format: "f2", platform: "tiktok", relevanceWindowDays: 5, source: "s" },
    ])}`;
    expect(parseTrendSignals(text)).toHaveLength(1);
  });
});

describe("isTrendExpired", () => {
  function signal(detectedAt: string, relevanceWindowDays: number): TrendSignal {
    return { id: "x", description: "d", format: "f", platform: "tiktok", detectedAt, relevanceWindowDays, source: "s" };
  }

  test("not expired within the window", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    expect(isTrendExpired(signal("2026-01-08T00:00:00.000Z", 7), now)).toBe(false);
  });

  test("expired once past the window", () => {
    const now = new Date("2026-01-20T00:00:00.000Z");
    expect(isTrendExpired(signal("2026-01-08T00:00:00.000Z", 7), now)).toBe(true);
  });

  test("not expired exactly at the boundary instant", () => {
    const detectedAt = "2026-01-08T00:00:00.000Z";
    const now = new Date(new Date(detectedAt).getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(isTrendExpired(signal(detectedAt, 7), now)).toBe(false);
  });
});

describe("loadFormatRecurrenceLog / saveFormatRecurrenceLog", () => {
  test("returns an empty log when no file exists yet", () => {
    withTmpDir((dir) => {
      const log = loadFormatRecurrenceLog(join(dir, ".day2-format-recurrence.json"));
      expect(log.occurrences).toEqual([]);
    });
  });

  test("round-trips a real log with real occurrences", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-format-recurrence.json");
      const log: FormatRecurrenceLog = { occurrences: [occurrence("pov-format", "2026-01-01T00:00:00.000Z")] };
      saveFormatRecurrenceLog(path, log);
      expect(loadFormatRecurrenceLog(path)).toEqual(log);
    });
  });

  test("throws on invalid JSON rather than silently overwriting", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-format-recurrence.json");
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(path, "not json");
      expect(() => loadFormatRecurrenceLog(path)).toThrow();
    });
  });

  test("throws on JSON that doesn't look like a valid log", () => {
    withTmpDir((dir) => {
      const path = join(dir, ".day2-format-recurrence.json");
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(path, JSON.stringify({ foo: "bar" }));
      expect(() => loadFormatRecurrenceLog(path)).toThrow();
    });
  });
});

describe("recordFormatOccurrence", () => {
  test("appends without mutating the original log", () => {
    const log: FormatRecurrenceLog = { occurrences: [] };
    const next = recordFormatOccurrence(log, occurrence("pov-format", "2026-01-01T00:00:00.000Z"));
    expect(log.occurrences).toHaveLength(0);
    expect(next.occurrences).toHaveLength(1);
  });
});

describe("countIndependentCycles", () => {
  test("zero occurrences of the format is zero cycles", () => {
    expect(countIndependentCycles([], "pov-format")).toBe(0);
  });

  test("a single occurrence is one cycle", () => {
    const occurrences = [occurrence("pov-format", "2026-01-01T00:00:00.000Z")];
    expect(countIndependentCycles(occurrences, "pov-format")).toBe(1);
  });

  test("occurrences within the minimum gap collapse into the same cycle", () => {
    const occurrences = [
      occurrence("pov-format", "2026-01-01T00:00:00.000Z"),
      occurrence("pov-format", "2026-01-03T00:00:00.000Z"),
    ];
    expect(countIndependentCycles(occurrences, "pov-format")).toBe(1);
  });

  test("occurrences spaced beyond the minimum gap count as separate cycles", () => {
    const occurrences = [
      occurrence("pov-format", "2026-01-01T00:00:00.000Z"),
      occurrence("pov-format", "2026-01-20T00:00:00.000Z"),
      occurrence("pov-format", "2026-02-10T00:00:00.000Z"),
    ];
    expect(countIndependentCycles(occurrences, "pov-format")).toBe(3);
  });

  test("ignores occurrences of a different format", () => {
    const occurrences = [
      occurrence("pov-format", "2026-01-01T00:00:00.000Z"),
      occurrence("duet-stitch-reaction", "2026-01-20T00:00:00.000Z"),
    ];
    expect(countIndependentCycles(occurrences, "pov-format")).toBe(1);
  });

  test("counts cycles correctly regardless of input order", () => {
    const occurrences = [
      occurrence("pov-format", "2026-02-10T00:00:00.000Z"),
      occurrence("pov-format", "2026-01-01T00:00:00.000Z"),
      occurrence("pov-format", "2026-01-20T00:00:00.000Z"),
    ];
    expect(countIndependentCycles(occurrences, "pov-format")).toBe(3);
  });
});

describe("shouldPromoteFormat", () => {
  test("false below the promotion threshold", () => {
    const occurrences = [
      occurrence("pov-format", "2026-01-01T00:00:00.000Z"),
      occurrence("pov-format", "2026-01-20T00:00:00.000Z"),
    ];
    expect(shouldPromoteFormat(occurrences, "pov-format")).toBe(false);
  });

  test("true once independent cycles reach the threshold", () => {
    const occurrences = [
      occurrence("pov-format", "2026-01-01T00:00:00.000Z"),
      occurrence("pov-format", "2026-01-20T00:00:00.000Z"),
      occurrence("pov-format", "2026-02-10T00:00:00.000Z"),
    ];
    expect(shouldPromoteFormat(occurrences, "pov-format")).toBe(true);
  });
});

describe("parsePromotionMechanism", () => {
  test("parses a well-formed mechanism", () => {
    const text = `${MECHANISM_MARKER}\n${JSON.stringify({
      mechanism: "Direct-address POV framing lowers perceived distance between viewer and the product's benefit.",
      mechanismDependsOn: ["platform"],
    })}`;
    const result = parsePromotionMechanism(text);
    expect(result.mechanism).toContain("Direct-address POV framing");
    expect(result.mechanismDependsOn).toEqual(["platform"]);
  });

  test("accepts an empty mechanismDependsOn as a genuine general claim", () => {
    const text = `${MECHANISM_MARKER}\n${JSON.stringify({ mechanism: "m", mechanismDependsOn: [] })}`;
    expect(parsePromotionMechanism(text).mechanismDependsOn).toEqual([]);
  });

  test("no marker fails closed to the honest default, not an exception", () => {
    const result = parsePromotionMechanism("nothing here");
    expect(result.mechanismDependsOn).toEqual([]);
    expect(result.mechanism.length).toBeGreaterThan(0);
  });

  test("invalid JSON fails closed to the honest default", () => {
    const result = parsePromotionMechanism(`${MECHANISM_MARKER}\nnot json`);
    expect(result.mechanismDependsOn).toEqual([]);
  });

  test("an empty mechanism string fails closed to the honest default", () => {
    const text = `${MECHANISM_MARKER}\n${JSON.stringify({ mechanism: "", mechanismDependsOn: [] })}`;
    expect(parsePromotionMechanism(text).mechanism.length).toBeGreaterThan(0);
  });

  test("an invalid mechanismDependsOn value fails closed to the honest default", () => {
    const text = `${MECHANISM_MARKER}\n${JSON.stringify({ mechanism: "m", mechanismDependsOn: ["vibes"] })}`;
    const result = parsePromotionMechanism(text);
    expect(result.mechanismDependsOn).toEqual([]);
  });
});

describe("buildPromotionCandidates", () => {
  test("builds one candidate per real occurrence of the format", () => {
    const occurrences = [
      occurrence("pov-format", "2026-01-01T00:00:00.000Z", { category: "consumer finance", platform: "tiktok" }),
      occurrence("pov-format", "2026-01-20T00:00:00.000Z", { category: "b2b saas", platform: "youtube" }),
    ];
    const candidates = buildPromotionCandidates("pov-format", occurrences, "mechanism text", ["platform"]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.mechanism).toBe("mechanism text");
    expect(candidates[0]!.mechanismDependsOn).toEqual(["platform"]);
    expect(candidates[0]!.rawEvidenceTag).toBe("platform_trending");
    expect(candidates[0]!.context).toEqual({ categories: ["consumer finance"], platforms: ["tiktok"] });
    expect(candidates[1]!.context).toEqual({ categories: ["b2b saas"], platforms: ["youtube"] });
  });

  test("excludes occurrences of other formats", () => {
    const occurrences = [
      occurrence("pov-format", "2026-01-01T00:00:00.000Z"),
      occurrence("duet-stitch-reaction", "2026-01-20T00:00:00.000Z"),
    ];
    const candidates = buildPromotionCandidates("pov-format", occurrences, "m", []);
    expect(candidates).toHaveLength(1);
  });

  test("every candidate's description names the format", () => {
    const occurrences = [occurrence("pov-format", "2026-01-01T00:00:00.000Z")];
    const candidates = buildPromotionCandidates("pov-format", occurrences, "m", []);
    expect(candidates[0]!.description).toContain("pov-format");
  });
});
