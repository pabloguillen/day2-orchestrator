import { describe, expect, test } from "bun:test";
import { arm } from "../../packages/sensors/src/lifecycle";
import type { UserActivity } from "../field-store";
import type { RetentionSnapshot } from "../retention";
import { audienceOf, guardrailFor, measureCampaign, missingAudiences, missingTriggers, queueFor, reachOf } from "./campaigns";
import { DEFAULT_SETTINGS, type Campaign, type PushToken, type SendRecord } from "./types";

const NOW = new Date("2026-11-03T13:00:00Z");
const DAY = 86_400_000;
const day = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);
const frac = (i: number) => ((i * 7919) % 997) / 997;
const hex = (i: number) => i.toString(16).padStart(32, "0");
const user = (i: number) => `u_${hex(i)}`;
const act = (u: string, days: number[], first?: number): UserActivity => {
  const ds = days.map(day).sort();
  return { user: u, firstSeen: first !== undefined ? day(first) : ds[0]!, lastSeen: ds.at(-1)!, days: ds };
};
const token = (u: string, i = 0): PushToken => ({ user: u, token: `ExponentPushToken[${u.slice(2, 22)}${i}]`, platform: "ios", tz: "Europe/Berlin", tzOffset: null, locale: "de", updatedAt: NOW.toISOString(), invalidatedAt: null, invalidReason: null });

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "msg-at-risk-1",
  kind: "lifecycle",
  name: "At-risk users",
  audience: "at_risk",
  channel: "push",
  texts: { de: { title: "Hallo", body: "Neues Rätsel" }, en: { title: "Hi", body: "New puzzle" } },
  status: "active",
  holdout: 0.1,
  by: "day2",
  createdAt: new Date(NOW.getTime() - 40 * DAY).toISOString(),
  updatedAt: NOW.toISOString(),
  approvedAt: new Date(NOW.getTime() - 40 * DAY).toISOString(),
  checks: { ok: true, issues: [] },
  result: { state: "collecting", note: "", treated: 0, held: 0 },
  ...over,
});

describe("audienceOf", () => {
  test("onboarding day 1 and day 3, at risk, lapsing, win-back", () => {
    expect(audienceOf(act(user(1), [1]), NOW, "daily")).toBe("onboarding_d1");
    expect(audienceOf(act(user(1), [3]), NOW, "daily")).toBe("onboarding_d3");
    expect(audienceOf(act(user(1), [3, 2]), NOW, "daily")).toBe("onboarding_d3"); // not back in the last two days
    expect(audienceOf(act(user(1), [3, 1]), NOW, "daily")).toBe("at_risk"); // back yesterday
    expect(audienceOf(act(user(1), [10, 9, 4]), NOW, "daily")).toBe("at_risk");
    expect(audienceOf(act(user(1), [40, 20]), NOW, "daily")).toBe("lapsing");
    expect(audienceOf(act(user(1), [100, 60]), NOW, "daily")).toBe("winback");
    expect(audienceOf(act(user(1), [500, 450]), NOW, "daily")).toBeNull(); // tokens are gone by then
    expect(audienceOf(act(user(1), [5, 0]), NOW, "daily")).toBeNull(); // active today
  });
});

describe("queueFor", () => {
  const users = Array.from({ length: 300 }, (_, i) => user(i + 1));
  const reach = reachOf(users.map((u) => token(u)));
  const base = { campaign: campaign(), reach, history: [] as SendRecord[], settings: DEFAULT_SETTINGS, rhythm: "daily" as const, now: NOW, fallbackZone: { tz: null, tzOffset: null }, nudgeRule: true, againAfterDays: 0 };

  test("queues the treated, records the held out, at a good local time", () => {
    const recs = queueFor({ ...base, candidates: users.map((u) => ({ user: u, lastActive: day(3) })) });
    expect(recs).toHaveLength(300);
    const held = recs.filter((r) => r.status === "held");
    expect(held.length).toBeGreaterThan(10);
    expect(held.length).toBeLessThan(60);
    for (const r of recs) expect(r.arm).toBe(arm(r.user, "msg-at-risk-1", 0.1));
    const q = recs.find((r) => r.status === "queued")!;
    expect(q.locale).toBe("de");
    expect(q.dueAt >= NOW.toISOString()).toBe(true); // 14:00 Berlin → now
    expect(Date.parse(q.expiresAt) - Date.parse(q.dueAt)).toBe(30 * 3_600_000);
  });

  test("no push, already in it since last active, weekly limit, stop when ignored", () => {
    const u = users[0]!;
    const pushed = (n: number, cid = "other"): SendRecord => ({ id: `s${n}${cid}`, campaignId: cid, user: u, channel: "push", arm: "on", status: "sent", locale: "de", eligibleAt: new Date(NOW.getTime() - n * DAY).toISOString(), dueAt: "", expiresAt: "", sentAt: new Date(NOW.getTime() - n * DAY).toISOString(), receipts: [], error: null, checkedAt: null });
    expect(queueFor({ ...base, reach: new Map(), candidates: [{ user: u, lastActive: day(3) }] })).toEqual([]);
    expect(queueFor({ ...base, history: [pushed(1, "msg-at-risk-1")], candidates: [{ user: u, lastActive: day(3) }] })).toEqual([]);
    // Active again since: may get it again.
    expect(queueFor({ ...base, history: [pushed(10, "msg-at-risk-1")], candidates: [{ user: u, lastActive: day(3) }] })).toHaveLength(1);
    // 3 this week → limit.
    expect(queueFor({ ...base, rhythm: "weekly", nudgeRule: false, history: [pushed(2), pushed(3), pushed(4)], candidates: [{ user: u, lastActive: day(30) }] })).toEqual([]);
    // 3 unanswered since last active → mayNudge says no (Duolingo's lesson).
    expect(queueFor({ ...base, settings: { ...DEFAULT_SETTINGS, maxPerWeek: 10 }, history: [pushed(10), pushed(12), pushed(14)], candidates: [{ user: u, lastActive: day(20) }] })).toEqual([]);
    // A push already today (daily rhythm) → no second one.
    expect(queueFor({ ...base, history: [pushed(0.2)], candidates: [{ user: u, lastActive: day(5) }] })).toEqual([]);
  });

  test("announcements go once per user", () => {
    const a = campaign({ id: "msg-news-1", kind: "announcement", audience: undefined });
    const first = queueFor({ ...base, campaign: a, againAfterDays: null, candidates: [{ user: users[0]!, lastActive: day(1) }] });
    expect(first).toHaveLength(1);
    expect(queueFor({ ...base, campaign: a, againAfterDays: null, history: [{ ...first[0]!, status: "sent" }], candidates: [{ user: users[0]!, lastActive: day(0) }] })).toEqual([]);
  });
});

describe("measureCampaign", () => {
  const c = campaign();
  const users = Array.from({ length: 2000 }, (_, i) => user(i + 1));
  const records = users.map(
    (u, i): SendRecord => ({ id: `r${i}`, campaignId: c.id, user: u, channel: "push", arm: arm(u, c.id, 0.1), status: arm(u, c.id, 0.1) === "holdout" ? "held" : "sent", locale: "de", eligibleAt: new Date(NOW.getTime() - 10 * DAY).toISOString(), dueAt: "", expiresAt: "", sentAt: null, receipts: [], error: null, checkedAt: null }),
  );
  const activity = (backTreated: number, backHeld: number) =>
    users.map((u, i) => {
      const held = arm(u, c.id, 0.1) === "holdout";
      const back = frac(i) < (held ? backHeld : backTreated);
      return act(u, back ? [20, 9] : [20]);
    });
  test("better, worse, no difference, against the holdout (weekly rhythm uses the next 7 days)", () => {
    expect(measureCampaign(c, records, activity(0.4, 0.2), "daily", NOW).state).toBe("better");
    expect(measureCampaign(c, records, activity(0.15, 0.3), "daily", NOW).state).toBe("worse");
    expect(measureCampaign(c, records, activity(0.3, 0.3), "daily", NOW).state).toBe("no_difference");
    const r = measureCampaign(c, records, activity(0.4, 0.2), "daily", NOW);
    expect(r.note).toContain("with the message");
  });
  test("too few, or the period isn't over yet", () => {
    expect(measureCampaign(c, records.slice(0, 50), activity(0.4, 0.2), "daily", NOW).state).toBe("collecting");
    expect(measureCampaign(c, records.map((r) => ({ ...r, eligibleAt: NOW.toISOString() })), activity(0.4, 0.2), "weekly", NOW).treated).toBe(0);
  });
});

describe("guardrailFor", () => {
  const c = campaign();
  const users = Array.from({ length: 2000 }, (_, i) => user(i + 1));
  const records = users.map((u, i): SendRecord => {
    const a = arm(u, c.id, 0.1);
    return { id: `r${i}`, campaignId: c.id, user: u, channel: "push", arm: a, status: a === "holdout" ? "held" : "delivered", locale: "de", eligibleAt: new Date(NOW.getTime() - 10 * DAY).toISOString(), dueAt: "", expiresAt: "", sentAt: a === "holdout" ? null : new Date(NOW.getTime() - 10 * DAY).toISOString(), receipts: [], error: null, checkedAt: null };
  });
  const outs = (rateTreated: number, rateHeld: number) =>
    users.flatMap((u, i) => (frac(i) < (arm(u, c.id, 0.1) === "holdout" ? rateHeld : rateTreated) ? [{ user: u, at: new Date(NOW.getTime() - 9 * DAY).toISOString(), reason: "disabled" as const }] : []));
  test("trips when recipients switch push off clearly more", () => {
    expect(guardrailFor(c, records, outs(0.08, 0.01), NOW).tripped).toBe(true);
    expect(guardrailFor(c, records, outs(0.02, 0.02), NOW).tripped).toBe(false);
  });
  test("before the holdout is big enough: 1 in 10 of 50+ recipients", () => {
    const few = records.filter((r) => r.arm === "on").slice(0, 60);
    expect(guardrailFor(c, few, outs(0.2, 0), NOW).tripped).toBe(true);
    expect(guardrailFor(c, few, outs(0.03, 0), NOW).tripped).toBe(false);
  });
});

describe("planning", () => {
  const snap = (leak: RetentionSnapshot["leak"]) => ({ status: "ready", leak, states: { new: 5, current: 10, reactivated: 0, resurrected: 0, at_risk: 4, lapsing: 3, dormant: 0 } }) as unknown as RetentionSnapshot;
  test("missing lifecycle campaigns, biggest leak first; none before anyone is identified", () => {
    expect(missingAudiences([], snap("lapsing"))).toEqual(["lapsing", "onboarding_d1", "onboarding_d3", "at_risk"]);
    expect(missingAudiences([campaign()], snap("new"))).toEqual(["onboarding_d1", "onboarding_d3", "lapsing"]);
    expect(missingAudiences([campaign({ status: "stopped" })], snap(null))).toContain("at_risk");
    expect(missingAudiences([], { status: "no_users" } as RetentionSnapshot)).toEqual([]);
    expect(missingAudiences([], null)).toEqual([]);
  });
  test("trigger events with a recipient", () => {
    const ev = (type: string, to?: string) => ({ type, props: to ? { to } : {} });
    expect(missingTriggers([], [ev("friend_joined", user(1)), ev("friend_joined", user(2)), ev("friend_joined", user(3)), ev("signup"), ev("comment_received")])).toEqual(["friend_joined"]);
    expect(missingTriggers([campaign({ kind: "trigger", trigger: { event: "friend_joined" } })], [ev("friend_joined", user(1)), ev("friend_joined", user(2)), ev("friend_joined", user(3))])).toEqual([]);
  });
});
