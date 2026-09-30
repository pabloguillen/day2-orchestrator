import { describe, expect, test } from "bun:test";
import {
  computeDistinctCountMetric,
  computeMeanMetric,
  computeRateMetric,
  countOfType,
  hasEventType,
  meetsCountedEventThreshold,
} from "./core";
import { EventLike } from "./types";

const events: EventLike[] = [
  // arm-a: 2 devices, 1 activates
  { type: "acquisition_landing", at: "2026-09-01T00:00:00.000Z", deviceId: "d1", acquisition: { channel: "paid_social", armKey: "arm-a" } },
  { type: "expense_added", at: "2026-09-01T01:00:00.000Z", deviceId: "d1" },
  { type: "acquisition_landing", at: "2026-09-01T00:00:00.000Z", deviceId: "d2", acquisition: { channel: "paid_social", armKey: "arm-a" } },
  // arm-b: 1 device, activates
  { type: "acquisition_landing", at: "2026-09-01T00:00:00.000Z", deviceId: "d3", acquisition: { channel: "seo", armKey: "arm-b" } },
  { type: "expense_added", at: "2026-09-01T02:00:00.000Z", deviceId: "d3" },
];

describe("computeRateMetric", () => {
  test("computes a real per-arm activation rate with correct n and value", () => {
    const results = computeRateMetric(
      "activation_rate",
      events,
      "arm",
      () => true,
      (d) => hasEventType(d, "expense_added"),
    );
    const armA = results.find((r) => r.breakdown.arm === "arm-a")!;
    expect(armA.n).toBe(2);
    expect(armA.value).toBeCloseTo(0.5, 5);
    const armB = results.find((r) => r.breakdown.arm === "arm-b")!;
    expect(armB.n).toBe(1);
    expect(armB.value).toBe(1);
  });

  test("a group with zero denominator devices reports null, not zero or a crash", () => {
    const results = computeRateMetric(
      "x",
      events,
      "arm",
      () => false, // nothing ever meets the denominator
      () => true,
    );
    expect(results.every((r) => r.value === null && r.n === 0)).toBe(true);
  });

  test("sufficientData is false below n=30 even when value is a real number", () => {
    const results = computeRateMetric("x", events, "arm", () => true, () => true);
    expect(results.every((r) => r.sufficientData === false)).toBe(true);
  });
});

describe("computeDistinctCountMetric", () => {
  test("counts real distinct devices meeting a predicate, grouped by dimension", () => {
    const results = computeDistinctCountMetric("count", events, "channel", (d) => hasEventType(d, "acquisition_landing"));
    const paidSocial = results.find((r) => r.breakdown.channel === "paid_social")!;
    expect(paidSocial.value).toBe(2);
    const seo = results.find((r) => r.breakdown.channel === "seo")!;
    expect(seo.value).toBe(1);
  });
});

describe("computeMeanMetric", () => {
  test("computes a real per-device mean, excluding devices the valueFn opts out (null)", () => {
    const results = computeMeanMetric("mean_expenses", events, "app", (d) => {
      const c = countOfType(d, "expense_added");
      return c > 0 ? c : null; // only devices that actually added an expense count
    });
    expect(results[0]!.value).toBe(1); // both d1 and d3 added exactly 1 each
    expect(results[0]!.n).toBe(2); // d2 excluded (0 expenses -> null)
  });

  test("an empty group reports null value, n=0, not NaN", () => {
    const results = computeMeanMetric("mean_x", events, "app", () => null);
    expect(results[0]!.value).toBeNull();
    expect(results[0]!.n).toBe(0);
  });
});

describe("meetsCountedEventThreshold", () => {
  test("true when count clears the threshold within the time window", () => {
    const deviceEvents: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d" },
      { type: "expense_added", at: "2026-09-01T02:00:00.000Z", deviceId: "d" },
    ];
    expect(meetsCountedEventThreshold(deviceEvents, "expense_added", 1, 24)).toBe(true);
  });

  test("false when the matching event falls outside the window", () => {
    const deviceEvents: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d" },
      { type: "expense_added", at: "2026-09-03T00:00:00.000Z", deviceId: "d" }, // 48h later
    ];
    expect(meetsCountedEventThreshold(deviceEvents, "expense_added", 1, 24)).toBe(false);
  });

  test("false when the count requirement isn't met even within the window", () => {
    const deviceEvents: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d" },
      { type: "expense_added", at: "2026-09-01T01:00:00.000Z", deviceId: "d" },
    ];
    expect(meetsCountedEventThreshold(deviceEvents, "expense_added", 2, 24)).toBe(false);
  });

  test("an empty device history never meets any threshold", () => {
    expect(meetsCountedEventThreshold([], "expense_added", 1)).toBe(false);
  });
});
