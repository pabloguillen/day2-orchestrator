import { describe, expect, test } from "bun:test";
import { clusterSignals } from "./cluster";
import type { Signal } from "./types";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig-1",
    source: "sentry",
    appId: "app-1",
    at: "2026-10-01T00:00:00.000Z",
    finding: "TypeError in checkout",
    evidence: {},
    occurrences: 1,
    affectedUsers: 1,
    suggestedAction: "investigate",
    ...overrides,
  };
}

describe("clusterSignals", () => {
  test("signals on the same app+path cluster into one report", () => {
    const reports = clusterSignals([
      signal({ id: "a", path: "/checkout", source: "sentry" }),
      signal({ id: "b", path: "/checkout", source: "interaction-friction" }),
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.signals).toHaveLength(2);
  });

  test("signals on different paths stay in separate reports", () => {
    const reports = clusterSignals([
      signal({ id: "a", path: "/checkout" }),
      signal({ id: "b", path: "/settings" }),
    ]);
    expect(reports).toHaveLength(2);
  });

  test("signals with no path each get their own report, not grouped together", () => {
    const reports = clusterSignals([signal({ id: "a" }), signal({ id: "b" })]);
    expect(reports).toHaveLength(2);
  });

  test("different apps never cluster together even on the same path", () => {
    const reports = clusterSignals([
      signal({ id: "a", appId: "app-1", path: "/checkout" }),
      signal({ id: "b", appId: "app-2", path: "/checkout" }),
    ]);
    expect(reports).toHaveLength(2);
  });

  test("multi-source corroboration on the same path is always P1, even with low individual counts", () => {
    const reports = clusterSignals([
      signal({ id: "a", path: "/checkout", source: "sentry", occurrences: 1, affectedUsers: 1 }),
      signal({ id: "b", path: "/checkout", source: "interaction-friction", occurrences: 1, affectedUsers: 1 }),
    ]);
    expect(reports[0]!.priority).toBe("P1");
    expect(reports[0]!.reason).toContain("corroborated by 2 signals across 2 source(s)");
  });

  test("single-source but high occurrence/affected-user count is P1", () => {
    const reports = clusterSignals([signal({ affectedUsers: 50, occurrences: 100 })]);
    expect(reports[0]!.priority).toBe("P1");
  });

  test("single-source, low-but-nonzero impact is P2", () => {
    const reports = clusterSignals([signal({ affectedUsers: 1, occurrences: 2 })]);
    expect(reports[0]!.priority).toBe("P2");
  });

  test("single-source, zero-impact signal is P3", () => {
    const reports = clusterSignals([signal({ affectedUsers: 0, occurrences: 1 })]);
    expect(reports[0]!.priority).toBe("P3");
  });

  test("a cluster of entirely low-confidence signals is not actionable", () => {
    const reports = clusterSignals([
      signal({ evidence: { lowConfidence: true } }),
      signal({ id: "b", evidence: { lowConfidence: true } }),
    ]);
    expect(reports[0]!.actionable).toBe(false);
    expect(reports[0]!.reason).toContain("low-confidence");
  });

  test("a cluster with at least one normal signal is actionable, even alongside a low-confidence one", () => {
    const reports = clusterSignals([
      signal({ id: "a", path: "/x", evidence: {} }),
      signal({ id: "b", path: "/x", evidence: { lowConfidence: true } }),
    ]);
    expect(reports[0]!.actionable).toBe(true);
  });

  test("title uses the highest-occurrence signal's finding and notes corroboration count", () => {
    const reports = clusterSignals([
      signal({ id: "a", path: "/x", finding: "minor thing", occurrences: 1 }),
      signal({ id: "b", path: "/x", finding: "the real bug here", occurrences: 99 }),
    ]);
    expect(reports[0]!.title).toContain("the real bug here");
    expect(reports[0]!.title).toContain("+1 corroborating");
  });

  test("empty input produces no reports", () => {
    expect(clusterSignals([])).toEqual([]);
  });
});
