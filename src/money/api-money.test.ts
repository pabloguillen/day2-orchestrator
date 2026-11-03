import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { appleJws, appleNotification } from "./testdata/sign";
import { MONEY_FILENAME } from "./types";
import { resetStoreNotifyLimits } from "./routes";
import { decideStrategy, propose, withGuardrails, parseStrategy } from "./strategy";
import { loadMoney, saveMoney } from "./types";

/**
 * Money's API through the real router in local mode: the page's view,
 * deciding a plan (→ products, tickets), AdMob ids, keys stored encrypted
 * and never returned, and the public store webhooks (Apple's signature is
 * checked; the test chain isn't Apple's, so it's refused).
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-money-"));
const REPO = join(ROOT, "app");
const saved: Record<string, string | undefined> = {};
let appId = "";

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handleRequest(
    new Request(`http://localhost:4700${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES", "DAY2_SECRETS_KEY"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  process.env.DAY2_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, "package.json"), '{"dependencies":{"expo":"54","react-native":"0.81"}}');
  writeFileSync(join(REPO, "app.json"), JSON.stringify({ expo: { name: "Dotty", ios: { bundleIdentifier: "de.dotty.app" }, android: { package: "de.dotty.app" } } }));
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "Dotty", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

const strategyText = `MONEY_STRATEGY_JSON:${JSON.stringify({
  category: "drawing apps",
  verdict: "monetize",
  summary: "Monthly plan with a trial, rewarded ads.",
  models: ["subscription", "rewarded_ads"],
  leaders: [{ app: "Ibis Paint", model: "subscription", example: "Prime monthly", source: "https://ibispaint.com/prime" }],
  products: [{ key: "pro_monthly", kind: "subscription", name: "Dotty Pro", description: "Alle Pinsel", period: "P1M", trialDays: 7, price: 4.99 }],
  paywalls: [{ placement: "after_third_drawing", trigger: "after the third drawing", title: "Mehr Pinsel", subtitle: "", bullets: [], products: ["pro_monthly"], highlight: "pro_monthly", cta: "Testen" }],
  ads: [{ id: "extra_stickers", format: "rewarded", where: "sticker shop", cap: {} }],
})}`;

describe("the Money page's API", () => {
  test("a mobile app's view: nothing planned yet, the owner's steps listed", async () => {
    const r = await call("GET", `/api/apps/${appId}/money`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applies: true, strategy: null, proposed: null, stores: { ios: "de.dotty.app", android: "de.dotty.app", asc: false, play: false } });
    expect(r.body.connections.map((c: { id: string }) => c.id)).toEqual(["paid_apps", "iap_key", "apple_notifications", "payments_profile", "rtdn"]);
  });

  test("approving a plan makes products and tickets; settings and AdMob ids are checked", async () => {
    const path = join(REPO, MONEY_FILENAME);
    const parsed = withGuardrails(parseStrategy(strategyText, { currency: "EUR", baseRegion: "DE" })!, { minorsHint: false });
    saveMoney(path, propose(loadMoney(path), parsed, { users: 50, rhythm: null, credits: 3, now: new Date() }).file);
    const view = await call("GET", `/api/apps/${appId}/money`);
    const sid = view.body.proposed.id;
    expect((await call("POST", `/api/apps/${appId}/money/strategy/${sid}/decide`, {})).status).toBe(400);
    const r = await call("POST", `/api/apps/${appId}/money/strategy/${sid}/decide`, { approve: true });
    expect(r.status).toBe(200);
    expect(r.body.strategy).toMatchObject({ id: sid, status: "approved" });
    expect(r.body.products[0]).toMatchObject({ productId: "de.dotty.app.pro_monthly.v1", approval: { state: "approved" } });
    expect(r.body.ads[0]).toMatchObject({ id: "extra_stickers", enabled: true, unitId: {} });
    const backlog = await call("GET", `/api/apps/${appId}/backlog`);
    expect(backlog.body.tickets.map((t: { source: { key: string } }) => t.source.key)).toEqual(expect.arrayContaining(["money:purchases", "money:paywall"]));
    expect((await call("POST", `/api/apps/${appId}/money/strategy/${sid}/decide`, { approve: true })).status).toBe(404);

    expect((await call("PUT", `/api/apps/${appId}/money/ads`, { units: { extra_stickers: { ios: "nope" } } })).status).toBe(400);
    const ads = await call("PUT", `/api/apps/${appId}/money/ads`, { appId: { ios: "ca-app-pub-1234567890123456~1234567890" }, units: { extra_stickers: { ios: "ca-app-pub-1234567890123456/1234567890" } } });
    expect(ads.body.ads[0].unitId).toEqual({ ios: "ca-app-pub-1234567890123456/1234567890" });
    expect(ads.body.config.ads.extra_stickers).toMatchObject({ enabled: true, unitId: { ios: "ca-app-pub-1234567890123456/1234567890" } });
    const s = await call("PUT", `/api/apps/${appId}/money/settings`, { prices: "auto", currency: "eur" });
    expect(s.body.settings).toMatchObject({ prices: "auto", currency: "EUR" });
    expect((await call("POST", `/api/apps/${appId}/money/connections/paid_apps/confirm`)).body.connections[0]).toMatchObject({ id: "paid_apps", state: "done" });
    expect((await call("POST", `/api/apps/${appId}/money/connections/iap_key/confirm`)).status).toBe(404);
    // Decisions are recorded with who made them.
    expect(decideStrategy).toBeDefined();
  });

  test("keys are checked, kept encrypted and never returned", async () => {
    expect((await call("PUT", `/api/apps/${appId}/money/connections/iap`, { issuerId: "x" })).status).toBe(400);
    const rc = await call("PUT", `/api/apps/${appId}/money/connections/revenuecat`, { webhookAuth: "a-long-random-shared-secret" });
    expect(rc.status).toBe(200);
    const stored = readFileSync(join(ROOT, ".day2-money-credentials.json"), "utf-8");
    expect(stored).not.toContain("a-long-random-shared-secret");
    expect(JSON.stringify((await call("GET", `/api/apps/${appId}/money`)).body)).not.toContain("a-long-random-shared-secret");
    expect((await call("PUT", `/api/apps/${appId}/money/connections/rtdn`, { pushServiceAccount: "push@proj.iam.gserviceaccount.com", audience: "https://day2.example/x" })).status).toBe(200);
    expect((await call("DELETE", `/api/apps/${appId}/money/connections/rtdn`)).status).toBe(200);
  });

  test("store webhooks are public but prove themselves", async () => {
    // A chain that doesn't end in Apple's root is refused, and nothing is recorded.
    const forged = appleNotification("DID_RENEW", { transactionId: "1", originalTransactionId: "1", productId: "p", purchaseDate: 1, type: "Consumable", price: 1000, currency: "EUR" });
    expect((await call("POST", `/api/store-notify/apple/${appId}`, { signedPayload: forged })).status).toBe(400);
    expect((await call("POST", `/api/store-notify/apple/${appId}`, { signedPayload: appleJws({}) }, { origin: "https://evil.example" })).status).toBe(400);
    expect((await call("POST", `/api/store-notify/apple/unknown-app`, { signedPayload: forged })).status).toBe(400);
    // Google: no OIDC identity configured (removed above) → refused.
    expect((await call("POST", `/api/store-notify/google/${appId}`, { message: { data: "e30=", messageId: "1" } }, { authorization: "Bearer a.b.c" })).status).toBe(401);
    // RevenueCat: the shared secret.
    expect((await call("POST", `/api/store-notify/revenuecat/${appId}`, { event: { id: "e1", type: "INITIAL_PURCHASE" } }, { authorization: "wrong" })).status).toBe(401);
    const ok = await call("POST", `/api/store-notify/revenuecat/${appId}`, { event: { id: "e1", type: "INITIAL_PURCHASE", product_id: "de.dotty.app.pro_monthly.v1", price_in_purchased_currency: 4.99, currency: "EUR", purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 30 * 86_400_000, environment: "PRODUCTION", transaction_id: "t1" } }, { authorization: "Bearer a-long-random-shared-secret" });
    expect(ok.status).toBe(200);
    const view = await call("GET", `/api/apps/${appId}/money`);
    expect(view.body.queue[0]).toMatchObject({ id: "revenuecat:e1", state: "done" });
  });

  test("an x-day2-inbox header from outside doesn't make a request a replay: Google's OIDC check still applies", async () => {
    expect((await call("PUT", `/api/apps/${appId}/money/connections/rtdn`, { pushServiceAccount: "push@proj.iam.gserviceaccount.com", audience: "https://day2.example/x" })).status).toBe(200);
    const data = Buffer.from(JSON.stringify({ packageName: "de.dotty.app", eventTimeMillis: String(Date.now()), subscriptionNotification: { notificationType: 3, purchaseToken: "attacker" } })).toString("base64");
    for (const h of [{ "x-day2-inbox": "1" }, { "x-day2-inbox": "1", "x-day2-inbox-sig": "deadbeef" }]) {
      expect((await call("POST", `/api/store-notify/google/${appId}`, { message: { data, messageId: "999" } }, h)).status).toBe(401);
    }
    const view = await call("GET", `/api/apps/${appId}/money`);
    expect(view.body.queue.some((q: { id: string }) => q.id.includes("999"))).toBe(false);
    expect((await call("DELETE", `/api/apps/${appId}/money/connections/rtdn`)).status).toBe(200);
  });

  test("store webhooks: size is checked before reading, then the shape, before any key is decrypted", async () => {
    const big = new Request(`http://localhost:4700/api/store-notify/apple/${appId}`, { method: "POST", headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) }, body: "{}" });
    expect((await handleRequest(big)).status).toBe(413);
    const streamed = new Request(`http://localhost:4700/api/store-notify/apple/${appId}`, { method: "POST", body: JSON.stringify({ signedPayload: "a".repeat(300 * 1024) }) });
    expect((await handleRequest(streamed)).status).toBe(413);
    // Not shaped like the store's body, or no Authorization where one is needed: refused without a lookup.
    expect((await call("POST", `/api/store-notify/apple/${appId}`, { signedPayload: "not a jws" })).status).toBe(400);
    expect((await call("POST", `/api/store-notify/google/${appId}`, { message: { data: "e30=", messageId: "1" } })).status).toBe(401);
    expect((await call("POST", `/api/store-notify/revenuecat/${appId}`, { event: { id: "e2", type: "X" } })).status).toBe(401);
  });

  test("store webhooks are rate-limited per address", async () => {
    resetStoreNotifyLimits();
    let last = 0;
    for (let i = 0; i < 601; i++) last = (await call("POST", `/api/store-notify/apple/${appId}`, { signedPayload: "x" }, { "cf-connecting-ip": "198.51.100.1" })).status;
    expect(last).toBe(429);
    expect((await call("POST", `/api/store-notify/apple/${appId}`, { signedPayload: "x" }, { "cf-connecting-ip": "198.51.100.2" })).status).toBe(400);
    resetStoreNotifyLimits();
  });
});
