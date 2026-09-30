import { describe, expect, test } from "bun:test";
import {
  computeActivationRate,
  computeCoreActionFrequency,
  computeDauWauMau,
  computeFeatureAdoption,
  computeFirstSessionDropOff,
  computeSessionsPerUser,
  computeStickiness,
  computeTimeToValueHours,
} from "./activation-engagement-kpis";
import { DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG, EventLike } from "./types";

const config = DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG; // activation: expense_added x1 within 24h

describe("computeActivationRate", () => {
  test("real per-device activation within the config's threshold", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" },
      { type: "expense_added", at: "2026-09-01T01:00:00.000Z", deviceId: "d1" }, // activates
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d2" }, // never activates
    ];
    const [result] = computeActivationRate(events, config, "app");
    expect(result!.value).toBeCloseTo(0.5, 5);
    expect(result!.n).toBe(2);
  });
});

describe("computeTimeToValueHours", () => {
  test("real median hours-to-activation over devices that actually activated", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" },
      { type: "expense_added", at: "2026-09-01T02:00:00.000Z", deviceId: "d1" }, // 2h
      { type: "session_start", at: "2026-09-02T00:00:00.000Z", deviceId: "d2" },
      { type: "expense_added", at: "2026-09-02T06:00:00.000Z", deviceId: "d2" }, // 6h
      { type: "session_start", at: "2026-09-03T00:00:00.000Z", deviceId: "d3" }, // never activates — excluded
    ];
    const result = computeTimeToValueHours(events, config);
    expect(result.value).toBeCloseTo(4, 5); // median of [2, 6]
    expect(result.n).toBe(2);
  });

  test("zero activators reports null, not NaN/zero", () => {
    const events: EventLike[] = [{ type: "session_start", at: "t0", deviceId: "d1" }];
    expect(computeTimeToValueHours(events, config).value).toBeNull();
  });
});

describe("computeFirstSessionDropOff", () => {
  test("ranks real last-event-before-drop-off among non-activators only", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d1" },
      { type: "screen_view", at: "2026-09-01T00:05:00.000Z", deviceId: "d1" }, // drops off here, never activates
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d2" },
      { type: "expense_added", at: "2026-09-01T00:05:00.000Z", deviceId: "d2" }, // activates — excluded from drop-off counts
    ];
    const result = computeFirstSessionDropOff(events, config);
    expect(result).toEqual([{ eventType: "screen_view", count: 1 }]);
  });
});

describe("DAU/WAU/MAU + stickiness", () => {
  const asOf = "2026-09-30T00:00:00.000Z";
  const events: EventLike[] = [
    { type: "session_start", at: "2026-09-30T00:00:00.000Z", deviceId: "d1" }, // active today
    { type: "session_start", at: "2026-09-25T00:00:00.000Z", deviceId: "d2" }, // active this week, not today
    { type: "session_start", at: "2026-09-05T00:00:00.000Z", deviceId: "d3" }, // active this month only
  ];

  test("DAU/WAU/MAU are real distinct-device counts over their respective windows", () => {
    const { dau, wau, mau } = computeDauWauMau(events, config, asOf);
    expect(dau[0]!.value).toBe(1);
    expect(wau[0]!.value).toBe(2);
    expect(mau[0]!.value).toBe(3);
  });

  test("stickiness is the real DAU/MAU ratio", () => {
    const result = computeStickiness(events, config, asOf);
    expect(result.value).toBeCloseTo(1 / 3, 5);
  });
});

describe("computeSessionsPerUser", () => {
  test("real mean session_start count per device that has at least one", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "t0", deviceId: "d1" },
      { type: "session_start", at: "t1", deviceId: "d1" },
      { type: "session_start", at: "t0", deviceId: "d2" },
    ];
    const [result] = computeSessionsPerUser(events, "app");
    expect(result!.value).toBeCloseTo(1.5, 5);
  });
});

describe("computeFeatureAdoption", () => {
  test("real share of devices using a named feature event", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "t0", deviceId: "d1" },
      { type: "weekly_report_viewed", at: "t1", deviceId: "d1" },
      { type: "session_start", at: "t0", deviceId: "d2" },
    ];
    const [result] = computeFeatureAdoption(events, "weekly_report_viewed");
    expect(result!.value).toBeCloseTo(0.5, 5);
  });
});

describe("computeCoreActionFrequency", () => {
  test("real mean core-action count per active device, config-driven", () => {
    const events: EventLike[] = [
      { type: "expense_added", at: "t0", deviceId: "d1" },
      { type: "expense_added", at: "t1", deviceId: "d1" },
      { type: "expense_added", at: "t0", deviceId: "d2" },
    ];
    const [result] = computeCoreActionFrequency(events, config);
    expect(result!.value).toBeCloseTo(1.5, 5);
  });
});
