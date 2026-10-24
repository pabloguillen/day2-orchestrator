import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { arm, hashUser, mayNudge, sha256, stateOf } from "../src/lifecycle";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const ago = (days: number) => NOW - days * 86_400_000;

describe("lifecycle states (Duolingo's model, per rhythm)", () => {
  test("daily habit", () => {
    expect(stateOf([ago(0.1)], NOW, "daily")).toBe("new");
    expect(stateOf([ago(0.1), ago(3)], NOW, "daily")).toBe("current");
    expect(stateOf([ago(0.1), ago(12)], NOW, "daily")).toBe("reactivated");
    expect(stateOf([ago(0.1), ago(60)], NOW, "daily")).toBe("resurrected");
    expect(stateOf([ago(3)], NOW, "daily")).toBe("at_risk");
    expect(stateOf([ago(12)], NOW, "daily")).toBe("lapsing");
    expect(stateOf([ago(45)], NOW, "daily")).toBe("dormant");
    expect(stateOf([], NOW, "daily")).toBeNull();
  });
  test("the same history means something else for a weekly product", () => {
    expect(stateOf([ago(3)], NOW, "weekly")).toBe("new");
    expect(stateOf([ago(3), ago(12)], NOW, "weekly")).toBe("current");
    expect(stateOf([ago(12)], NOW, "weekly")).toBe("at_risk");
    expect(stateOf([ago(45)], NOW, "weekly")).toBe("lapsing");
  });
  test("first activity older than the history passed in", () => {
    expect(stateOf([ago(0.1)], NOW, "daily", ago(400))).toBe("resurrected");
  });
});

describe("holdouts", () => {
  test("sha256 matches the standard", () => {
    for (const s of ["", "abc", "ü€😀 day2", "x".repeat(200)]) expect(sha256(s)).toBe(createHash("sha256").update(s).digest("hex"));
  });
  test("users are hashed per app, never sent as is", () => {
    expect(hashUser("d2k_a", "user-42")).toMatch(/^u_[0-9a-f]{32}$/);
    expect(hashUser("d2k_a", "user-42")).not.toBe(hashUser("d2k_b", "user-42"));
  });
  test("about 10% held out, stable, independent per treatment", () => {
    const users = Array.from({ length: 5000 }, (_, i) => hashUser("d2k_a", `u${i}`));
    const held = users.filter((u) => arm(u, "welcome_back") === "holdout").length / users.length;
    expect(held).toBeGreaterThan(0.085);
    expect(held).toBeLessThan(0.115);
    expect(users.map((u) => arm(u, "welcome_back"))).toEqual(users.map((u) => arm(u, "welcome_back")));
    const both = users.filter((u) => arm(u, "welcome_back") === "holdout" && arm(u, "weekly_digest") === "holdout").length / users.length;
    expect(both).toBeLessThan(0.02);
    expect(arm(null, "welcome_back")).toBe("on");
  });
});

describe("reminders nobody answers stop", () => {
  test("one per period, at most 3 unanswered, reset by activity", () => {
    expect(mayNudge({ sent: [], lastActive: ago(2), now: NOW, rhythm: "daily" })).toBe(true);
    expect(mayNudge({ sent: [ago(0.5)], lastActive: ago(2), now: NOW, rhythm: "daily" })).toBe(false);
    expect(mayNudge({ sent: [ago(1.5), ago(2.5), ago(3.5)], lastActive: ago(5), now: NOW, rhythm: "daily" })).toBe(false);
    expect(mayNudge({ sent: [ago(1.5), ago(2.5), ago(3.5)], lastActive: ago(1.2), now: NOW, rhythm: "daily" })).toBe(true);
  });
});
