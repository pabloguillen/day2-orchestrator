import { describe, expect, test } from "bun:test";
import { summarizeApp } from "./app-overview";
import type { AuditEntry } from "./owner-feed";
import type { AppCreditUsage } from "./credits";

const credits: AppCreditUsage = { caps: { monthlyCredits: 6000 }, usedThisMonth: 4210, usedToday: 0, byService: [], byDay: [] };

function audit(timestamp: string, autoShip: boolean): AuditEntry {
  return { timestamp, sourceId: "x", area: "ui-fixes", filesChanged: [], level: "L3", autoShip, reason: "r" };
}

describe("summarizeApp", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");

  test("counts only auto-shipped changes from this calendar month", () => {
    const o = summarizeApp({
      id: "a",
      hasGitRemote: true,
      pendingApprovals: 3,
      audit: [audit("2026-10-02T00:00:00Z", true), audit("2026-10-03T00:00:00Z", false), audit("2026-09-30T23:59:00Z", true)],
      credits,
      killSwitch: false,
      now,
    });
    expect(o.autoShippedThisMonth).toBe(1);
    expect(o.pendingApprovals).toBe(3);
    expect(o.creditsUsedThisMonth).toBe(4210);
    expect(o.monthlyCreditCap).toBe(6000);
  });

  test("pending approvals are unknown (null), not zero, without a git remote", () => {
    const o = summarizeApp({ id: "a", hasGitRemote: false, pendingApprovals: 0, audit: [], credits, killSwitch: false, now });
    expect(o.pendingApprovals).toBeNull();
  });

  test("passes through an unknown (null) count rather than inventing one", () => {
    const o = summarizeApp({ id: "a", hasGitRemote: true, pendingApprovals: null, audit: [], credits, killSwitch: false, now });
    expect(o.pendingApprovals).toBeNull();
  });
});
