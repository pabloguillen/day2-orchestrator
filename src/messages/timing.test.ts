import { describe, expect, test } from "bun:test";
import { isQuiet, localeFromZone, localTime, nextSendAt, usualHour } from "./timing";

const Q = { start: 21, end: 9 };
const BERLIN = { tz: "Europe/Berlin", tzOffset: null };

describe("local time and quiet hours", () => {
  test("reads the zone (with daylight saving), else the offset, else UTC", () => {
    expect(localTime(new Date("2026-07-01T10:00:00Z"), BERLIN).hour).toBe(12);
    expect(localTime(new Date("2026-12-01T10:00:00Z"), BERLIN).hour).toBe(11);
    expect(localTime(new Date("2026-12-01T10:00:00Z"), { tz: null, tzOffset: -300 }).hour).toBe(5);
    expect(localTime(new Date("2026-12-01T10:30:00Z"), { tz: null, tzOffset: null })).toEqual({ hour: 10, minute: 30 });
  });
  test("quiet hours wrap around midnight", () => {
    expect([20, 21, 23, 0, 8, 9].map((h) => isQuiet(h, Q))).toEqual([false, true, true, true, true, false]);
    expect(isQuiet(13, { start: 12, end: 14 })).toBe(true);
    expect(isQuiet(3, { start: 0, end: 0 })).toBe(false);
  });
});

describe("nextSendAt", () => {
  test("now, when it isn't quiet and the usual hour is unknown", () => {
    const now = new Date("2026-11-03T13:00:00Z"); // 14:00 in Berlin
    expect(nextSendAt(now, BERLIN, Q, null, "x").toISOString()).toBe(now.toISOString());
  });
  test("after quiet hours, spread over the first half hour", () => {
    const now = new Date("2026-11-03T21:30:00Z"); // 22:30 in Berlin
    const t = nextSendAt(now, BERLIN, Q, null, "seed");
    const l = localTime(t, BERLIN);
    expect(l.hour).toBe(9);
    expect(l.minute).toBeLessThan(30);
    expect(t.getTime() - now.getTime()).toBeLessThan(12 * 3_600_000);
    // Different users, different minutes.
    const minutes = new Set(["a", "b", "c", "d", "e"].map((s) => localTime(nextSendAt(now, BERLIN, Q, null, s), BERLIN).minute));
    expect(minutes.size).toBeGreaterThan(1);
  });
  test("at the user's usual hour when known (never a quiet one)", () => {
    const now = new Date("2026-11-03T08:00:00Z"); // 09:00 in Berlin
    const t = nextSendAt(now, BERLIN, Q, 18, "u");
    expect(localTime(t, BERLIN).hour).toBe(18);
    expect(t.getTime()).toBeGreaterThan(now.getTime());
    const quiet = nextSendAt(now, BERLIN, Q, 23, "u");
    expect(quiet.toISOString()).toBe(now.toISOString());
  });
});

test("usualHour: the clear favourite outside quiet hours", () => {
  const at = (h: number, d: number) => new Date(Date.UTC(2026, 9, d, h - 1, 10)).toISOString(); // Berlin = UTC+1 in late Oct? use offset zone
  const zone = { tz: null, tzOffset: 60 };
  expect(usualHour([at(18, 1), at(18, 2), at(18, 3), at(12, 4)], zone, Q)).toBe(18);
  expect(usualHour([at(18, 1), at(12, 4)], zone, Q)).toBeNull();
  expect(usualHour([at(22, 1), at(22, 2), at(22, 3)], zone, Q)).toBeNull();
});

test("German-speaking zones suggest German", () => {
  expect(localeFromZone("Europe/Vienna")).toBe("de");
  expect(localeFromZone("Europe/London")).toBeNull();
  expect(localeFromZone(null)).toBeNull();
});
