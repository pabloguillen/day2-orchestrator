import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReportCardsFromInputs, loadJsonArrayFile, parseArgs } from "./cohort-report-card-cli";
import type { Diagnosis } from "./diagnosis";
import type { EventLike } from "./metrics";
import type { AuditEntry } from "./owner-feed";
import type { RecordedProposal } from "./proposals";

const ASOF = "2026-10-15T00:00:00.000Z";

/** One device's real event history: lands via `arm`, optionally activates. */
function device(deviceId: string, arm: string, channel: string, activated: boolean, at: string): EventLike[] {
  const events: EventLike[] = [
    { type: "acquisition_landing", at, deviceId, acquisition: { channel, armKey: arm } },
    { type: "session_start", at, deviceId },
  ];
  if (activated) events.push({ type: "expense_added", at, deviceId });
  return events;
}

function manyDevices(prefix: string, arm: string, channel: string, n: number, activatedCount: number, at: string): EventLike[] {
  const events: EventLike[] = [];
  for (let i = 0; i < n; i++) {
    events.push(...device(`${prefix}-${i}`, arm, channel, i < activatedCount, at));
  }
  return events;
}

describe("parseArgs", () => {
  test("parses all real flags", () => {
    const original = process.argv;
    try {
      process.argv = [
        ...original.slice(0, 2),
        "--events-file", "/tmp/events.json",
        "--last-week-events-file", "/tmp/last-week.json",
        "--diagnoses-file", "/tmp/diagnoses.json",
        "--proposals-file", "/tmp/proposals.jsonl",
        "--audit-file", "/tmp/audit.jsonl",
        "--as-of", ASOF,
      ];
      const opts = parseArgs();
      expect(opts).toEqual({
        eventsFile: "/tmp/events.json",
        lastWeekEventsFile: "/tmp/last-week.json",
        diagnosesFile: "/tmp/diagnoses.json",
        proposalsFile: "/tmp/proposals.jsonl",
        auditFile: "/tmp/audit.jsonl",
        asOf: ASOF,
      });
    } finally {
      process.argv = original;
    }
  });

  test("optional flags are undefined when omitted", () => {
    const original = process.argv;
    try {
      process.argv = [...original.slice(0, 2), "--events-file", "/tmp/events.json"];
      const opts = parseArgs();
      expect(opts.lastWeekEventsFile).toBeUndefined();
      expect(opts.diagnosesFile).toBeUndefined();
    } finally {
      process.argv = original;
    }
  });
});

describe("loadJsonArrayFile", () => {
  test("reads a real JSON array", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-cohort-card-"));
    try {
      const path = join(dir, "events.json");
      writeFileSync(path, JSON.stringify([{ a: 1 }]));
      expect(loadJsonArrayFile(path, "events")).toEqual([{ a: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed file (not an array) throws rather than silently treating it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-cohort-card-"));
    try {
      const path = join(dir, "events.json");
      writeFileSync(path, JSON.stringify({ not: "an array" }));
      expect(() => loadJsonArrayFile(path, "events")).toThrow("must contain a JSON array");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReportCardsFromInputs — real cards from real metrics + real linked items", () => {
  test("produces a card per real cohort found in the events, with real funnel metrics populated", () => {
    const events = manyDevices("d", "arm-a", "paid_social", 40, 30, "2026-09-01T00:00:00.000Z");
    const cards = buildReportCardsFromInputs({ events, asOfIso: ASOF });

    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.arm).toBe("arm-a");
    expect(card.channel).toBe("paid_social");
    const activation = card.funnel.find((f) => f.metric === "activation_rate")!;
    expect(activation.value).toBeCloseTo(30 / 40, 5);
  });

  test("with no last-week snapshot, every real cohort present is shown (the honest default)", () => {
    const events = [
      ...manyDevices("a", "arm-a", "paid_social", 5, 2, "2026-09-01T00:00:00.000Z"),
      ...manyDevices("b", "arm-b", "seo", 5, 1, "2026-09-01T00:00:00.000Z"),
    ];
    const cards = buildReportCardsFromInputs({ events, asOfIso: ASOF });
    expect(cards.map((c) => c.arm).sort()).toEqual(["arm-a", "arm-b"]);
  });

  test("with a last-week snapshot, a cohort whose metrics didn't move materially is excluded", () => {
    const at = "2026-09-01T00:00:00.000Z";
    const events = manyDevices("d", "arm-a", "paid_social", 100, 50, at); // 50% activation both weeks
    const lastWeekEvents = manyDevices("d", "arm-a", "paid_social", 100, 50, at);
    const cards = buildReportCardsFromInputs({ events, lastWeekEvents, asOfIso: ASOF });
    expect(cards).toHaveLength(0);
  });

  test("with a last-week snapshot, a cohort whose activation rate moved >10% is included", () => {
    const at = "2026-09-01T00:00:00.000Z";
    const lastWeekEvents = manyDevices("d", "arm-a", "paid_social", 100, 20, at); // 20% activation
    const events = manyDevices("d", "arm-a", "paid_social", 100, 80, at); // 80% activation — real, large move
    const cards = buildReportCardsFromInputs({ events, lastWeekEvents, asOfIso: ASOF });
    expect(cards).toHaveLength(1);
  });

  test("real diagnoses + real matching proposals populate linkedItems end to end", () => {
    const at = "2026-09-01T00:00:00.000Z";
    const events = manyDevices("d", "arm-a", "paid_social", 50, 10, at); // low activation
    const diagnoses: Diagnosis[] = [
      {
        id: "diag-1",
        appId: "expense-buddy",
        cohortKey: "arm-a@2026-W36",
        ruleId: "D4",
        primary: true,
        evidence: [{ metric: "activation_rate", value: 0.2, baseline: 0.6, n: 50, ci: null }],
        route: "evolution",
        createdAt: "2026-09-02T00:00:00.000Z",
      },
    ];
    const proposals: RecordedProposal[] = [
      {
        title: "Quick-add for arm-a",
        rationale: "arm-a users struggle with the full form.",
        observedEvidence: "...",
        proposedContract: "...",
        openQuestions: [],
        recordedAt: "2026-09-03T00:00:00.000Z",
      },
    ];
    const cards = buildReportCardsFromInputs({ events, diagnoses, proposals, asOfIso: ASOF });
    const card = cards.find((c) => c.cohortKey === "arm-a@2026-W36");
    expect(card).toBeDefined();
    expect(card!.linkedItems).toEqual([{ feed: "proposals", id: "Quick-add for arm-a" }]);
    expect(card!.primaryDiagnosis?.ruleId).toBe("D4");
  });

  test("real diagnoses + real matching audit entries populate linkedItems for a release-routed cohort", () => {
    const at = "2026-09-01T00:00:00.000Z";
    const events = manyDevices("d", "arm-b", "seo", 50, 10, at);
    const diagnoses: Diagnosis[] = [
      {
        id: "diag-2",
        appId: "expense-buddy",
        cohortKey: "arm-b@2026-W36",
        ruleId: "D8",
        primary: true,
        evidence: [{ metric: "d7_retention", value: 0.1, baseline: 0.4, n: 50, ci: null }],
        route: "release",
        createdAt: "2026-09-02T00:00:00.000Z",
      },
    ];
    const auditEntries: AuditEntry[] = [
      {
        timestamp: "2026-09-03T00:00:00.000Z",
        sourceId: "src-arm-b-1",
        area: "arm-b regression",
        filesChanged: ["src/x.ts"],
        level: "L3",
        autoShip: true,
        reason: "Fixed a crash in arm-b's flow.",
      },
    ];
    const cards = buildReportCardsFromInputs({ events, diagnoses, auditEntries, asOfIso: ASOF });
    const card = cards.find((c) => c.cohortKey === "arm-b@2026-W36");
    expect(card!.linkedItems).toEqual([{ feed: "owner-feed", id: "src-arm-b-1" }]);
  });
});
