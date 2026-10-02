import { describe, expect, test } from "bun:test";
import {
  groupDevicesByDimension,
  isoWeek,
  poolCohortIfSparse,
  resolveAllDeviceBreakdowns,
  resolveDeviceBreakdown,
} from "./breakdown";
import { EventLike, UNATTRIBUTED_ARM, UNKNOWN_BUCKET } from "./types";

describe("isoWeek", () => {
  test("a known reference date: 2026-09-30 is ISO week 2026-W40", () => {
    expect(isoWeek("2026-09-30T00:00:00.000Z")).toBe("2026-W40");
  });

  test("Jan 1 of a year can belong to the previous ISO year's last week", () => {
    // 2027-01-01 is a Friday; ISO week containing it belongs to 2026-W53.
    expect(isoWeek("2027-01-01T00:00:00.000Z")).toBe("2026-W53");
  });
});

describe("resolveDeviceBreakdown", () => {
  test("a real paid-arm device resolves arm/channel/cohort from its first real acquisition_landing", () => {
    const events: EventLike[] = [
      {
        type: "acquisition_landing",
        at: "2026-09-30T10:00:00.000Z",
        deviceId: "d1",
        acquisition: { channel: "paid_social", armKey: "social_content|video|ugc|angle-1" },
      },
      { type: "expense_added", at: "2026-09-30T10:05:00.000Z", deviceId: "d1" },
    ];
    const resolved = resolveDeviceBreakdown(events);
    expect(resolved.arm).toBe("social_content|video|ugc|angle-1");
    expect(resolved.channel).toBe("paid_social");
    expect(resolved.cohort).toBe("social_content|video|ugc|angle-1@2026-W40");
  });

  test("a device with no acquisition context resolves to unattributed/unknown, not a crash", () => {
    const events: EventLike[] = [{ type: "session_start", at: "2026-09-30T10:00:00.000Z", deviceId: "d2" }];
    const resolved = resolveDeviceBreakdown(events);
    expect(resolved.arm).toBe(UNATTRIBUTED_ARM);
    expect(resolved.channel).toBe(UNKNOWN_BUCKET);
  });

  test("segment/appVersion/platform take the LATEST non-undefined value across a device's history", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "2026-09-01T00:00:00.000Z", deviceId: "d3", segmentId: "novice" },
      { type: "session_start", at: "2026-09-10T00:00:00.000Z", deviceId: "d3", segmentId: "established" },
    ];
    expect(resolveDeviceBreakdown(events).segment).toBe("established");
  });

  test("variant collapses multiple active experiments into one sorted, joined string", () => {
    const events: EventLike[] = [
      {
        type: "session_start",
        at: "2026-09-01T00:00:00.000Z",
        deviceId: "d4",
        variants: { exp_b: "B", exp_a: "A" },
      },
    ];
    expect(resolveDeviceBreakdown(events).variant).toBe("exp_a=A,exp_b=B");
  });
});

describe("resolveAllDeviceBreakdowns + groupDevicesByDimension", () => {
  test("groups real multi-device event streams correctly by arm", () => {
    const events: EventLike[] = [
      { type: "acquisition_landing", at: "t0", deviceId: "d1", acquisition: { channel: "paid_social", armKey: "arm-a" } },
      { type: "acquisition_landing", at: "t0", deviceId: "d2", acquisition: { channel: "paid_social", armKey: "arm-a" } },
      { type: "acquisition_landing", at: "t0", deviceId: "d3", acquisition: { channel: "seo", armKey: "arm-b" } },
    ];
    const breakdowns = resolveAllDeviceBreakdowns(events);
    const groups = groupDevicesByDimension(breakdowns.keys(), breakdowns, "arm");
    expect(groups.get("arm-a")?.sort()).toEqual(["d1", "d2"]);
    expect(groups.get("arm-b")).toEqual(["d3"]);
  });

  test("dimension 'app' isn't special-cased by groupDevicesByDimension — every device shares the constant 'app' key", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "t0", deviceId: "d1" },
      { type: "session_start", at: "t0", deviceId: "d2" },
    ];
    const breakdowns = resolveAllDeviceBreakdowns(events);
    const groups = groupDevicesByDimension(breakdowns.keys(), breakdowns, "app");
    expect(groups.size).toBe(1);
    expect(groups.get("app")?.sort()).toEqual(["d1", "d2"]);
  });
});

describe("poolCohortIfSparse", () => {
  test("uses the arm level when the arm itself clears the minimum", () => {
    expect(poolCohortIfSparse("arm-a", "paid_social", 40, 100, 30)).toEqual({ level: "arm", key: "arm-a", borrowed: false });
  });

  test("falls back to channel, marked borrowed, when the arm is too sparse", () => {
    expect(poolCohortIfSparse("arm-a", "paid_social", 5, 40, 30)).toEqual({
      level: "channel",
      key: "paid_social",
      borrowed: true,
    });
  });

  test("falls back to app-wide, marked borrowed, when both arm and channel are sparse", () => {
    expect(poolCohortIfSparse("arm-a", "paid_social", 5, 5, 30)).toEqual({ level: "app", key: "app", borrowed: true });
  });
});
