import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAutonomyAudit, evaluateAutonomy, DEFAULT_AUTONOMY_CONFIG } from "./autonomy";
import { loadAuditEntries, renderEntry, renderFeed } from "./owner-feed";
import type { AutonomyConfig, ChangeForAutonomy } from "./types";

const cleanBugfix: ChangeForAutonomy = {
  sourceId: "test-1",
  filesChanged: ["src/routes/index.tsx"],
  isBugfix: true,
  verifierApproved: true,
  ciPassed: true,
};

describe("renderEntry", () => {
  test("with summary present, auto-shipped", () => {
    const decision = evaluateAutonomy(cleanBugfix, {
      defaultLevel: "L3",
      areas: [],
    } as AutonomyConfig);
    const line = renderEntry({
      timestamp: "2026-09-25T10:00:00.000Z",
      sourceId: "test-1",
      area: decision.area,
      filesChanged: cleanBugfix.filesChanged,
      level: decision.level,
      autoShip: decision.autoShip,
      reason: decision.reason,
      summary: "a checkout crash affecting Android users",
    });
    expect(line).toBe(
      "Fixed a checkout crash affecting Android users — shipped automatically to canary (default).",
    );
  });

  test("with summary present, opened for review", () => {
    const decision = evaluateAutonomy(cleanBugfix, DEFAULT_AUTONOMY_CONFIG);
    const line = renderEntry({
      timestamp: "2026-09-25T10:00:00.000Z",
      sourceId: "test-1",
      area: decision.area,
      filesChanged: cleanBugfix.filesChanged,
      level: decision.level,
      autoShip: decision.autoShip,
      reason: decision.reason,
      summary: "a checkout crash affecting Android users",
    });
    expect(line).toContain("Fixed a checkout crash affecting Android users — opened for review");
  });

  test("without summary, falls back to file/area description", () => {
    const decision = evaluateAutonomy(cleanBugfix, DEFAULT_AUTONOMY_CONFIG);
    const line = renderEntry({
      timestamp: "2026-09-25T10:00:00.000Z",
      sourceId: "test-1",
      area: decision.area,
      filesChanged: cleanBugfix.filesChanged,
      level: decision.level,
      autoShip: decision.autoShip,
      reason: decision.reason,
    });
    expect(line).toContain("Change touching 1 file in default — opened for review.");
  });
});

describe("loadAuditEntries + renderFeed", () => {
  test("reads real audit-log entries written by recordAutonomyAudit and renders a feed", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-feed-"));
    const auditFile = join(dir, "audit.jsonl");
    try {
      const shipDecision = evaluateAutonomy(cleanBugfix, {
        defaultLevel: "L3",
        areas: [],
      } as AutonomyConfig);
      recordAutonomyAudit(auditFile, cleanBugfix, shipDecision, "a checkout crash");

      const reviewDecision = evaluateAutonomy(
        { ...cleanBugfix, sourceId: "test-2" },
        DEFAULT_AUTONOMY_CONFIG,
      );
      recordAutonomyAudit(auditFile, { ...cleanBugfix, sourceId: "test-2" }, reviewDecision);

      const entries = loadAuditEntries(auditFile);
      expect(entries).toHaveLength(2);
      expect(entries[0].sourceId).toBe("test-1");
      expect(entries[0].summary).toBe("a checkout crash");
      expect(entries[1].summary).toBeUndefined();

      const feed = renderFeed(entries);
      expect(feed).toContain("Fixed a checkout crash — shipped automatically to canary");
      expect(feed).toContain("Change touching 1 file in default — opened for review.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing audit file returns empty list, empty feed says so", () => {
    expect(loadAuditEntries("/tmp/day2-owner-feed-does-not-exist.jsonl")).toEqual([]);
    expect(renderFeed([])).toBe("No changes recorded yet.");
  });
});
