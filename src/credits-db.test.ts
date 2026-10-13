import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestDatabase } from "./db/test-db";
import { buyTopUp, getSummary, MARKUP, readCredits, recordCharge, setPlan, type CreditStore } from "./credits";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let a: CreditStore;
let b: CreditStore;

async function account(sql: SQL, name: string): Promise<string> {
  const [row] = (await sql`INSERT INTO accounts (name) VALUES (${name}) RETURNING id`) as Array<{ id: string }>;
  return row!.id;
}

beforeAll(async () => {
  t = await createTestDatabase();
  a = { db: t.sql, accountId: await account(t.sql, "A") };
  b = { db: t.sql, accountId: await account(t.sql, "B") };
});
afterAll(async () => t.drop());

describe("credits in Postgres", () => {
  test("a new account is a trial; plan changes and top-ups persist", async () => {
    expect((await getSummary(a)).plan.id).toBe("trial");
    await setPlan(a, "growth", "monthly");
    await buyTopUp(a, "1k");
    const s = await getSummary(a);
    expect(s.plan.id).toBe("growth");
    expect(s.balance.topUp).toBe(1000);
    const rows = (await t.sql`SELECT kind, count(*)::int AS n FROM credit_events WHERE account_id = ${(a as { accountId: string }).accountId} GROUP BY kind ORDER BY kind`) as Array<{ kind: string; n: number }>;
    expect(rows).toEqual([{ kind: "grant", n: 3 }]);
  });

  test("accounts are isolated", async () => {
    expect((await getSummary(b)).plan.id).toBe("trial");
    expect((await getSummary(b)).balance.topUp).toBe(0);
  });

  test("50 concurrent charges: each recorded once, the balance never goes below zero", async () => {
    process.env.DAY2_USD_TO_EUR = "1";
    const before = (await getSummary(b)).balance.total; // 1,000 trial credits
    const costUsd = 0.1; // 30 credits each at 3× → 50 × 30 = 1,500 > 1,000
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => recordCharge(b, { id: `c${i}`, appId: null, service: "agent_work", costUsd, description: "Fix" })),
    );
    // Replays of the same ids are no-ops.
    await Promise.all(Array.from({ length: 10 }, (_, i) => recordCharge(b, { id: `c${i}`, appId: null, service: "agent_work", costUsd, description: "Fix" })));
    delete process.env.DAY2_USD_TO_EUR;
    const s = await getSummary(b);
    const charged = results.reduce((sum, r) => sum + (r?.credits ?? 0), 0);
    expect(charged).toBe(before);
    expect(s.balance.total).toBe(0);
    expect(s.balance.usedThisMonth).toBe(before);
    expect(results.filter((r) => r && r.uncollectedCredits > 0).length).toBeGreaterThan(0);
    const { events } = await readCredits(b);
    expect(events.filter((e) => e.kind === "charge")).toHaveLength(50);
    expect(Math.ceil((costUsd * MARKUP.agent_work) / 0.01 - 1e-9)).toBe(30);
  });
});
