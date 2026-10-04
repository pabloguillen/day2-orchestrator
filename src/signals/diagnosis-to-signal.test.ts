import { describe, expect, test } from "bun:test";
import { diagnosesToSignals, diagnosisToSignal } from "./diagnosis-to-signal";
import type { Diagnosis } from "../diagnosis";

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id: "app-1:cohort-a:D6:2026-10-01T00:00:00.000Z",
    appId: "app-1",
    cohortKey: "cohort-a",
    ruleId: "D6",
    primary: true,
    evidence: [{ metric: "error_rate", value: 0.08, baseline: 0.02, n: 150, ci: null }],
    route: "healing",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("diagnosisToSignal", () => {
  test("a healing-routed diagnosis converts into a real Signal", () => {
    const signal = diagnosisToSignal(diagnosis());
    expect(signal.source).toBe("growth-diagnosis");
    expect(signal.appId).toBe("app-1");
    expect(signal.id).toBe("diagnosis-app-1:cohort-a:D6:2026-10-01T00:00:00.000Z");
    expect(signal.at).toBe("2026-10-01T00:00:00.000Z");
    expect(signal.path).toBe("cohort-a");
    expect(signal.finding).toContain("cohort-a");
    expect(signal.finding).toContain("D6");
    expect(signal.finding).toContain("error_rate");
    expect(signal.suggestedAction).toContain("D6");
    expect(signal.suggestedAction).toContain("cohort-a");
  });

  test("occurrences is the largest evidence metric's sample size, not a fabricated count", () => {
    const signal = diagnosisToSignal(
      diagnosis({
        evidence: [
          { metric: "crash_free_sessions", value: 0.9, baseline: 0.99, n: 40, ci: null },
          { metric: "error_rate", value: 0.08, baseline: 0.02, n: 200, ci: null },
        ],
      }),
    );
    expect(signal.occurrences).toBe(200);
  });

  test("affectedUsers is honestly disclosed as 0 (unknown at the cohort-diagnosis level), not fabricated", () => {
    const signal = diagnosisToSignal(diagnosis());
    expect(signal.affectedUsers).toBe(0);
  });

  test("a segmentId, when present, is folded into the signal's path for clustering", () => {
    const signal = diagnosisToSignal(diagnosis({ segmentId: "seg-1" }));
    expect(signal.path).toBe("cohort-a/seg-1");
  });

  test("evidence and ruleId carry through into the signal's evidence record", () => {
    const signal = diagnosisToSignal(diagnosis());
    expect(signal.evidence.ruleId).toBe("D6");
    expect(signal.evidence.cohortKey).toBe("cohort-a");
    expect(signal.evidence.metrics).toEqual(diagnosis().evidence);
  });

  test("throws for a non-healing-routed diagnosis rather than silently converting it", () => {
    expect(() => diagnosisToSignal(diagnosis({ route: "creative", ruleId: "D1" }))).toThrow(/healing/);
  });
});

describe("diagnosesToSignals", () => {
  test("filters out every non-healing-routed diagnosis before converting", () => {
    const signals = diagnosesToSignals([
      diagnosis({ id: "d-healing", route: "healing" }),
      diagnosis({ id: "d-creative", route: "creative", ruleId: "D1" }),
      diagnosis({ id: "d-allocator", route: "allocator", ruleId: "D5" }),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe("diagnosis-d-healing");
  });

  test("an empty diagnoses list produces an empty signals list", () => {
    expect(diagnosesToSignals([])).toEqual([]);
  });

  test("multiple healing-routed diagnoses each produce their own signal", () => {
    const signals = diagnosesToSignals([
      diagnosis({ id: "d-1", cohortKey: "cohort-a" }),
      diagnosis({ id: "d-2", cohortKey: "cohort-b" }),
    ]);
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.path)).toEqual(["cohort-a", "cohort-b"]);
  });
});
