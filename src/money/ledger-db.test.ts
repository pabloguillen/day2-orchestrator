import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase } from "../db/test-db";
import { dbMoneyCredentials } from "./credentials";
import { dbMoneyLedger, type MoneyRecord } from "./ledger";

/** The Postgres versions of the ledger, the queue and Money's keys (migration 015_money.sql). */

const hasDb = Boolean(process.env.DAY2_TEST_DATABASE_URL);
let t: Awaited<ReturnType<typeof createTestDatabase>>;
const prevKey = process.env.DAY2_SECRETS_KEY;

beforeAll(async () => {
  if (!hasDb) return;
  process.env.DAY2_SECRETS_KEY = Buffer.alloc(32, 3).toString("base64");
  t = await createTestDatabase();
  const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('Pablo') RETURNING id`) as Array<{ id: string }>;
  await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('app_m', ${acc!.id}, 'Dotty', '/tmp/x', 'github')`;
});

afterAll(async () => {
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = prevKey;
  if (hasDb) await t.drop();
});

const rec = (o: Partial<MoneyRecord> = {}): MoneyRecord => ({
  id: "apple:1:purchase_verified",
  store: "apple",
  type: "purchase_verified",
  kind: "subscription",
  productId: "de.dotty.app.pro_monthly.v1",
  at: "2026-11-01T10:00:00.000Z",
  amount: 4.99,
  currency: "EUR",
  user: "u_1",
  variants: { "X-1": "cards" },
  source: "meta",
  chain: "1",
  sandbox: false,
  expiresAt: "2026-12-01T10:00:00.000Z",
  ...o,
});

describe.skipIf(!hasDb)("money in Postgres", () => {
  test("records upsert by id and read back exactly", async () => {
    const l = dbMoneyLedger(t.sql);
    expect(await l.record("app_m", [rec(), rec({ id: "apple:2:refund", type: "refund", user: null, variants: {}, expiresAt: null })])).toBe(2);
    expect(await l.record("app_m", [rec({ amount: 0 })])).toBe(0);
    const rs = await l.records("app_m", new Date("2026-10-01"));
    expect(rs).toHaveLength(2);
    expect(rs.find((r) => r.id === "apple:1:purchase_verified")).toEqual(rec({ amount: 0 }));
    expect(await l.records("app_m", new Date("2026-11-02"))).toHaveLength(0);
  });

  test("the queue: once per id, due items, retries, payload dropped when done", async () => {
    const l = dbMoneyLedger(t.sql);
    const now = new Date("2026-11-01T10:00:00Z");
    expect(await l.enqueue("app_m", { id: "apple:n1", store: "apple", receivedAt: now.toISOString(), payload: { signedPayload: "x" } })).toBe(true);
    expect(await l.enqueue("app_m", { id: "apple:n1", store: "apple", receivedAt: now.toISOString(), payload: null })).toBe(false);
    expect((await l.due("app_m", now)).map((q) => q.id)).toEqual(["apple:n1"]);
    await l.settle("app_m", "apple:n1", { state: "queued", error: "boom", nextAt: new Date(now.getTime() + 60_000).toISOString() });
    expect(await l.due("app_m", now)).toHaveLength(0);
    const [q] = await l.due("app_m", new Date(now.getTime() + 61_000));
    expect(q).toMatchObject({ attempts: 1, error: "boom", payload: { signedPayload: "x" } });
    await l.settle("app_m", "apple:n1", { state: "done", note: "Renewal" });
    expect((await l.queue("app_m"))[0]).toMatchObject({ state: "done", payload: null, note: "Renewal", attempts: 2 });
  });

  test("keys are encrypted at rest and bound to the app", async () => {
    const c = dbMoneyCredentials(t.sql);
    await c.set("app_m", "revenuecat", { webhookAuth: "super-secret-value-123" }, "RevenueCat webhook", "Pablo");
    expect(await c.get("app_m", "revenuecat")).toEqual({ webhookAuth: "super-secret-value-123" });
    const [row] = (await t.sql`SELECT secret FROM money_credentials`) as Array<{ secret: string }>;
    expect(row!.secret).not.toContain("super-secret");
    expect((await c.list("app_m"))[0]).toMatchObject({ kind: "revenuecat", label: "RevenueCat webhook", setBy: "Pablo" });
    await c.remove("app_m", "revenuecat");
    expect(await c.get("app_m", "revenuecat")).toBeNull();
  });
});
