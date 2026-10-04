import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEventsFile, parseArgs, writeLearnedEntryPaths } from "./entry-paths-cli";
import type { LearnedEntryPath } from "./entry-paths";

/**
 * This CLI's own logic is arg parsing and file I/O — the math
 * (`learnEntryPaths`) is already exercised end-to-end in
 * entry-paths.test.ts, so these tests don't re-derive real lift/confidence
 * numbers; they prove the CLI wires real file-based input/output correctly,
 * matching the convention `auto-release-cli.test.ts`/`health-scout-cli.test.ts`
 * already establish for CLI-adjacent pure helpers.
 */

describe("parseArgs", () => {
  test("parses --events-file/--out/--as-of, defaulting --active-user-event to session_start", () => {
    const original = process.argv;
    try {
      process.argv = [...original.slice(0, 2), "--events-file", "/tmp/events.json", "--out", "/tmp/out.json"];
      const opts = parseArgs();
      expect(opts.eventsFile).toBe("/tmp/events.json");
      expect(opts.out).toBe("/tmp/out.json");
      expect(opts.activeUserEvent).toBe("session_start");
      expect(opts.asOf).toBeUndefined();
    } finally {
      process.argv = original;
    }
  });

  test("--active-user-event and --as-of override their defaults", () => {
    const original = process.argv;
    try {
      process.argv = [
        ...original.slice(0, 2),
        "--events-file", "/tmp/events.json",
        "--out", "/tmp/out.json",
        "--active-user-event", "expense_added",
        "--as-of", "2026-10-25T00:00:00.000Z",
      ];
      const opts = parseArgs();
      expect(opts.activeUserEvent).toBe("expense_added");
      expect(opts.asOf).toBe("2026-10-25T00:00:00.000Z");
    } finally {
      process.argv = original;
    }
  });
});

describe("loadEventsFile", () => {
  test("reads a real JSON array of events", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-entry-paths-"));
    try {
      const path = join(dir, "events.json");
      const events = [{ type: "acquisition_landing", at: "2026-10-01T00:00:00.000Z", deviceId: "d1" }];
      writeFileSync(path, JSON.stringify(events));
      expect(loadEventsFile(path)).toEqual(events as any);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed events file (not a JSON array) throws rather than silently learning nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-entry-paths-"));
    try {
      const path = join(dir, "events.json");
      writeFileSync(path, JSON.stringify({ not: "an array" }));
      expect(() => loadEventsFile(path)).toThrow("must contain a JSON array");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing events file throws (fail-closed), not an empty learn run", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-entry-paths-"));
    try {
      expect(() => loadEventsFile(join(dir, "does-not-exist.json"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeLearnedEntryPaths", () => {
  test("writes real LearnedEntryPath[] JSON a consuming app's deploy step could read", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-entry-paths-"));
    try {
      const path = join(dir, "out.json");
      const learned: LearnedEntryPath[] = [
        {
          armOrPoolKey: "arm-a",
          entryPathId: "guided_entry",
          slotOverrides: { ExpenseEntryForm: { layout: "guided" } },
          lift: 0.5,
          n: 120,
          confidence: 1,
          learnedAt: "2026-10-25T00:00:00.000Z",
        },
      ];
      writeLearnedEntryPaths(path, learned);
      const written = JSON.parse(readFileSync(path, "utf-8"));
      expect(written).toEqual(learned as any);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty learned-path list still writes a real, valid empty JSON array", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-entry-paths-"));
    try {
      const path = join(dir, "out.json");
      writeLearnedEntryPaths(path, []);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
