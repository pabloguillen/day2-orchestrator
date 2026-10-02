import { describe, expect, test } from "bun:test";
import { reportsToBugReports } from "./report-to-bug-report";
import type { Report, Signal } from "./types";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig-1",
    source: "sentry",
    appId: "app-1",
    at: "2026-01-01T00:00:00.000Z",
    finding: "TypeError in checkout",
    evidence: { culprit: "checkout.ts" },
    occurrences: 5,
    affectedUsers: 3,
    suggestedAction: "fix the null check",
    ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: "report-1",
    appId: "app-1",
    title: "Checkout fails",
    signals: [signal()],
    priority: "P1",
    actionable: true,
    reason: "single concrete signal",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("reportsToBugReports", () => {
  test("an actionable report becomes a BugReport tagged with the health-scout source", () => {
    const bugReports = reportsToBugReports([report()]);
    expect(bugReports).toHaveLength(1);
    expect(bugReports[0]!.source).toBe("health-scout");
    expect(bugReports[0]!.sourceId).toBe("report-1");
    expect(bugReports[0]!.title).toContain("P1");
    expect(bugReports[0]!.description).toContain("TypeError in checkout");
    expect(bugReports[0]!.description).toContain("fix the null check");
  });

  test("a non-actionable (needs-input) report is excluded entirely, not converted with a caveat", () => {
    const bugReports = reportsToBugReports([report({ actionable: false, reason: "low confidence" })]);
    expect(bugReports).toHaveLength(0);
  });

  test("multiple signals in one report all appear in the evidence section", () => {
    const bugReports = reportsToBugReports([
      report({
        signals: [
          signal({ source: "sentry", finding: "error A" }),
          signal({ source: "interaction-friction", finding: "friction B" }),
        ],
      }),
    ]);
    expect(bugReports[0]!.description).toContain("error A");
    expect(bugReports[0]!.description).toContain("friction B");
    expect(bugReports[0]!.context).toContain("2 real signal(s)");
  });

  test("a mix of actionable and non-actionable reports only converts the actionable ones", () => {
    const bugReports = reportsToBugReports([
      report({ id: "r1", actionable: true }),
      report({ id: "r2", actionable: false }),
    ]);
    expect(bugReports).toHaveLength(1);
    expect(bugReports[0]!.sourceId).toBe("r1");
  });

  test("empty input produces no bug reports", () => {
    expect(reportsToBugReports([])).toEqual([]);
  });
});
