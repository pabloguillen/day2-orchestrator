import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllocatorState, Arm } from "./growth-allocator";
import type { Creative } from "./growth-creative";
import { countConsecutiveGenericFlags, loadGrowthActions, recordGrowthAction, renderGrowthFeed, type GrowthActionRecord } from "./growth-feed";

const arm: Arm = { channel: "social_content", assetType: "text", formatTag: "text-post" };

function creative(segment: string): Creative {
  return { arm, segment, headline: "h", body: "b", claimsCheckedAgainst: [], costUsd: 0 };
}

function makeRecord(overrides: Partial<GrowthActionRecord> = {}): GrowthActionRecord {
  return {
    timestamp: "2026-09-05T10:00:00.000Z",
    creativeId: "creative-1",
    strategy: { stage: "launch", channel: "social_content" },
    arm,
    toolUsed: null,
    frequency: "3x/week",
    spend: { requested: 5, allowed: true, runningMonthlyTotalUsd: 20, monthlyBudgetUsd: 200 },
    claimsCheck: { creative: creative("all-users"), truthful: true, issues: [] },
    authenticityCheck: { creative: creative("all-users"), readsAsGeneric: false, matchedPatterns: [], suggestion: "" },
    executionResult: "simulated_stopped_before_live_action",
    ...overrides,
  };
}

const emptyAllocatorState: AllocatorState = { arms: [], updatedAt: "2026-09-01T00:00:00.000Z" };

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "day2-growth-feed-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("recordGrowthAction / loadGrowthActions", () => {
  test("appends one JSON line per call, round-trips correctly", () => {
    withTempDir((dir) => {
      const auditFile = join(dir, "actions.jsonl");
      recordGrowthAction(auditFile, makeRecord({ creativeId: "a" }));
      recordGrowthAction(auditFile, makeRecord({ creativeId: "b" }));
      expect(existsSync(auditFile)).toBe(true);
      const records = loadGrowthActions(auditFile);
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.creativeId)).toEqual(["a", "b"]);
      const raw = readFileSync(auditFile, "utf-8").trim().split("\n");
      expect(raw).toHaveLength(2);
    });
  });

  test("returns [] for a nonexistent file", () => {
    expect(loadGrowthActions("/tmp/day2-growth-feed-does-not-exist.jsonl")).toEqual([]);
  });

  test("filters by since when provided", () => {
    withTempDir((dir) => {
      const auditFile = join(dir, "actions.jsonl");
      recordGrowthAction(auditFile, makeRecord({ creativeId: "old", timestamp: "2026-09-01T00:00:00.000Z" }));
      recordGrowthAction(auditFile, makeRecord({ creativeId: "new", timestamp: "2026-09-10T00:00:00.000Z" }));
      const records = loadGrowthActions(auditFile, new Date("2026-09-05T00:00:00.000Z"));
      expect(records.map((r) => r.creativeId)).toEqual(["new"]);
    });
  });
});

describe("countConsecutiveGenericFlags", () => {
  const genericHit = makeRecord({
    executionResult: "blocked_by_authenticity_check",
    authenticityCheck: { creative: creative("all-users"), readsAsGeneric: true, matchedPatterns: ["overused-phrase"], suggestion: "revise" },
    timestamp: "2026-09-05T10:00:00.000Z",
  });
  const clean = makeRecord({ timestamp: "2026-09-04T10:00:00.000Z" });

  test("zero when there's no history for this segment/channel", () => {
    expect(countConsecutiveGenericFlags([], "all-users", "social_content")).toBe(0);
  });

  test("counts a real, unbroken streak of the most recent flags", () => {
    const records = [
      { ...genericHit, timestamp: "2026-09-07T10:00:00.000Z" },
      { ...genericHit, timestamp: "2026-09-06T10:00:00.000Z" },
      clean,
    ];
    expect(countConsecutiveGenericFlags(records, "all-users", "social_content")).toBe(2);
  });

  test("stops counting at the first non-flagged record, even if flags exist further back", () => {
    const records = [
      { ...genericHit, timestamp: "2026-09-07T10:00:00.000Z" },
      { ...clean, timestamp: "2026-09-06T10:00:00.000Z" },
      { ...genericHit, timestamp: "2026-09-05T10:00:00.000Z" },
    ];
    expect(countConsecutiveGenericFlags(records, "all-users", "social_content")).toBe(1);
  });

  test("only counts records for the matching segment/channel, not everything", () => {
    const otherChannel = { ...genericHit, strategy: { stage: "launch" as const, channel: "paid_ads" }, timestamp: "2026-09-07T10:00:00.000Z" };
    const records = [otherChannel, { ...genericHit, timestamp: "2026-09-06T10:00:00.000Z" }];
    expect(countConsecutiveGenericFlags(records, "all-users", "social_content")).toBe(1);
  });
});

describe("renderGrowthFeed", () => {
  test("honest empty-state message plus the allocator summary, rather than a blank render", () => {
    const feed = renderGrowthFeed([], emptyAllocatorState);
    expect(feed).toContain("No growth actions recorded yet.");
    expect(feed).toContain("No formats have been tried yet.");
  });

  test("shows the real running budget line, generic-flag count, and day-grouped entries", () => {
    const records = [
      makeRecord({ creativeId: "a", timestamp: "2026-09-05T10:00:00.000Z" }),
      makeRecord({
        creativeId: "b",
        timestamp: "2026-09-05T14:00:00.000Z", // the latest record — its own spend figures are what the running-total line reflects
        spend: { requested: 5, allowed: true, runningMonthlyTotalUsd: 40, monthlyBudgetUsd: 200 },
        authenticityCheck: { creative: creative("all-users"), readsAsGeneric: true, matchedPatterns: ["x"], suggestion: "y" },
      }),
    ];
    const feed = renderGrowthFeed(records, emptyAllocatorState);
    expect(feed).toContain("$40.00 of $200.00 used this month (20%)");
    expect(feed).toContain("1 of 2 creatives flagged as generic this period.");
    expect(feed).toContain("2026-09-05");
    expect(feed).toContain("flagged as reading generic");
  });

  test("groups entries under the correct day when multiple days are present", () => {
    const records = [
      makeRecord({ creativeId: "day1", timestamp: "2026-09-04T10:00:00.000Z" }),
      makeRecord({ creativeId: "day2", timestamp: "2026-09-05T10:00:00.000Z" }),
    ];
    const feed = renderGrowthFeed(records, emptyAllocatorState);
    expect(feed).toContain("2026-09-04");
    expect(feed).toContain("2026-09-05");
  });

  test("shows a real organic action distinctly from a tool-backed one", () => {
    const organic = makeRecord({ creativeId: "organic-1", toolUsed: null });
    const toolBacked = makeRecord({
      creativeId: "tool-1",
      toolUsed: { capability: "creative_generation", mcpServerName: "tryholo", reason: "on-brand static asset" },
    });
    const feed = renderGrowthFeed([organic, toolBacked], emptyAllocatorState);
    expect(feed).toContain("organic, no external tool");
    expect(feed).toContain("via tryholo (on-brand static asset)");
  });

  test("appends the real allocator summary at the end", () => {
    const feed = renderGrowthFeed([makeRecord()], emptyAllocatorState);
    expect(feed.trimEnd().endsWith("No formats have been tried yet.")).toBe(true);
  });

  test("shows no judge-model note at all when the record has none — true for every record predating this field", () => {
    const feed = renderGrowthFeed([makeRecord()], emptyAllocatorState);
    expect(feed).not.toContain("judge model");
  });

  test("shows no judge-model note for a no_model_fallback prediction — suppressing noise, not a real signal", () => {
    const feed = renderGrowthFeed(
      [
        makeRecord({
          judgePrediction: { predictedSuccessProbability: 0.5, confidence: "none", basis: "no_model_fallback", trainedOnExampleCount: 0 },
        }),
      ],
      emptyAllocatorState,
    );
    expect(feed).not.toContain("judge model");
  });

  test("shows the real prediction when the judge model has actually been trained", () => {
    const feed = renderGrowthFeed(
      [
        makeRecord({
          judgePrediction: { predictedSuccessProbability: 0.73, confidence: "medium", basis: "learned_model", trainedOnExampleCount: 300 },
        }),
      ],
      emptyAllocatorState,
    );
    expect(feed).toContain("judge model: 73% predicted (medium confidence, n=300)");
  });
});
