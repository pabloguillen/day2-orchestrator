import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { buyTopUp, readCredits, setPlan } from "../credits";
import type { UserActivity } from "../field-store";
import { loadAllocatorState } from "../growth-allocator";
import { BETS_FILENAME, saveBets, type Bet } from "../growth-bets";
import type { EventLike } from "../metrics/types";
import type { AppProfile } from "../onboarding";
import { fileAssetStore } from "./assets";
import { ADS_FILENAME, adDecisions, loadAds, runPlatformAds, type PlatformAdsDeps, type PlatformCampaign } from "./autopilot";
import { collectConversions, fileSentConversions } from "./conversions";
import type { AdCopyPlan, CopyInput } from "./copy";
import { setRatesForTest } from "./fx";
import { filePlatformIdentities } from "./identities";
import { computeLearnings, copyHints, formatsToSkip, platformOrder, recordInAllocator, researchHint } from "./learnings";
import { judgeBy, parseTag, platformResults, retentionFrom } from "./results";
import type { AdPlatform, AdStats, LaunchSpec, Launched, PlatformId, PlatformInfo } from "./types";

/** The feedback loop: per-ad results, users who stay, conversions back to the platforms, and what the next round learns. */

const NOW = new Date("2026-10-28T10:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const bet = (over: Partial<Bet> = {}): Bet => ({ id: "B-1", title: "Split dinners", angle: "Split a dinner bill fast", audience: "friends", channel: "ads", metric: "signup", landingPath: "/go/split", ticketId: null, source: null, status: "live", createdAt: ago(30), liveAt: ago(20), stoppedAt: null, ...over });
const visit = (device: string, tag: string, opts: { signup?: boolean; user?: string; click?: string } = {}): EventLike[] => [
  { type: "visit", at: ago(10), deviceId: device, acquisition: { campaignId: tag, channel: "paid", ...(opts.click ? { click: { param: "ttclid", value: opts.click, ip: "203.0.113.7", ua: "Mozilla/5.0" } } : {}) } },
  ...(opts.signup ? [{ type: "signup", at: ago(9.9), deviceId: device, ...(opts.user ? { userId: opts.user } : {}) }] : []),
];
const camp = (platform: PlatformId, over: Partial<PlatformCampaign> = {}): PlatformCampaign => ({
  betId: "B-1",
  platform,
  launched: { platform, campaignId: `${platform}-1`, refs: {}, ads: {} },
  status: "active",
  billing: "credits",
  currency: "USD",
  dailyBudgetUsd: 20,
  launchedAt: ago(12),
  spendUsd: 100,
  billedSpendUsd: 100,
  impressions: 0,
  clicks: 0,
  lastSyncAt: null,
  lastScaledAt: null,
  heldFor: null,
  stopReason: null,
  review: null,
  optimizeFor: "clicks",
  month: { id: "2026-10", spendAtStart: 0 },
  creatives: [
    { key: `B-1-${platform}-v1`, variant: 0, assetId: null, kind: "video", format: "walkthrough", headline: "Split a bill in 10 seconds" },
    { key: `B-1-${platform}-v2`, variant: 0, assetId: null, kind: "video", format: "presenter", headline: "Split a bill in 10 seconds" },
  ],
  adSpendUsd: { [`B-1-${platform}-v1`]: 50, [`B-1-${platform}-v2`]: 50 },
  ...over,
});

describe("per ad, and users who stay", () => {
  const events = [
    ...Array.from({ length: 10 }, (_, i) => visit(`a${i}`, "B-1.tiktok.v1", { signup: true, user: `u_a${i}` })).flat(),
    ...Array.from({ length: 10 }, (_, i) => visit(`b${i}`, "B-1.tiktok.v2", { signup: i < 2, user: `u_b${i}` })).flat(),
  ];
  // Only the walkthrough's users came back a week later.
  const users: UserActivity[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ user: `u_a${i}`, firstSeen: ago(10).slice(0, 10), lastSeen: ago(1).slice(0, 10), days: [ago(10).slice(0, 10), ago(1).slice(0, 10)] })),
    ...Array.from({ length: 2 }, (_, i) => ({ user: `u_b${i}`, firstSeen: ago(10).slice(0, 10), lastSeen: ago(10).slice(0, 10), days: [ago(10).slice(0, 10)] })),
  ];
  const retention = retentionFrom(events, users, NOW);
  const [r] = platformResults(bet(), [camp("tiktok")], events, retention);

  test("tags: experiment, platform, ad", () => {
    expect(parseTag("B-1.tiktok.v2")).toEqual({ bet: "B-1", platform: "tiktok", ad: "v2" });
    expect(parseTag("B-1")).toEqual({ bet: "B-1" });
  });
  test("people, sign-ups and users who stayed, per ad", () => {
    expect(r).toMatchObject({ people: 20, outcomes: 12, retained: 10, eligible: 12 });
    expect(r!.ads.map((a) => [a.key, a.people, a.outcomes, a.retained])).toEqual([
      ["B-1-tiktok-v1", 10, 10, 10],
      ["B-1-tiktok-v2", 10, 2, 0],
    ]);
    expect(judgeBy([r!])).toBe("retained");
  });
  test("inside a platform: the ad nobody stays from is paused, the best keeps running", () => {
    expect(adDecisions(camp("tiktok"), r!, "retained")).toEqual([{ key: "B-1-tiktok-v2", why: expect.stringContaining("without a single user who stayed") }]);
    expect(adDecisions(camp("tiktok", { creatives: camp("tiktok").creatives.slice(0, 1) }), r!, "retained")).toEqual([]);
  });

  test("learnings: formats, platforms, copy and angles ranked — and where they go", () => {
    const meta = camp("meta");
    const metaEvents = Array.from({ length: 10 }, (_, i) => visit(`m${i}`, "B-1.meta.v1", { signup: i < 1 })).flat();
    const results = new Map([["B-1", platformResults(bet(), [camp("tiktok"), meta], [...events, ...metaEvents], retention)]]);
    const l = computeLearnings([bet(), bet({ id: "B-0", status: "stopped", stopReason: "Stopped by day2: it brought people who reach the goal less often", angle: "Save money on trips" })], [camp("tiktok"), meta].map((c) => ({ ...c, creatives: c.creatives })), results, "outcome", NOW);
    expect(l.platforms.map((p) => p.platform)).toEqual(["tiktok", "meta"]);
    expect(platformOrder(["meta", "tiktok", "google", "snapchat"], l)).toEqual(["tiktok", "meta", "google", "snapchat"]);
    expect(l.formats.find((f) => f.format === "walkthrough")).toMatchObject({ wins: 1 });
    expect(l.formats.find((f) => f.format === "presenter")!.losses).toBeGreaterThanOrEqual(1);
    expect(copyHints(l)).toContain('Angle that failed: "Save money on trips"');
    expect(researchHint(l)).toContain("failed: Save money on trips");
    // A format that lost twice and never won isn't made again.
    expect(formatsToSkip({ ...l, formats: [{ format: "presenter", ads: 4, people: 10, outcomes: 0, spendUsd: 80, costUsd: null, wins: 0, losses: 2 }] })).toEqual(["presenter"]);
  });

  test("the growth allocator learns from every ad, once", () => {
    const ads = r!.ads.map((a) => ({ key: a.key, format: a.key.endsWith("v1") ? ("walkthrough" as const) : ("presenter" as const), people: a.people, outcomes: a.outcomes, spendUsd: a.spendUsd }));
    const first = recordInAllocator({ arms: [], updatedAt: "" }, ads, {});
    const walk = first.state.arms.find((x) => x.arm.formatTag === "walkthrough")!;
    expect(walk).toMatchObject({ attempts: 10, successes: 10 });
    const again = recordInAllocator(first.state, ads, first.recorded);
    expect(again.state.arms.find((x) => x.arm.formatTag === "walkthrough")!.attempts).toBe(10);
  });
});

describe("conversions back to the platforms", () => {
  test("only people from that platform's ads, with its click id, IP and browser; each once", () => {
    const events = [...visit("d1", "B-1.tiktok.v1", { signup: true, user: "u_1", click: "E.C.P.123" }), ...visit("d2", "B-1.tiktok.v1", { signup: true }), ...visit("d3", "B-1.meta.v1", { signup: true, click: "E.C.P.9" })];
    const page = () => "https://buddy.example/go/split";
    const c = collectConversions({ platform: "tiktok", clickParam: "ttclid", events, sent: new Set(), pageUrl: page });
    expect(c).toEqual([{ eventId: "d1:signup", name: "signup", at: ago(9.9), click: { param: "ttclid", value: "E.C.P.123" }, pageUrl: "https://buddy.example/go/split", externalId: "u_1", clientIp: "203.0.113.7", userAgent: "Mozilla/5.0" }]);
    expect(collectConversions({ platform: "tiktok", clickParam: "ttclid", events, sent: new Set(["d1:signup"]), pageUrl: page })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A pass with the app's own EUR ad account
// ---------------------------------------------------------------------------

class Fake implements AdPlatform {
  launches: LaunchSpec[] = [];
  calls: string[] = [];
  sent: string[] = [];
  stat: AdStats = { spend: 0, currency: "EUR", impressions: 0, clicks: 0, status: "active" };
  constructor(public id: PlatformId) {}
  async launch(spec: LaunchSpec): Promise<Launched> {
    this.launches.push(spec);
    return { platform: this.id, campaignId: `${this.id}-${this.launches.length}`, refs: {}, ads: {} };
  }
  async stats() {
    return this.stat;
  }
  async pause() {}
  async resume() {}
  async setDailyBudget(c: Launched, n: number) {
    this.calls.push(`budget ${c.campaignId} ${n}`);
  }
  async setAdActive(c: Launched, key: string, on: boolean) {
    this.calls.push(`ad ${key} ${on}`);
  }
  async accountInfo() {
    return { id: "a", name: "a", currency: "EUR", canSpend: true };
  }
  async ensureConversions() {
    return { platform: this.id, refs: { pixel: "px" } };
  }
  async sendConversions(_s: unknown, ev: Array<{ eventId: string }>) {
    this.sent.push(...ev.map((e) => e.eventId));
    return { sent: ev.length, rejected: [] };
  }
}

describe("a pass on the app's own ad account", () => {
  const root = mkdtempSync(join(tmpdir(), "day2-feedback-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    setRatesForTest(null);
  });
  const repo = join(root, "app");
  mkdirSync(repo, { recursive: true });
  const app: AppEntry = { id: "app_f", name: "Buddy", repoPath: repo, connectionMethod: "local_path", appBaseUrl: "https://buddy.example", addedAt: "2026-09-01T00:00:00Z" };
  const profile = { purpose: "Splits bills", targetUsers: "Friends", featureMap: ["Split a bill"], styleGuide: null } as unknown as AppProfile;
  const credits = { dir: join(root, "credits") };
  mkdirSync(credits.dir, { recursive: true });
  const tiktok = new Fake("tiktok");
  const info: PlatformInfo = { id: "tiktok", name: "TikTok", formats: [{ kind: "video", ratio: "9:16", width: 1080, height: 1920, maxBytes: 1e9, maxDurationSec: 60, mimes: ["video/mp4"] }], textOnly: false, copyLimits: { headline: 40, body: 100 }, minDailyUsd: 20, clickIdParam: "ttclid", identity: "custom", audiences: ["consumer"], env: [], apiVersion: "t" };
  const assets = fileAssetStore(join(root, "assets"), "https://day2.example");
  const identities = filePlatformIdentities(join(root, "ids.json"));
  const sent = fileSentConversions(join(root, "sent.json"));
  let events: EventLike[] = [];
  const copyInputs: CopyInput[] = [];
  const COPY: AdCopyPlan = { audience: "consumer", variants: [{ headline: "Split a bill", shortHeadline: "Split a bill", body: "b", description: "d", cta: "sign_up", frameHeadline: "Split", frameCta: "Try", claims: [] }], script: null, keywords: [], interests: [], countries: ["DE"], languages: ["de"] };
  const deps = (): PlatformAdsDeps => ({
    credits,
    platforms: new Map([["tiktok", tiktok]]),
    infos: new Map([["tiktok", info]]),
    accounts: new Map([["tiktok", { billing: "own" as const, currency: "EUR" }]]),
    identities,
    assets,
    providers: { creatify: null, runway: null },
    events: async () => events,
    users: async () => [],
    sentConversions: sent,
    paidGate: async () => ({ unlocked: true, reason: "" }),
    writeCopy: async (i) => {
      copyInputs.push(i);
      return COPY;
    },
    checkCopy: async (plan) => ({ plan, dropped: [] }),
    async produce(i) {
      const f = join(root, `v-${i.purpose}.mp4`);
      writeFileSync(f, "x");
      const a = await assets.put(f, { appId: i.appId, purpose: i.purpose, label: "App walkthrough video", kind: "video", ratio: "9:16", width: 1080, height: 1920, durationSec: 14, mime: "video/mp4", source: "screen_recording", aiGenerated: false, aiPerson: false });
      return { assets: [{ asset: a, variant: 0 }], costUsd: 0, notes: [] };
    },
  });
  const ensureIdentity = async () => ({ platform: "tiktok" as const, ref: "id-1", displayName: "Buddy" });
  Object.assign(tiktok, { ensureIdentity });
  const run = (now: Date) => runPlatformAds(app, profile, deps(), { monthlyAdsUsd: 3000, now, log: () => {} });

  test("budget in the account's currency; spend not billed in credits (the customer pays the platform)", async () => {
    setRatesForTest({ USD: 1, EUR: 0.9 });
    await setPlan(credits, "scale", "monthly", NOW);
    for (let i = 0; i < 3; i++) await buyTopUp(credits, "10k", NOW);
    saveBets(join(repo, BETS_FILENAME), { nextNumber: 3, bets: [bet()] });
    await run(NOW);
    const spec = tiktok.launches[0]!;
    expect(spec.currency).toBe("EUR");
    expect(spec.dailyBudget).toBeCloseTo(50 * 0.9, 1); // half of the $100/day share, in EUR
    const before = (await readCredits(credits, NOW)).events.length;
    tiktok.stat = { spend: 90, currency: "EUR", impressions: 1, clicks: 1, status: "active" };
    await run(new Date(NOW.getTime() + 7 * 3_600_000));
    const c = loadAds(join(repo, ADS_FILENAME)).campaigns[0]!;
    expect(c).toMatchObject({ billing: "own", spendUsd: 100, billedSpendUsd: 0 });
    expect((await readCredits(credits, NOW)).events.length).toBe(before);
  });

  test("sign-ups go back to TikTok once; after enough of them, new campaigns optimise for sign-ups", async () => {
    events = Array.from({ length: 16 }, (_, i) => visit(`c${i}`, "B-1.tiktok.v1", { signup: true, click: `E.C.P.${i}00` })).flat();
    await run(new Date(NOW.getTime() + 14 * 3_600_000));
    expect(tiktok.sent).toHaveLength(16);
    await run(new Date(NOW.getTime() + 21 * 3_600_000));
    expect(tiktok.sent).toHaveLength(16);
    // A new experiment launches optimising for sign-ups, with the setup, and the copy writer is told which angle failed before.
    saveBets(join(repo, BETS_FILENAME), { nextNumber: 4, bets: [bet(), bet({ id: "B-0", status: "stopped", stopReason: "Stopped by day2: it brought people who reach the goal less often", angle: "Save money on trips" }), bet({ id: "B-2", angle: "Trips" })] });
    await run(new Date(NOW.getTime() + 22 * 3_600_000));
    const second = tiktok.launches.find((l) => l.campaignName.endsWith("B-2"))!;
    expect(second).toMatchObject({ optimizeFor: "signups", conversion: { refs: { pixel: "px" } } });
    expect(copyInputs.at(-1)!.learned).toContain('Angle that failed: "Save money on trips"');
    expect(loadAllocatorState(join(repo, "day2-allocator-state.json")).arms.length).toBeGreaterThan(0);
  });
});
