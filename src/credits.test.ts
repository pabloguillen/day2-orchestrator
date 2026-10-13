import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeLots,
  allocate,
  buildCharge,
  buyTopUp,
  changePlan,
  checkCredits,
  dueGrants,
  getSummary,
  grantManual,
  lotsOf,
  MARKUP,
  newAccount,
  PLANS,
  recordCharge,
  setPlan,
  summarize,
  toPublicCharge,
  topUpGrant,
  TOPUP_PACKS,
  updateAccount,
  type CreditAccount,
  type CreditEvent,
  type CreditService,
} from "./credits";

const FX = 1; // keep arithmetic readable: $1 == €1 in these tests
const d = (s: string) => new Date(s);

function paid(plan: "starter" | "growth" | "scale", now: Date, cycle: "monthly" | "yearly" = "monthly") {
  const acc0 = newAccount(now);
  const first = dueGrants(acc0, [], now);
  const events: CreditEvent[] = [...first.grants];
  const changed = changePlan(first.account, events, plan, cycle, now);
  return { account: changed.account, events: [...events, ...changed.grants] };
}

describe("grants", () => {
  test("a new account is a 14-day trial with 1,000 credits", () => {
    const now = d("2026-10-10T12:00:00Z");
    const { grants } = dueGrants(newAccount(now), [], now);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: "trial", credits: 1000, eurCents: 0, expiresAt: "2026-10-24T12:00:00.000Z" });
  });

  test("a paid plan grants its allowance each month, idempotently", () => {
    const now = d("2026-10-10T00:00:00Z");
    const { account, events } = paid("growth", now);
    expect(events.filter((e) => e.kind === "grant" && e.id === "plan:2026-10")).toHaveLength(1);
    expect(dueGrants(account, events, now).grants).toHaveLength(0);
    const nov = dueGrants(account, events, d("2026-11-02T00:00:00Z")).grants;
    expect(nov.map((g) => g.id)).toEqual(["plan:2026-11"]);
    expect(nov[0]).toMatchObject({ credits: 8500, eurCents: 7900, expiresAt: "2027-01-01T00:00:00.000Z" });
  });

  test("unused monthly credits roll over exactly one month", () => {
    const { account, events } = paid("starter", d("2026-10-01T00:00:00Z"));
    const nov = d("2026-11-15T00:00:00Z");
    const all = [...events, ...dueGrants(account, events, nov).grants];
    expect(activeLots(all, nov).filter((l) => l.source === "plan").map((l) => l.id)).toEqual(["plan:2026-10", "plan:2026-11"]);
    const dec = d("2026-12-01T00:00:00Z");
    const all2 = [...all, ...dueGrants(account, all, dec).grants];
    expect(activeLots(all2, dec).filter((l) => l.source === "plan").map((l) => l.id)).toEqual(["plan:2026-11", "plan:2026-12"]);
  });

  test("yearly billing prices the monthly lot 20% lower", () => {
    const { events } = paid("scale", d("2026-10-01T00:00:00Z"), "yearly");
    const lot = lotsOf(events).find((l) => l.id === "plan:2026-10")!;
    expect(lot.eurCents).toBe(Math.round(19900 * 0.8));
  });
});

describe("plan changes", () => {
  test("an upgrade adds the difference now; a downgrade waits for next month", () => {
    const now = d("2026-10-10T00:00:00Z");
    const { account, events } = paid("starter", d("2026-10-01T00:00:00Z"));
    const up = changePlan(account, events, "scale", "monthly", now);
    expect(up.effective).toBe("now");
    expect(up.grants).toHaveLength(1);
    expect(up.grants[0]).toMatchObject({ credits: 22000 - 3000, eurCents: 19900 - 2900 });

    const after = [...events, ...up.grants];
    const down = changePlan(up.account, after, "growth", "monthly", now);
    expect(down.effective).toBe("next_month");
    expect(down.account.plan).toBe("scale");
    const nov = dueGrants(down.account, after, d("2026-11-01T00:00:00Z"));
    expect(nov.account.plan).toBe("growth");
    expect(nov.grants[0]).toMatchObject({ id: "plan:2026-11", credits: 8500 });
  });
});

describe("allocation", () => {
  test("normal services: real cost × markup at €0.01 a credit, monthly credits before top-ups", () => {
    const now = d("2026-10-05T00:00:00Z");
    const { events } = paid("starter", now);
    const withTopUp = [...events, topUpGrant(TOPUP_PACKS[0]!, now, "topup:a")];
    const a = allocate("agent_work", 2, activeLots(withTopUp, now), FX);
    expect(a.credits).toBe(Math.ceil((2 * MARKUP.agent_work) / 0.01));
    expect(a.draws[0]!.lotId).not.toBe("topup:a");
  });

  test("paid ads use what the credits cost, so discounted credits are never sold below cost", () => {
    const now = d("2026-10-05T00:00:00Z");
    const { events } = paid("scale", now, "yearly");
    const lots = activeLots(events, now).filter((l) => l.source === "plan");
    const a = allocate("paid_ads", 100, lots, FX);
    const paidEur = a.draws.reduce((s, dr) => s + dr.credits * lots.find((l) => l.id === dr.lotId)!.eurPerCredit, 0);
    expect(a.covered).toBe(true);
    expect(paidEur).toBeGreaterThanOrEqual(100 * MARKUP.paid_ads - 1e-6);
  });

  test("paid ads can't be paid with free (trial or manual) credits", () => {
    const now = d("2026-10-05T00:00:00Z");
    const { grants } = dueGrants(newAccount(now), [], now);
    const a = allocate("paid_ads", 1, activeLots(grants, now), FX);
    expect(a.covered).toBe(false);
    expect(a.credits).toBe(0);
  });
});

describe("checkCredits", () => {
  const now = d("2026-10-05T00:00:00Z");

  test("trial can't run ads or build apps", () => {
    const { account, grants } = dueGrants(newAccount(now), [], now);
    expect(checkCredits({ account, events: grants, now, appId: null, service: "paid_ads", maxCostUsd: 1, fx: FX })).toMatchObject({ ok: false, code: "plan" });
    expect(checkCredits({ account, events: grants, now, appId: null, service: "app_build", maxCostUsd: 1, fx: FX })).toMatchObject({ ok: false, code: "plan" });
    expect(checkCredits({ account, events: grants, now, appId: null, service: "agent_work", maxCostUsd: 1, fx: FX }).ok).toBe(true);
  });

  test("refuses when the worst case doesn't fit the balance", () => {
    const { account, grants } = dueGrants(newAccount(now), [], now);
    const r = checkCredits({ account, events: grants, now, appId: null, service: "agent_work", maxCostUsd: 10, fx: FX });
    expect(r).toMatchObject({ ok: false, code: "balance" });
  });

  test("kill switch and per-app monthly/daily caps", () => {
    const base = paid("growth", now);
    const account: CreditAccount = { ...base.account, appCaps: { a: { monthlyCredits: 500, dailyCredits: 400 } } };
    const charge = buildCharge({ events: base.events, now, id: "c1", appId: "a", service: "agent_work", costUsd: 1, description: "x", fx: FX })!;
    const events = [...base.events, charge]; // 300 credits used
    expect(checkCredits({ account, events, now, appId: "a", service: "agent_work", maxCostUsd: 0.1, killSwitch: true, fx: FX })).toMatchObject({ code: "kill_switch" });
    expect(checkCredits({ account, events, now, appId: "a", service: "agent_work", maxCostUsd: 0.7, fx: FX })).toMatchObject({ code: "app_cap" });
    expect(checkCredits({ account, events, now, appId: "a", service: "agent_work", maxCostUsd: 0.5, fx: FX })).toMatchObject({ code: "daily_cap" });
    expect(checkCredits({ account, events, now, appId: "a", service: "agent_work", maxCostUsd: 0.1, fx: FX }).ok).toBe(true);
    expect(checkCredits({ account, events, now, appId: "b", service: "agent_work", maxCostUsd: 0.5, fx: FX }).ok).toBe(true);
  });
});

describe("charges", () => {
  const now = d("2026-10-05T00:00:00Z");

  test("idempotent by id and capped at what was authorized", () => {
    const { events } = paid("starter", now);
    const c = buildCharge({ events, now, id: "x", appId: null, service: "agent_work", costUsd: 5, description: "Fix", maxCredits: 1000, fx: FX })!;
    expect(c.credits).toBe(1000);
    expect(c.uncollectedCredits).toBe(500);
    expect(buildCharge({ events: [...events, c], now, id: "x", appId: null, service: "agent_work", costUsd: 5, description: "Fix", fx: FX })).toBeNull();
  });

  test("the public shape never carries cost or markup", () => {
    const { events } = paid("starter", now);
    const c = buildCharge({ events, now, id: "x", appId: "a", service: "content_generation", costUsd: 0.37, description: "Creative", fx: FX })!;
    const pub = toPublicCharge(c) as Record<string, unknown>;
    expect(Object.keys(pub)).not.toContain("costUsd");
    expect(JSON.stringify(pub)).not.toContain("0.37");
    expect(pub.credits).toBe(-c.credits);
  });

  test("property: across random sequences, no lot ever goes below zero and no charge exceeds its authorization", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const services: CreditService[] = ["agent_work", "scan_answer", "content_generation", "paid_ads", "app_build", "infra"];
    for (let run = 0; run < 300; run++) {
      const start = d("2026-09-01T00:00:00Z");
      const plan = (["starter", "growth", "scale"] as const)[Math.floor(rnd() * 3)]!;
      let { account, events } = paid(plan, start, rnd() < 0.5 ? "monthly" : "yearly");
      account = { ...account, appCaps: { a: { monthlyCredits: Math.floor(rnd() * 20000) } } };
      let now = start;
      for (let step = 0; step < 60; step++) {
        now = new Date(now.getTime() + Math.floor(rnd() * 3 * 86_400_000));
        const due = dueGrants(account, events, now);
        account = due.account;
        events = [...events, ...due.grants];
        if (rnd() < 0.08) events = [...events, topUpGrant(TOPUP_PACKS[Math.floor(rnd() * 2)]!, now, `t${run}-${step}`)];
        const service = services[Math.floor(rnd() * services.length)]!;
        const maxCostUsd = rnd() * 40;
        const appId = rnd() < 0.7 ? "a" : null;
        const check = checkCredits({ account, events, now, appId, service, maxCostUsd, fx: FX });
        if (!check.ok) continue;
        const actual = rnd() < 0.1 ? maxCostUsd * 1.5 : maxCostUsd * rnd();
        const charge = buildCharge({ events, now, id: `c${run}-${step}`, appId, service, costUsd: actual, description: "x", maxCredits: check.maxCredits, fx: FX });
        expect(charge).not.toBeNull();
        expect(charge!.credits).toBeLessThanOrEqual(check.maxCredits);
        expect(charge!.draws.reduce((s, x) => s + x.credits, 0)).toBe(charge!.credits);
        events = [...events, charge!];
        const grants = new Map(events.filter((e) => e.kind === "grant").map((e) => [e.id, e.credits]));
        const drawn = new Map<string, number>();
        for (const e of events) if (e.kind === "charge") for (const x of e.draws) drawn.set(x.lotId, (drawn.get(x.lotId) ?? 0) + x.credits);
        for (const [lot, n] of drawn) expect(n).toBeLessThanOrEqual(grants.get(lot)!);
        if (appId && account.appCaps.a?.monthlyCredits !== undefined) {
          expect(summarize(account, events, now).appCaps.a!.usedThisMonth).toBeLessThanOrEqual(account.appCaps.a.monthlyCredits);
        }
      }
    }
  });
});

describe("summary", () => {
  test("splits monthly and top-up credits and groups usage", () => {
    const now = d("2026-10-05T00:00:00Z");
    const { account, events } = paid("scale", now);
    const all = [...events, topUpGrant(TOPUP_PACKS[0]!, now, "t")];
    const c = buildCharge({ events: all, now, id: "c", appId: "a", service: "agent_work", costUsd: 1, description: "Fix", fx: FX })!;
    const s = summarize(account, [...all, c], now);
    expect(s.plan.id).toBe("scale");
    expect(s.balance.allowance).toBe(22000);
    expect(s.balance.topUp).toBe(1000);
    expect(s.balance.usedThisMonth).toBe(300);
    expect(s.balance.total).toBe(1000 + 1000 + 22000 - 300); // trial lot still active + top-up + plan - used
    expect(s.byService[0]).toMatchObject({ service: "agent_work", credits: 300, count: 1 });
    expect(s.period.renewsAt).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("store (files)", () => {
  const dir = mkdtempSync(join(tmpdir(), "day2-credits-"));
  const store = { dir };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("trial on first read, plan change, top-up, charges, caps, manual grant", async () => {
    const now = d("2026-10-10T00:00:00Z");
    expect((await getSummary(store, now)).plan.id).toBe("trial");
    await expect(buyTopUp(store, "1k", now)).rejects.toThrow(/paid plan/);
    const changed = await setPlan(store, "growth", "monthly", now);
    expect(changed.effective).toBe("now");
    await buyTopUp(store, "1k", now);
    const charge = await recordCharge(store, { id: "r1", appId: "a", service: "scan_answer", costUsd: 0.5, description: "App scan" }, now);
    expect(charge!.credits).toBeGreaterThan(0);
    expect(await recordCharge(store, { id: "r1", appId: "a", service: "scan_answer", costUsd: 0.5, description: "App scan" }, now)).toBeNull();
    const s = await updateAccount(store, (a) => ({ ...a, appCaps: { a: { monthlyCredits: 6000 } } }), now);
    expect(s.appCaps.a).toMatchObject({ monthlyCredits: 6000, usedThisMonth: charge!.credits });
    await grantManual(store, 500, "Goodwill", now);
    const final = await getSummary(store, now);
    expect(final.plan.id).toBe("growth");
    expect(final.recent.some((r) => r.description === "Goodwill" && r.credits === 500)).toBe(true);
    expect(PLANS.growth.monthlyCredits).toBe(8500);
  });

  test("auto top-up kicks in when the balance runs low", async () => {
    const now = d("2026-10-11T00:00:00Z");
    await updateAccount(store, (a) => ({ ...a, autoTopUp: { enabled: true, packId: "1k" } }), now);
    const before = (await getSummary(store, now)).balance;
    const spendUsd = ((before.total - 50) * 0.01) / (0.95 * MARKUP.agent_work);
    process.env.DAY2_USD_TO_EUR = "0.95";
    await recordCharge(store, { id: "big", appId: null, service: "agent_work", costUsd: spendUsd, description: "Fix" }, now);
    delete process.env.DAY2_USD_TO_EUR;
    const after = await getSummary(store, now);
    expect(after.recent.filter((r) => r.source === "topup").length).toBe(2);
    expect(after.balance.total).toBeGreaterThan(900);
  });
});
