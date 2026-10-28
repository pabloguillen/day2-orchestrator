import { describe, expect, test } from "bun:test";
import type { Backlog } from "../backlog";
import type { UserActivity } from "../field-store";
import { AD_PROMISE_ID, adPromiseIdea, adPromiseTicket, computeSnapshot, measureTreatment, nextTreatment, type RetentionFile, type RetentionSnapshot, type Treatment } from "../retention";
import { scaleGate, stayAfterDays } from "./retention-link";

/** Ads and the retention engine as one loop. */

const NOW = new Date("2026-10-28T12:00:00Z");
const DAY = 86_400_000;
const day = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString().slice(0, 10);
const emptyBacklog = { tickets: [] } as unknown as Backlog;

const snap = (over: Partial<RetentionSnapshot> = {}): RetentionSnapshot => ({
  at: NOW.toISOString(),
  status: "ready",
  rhythm: "weekly",
  rhythmFrom: "usage",
  users: 500,
  states: { new: 100, current: 200, reactivated: 10, resurrected: 5, at_risk: 50, lapsing: 60, dormant: 75 },
  rates: { new: 0.3, current: 0.8, back: 0.4, at_risk: 0.3, lapsing: 0.1 },
  base: { new: 100, current: 200, back: 15, at_risk: 50, lapsing: 60 },
  lost: { new: 70, current: 40, back: 9, at_risk: 35, lapsing: 54 },
  trend: [],
  leak: "new",
  ...over,
});

describe("ads don't buy users the product can't keep yet", () => {
  test("scale-ups hold while almost no new user comes back; running ads are untouched", () => {
    expect(scaleGate(snap())).toEqual({ hold: false });
    const g = scaleGate(snap({ rates: { ...snap().rates, new: 0.06 } }));
    expect(g.hold).toBe(true);
    expect(g.hold && g.why).toContain("only 6% of new users come back the next week");
    // Too few new users, or not ready: no hold.
    expect(scaleGate(snap({ rates: { ...snap().rates, new: 0.06 }, base: { ...snap().base, new: 12 } }))).toEqual({ hold: false });
    expect(scaleGate(null)).toEqual({ hold: false });
  });
  test("staying is measured on the app's own rhythm", () => {
    expect(stayAfterDays(snap({ rhythm: "monthly" }))).toBe(30);
    expect(stayAfterDays(null)).toBe(7);
  });
});

describe("the retention engine knows who came from ads", () => {
  // Weekly app. New users last week: 40 from ads (8 came back), 40 others (20 came back).
  const users: UserActivity[] = [];
  for (let i = 0; i < 80; i++) {
    const back = i < 40 ? i < 8 : i < 60;
    users.push({ user: `u${i}`, firstSeen: day(10), lastSeen: back ? day(3) : day(10), days: back ? [day(10), day(3)] : [day(10)] });
  }
  for (let i = 0; i < 30; i++) users.push({ user: `c${i}`, firstSeen: day(60), lastSeen: day(2), days: [day(60), day(40), day(20), day(12), day(9), day(2)] });
  const sourceOf = (u: string) => (u.startsWith("u") && Number(u.slice(1)) < 40 ? "ads" : "other") as "ads" | "other";

  test("new users split by source in the snapshot", () => {
    const s = computeSnapshot({ users, older: 0, productType: "routine", now: NOW, sourceOf });
    expect(s.newBySource).toMatchObject({ ads: { n: 40, kept: 8, rate: 0.2 }, other: { n: 40, kept: 20, rate: 0.5 } });
    expect(computeSnapshot({ users, older: 0, productType: "routine", now: NOW }).newBySource).toBeNull();
  });

  test("ad users staying clearly less → one treatment for them: continue the ad's promise", () => {
    const s = computeSnapshot({ users, older: 0, productType: "routine", now: NOW, sourceOf });
    const file: RetentionFile = { research: [], treatments: [] };
    const exps = [{ id: "B-4", angle: "Split a dinner bill fast", landingPath: "/go/split" }];
    const idea = adPromiseIdea(file, s, emptyBacklog, exps)!;
    expect(idea).toMatchObject({ id: AD_PROMISE_ID, target: "new", segment: "ads", channel: "in_app" });
    expect(idea.change).toContain('"B-4" promised "Split a dinner bill fast" (landing /go/split)');
    const t = adPromiseTicket(idea, s);
    expect(t.description).toContain("come back 20% of the time the next week; other new users 50%");
    expect(t.description).toContain(`day2.treatment("${AD_PROMISE_ID}")`);
    // Not when ad users stay about as well, nor twice.
    expect(adPromiseIdea(file, { ...s, newBySource: { ads: { n: 40, kept: 18, rate: 0.45 }, other: s.newBySource!.other } }, emptyBacklog, exps)).toBeNull();
    expect(adPromiseIdea({ ...file, treatments: [{ id: AD_PROMISE_ID } as Treatment] }, s, emptyBacklog, exps)).toBeNull();
  });

  test("a treatment for ad users is measured on ad users only", () => {
    const t = { id: AD_PROMISE_ID, target: "new", segment: "ads", rhythm: "weekly", holdout: 0.1, shippedAt: new Date(NOW.getTime() - 30 * DAY).toISOString() } as Treatment;
    const r = measureTreatment(t, users, NOW, sourceOf);
    const all = measureTreatment({ ...t, segment: undefined }, users, NOW, sourceOf);
    expect(r.state).toBe("collecting");
    expect(r.note).not.toBe(all.note);
  });

  test("while ads buy new users, their leak weighs more when choosing what to fix", () => {
    const research = { id: "r", at: NOW.toISOString(), category: "x", productType: "routine" as const, leaders: [], credits: 0, ideas: [
      { id: "new-a", target: "new" as const, channel: "in_app" as const, name: "A", practice: "p", change: "c", leaders: [] },
      { id: "lapsing-b", target: "lapsing" as const, channel: "email" as const, name: "B", practice: "p", change: "c", leaders: [] },
    ] };
    const s = snap({ lost: { new: 50, current: 10, back: 5, at_risk: 10, lapsing: 60 } });
    expect(nextTreatment({ research: [research], treatments: [] }, s, emptyBacklog)!.target).toBe("lapsing");
    expect(nextTreatment({ research: [research], treatments: [] }, s, emptyBacklog, { paidNew: true })!.target).toBe("new");
  });
});
