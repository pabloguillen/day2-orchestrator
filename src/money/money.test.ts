import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { emptyBacklog, saveBacklog, withBacklog } from "../backlog";
import { backlogFile } from "../backlog-work";
import type { FieldStore } from "../field-store";
import { setRatesForTest } from "../ads/fx";
import type { EventLike } from "../metrics/types";
import type { AppProfile } from "../onboarding";
import { changesFor, disclosure, practicesFrom } from "../store-privacy";
import { LIVE_CONTRIBUTORS } from "../live/contributors";
import { registeredNeeds } from "../live/native-foundations";
import { liveConfigPart } from "./config";
import { checkAdMobIds, checkIap, connectionViews } from "./connections";
import { adRevenueRecords, computeKpis } from "./kpis";
import { fileMoneyLedger, type MoneyRecord } from "./ledger";
import { adTest, decideTest, nextTest, storePrice, syncTests, type LiveExperimentsPort } from "./offer-tests";
import { adoptStrategy, moneyPass } from "./pass";
import { buildStrategyPrompt, capFor, decideStrategy, minorsHint, parseStrategy, propose, strategyDue, withGuardrails, type ParsedStrategy, type StrategyInput } from "./strategy";
import { ADS_ATT_KEY, ADS_KEY, PAYWALL_KEY, PURCHASES_KEY, ticketsFor } from "./tickets";
import { currentStrategy, emptyMoney, type MoneyFile, type Strategy } from "./types";
import { loadAppMoney, saveAppMoney, serverBatches } from "./wiring";
import { fileFieldStore } from "../field-store";

const NOW = new Date("2026-11-03T12:00:00Z");
const DAY = 86_400_000;

const answer = (o: Record<string, unknown> = {}) =>
  `I looked at the leaders.\nMONEY_STRATEGY_JSON:\n${JSON.stringify({
    category: "drawing apps for young people",
    verdict: "monetize",
    summary: "A monthly and a yearly plan with a 7-day trial, plus rewarded ads for extra stickers.",
    minors: false,
    models: ["subscription", "rewarded_ads", "lottery"],
    leaders: [
      { app: "Procreate Pocket", model: "one-time", example: "Sold once for 5.99", source: "https://apps.apple.com/app/procreate-pocket/id916366645" },
      { app: "Ibis Paint", model: "subscription + ads", example: "Prime membership monthly", source: "https://ibispaint.com/prime" },
      { app: "Uncited", model: "x", example: "y", source: "not a url" },
    ],
    products: [
      { key: "Pro Monthly", kind: "subscription", name: "Dotty Pro", description: "Alle Pinsel", period: "P1M", trialDays: 7, tier: 1, price: 4.99, regional: [{ region: "US", amount: 4.99, currency: "USD" }, { region: "DE", amount: 1, currency: "EUR" }], why: "Leaders' main plan" },
      { key: "pro_yearly", kind: "subscription", name: "Dotty Pro Jahr", description: "Alle Pinsel, ein Jahr", period: "P1Y", trialDays: 60, price: 29.99, regional: [] },
      { key: "bad", kind: "subscription", name: "x", period: "P5D", price: 3 },
      { key: "free", kind: "one_time", name: "x", price: 0 },
    ],
    paywalls: [{ placement: "after_third_drawing", trigger: "after the third finished drawing", title: "Mehr Pinsel", subtitle: "Teste 7 Tage gratis", bullets: ["Alle Pinsel"], products: ["pro_monthly", "pro_yearly", "missing"], highlight: "pro_yearly", cta: "Gratis testen" }],
    ads: [
      { id: "extra_stickers", format: "rewarded", where: "sticker shop", cap: { perSession: 20, perDay: 50, minSecondsBetween: 5 } },
      { id: "between_levels", format: "interstitial", where: "between canvases", cap: {} },
    ],
    avoid: ["No ads while drawing"],
    ...o,
  })}`;

const parse = (o: Record<string, unknown> = {}) => parseStrategy(answer(o), { currency: "EUR", baseRegion: "DE" })!;

describe("strategy", () => {
  test("parses only cited leaders, known models, valid products, and paywalls with real products", () => {
    const s = parse();
    expect(s.leaders.map((l) => l.app)).toEqual(["Procreate Pocket", "Ibis Paint"]);
    expect(s.models).toEqual(["subscription", "rewarded_ads"]);
    expect(s.products.map((p) => p.key)).toEqual(["pro_monthly", "pro_yearly"]);
    expect(s.products[0]).toMatchObject({ base: { region: "DE", amount: 4.99, currency: "EUR" }, regional: [{ region: "US", amount: 4.99, currency: "USD" }], trialDays: 7 });
    expect(s.products[1]!.trialDays).toBeNull();
    expect(s.paywalls[0]).toMatchObject({ products: ["pro_monthly", "pro_yearly"], highlight: "pro_yearly" });
    // Caps are never looser than day2's.
    expect(s.ads[0]!.cap).toEqual({ perSession: 5, perDay: 12, minSecondsBetween: 30 });
    expect(capFor("interstitial", {})).toEqual({ perSession: 2, perDay: 6, minSecondsBetween: 180 });
  });

  test("nothing cited, nothing proposed", () => {
    expect(parseStrategy(answer({ leaders: [] }), { currency: "EUR", baseRegion: "DE" })).toBeNull();
    expect(parseStrategy("no marker", { currency: "EUR", baseRegion: "DE" })).toBeNull();
  });

  test("guardrails: no full-screen ads in the first session; with minors no interstitials and no tracking", () => {
    const g = withGuardrails(parse(), { minorsHint: false });
    expect(g.ads.find((a) => a.id === "between_levels")!.notInFirstSession).toBe(true);
    expect(g.avoid).toContain("No full-screen ads in a user's first session.");
    const m = withGuardrails(parse(), { minorsHint: minorsHint("Schüler und Jugendliche") });
    expect(m.minors).toBe(true);
    expect(m.ads.map((a) => a.id)).toEqual(["extra_stickers"]);
    expect(m.avoid.some((a) => /non-personalized/.test(a))).toBe(true);
    expect(minorsHint("Designers at work")).toBe(false);
  });

  test("the prompt is grounded in the app and asks for citations", () => {
    const input: StrategyInput = { appName: "Dotty", purpose: "Draw dot art", targetUsers: "young people", featureMap: "canvas", businessModel: null, brandBrief: "", users: 120, rhythm: "weekly", d7: 0.31, currency: "EUR", baseRegion: "DE", existing: [], minorsHint: false, excerpts: [{ file: "src/Shop.tsx", text: "export function Shop" }] };
    const p = buildStrategyPrompt(input);
    expect(p).toContain("120 identified users");
    expect(p).toContain("31% of new users");
    expect(p).toContain("Cite a real source");
    expect(p).toContain("src/Shop.tsx");
  });

  test("proposal → owner's decision; due again after 60 days or 5× the users", () => {
    let f = emptyMoney();
    expect(strategyDue(f, 0, NOW)).toBe(true);
    const r = propose(f, withGuardrails(parse(), { minorsHint: false }), { users: 40, rhythm: "weekly", credits: 12, now: NOW });
    f = r.file;
    expect(strategyDue(f, 1000, NOW)).toBe(false); // waits for the owner
    f = decideStrategy(f, r.strategy.id, true, "Pablo", NOW).file;
    expect(currentStrategy(f)).toMatchObject({ status: "approved", decidedBy: "Pablo" });
    expect(strategyDue(f, 100, new Date(NOW.getTime() + DAY))).toBe(false);
    expect(strategyDue(f, 200, new Date(NOW.getTime() + DAY))).toBe(true);
    expect(strategyDue(f, 40, new Date(NOW.getTime() + 61 * DAY))).toBe(true);
  });
});

function approved(minors = false): { file: MoneyFile; strategy: Strategy } {
  const p = propose(emptyMoney(), withGuardrails(parse(minors ? { minors: true } : {}), { minorsHint: false }), { users: 40, rhythm: "weekly", credits: 12, now: NOW });
  const d = decideStrategy(p.file, p.strategy.id, true, "Pablo", NOW);
  return { file: adoptStrategy(d.file, d.strategy!, { idBase: "de.dotty.app", stores: { ios: true, android: true }, now: NOW }), strategy: d.strategy! };
}

const created = (f: MoneyFile): MoneyFile => ({ ...f, products: f.products.map((p) => ({ ...p, ios: { state: "created" }, android: { state: "created", offer: "trial-7d" } })) });

describe("approved strategy → products, config, tickets", () => {
  test("approving makes approved products; config shows only what's in the stores", () => {
    const { file } = approved();
    expect(file.products.map((p) => [p.productId, p.approval.state])).toEqual([
      ["de.dotty.app.pro_monthly.v1", "approved"],
      ["de.dotty.app.pro_yearly.v1", "approved"],
    ]);
    expect(liveConfigPart(file).values?.["paywall.after_third_drawing"]).toBeUndefined();
    const part = liveConfigPart(created(file));
    expect(part.values?.["paywall.after_third_drawing"]).toMatchObject({ title: "Mehr Pinsel", cta: "Gratis testen", highlight: "de.dotty.app.pro_yearly.v1", layout: "list" });
    expect(part.values?.["money.products"]).toHaveLength(2);
    // Ads without unit ids stay off.
    expect(part.ads?.extra_stickers).toMatchObject({ format: "rewarded", enabled: false });
    expect(part.values?.["money.ads"]).toMatchObject({ nonPersonalized: false, notInFirstSession: ["extra_stickers", "between_levels"] });
  });

  test("with minors: non-personalized and tagged ads", () => {
    const part = liveConfigPart(created(approved(true).file));
    expect(part.values?.["money.ads"]).toMatchObject({ nonPersonalized: true, tagForUnderAgeOfConsent: true, maxAdContentRating: "T" });
    expect(part.ads?.between_levels).toBeUndefined();
  });

  test("tickets: purchases, paywall, ads (with the tracking prompt only without minors); none twice; none for RevenueCat apps' purchases", () => {
    const { file, strategy } = approved();
    const t = ticketsFor(file, strategy, { haveKeys: new Set(), usesRevenueCat: false });
    expect(t.map((x) => x.source.key)).toEqual([PURCHASES_KEY, PAYWALL_KEY, ADS_ATT_KEY]);
    expect(t[0]!.description).toContain("appAccountToken: day2.purchaseToken()");
    expect(t[0]!.description).toContain("obfuscatedAccountIdAndroid");
    expect(t[1]!.description).toContain("paywall.<placement>");
    expect(t[2]!.description).toContain("canRequestAds");
    expect(t[2]!.description).toContain("TestIds");
    expect(ticketsFor(file, strategy, { haveKeys: new Set([PURCHASES_KEY, PAYWALL_KEY, ADS_ATT_KEY]), usesRevenueCat: false })).toHaveLength(0);
    expect(ticketsFor(file, strategy, { haveKeys: new Set(), usesRevenueCat: true }).map((x) => x.source.key)).not.toContain(PURCHASES_KEY);
    const m = approved(true);
    expect(ticketsFor(m.file, m.strategy, { haveKeys: new Set(), usesRevenueCat: false }).at(-1)!.source.key).toBe(ADS_KEY);
  });

  test("Money's contributor and native needs are registered with Live's extension points", () => {
    expect(LIVE_CONTRIBUTORS.map((c) => c.module)).toContain("money");
    expect(registeredNeeds().flatMap((n) => n.packages)).toEqual(expect.arrayContaining(["expo-iap", "react-native-google-mobile-ads"]));
  });
});

describe("tests of offers", () => {
  const port = (): LiveExperimentsPort & { started: string[] } => {
    const started: string[] = [];
    return {
      started,
      async start(_a, spec) {
        started.push(spec.name);
        return { id: `X-${started.length}` };
      },
      async result(_a, id) {
        return id === "X-1" ? { state: "decided", winner: "control", note: "No difference in revenue per user; kept the current one." } : { state: "running", winner: null, note: "" };
      },
    };
  };
  const app = { id: "a1", name: "Dotty", repoPath: "/tmp", connectionMethod: "local_path", addedAt: "" } as AppEntry;

  test("layout first (config only, day2 decides), then a price test that waits for the owner", async () => {
    let f = created(approved().file);
    let n = nextTest(f, { idBase: "de.dotty.app", stores: { ios: true, android: true }, now: NOW })!;
    expect(n.test).toMatchObject({ kind: "paywall_layout", state: "proposed", primary: "revenue_per_user", guardrails: ["d7_retention", "crash_rate"] });
    expect(n.test.variants[1]!.values["paywall.after_third_drawing"]).toMatchObject({ layout: "cards" });
    f = { ...n.file, tests: [{ ...n.test, state: "decided" }] };
    n = nextTest(f, { idBase: "de.dotty.app", stores: { ios: true, android: true }, now: NOW })!;
    expect(n.test.kind).toBe("trial_length");
    f = { ...n.file, tests: [{ ...n.test, state: "decided" }, ...f.tests] };
    n = nextTest(f, { idBase: "de.dotty.app", stores: { ios: true, android: true }, now: NOW })!;
    expect(n.test).toMatchObject({ kind: "price", state: "waiting_approval" });
    const variant = n.file.products.find((p) => p.test?.experimentId === n.test.id)!;
    expect(variant).toMatchObject({ productId: "de.dotty.app.pro_yearly.v3", base: { amount: 38.99 }, approval: { state: "waiting" } });
    expect(n.test.variants[1]!.values["paywall.after_third_drawing"]).toMatchObject({ highlight: variant.productId });
    // Approving the test approves its products; Live starts it only once they're in the stores.
    f = decideTest({ ...n.file, tests: [n.test, ...f.tests] }, n.test.id, true, "Pablo", NOW);
    expect(f.products.find((p) => p.productId === variant.productId)!.approval.state).toBe("approved");
    const p = port();
    let s = await syncTests(app, f, p, NOW);
    expect(s.started).toEqual([]);
    s = await syncTests(app, created(f), p, NOW);
    expect(s.started).toEqual([n.test.id]);
    s = await syncTests(app, s.file, p, NOW);
    expect(s.decided).toEqual([n.test.id]);
    // Control won: the variant's product isn't offered any more.
    expect(s.file.products.find((x) => x.productId === variant.productId)!.retiredAt).toBe(NOW.toISOString());
    expect(storePrice(4.99 * 1.3)).toBe(5.99);
  });

  test("ad tests override the placement through config", () => {
    const f = approved().file;
    const t = adTest(f, { ...f.ads[0]!, unitId: { ios: "ca-app-pub-1234567890123456/1234567890" } }, "ad_frequency", NOW);
    expect(t.keys).toEqual(["ads.extra_stickers"]);
    expect(t.variants[1]!.values["ads.extra_stickers"]).toEqual({ enabled: true, cap: { perSession: 2, perDay: 6, minSecondsBetween: 60 } });
  });
});

describe("KPIs", () => {
  setRatesForTest({ USD: 1, EUR: 0.9 });
  afterAll(() => setRatesForTest(null));
  const rec = (o: Partial<MoneyRecord>): MoneyRecord => ({ id: Math.random().toString(36), store: "apple", type: "purchase_verified", kind: "subscription", productId: "p", at: new Date(NOW.getTime() - 5 * DAY).toISOString(), amount: 4.99, currency: "EUR", user: "u1", variants: {}, source: null, chain: "c1", sandbox: false, expiresAt: null, ...o });

  test("revenue by source, per user, ARPPU, conversion, trials, refunds, by variant and source — in the app's currency", () => {
    const records = [
      rec({ type: "trial_started", amount: 0, at: new Date(NOW.getTime() - 12 * DAY).toISOString() }),
      rec({ type: "renewal", expiresAt: new Date(NOW.getTime() + 20 * DAY).toISOString(), variants: { "X-1": "cards" } }),
      rec({ user: "u2", chain: "c2", type: "trial_started", amount: 0, at: new Date(NOW.getTime() - 10 * DAY).toISOString() }),
      rec({ user: "u3", chain: null, kind: "purchase", amount: 9.99, currency: "USD" }),
      rec({ user: "u3", chain: null, kind: "purchase", type: "refund", amount: 9.99, currency: "USD" }),
      rec({ user: "u4", store: "device", kind: "ad", type: "ad_revenue", amount: 0.02, chain: null }),
      rec({ user: "u5", amount: 99, sandbox: true }),
    ];
    const users = ["u1", "u2", "u3", "u4", "u6"].map((u, i) => ({ user: u, variants: u === "u1" ? { "X-1": "cards" } : u === "u2" ? { "X-1": "control" } : {}, source: i % 2 ? "meta" : null }));
    const k = computeKpis({ records, users, currency: "EUR", days: 30, now: NOW });
    expect(k.revenue).toEqual({ total: 14.0, subscriptions: 4.99, purchases: 8.99, ads: 0.02, refunds: 8.99 });
    expect(k.users).toBe(5);
    expect(k.payers).toBe(2);
    expect(k.revenuePerUser).toBe(1);
    expect(k.conversionToPaid).toBe(0.4);
    expect(k.trialConversion).toBe(0.5);
    expect(k.refundRate).toBe(0.5);
    expect(k.activeSubscriptions).toBe(1);
    expect(k.byVariant).toEqual([
      { experiment: "X-1", variant: "cards", users: 1, revenuePerUser: 4.99 },
      { experiment: "X-1", variant: "control", users: 1, revenuePerUser: 0 },
    ]);
    expect(k.bySource.find((s) => s.source === "meta")).toMatchObject({ users: 2, revenue: 0.02 });
  });

  test("ad revenue from the app's paid events (once events carry value)", () => {
    const e = { type: "revenue", at: NOW.toISOString(), deviceId: "d", userId: "u1", value: { amount: 0.012, currency: "EUR" }, props: { kind: "ad", placement: "extra_stickers" } } as EventLike;
    const [r] = adRevenueRecords([e, { type: "revenue", at: NOW.toISOString(), deviceId: "d" }]);
    expect(r).toMatchObject({ type: "ad_revenue", kind: "ad", amount: 0.012, productId: "extra_stickers", user: "u1" });
    expect(adRevenueRecords([e])[0]!.id).toBe(r!.id);
  });
});

describe("server events for Live", () => {
  test("verified purchases, renewals and refunds as events with value; not counted as activity", async () => {
    const base = { store: "apple" as const, kind: "subscription" as const, productId: "p", at: NOW.toISOString(), currency: "EUR", user: "u1", variants: { "X-2": "cards" }, source: null, chain: "c", sandbox: false, expiresAt: null };
    const b = serverBatches([
      { ...base, id: "1", type: "purchase_verified", amount: 4.99 },
      { ...base, id: "2", type: "renewal", amount: 4.99 },
      { ...base, id: "3", type: "refund", amount: 4.99 },
      { ...base, id: "4", type: "cancellation", amount: 0 },
      { ...base, id: "5", type: "renewal", amount: 4.99, sandbox: true },
    ]);
    expect(b.map((x) => x.events[0]!.type)).toEqual(["purchase_verified", "revenue", "refund"]);
    expect(b[1]).toMatchObject({ variants: { "X-2": "cards" }, events: [{ value: { amount: 4.99, currency: "EUR" }, props: { by: "store", kind: "subscription" } }] });
    const dir = mkdtempSync(join(tmpdir(), "money-field-"));
    const fs = fileFieldStore(dir);
    for (const x of b) await fs.record("a", x, NOW);
    expect((await fs.activity("a", "2026-01-01")).users).toHaveLength(0);
    expect((await fs.events("a", new Date(0))).map((e) => e.type)).toEqual(["purchase_verified", "revenue", "refund"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("store privacy", () => {
  const done = (key: string) => ({ source: { kind: "day2_proposal", key }, state: "done" }) as never;
  test("purchases and ads add their data types; tracking only with the prompt", () => {
    const p = practicesFrom([done("day2:field-install"), done(PURCHASES_KEY), done(ADS_KEY)], { adConversions: "off", deviceId: false });
    expect(p).toMatchObject({ purchases: true, ads: true });
    expect(p.adTracking).toBeUndefined();
    const d = disclosure(p);
    expect(d.ios.rows.find((r) => r.type === "Purchase History")).toMatchObject({ category: "Purchases", tracking: false });
    expect(d.ios.rows.find((r) => r.type === "Coarse Location")).toMatchObject({ purposes: ["Third-Party Advertising", "Analytics"], tracking: false });
    expect(d.ios.trackingPrompt).toBe(false);
    expect(d.android.rows.find((r) => r.type === "Purchase history")).toMatchObject({ category: "Financial info", shared: false });
    const t = disclosure({ ...p, adTracking: true });
    expect(t.ios.trackingPrompt).toBe(true);
    expect(t.ios.rows.find((r) => r.type === "Device ID")!.tracking).toBe(true);
    expect(changesFor("ios", null, p).some((s) => s.includes("Purchases → Purchase History"))).toBe(true);
  });
});

describe("connections", () => {
  test("AdMob ids are checked", () => {
    expect(checkAdMobIds({ appId: { ios: "ca-app-pub-1234567890123456~1234567890" }, units: { a: { android: "ca-app-pub-1234567890123456/1234567890" } } })).toBeNull();
    expect(checkAdMobIds({ appId: { ios: "ca-app-pub-1234567890123456/1234567890" } })).toMatch(/with a ~/);
    expect(checkAdMobIds({ units: { a: { ios: "nope" } } })).toMatch(/“a”/);
  });

  test("the In-App Purchase key is tried with Apple before it's kept", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const cred = { issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", keyId: "ABCDEFGHIJ", privateKey };
    let auth = "";
    const f = (status: number) =>
      (async (_u: string, init: RequestInit) => {
        auth = String((init.headers as Record<string, string>).authorization);
        return new Response("{}", { status });
      }) as unknown as typeof fetch;
    expect(await checkIap(cred, "de.dotty.app", f(404))).toEqual({ ok: true, who: "In-App Purchase key for de.dotty.app" });
    const claims = JSON.parse(Buffer.from(auth.split(" ")[1]!.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ iss: cred.issuerId, aud: "appstoreconnect-v1", bid: "de.dotty.app" });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);
    expect((await checkIap(cred, "de.dotty.app", f(401))).ok).toBe(false);
    expect((await checkIap(cred, null, f(404))).ok).toBe(false);
  });

  test("walkthroughs for what the owner does once", () => {
    const v = connectionViews(approved().file, { appName: "Dotty", appStoreId: "123", publicUrl: "https://day2.example", appId: "a1", iapLabel: null, rtdnLabel: null, hasIos: true, hasAndroid: true });
    expect(v.map((x) => x.id)).toEqual(["paid_apps", "iap_key", "apple_notifications", "payments_profile", "rtdn", "admob"]);
    expect(v.find((x) => x.id === "apple_notifications")!.walkthrough.some((s) => s.detail.includes("https://day2.example/api/store-notify/apple/a1"))).toBe(true);
    expect(v.find((x) => x.id === "rtdn")!.walkthrough.some((s) => s.detail.includes("google-play-developer-notifications@system.gserviceaccount.com"))).toBe(true);
  });
});

describe("the money pass", () => {
  const root = mkdtempSync(join(tmpdir(), "day2-money-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"dependencies":{"expo":"54","react-native":"0.81"}}');
  writeFileSync(join(root, "app.json"), JSON.stringify({ expo: { ios: { bundleIdentifier: "de.dotty.app" }, android: { package: "de.dotty.app" } } }));
  const app: AppEntry = { id: "app_m", name: "Dotty", repoPath: root, connectionMethod: "local_path", addedAt: "2026-09-01T00:00:00Z" };
  const profile = { purpose: "Draw dot art", targetUsers: "Young people in Germany", featureMap: ["Canvas"], businessModel: null } as unknown as AppProfile;
  let userCount = 5;
  const store = {
    activity: async () => ({ users: Array.from({ length: userCount }, (_, i) => ({ user: `u${i}`, firstSeen: "2026-10-01", lastSeen: "2026-11-02", days: ["2026-11-02"] })), older: 0 }),
    events: async () => [],
    retention: async () => null,
  } as unknown as FieldStore;
  const ledger = fileMoneyLedger(join(root, "ledger"));
  let researched = 0;
  const made: string[] = [];
  const deps = {
    ledger,
    store,
    verify: async () => ({ ledger, who: () => null, bundleId: "de.dotty.app", packageName: "de.dotty.app", catalog: [] }),
    catalogs: async () => ({
      apple: { ensure: async (p: { productId: string }) => (made.push(p.productId), { state: "created" as const, ref: "s" }), state: async () => null, reviewScreenshot: async () => {} },
      google: null,
    }),
    research: async (input: StrategyInput) => {
      researched++;
      expect(input.users).toBe(userCount);
      return { result: withGuardrails(parse(), { minorsHint: input.minorsHint }) as ParsedStrategy, credits: 20 };
    },
    experiments: null,
  };

  test("too few users: not yet, without research", async () => {
    saveBacklog(backlogFile(app), emptyBacklog());
    const r = await moneyPass(app, profile, deps, () => {}, NOW);
    expect(r.strategy).toBe("not_yet");
    expect(researched).toBe(0);
    expect(currentStrategy(loadAppMoney(app))!.verdict).toBe("not_yet");
  });

  test("enough users: a researched proposal waits; approving it creates products and tickets", async () => {
    userCount = 150;
    const logs: string[] = [];
    let r = await moneyPass(app, profile, deps, (t) => logs.push(t), new Date(NOW.getTime() + 2 * DAY));
    expect(r.strategy).toBe("proposed");
    expect(researched).toBe(1);
    expect(logs.some((l) => l.includes("waits for your approval"))).toBe(true);
    expect(made).toEqual([]);
    // The owner approves (what the API does).
    let f = loadAppMoney(app);
    const d = decideStrategy(f, f.strategies[0]!.id, true, "Pablo", NOW);
    f = adoptStrategy(d.file, d.strategy!, { idBase: "de.dotty.app", stores: { ios: true, android: true }, now: NOW });
    saveAppMoney(app, f);
    r = await moneyPass(app, profile, deps, () => {}, new Date(NOW.getTime() + 3 * DAY));
    expect(made).toEqual(["de.dotty.app.pro_monthly.v1", "de.dotty.app.pro_yearly.v1"]);
    expect(r.ticketsCreated).toHaveLength(3);
    f = loadAppMoney(app);
    expect(f.products[0]!.android.error).toContain("Connect Google Play");
    expect(Object.keys(f.tickets)).toEqual([PURCHASES_KEY, PAYWALL_KEY, ADS_ATT_KEY]);
    // Again: nothing new.
    r = await moneyPass(app, profile, deps, () => {}, new Date(NOW.getTime() + 3 * DAY + 60_000));
    expect(r.ticketsCreated).toHaveLength(0);
    expect(made).toHaveLength(2);
    const backlog = await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
    expect(backlog.tickets.map((t) => t.source.key)).toEqual(expect.arrayContaining([PURCHASES_KEY, PAYWALL_KEY, ADS_ATT_KEY]));
  });
});
