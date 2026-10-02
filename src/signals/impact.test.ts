import { describe, expect, test } from "bun:test";
import { measureImpact } from "./impact";
import type { Report, Signal } from "./types";

function sentrySignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig-1",
    source: "sentry",
    appId: "app-1",
    at: "2026-01-01T00:00:00.000Z",
    finding: "TypeError in checkout",
    evidence: { permalink: "https://sentry.io/issues/123" },
    occurrences: 10,
    affectedUsers: 5,
    path: "checkout.ts",
    suggestedAction: "fix it",
    ...overrides,
  };
}

function frictionSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig-2",
    source: "interaction-friction",
    appId: "app-1",
    at: "2026-01-01T00:00:00.000Z",
    finding: "rage click",
    evidence: { target: "id:save" },
    occurrences: 10,
    affectedUsers: 5,
    path: "/checkout",
    suggestedAction: "fix it",
    ...overrides,
  };
}

function report(signals: Signal[]): Report {
  return {
    id: "report-1",
    appId: "app-1",
    title: "x",
    signals,
    priority: "P1",
    actionable: true,
    reason: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("measureImpact", () => {
  test("a Sentry issue absent from the fresh sweep entirely is cleared", () => {
    const result = measureImpact(report([sentrySignal()]), []);
    expect(result.cleared).toBe(true);
    expect(result.signalOutcomes[0]!.stillPresent).toBe(false);
  });

  test("a Sentry issue still present with high occurrence count is NOT cleared", () => {
    const fresh = [sentrySignal({ occurrences: 15 })];
    const result = measureImpact(report([sentrySignal()]), fresh);
    expect(result.cleared).toBe(false);
    expect(result.signalOutcomes[0]!.stillPresent).toBe(true);
  });

  test("a Sentry issue present but with only noise-level occurrences counts as cleared", () => {
    const fresh = [sentrySignal({ occurrences: 1 })];
    const result = measureImpact(report([sentrySignal()]), fresh);
    expect(result.cleared).toBe(true);
  });

  test("matches Sentry signals by permalink identity, not just path — a different issue at the same path doesn't count as recurrence", () => {
    const originalIssue = sentrySignal({ evidence: { permalink: "https://sentry.io/issues/123" } });
    const differentIssueSamePath = sentrySignal({
      evidence: { permalink: "https://sentry.io/issues/999" },
      occurrences: 50,
    });
    const result = measureImpact(report([originalIssue]), [differentIssueSamePath]);
    expect(result.cleared).toBe(true);
  });

  test("friction signals match by path+target", () => {
    const result = measureImpact(report([frictionSignal()]), [frictionSignal({ occurrences: 20 })]);
    expect(result.cleared).toBe(false);
  });

  test("friction signal for a different target at the same path is not a match", () => {
    const result = measureImpact(
      report([frictionSignal({ evidence: { target: "id:save" } })]),
      [frictionSignal({ evidence: { target: "id:cancel" }, occurrences: 50 })],
    );
    expect(result.cleared).toBe(true);
  });

  test("a report with multiple signals is only cleared if ALL of them cleared", () => {
    const result = measureImpact(
      report([sentrySignal({ id: "a" }), frictionSignal({ id: "b" })]),
      [sentrySignal({ id: "a", occurrences: 50 })], // sentry one recurs, friction one is gone
    );
    expect(result.cleared).toBe(false);
    expect(result.signalOutcomes.find((o) => o.signalId === "a")!.stillPresent).toBe(true);
    expect(result.signalOutcomes.find((o) => o.signalId === "b")!.stillPresent).toBe(false);
  });

  test("signals from a different app never match, even with identical evidence", () => {
    const result = measureImpact(
      report([sentrySignal({ appId: "app-1" })]),
      [sentrySignal({ appId: "app-2", occurrences: 50 })],
    );
    expect(result.cleared).toBe(true);
  });
});
