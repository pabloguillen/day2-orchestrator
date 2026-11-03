import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { appleTrial, createAppleCatalog, FIRST_PURCHASE_TODO } from "./catalog-apple";
import { createGoogleCatalog, gMoney } from "./catalog-google";
import type { GoogleClient } from "./google-play";
import { applyProducts, decideProduct, planProducts, productIdFor } from "./products";
import { emptyMoney, type Product, type ProductPlan } from "./types";

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const asc = { issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", keyId: "ABCDEFGHIJ", privateKey: ec };
const NOW = new Date("2026-11-03T12:00:00Z");

type Call = { method: string; path: string; body: Record<string, unknown> | null };
function router(routes: Array<[RegExp, (c: Call) => unknown]>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const c: Call = { method: init.method ?? "GET", path: `${u.pathname}${u.search}`, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    for (const [re, h] of routes) if (re.test(`${c.method} ${c.path}`)) return new Response(JSON.stringify(h(c) ?? {}), { status: 200 });
    return new Response(JSON.stringify({ errors: [{ status: "404", detail: `no route ${c.method} ${c.path}` }] }), { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const plan = (over: Partial<ProductPlan> = {}): ProductPlan => ({
  key: "pro_monthly",
  kind: "subscription",
  name: "Dotty Pro",
  description: "Alle Pinsel und Farben",
  period: "P1M",
  trialDays: 7,
  tier: 1,
  base: { region: "DE", amount: 4.99, currency: "EUR" },
  regional: [{ region: "US", amount: 4.99, currency: "USD" }],
  why: "Leaders sell a monthly plan with a week's trial.",
  ...over,
});

function product(over: Partial<ProductPlan> = {}): Product {
  const f = planProducts(emptyMoney(), [plan(over)], { idBase: "de.dotty.app", stores: { ios: true, android: true }, approval: { state: "approved", by: "Pablo", at: NOW.toISOString() }, now: NOW });
  return f.added[0]!;
}

describe("product ids and plans", () => {
  test("ids are fixed per version; a new price is a new product", () => {
    expect(productIdFor("de.Dotty-App", "Pro Monthly", 2)).toBe("de.dotty_app.pro_monthly.v2");
    let f = emptyMoney();
    const o = { idBase: "de.dotty.app", stores: { ios: true, android: false }, approval: { state: "waiting" as const, by: null, at: null }, now: NOW };
    const a = planProducts(f, [plan()], o);
    f = a.file;
    expect(a.added[0]).toMatchObject({ productId: "de.dotty.app.pro_monthly.v1", ios: { state: "waiting" }, android: { state: "skipped" } });
    expect(planProducts(f, [plan()], o).added).toHaveLength(0);
    const b = planProducts(f, [plan({ base: { region: "DE", amount: 5.99, currency: "EUR" } })], o);
    expect(b.added[0]!.productId).toBe("de.dotty.app.pro_monthly.v2");
  });

  test("price changes wait for the owner unless prices are automatic", () => {
    const o = { idBase: "x", stores: { ios: true, android: true }, approval: { state: "waiting" as const, by: null, at: null }, now: NOW };
    let f = planProducts(emptyMoney(), [plan()], o).file;
    f = decideProduct(f, "x.pro_monthly.v1", true, "Pablo", NOW);
    expect(f.products[0]!.approval).toMatchObject({ state: "approved", by: "Pablo" });
    expect(f.log[0]!.text).toContain("approved Dotty Pro at 4.99 EUR");
  });
});

describe("App Store Connect", () => {
  const pricePoints = (c: Call) => ({ data: c.path.endsWith("USA&limit=8000") ? [{ id: "pp-us-499", type: "subscriptionPricePoints", attributes: { customerPrice: "4.99" } }] : [{ id: "pp-de-449", type: "subscriptionPricePoints", attributes: { customerPrice: "4.49" } }, { id: "pp-de-499", type: "subscriptionPricePoints", attributes: { customerPrice: "4.99" } }] });

  test("a subscription: group, product, localization, availability, equalized prices with regional overrides, and a free trial", async () => {
    const { f, calls } = router([
      [/^GET \/v1\/apps\?filter/, () => ({ data: [{ id: "app1", type: "apps" }] })],
      [/^GET \/v1\/apps\/app1\/subscriptionGroups/, () => ({ data: [] })],
      [/^POST \/v1\/subscriptionGroups$/, () => ({ data: { id: "g1", type: "subscriptionGroups" } })],
      [/^GET \/v1\/subscriptionGroups\/g1\/subscriptions/, () => ({ data: [] })],
      [/^POST \/v1\/subscriptions$/, () => ({ data: { id: "s1", type: "subscriptions" } })],
      [/^GET \/v1\/territories/, () => ({ data: [{ id: "DEU" }, { id: "USA" }, { id: "AUT" }] })],
      [/^GET \/v1\/subscriptions\/s1\/pricePoints/, pricePoints],
      [/^GET \/v1\/subscriptionPricePoints\/pp-de-499\/equalizations/, () => ({ data: [{ id: "pp-at-499", relationships: { territory: { data: { type: "territories", id: "AUT" } } } }, { id: "pp-us-599", relationships: { territory: { data: { type: "territories", id: "USA" } } } }] })],
      [/^GET \/v1\/subscriptions\/s1$/, () => ({ data: { id: "s1", attributes: { state: "MISSING_METADATA" } } })],
      [/^POST /, () => ({ data: { id: "x" } })],
    ]);
    const side = await createAppleCatalog(asc, { fetch: f, now: () => NOW }).ensure(product(), { bundleId: "de.dotty.app", locale: "de-DE", groupName: "Dotty subscriptions", firstPurchase: true });
    expect(side).toMatchObject({ state: "created", ref: "s1", group: "g1", offer: "ONE_WEEK", status: "MISSING_METADATA" });
    expect(side.todo).toContain(FIRST_PURCHASE_TODO);
    const sub = calls.find((c) => c.path === "/v1/subscriptions" && c.method === "POST")!.body as { data: { attributes: Record<string, unknown> } };
    expect(sub.data.attributes).toMatchObject({ productId: "de.dotty.app.pro_monthly.v1", subscriptionPeriod: "ONE_MONTH", groupLevel: 1 });
    const prices = calls.filter((c) => c.path === "/v1/subscriptionPrices").map((c) => (c.body as { data: { relationships: { territory: { data: { id: string } }; subscriptionPricePoint: { data: { id: string } } } } }).data.relationships);
    expect(Object.fromEntries(prices.map((p) => [p.territory.data.id, p.subscriptionPricePoint.data.id]))).toEqual({ DEU: "pp-de-499", AUT: "pp-at-499", USA: "pp-us-499" });
    const trials = calls.filter((c) => c.path === "/v1/subscriptionIntroductoryOffers");
    expect(trials).toHaveLength(3);
    expect((trials[0]!.body as { data: { attributes: Record<string, unknown> } }).data.attributes).toMatchObject({ offerMode: "FREE_TRIAL", duration: "ONE_WEEK", numberOfPeriods: 1 });
    expect(calls.every((c) => !JSON.stringify(c.body ?? {}).includes("PRIVATE KEY"))).toBe(true);
  });

  test("an existing product is found again instead of created twice", async () => {
    const { f, calls } = router([
      [/^GET \/v1\/apps\?filter/, () => ({ data: [{ id: "app1" }] })],
      [/^GET \/v1\/apps\/app1\/subscriptionGroups/, () => ({ data: [{ id: "g1", attributes: { referenceName: "Dotty subscriptions" } }] })],
      [/^GET \/v1\/subscriptionGroups\/g1\/subscriptions/, () => ({ data: [{ id: "s9", attributes: { productId: "de.dotty.app.pro_monthly.v1" } }] })],
      [/^GET \/v1\/subscriptions\/s9$/, () => ({ data: { id: "s9", attributes: { state: "READY_TO_SUBMIT" } } })],
    ]);
    const side = await createAppleCatalog(asc, { fetch: f, now: () => NOW }).ensure(product(), { bundleId: "de.dotty.app", locale: "de-DE", groupName: "Dotty subscriptions", firstPurchase: false });
    expect(side).toMatchObject({ ref: "s9", status: "READY_TO_SUBMIT" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a consumable: inAppPurchasesV2 with a price schedule from the base territory", async () => {
    const { f, calls } = router([
      [/^GET \/v1\/apps\?filter/, () => ({ data: [{ id: "app1" }] })],
      [/^GET \/v1\/apps\/app1\/inAppPurchasesV2/, () => ({ data: [] })],
      [/^POST \/v2\/inAppPurchases$/, () => ({ data: { id: "i1" } })],
      [/^GET \/v2\/inAppPurchases\/i1\/pricePoints/, () => ({ data: [{ id: "ip-199", attributes: { customerPrice: "1.99" } }] })],
      [/^GET \/v1\/territories/, () => ({ data: [{ id: "DEU" }] })],
      [/^GET \/v2\/inAppPurchases\/i1$/, () => ({ data: { id: "i1", attributes: { state: "MISSING_METADATA" } } })],
      [/^POST /, () => ({ data: { id: "x" } })],
    ]);
    const p = product({ key: "brushes", kind: "consumable", period: undefined, trialDays: null, base: { region: "DE", amount: 1.99, currency: "EUR" }, regional: [] });
    await createAppleCatalog(asc, { fetch: f, now: () => NOW }).ensure(p, { bundleId: "de.dotty.app", locale: "de-DE", groupName: "x", firstPurchase: false });
    expect((calls.find((c) => c.path === "/v2/inAppPurchases")!.body as { data: { attributes: Record<string, unknown> } }).data.attributes.inAppPurchaseType).toBe("CONSUMABLE");
    const sched = calls.find((c) => c.path === "/v1/inAppPurchasePriceSchedules")!.body as { data: { relationships: { baseTerritory: { data: { id: string } } } }; included: Array<{ relationships: { inAppPurchasePricePoint: { data: { id: string } } } }> };
    expect(sched.data.relationships.baseTerritory.data.id).toBe("DEU");
    expect(sched.included[0]!.relationships.inAppPurchasePricePoint.data.id).toBe("ip-199");
  });

  test("a price that isn't an Apple price point is refused with a plain reason", async () => {
    const { f } = router([
      [/^GET \/v1\/apps\?filter/, () => ({ data: [{ id: "app1" }] })],
      [/^GET \/v1\/apps\/app1\/subscriptionGroups/, () => ({ data: [{ id: "g1", attributes: { referenceName: "G" } }] })],
      [/^GET \/v1\/subscriptionGroups\/g1\/subscriptions/, () => ({ data: [] })],
      [/^POST \/v1\/subscriptions$/, () => ({ data: { id: "s1" } })],
      [/^GET \/v1\/territories/, () => ({ data: [{ id: "DEU" }] })],
      [/^GET \/v1\/subscriptions\/s1\/pricePoints/, () => ({ data: [{ id: "a", attributes: { customerPrice: "4.99" } }] })],
      [/^POST /, () => ({ data: { id: "x" } })],
    ]);
    await expect(createAppleCatalog(asc, { fetch: f, now: () => NOW }).ensure(product({ base: { region: "DE", amount: 4.37, currency: "EUR" } }), { bundleId: "de.dotty.app", locale: "de-DE", groupName: "G", firstPurchase: false })).rejects.toThrow(/isn't one of Apple's price points/);
  });

  test("trial lengths map to Apple's durations", () => {
    expect([3, 5, 7, 14, 30, 0].map(appleTrial)).toEqual(["THREE_DAYS", "ONE_WEEK", "ONE_WEEK", "TWO_WEEKS", "ONE_MONTH", null]);
  });
});

describe("Google Play", () => {
  function client(handlers: Array<[RegExp, (body: unknown) => unknown]>) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const c: GoogleClient = {
      async call<T>(url: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}) {
        const u = new URL(url);
        for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v);
        const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
        calls.push({ method, url: u.pathname + u.search, body: init.body });
        for (const [re, h] of handlers) if (re.test(`${method} ${u.pathname}`)) return h(init.body) as T;
        const { GoogleError } = await import("./google-play");
        throw new GoogleError("404 not found", 404);
      },
    };
    return { c, calls };
  }

  test("a subscription with a base plan priced in every region and an activated trial offer", async () => {
    const { c, calls } = client([
      [/pricing:convertRegionPrices$/, () => ({ convertedRegionPrices: { US: { regionCode: "US", price: gMoney(5.49, "USD") }, AT: { regionCode: "AT", price: gMoney(4.99, "EUR") } } })],
      [/^POST .*\/subscriptions$/, (b) => b],
      [/:activate$/, () => ({})],
      [/\/offers$/, (b) => b],
    ]);
    const side = await createGoogleCatalog(c).ensure(product(), { packageName: "de.dotty.app", locale: "de-DE" });
    expect(side).toMatchObject({ state: "created", ref: "de.dotty.app.pro_monthly.v1", group: "monthly", offer: "trial-7d" });
    const create = calls.find((x) => x.method === "POST" && x.url.includes("/subscriptions?"))!;
    expect(create.url).toContain("productId=de.dotty.app.pro_monthly.v1");
    const bp = (create.body as { basePlans: Array<{ autoRenewingBasePlanType: { billingPeriodDuration: string }; regionalConfigs: Array<{ regionCode: string; price: { units: string; nanos: number; currencyCode: string } }> }> }).basePlans[0]!;
    expect(bp.autoRenewingBasePlanType.billingPeriodDuration).toBe("P1M");
    // The strategy's US price wins over Google's conversion.
    expect(Object.fromEntries(bp.regionalConfigs.map((r) => [r.regionCode, `${r.price.units}.${String(r.price.nanos).slice(0, 2)} ${r.price.currencyCode}`]))).toEqual({ US: "4.99 USD", AT: "4.99 EUR", DE: "4.99 EUR" });
    expect(calls.filter((x) => x.url.endsWith(":activate")).map((x) => x.url)).toEqual([
      "/androidpublisher/v3/applications/de.dotty.app/subscriptions/de.dotty.app.pro_monthly.v1/basePlans/monthly:activate",
      "/androidpublisher/v3/applications/de.dotty.app/subscriptions/de.dotty.app.pro_monthly.v1/basePlans/monthly/offers/trial-7d:activate",
    ]);
    const offer = calls.find((x) => x.url.includes("/offers?"))!.body as { phases: Array<{ duration: string; regionalConfigs: Array<{ free: object }> }> };
    expect(offer.phases[0]!.duration).toBe("P7D");
  });

  test("a one-time product with auto-converted prices", async () => {
    const { c, calls } = client([[/^POST .*\/inappproducts$/, (b) => b]]);
    await createGoogleCatalog(c).ensure(product({ key: "unlock", kind: "one_time", period: undefined, trialDays: null, base: { region: "DE", amount: 9.99, currency: "EUR" }, regional: [] }), { packageName: "de.dotty.app", locale: "de-DE" });
    const b = calls.find((x) => x.method === "POST")!;
    expect(b.url).toContain("autoConvertMissingPrices=true");
    expect(b.body).toMatchObject({ sku: "de.dotty.app.unlock.v1", purchaseType: "managedUser", defaultPrice: { priceMicros: "9990000", currency: "EUR" } });
  });
});

describe("applying products", () => {
  test("only approved products are created; a store failure is kept and retried", async () => {
    let f = planProducts(emptyMoney(), [plan()], { idBase: "de.dotty.app", stores: { ios: true, android: true }, approval: { state: "approved", by: "o", at: null }, now: NOW }).file;
    f = planProducts(f, [plan({ key: "yearly", period: "P1Y" })], { idBase: "de.dotty.app", stores: { ios: true, android: true }, approval: { state: "waiting", by: null, at: null }, now: NOW }).file;
    const made: string[] = [];
    const r = await applyProducts(f, {
      apple: { ensure: async (p) => (made.push(`ios:${p.key}`), { state: "created", ref: "s1" }), state: async () => null, reviewScreenshot: async () => {} },
      google: { ensure: async () => Promise.reject(new Error("Google: 403 The caller does not have permission")), state: async () => null },
      bundleId: "de.dotty.app",
      packageName: "de.dotty.app",
      locale: "de-DE",
      groupName: "G",
      now: NOW,
    });
    expect(made).toEqual(["ios:pro_monthly"]);
    expect(r.created).toEqual(["de.dotty.app.pro_monthly.v1 (App Store)"]);
    expect(r.file.products[0]!.android).toMatchObject({ state: "failed", error: "Google: 403 The caller does not have permission" });
    expect(r.file.products[1]!.ios.state).toBe("waiting");
  });
});
