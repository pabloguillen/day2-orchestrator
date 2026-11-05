import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanBatch, handleIngest, rateLimitBuckets, resetRateLimits, type IngestDeps, type PushTokenRecord } from "./field-ingest";
import { asRequest } from "./ingest-inbox";
import { createLimiter } from "./rate-limit";
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

describe("props, money and Live assignments", () => {
  test("props: at most 8 well-named keys, short strings, finite numbers, booleans", () => {
    const b = cleanBatch(
      {
        ...batch(),
        events: [
          {
            type: "exposure",
            at: NOW.toISOString(),
            props: { exp: "X-1", variant: "short", Bad: 1, "with space": 2, long: "x".repeat(200), n: 3, ok: true, nan: Number.NaN, obj: { a: 1 }, a: 1, b: 2, c: 3, d: 4, e: 5 },
          },
        ],
      },
      NOW,
    )!;
    const props = b.events[0]!.props!;
    expect(Object.keys(props)).toHaveLength(8);
    expect(props).toMatchObject({ exp: "X-1", variant: "short", n: 3, ok: true });
    expect(props.long).toHaveLength(80);
    expect(props).not.toHaveProperty("Bad");
    expect(props).not.toHaveProperty("obj");
    expect(props).not.toHaveProperty("nan");
  });

  test("money: 0 ≤ amount < 10 000 and an ISO currency, else dropped (the event stays)", () => {
    const ev = (value: unknown) => cleanBatch({ ...batch(), events: [{ type: "revenue", at: NOW.toISOString(), value }] }, NOW)!.events[0]!;
    expect(ev({ amount: 4.99, currency: "EUR" }).value).toEqual({ amount: 4.99, currency: "EUR" });
    expect(ev({ amount: -1, currency: "EUR" })).not.toHaveProperty("value");
    expect(ev({ amount: 10_000, currency: "EUR" })).not.toHaveProperty("value");
    expect(ev({ amount: 1, currency: "eur" })).not.toHaveProperty("value");
    expect(ev({ amount: "1", currency: "EUR" })).not.toHaveProperty("value");
    expect(ev({ amount: 1, currency: "EUR" }).type).toBe("revenue");
  });

  test("variants: at most 20, short ids", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`X-${i}`, "control"]));
    const b = cleanBatch({ ...batch(), variants: { ...many, "bad id!": "x", "X-99": "<script>" } }, NOW)!;
    expect(Object.keys(b.variants!)).toHaveLength(20);
    expect(JSON.stringify(b.variants)).not.toContain("script");
    expect(cleanBatch({ ...batch(), variants: "nope" }, NOW)).not.toHaveProperty("variants");
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

    test("props, money and the batch's Live assignments are kept on each event", async () => {
      const b = batch({
        device: { id: "dev-live0001", platform: "ios" },
        failures: [],
        passes: {},
        variants: { "X-1": "short" },
        events: [
          { type: "exposure", at: "2026-10-15T11:58:00Z", user: `u_${"a".repeat(32)}`, props: { exp: "X-1", variant: "short" } },
          { type: "revenue", at: "2026-10-15T11:58:30Z", user: `u_${"a".repeat(32)}`, value: { amount: 4.99, currency: "EUR" }, props: { kind: "subscription", product: "pro_monthly" } },
        ],
      });
      expect((await handleIngest(post(ctx.key, b), ctx.deps)).status).toBe(204);
      const events = (await ctx.store.events(ctx.appId, new Date("2026-10-01T00:00:00Z"))).filter((e) => e.deviceId === "dev-live0001");
      expect(events).toEqual([
        { type: "exposure", at: "2026-10-15T11:58:00.000Z", deviceId: "dev-live0001", platform: "ios", userId: `u_${"a".repeat(32)}`, props: { exp: "X-1", variant: "short" }, variants: { "X-1": "short" } },
        {
          type: "revenue",
          at: "2026-10-15T11:58:30.000Z",
          deviceId: "dev-live0001",
          platform: "ios",
          userId: `u_${"a".repeat(32)}`,
          props: { kind: "subscription", product: "pro_monthly" },
          value: { amount: 4.99, currency: "EUR" },
          variants: { "X-1": "short" },
        },
      ]);
    });

    test("ad clicks: the click id kept with the visitor's IP and browser (for sending conversions), which go after 7 days", async () => {
      const events = [
        { type: "visit", at: "2026-10-15T11:58:00Z", acquisition: { campaignId: "B-3.tiktok.v1", channel: "paid", click: { param: "ttclid", value: "E.C.P.abc123" } } },
        { type: "visit", at: "2026-10-15T11:58:30Z", acquisition: { campaignId: "B-3", channel: "paid", click: { param: "ttclid", value: "<script>" } } },
        { type: "visit", at: "2026-10-15T11:59:00Z", acquisition: { campaignId: "B-3", channel: "paid", click: { param: "utm_evil", value: "abcdef" } } },
      ];
      const b = batch({ device: { ...batch().device, id: "dev-clicks01" }, events: events as Batch["events"] });
      expect((await handleIngest(post(ctx.key, b, { "cf-connecting-ip": "203.0.113.7", "user-agent": "Mozilla/5.0 (iPhone)" }), ctx.deps)).status).toBe(204);
      const mine = (await ctx.store.events(ctx.appId, new Date("2026-10-01T00:00:00Z"))).filter((e) => e.deviceId === "dev-clicks01");
      expect(mine.map((e) => e.acquisition?.click ?? null)).toEqual([{ param: "ttclid", value: "E.C.P.abc123", ip: "203.0.113.7", ua: "Mozilla/5.0 (iPhone)" }, null, null]);
      // From a phone: the click id (sent after consent) is kept, the IP address and device details aren't.
      const phone = batch({ device: { id: "dev-phone001", platform: "ios" }, events: [{ type: "ad_click", at: "2026-10-15T11:58:00Z", acquisition: { campaignId: "B-3.tiktok.v1", channel: "paid", click: { param: "ttclid", value: "E.C.P.ph1" } } }] as Batch["events"] });
      expect((await handleIngest(post(ctx.key, phone, { "cf-connecting-ip": "203.0.113.9", "user-agent": "Buddy/3.0" }), ctx.deps)).status).toBe(204);
      const ph = (await ctx.store.events(ctx.appId, new Date("2026-10-01T00:00:00Z"))).find((e) => e.deviceId === "dev-phone001")!;
      expect(ph.acquisition!.click).toEqual({ param: "ttclid", value: "E.C.P.ph1" });
      await ctx.store.prune(new Date("2026-10-23T12:00:00Z"));
      const later = (await ctx.store.events(ctx.appId, new Date("2026-10-01T00:00:00Z"))).find((e) => e.deviceId === "dev-clicks01")!;
      expect(later.acquisition!.click).toEqual({ param: "ttclid", value: "E.C.P.abc123" });
    });

    test("identified users: hashed ids only, active days per user, a stored snapshot", async () => {
      const u1 = `u_${"a".repeat(32)}`;
      const u2 = `u_${"b".repeat(32)}`;
      const ev = (user: string, at: string) => ({ type: "active", at, user });
      const b = { v: 1, device: { id: "dev-users1", platform: "web" }, passes: {}, failures: [], events: [ev(u1, "2026-10-14T15:00:00Z"), ev(u1, "2026-10-15T09:00:00Z"), ev(u1, "2026-10-15T11:00:00Z"), { type: "active", at: "2026-10-15T09:00:00Z", user: "alice@example.com" }] };
      expect((await handleIngest(post(ctx.key, b), ctx.deps)).status).toBe(204);
      // Someone last seen in March (written directly: ingest dates old reports to arrival).
      await ctx.store.record(ctx.appId, { v: 1, device: { id: "dev-users2", platform: "web" }, passes: {}, failures: [], events: [ev(u2, "2026-03-01T09:00:00Z")] }, NOW);
      const all = await ctx.store.activity(ctx.appId, "2026-01-01");
      const one = all.users.find((u) => u.user === u1)!;
      expect(one).toMatchObject({ firstSeen: "2026-10-14", lastSeen: "2026-10-15", days: ["2026-10-14", "2026-10-15"] });
      expect(all.users.map((u) => u.user).sort()).toEqual([u1, u2]); // the raw email was dropped
      expect(JSON.stringify(await ctx.store.events(ctx.appId, new Date("2026-01-01")))).not.toContain("alice");
      const recent = await ctx.store.activity(ctx.appId, "2026-10-01");
      expect(recent).toMatchObject({ older: 1, users: [{ user: u1 }] });
      await ctx.store.setRetention(ctx.appId, { at: NOW.toISOString(), status: "ready", users: 2 } as never);
      expect(await ctx.store.retention(ctx.appId)).toMatchObject({ status: "ready", users: 2 });
      // Kept 400 days per day, two years per user.
      await ctx.store.prune(new Date("2028-03-15T00:00:00Z"));
      expect((await ctx.store.activity(ctx.appId, "2026-01-01")).users.map((u) => u.user)).toEqual([u1]);
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

describe("rate limits can't be reset by flooding, and come in the right order", () => {
  const KEY = `d2k_${"a".repeat(24)}`;
  const USER = `u_${"0".repeat(32)}`;
  const saved: PushTokenRecord[] = [];
  let resolves = 0;
  const deps: IngestDeps = {
    keys: { resolve: async (k: string) => (resolves++, k === KEY ? { appId: "a", accountId: "x" } : null) } as never,
    store: { record: async () => {} } as never,
    appBaseUrl: async () => null,
    pushTokens: { save: async (_a, t) => void saved.push(t) },
    now: () => NOW,
  };
  const push = (key: string, ip: string, body: Record<string, unknown> = {}) =>
    handleIngest(new Request(`https://day2.example/api/ingest/${key}/push`, { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ user: USER, device: "dev-phone-0001", token: "ExponentPushToken[xxxxxxxxxx]", platform: "ios", ...body }) }), deps);
  const report = (key: string, ip: string) => handleIngest(post(key, { v: 1 }, { "cf-connecting-ip": ip }), deps);
  beforeEach(() => {
    resetRateLimits();
    saved.length = 0;
    resolves = 0;
  });

  test("junk keys never get a bucket, so they can't flush the real key's limit", async () => {
    let ok = 0;
    for (let i = 0; i < 130; i++) if ((await report(KEY, `1.1.1.${i}`)).status !== 429) ok++;
    expect(ok).toBe(120);
    // Unknown keys from many addresses: each address gets a bucket, no key does.
    for (let i = 0; i < 2000; i++) await report(`d2k_junk${i.toString(36).padStart(20, "0")}`, `9.9.${i >> 8}.${i & 255}`);
    expect(rateLimitBuckets()).toBeLessThan(2000 + 200);
    expect((await report(KEY, "1.1.1.1")).status).toBe(429);
  });

  test("the address is checked before the key is looked up", async () => {
    for (let i = 0; i < 300; i++) await report(`d2k_junk${i.toString(36).padStart(20, "0")}`, "6.6.6.6");
    const before = resolves;
    expect((await report(KEY, "6.6.6.6")).status).toBe(429);
    expect(resolves).toBe(before); // refused without a lookup
  });

  test("a full limiter evicts expired and under-limit buckets, never one that's over its limit", () => {
    const l = createLimiter(100);
    for (let i = 0; i < 6; i++) l.allow("hot", 5, 1000);
    expect(l.allow("hot", 5, 1000)).toBe(false);
    for (let i = 0; i < 10_000; i++) l.allow(`junk${i}`, 5, 1000 + i);
    expect(l.size()).toBeLessThanOrEqual(101);
    expect(l.allow("hot", 5, 2000)).toBe(false); // still limited
    expect(l.allow("hot", 5, 61_001)).toBe(true); // its own window ended
  });

  test("x-forwarded-for is only believed with DAY2_TRUST_PROXY; cf-connecting-ip always", async () => {
    const xff = (ip: string) => handleIngest(post(`d2k_${"z".repeat(24)}`, { v: 1 }, { "x-forwarded-for": ip }), deps);
    // Spoofed X-Forwarded-For doesn't get around the per-address limit.
    let last = 0;
    for (let i = 0; i < 301; i++) last = (await xff(`10.0.${i >> 8}.${i & 255}`)).status;
    expect(last).toBe(429);
    // Cloudflare's address header counts per address.
    expect((await handleIngest(post(`d2k_${"z".repeat(24)}`, { v: 1 }, { "cf-connecting-ip": "10.9.9.9" }), deps)).status).toBe(404);
    const prev = process.env.DAY2_TRUST_PROXY;
    process.env.DAY2_TRUST_PROXY = "on";
    try {
      expect((await xff("10.8.8.8")).status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.DAY2_TRUST_PROXY;
      else process.env.DAY2_TRUST_PROXY = prev;
    }
  });

  test("push: the device id is required, sent on, and registrations are limited per user", async () => {
    expect((await push(KEY, "2.2.2.2", { device: undefined })).status).toBe(400);
    expect((await push(KEY, "2.2.2.2", { device: "../../x" })).status).toBe(400);
    expect((await push(KEY, "2.2.2.2")).status).toBe(204);
    expect(saved[0]).toMatchObject({ user: USER, device: "dev-phone-0001", token: "ExponentPushToken[xxxxxxxxxx]" });
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await push(KEY, `3.3.3.${i}`)).status;
    expect(last).toBe(429);
    expect(saved.length).toBe(20);
  });

  test("inbox replays have their own allowance: a busy public limit doesn't hold them back", async () => {
    for (let i = 0; i < 125; i++) await report(KEY, `4.4.4.${i}`);
    expect((await report(KEY, "4.4.4.200")).status).toBe(429);
    const replay = asRequest({ id: 1, path: `/api/ingest/${KEY}`, body: JSON.stringify({ v: 1 }), ip: "4.4.4.4", ua: null, origin: null, received_at: NOW.getTime() });
    expect((await handleIngest(replay, deps)).status).toBe(400); // handled (not a batch), not 429
    // A header can't make a request a replay.
    const forged = post(KEY, { v: 1 }, { "cf-connecting-ip": "4.4.4.201", "x-day2-inbox": "1" });
    expect((await handleIngest(forged, deps)).status).toBe(429);
  });
});
