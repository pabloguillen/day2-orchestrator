import { describe, expect, test } from "bun:test";
import type { UserActivity } from "../field-store";
import type { EventLike } from "../metrics/types";
import type { MoneyRecord } from "../money/ledger";
import { compareValues, computeNumbers, crashPerDay, periodDays, spendBetween, storeTotals, type NumbersInput } from "./compute";
import { fromUsd } from "../ads/fx";
import { emptyNumbersDoc, type Num, type NumbersDoc, type Series } from "./types";

/**
 * The Numbers page computed from fixed inputs: what's not available says
 * why and how to fix it (never 0), store numbers compare the same days,
 * comparisons carry their samples, and every split adds up.
 */

const NOW = new Date("2026-11-03T10:00:00Z");
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.parse("2026-11-03T00:00:00Z") - offset * DAY).toISOString().slice(0, 10);

function input(over: Partial<NumbersInput> = {}): NumbersInput {
  return {
    now: NOW,
    days: 7,
    kind: "mobile",
    stores: { ios: true, android: true },
    connected: { asc: false, play: false },
    doc: emptyNumbersDoc(),
    events: [],
    users: [],
    fixedDeviceId: false,
    retention: null,
    money: { applies: true, records: [], currency: "EUR", connected: false, users: [] },
    ads: { campaigns: [], names: { meta: "Meta", tiktok: "TikTok" }, credits: (usd) => Math.round(usd * 100), fromUsd },
    quality: { crashes: [], releases: [], checks: [], ratings: [], reviews: [] },
    experiments: [],
    ...over,
  };
}

const all = (v: ReturnType<typeof computeNumbers>) => v.sections.flatMap((s) => s.numbers);
const get = (v: ReturnType<typeof computeNumbers>, key: string): Num => {
  const n = all(v).find((x) => x.key === key);
  if (!n) throw new Error(`no number ${key}`);
  return n;
};
const series = (from: number, to: number, v: number): Series => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [day(from + i), { v }]));

describe("periods and comparisons", () => {
  test("the period ends today; the one before is the same length right before it", () => {
    const p = periodDays(NOW, 7);
    expect(p.cur).toEqual([day(6), day(5), day(4), day(3), day(2), day(1), day(0)]);
    expect(p.prev[0]).toBe(day(13));
    expect(p.prev.at(-1)).toBe(day(7));
  });

  test("too few to compare, same, up and down — percents compare in points", () => {
    expect(compareValues(12, 4, 12, 4, "count", 10)).toMatchObject({ state: "too_few", change: null, n: 12, prevN: 4 });
    expect(compareValues(120, 100, 120, 100, "count", 10)).toMatchObject({ state: "up", change: 0.19999999999999996 });
    expect(compareValues(101, 100, 101, 100, "count", 10).state).toBe("same");
    expect(compareValues(0.42, 0.4, 300, 280, "percent", 30)).toMatchObject({ state: "up", change: expect.closeTo(0.02, 6) });
    expect(compareValues(null, 3, 0, 3, "count", 10).state).toBe("none");
  });

  test("store totals use the days the store reported, and the same days before", () => {
    const s: Series = { ...series(2, 6, 10), ...series(9, 13, 4) };
    const p = periodDays(NOW, 7);
    const t = storeTotals(s, p.cur, p.prev);
    expect(t).toMatchObject({ value: 50, prev: 20, covered: 5, lastDay: day(2) });
    // The period before missing most days: nothing to compare with.
    expect(storeTotals(series(2, 6, 10), p.cur, p.prev).prev).toBeNull();
  });
});

describe("nothing connected yet", () => {
  test("every number says why it's missing and how to fix it — none is a made-up 0", () => {
    const v = computeNumbers(input());
    for (const n of all(v).filter((x) => !x.key.startsWith("experiments"))) {
      expect(n.value).toBeNull();
      expect(n.missing?.reason).toBeTruthy();
    }
    expect(get(v, "installs.ios").missing).toEqual({ reason: "App Store Connect isn't connected.", fix: "Connect App Store Connect on Releases", to: "releases" });
    expect(get(v, "installs.android").missing?.fix).toBe("Connect Google Play on Releases");
    expect(get(v, "firstOpens").missing?.reason).toContain("No field data");
    expect(get(v, "newUsers").missing?.reason).toContain("No field data");
    expect(get(v, "revenue").missing).toMatchObject({ fix: "Set up how the app earns on Money", to: "money" });
    expect(get(v, "ads.spend").missing?.to).toBe("growth/ads");
    expect(get(v, "crashFree").missing?.reason).toContain("No field data");
    expect(v.headline.newUsers.key).toBe("newUsers");
    expect(v.connections.apple).toMatchObject({ applies: true, connected: false });
  });

  test("Play connected but no reports bucket: asks for the Cloud Storage URI", () => {
    const v = computeNumbers(input({ connected: { asc: false, play: true } }));
    expect(get(v, "installs.android").missing?.fix).toContain("Cloud Storage URI");
  });

  test("a web app: no store numbers, money doesn't apply", () => {
    const v = computeNumbers(input({ kind: "web", stores: { ios: false, android: false } }));
    expect(all(v).some((n) => n.key.startsWith("installs."))).toBe(false);
    expect(v.sections[0]!.note).toContain("web");
    expect(get(v, "revenue").missing?.reason).toContain("App Store and Google Play");
  });
});

describe("store installs", () => {
  const doc = (): NumbersDoc => ({
    ...emptyNumbersDoc(),
    settings: { appleVendorNumber: "85912345", playBucket: "pubsite_prod_rev_1" },
    series: {
      "ios.downloads": { ...series(2, 6, 20), ...series(9, 13, 10) },
      "ios.salesUnits": { ...series(1, 6, 999), ...series(8, 13, 999) },
      "android.installs": { ...series(2, 6, 5), ...series(9, 13, 5) },
      "ios.impressions": { ...series(2, 6, 400), ...series(9, 13, 300) },
      "ios.pageViews": { ...series(2, 6, 80), ...series(9, 13, 50) },
    },
    fetchedAt: NOW.toISOString(),
  });

  test("App Analytics first, both stores together, split by platform, late days said", () => {
    const v = computeNumbers(input({ connected: { asc: true, play: true }, doc: doc() }));
    const ios = get(v, "installs.ios");
    expect(ios).toMatchObject({ value: 100, prev: 50, source: "app_store", compare: { state: "up", change: 1, n: 100, prevN: 50 } });
    expect(ios.note).toContain("First-time downloads");
    expect(ios.note).toContain("up to Nov 1");
    expect(get(v, "installs.android")).toMatchObject({ value: 25, prev: 25, compare: { state: "same" } });
    const total = get(v, "installs.total");
    expect(total).toMatchObject({ value: 125, prev: 75 });
    expect(total.byPlatform).toEqual([
      { key: "ios", label: "iOS", value: 100, prev: 50 },
      { key: "android", label: "Android", value: 25, prev: 25 },
    ]);
    expect(get(v, "store.conversion").value).toBeCloseTo(100 / 400);
    expect(v.charts.find((c) => c.key === "installs")!.current).toEqual([25, 25, 25, 25, 25, null, null]);
  });

  test("Sales and Trends when App Analytics hasn't arrived; the reason when neither has", () => {
    const d = doc();
    delete d.series["ios.downloads"];
    const v = computeNumbers(input({ connected: { asc: true, play: true }, doc: d }));
    expect(get(v, "installs.ios")).toMatchObject({ value: 999 * 6, note: expect.stringContaining("Sales and Trends") });
    delete d.series["ios.salesUnits"];
    d.apple.analytics = { at: NOW.toISOString(), ok: false, error: "The App Store Connect key can't start App Analytics reports: that needs a key with the Admin role (Users and Access → Integrations)." };
    const w = computeNumbers(input({ connected: { asc: true, play: true }, doc: d }));
    expect(get(w, "installs.ios").missing?.reason).toContain("Admin role");
    expect(get(w, "installs.total").missing?.reason).toContain("hasn't reported");
  });
});

// ---------------------------------------------------------------------------
// Field data
// ---------------------------------------------------------------------------

const ev = (type: string, offsetDays: number, deviceId: string, o: Partial<EventLike> = {}): EventLike => ({ type, at: new Date(NOW.getTime() - offsetDays * DAY - 3600_000).toISOString(), deviceId, ...o });
const user = (id: string, first: number, activeOffsets: number[]): UserActivity => {
  const days = [...new Set([first, ...activeOffsets])].map(day).sort();
  return { user: id, firstSeen: day(first), lastSeen: days.at(-1)!, days };
};

describe("field data", () => {
  // 12 new iOS devices this week (4 from Meta ads), 3 Android last week.
  const events: EventLike[] = [
    ...Array.from({ length: 12 }, (_, k) => ev("visit", k % 5, `i${k}`, { platform: "ios", userId: `u${k}`, ...(k < 4 ? { acquisition: { campaignId: "B-1.meta.v1", channel: "paid" } } : {}) })),
    ...Array.from({ length: 4 }, (_, k) => ev("signup", k % 5, `i${k}`, { platform: "ios", userId: `u${k}` })),
    ...Array.from({ length: 3 }, (_, k) => ev("visit", 9, `a${k}`, { platform: "android", userId: `w${k}` })),
    ev("dot_added", 1, "i1", { platform: "ios", userId: "u1" }),
    ev("dot_added", 1, "i2", { platform: "ios", userId: "u2" }),
    ev("activated", 1, "i1", { platform: "ios", userId: "u1" }),
  ];
  const users = [...Array.from({ length: 12 }, (_, k) => user(`u${k}`, k % 5, [k % 5, 0])), ...Array.from({ length: 3 }, (_, k) => user(`w${k}`, 9, [9, 8]))];

  test("first opens need a fixed device id; then they split by platform and by ad", () => {
    expect(get(computeNumbers(input({ events, users })), "firstOpens").missing?.to).toBe("privacy");
    const v = computeNumbers(input({ events, users, fixedDeviceId: true }));
    const fo = get(v, "firstOpens");
    expect(fo).toMatchObject({ value: 12, prev: 3, compare: { state: "too_few", n: 12, prevN: 3 } });
    expect(fo.byPlatform).toEqual([
      { key: "ios", label: "iOS", value: 12, prev: 0 },
      { key: "android", label: "Android", value: 0, prev: 3 },
    ]);
    expect(fo.bySource).toEqual([
      { key: "meta", label: "Meta ads", value: 4, prev: 0 },
      { key: "other", label: "Everyone else", value: 8, prev: 3 },
    ]);
  });

  test("new and active users from identified users; stickiness; the app not identifying users is said", () => {
    const v = computeNumbers(input({ events, users }));
    expect(get(v, "newUsers")).toMatchObject({ value: 12, prev: 3, source: "field" });
    expect(get(v, "newUsers").bySource![0]).toMatchObject({ key: "meta", value: 4 });
    expect(get(v, "wau")).toMatchObject({ value: 12, prev: 3 });
    expect(get(v, "mau").value).toBe(15);
    expect(get(v, "mau").byPlatform).toEqual([
      { key: "ios", label: "iOS", value: 12, prev: 0 },
      { key: "android", label: "Android", value: 3, prev: 3 },
    ]);
    expect(get(v, "stickiness").value).toBeCloseTo(get(v, "dau").value! / 15, 2);
    expect(v.headline.newUsers.key).toBe("newUsers");
    expect(v.headline.activeUsers.key).toBe("mau");
    const none = computeNumbers(input({ events: events.map(({ userId: _u, ...e }) => e) }));
    expect(get(none, "dau").missing?.reason).toContain("doesn't tell day2 who its users are");
  });

  test("activation from the activated event; core actions per active user", () => {
    const v = computeNumbers(input({ events, users }));
    expect(get(v, "activation")).toMatchObject({ value: 1 / 12, compare: { n: 12 } });
    const a = get(v, "action.dot_added");
    expect(a.value).toBeCloseTo(2 / 12, 2);
    expect(a.note).toContain("2 people did it");
    expect(get(v, "sessionsPerUser").value).toBe(1);
    const noActivated = computeNumbers(input({ events: events.filter((e) => e.type !== "activated"), users }));
    expect(get(noActivated, "activation").missing?.reason).toContain("activated");
  });

  test("day 1 retention: people whose day 1 falls in the period, and who came back that day", () => {
    const cohort = [user("r1", 5, [4]), user("r2", 5, [4]), user("r3", 4, []), user("r4", 12, [11])];
    const v = computeNumbers(input({ users: cohort, events: [ev("visit", 0, "x", { userId: "r1" })] }));
    const d1 = get(v, "d1");
    expect(d1).toMatchObject({ value: 2 / 3, prev: 1, compare: { state: "too_few", n: 3, prevN: 1 } });
    expect(get(v, "d30").value).toBeNull();
  });

  test("ads: spend this period from the daily snapshots, people and sign-ups from the ad links, cost per sign-up", () => {
    const doc: NumbersDoc = { ...emptyNumbersDoc(), adSpend: { [day(7)]: { "B-1:meta": 60 } } };
    const v = computeNumbers(input({ events, users, doc, ads: { ...input().ads, campaigns: [{ betId: "B-1", platform: "meta", billing: "credits", currency: "USD", spendUsd: 100, launchedAt: "2026-10-01T00:00:00Z" }] } }));
    const row = v.adPlatforms[0]!;
    expect(row.name).toBe("Meta");
    expect(row.spend).toMatchObject({ unit: "credits", value: 4000 });
    expect(row.people.value).toBe(4);
    expect(row.results).toMatchObject({ label: "Sign-ups", value: 4 });
    expect(row.costPerResult.value).toBe(1000);
    expect(get(v, "ads.spend")).toMatchObject({ value: 4000, prev: expect.any(Number) });
    expect(get(v, "ads.cost").value).toBe(1000);
  });

  test("crash-free: launches without a crash per day, older days from the kept daily counts", () => {
    const visits = [...Array.from({ length: 40 }, (_, k) => ev("visit", 1, `d${k}`, { platform: "ios" })), ...Array.from({ length: 10 }, (_, k) => ev("visit", 2, `e${k}`, { platform: "android" }))];
    const crashes = [{ deviceId: "d1", at: ev("x", 1, "d1").at }, { deviceId: "e1", at: ev("x", 2, "e1").at }];
    const doc: NumbersDoc = { ...emptyNumbersDoc(), field: { [day(9)]: { launches: 100, crashed: 10 } } };
    const v = computeNumbers(input({ events: visits, doc, quality: { ...input().quality, crashes } }));
    const c = get(v, "crashFree");
    expect(c.label).toBe("Crash-free sessions");
    expect(c.value).toBeCloseTo(1 - 2 / 50);
    expect(c.prev).toBeCloseTo(0.9);
    expect(c.compare).toMatchObject({ state: "up", n: 50, prevN: 100 });
    expect(c.byPlatform).toEqual([
      { key: "ios", label: "iOS", value: 1 - 1 / 40, prev: null },
      { key: "android", label: "Android", value: 0.9, prev: null },
    ]);
    expect(crashPerDay(visits, crashes)[day(1)]).toEqual({ launches: 40, crashed: 1 });
  });
});

describe("money, quality and experiments", () => {
  const rec = (o: Partial<MoneyRecord>): MoneyRecord => ({ id: Math.random().toString(36), store: "apple", type: "purchase_verified", kind: "subscription", productId: "pro", at: ev("x", 1, "x").at, amount: 5, currency: "EUR", user: "u1", variants: {}, source: null, chain: null, sandbox: false, expiresAt: null, ...o });

  test("revenue by platform and by kind, refunds, paying users — test purchases never count", () => {
    const records = [rec({}), rec({ store: "google", user: "u2", kind: "purchase", amount: 3 }), rec({ sandbox: true, amount: 100 }), rec({ type: "refund", amount: 5, at: ev("x", 2, "x").at }), rec({ at: ev("x", 9, "x").at, amount: 4 })];
    const v = computeNumbers(input({ money: { applies: true, records, currency: "EUR", connected: true, users: [{ user: "u1", variants: {}, source: null }, { user: "u2", variants: {}, source: null }] } }));
    const r = get(v, "revenue");
    expect(r).toMatchObject({ value: 8, prev: 4, unit: "money", currency: "EUR", source: "payments", compare: { state: "too_few" } });
    expect(r.byPlatform).toEqual([
      { key: "ios", label: "iOS", value: 5, prev: 4 },
      { key: "android", label: "Android", value: 3, prev: 0 },
    ]);
    expect(get(v, "revenue.purchases").value).toBe(3);
    expect(get(v, "refunds")).toMatchObject({ value: 5, better: "down" });
    expect(get(v, "payers").value).toBe(2);
    expect(v.charts.find((c) => c.key === "revenue")!.current.at(-2)).toBe(8);
  });

  test("ratings compare with the last reading before the period; reviews count by period; Play vitals averaged by users", () => {
    const doc: NumbersDoc = { ...emptyNumbersDoc(), series: { "android.crashRate": { [day(1)]: { v: 0.01 }, [day(2)]: { v: 0.02 } }, "android.vitalsUsers": { [day(1)]: { v: 300 }, [day(2)]: { v: 100 } } } };
    const v = computeNumbers(
      input({
        connected: { asc: true, play: true },
        doc,
        events: [ev("visit", 1, "d1")],
        quality: {
          crashes: [],
          releases: [{ release: "1.0.0(3)*", label: "iOS store build 1.0.0(3)", devices: 12, crashed: 1 }],
          checks: [{ contract: "action:save", label: "Saving a drawing doesn't finish", failures: 4, devices: 3 }],
          ratings: [
            { at: ev("x", 20, "x").at, store: "ios", average: 4.2, count: 10 },
            { at: ev("x", 1, "x").at, store: "ios", average: 4.5, count: 14 },
          ],
          reviews: [
            { store: "ios", rating: 5, createdAt: ev("x", 1, "x").at },
            { store: "ios", rating: 3, createdAt: ev("x", 2, "x").at },
          ],
        },
      }),
    );
    expect(get(v, "rating.ios")).toMatchObject({ value: 4.5, prev: 4.2, compare: { n: 14, prevN: 10 } });
    expect(get(v, "rating.android").missing?.to).toBe("store");
    expect(get(v, "reviews")).toMatchObject({ value: 2, prev: 0, note: "Average 4 stars." });
    expect(get(v, "android.crashRate").value).toBeCloseTo((0.01 * 300 + 0.02 * 100) / 400);
    expect(get(v, "checks").value).toBe(1);
    expect(v.releases[0]).toMatchObject({ crashFree: 11 / 12, tooFew: true });
  });

  test("experiments running and decided in the period", () => {
    const v = computeNumbers(
      input({
        experiments: [
          { id: "X-1", title: "Shorter welcome", state: "running", metric: "Sign-ups", startedAt: ev("x", 3, "x").at, arms: [{ name: "control", n: 40 }], decision: null },
          { id: "X-2", title: "Bigger button", state: "promoted", metric: "Sign-ups", startedAt: null, arms: [], decision: { verdict: "better", winner: "big", at: ev("x", 2, "x").at, by: "day2", note: "" } },
          { id: "X-3", title: "Old one", state: "stopped", metric: "Sign-ups", startedAt: null, arms: [], decision: { verdict: "worse", winner: null, at: ev("x", 40, "x").at, by: "owner", note: "" } },
        ],
      }),
    );
    expect(v.experiments.running.map((e) => e.id)).toEqual(["X-1"]);
    expect(v.experiments.decided.map((e) => e.id)).toEqual(["X-2"]);
    expect(get(v, "experiments.decided")).toMatchObject({ value: 1, prev: 0 });
  });
});

describe("ad spend between two times", () => {
  const c = { betId: "B-1", platform: "meta", billing: "credits" as const, currency: "USD", spendUsd: 100, launchedAt: "2026-10-24T00:00:00Z" };
  test("from snapshots when they reach back", () => {
    expect(spendBetween(c, { "2026-10-26": { "B-1:meta": 30 } }, Date.parse("2026-10-27T00:00:00Z"), NOW.getTime(), NOW.getTime())).toEqual({ usd: 70, estimated: false });
  });
  test("estimated (even spending since launch) where they don't", () => {
    const r = spendBetween(c, {}, Date.parse("2026-10-29T00:00:00Z"), NOW.getTime(), NOW.getTime());
    expect(r.estimated).toBe(true);
    expect(r.usd).toBeGreaterThan(40);
    expect(r.usd).toBeLessThan(60);
    // Launched inside the period: all of it, nothing estimated.
    expect(spendBetween(c, {}, Date.parse("2026-10-20T00:00:00Z"), NOW.getTime(), NOW.getTime())).toEqual({ usd: 100, estimated: false });
  });
});
