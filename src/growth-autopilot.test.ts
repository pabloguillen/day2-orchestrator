import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotPass, loadAutopilotLog, monthlyAdBudgetUsd, saveAutopilot, AUTOPILOT_FILENAME, AUTOPILOT_LOG_FILENAME, DEFAULT_AUTOPILOT, type AutopilotDeps } from "./growth-autopilot";
import { loadBets, saveBets, BETS_FILENAME } from "./growth-bets";
import { loadBacklog, BACKLOG_FILENAME, saveBacklog, updateTicket } from "./backlog";
import { saveAppProfile, APP_PROFILE_FILENAME, type AppProfile } from "./onboarding";
import { loadGrowthConfig, saveGrowthConfig, GROWTH_CONFIG_FILENAME, setKillSwitch, setMonthlyBudget } from "./growth-config";

const defaultGrowthConfig = () => loadGrowthConfig("/nonexistent/day2-growth.json");
import { getSummary, setPlan, type CreditStore } from "./credits";
import type { AdPlatform } from "./ads";
import type { AppEntry } from "./apps-registry";
import type { EventLike } from "./metrics/types";

let root: string;
let app: AppEntry;
let credits: CreditStore;
let adCalls: string[];
let adSpend: number;

const PROFILE: AppProfile = {
  purpose: "Splits shared bills between friends",
  targetUsers: "Roommates and travel groups",
  featureMap: ["Split a bill"],
  styleGuide: null,
  toneOfVoice: "friendly",
  businessModel: null,
  caveats: [],
  competitors: null,
  currentState: null,
  currentStateCaveat: "",
  scannedAt: "2026-10-01T00:00:00Z",
};

function fakeAds(): AdPlatform {
  return {
    async launch(i) {
      adCalls.push(`launch ${i.campaignName} ${i.dailyBudgetUsd} ${i.pageId} ${i.link}`);
      return { campaignId: `c-${adCalls.length}` };
    },
    async stats(id) {
      adCalls.push(`stats ${id}`);
      return { spendUsd: adSpend, impressions: 1000, clicks: 40, status: "ACTIVE" };
    },
    async pause(id) {
      adCalls.push(`pause ${id}`);
    },
    async setDailyBudget(id, usd) {
      adCalls.push(`budget ${id} ${usd}`);
    },
  };
}

function deps(over: Partial<AutopilotDeps> = {}): AutopilotDeps {
  return {
    credits,
    research: async () => ({
      findings: [
        { competitor: "Splitwise", angle: "Never chase friends for money again", channel: "paid_ads", relevance: "same audience", source: "https://example.com/a" },
        { competitor: "Tricount", angle: "Free forever for groups", channel: "app_store", relevance: "price hook", source: "https://example.com/b" },
        { competitor: "Settle Up", angle: "Works offline on trips", channel: "seo", relevance: "travel", source: "https://example.com/c" },
      ],
      usedTools: ["Foreplay"],
      credits: 120,
    }),
    paidGate: async () => ({ unlocked: true, reason: "" }),
    ads: fakeAds(),
    adAccountId: "act_123",
    metaPageId: async () => "1234567890",
    events: async () => null,
    now: new Date("2026-10-14T10:00:00Z"),
    ...over,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "day2-autopilot-"));
  const repo = join(root, "app");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "index.html"), '<meta property="og:title" content="Buddy">');
  app = { id: "app1", name: "buddy", repoPath: repo, connectionMethod: "local_path", appBaseUrl: "https://buddy.example", addedAt: "2026-10-01T00:00:00Z" };
  saveAppProfile(join(repo, APP_PROFILE_FILENAME), PROFILE);
  saveGrowthConfig(join(repo, GROWTH_CONFIG_FILENAME), setMonthlyBudget(defaultGrowthConfig(), 300));
  credits = { dir: join(root, "credits") };
  mkdirSync(credits.dir, { recursive: true });
  process.env.DAY2_USD_TO_EUR = "1";
  await setPlan(credits, "scale", "monthly");
  adCalls = [];
  adSpend = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const repoFile = (f: string) => join(app.repoPath, f);

/** Marks every experiment page ticket done (as the backlog autopilot would). */
function shipPages() {
  const b = loadBacklog(repoFile(BACKLOG_FILENAME));
  let next = b;
  for (const t of b.tickets.filter((x) => x.source.key?.startsWith("bet:"))) next = updateTicket(next, t.id, { state: "done" }, new Date("2026-10-15T00:00:00Z"), { kind: "user" }).backlog;
  saveBacklog(repoFile(BACKLOG_FILENAME), next);
}

describe("the growth autopilot", () => {
  test("first pass: growth features become tickets, research runs, experiments start — nobody clicks anything", async () => {
    const r = await autopilotPass(app, deps());
    const backlog = loadBacklog(repoFile(BACKLOG_FILENAME));
    const keys = backlog.tickets.map((t) => t.source.key);
    expect(keys).toContain("loop:referral");
    expect(keys).not.toContain("loop:share_preview"); // already in the app
    expect(r.ticketsCreated.length).toBeGreaterThanOrEqual(4);
    expect(r.researched).toBe(true);
    // At most 2 experiments at once, from the research.
    expect(r.experimentsCreated).toEqual(["B-1", "B-2"]);
    const bets = loadBets(repoFile(BETS_FILENAME)).bets;
    expect(bets.every((b) => b.createdBy === "autopilot" && b.ticketId)).toBe(true);
    expect(keys.filter((k) => k?.startsWith("bet:"))).toHaveLength(2);
    // Nothing to advertise yet: the pages aren't live.
    expect(adCalls).toEqual([]);
    const log = loadAutopilotLog(repoFile(AUTOPILOT_LOG_FILENAME));
    expect(log.map((e) => e.step)).toEqual(expect.arrayContaining(["built_in", "research", "experiment"]));

    // Second pass: no duplicates, research not due again.
    const again = await autopilotPass(app, deps());
    expect(again).toMatchObject({ ticketsCreated: [], researched: false, experimentsCreated: [] });
  });

  test("once a page is live: launches the ad within the budget, bills spend in credits, stops a loser", async () => {
    await autopilotPass(app, deps());
    shipPages();
    const later = new Date("2026-10-15T12:00:00Z");
    const r = await autopilotPass(app, deps({ now: later }));
    expect(r.launched).toEqual(["B-2", "B-1"].filter((id) => r.launched.includes(id)));
    expect(r.launched.length).toBe(2);
    const daily = monthlyAdBudgetUsd(300) / 30; // $4/day < Meta minimum
    expect(daily).toBeLessThan(5);
    expect(adCalls[0]).toMatch(/^launch day2 buddy B-\d 5 1234567890 https:\/\/buddy\.example\/go\/.+\?d2=B-\d$/);

    // Six hours on: results read, spend billed once, a clear loser stopped.
    adSpend = 30;
    const loser: EventLike[] = [];
    for (let i = 0; i < 40; i++) loser.push({ type: "visit", at: "2026-10-15T13:00:00Z", deviceId: `b${i}`, acquisition: { campaignId: "B-1" } });
    for (let i = 0; i < 100; i++) {
      loser.push({ type: "visit", at: "2026-10-15T13:00:00Z", deviceId: `o${i}` });
      if (i < 50) loser.push({ type: "activated", at: "2026-10-15T14:00:00Z", deviceId: `o${i}` });
    }
    const before = (await getSummary(credits)).balance.usedThisMonth;
    const r2 = await autopilotPass(app, deps({ now: new Date("2026-10-15T19:00:00Z"), events: async () => loser }));
    expect(r2.paused).toContain("B-1");
    const b1 = loadBets(repoFile(BETS_FILENAME)).bets.find((b) => b.id === "B-1")!;
    expect(b1).toMatchObject({ status: "stopped", campaign: { status: "paused", spendUsd: 30, billedSpendUsd: 30 } });
    expect(b1.stopReason).toContain("Stopped by day2");
    const used = (await getSummary(credits)).balance.usedThisMonth - before;
    expect(used).toBeGreaterThan(0); // both campaigns' $30 billed at the paid-ads rate
    // Replaying the same spend bills nothing more.
    const again = await autopilotPass(app, deps({ now: new Date("2026-10-16T02:00:00Z"), events: async () => loser }));
    void again;
    expect((await getSummary(credits)).balance.usedThisMonth - before).toBe(used);
  });

  test("no ads without a budget, an unlocked stage or the app's Page; the kill switch pauses running ads", async () => {
    await autopilotPass(app, deps());
    shipPages();
    const later = new Date("2026-10-15T12:00:00Z");
    expect((await autopilotPass(app, deps({ now: later, paidGate: async () => ({ unlocked: false, reason: "people don't stick around yet" }) }))).skipped).toContain(
      "ads: people don't stick around yet",
    );
    expect((await autopilotPass(app, deps({ now: later, metaPageId: async () => null }))).skipped.join(" ")).toContain("Facebook Page");
    expect((await autopilotPass(app, deps({ now: later, ads: null }))).skipped.join(" ")).toContain("isn't connected");
    expect(adCalls).toEqual([]);

    await autopilotPass(app, deps({ now: later }));
    expect(adCalls.filter((c) => c.startsWith("launch"))).toHaveLength(2);
    saveGrowthConfig(repoFile(GROWTH_CONFIG_FILENAME), setKillSwitch(setMonthlyBudget(defaultGrowthConfig(), 300), true));
    const off = await autopilotPass(app, deps({ now: later }));
    expect(off.paused.sort()).toEqual(["B-1", "B-2"]);
  });

  test("the owner can turn it off; a working experiment gets more budget", async () => {
    saveAutopilot(repoFile(AUTOPILOT_FILENAME), { ...DEFAULT_AUTOPILOT, enabled: false });
    expect(await autopilotPass(app, deps())).toMatchObject({ ticketsCreated: [], researched: false });

    saveAutopilot(repoFile(AUTOPILOT_FILENAME), { ...DEFAULT_AUTOPILOT, maxActiveExperiments: 1 });
    saveGrowthConfig(repoFile(GROWTH_CONFIG_FILENAME), setMonthlyBudget(defaultGrowthConfig(), 1500)); // $20/day for ads
    await autopilotPass(app, deps());
    shipPages();
    await autopilotPass(app, deps({ now: new Date("2026-10-15T12:00:00Z") }));
    const winner: EventLike[] = [];
    for (let i = 0; i < 60; i++) {
      winner.push({ type: "visit", at: "2026-10-15T13:00:00Z", deviceId: `b${i}`, acquisition: { campaignId: "B-1" } });
      if (i < 30) winner.push({ type: "activated", at: "2026-10-15T14:00:00Z", deviceId: `b${i}` });
    }
    for (let i = 0; i < 100; i++) winner.push({ type: "visit", at: "2026-10-15T13:00:00Z", deviceId: `o${i}` });
    const r = await autopilotPass(app, deps({ now: new Date("2026-10-15T19:00:00Z"), events: async () => winner }));
    expect(r.scaled).toEqual(["B-1"]);
    const c = loadBets(repoFile(BETS_FILENAME)).bets[0]!.campaign!;
    // Started at $10/day (half of its $20 share), raised 1.5× to $15.
    expect(c.dailyBudgetUsd).toBe(15);
    void saveBets;
  });
});
