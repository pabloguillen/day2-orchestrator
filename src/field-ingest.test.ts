import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanBatch, handleIngest, resetRateLimits, type IngestDeps } from "./field-ingest";
import { dbFieldStore, dbIngestKeys, fileFieldStore, fileIngestKeys, type FieldStore } from "./field-store";
import { createTestDatabase } from "./db/test-db";
import type { Batch } from "../packages/sensors/src/types";

const NOW = new Date("2026-10-15T12:00:00Z");

const batch = (over: Partial<Batch> = {}): Batch => ({
  v: 1,
  release: "1.4.0",
  device: { id: "dev-aaaaaaaa", platform: "web", viewport: { w: 375, h: 812 }, browser: "Safari", os: "iOS", locale: "de-DE" },
  passes: { "cart.continue": 4, "screen:/checkout": 3, "cart.continue#rejected": 1, "builtin:stability.error#failed": 2 },
  failures: [
    {
      contract: "cart.continue",
      at: "2026-10-15T11:59:00Z",
      route: "/cart",
      expected: { screen: "/checkout" },
      actual: { screen: "/cart", afterMs: 3000 },
      evidence: { requests: [{ call: "POST /api/cart/validate", status: 422, ms: 120 }], errors: [] },
      steps: ["screen /cart", "tap cart.continue", "request POST /api/cart/validate → 422"],
    },
  ],
  events: [{ type: "visit", at: "2026-10-15T11:58:00Z", acquisition: { campaignId: "B-2", channel: "paid" } }],
  ...over,
});

const post = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://day2.example/api/ingest/${key}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "text/plain", ...headers } });

describe("cleaning what apps send", () => {
  test("keeps the known fields, drops the rest, dates far-off clocks to arrival", () => {
    const b = cleanBatch(
      {
        ...batch(),
        secret: "x",
        device: { ...batch().device, email: "a@b.c" },
        failures: [{ ...batch().failures[0], at: "2020-01-01T00:00:00Z", extra: 1, expected: "x".repeat(5000) }],
        events: [{ type: "signup; drop table", at: NOW.toISOString() }, { type: "signup", at: NOW.toISOString(), acquisition: { channel: "evil", campaignId: "B-1" } }],
      },
      NOW,
    )!;
    expect(JSON.stringify(b)).not.toContain("a@b.c");
    expect(JSON.stringify(b)).not.toContain("secret");
    expect(b.failures[0]).toMatchObject({ at: NOW.toISOString(), expected: "(too large)" });
    expect(b.failures[0]).not.toHaveProperty("extra");
    expect(b.events).toEqual([{ type: "signup", at: NOW.toISOString(), acquisition: { campaignId: "B-1" } }]);
    expect(cleanBatch({ v: 2 }, NOW)).toBeNull();
    expect(cleanBatch({ ...batch(), device: { id: "x", platform: "web" } }, NOW)).toBeNull();
  });
});

function suite(name: string, make: () => Promise<{ store: FieldStore; deps: IngestDeps; appId: string; key: string; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let ctx: Awaited<ReturnType<typeof make>>;
    beforeAll(async () => {
      ctx = await make();
    });
    afterAll(async () => ctx.cleanup());
    beforeEach(() => resetRateLimits());

    test("a batch is stored: counts per contract, the failure in full, growth events", async () => {
      expect((await handleIngest(post(ctx.key, batch()), ctx.deps)).status).toBe(204);
      expect((await handleIngest(post(ctx.key, batch({ device: { ...batch().device, id: "dev-bbbbbbbb" } })), ctx.deps)).status).toBe(204);
      const h = await ctx.store.health(ctx.appId, new Date("2026-10-08T00:00:00Z"));
      const cont = h.find((x) => x.contract === "cart.continue")!;
      expect(cont).toMatchObject({ passes: 8, failures: 2, rejected: 2, devices: 2 });
      expect(cont.sample).toMatchObject({ expected: { screen: "/checkout" }, actual: { screen: "/cart" }, release: "1.4.0", device: { platform: "web", locale: "de-DE" } });
      expect(h.find((x) => x.contract === "builtin:stability.error")).toMatchObject({ failures: 4, passes: 0 });
      expect(h.find((x) => x.contract === "cart.continue#rejected")).toBeUndefined();
      const events = await ctx.store.events(ctx.appId, new Date("2026-10-01T00:00:00Z"));
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "visit", deviceId: "dev-aaaaaaaa", acquisition: { campaignId: "B-2", channel: "paid" } });
      expect(await ctx.store.meta(ctx.appId)).toMatchObject({ lastRelease: "1.4.0", platforms: ["web"] });
      expect(await ctx.store.failures(ctx.appId, "cart.continue", 1)).toHaveLength(1);
    });

    test("contracts are served by key; unknown keys, other sites, junk and floods are refused", async () => {
      await ctx.store.setContracts(ctx.appId, { head: "abc", file: { version: 1, generatedAt: NOW.toISOString(), contracts: [{ id: "screen:/", kind: "screen", route: "/", source: "code" }] }, candidates: [] }, NOW);
      const c = await handleIngest(new Request(`https://day2.example/api/ingest/${ctx.key}/contracts`), ctx.deps);
      expect(c.status).toBe(200);
      expect(c.headers.get("access-control-allow-origin")).toBe("*");
      expect(((await c.json()) as { contracts: unknown[] }).contracts).toHaveLength(1);

      expect((await handleIngest(post("d2k_aaaaaaaaaaaaaaaaaaaaaaaa", batch()), ctx.deps)).status).toBe(404);
      expect((await handleIngest(post("nope", batch()), ctx.deps)).status).toBe(404);
      expect((await handleIngest(post(ctx.key, batch(), { origin: "https://evil.example" }), ctx.deps)).status).toBe(403);
      expect((await handleIngest(post(ctx.key, batch(), { origin: "https://www.buddy.example" }), ctx.deps)).status).toBe(204);
      expect((await handleIngest(post(ctx.key, batch(), { origin: "http://localhost:5173" }), ctx.deps)).status).toBe(204);
      expect((await handleIngest(post(ctx.key, "{not json"), ctx.deps)).status).toBe(400);
      expect((await handleIngest(post(ctx.key, "x".repeat(70_000)), ctx.deps)).status).toBe(413);
      let last = 0;
      for (let i = 0; i < 125; i++) last = (await handleIngest(post(ctx.key, { v: 1 }), ctx.deps)).status;
      expect(last).toBe(429);
    });
  });
}

suite("ingest with files (local mode)", async () => {
  const root = mkdtempSync(join(tmpdir(), "day2-field-"));
  const store = fileFieldStore(join(root, "field"));
  const keys = fileIngestKeys(join(root, "keys.json"), "local");
  const key = await keys.forApp("app_1");
  expect(await keys.forApp("app_1")).toBe(key);
  return {
    store,
    appId: "app_1",
    key,
    deps: { keys, store, appBaseUrl: async () => "https://buddy.example", now: () => NOW },
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});

if (process.env.DAY2_TEST_DATABASE_URL) {
  suite("ingest with Postgres (accounts mode)", async () => {
    const t = await createTestDatabase();
    const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
    await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method, app_base_url) VALUES ('app_db', ${acc!.id}, 'buddy', '/tmp/x', 'github', 'https://buddy.example')`;
    const store = dbFieldStore(t.sql);
    const keys = dbIngestKeys(t.sql);
    const key = await keys.forApp("app_db");
    expect(await keys.forApp("app_db")).toBe(key);
    expect(await keys.resolve(key)).toEqual({ appId: "app_db", accountId: acc!.id });
    return {
      store,
      appId: "app_db",
      key,
      deps: { keys, store, appBaseUrl: async () => "https://buddy.example", now: () => NOW },
      cleanup: async () => t.drop(),
    };
  });
}
