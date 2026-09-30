/**
 * Integration test (docs/closed-loop-spec.md M2's "Done when": "all KPIs
 * compute for expense-buddy with breakdowns by arm, segment and variant").
 * One realistic, multi-device fixture shaped exactly like real
 * expense-buddy events (M1's envelope: acquisition/sessionId/segmentId/
 * variants), run through every domain's KPI functions together — not just
 * each function in isolation against its own minimal fixture.
 */

import { describe, expect, test } from "bun:test";
import {
  computeActivationRate,
  computeDauWauMau,
  computeSessionsPerUser,
} from "./activation-engagement-kpis";
import { computeCacPaid, computeCtr, computeOrganicShare, computeReferralRate } from "./acquisition-virality-kpis";
import { computeCrashFreeSessions, computeRageClicksPerSession } from "./quality-satisfaction-kpis";
import { computeChurnRate, computeRetention } from "./retention-kpis";
import { computeArpu, computeMrr } from "./monetization-kpis";
import { DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG, EventLike } from "./types";
import type { SpendIngestRow, PaymentIngestRow } from "../external-ingest";

const ASOF = "2026-10-01T00:00:00.000Z";
const config = DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG;

/** Realistic fixture: 3 arms across 2 channels, a mix of activated/
 * non-activated devices, real segments, one active experiment, real
 * sessionIds, a rage-click and a crash on one session. Mirrors what a real
 * `wrangler kv namespace list` + per-device event pull would actually
 * produce once M1's envelope is live (COORDINATION.md W47). */
function buildFixture(): EventLike[] {
  const events: EventLike[] = [];
  const arms: { armKey: string; channel: string; deviceCount: number; activationFraction: number }[] = [
    { armKey: "social_content|video|ugc|angle-1", channel: "paid_social", deviceCount: 6, activationFraction: 2 / 3 },
    { armKey: "social_content|image|static|angle-2", channel: "paid_social", deviceCount: 4, activationFraction: 0.25 },
    { armKey: "seo-organic", channel: "seo", deviceCount: 3, activationFraction: 1 },
  ];
  let deviceCounter = 0;
  for (const arm of arms) {
    for (let i = 0; i < arm.deviceCount; i++) {
      const deviceId = `d${deviceCounter++}`;
      const sessionId = `s-${deviceId}`;
      const landingAt = "2026-09-15T00:00:00.000Z";
      events.push({
        type: "acquisition_landing",
        at: landingAt,
        deviceId,
        sessionId,
        acquisition: { channel: arm.channel, armKey: arm.armKey },
        segmentId: i % 2 === 0 ? "novice" : "established",
        variants: { entry_path: i % 3 === 0 ? "guided" : "compact" },
        appVersion: "1.0.0",
        platform: "web",
      });
      events.push({ type: "session_start", at: landingAt, deviceId, sessionId, acquisition: { channel: arm.channel, armKey: arm.armKey } });
      const activates = i < Math.round(arm.deviceCount * arm.activationFraction);
      if (activates) {
        events.push({ type: "expense_added", at: "2026-09-15T02:00:00.000Z", deviceId, sessionId });
        // Real D7 return for roughly half of activators.
        if (i % 2 === 0) {
          const returnSessionId = `s-${deviceId}-r`;
          events.push({ type: "session_start", at: "2026-09-22T00:00:00.000Z", deviceId, sessionId: returnSessionId });
        }
      }
    }
  }
  // One crash + one rage click on a real session.
  events.push({ type: "crash", at: "2026-09-15T02:05:00.000Z", deviceId: "d0", sessionId: "s-d0" });
  events.push({ type: "rage_click", at: "2026-09-15T02:06:00.000Z", deviceId: "d0", sessionId: "s-d0" });
  // A referral share.
  events.push({ type: "referral_shared", at: "2026-09-16T00:00:00.000Z", deviceId: "d2" });
  return events;
}

const spendRows: SpendIngestRow[] = [
  { armId: "social_content|video|ugc|angle-1", date: "2026-09-15", spendUsd: 60, impressions: 3000, clicks: 90, installs: 6 },
  { armId: "social_content|image|static|angle-2", date: "2026-09-15", spendUsd: 40, impressions: 2000, clicks: 30, installs: 4 },
];

const paymentRows: PaymentIngestRow[] = [
  { date: "2026-09-20", revenueUsd: 9.99, refundsUsd: 0, chargebacksUsd: 0, deviceOrUserId: "d0" },
];

describe("M2 integration — full KPI suite against one realistic expense-buddy-shaped fixture", () => {
  const events = buildFixture();

  test("breaks down real activation rate by arm — the weaker arm is visibly weaker", () => {
    const results = computeActivationRate(events, config, "arm");
    const strong = results.find((r) => r.breakdown.arm === "social_content|video|ugc|angle-1")!;
    const weak = results.find((r) => r.breakdown.arm === "social_content|image|static|angle-2")!;
    expect(strong.value).toBeGreaterThan(weak.value!);
    expect(strong.n).toBe(6);
    expect(weak.n).toBe(4);
  });

  test("breaks down real activation rate by segment", () => {
    const results = computeActivationRate(events, config, "segment");
    const segments = results.map((r) => r.breakdown.segment).sort();
    expect(segments).toEqual(["established", "novice"]);
  });

  test("breaks down real activation rate by variant", () => {
    const results = computeActivationRate(events, config, "variant");
    expect(results.some((r) => r.breakdown.variant === "entry_path=guided")).toBe(true);
    expect(results.some((r) => r.breakdown.variant === "entry_path=compact")).toBe(true);
  });

  test("DAU/WAU/MAU and sessions-per-user compute real, sane numbers app-wide", () => {
    const { mau } = computeDauWauMau(events, config, ASOF);
    expect(mau[0]!.value).toBe(13); // all 13 devices had a session_start within 30 days of ASOF
    const [sessionsPerUser] = computeSessionsPerUser(events);
    expect(sessionsPerUser!.value).toBeGreaterThan(1); // some devices returned
  });

  test("D7 retention is computable and reflects the real return pattern built into the fixture", () => {
    const result = computeRetention(events, { ...config, retentionWindowsDays: [7] }, ASOF, "app");
    expect(result[7]![0]!.value).not.toBeNull();
    expect(result[7]![0]!.value!).toBeGreaterThan(0);
    expect(result[7]![0]!.value!).toBeLessThan(1);
  });

  test("churn rate is computable over the fixture's real activity pattern", () => {
    const result = computeChurnRate(events, config, ASOF, 7);
    expect(result.n).toBeGreaterThan(0);
  });

  test("CTR, CAC (paid), and organic share join real ingest spend against real app-side acquisition events", () => {
    const ctrResults = computeCtr(spendRows);
    expect(ctrResults.length).toBe(2);
    const cac = computeCacPaid(spendRows, events);
    expect(cac.value).not.toBeNull();
    expect(cac.value!).toBeGreaterThan(0);
    const organic = computeOrganicShare(events);
    expect(organic.value).toBeCloseTo(3 / 13, 2); // 3 of 13 devices came from the seo arm
  });

  test("referral rate reflects the one real referral_shared event in the fixture", () => {
    const [result] = computeReferralRate(events);
    expect(result!.value).toBeCloseTo(1 / 13, 5);
  });

  test("crash-free sessions and rage-clicks-per-session reflect the one real bad session", () => {
    const crashFree = computeCrashFreeSessions(events);
    expect(crashFree.n).toBeGreaterThan(0);
    expect(crashFree.value!).toBeLessThan(1); // d0's session had a real crash
    const rage = computeRageClicksPerSession(events);
    expect(rage.value!).toBeGreaterThan(0);
  });

  test("ARPU/MRR compute over real payment rows joined against the real MAU count", () => {
    const { mau } = computeDauWauMau(events, config, ASOF);
    const arpu = computeArpu(paymentRows, mau[0]!.value!);
    expect(arpu.value).toBeCloseTo(9.99 / 13, 3);
    const mrr = computeMrr(paymentRows);
    expect(mrr.value).toBe(9.99);
  });

  test("every domain reports sufficientData: false at this fixture's small scale — never silently claims decision-grade confidence", () => {
    const activation = computeActivationRate(events, config, "app")[0]!;
    expect(activation.sufficientData).toBe(false); // n=13, well under the spec's n=30 bar
  });
});
