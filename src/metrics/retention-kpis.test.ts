import { describe, expect, test } from "bun:test";
import { computeChurnRate, computeResurrectionRate, computeRetention } from "./retention-kpis";
import { DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG, EventLike } from "./types";

const config = DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG; // activeUser: session_start x1

describe("computeRetention", () => {
  test("D1 retention: real active-on-day-1 devices / eligible devices", () => {
    const asOf = "2026-09-10T00:00:00.000Z";
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" },
      { type: "session_start", at: "2026-09-02T00:00:00.000Z", deviceId: "d1" }, // returns day 1 -> retained
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d2" }, // no day-1 return -> not retained
    ];
    const result = computeRetention(events, { ...config, retentionWindowsDays: [1] }, asOf, "app");
    expect(result[1]![0]!.value).toBeCloseTo(0.5, 5);
    expect(result[1]![0]!.n).toBe(2);
  });

  test("a device too new to judge for a window is excluded from both numerator and denominator", () => {
    const asOf = "2026-09-02T00:00:00.000Z"; // only 1 day after d1's first event — can't judge D7 yet
    const events: EventLike[] = [{ type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" }];
    const result = computeRetention(events, { ...config, retentionWindowsDays: [7] }, asOf, "app");
    expect(result[7]![0]!.n).toBe(0);
    expect(result[7]![0]!.value).toBeNull();
  });

  test("the ±1 day tolerance counts a return on day 8 as D7-retained", () => {
    const asOf = "2026-09-15T00:00:00.000Z";
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" },
      { type: "session_start", at: "2026-09-09T00:00:00.000Z", deviceId: "d1" }, // day 8 — within ±1 of day 7
    ];
    const result = computeRetention(events, { ...config, retentionWindowsDays: [7] }, asOf, "app");
    expect(result[7]![0]!.value).toBe(1);
  });
});

describe("computeChurnRate", () => {
  test("real churn: active last period, not active this period / active last period", () => {
    const asOf = "2026-09-15T00:00:00.000Z"; // periodDays=7: last period [09-01, 09-08), this period [09-08, 09-15]
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-03T00:00:00.000Z", deviceId: "d1" }, // active last period only -> churned
      { type: "session_start", at: "2026-09-03T00:00:00.000Z", deviceId: "d2" },
      { type: "session_start", at: "2026-09-10T00:00:00.000Z", deviceId: "d2" }, // active both periods -> retained
    ];
    const result = computeChurnRate(events, config, asOf, 7);
    expect(result.value).toBeCloseTo(0.5, 5);
    expect(result.n).toBe(2);
  });

  test("a device never active last period doesn't count toward churn at all", () => {
    const asOf = "2026-09-15T00:00:00.000Z";
    const events: EventLike[] = [{ type: "session_start", at: "2026-09-12T00:00:00.000Z", deviceId: "d1" }]; // only active this period
    const result = computeChurnRate(events, config, asOf, 7);
    expect(result.n).toBe(0);
    expect(result.value).toBeNull();
  });
});

describe("computeResurrectionRate", () => {
  test("a real 30+ day gap followed by a return counts as both pool and resurrection", () => {
    const asOf = "2026-10-01T00:00:00.000Z";
    const events: EventLike[] = [
      { type: "session_start", at: "2026-08-01T00:00:00.000Z", deviceId: "d1" },
      { type: "session_start", at: "2026-09-15T00:00:00.000Z", deviceId: "d1" }, // 45-day gap, then returns
    ];
    const result = computeResurrectionRate(events, config, asOf);
    expect(result.n).toBe(1);
    expect(result.value).toBe(1);
  });

  test("a device currently silent 30+ days with no return counts toward the pool but NOT resurrected — the bug this test locks in", () => {
    const asOf = "2026-10-01T00:00:00.000Z";
    const events: EventLike[] = [
      { type: "session_start", at: "2026-08-01T00:00:00.000Z", deviceId: "d1" }, // silent ever since, 60+ days by asOf
    ];
    const result = computeResurrectionRate(events, config, asOf);
    expect(result.n).toBe(1); // in the inactive pool
    expect(result.value).toBe(0); // but never resurrected — must NOT be 1
  });

  test("a device with frequent activity (no 30-day gap, not currently silent) never enters the pool", () => {
    const asOf = "2026-09-10T00:00:00.000Z";
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" },
      { type: "session_start", at: "2026-09-08T00:00:00.000Z", deviceId: "d1" },
    ];
    const result = computeResurrectionRate(events, config, asOf);
    expect(result.n).toBe(0);
    expect(result.value).toBeNull();
  });
});
