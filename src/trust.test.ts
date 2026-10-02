import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { AuditEntry } from "./owner-feed";
import {
  computeTrackRecord,
  loadAutonomyOutcomes,
  proposeLevelUp,
  recordAutonomyOutcome,
  LEVEL_UP_STREAK_THRESHOLD,
  type AutonomyOutcome,
} from "./trust";

function decision(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-10-01T00:00:00.000Z",
    sourceId: "src-1",
    area: "ui-fixes",
    filesChanged: ["src/components/Foo.tsx"],
    level: "L3",
    autoShip: true,
    reason: "eligible",
    ...overrides,
  };
}

function outcome(overrides: Partial<AutonomyOutcome> = {}): AutonomyOutcome {
  return {
    timestamp: "2026-10-01T00:10:00.000Z",
    sourceId: "src-1",
    status: "promoted",
    reason: "clean canary",
    ...overrides,
  };
}

describe("computeTrackRecord", () => {
  test("a clean run of N auto-ships with known outcomes counts N consecutive clean", () => {
    const decisions = [1, 2, 3, 4].map((i) =>
      decision({ sourceId: `src-${i}`, timestamp: `2026-10-0${i}T00:00:00.000Z` }),
    );
    const outcomes = [1, 2, 3, 4].map((i) =>
      outcome({ sourceId: `src-${i}`, timestamp: `2026-10-0${i}T00:10:00.000Z` }),
    );
    const record = computeTrackRecord(decisions, outcomes, "ui-fixes");
    expect(record.consecutiveCleanAutoShips).toBe(4);
    expect(record.totalAutoShipsWithKnownOutcome).toBe(4);
    expect(record.totalRollbacks).toBe(0);
  });

  test("a rollback in the middle resets the streak to only what's after it", () => {
    const decisions = [1, 2, 3, 4].map((i) => decision({ sourceId: `src-${i}`, timestamp: `2026-10-0${i}T00:00:00.000Z` }));
    const outcomes = [
      outcome({ sourceId: "src-1", status: "promoted", timestamp: "2026-10-01T00:10:00.000Z" }),
      outcome({ sourceId: "src-2", status: "rolled_back", timestamp: "2026-10-02T00:10:00.000Z" }),
      outcome({ sourceId: "src-3", status: "promoted", timestamp: "2026-10-03T00:10:00.000Z" }),
      outcome({ sourceId: "src-4", status: "promoted", timestamp: "2026-10-04T00:10:00.000Z" }),
    ];
    const record = computeTrackRecord(decisions, outcomes, "ui-fixes");
    expect(record.consecutiveCleanAutoShips).toBe(2); // src-3, src-4 only
    expect(record.totalRollbacks).toBe(1);
    expect(record.totalAutoShipsWithKnownOutcome).toBe(4);
  });

  test("decisions with no recorded outcome yet are skipped, not counted as clean or dirty", () => {
    const decisions = [1, 2].map((i) => decision({ sourceId: `src-${i}`, timestamp: `2026-10-0${i}T00:00:00.000Z` }));
    const record = computeTrackRecord(decisions, [], "ui-fixes"); // no outcomes recorded at all
    expect(record.consecutiveCleanAutoShips).toBe(0);
    expect(record.totalAutoShipsWithKnownOutcome).toBe(0);
  });

  test("other areas and non-auto-shipped decisions don't pollute this area's record", () => {
    const decisions = [
      decision({ sourceId: "src-1", area: "ui-fixes", autoShip: true }),
      decision({ sourceId: "src-2", area: "billing", autoShip: true }), // different area
      decision({ sourceId: "src-3", area: "ui-fixes", autoShip: false }), // not auto-shipped
    ];
    const outcomes = [
      outcome({ sourceId: "src-1" }),
      outcome({ sourceId: "src-2", status: "rolled_back" }),
      outcome({ sourceId: "src-3", status: "rolled_back" }),
    ];
    const record = computeTrackRecord(decisions, outcomes, "ui-fixes");
    expect(record.totalAutoShipsWithKnownOutcome).toBe(1);
    expect(record.consecutiveCleanAutoShips).toBe(1);
    expect(record.totalRollbacks).toBe(0);
  });
});

describe("proposeLevelUp", () => {
  test("a streak at or above the threshold suggests the next level up", () => {
    const record = { area: "ui-fixes", consecutiveCleanAutoShips: LEVEL_UP_STREAK_THRESHOLD, totalAutoShipsWithKnownOutcome: LEVEL_UP_STREAK_THRESHOLD, totalRollbacks: 0 };
    const suggestion = proposeLevelUp(record, "L3");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.currentLevel).toBe("L3");
    expect(suggestion!.suggestedLevel).toBe("L4");
    expect(suggestion!.reason).toContain("autonomy-config-cli.ts");
  });

  test("a streak below the threshold suggests nothing", () => {
    const record = { area: "ui-fixes", consecutiveCleanAutoShips: LEVEL_UP_STREAK_THRESHOLD - 1, totalAutoShipsWithKnownOutcome: LEVEL_UP_STREAK_THRESHOLD - 1, totalRollbacks: 0 };
    expect(proposeLevelUp(record, "L3")).toBeNull();
  });

  test("already at L5 suggests nothing — there's no higher level", () => {
    const record = { area: "ui-fixes", consecutiveCleanAutoShips: 999, totalAutoShipsWithKnownOutcome: 999, totalRollbacks: 0 };
    expect(proposeLevelUp(record, "L5")).toBeNull();
  });

  test("a custom threshold is honored", () => {
    const record = { area: "ui-fixes", consecutiveCleanAutoShips: 3, totalAutoShipsWithKnownOutcome: 3, totalRollbacks: 0 };
    expect(proposeLevelUp(record, "L3", 3)).not.toBeNull();
    expect(proposeLevelUp(record, "L3", 4)).toBeNull();
  });
});

describe("recordAutonomyOutcome / loadAutonomyOutcomes", () => {
  const file = "/tmp/day2-trust-test-outcomes.jsonl";
  afterEach(() => {
    if (existsSync(file)) rmSync(file);
  });

  test("round-trips entries written to disk", () => {
    recordAutonomyOutcome(file, outcome({ sourceId: "a" }));
    recordAutonomyOutcome(file, outcome({ sourceId: "b", status: "rolled_back" }));
    const loaded = loadAutonomyOutcomes(file);
    expect(loaded.length).toBe(2);
    expect(loaded[0]!.sourceId).toBe("a");
    expect(loaded[1]!.status).toBe("rolled_back");
  });

  test("a missing file loads as empty, not an error", () => {
    expect(loadAutonomyOutcomes("/tmp/day2-trust-does-not-exist.jsonl")).toEqual([]);
  });
});
