import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLE_ROOT_CA_G3_SHA256, JwsError, verifyAppleJws } from "./apple-jws";
import { resetGoogleCertCache, type PlayPurchases } from "./google-play";
import { fileMoneyLedger, MAX_UNVERIFIED_QUEUED, trimQueue, type MoneyLedger } from "./ledger";
import { appleJws, appleNotification, GOOGLE_KID, googleJwks, googleOidc, otherRootChain, pubsubPush, TEST_ROOT } from "./testdata/sign";
import type { Product } from "./types";
import { purchaseTokenFor as libraryToken } from "../../packages/sensors/src/live";
import { drainQueue, purchaseTokenFor, receiveApple, receiveGoogle, tokenResolver, type VerifyDeps } from "./verify";

const NOW = new Date("2026-12-01T10:00:05Z"); // after the test certificates were made
const KEY = "d2k_qodmrFihh_VU5JJgYrl-Nrns";
const USER = "u_0123456789abcdef0123456789abcdef";
const TOKEN = purchaseTokenFor(KEY, USER);

const product = (over: Partial<Product> = {}): Product => ({
  key: "pro_monthly",
  kind: "subscription",
  name: "Dotty Pro",
  description: "All brushes",
  period: "P1M",
  trialDays: 7,
  base: { region: "DE", amount: 4.99, currency: "EUR" },
  regional: [{ region: "US", amount: 4.99, currency: "USD" }],
  why: "",
  productId: "de.dotty.app.pro_monthly.v1",
  version: 1,
  approval: { state: "approved", by: "o", at: null },
  ios: { state: "created" },
  android: { state: "created", ref: "de.dotty.app.pro_monthly.v1", group: "monthly", offer: "trial7" },
  createdAt: NOW.toISOString(),
  ...over,
});

let ledger: MoneyLedger;
let connected: string[];
let deps: VerifyDeps;

beforeEach(() => {
  ledger = fileMoneyLedger(mkdtempSync(join(tmpdir(), "money-ledger-")));
  connected = [];
  deps = {
    ledger,
    who: tokenResolver(KEY, [USER, "u_other"], () => ({ "X-3": "B" }), () => "meta"),
    bundleId: "de.dotty.app",
    packageName: "de.dotty.app",
    appleRoots: [TEST_ROOT],
    catalog: [product(), product({ key: "brushes", kind: "consumable", productId: "de.dotty.app.brushes.v1", base: { region: "DE", amount: 1.99, currency: "EUR" }, regional: [] })],
    connected: async (c) => void connected.push(c),
    now: NOW,
  };
});

describe("purchase token", () => {
  test("is a stable UUID that maps back to the hashed user", () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(TOKEN).toBe(libraryToken(KEY, USER)); // the app library gives the same token
    expect(purchaseTokenFor(KEY, USER)).toBe(TOKEN);
    expect(tokenResolver(KEY, [USER], () => ({}), () => null)(TOKEN.toUpperCase())?.user).toBe(USER);
    expect(tokenResolver(KEY, [USER], () => ({}), () => null)(purchaseTokenFor(KEY, "u_x"))).toBeNull();
  });
});

describe("Apple JWS", () => {
  test("verifies the chain and the signature", () => {
    expect(verifyAppleJws<{ a: number }>(appleJws({ a: 1 }), { roots: [TEST_ROOT] }).a).toBe(1);
  });
  test("refuses a chain that doesn't end in the pinned root", () => {
    // Apple's real root is the default: the test chain isn't it.
    expect(() => verifyAppleJws(appleJws({ a: 1 }))).toThrow(JwsError);
    expect(APPLE_ROOT_CA_G3_SHA256).toContain("63:34:3A:BF");
    expect(() => verifyAppleJws(appleJws({ a: 1 }, { x5c: otherRootChain() }), { roots: [TEST_ROOT] })).toThrow(/issued by the root/);
  });
  test("refuses a changed payload", () => {
    const [h, , s] = appleJws({ a: 1 }).split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${s}`;
    expect(() => verifyAppleJws(forged, { roots: [TEST_ROOT] })).toThrow(/signature/);
  });
  test("refuses expired certificates", () => {
    expect(() => verifyAppleJws(appleJws({ a: 1 }), { roots: [TEST_ROOT], now: new Date("2090-01-01") })).toThrow(/expired/);
  });
});

describe("Apple notifications", () => {
  const tx = (o: Record<string, unknown> = {}) => ({
    transactionId: "2000001",
    originalTransactionId: "2000000",
    productId: "de.dotty.app.pro_monthly.v1",
    purchaseDate: Date.parse("2026-11-01T09:00:00Z"),
    expiresDate: Date.parse("2026-12-01T09:00:00Z"),
    type: "Auto-Renewable Subscription",
    appAccountToken: TOKEN,
    price: 4990,
    currency: "EUR",
    ...o,
  });

  test("a new subscription becomes purchase_verified for the hashed user, with variants and source", async () => {
    const r = await receiveApple("a1", { signedPayload: appleNotification("SUBSCRIBED", tx(), { subtype: "INITIAL_BUY", uuid: "n1" }) }, deps);
    expect(r.status).toBe(200);
    const recs = await ledger.records("a1", new Date(0));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ type: "purchase_verified", kind: "subscription", amount: 4.99, currency: "EUR", user: USER, variants: { "X-3": "B" }, source: "meta", chain: "2000000", sandbox: false });
  });

  test("a free trial, then the renewal that converts it", async () => {
    await receiveApple("a1", { signedPayload: appleNotification("SUBSCRIBED", tx({ price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL" }), { uuid: "n1" }) }, deps);
    await receiveApple("a1", { signedPayload: appleNotification("DID_RENEW", tx({ transactionId: "2000002" }), { uuid: "n2" }) }, deps);
    const recs = await ledger.records("a1", new Date(0));
    expect(recs.map((r) => [r.type, r.amount])).toEqual([
      ["trial_started", 0],
      ["renewal", 4.99],
    ]);
  });

  test("a redelivered notification counts once; refunds and their reversal", async () => {
    const body = { signedPayload: appleNotification("ONE_TIME_CHARGE", tx({ type: "Consumable", productId: "de.dotty.app.brushes.v1", price: 1990 }), { uuid: "n3" }) };
    await receiveApple("a1", body, deps);
    expect((await receiveApple("a1", body, deps)).note).toBe("already received");
    await receiveApple("a1", { signedPayload: appleNotification("REFUND", tx({ type: "Consumable", productId: "de.dotty.app.brushes.v1", price: 1990, revocationDate: NOW.getTime() }), { uuid: "n4" }) }, deps);
    let recs = await ledger.records("a1", new Date(0));
    expect(recs.map((r) => [r.type, r.kind, r.amount])).toEqual([
      ["purchase_verified", "purchase", 1.99],
      ["refund", "purchase", 1.99],
    ]);
    await receiveApple("a1", { signedPayload: appleNotification("REFUND_REVERSED", tx({ type: "Consumable", productId: "de.dotty.app.brushes.v1", price: 1990 }), { uuid: "n5" }) }, deps);
    recs = await ledger.records("a1", new Date(0));
    expect(recs.find((r) => r.type === "refund")?.amount).toBe(0);
  });

  test("forged bodies are refused; other apps and tests are ignored", async () => {
    expect((await receiveApple("a1", { signedPayload: "x.y.z" }, deps)).status).toBe(400);
    expect((await receiveApple("a1", {}, deps)).status).toBe(400);
    await receiveApple("a1", { signedPayload: appleNotification("DID_RENEW", tx({ bundleId: "com.other" }), { uuid: "n6", bundleId: "com.other" }) }, deps);
    await receiveApple("a1", { signedPayload: appleJws({ notificationType: "TEST", notificationUUID: "t1", data: { bundleId: "de.dotty.app" } }) }, deps);
    expect(await ledger.records("a1", new Date(0))).toHaveLength(0);
    expect(connected).toEqual(["apple_notifications"]);
    const q = await ledger.queue("a1");
    expect(q.every((x) => x.state === "ignored" && x.payload === null)).toBe(true);
  });

  test("Apple's TEST for another app (or with no bundle id) is not taken as proof; without a bundle id everything is refused", async () => {
    await receiveApple("a1", { signedPayload: appleJws({ notificationType: "TEST", notificationUUID: "t2", data: { bundleId: "com.other" } }) }, deps);
    await receiveApple("a1", { signedPayload: appleJws({ notificationType: "TEST", notificationUUID: "t3", data: {} }) }, deps);
    await receiveApple("a1", { signedPayload: appleJws({ notificationType: "TEST", notificationUUID: "t4", data: { bundleId: "de.dotty.app", appAppleId: 999 } }) }, { ...deps, appAppleId: 123 });
    expect(connected).toEqual([]);
    const none = { ...deps, bundleId: null };
    expect((await receiveApple("a1", { signedPayload: appleJws({ notificationType: "TEST", notificationUUID: "t5", data: { bundleId: "de.dotty.app" } }) }, none)).status).toBe(400);
    expect((await receiveApple("a1", { signedPayload: appleNotification("DID_RENEW", tx(), { uuid: "n9" }) }, none)).status).toBe(400);
    expect(connected).toEqual([]);
    expect(await ledger.records("a1", new Date(0))).toHaveLength(0);
  });

  test("turning off renewal is a cancellation; purchases without day2's token stay unattributed", async () => {
    await receiveApple("a1", { signedPayload: appleNotification("DID_CHANGE_RENEWAL_STATUS", tx({ appAccountToken: undefined }), { subtype: "AUTO_RENEW_DISABLED", uuid: "n7" }) }, deps);
    const [r] = await ledger.records("a1", new Date(0));
    expect(r).toMatchObject({ type: "cancellation", user: null, variants: {} });
  });
});

describe("Google notifications", () => {
  const AUD = "https://day2.example/api/store-notify/google/a1";
  const SA = "rtdn-push@dotty.iam.gserviceaccount.com";
  const jwksFetch = (async (url: string) => {
    if (String(url).includes("oauth2/v3/certs")) return new Response(JSON.stringify(googleJwks), { headers: { "cache-control": "max-age=600" } });
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const auth = (o: Record<string, unknown> = {}) => `Bearer ${googleOidc({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, exp: Math.floor(NOW.getTime() / 1000) + 600, ...o })}`;
  const sub = (o: Record<string, unknown> = {}) => ({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    latestOrderId: "GPA.1",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: TOKEN },
    lineItems: [{ productId: "de.dotty.app.pro_monthly.v1", expiryTime: "2026-12-01T09:00:00Z", autoRenewingPlan: { recurringPrice: { currencyCode: "EUR", units: "4", nanos: 990000000 } }, offerDetails: { basePlanId: "monthly" } }],
    ...o,
  });
  let calls: string[];
  let play: PlayPurchases;
  let current: Record<string, unknown>;

  beforeEach(() => {
    resetGoogleCertCache();
    calls = [];
    current = sub();
    play = {
      subscription: async (_p, t) => (calls.push(`sub:${t}`), current as never),
      product: async (_p, sku, t) => (calls.push(`prod:${sku}:${t}`), { purchaseState: 0, orderId: "GPA.9", regionCode: "DE", acknowledgementState: 0, obfuscatedExternalAccountId: TOKEN, purchaseTimeMillis: String(NOW.getTime()) }),
      acknowledgeSubscription: async () => void calls.push("ack-sub"),
      acknowledgeProduct: async () => void calls.push("ack-prod"),
      voidedOrders: async () => (calls.push("voided"), new Set(["GPA.9"])),
    };
    deps = { ...deps, play, rtdn: { pushServiceAccount: SA, audience: AUD }, fetch: jwksFetch };
  });

  const note = (n: Record<string, unknown>) => ({ version: "1.0", packageName: "de.dotty.app", eventTimeMillis: String(NOW.getTime()), ...n });

  test("only pushes with Google's OIDC token for the configured account and audience are believed", async () => {
    const body = pubsubPush("m1", note({ subscriptionNotification: { notificationType: 4, purchaseToken: "tok", subscriptionId: "x" } }));
    expect((await receiveGoogle("a1", null, body, deps)).status).toBe(401);
    expect((await receiveGoogle("a1", auth({ aud: "https://elsewhere" }), body, deps)).note).toMatch(/audience/);
    expect((await receiveGoogle("a1", auth({ email: "x@y.iam.gserviceaccount.com" }), body, deps)).note).toMatch(/service account/);
    expect((await receiveGoogle("a1", auth({ exp: 100 }), body, deps)).note).toMatch(/expired/);
    expect((await receiveGoogle("a1", `Bearer ${googleOidc({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, exp: 9e9 }, "unknown")}`, body, deps)).note).toMatch(/current Google key/);
    expect((await receiveGoogle("a1", auth(), body, { ...deps, rtdn: null })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("a purchase is read from the Play API, acknowledged, and attributed", async () => {
    const r = await receiveGoogle("a1", auth(), pubsubPush("m1", note({ subscriptionNotification: { notificationType: 4, purchaseToken: "tok", subscriptionId: "de.dotty.app.pro_monthly.v1" } })), deps);
    expect(r.status).toBe(204);
    expect(calls).toEqual(["sub:tok", "ack-sub"]);
    const [rec] = await ledger.records("a1", new Date(0));
    expect(rec).toMatchObject({ id: "google:GPA.1:purchase_verified", type: "purchase_verified", amount: 4.99, currency: "EUR", user: USER, variants: { "X-3": "B" } });
    expect(rec!.chain).not.toContain("tok");
  });

  test("the trial offer starts a trial; each renewal is its own order", async () => {
    current = sub({ lineItems: [{ ...sub().lineItems[0], offerDetails: { basePlanId: "monthly", offerId: "trial7" } }] });
    await receiveGoogle("a1", auth(), pubsubPush("m1", note({ subscriptionNotification: { notificationType: 4, purchaseToken: "tok" } })), deps);
    current = sub({ latestOrderId: "GPA.1..0", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" });
    await receiveGoogle("a1", auth(), pubsubPush("m2", note({ subscriptionNotification: { notificationType: 2, purchaseToken: "tok" } })), deps);
    await receiveGoogle("a1", auth(), pubsubPush("m2", note({ subscriptionNotification: { notificationType: 2, purchaseToken: "tok" } })), deps);
    const recs = await ledger.records("a1", new Date(0));
    expect(recs.map((r) => [r.type, r.amount])).toEqual([
      ["trial_started", 0],
      ["renewal", 4.99],
    ]);
  });

  test("one-time purchases use day2's price for the region; voided purchases refund what was paid", async () => {
    await receiveGoogle("a1", auth(), pubsubPush("m3", note({ oneTimeProductNotification: { notificationType: 1, purchaseToken: "t2", sku: "de.dotty.app.brushes.v1" } })), deps);
    await receiveGoogle("a1", auth(), pubsubPush("m4", note({ voidedPurchaseNotification: { purchaseToken: "t2", orderId: "GPA.9", productType: 2 } })), deps);
    const recs = await ledger.records("a1", new Date(0));
    expect(recs.map((r) => [r.type, r.kind, r.amount, r.user])).toEqual([
      ["purchase_verified", "purchase", 1.99, USER],
      ["refund", "purchase", 1.99, USER],
    ]);
    expect(calls).toContain("ack-prod");
  });

  test("a failed lookup is retried later from the queue", async () => {
    let fail = true;
    deps.play = { ...play, subscription: async (...a) => (fail ? Promise.reject(new Error("boom")) : play.subscription(...a)) };
    await receiveGoogle("a1", auth(), pubsubPush("m5", note({ subscriptionNotification: { notificationType: 2, purchaseToken: "tok" } })), deps);
    let [q] = await ledger.queue("a1");
    expect(q).toMatchObject({ state: "queued", attempts: 1, error: "boom" });
    expect(q!.payload).not.toBeNull();
    fail = false;
    expect(await drainQueue("a1", { ...deps, now: new Date(NOW.getTime() + 30_000) })).toEqual({ done: 0, retrying: 0, failed: 0 });
    expect(await drainQueue("a1", { ...deps, now: new Date(NOW.getTime() + 61_000) })).toEqual({ done: 1, retrying: 0, failed: 0 });
    [q] = await ledger.queue("a1");
    expect(q).toMatchObject({ state: "done", payload: null });
  });

  test("inbox replays (no Authorization) only count what the Play API confirms", async () => {
    // Without the replay marker a missing token is refused.
    expect((await receiveGoogle("a1", null, pubsubPush("r0", note({ testNotification: {} })), deps)).status).toBe(401);
    await receiveGoogle("a1", null, pubsubPush("r1", note({ testNotification: {} })), deps, { replay: true });
    expect(connected).toEqual([]);
    await receiveGoogle("a1", null, pubsubPush("r2", note({ subscriptionNotification: { notificationType: 4, purchaseToken: "tok" } })), deps, { replay: true });
    await receiveGoogle("a1", null, pubsubPush("r3", note({ voidedPurchaseNotification: { purchaseToken: "x", orderId: "GPA.forged", productType: 1 } })), deps, { replay: true });
    const recs = await ledger.records("a1", new Date(0));
    expect(recs.map((r) => r.type)).toEqual(["purchase_verified"]);
    expect(calls).toContain("sub:tok");
    expect(calls).toContain("voided");
  });

  test("the test notification proves the connection", async () => {
    await receiveGoogle("a1", auth(), pubsubPush("m6", note({ testNotification: { version: "1.0" } })), deps);
    expect(connected).toEqual(["rtdn"]);
    expect(GOOGLE_KID).toBe("test-kid");
  });

  test("forged replays can't record cancellations or billing issues for a subscription Google says is active", async () => {
    for (let i = 0; i < 6; i++) await receiveGoogle("a1", null, pubsubPush(`evil${i}`, note({ subscriptionNotification: { notificationType: [3, 5, 6, 12, 13][i % 5], purchaseToken: "attackers-own" } })), deps, { replay: true });
    expect(await ledger.records("a1", new Date(0))).toEqual([]);
    // Verified pushes are checked against the state too.
    await receiveGoogle("a1", auth(), pubsubPush("m7", note({ subscriptionNotification: { notificationType: 3, purchaseToken: "tok" } })), deps);
    expect(await ledger.records("a1", new Date(0))).toEqual([]);
    // When Google agrees, it's recorded — and an unverified repeat counts once.
    current = sub({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", canceledStateContext: { userInitiatedCancellation: {} } });
    for (const id of ["c1", "c2", "c3"]) await receiveGoogle("a1", null, pubsubPush(id, note({ subscriptionNotification: { notificationType: 3, purchaseToken: "tok" } })), deps, { replay: true });
    expect((await ledger.records("a1", new Date(0))).map((r) => r.type)).toEqual(["cancellation"]);
    current = sub({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" });
    await receiveGoogle("a1", auth(), pubsubPush("m8", note({ subscriptionNotification: { notificationType: 5, purchaseToken: "tok" } })), deps);
    expect((await ledger.records("a1", new Date(0))).map((r) => r.type)).toEqual(["cancellation", "billing_issue"]);
  });

  test("a replayed message id can't pre-claim the real Pub/Sub message", async () => {
    current = sub({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" });
    await receiveGoogle("a1", null, pubsubPush("123456", note({ testNotification: {} })), deps, { replay: true });
    const real = await receiveGoogle("a1", auth(), pubsubPush("123456", note({ subscriptionNotification: { notificationType: 5, purchaseToken: "tok" } })), deps);
    expect(real.note).toBe("received");
    expect((await ledger.records("a1", new Date(0))).map((r) => r.type)).toEqual(["billing_issue"]);
  });

  test("only so many unverified replays wait at once; verified retries are never pushed out", async () => {
    deps.play = { ...play, subscription: async () => Promise.reject(new Error("Play is down")) };
    await receiveGoogle("a1", auth(), pubsubPush("real1", note({ subscriptionNotification: { notificationType: 2, purchaseToken: "tok" } })), deps);
    for (let i = 0; i < MAX_UNVERIFIED_QUEUED + 50; i++) await receiveGoogle("a1", null, pubsubPush(`flood${i}`, note({ subscriptionNotification: { notificationType: 2, purchaseToken: `t${i}` } })), deps, { replay: true });
    const q = await ledger.queue("a1", 5000);
    expect(q.filter((x) => x.id.startsWith("google:inbox:")).length).toBe(MAX_UNVERIFIED_QUEUED);
    expect(q.find((x) => x.id === "google:real1")).toMatchObject({ state: "queued" });
    // Verified first when the queue is worked through.
    expect((await ledger.due("a1", new Date(NOW.getTime() + 86_400_000), 1))[0]!.id).toBe("google:real1");
    // And trimming the file queue keeps verified items that still wait.
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, store: "google" as const, receivedAt: NOW.toISOString(), state: (i === 0 ? "queued" : i < 5 ? "done" : "queued") as "queued" | "done", attempts: 0, nextAt: null, error: null, note: null, payload: i >= 5 ? { unverified: true } : {} }));
    expect(trimQueue(items, 3).map((x) => x.id)).toEqual(["x0", "x8", "x9"]);
  });

  test("an unknown signing key makes day2 fetch Google's keys once more (rate-limited)", async () => {
    let fetches = 0;
    let keys: unknown = { keys: [] };
    deps.fetch = (async () => (fetches++, new Response(JSON.stringify(keys), { headers: { "cache-control": "max-age=600" } }))) as unknown as typeof fetch;
    const body = pubsubPush("k1", note({ testNotification: {} }));
    expect((await receiveGoogle("a1", auth(), body, deps)).status).toBe(401); // keys rotated: not in the (empty) set
    expect(fetches).toBe(2);
    keys = googleJwks;
    // Within the rate limit: no refetch.
    expect((await receiveGoogle("a1", auth(), body, deps)).status).toBe(401);
    expect(fetches).toBe(2);
    const later = { ...deps, now: new Date(NOW.getTime() + 6 * 60_000) };
    const fresh = `Bearer ${googleOidc({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, exp: Math.floor(later.now.getTime() / 1000) + 600 })}`;
    expect((await receiveGoogle("a1", fresh, body, later)).status).toBe(204);
    expect(fetches).toBe(3);
  });
});
