import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { buyTopUp, readCredits, setPlan } from "../credits";
import { BETS_FILENAME, loadBets, saveBets, type Bet } from "../growth-bets";
import type { EventLike } from "../metrics/types";
import type { AppProfile } from "../onboarding";
import { fileAssetStore, type StoredAsset } from "./assets";
import { ADS_FILENAME, choosePlatforms, creativesFor, loadAds, pausePlatformAds, platformResults, rebalance, runPlatformAds, type PlatformAdsDeps, type PlatformCampaign } from "./autopilot";
import type { AdCopyPlan } from "./copy";
import { filePlatformIdentities } from "./identities";
import type { AdPlatform, AdStats, LaunchSpec, Launched, PlatformId, PlatformInfo } from "./types";

const NOW = new Date("2026-10-28T10:00:00Z");
const DAY = 86_400_000;

const info = (id: PlatformId, over: Partial<PlatformInfo> = {}): PlatformInfo => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  formats: [
    { kind: "video", ratio: "9:16", width: 1080, height: 1920, maxDurationSec: 60, maxBytes: 500_000_000, mimes: ["video/mp4"] },
    { kind: "image", ratio: "1:1", width: 1080, height: 1080, maxBytes: 30_000_000, mimes: ["image/jpeg"] },
  ],
  textOnly: false,
  copyLimits: { headline: 40, body: 125 },
  minDailyUsd: 1,
  clickIdParam: "fbclid",
  identity: "none",
  audiences: ["consumer", "business"],
  env: [],
  apiVersion: "test",
  ...over,
});

const INFOS: Record<string, PlatformInfo> = {
  meta: info("meta", { identity: "app_account", identityHelp: "the app's Facebook Page" }),
  tiktok: info("tiktok", { minDailyUsd: 20, identity: "custom", audiences: ["consumer"], clickIdParam: "ttclid" }),
  google: info("google", { textOnly: true, copyLimits: { headline: 30, body: 90 }, formats: [{ kind: "image", ratio: "1.91:1", width: 1200, height: 628, maxBytes: 5_000_000, mimes: ["image/jpeg"] }] }),
  snapchat: info("snapchat", { minDailyUsd: 5, audiences: ["consumer"] }),
  linkedin: info("linkedin", { minDailyUsd: 10, audiences: ["business"], identity: "app_account", formats: [{ kind: "image", ratio: "1:1", width: 1080, height: 1080, maxBytes: 5_000_000, mimes: ["image/jpeg"] }] }),
};

describe("which platforms, at what budget", () => {
  test("consumers: in fit order, as many as the minimums allow", () => {
    const r = choosePlatforms([INFOS.meta!, INFOS.tiktok!, INFOS.google!, INFOS.snapchat!], "consumer", 30);
    expect(r.chosen.map((c) => c.id)).toEqual(["meta", "tiktok", "google", "snapchat"]);
    expect(r.chosen.find((c) => c.id === "tiktok")!.dailyUsd).toBeCloseTo(20.75, 2);
    const small = choosePlatforms([INFOS.meta!, INFOS.tiktok!, INFOS.google!], "consumer", 6);
    expect(small.chosen.map((c) => c.id)).toEqual(["meta", "google"]);
    expect(small.skipped[0]).toMatchObject({ id: "tiktok", why: expect.stringMatching(/its minimum is [\d,]+ credits a day/) });
  });
  test("business: LinkedIn first, consumer-only platforms left out", () => {
    const r = choosePlatforms(Object.values(INFOS), "business", 40);
    expect(r.chosen.map((c) => c.id)).toEqual(["linkedin", "google", "meta"]);
  });
});

const COPY: AdCopyPlan = {
  audience: "consumer",
  variants: [
    { headline: "Split a dinner bill in 10 seconds", shortHeadline: "Split bills in 10 seconds", body: "Add the bill, pick who was there, done.", description: "For groups and trips", cta: "sign_up", frameHeadline: "Split a dinner bill in 10 seconds", frameCta: "Try it", claims: ["splits bills"] },
    { headline: "Trips without money talk", shortHeadline: "Trips without money talk", body: "Everyone sees who paid what.", description: "Settle up in one tap", cta: "learn_more", frameHeadline: "Trips without money talk", frameCta: "Try it", claims: ["shows balances"] },
  ],
  script: "Here's how a group settles a trip in one tap.",
  keywords: ["split bills app", "group expenses", "trip costs"],
  interests: ["travel"],
  countries: ["DE"],
  languages: ["de"],
};

const asset = (id: string, kind: "image" | "video", ratio: StoredAsset["ratio"], over: Partial<StoredAsset> = {}): StoredAsset => ({
  id,
  kind,
  ratio,
  width: 1080,
  height: 1080,
  mime: kind === "video" ? "video/mp4" : "image/jpeg",
  bytes: 1000,
  path: "/x",
  url: `https://day2.example/api/assets/${id}`,
  source: kind === "video" ? "screen_recording" : "screenshot",
  aiGenerated: false,
  aiPerson: false,
  appId: "app_a",
  createdAt: NOW.toISOString(),
  purpose: "B-1",
  label: kind === "video" ? "App walkthrough video" : "App page image",
  costUsd: 0,
  ...(kind === "video" ? { durationSec: 14 } : {}),
  ...over,
});

describe("which ads go where", () => {
  const made = [
    { asset: asset("v1", "video", "9:16"), variant: 0 },
    { asset: asset("v2", "video", "9:16", { source: "creatify", aiGenerated: true, aiPerson: true, label: "AI presenter video" }), variant: 0 },
    { asset: asset("i1", "image", "1:1"), variant: 0 },
    { asset: asset("i2", "image", "1:1"), variant: 1 },
    { asset: asset("i3", "image", "1.91:1"), variant: 0 },
  ];
  test("video where the platform takes it, one per kind; an AI presenter is disclosed in the text", () => {
    const c = creativesFor(INFOS.tiktok!, "B-1", COPY, made);
    expect(c.map((x) => x.asset?.id)).toEqual(["v1", "v2"]);
    expect(c[1]!.copy.body).toEndWith("(AI presenter)");
    expect(c[0]!.copy.body).not.toContain("AI presenter");
  });
  test("images per copy variant where only images fit; search text where wanted", () => {
    expect(creativesFor(INFOS.linkedin!, "B-1", COPY, made).map((x) => [x.asset?.id, x.copy.headline])).toEqual([
      ["i1", "Split a dinner bill in 10 seconds"],
      ["i2", "Trips without money talk"],
    ]);
    const search = creativesFor(INFOS.google!, "B-1", COPY, made, { preferText: true });
    expect(search.map((x) => [x.asset, x.copy.headline])).toEqual([
      [null, "Split bills in 10 seconds"],
      [null, "Trips without money talk"],
    ]);
  });
});

const bet = (over: Partial<Bet> = {}): Bet => ({ id: "B-1", title: "Split dinners", angle: "Split a dinner bill fast", audience: "friends", channel: "ads", metric: "signup", landingPath: "/go/split", ticketId: null, source: null, status: "live", createdAt: NOW.toISOString(), liveAt: new Date(NOW.getTime() - 20 * DAY).toISOString(), stoppedAt: null, ...over });
const camp = (platform: PlatformId, over: Partial<PlatformCampaign> = {}): PlatformCampaign => ({
  betId: "B-1",
  platform,
  launched: { platform, campaignId: `${platform}-c1`, refs: {}, ads: {} },
  status: "active",
  dailyBudgetUsd: 10,
  launchedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
  spendUsd: 100,
  billedSpendUsd: 100,
  impressions: 0,
  clicks: 0,
  lastSyncAt: null,
  lastScaledAt: null,
  heldFor: null,
  stopReason: null,
  review: null,
  month: { id: "2026-10", spendAtStart: 0 },
  creatives: [],
  billing: "credits",
  currency: "USD",
  optimizeFor: "clicks",
  ...over,
});
const visit = (device: string, c: string, signup: boolean): EventLike[] => [
  { type: "visit", at: new Date(NOW.getTime() - 5 * DAY).toISOString(), deviceId: device, acquisition: { campaignId: c, channel: "paid" } },
  ...(signup ? [{ type: "signup", at: new Date(NOW.getTime() - 5 * DAY + 60_000).toISOString(), deviceId: device }] : []),
];

describe("comparing platforms by what they bring", () => {
  const events = [
    ...Array.from({ length: 10 }, (_, i) => visit(`m${i}`, "B-1.meta", true)).flat(), // 10 sign-ups for $100: $10 each
    ...Array.from({ length: 20 }, (_, i) => visit(`t${i}`, "B-1.tiktok", i < 2)).flat(), // 2 sign-ups for $100: $50 each
    ...Array.from({ length: 30 }, (_, i) => visit(`s${i}`, "B-1.snapchat", false)).flat(), // none for $100
    ...visit("other", "B-9", true),
  ];
  const campaigns = [camp("meta"), camp("tiktok", { dailyBudgetUsd: 25 }), camp("snapchat")];
  const results = platformResults(bet(), campaigns, events);

  test("people and outcomes per platform, from day2's own events", () => {
    expect(results.map((r) => [r.platform, r.people, r.outcomes, r.costPerOutcome])).toEqual([
      ["meta", 10, 10, 10],
      ["tiktok", 20, 2, 50],
      ["snapchat", 30, 0, null],
    ]);
  });
  test("stop what brings nothing, cut what costs far more, give the best more", () => {
    const d = rebalance(campaigns, results, new Map(Object.entries(INFOS)) as Map<PlatformId, PlatformInfo>, NOW, { dailyUsd: 0 }, "sign-up");
    expect(d).toEqual([
      { platform: "tiktok", action: "cut", dailyUsd: 20, why: "each sign-up costs 5.0× more than on Meta" },
      { platform: "snapchat", action: "stop", why: expect.stringMatching(/^spent [\d,]+ credits without a single sign-up$/) },
      { platform: "meta", action: "scale", dailyUsd: 15, why: expect.stringMatching(/^the lowest cost per sign-up \([\d,]+ credits\)$/) },
    ]);
  });
  test("while the retention engine holds scale-ups, losers are still cut but nothing grows", () => {
    const d = rebalance(campaigns, results, new Map(Object.entries(INFOS)) as Map<PlatformId, PlatformInfo>, NOW, { dailyUsd: 0 }, "sign-up", true);
    expect(d.map((x) => x.action)).toEqual(["cut", "stop"]);
  });
  test("too early or too little spend: no judgement yet", () => {
    const young = campaigns.map((c) => ({ ...c, launchedAt: new Date(NOW.getTime() - DAY).toISOString() }));
    expect(rebalance(young, results, new Map(Object.entries(INFOS)) as Map<PlatformId, PlatformInfo>, NOW, { dailyUsd: 0 }, "sign-up")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A whole pass, against fake platforms
// ---------------------------------------------------------------------------

class FakePlatform implements AdPlatform {
  launches: LaunchSpec[] = [];
  calls: string[] = [];
  stat: AdStats = { spend: 0, currency: "USD", impressions: 0, clicks: 0, status: "active" };
  conversionsSent: string[] = [];
  identities = 0;
  constructor(public id: PlatformId) {}
  async launch(spec: LaunchSpec): Promise<Launched> {
    this.launches.push(spec);
    return { platform: this.id, campaignId: `${this.id}-${this.launches.length}`, refs: {}, ads: Object.fromEntries(spec.creatives.map((c, i) => [c.key, `ad${i}`])) };
  }
  async stats() {
    this.calls.push("stats");
    return this.stat;
  }
  async pause(c: Launched) {
    this.calls.push(`pause ${c.campaignId}`);
  }
  async resume(c: Launched) {
    this.calls.push(`resume ${c.campaignId}`);
  }
  async setDailyBudget(c: Launched, usd: number) {
    this.calls.push(`budget ${c.campaignId} ${usd}`);
  }
  async setAdActive(c: Launched, key: string, active: boolean) {
    this.calls.push(`ad ${c.campaignId} ${key} ${active ? "on" : "off"}`);
  }
  async accountInfo() {
    return { id: "acc", name: "acc", currency: "USD", canSpend: true };
  }
  async ensureConversions() {
    this.calls.push("ensureConversions");
    return { platform: this.id, refs: { pixel: "px1" } };
  }
  async sendConversions(_s: unknown, events: Array<{ eventId: string }>) {
    this.conversionsSent.push(...events.map((e) => e.eventId));
    return { sent: events.length, rejected: [] };
  }
}

describe("a pass", () => {
  const root = mkdtempSync(join(tmpdir(), "day2-ads-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "app");
  mkdirSync(repo, { recursive: true });
  const app: AppEntry = { id: "app_a", name: "Buddy", repoPath: repo, connectionMethod: "local_path", appBaseUrl: "https://buddy.example", addedAt: "2026-09-01T00:00:00Z" };
  const profile = { purpose: "Splits bills", targetUsers: "Friends", featureMap: ["Split a bill"], styleGuide: { colors: ["#4f46e5"], framework: "react" } } as unknown as AppProfile;
  const credits = { dir: join(root, "credits") };
  mkdirSync(credits.dir, { recursive: true });
  const assets = fileAssetStore(join(root, "assets"), "https://day2.example");
  const identities = filePlatformIdentities(join(root, "identities.json"));
  const meta = new FakePlatform("meta");
  const tiktok = Object.assign(new FakePlatform("tiktok"), {
    async ensureIdentity(a: { displayName: string }) {
      (tiktok as FakePlatform).identities++;
      return { platform: "tiktok" as const, ref: "ident-1", displayName: a.displayName };
    },
  });
  const google = new FakePlatform("google");
  let health = { ok: true, reason: "" };
  let events: EventLike[] = [];
  let produced = 0;
  const logs: string[] = [];

  const deps = (): PlatformAdsDeps => ({
    credits,
    platforms: new Map<PlatformId, AdPlatform>([
      ["meta", meta],
      ["tiktok", tiktok],
      ["google", google],
    ]),
    infos: new Map<PlatformId, PlatformInfo>([
      ["meta", INFOS.meta!],
      ["tiktok", INFOS.tiktok!],
      ["google", INFOS.google!],
    ]),
    identities,
    assets,
    providers: { creatify: null, runway: null },
    events: async () => events,
    pageHealth: async () => health,
    paidGate: async () => ({ unlocked: true, reason: "" }),
    writeCopy: async () => COPY,
    checkCopy: async (plan) => ({ plan: { ...plan, variants: plan.variants.slice(0, 1) }, dropped: [{ what: "variant 2", why: "overstates" }] }),
    async produce(i) {
      produced++;
      const make = async (kind: "image" | "video", ratio: StoredAsset["ratio"]) => {
        const f = join(root, `${kind}-${ratio.replace(/[:.]/g, "x")}-${produced}`);
        writeFileSync(f, "x");
        return assets.put(f, { appId: i.appId, purpose: i.purpose, label: kind === "video" ? "App walkthrough video" : "App page image", kind, ratio, width: 1080, height: 1080, ...(kind === "video" ? { durationSec: 14 } : {}), mime: kind === "video" ? "video/mp4" : "image/jpeg", source: kind === "video" ? "screen_recording" : "screenshot", aiGenerated: false, aiPerson: false });
      };
      return { assets: [{ asset: await make("video", "9:16"), variant: 0 }, { asset: await make("image", "1:1"), variant: 0 }, { asset: await make("image", "1.91:1"), variant: 0 }], costUsd: 0, notes: [] };
    },
  });
  const run = (now: Date, monthlyAdsUsd = 1500) => runPlatformAds(app, profile, deps(), { monthlyAdsUsd, now, log: (t) => logs.push(t) });

  test("launches on every platform that's ready, each with its own tracked link; waits for the app's Page on Meta", async () => {
    await setPlan(credits, "scale", "monthly", NOW);
    for (let i = 0; i < 5; i++) await buyTopUp(credits, "10k", NOW);
    saveBets(join(repo, BETS_FILENAME), { nextNumber: 2, bets: [bet()] });
    const r = await run(NOW);
    expect(r.launched).toEqual(["B-1:tiktok", "B-1:google"]);
    expect(r.skipped.some((s) => s.includes("Meta (needs the app's Facebook Page)"))).toBe(true);
    expect(tiktok.launches[0]).toMatchObject({ link: "https://buddy.example/go/split?d2=B-1.tiktok", currency: "USD", optimizeFor: "clicks", identity: { ref: "ident-1", displayName: "Buddy" }, targeting: { countries: ["DE"], keywords: COPY.keywords } });
    // Every ad carries its own tag, so day2 knows which one brought whom.
    expect(tiktok.launches[0]!.creatives[0]!.link).toBe("https://buddy.example/go/split?d2=B-1.tiktok.v1");
    expect(tiktok.launches[0]!.creatives.map((c) => c.asset?.kind)).toEqual(["video"]);
    expect(google.launches[0]).toMatchObject({ link: "https://buddy.example/go/split?d2=B-1.google", identity: null });
    expect(google.launches[0]!.creatives.map((c) => c.asset)).toEqual([null]); // search ads from the keywords
    expect(await identities.get("app_a", "tiktok")).toMatchObject({ ref: "ident-1", setBy: "day2" });
    expect(logs).toContain("Left out the variant 2 for B-1: overstates.");
    // Budget: half of an equal share, split at the platforms' minimums.
    expect(tiktok.launches[0]!.dailyBudget + google.launches[0]!.dailyBudget).toBeCloseTo(25, 0);
    expect(produced).toBe(1);
  });

  test("next pass: results billed in credits; a rejected ad is stopped with its reason", async () => {
    tiktok.stat = { spend: 42.5, currency: "USD", impressions: 9000, clicks: 300, status: "active" };
    google.stat = { spend: 3, currency: "USD", impressions: 100, clicks: 4, status: "rejected", rejection: "Destination not working" };
    const before = (await readCredits(credits, NOW)).events.length;
    const r = await run(new Date(NOW.getTime() + 7 * 3_600_000));
    expect(r.stopped).toEqual(["B-1:google"]);
    expect(logs.some((l) => l.includes("Google rejected the ad for B-1 (Destination not working)"))).toBe(true);
    const after = await readCredits(credits, NOW);
    expect(after.events.length).toBe(before + 2);
    expect(after.events.some((e) => e.id === "ads:tiktok:tiktok-1:4250")).toBe(true);
    expect(loadAds(join(repo, ADS_FILENAME)).campaigns.find((c) => c.platform === "tiktok")).toMatchObject({ spendUsd: 42.5, clicks: 300, status: "active" });
  });

  test("a broken page holds its ads, and they come back when it works", async () => {
    health = { ok: false, reason: "button does nothing" };
    await run(new Date(NOW.getTime() + 8 * 3_600_000));
    expect(tiktok.calls).toContain("pause tiktok-1");
    health = { ok: true, reason: "" };
    await run(new Date(NOW.getTime() + 9 * 3_600_000));
    expect(tiktok.calls).toContain("resume tiktok-1");
  });

  test("the month's budget: everything holds until the new month", async () => {
    tiktok.stat = { spend: 60, currency: "USD", impressions: 1, clicks: 1, status: "active" };
    await run(new Date(NOW.getTime() + 20 * 3_600_000), 50);
    expect(loadAds(join(repo, ADS_FILENAME)).campaigns.find((c) => c.platform === "tiktok")).toMatchObject({ status: "paused", heldFor: "this month's ad budget is used up" });
    await run(new Date("2026-11-01T08:00:00Z"), 50);
    expect(loadAds(join(repo, ADS_FILENAME)).campaigns.find((c) => c.platform === "tiktok")).toMatchObject({ status: "active", heldFor: null });
  });

  test("the kill switch pauses every platform", async () => {
    const paused = await pausePlatformAds(app, deps().platforms, (t) => logs.push(t), "the kill switch is on");
    expect(paused).toEqual(["B-1 on tiktok"]);
  });

  test("an experiment measured as worse stops everywhere", async () => {
    // Re-activate for the test, then make the experiment clearly worse.
    const f = loadAds(join(repo, ADS_FILENAME));
    for (const c of f.campaigns) if (c.platform === "tiktok") Object.assign(c, { status: "active", heldFor: null });
    writeFileSync(join(repo, ADS_FILENAME), JSON.stringify(f));
    events = [
      ...Array.from({ length: 60 }, (_, i) => visit(`x${i}`, "B-1.tiktok", false)).flat(),
      ...Array.from({ length: 60 }, (_, i) => visit(`o${i}`, "other", true)).flat(),
    ];
    await run(new Date("2026-11-02T08:00:00Z"));
    expect(loadAds(join(repo, ADS_FILENAME)).campaigns.every((c) => c.status === "stopped")).toBe(true);
  });
});

describe("where ads lead: the website or straight to the stores", () => {
  const root = mkdtempSync(join(tmpdir(), "day2-ads-dest-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "app");
  mkdirSync(repo, { recursive: true });
  const app: AppEntry = { id: "app_d", name: "Dotty", repoPath: repo, connectionMethod: "local_path", appBaseUrl: "https://dotty.example", addedAt: "2026-09-01T00:00:00Z" };
  const profile = { purpose: "Friends on a map", targetUsers: "Friends", featureMap: ["Share a moment"], styleGuide: { colors: ["#fdf6d8"], framework: "react-native" } } as unknown as AppProfile;
  const credits = { dir: join(root, "credits") };
  mkdirSync(credits.dir, { recursive: true });
  const assets = fileAssetStore(join(root, "assets"), "https://day2.example");
  const tiktok = new FakePlatform("tiktok");
  let handoffReady = false;
  let pageChecks: string[] = [];
  const logs: string[] = [];
  const deps = (): PlatformAdsDeps => ({
    credits,
    platforms: new Map<PlatformId, AdPlatform>([["tiktok", tiktok]]),
    infos: new Map<PlatformId, PlatformInfo>([["tiktok", { ...INFOS.tiktok!, identity: "none", minDailyUsd: 1 }]]),
    identities: filePlatformIdentities(join(root, "identities.json")),
    assets,
    providers: { creatify: null, runway: null },
    events: async () => [],
    pageHealth: async () => ({ ok: true, reason: "" }),
    paidGate: async () => ({ unlocked: true, reason: "" }),
    writeCopy: async () => COPY,
    checkCopy: async (plan) => ({ plan, dropped: [] }),
    storeLink: "https://day2.example/api/l/app_d",
    storeScreens: async () => [join(root, "shot.png")],
    handoff: {
      ensure: async () => (handoffReady ? { ready: true, ticketId: null, why: null } : { ready: false, ticketId: "D2-9", why: "the website doesn't send phones on to the App Store / Google Play yet" }),
      pageOk: async (url) => {
        pageChecks.push(url);
        return handoffReady;
      },
    },
    async produce(i) {
      const f = join(root, `v-${i.purpose}`);
      writeFileSync(f, "x");
      const a = await assets.put(f, { appId: i.appId, purpose: i.purpose, label: "Video", kind: "video", ratio: "9:16", width: 1080, height: 1920, durationSec: 12, mime: "video/mp4", source: "motion_template", aiGenerated: false, aiPerson: false });
      return { assets: [{ asset: a, variant: 0 }], costUsd: 0, notes: [] };
    },
  });
  const run = (now: Date) => runPlatformAds(app, profile, deps(), { monthlyAdsUsd: 1500, now, log: (t) => logs.push(t) });
  const setDestination = (d: "website" | "store" | null) => {
    const f = loadAds(join(repo, ADS_FILENAME));
    writeFileSync(join(repo, ADS_FILENAME), JSON.stringify({ ...f, destination: d }));
  };

  test("website (the default): new ads wait until the website sends phones on to the stores", async () => {
    await setPlan(credits, "scale", "monthly", NOW);
    for (let i = 0; i < 5; i++) await buyTopUp(credits, "10k", NOW);
    writeFileSync(join(root, "shot.png"), "x");
    saveBets(join(repo, BETS_FILENAME), { nextNumber: 3, bets: [bet()] });
    const r = await run(NOW);
    expect(r.launched).toEqual([]);
    expect(r.skipped).toContain("ads: the website doesn't send phones on to the App Store / Google Play yet");
    expect(logs.some((l) => l.startsWith("New ads wait:") && l.includes("(D2-9)"))).toBe(true);
    expect(loadAds(join(repo, ADS_FILENAME)).handoff).toMatchObject({ ready: false, ticketId: "D2-9" });
  });

  test("website, once the handoff is live: the ad links to the experiment's page on the website", async () => {
    handoffReady = true;
    const r = await run(new Date(NOW.getTime() + 3_600_000));
    expect(r.launched).toEqual(["B-1:tiktok"]);
    expect(tiktok.launches[0]!.link).toBe("https://dotty.example/go/split?d2=B-1.tiktok");
    expect(pageChecks).toContain("https://dotty.example/go/split");
    expect(logs).toContain("The website now sends phones from ads on to the App Store / Google Play.");
  });

  test("store: the next experiment's ads go straight to day2's smart link, made from the app's real screens", async () => {
    setDestination("store");
    handoffReady = false; // not needed for the stores
    saveBets(join(repo, BETS_FILENAME), { nextNumber: 3, bets: [bet({ id: "B-2", landingPath: "/go/map" }), ...loadBets(join(repo, BETS_FILENAME)).bets] });
    const r = await run(new Date(NOW.getTime() + 2 * 3_600_000));
    expect(r.launched).toEqual(["B-2:tiktok"]);
    expect(tiktok.launches[1]!.link).toBe("https://day2.example/api/l/app_d?d2=B-2.tiktok");
    // The running website ad keeps its link.
    expect(loadAds(join(repo, ADS_FILENAME)).campaigns.find((c) => c.betId === "B-1")).toMatchObject({ status: "active" });
  });
});
