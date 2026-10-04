import { describe, expect, test } from "bun:test";
import { isAlreadyProcessed } from "./pipeline";
import type { BugReport } from "./types";

function bugReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    title: "Checkout fails",
    description: "TypeError in checkout",
    sourceId: "sentry-issue-1",
    source: "sentry",
    ...overrides,
  };
}

describe("isAlreadyProcessed", () => {
  test("a brand-new sourceId is not already processed", () => {
    expect(isAlreadyProcessed(new Set(), bugReport())).toBe(false);
  });

  test("a previously-seen sourceId is already processed", () => {
    const processed = new Set(["sentry-issue-1"]);
    expect(isAlreadyProcessed(processed, bugReport())).toBe(true);
  });

  test("the same Sentry issue reported again via a health-scout cluster is recognized as already processed", () => {
    // The classic sentry.ts path already processed this issue under its own sourceId...
    const processed = new Set(["sentry-issue-1", "https://sentry.io/organizations/x/issues/1/"]);
    // ...and a health-scout cluster corroborating the same issue carries a
    // different sourceId (its own report id) but the same correlationKey.
    const healthScoutReport = bugReport({
      sourceId: "report-health-scout-42",
      source: "health-scout",
      correlationKey: "https://sentry.io/organizations/x/issues/1/",
    });
    expect(isAlreadyProcessed(processed, healthScoutReport)).toBe(true);
  });

  test("a health-scout report with no correlationKey only matches on sourceId", () => {
    const processed = new Set(["some-other-report-id"]);
    const healthScoutReport = bugReport({
      sourceId: "report-health-scout-99",
      source: "health-scout",
      correlationKey: undefined,
    });
    expect(isAlreadyProcessed(processed, healthScoutReport)).toBe(false);
  });

  test("a matching correlationKey is sufficient even if sourceId differs and was never seen", () => {
    const processed = new Set(["https://sentry.io/organizations/x/issues/7/"]);
    const report = bugReport({
      sourceId: "report-health-scout-7",
      correlationKey: "https://sentry.io/organizations/x/issues/7/",
    });
    expect(isAlreadyProcessed(processed, report)).toBe(true);
  });
});
