import { describe, expect, test } from "bun:test";
import { assignVariant as serverAssign } from "../../../src/experiments";
import { hashUser } from "../src/lifecycle";
import { assignVariant, inAudience, localized, purchaseTokenFor, startLive, versionAtLeast, type LiveEnv, type LiveStorage } from "../src/live";
import type { LiveConfig } from "../src/types";

/**
 * Live in the app, against a fake day2: config caching ("next launch"),
 * the first-launch wait, assignment and exposure, revenue, ads with caps,
 * push tokens, messages and the review moment.
 */

const KEY = "d2k_livetest_aaaaaaaaaaaa";
const USER = hashUser(KEY, "user-1");

const CONFIG = (version = 1, over: Partial<LiveConfig> = {}): LiveConfig => ({
  v: 1,
  version,
  values: { "onboarding.title": "Welcome", "paywall.trial_days": 7 },
  experiments: [
    {
      id: "X-1",
      keys: ["onboarding.title"],
      variants: [
        { name: "control", weight: 50, values: {} },
        { name: "short", weight: 50, values: { "onboarding.title": "Hi" } },
      ],
    },
  ],
  ...over,
});

function memStorage(init: Record<string, string> = {}): LiveStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => void data.set(k, v) };
}

type Tracked = { type: string; extra?: Parameters<LiveEnv["track"]>[1] };

function setup(o: { storage?: LiveStorage | null; config?: LiveConfig | null; user?: string | null; device?: string | null; now?: () => number; problems?: number; locale?: string; delayMs?: number; holdFirst?: boolean } = {}) {
  const tracked: Tracked[] = [];
  const variants: Record<string, string> = {};
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let timers: Array<{ fn: () => void; ms: number }> = [];
  let user = o.user === undefined ? USER : o.user;
  let release: (() => void) | null = null;
  const env: LiveEnv = {
    key: KEY,
    ingest: `https://day2.example/api/ingest/${KEY}`,
    platform: "ios",
    release: "1.4.0(23)",
    locale: o.locale ?? "de-DE",
    timeZone: "Europe/Berlin",
    storage: o.storage === undefined ? memStorage() : o.storage,
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(u), init });
      if (String(u).includes("/config")) {
        if (o.holdFirst) await new Promise<void>((r) => (release = r));
        const cfg = o.config === undefined ? CONFIG() : o.config;
        if (!cfg) return new Response(null, { status: 503 });
        const tag = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
        if (tag === `"${cfg.version}"`) return new Response(null, { status: 304 });
        return Response.json(cfg);
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    now: o.now ?? (() => Date.parse("2026-11-03T10:00:00Z")),
    user: () => user,
    device: () => o.device ?? null,
    pushDevice: () => "dev-push-0001",
    track: (type, extra) => tracked.push({ type, ...(extra ? { extra } : {}) }),
    setVariant: (exp, v) => void (variants[exp] = v),
    problems: () => o.problems ?? 0,
    setTimeout: (fn, ms) => {
      if (ms === 0) queueMicrotask(fn);
      else timers.push({ fn, ms });
    },
  };
  const live = startLive(env);
  return {
    live,
    env,
    tracked,
    variants,
    requests,
    setUser: (u: string | null) => (user = u),
    fireTimers: () => {
      const t = timers;
      timers = [];
      for (const x of t) x.fn();
    },
    releaseFetch: () => release?.(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("assignment and audiences (shared with day2's server)", () => {
  test("the library assigns exactly like the server", () => {
    const exp = { name: "X-7", variants: [{ name: "control", weight: 1 }, { name: "a", weight: 2 }, { name: "b", weight: 1 }] };
    for (let i = 0; i < 200; i++) expect(assignVariant(`u_${i}`, exp)).toBe(serverAssign(`u_${i}`, exp));
  });

  test("audience rules", () => {
    const now = Date.parse("2026-11-03T10:00:00Z");
    const ctx = { platform: "ios" as const, locale: "de-DE", installedAt: now - 2 * 86_400_000, now, fromAds: true, release: "1.4.2(30)@abcd1234", unit: "u_1" };
    expect(inAudience(undefined, ctx)).toBe(true);
    expect(inAudience({ platforms: ["android"] }, ctx)).toBe(false);
    expect(inAudience({ locales: ["de"] }, ctx)).toBe(true);
    expect(inAudience({ locales: ["de-AT"] }, ctx)).toBe(false);
    expect(inAudience({ newWithinDays: 1 }, ctx)).toBe(false);
    expect(inAudience({ newWithinDays: 3 }, ctx)).toBe(true);
    expect(inAudience({ fromAds: false }, ctx)).toBe(false);
    expect(inAudience({ minRelease: "1.4.1" }, ctx)).toBe(true);
    expect(inAudience({ minRelease: "1.5" }, ctx)).toBe(false);
    expect(inAudience({ percent: 0 }, ctx)).toBe(false);
    expect(inAudience({ percent: 100 }, { ...ctx, unit: null })).toBe(true);
    expect(inAudience({ percent: 50 }, { ...ctx, unit: null })).toBe(false);
    const share = Array.from({ length: 1000 }, (_, i) => inAudience({ percent: 30 }, { ...ctx, unit: `u_${i}` }, "X-1")).filter(Boolean).length;
    expect(share).toBeGreaterThan(250);
    expect(share).toBeLessThan(350);
    expect(versionAtLeast("2.0", "1.9.9")).toBe(true);
    expect(versionAtLeast(null, "1.0")).toBe(false);
  });

  test("purchase token: a stable UUID v4 shape from the hashed user", () => {
    const t = purchaseTokenFor(KEY, USER);
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(purchaseTokenFor(KEY, USER)).toBe(t);
    expect(purchaseTokenFor(KEY, hashUser(KEY, "user-2"))).not.toBe(t);
  });

  test("message texts in the user's language", () => {
    const m = { id: "m1", trigger: "t", title: "Hello", body: "Body", cta: { label: "Go" }, cap: { total: 1, perDay: 1 }, locale: { de: { title: "Hallo", body: "Text", cta: "Los" }, "pt-BR": { title: "Olá", body: "Corpo" } } };
    expect(localized(m, "de-DE")).toEqual({ title: "Hallo", body: "Text", cta: "Los" });
    expect(localized(m, "pt-BR")).toEqual({ title: "Olá", body: "Corpo" });
    expect(localized(m, "fr-FR")).toEqual({ title: "Hello", body: "Body", cta: "Go" });
  });
});

describe("config: cached at once, fresh on the next launch", () => {
  test("first launch: waits for the first fetch, then values come from it; the copy is kept", async () => {
    const storage = memStorage();
    const s = setup({ storage });
    expect(s.live.value("paywall.trial_days", 3)).toBe(3);
    let readyCalls = 0;
    s.live.onReady(() => readyCalls++);
    await s.live.settled;
    expect(readyCalls).toBe(1);
    expect(s.live.value("paywall.trial_days", 3)).toBe(7);
    expect(s.requests[0]!.url).toBe(`https://day2.example/api/ingest/${KEY}/config?p=ios&r=1.4.0(23)`);
    expect(JSON.parse(storage.data.get("day2.live")!).version).toBe(1);
  });

  test("first launch, day2 slow: after 1.5 s the app goes on with its fallbacks; the late config is for the next launch", async () => {
    const storage = memStorage();
    const s = setup({ storage, holdFirst: true });
    await tick();
    s.fireTimers(); // 1.5 s passed
    await s.live.settled;
    expect(s.live.value("paywall.trial_days", 3)).toBe(3);
    s.releaseFetch();
    await tick();
    expect(s.live.value("paywall.trial_days", 3)).toBe(3);
    expect(JSON.parse(storage.data.get("day2.live")!).version).toBe(1);
  });

  test("later launches: the cached config is used; a changed one only takes effect on the launch after", async () => {
    const storage = memStorage({ "day2.live": JSON.stringify(CONFIG(1)) });
    const s = setup({ storage, config: CONFIG(2, { values: { "paywall.trial_days": 14 } }) });
    await s.live.settled;
    expect(s.live.value("paywall.trial_days", 3)).toBe(7);
    await tick();
    expect(s.live.value("paywall.trial_days", 3)).toBe(7);
    // Sent with the version it has; the fresh one is kept.
    expect((s.requests[0]!.init!.headers as Record<string, string>)["if-none-match"]).toBe('"1"');
    expect(JSON.parse(storage.data.get("day2.live")!).version).toBe(2);
    const next = setup({ storage, config: CONFIG(2, { values: { "paywall.trial_days": 14 } }) });
    await next.live.settled;
    expect(next.live.value("paywall.trial_days", 3)).toBe(14);
  });

  test("foreground refetches at most every 15 minutes", async () => {
    let now = Date.parse("2026-11-03T10:00:00Z");
    const s = setup({ now: () => now, storage: memStorage({ "day2.live": JSON.stringify(CONFIG(1)) }) });
    await s.live.settled;
    await tick();
    const n = s.requests.length;
    now += 5 * 60_000;
    s.live.foreground();
    expect(s.requests.length).toBe(n);
    now += 11 * 60_000;
    s.live.foreground();
    expect(s.requests.length).toBe(n + 1);
  });

  test("a wrong-typed value falls back; without storage, everything still works for the launch", async () => {
    const s = setup({ storage: null, config: CONFIG(1, { values: { "paywall.trial_days": "seven" } }) });
    await s.live.settled;
    expect(s.live.value("paywall.trial_days", 3)).toBe(3);
  });
});

describe("experiments", () => {
  test("the variant decides the value; the first read sends one exposure and batches carry it", async () => {
    const s = setup();
    await s.live.settled;
    const v = assignVariant(USER, { name: "X-1", variants: CONFIG().experiments[0]!.variants });
    const title = s.live.value("onboarding.title", "Fallback");
    expect(title).toBe(v === "short" ? "Hi" : "Welcome");
    s.live.value("onboarding.title", "Fallback");
    expect(s.live.variant("X-1")).toBe(v);
    expect(s.tracked.filter((t) => t.type === "exposure")).toEqual([{ type: "exposure", extra: { props: { exp: "X-1", variant: v } } }]);
    expect(s.variants).toEqual({ "X-1": v });
    expect(s.live.variant("X-404")).toBeNull();
  });

  test("no unit (not identified, no kept device id): defaults, not in experiments", async () => {
    const s = setup({ user: null });
    await s.live.settled;
    expect(s.live.value("onboarding.title", "Fallback")).toBe("Welcome");
    expect(s.live.variant("X-1")).toBeNull();
    expect(s.tracked).toEqual([]);
  });

  test("the device id is the unit when the app keeps one", async () => {
    const s = setup({ user: null, device: "dev-kept-123456" });
    await s.live.settled;
    expect(s.live.variant("X-1")).toBe(assignVariant("dev-kept-123456", { name: "X-1", variants: CONFIG().experiments[0]!.variants }));
  });

  test("outside the experiment's audience: the default", async () => {
    const cfg = CONFIG(1);
    cfg.experiments[0]!.audience = { platforms: ["android"] };
    const s = setup({ config: cfg });
    await s.live.settled;
    expect(s.live.value("onboarding.title", "x")).toBe("Welcome");
    expect(s.live.variant("X-1")).toBeNull();
  });
});

describe("money, ads, push, messages, reviews", () => {
  test("revenue: checked, then sent as an event with value and props", async () => {
    const s = setup();
    s.live.revenue({ kind: "subscription", amount: 4.99, currency: "EUR", productId: "pro_monthly" });
    s.live.revenue({ kind: "purchase", amount: -1, currency: "EUR" });
    s.live.revenue({ kind: "purchase", amount: 1, currency: "euro" });
    expect(s.tracked).toEqual([{ type: "revenue", extra: { value: { amount: 4.99, currency: "EUR" }, props: { kind: "subscription", product: "pro_monthly" } } }]);
    expect(s.live.purchaseToken()).toBe(purchaseTokenFor(KEY, USER));
    s.setUser(null);
    expect(s.live.purchaseToken()).toBeNull();
  });

  test("ads: enabled, audience, per session, per day and time between; counters survive a relaunch", async () => {
    let now = Date.parse("2026-11-03T10:00:00Z");
    const storage = memStorage();
    const ads = { home: { format: "interstitial" as const, unitId: { ios: "ca-app-pub-1/2", android: "ca-app-pub-1/3" }, cap: { perSession: 2, perDay: 3, minSecondsBetween: 60 }, enabled: true } };
    const s = setup({ storage, now: () => now, config: CONFIG(1, { ads: { ...ads, off: { ...ads.home, enabled: false } } }) });
    await s.live.settled;
    expect(s.live.adPlacement("home")).toEqual({ show: true, unitId: "ca-app-pub-1/2", format: "interstitial" });
    expect(s.live.adPlacement("off").show).toBe(false);
    expect(s.live.adPlacement("missing")).toEqual({ show: false, unitId: null, format: null });
    s.live.adShown("home");
    expect(s.live.adPlacement("home").show).toBe(false); // 60 s between
    now += 61_000;
    expect(s.live.adPlacement("home").show).toBe(true);
    s.live.adShown("home");
    now += 61_000;
    expect(s.live.adPlacement("home").show).toBe(false); // 2 per session
    expect(s.tracked.filter((t) => t.type === "ad_shown")).toHaveLength(2);
    await tick();
    const again = setup({ storage, now: () => now, config: CONFIG(1, { ads }) });
    await again.live.settled;
    expect(again.live.adPlacement("home").show).toBe(true);
    again.live.adShown("home");
    now += 61_000;
    expect(again.live.adPlacement("home").show).toBe(false); // 3 per day
    now += 86_400_000;
    expect(again.live.adPlacement("home").show).toBe(true);
  });

  test("push token: sent for the identified user (never as an event), once; waits for identify", async () => {
    const s = setup({ user: null });
    s.live.setPushToken("ExponentPushToken[abc]");
    expect(s.requests.filter((r) => r.url.endsWith("/push"))).toHaveLength(0);
    s.setUser(USER);
    s.live.identified();
    await tick();
    const pushes = s.requests.filter((r) => r.url.endsWith("/push"));
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(String(pushes[0]!.init!.body))).toEqual({ user: USER, device: "dev-push-0001", token: "ExponentPushToken[abc]", platform: "ios", tz: "Europe/Berlin", locale: "de-DE" });
    expect(pushes[0]!.init!.method).toBe("POST");
    s.live.setPushToken("ExponentPushToken[abc]");
    await tick();
    expect(s.requests.filter((r) => r.url.endsWith("/push"))).toHaveLength(1);
    s.live.setPushToken(null);
    await tick();
    expect(JSON.parse(String(s.requests.filter((r) => r.url.endsWith("/push"))[1]!.init!.body)).token).toBeNull();
    expect(s.tracked).toEqual([]);
  });

  test("messages: by trigger, in the user's language, with total and daily caps", async () => {
    let now = Date.parse("2026-11-03T10:00:00Z");
    const messages = [
      { id: "welcome", trigger: "home_open", title: "Welcome", body: "Add your first dot", cta: { label: "Add", route: "/new" }, cap: { total: 2, perDay: 1 }, locale: { de: { title: "Willkommen", body: "Füge deinen ersten Punkt hinzu", cta: "Hinzufügen" } } },
    ];
    const s = setup({ now: () => now, config: CONFIG(1, { messages }) });
    await s.live.settled;
    expect(s.live.message("other")).toBeNull();
    expect(s.live.message("home_open")).toEqual({ id: "welcome", title: "Willkommen", body: "Füge deinen ersten Punkt hinzu", cta: { label: "Hinzufügen", route: "/new" } });
    s.live.messageEvent("welcome", "shown");
    expect(s.live.message("home_open")).toBeNull(); // 1 per day
    now += 86_400_000;
    s.live.messageEvent("welcome", "shown");
    now += 86_400_000;
    expect(s.live.message("home_open")).toBeNull(); // 2 in total
    s.live.messageEvent("welcome", "tapped");
    expect(s.tracked.map((t) => t.type)).toEqual(["message_shown", "message_shown", "message_tapped"]);
  });

  test("review: after enough events, days since install, days between asks, and not after a problem", async () => {
    let now = Date.parse("2026-11-03T10:00:00Z");
    const review = { afterEvents: { dot_added: 3 }, minDaysSinceInstall: 2, minDaysBetween: 30, notAfterProblem: true };
    const storage = memStorage();
    const s = setup({ storage, now: () => now, config: CONFIG(1, { review }) });
    await s.live.settled;
    for (let i = 0; i < 3; i++) s.live.counted("dot_added");
    expect(s.live.shouldAskForReview()).toBe(false); // installed today
    now += 3 * 86_400_000;
    expect(s.live.shouldAskForReview()).toBe(true);
    expect(s.live.shouldAskForReview()).toBe(false); // just asked
    expect(s.tracked.filter((t) => t.type === "review_prompt")).toHaveLength(1);
    now += 31 * 86_400_000;
    await tick();
    const crashed = setup({ storage, now: () => now, config: CONFIG(1, { review }), problems: 1 });
    await crashed.live.settled;
    expect(crashed.live.shouldAskForReview()).toBe(false);
    const fine = setup({ storage, now: () => now, config: CONFIG(1, { review }) });
    await fine.live.settled;
    expect(fine.live.shouldAskForReview()).toBe(true);
  });
});
