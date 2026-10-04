import { describe, expect, test } from "bun:test";
import { buildCohortReportCard, buildFunnelSteps, findLinkedItems, hasChangedMaterially, renderCohortReportCard, renderCohortReportCards } from "./cohort-report-card";
import type { Diagnosis } from "./diagnosis";
import type { MetricValue } from "./metrics";
import type { AuditEntry } from "./owner-feed";
import type { RecordedProposal } from "./proposals";

function proposal(overrides: Partial<RecordedProposal> = {}): RecordedProposal {
  return {
    title: "Quick re-add for dominant category",
    rationale: "Users in arm-a are stuck re-picking the same category every time.",
    observedEvidence: "deviceId w1: 6/6 expenses in one category.",
    proposedContract: "type QuickAddShortcut = {...}",
    openQuestions: [],
    recordedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-10-02T00:00:00.000Z",
    sourceId: "src-1",
    area: "release",
    filesChanged: ["src/foo.ts"],
    level: "L3",
    autoShip: true,
    reason: "Bug fix, independently verified, CI green.",
    ...overrides,
  };
}

function mv(value: number | null, n = 200): MetricValue {
  return { metric: "x", breakdown: {}, value, n, ci: null, sufficientData: n >= 30 };
}

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id: "d1",
    appId: "expense-buddy",
    cohortKey: "arm-a@2026-W40",
    ruleId: "D3",
    primary: true,
    evidence: [{ metric: "activation_rate", value: 0.2, baseline: 0.6, n: 150, ci: null }],
    route: "composer",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildFunnelSteps", () => {
  test("marks the primary diagnosis's evidence metric as the weakest step", () => {
    const steps = buildFunnelSteps({ activation_rate: mv(0.2) }, { activation_rate: 0.6 }, "activation_rate");
    const activation = steps.find((s) => s.metric === "activation_rate")!;
    expect(activation.isWeakest).toBe(true);
    expect(steps.filter((s) => s.isWeakest)).toHaveLength(1);
  });

  test("a metric with no real data is still listed, honestly, not dropped", () => {
    const steps = buildFunnelSteps({}, {}, undefined);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.value === null)).toBe(true);
  });

  test("a primary metric outside the listed funnel (e.g. a quality metric) marks nothing weakest, correctly", () => {
    const steps = buildFunnelSteps({ activation_rate: mv(0.6) }, { activation_rate: 0.6 }, "crash_free_sessions");
    expect(steps.every((s) => !s.isWeakest)).toBe(true);
  });
});

describe("hasChangedMaterially", () => {
  test("a real >10% relative move in a funnel metric counts as material", () => {
    const result = hasChangedMaterially({ activation_rate: mv(0.5) }, { activation_rate: mv(0.4) }, "D3", "D3");
    expect(result).toBe(true);
  });

  test("a small, sub-threshold move does not count as material on its own", () => {
    const result = hasChangedMaterially({ activation_rate: mv(0.41) }, { activation_rate: mv(0.4) }, "D3", "D3");
    expect(result).toBe(false);
  });

  test("a changed primary diagnosis is material even with no metric crossing the numeric bar", () => {
    const result = hasChangedMaterially({ activation_rate: mv(0.4) }, { activation_rate: mv(0.4) }, "D4", "D3");
    expect(result).toBe(true);
  });

  test("a diagnosis appearing where there was none before is material", () => {
    const result = hasChangedMaterially({}, {}, "D3", undefined);
    expect(result).toBe(true);
  });

  test("nothing changed at all is not material", () => {
    const result = hasChangedMaterially({ activation_rate: mv(0.4) }, { activation_rate: mv(0.4) }, "D3", "D3");
    expect(result).toBe(false);
  });
});

describe("buildCohortReportCard", () => {
  test("a cohort with a real primary diagnosis gets a real, populated card", () => {
    const card = buildCohortReportCard(
      "arm-a@2026-W40",
      "paid_social",
      "arm-a",
      [diagnosis()],
      { activation_rate: mv(0.2) },
      { activation_rate: 0.6 },
      "Expected to lift activation_rate toward baseline.",
    );
    expect(card.diagnosisSummary).toContain("entry path");
    expect(card.proposedAction).toContain("entry path");
    expect(card.primaryDiagnosis?.ruleId).toBe("D3");
    expect(card.funnel.find((s) => s.metric === "activation_rate")!.isWeakest).toBe(true);
  });

  test("a cohort with no diagnosis at all still gets an honest, non-fabricated card", () => {
    const card = buildCohortReportCard(
      "arm-b@2026-W40",
      "seo",
      "arm-b",
      [],
      { activation_rate: mv(0.6) },
      { activation_rate: 0.55 },
      "No specific expected effect — no diagnosis fired.",
    );
    expect(card.diagnosisSummary).toContain("no specific problem");
    expect(card.primaryDiagnosis).toBeUndefined();
  });

  test("a secondary (non-primary) diagnosis in the list is not what drives the card's summary", () => {
    const secondary = diagnosis({ ruleId: "D7", primary: false, evidence: [{ metric: "refund_rate", value: 0.1, baseline: 0.02, n: 100, ci: null }] });
    const primary = diagnosis({ ruleId: "D3", primary: true });
    const card = buildCohortReportCard("arm-a@2026-W40", "paid_social", "arm-a", [primary, secondary], { activation_rate: mv(0.2) }, { activation_rate: 0.6 }, "x");
    expect(card.primaryDiagnosis?.ruleId).toBe("D3");
  });
});

describe("renderCohortReportCard / renderCohortReportCards", () => {
  test("renders every required element from spec §11: source, funnel, diagnosis, action, effect, buttons", () => {
    const card = buildCohortReportCard(
      "arm-a@2026-W40",
      "paid_social",
      "arm-a",
      [diagnosis()],
      { activation_rate: mv(0.2) },
      { activation_rate: 0.6 },
      "Expected to lift activation_rate toward baseline.",
      "creative-thumb-42.png",
    );
    const rendered = renderCohortReportCard(card);
    expect(rendered).toContain("arm-a@2026-W40");
    expect(rendered).toContain("creative-thumb-42.png");
    expect(rendered).toContain("weakest step");
    expect(rendered).toContain("entry path");
    expect(rendered).toContain("Expected effect:");
    expect(rendered).toContain("[ Apply ]");
    expect(rendered).toContain("[ Undo ]");
    expect(rendered).toContain("[ Ask a question ]");
  });

  test("renderCohortReportCards renders one card per changed cohort, separated, matching M5's own 'Done when' bar", () => {
    const cardA = buildCohortReportCard("arm-a@2026-W40", "paid_social", "arm-a", [diagnosis()], {}, {}, "x");
    const cardB = buildCohortReportCard("arm-b@2026-W40", "seo", "arm-b", [diagnosis({ id: "d2", cohortKey: "arm-b@2026-W40", ruleId: "D1" })], {}, {}, "y");
    const rendered = renderCohortReportCards([cardA, cardB]);
    expect(rendered).toContain("arm-a@2026-W40");
    expect(rendered).toContain("arm-b@2026-W40");
    expect(rendered.split("---")).toHaveLength(2);
  });

  test("zero changed cohorts renders an honest empty state, not a blank string", () => {
    expect(renderCohortReportCards([])).toContain("No cohorts changed materially");
  });
});

describe("findLinkedItems — real cross-references into proposals.ts and owner-feed.ts", () => {
  test("an evolution-routed diagnosis links a real proposal that mentions this arm", () => {
    const d = diagnosis({ ruleId: "D4", route: "evolution", createdAt: "2026-10-01T00:00:00.000Z" });
    const p = proposal({ rationale: "Users in arm-a are stuck re-picking the same category every time.", recordedAt: "2026-10-02T00:00:00.000Z" });
    const linked = findLinkedItems(d, "arm-a", "paid_social", [p], []);
    expect(linked).toEqual([{ feed: "proposals", id: p.title }]);
  });

  test("a proposal recorded BEFORE the diagnosis is excluded — a response can't predate the problem", () => {
    const d = diagnosis({ ruleId: "D4", route: "evolution", createdAt: "2026-10-05T00:00:00.000Z" });
    const p = proposal({ rationale: "Mentions arm-a.", recordedAt: "2026-09-20T00:00:00.000Z" });
    expect(findLinkedItems(d, "arm-a", "paid_social", [p], [])).toEqual([]);
  });

  test("a proposal that never mentions this cohort's arm or channel is excluded", () => {
    const d = diagnosis({ ruleId: "D4", route: "evolution", createdAt: "2026-10-01T00:00:00.000Z" });
    const p = proposal({ rationale: "A totally unrelated pattern in arm-z.", recordedAt: "2026-10-02T00:00:00.000Z" });
    expect(findLinkedItems(d, "arm-a", "paid_social", [p], [])).toEqual([]);
  });

  test("a non-evolution route (e.g. D3's composer route) never scans proposals, even if one mentions the arm", () => {
    const d = diagnosis({ ruleId: "D3", route: "composer", createdAt: "2026-10-01T00:00:00.000Z" });
    const p = proposal({ rationale: "Mentions arm-a directly.", recordedAt: "2026-10-02T00:00:00.000Z" });
    expect(findLinkedItems(d, "arm-a", "paid_social", [p], [])).toEqual([]);
  });

  test("a release-routed diagnosis (D8) links a real owner-feed audit entry that mentions this cohort's channel", () => {
    const d = diagnosis({ ruleId: "D8", route: "release", createdAt: "2026-10-01T00:00:00.000Z" });
    const e = auditEntry({ sourceId: "src-42", reason: "Regression affecting paid_social users after the last release.", timestamp: "2026-10-02T00:00:00.000Z" });
    const linked = findLinkedItems(d, "arm-a", "paid_social", [], [e]);
    expect(linked).toEqual([{ feed: "owner-feed", id: "src-42" }]);
  });

  test("a healing-routed diagnosis (D6) also links a matching owner-feed audit entry", () => {
    const d = diagnosis({ ruleId: "D6", route: "healing", createdAt: "2026-10-01T00:00:00.000Z" });
    const e = auditEntry({ sourceId: "src-7", area: "arm-a", timestamp: "2026-10-02T00:00:00.000Z" });
    expect(findLinkedItems(d, "arm-a", "paid_social", [], [e])).toEqual([{ feed: "owner-feed", id: "src-7" }]);
  });

  test("no diagnosis at all (undefined primary) never links anything", () => {
    const p = proposal({ rationale: "Mentions arm-a." });
    const e = auditEntry({ area: "arm-a" });
    expect(findLinkedItems(undefined, "arm-a", "paid_social", [p], [e])).toEqual([]);
  });

  test("an unattributed arm/unknown channel never produces a match (nothing real and specific to search for)", () => {
    const d = diagnosis({ ruleId: "D4", route: "evolution", createdAt: "2026-10-01T00:00:00.000Z" });
    const p = proposal({ rationale: "unattributed users show this pattern", recordedAt: "2026-10-02T00:00:00.000Z" });
    expect(findLinkedItems(d, "unattributed", "(none)", [p], [])).toEqual([]);
  });
});

describe("buildCohortReportCard — real linkedItems wiring (previously always [])", () => {
  test("a card for an evolution-routed cohort picks up a real matching proposal in linkedItems", () => {
    const d = diagnosis({ ruleId: "D4", route: "evolution", createdAt: "2026-10-01T00:00:00.000Z" });
    const p = proposal({ rationale: "A real pattern observed in arm-a.", recordedAt: "2026-10-02T00:00:00.000Z" });
    const card = buildCohortReportCard(
      "arm-a@2026-W40",
      "paid_social",
      "arm-a",
      [d],
      { activation_rate: mv(0.2) },
      { activation_rate: 0.6 },
      "Expected to lift activation_rate toward baseline.",
      undefined,
      [p],
      [],
    );
    expect(card.linkedItems).toEqual([{ feed: "proposals", id: p.title }]);
  });

  test("a card with no related proposals/audit entries supplied still returns a real empty array, not a crash", () => {
    const card = buildCohortReportCard("arm-a@2026-W40", "paid_social", "arm-a", [diagnosis()], {}, {}, "x");
    expect(card.linkedItems).toEqual([]);
  });

  test("rendering a card with real linkedItems includes the Linked: line", () => {
    const d = diagnosis({ ruleId: "D8", route: "release", createdAt: "2026-10-01T00:00:00.000Z" });
    const e = auditEntry({ sourceId: "src-99", reason: "arm-a regression", timestamp: "2026-10-02T00:00:00.000Z" });
    const card = buildCohortReportCard("arm-a@2026-W40", "paid_social", "arm-a", [d], {}, {}, "x", undefined, [], [e]);
    const rendered = renderCohortReportCard(card);
    expect(rendered).toContain("Linked: owner-feed#src-99");
  });
});
