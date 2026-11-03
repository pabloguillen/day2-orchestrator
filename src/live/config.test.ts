import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { createTestDatabase } from "../db/test-db";
import { handleIngest, resetRateLimits, type IngestDeps, type PushTokenRecord } from "../field-ingest";
import { fileFieldStore } from "../field-store";
import { buildConfig, serveConfig } from "./config";
import { liveSelf, type LiveContributor } from "./contributors";
import { dbLiveStore, fileLiveStore, type LiveStore } from "./store";
import { addLog, emptyLiveState, type Experiment } from "./types";

const NOW = new Date("2026-11-03T12:00:00Z");
const root = mkdtempSync(join(tmpdir(), "day2-live-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const APP: AppEntry = { id: "app_dotty", name: "Dotty", repoPath: root, connectionMethod: "local", addedAt: NOW.toISOString() } as AppEntry;

const exp = (id: string, state: Experiment["state"]): Experiment => ({
  id,
  title: id,
  hypothesis: "",
  keys: [`k.${id.toLowerCase()}`],
  variants: [
    { name: "control", weight: 50, values: {} },
    { name: "b", weight: 50, values: { [`k.${id.toLowerCase()}`]: 2 } },
  ],
  metric: { kind: "retention_d7" },
  guardrails: { crashRate: true, retentionD7: false },
  configOnly: true,
  state,
  createdBy: "owner",
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  minPerArm: 100,
  maxDays: 28,
  ticketId: null,
  cleanupTicketId: null,
  release: null,
  startedAt: null,
  endedAt: null,
  result: null,
  decision: null,
  stopReason: null,
  ideaId: null,
});

function storeSuite(name: string, make: () => Promise<{ store: LiveStore; appId: string; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    test("an app's Live document: read, change, served config kept", async () => {
      const { store, appId, cleanup } = await make();
      try {
        expect(await store.get(appId)).toEqual(emptyLiveState());
        const r = await store.update(appId, (s) => ({ state: addLog({ ...s, values: { "onboarding.title": { value: "Hi", by: "owner", at: NOW.toISOString() } } }, NOW, "set"), result: 7 }));
        expect(r).toBe(7);
        const s = await store.get(appId);
        expect(s.values["onboarding.title"]!.value).toBe("Hi");
        expect(s.log[0]!.text).toBe("set");
        expect(await store.served(appId)).toBeNull();
        await store.setServed(appId, { version: 3, hash: "h", body: { v: 1, version: 3, values: {}, experiments: [] } });
        expect(await store.served(appId)).toMatchObject({ version: 3, hash: "h" });
        // Parallel updates don't lose each other.
        await Promise.all(Array.from({ length: 5 }, (_, i) => store.update(appId, (x) => ({ state: { ...x, nextIdea: x.nextIdea + 1 }, result: i }))));
        expect((await store.get(appId)).nextIdea).toBe(6);
      } finally {
        await cleanup();
      }
    });
  });
}

storeSuite("Live store in a file (local mode)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "day2-live-store-"));
  return { store: fileLiveStore(async (id) => (id === "app_1" ? join(dir, "day2-live.json") : null)), appId: "app_1", cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});

if (process.env.DAY2_TEST_DATABASE_URL) {
  storeSuite("Live store in Postgres (accounts mode)", async () => {
    const t = await createTestDatabase();
    const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
    await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('app_db', ${acc!.id}, 'Dotty', '/tmp/x', 'github')`;
    return { store: dbLiveStore(t.sql), appId: "app_db", cleanup: () => t.drop() };
  });
}

describe("the config apps get", () => {
  test("Live's values win over modules'; only waiting/running/decided experiments; a failing module is left out", async () => {
    const state = { ...emptyLiveState(), values: { "paywall.trial_days": { value: 14, by: "owner" as const, at: NOW.toISOString() } }, experiments: [exp("X-1", "running"), exp("X-2", "building"), exp("X-3", "promoted"), exp("X-4", "waiting")] };
    const money: LiveContributor = {
      module: "money",
      contribute: async () => ({ values: { "paywall.trial_days": 7, "paywall.plan": "annual" }, ads: { home: { format: "banner", unitId: { ios: "a" }, cap: {}, enabled: true } } }),
    };
    const messages: LiveContributor = { module: "messages", contribute: async () => ({ messages: [{ id: "m1", trigger: "t", title: "a", body: "b", cap: { total: 1, perDay: 1 } }] }) };
    const broken: LiveContributor = { module: "store", contribute: async () => Promise.reject(new Error("boom")) };
    const warnings: string[] = [];
    const c = await buildConfig(APP, state, NOW, [liveSelf, money, messages, broken], (t) => warnings.push(t));
    expect(c.values).toEqual({ "paywall.trial_days": 14, "paywall.plan": "annual" });
    expect(c.experiments.map((e) => e.id)).toEqual(["X-1", "X-4"]);
    expect(c.ads?.home?.format).toBe("banner");
    expect(c.messages).toHaveLength(1);
    expect(c.review).toBeUndefined();
    expect(warnings[0]).toContain("store couldn't add its part");
  });

  test("the version only goes up when something changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-live-serve-"));
    const store = fileLiveStore(async () => join(dir, "day2-live.json"));
    const deps = { store, app: async () => APP };
    const a = await serveConfig(APP.id, deps);
    expect(a.version).toBe(1);
    expect((await serveConfig(APP.id, deps)).version).toBe(1);
    await store.update(APP.id, (s) => ({ state: { ...s, values: { x: { value: 1, by: "owner", at: NOW.toISOString() } } }, result: null }));
    const b = await serveConfig(APP.id, deps);
    expect(b).toMatchObject({ version: 2, values: { x: 1 } });
    // A log line alone isn't a config change.
    await store.update(APP.id, (s) => ({ state: addLog(s, NOW, "hello"), result: null }));
    expect((await serveConfig(APP.id, deps)).version).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ingest sub-routes", () => {
  const KEY = "d2k_dottyAAAAAAAAAAAAAAAAAAAA";
  const saved: Array<{ appId: string; t: PushTokenRecord }> = [];
  const deps: IngestDeps = {
    keys: { forApp: async () => KEY, resolve: async (k) => (k === KEY ? { appId: APP.id, accountId: "local" } : null) },
    store: fileFieldStore(join(root, "field")),
    appBaseUrl: async () => null,
    liveConfig: async () => ({ v: 1, version: 5, values: { "onboarding.title": "Hi" }, experiments: [] }),
    pushTokens: { save: async (appId, t) => void saved.push({ appId, t }) },
    now: () => NOW,
  };
  beforeEach(() => resetRateLimits());
  const url = (sub: string) => `https://day2.example/api/ingest/${KEY}/${sub}`;

  test("config: cache headers and an etag; the same version answers 304", async () => {
    const res = await handleIngest(new Request(url("config?p=ios&r=1.4.0")), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"5"');
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(((await res.json()) as { values: Record<string, unknown> }).values).toEqual({ "onboarding.title": "Hi" });
    const again = await handleIngest(new Request(url("config"), { headers: { "if-none-match": '"5"' } }), deps);
    expect(again.status).toBe(304);
    expect((await handleIngest(new Request(url("config"), { method: "POST", body: "{}" }), deps)).status).toBe(405);
    expect((await handleIngest(new Request(url("nope")), deps)).status).toBe(404);
    // Without Live wired in: an empty config.
    const bare = await handleIngest(new Request(url("config")), { ...deps, liveConfig: undefined });
    expect(await bare.json()).toEqual({ v: 1, version: 0, values: {}, experiments: [] });
  });

  test("push: a hashed user's token is handed to the push store; anything else is refused", async () => {
    const user = `u_${"a".repeat(32)}`;
    const post = (body: unknown) => handleIngest(new Request(url("push"), { method: "POST", body: JSON.stringify(body) }), deps);
    const device = "dev-phone-0001";
    expect((await post({ user, device, token: "ExponentPushToken[xyz123]", platform: "ios", tz: "Europe/Berlin", locale: "de-DE" })).status).toBe(204);
    expect(saved).toEqual([{ appId: APP.id, t: { user, device, token: "ExponentPushToken[xyz123]", platform: "ios", tz: "Europe/Berlin", locale: "de-DE", at: NOW.toISOString() } }]);
    expect((await post({ user: "alice@example.com", device, token: "ExponentPushToken[xyz123]", platform: "ios" })).status).toBe(400);
    expect((await post({ user, device, token: "x", platform: "ios" })).status).toBe(400);
    // Without the sending device's id: refused (tokens are bound to devices).
    expect((await post({ user, token: "ExponentPushToken[xyz123]", platform: "ios" })).status).toBe(400);
    expect((await post({ user, device, token: null, platform: "android" })).status).toBe(204);
    expect(saved[1]!.t.token).toBeNull();
    // Messages not built yet: accepted, nothing stored.
    const res = await handleIngest(new Request(url("push"), { method: "POST", body: JSON.stringify({ user, device, token: "ExponentPushToken[q]", platform: "ios" }) }), { ...deps, pushTokens: undefined });
    expect(res.status).toBe(204);
  });

  test("contracts still work through the same table", async () => {
    const res = await handleIngest(new Request(url("contracts")), deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { contracts: unknown[] }).contracts).toEqual([]);
  });
});
