import { describe, expect, test } from "bun:test";
import { buildCohortReportCard, buildFunnelSteps, hasChangedMaterially, renderCohortReportCard, renderCohortReportCards } from "./cohort-report-card";
import type { Diagnosis } from "./diagnosis";
import type { MetricValue } from "./metrics";

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
