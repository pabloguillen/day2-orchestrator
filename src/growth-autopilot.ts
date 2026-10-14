import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppEntry } from "./apps-registry";
import { createTicket, findTicket, rankBacklog, withBacklog } from "./backlog";
import { backlogFile } from "./backlog-work";
import { auditLoops, loopSourceKey, loopTicket } from "./distribution-loops";
import { addBet, betLink, betTicket, BETS_FILENAME, loadBets, measureBet, saveBets, syncBetStatus, type Bet, type BetsFile } from "./growth-bets";
import { loadResearch, MARKET_RESEARCH_FILENAME, recordResearch, researchTopic } from "./market-research";
import { APP_PROFILE_FILENAME, loadAppProfile, type AppProfile } from "./onboarding";
import { GROWTH_CONFIG_FILENAME, loadGrowthConfig } from "./growth-config";
import { authorize, CreditsError, type CreditStore } from "./credits";
import { billAdSpend, type AdPlatform } from "./ads";
import type { CompetitorAngleInsight } from "./competitor-feed";
import type { EventLike } from "./metrics/types";

/**
 * The growth autopilot: day2 growing an app with nobody triggering anything.
 * Runs on the server's timer, once per app per pass:
 *
 *  1. Built into the app — every growth feature the app's code is missing
 *     becomes a ticket; the backlog autopilot builds it (autoStart.growth),
 *     and what ships follows the app's autonomy level.
 *  2. Research — what's working for competitors, on a schedule.
 *  3. Experiments — the best untested idea becomes an experiment, with its
 *     page in the app built like any ticket (at most a few at once).
 *  4. Paid traffic — once an experiment's page is live, paid ads make sense
 *     for the app's stage and it has an ad budget, day2 launches the ad from
 *     its own Meta account, bills the spend in credits, stops what doesn't
 *     work and puts more behind what does.
 *
 * Every step respects the kill switch and the credit caps (a refused
 * credit check just skips that step this pass) and is written to the app's
 * autopilot log in plain words. The owner can turn the autopilot off per app.
 */

export const AUTOPILOT_FILENAME = "day2-autopilot.json";
export const AUTOPILOT_LOG_FILENAME = "day2-autopilot-log.jsonl";

export type AutopilotSettings = {
  enabled: boolean;
  researchEveryDays: number;
  maxActiveExperiments: number;
};

export const DEFAULT_AUTOPILOT: AutopilotSettings = { enabled: true, researchEveryDays: 7, maxActiveExperiments: 2 };

export function loadAutopilot(path: string): AutopilotSettings {
  if (!existsSync(path)) return { ...DEFAULT_AUTOPILOT };
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<AutopilotSettings>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_AUTOPILOT.enabled,
    researchEveryDays: Number.isFinite(raw.researchEveryDays) && raw.researchEveryDays! >= 1 ? raw.researchEveryDays! : DEFAULT_AUTOPILOT.researchEveryDays,
    maxActiveExperiments:
      Number.isInteger(raw.maxActiveExperiments) && raw.maxActiveExperiments! >= 0 && raw.maxActiveExperiments! <= 5 ? raw.maxActiveExperiments! : DEFAULT_AUTOPILOT.maxActiveExperiments,
  };
}

export function saveAutopilot(path: string, s: AutopilotSettings): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, path);
}

export type AutopilotEntry = { at: string; step: "built_in" | "research" | "experiment" | "ads" | "skipped"; text: string; credits?: number };

const KEEP_LOG = 300;

export function loadAutopilotLog(path: string): AutopilotEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AutopilotEntry)
    .reverse();
}

function log(path: string, entry: AutopilotEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  if (lines.length > KEEP_LOG * 1.5) writeFileSync(path, `${lines.slice(-KEEP_LOG).join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Ads money rules
// ---------------------------------------------------------------------------

/** Share of the app's monthly growth budget the autopilot may spend on ads;
 * the rest stays for content, research and building. */
export const PAID_SHARE = 0.4;
/** Meta needs a meaningful daily budget to learn anything. */
export const MIN_DAILY_AD_USD = 5;
/** A new campaign is only started when its first week fits in the credits. */
const AUTHORIZE_DAYS = 7;
/** How often a campaign's results are read (each read is an agent run). */
const STATS_EVERY_MS = 6 * 3_600_000;
/** A working experiment gets more, at most this often, by this factor. */
const SCALE_EVERY_MS = 7 * 86_400_000;
const SCALE_FACTOR = 1.5;

export function monthlyAdBudgetUsd(monthlyGrowthBudgetUsd: number): number {
  return Math.round(monthlyGrowthBudgetUsd * PAID_SHARE * 100) / 100;
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

export type AutopilotDeps = {
  credits: CreditStore;
  /** Research with whatever tools day2 has connected; returns cited findings. */
  research: (topic: string) => Promise<{ findings: CompetitorAngleInsight[]; usedTools: string[]; credits: number }>;
  /** Whether paid ads make sense for the app's stage right now, and why. */
  paidGate: (app: AppEntry, profile: AppProfile) => Promise<{ unlocked: boolean; reason: string }>;
  /** day2's Meta ads, when connected and an ad account is configured. */
  ads: AdPlatform | null;
  adAccountId: string | null;
  /** The Facebook Page this app's ads run under, if the operator assigned one. */
  metaPageId: (appId: string) => Promise<string | null>;
  events: (app: AppEntry, sinceIso: string) => Promise<EventLike[] | null>;
  now?: Date;
};

export type AutopilotReport = { ticketsCreated: string[]; researched: boolean; experimentsCreated: string[]; launched: string[]; paused: string[]; scaled: string[]; skipped: string[] };

export async function autopilotPass(app: AppEntry, deps: AutopilotDeps): Promise<AutopilotReport> {
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const file = (f: string) => resolve(app.repoPath, f);
  const logPath = file(AUTOPILOT_LOG_FILENAME);
  const report: AutopilotReport = { ticketsCreated: [], researched: false, experimentsCreated: [], launched: [], paused: [], scaled: [], skipped: [] };
  const settings = loadAutopilot(file(AUTOPILOT_FILENAME));
  const killSwitch = loadGrowthConfig(file(GROWTH_CONFIG_FILENAME)).budget.killSwitch;

  // Paid campaigns must stop when the autopilot or spending is switched off.
  if (!settings.enabled || killSwitch) {
    const paused = await pauseAll(app, deps, logPath, at, killSwitch ? "the kill switch is on" : "the growth autopilot is off");
    report.paused.push(...paused);
    return report;
  }

  // 1. Built into the app.
  const backlog = await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
  const missing = auditLoops(app.repoPath, backlog).filter((l) => l.status === "missing" && !l.ticket);
  if (missing.length) {
    const created = await withBacklog(backlogFile(app), (b) => {
      let next = b;
      const made: Array<{ id: string; name: string }> = [];
      for (const l of missing) {
        if (next.tickets.some((t) => t.source.key === loopSourceKey(l.id))) continue;
        const r = createTicket(next, loopTicket(l.id), now);
        next = r.backlog;
        made.push({ id: r.ticket.id, name: l.name });
      }
      return { backlog: rankBacklog(next, now).backlog, result: made };
    });
    for (const m of created) {
      log(logPath, { at, step: "built_in", text: `Your app doesn't have ${m.name.toLowerCase()} yet — added ${m.id} to build it.` });
    }
    report.ticketsCreated.push(...created.map((m) => m.id));
  }

  const profile = loadAppProfile(file(APP_PROFILE_FILENAME));
  if (!profile) {
    report.skipped.push("No app profile yet — research and experiments start after the app scan.");
    return report;
  }

  // 2. Research, on a schedule.
  const researchPath = file(MARKET_RESEARCH_FILENAME);
  const lastRun = loadResearch(researchPath).runs[0];
  const due = !lastRun || now.getTime() - new Date(lastRun.at).getTime() >= settings.researchEveryDays * 86_400_000;
  if (due) {
    try {
      const topic = researchTopic(profile);
      const r = await deps.research(topic);
      recordResearch(researchPath, { at, topic, usedTools: r.usedTools, findings: r.findings, credits: r.credits });
      log(logPath, { at, step: "research", text: `Researched what's working for competitors: ${r.findings.length} cited idea${r.findings.length === 1 ? "" : "s"}.`, credits: r.credits });
      report.researched = true;
    } catch (err) {
      const why = err instanceof CreditsError ? err.message : (err as Error).message;
      log(logPath, { at, step: "skipped", text: `Research skipped: ${why}` });
      report.skipped.push(`research: ${why}`);
    }
  }

  // 3. Experiments from the best untested idea.
  const betsPath = file(BETS_FILENAME);
  let bets = syncAll(loadBets(betsPath), backlog.tickets);
  const active = bets.bets.filter((b) => b.status !== "stopped").length;
  const latest = loadResearch(researchPath).runs[0];
  if (latest && active < settings.maxActiveExperiments) {
    const tested = new Set(bets.bets.map((b) => b.source && `${b.source.researchRunId}:${b.source.findingId}`));
    const testedAngles = new Set(bets.bets.map((b) => b.angle.trim().toLowerCase()));
    const ideas = latest.findings.filter((f) => !tested.has(`${latest.id}:${f.id}`) && !testedAngles.has(f.angle.trim().toLowerCase()));
    for (const f of ideas.slice(0, settings.maxActiveExperiments - active)) {
      const added = addBet(
        bets,
        {
          title: shortTitle(f.angle),
          angle: f.angle,
          audience: profile.targetUsers,
          channel: "Meta ads",
          metric: "activation",
          source: { researchRunId: latest.id, findingId: f.id, competitor: f.competitor },
          createdBy: "autopilot",
        },
        now,
      );
      const ticket = await withBacklog(backlogFile(app), (b) => {
        const r = createTicket(b, betTicket(added.bet), now);
        return { backlog: rankBacklog(r.backlog, now).backlog, result: r.ticket };
      });
      bets = { ...added.file, bets: added.file.bets.map((b) => (b.id === added.bet.id ? { ...b, ticketId: ticket.id } : b)) };
      log(logPath, { at, step: "experiment", text: `Started experiment ${added.bet.id} from ${f.competitor}'s angle: "${f.angle}". Its page is ${ticket.id}.` });
      report.experimentsCreated.push(added.bet.id);
    }
  }
  saveBets(betsPath, bets);

  // 4. Paid traffic.
  await runAds(app, profile, deps, logPath, at, now, report);
  return report;
}

function syncAll(file: BetsFile, tickets: Parameters<typeof findTicket>[0]["tickets"]): BetsFile {
  return { ...file, bets: file.bets.map((b) => syncBetStatus(b, b.ticketId ? tickets.find((t) => t.id === b.ticketId) : undefined)) };
}

function shortTitle(angle: string): string {
  const t = angle.replace(/\s+/g, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 57).replace(/\s+\S*$/, "")}…`;
}

async function pauseAll(app: AppEntry, deps: AutopilotDeps, logPath: string, at: string, why: string): Promise<string[]> {
  const betsPath = resolve(app.repoPath, BETS_FILENAME);
  if (!deps.ads) return [];
  const file = loadBets(betsPath);
  const paused: string[] = [];
  const bets: Bet[] = [];
  for (const b of file.bets) {
    if (b.campaign?.status === "active") {
      try {
        await deps.ads.pause(b.campaign.campaignId);
        bets.push({ ...b, campaign: { ...b.campaign, status: "paused" } });
        paused.push(b.id);
        log(logPath, { at, step: "ads", text: `Paused the ad for ${b.id} because ${why}.` });
        continue;
      } catch (err) {
        log(logPath, { at, step: "skipped", text: `Couldn't pause the ad for ${b.id}: ${(err as Error).message}` });
      }
    }
    bets.push(b);
  }
  if (paused.length) saveBets(betsPath, { ...file, bets });
  return paused;
}

async function runAds(app: AppEntry, profile: AppProfile, deps: AutopilotDeps, logPath: string, at: string, now: Date, report: AutopilotReport) {
  const betsPath = resolve(app.repoPath, BETS_FILENAME);
  let file = loadBets(betsPath);
  const needsAds = file.bets.some((b) => (b.status === "live" && !b.campaign) || b.campaign?.status === "active");
  if (!needsAds) return;
  if (!deps.ads || !deps.adAccountId) {
    report.skipped.push("ads: day2's Meta Ads isn't connected on this server yet.");
    return;
  }
  const ads = deps.ads;
  const monthlyGrowth = loadGrowthConfig(resolve(app.repoPath, GROWTH_CONFIG_FILENAME)).budget.monthlyBudgetUsd;
  const monthlyAds = monthlyAdBudgetUsd(monthlyGrowth);
  const update = (id: string, fn: (b: Bet) => Bet) => {
    file = { ...file, bets: file.bets.map((b) => (b.id === id ? fn(b) : b)) };
    saveBets(betsPath, file);
  };

  // Running campaigns: read results (throttled), bill spend, decide.
  const since = file.bets.map((b) => b.liveAt).filter((x): x is string => Boolean(x)).sort()[0];
  const events = since ? await deps.events(app, since) : null;
  for (const b of file.bets) {
    const c = b.campaign;
    if (!c || c.status !== "active") continue;
    if (b.status === "stopped") {
      await ads.pause(c.campaignId).then(
        () => {
          update(b.id, (x) => ({ ...x, campaign: { ...c, status: "paused" } }));
          report.paused.push(b.id);
          log(logPath, { at, step: "ads", text: `Paused the ad for ${b.id} (the experiment was stopped).` });
        },
        (err: Error) => log(logPath, { at, step: "skipped", text: `Couldn't pause the ad for ${b.id}: ${err.message}` }),
      );
      continue;
    }
    if (c.lastSyncAt && now.getTime() - new Date(c.lastSyncAt).getTime() < STATS_EVERY_MS) continue;
    let stats;
    try {
      stats = await ads.stats(c.campaignId);
    } catch (err) {
      log(logPath, { at, step: "skipped", text: `Couldn't read the ad results for ${b.id}: ${(err as Error).message}` });
      continue;
    }
    const billed = await billAdSpend(deps.credits, { appId: app.id, campaignId: c.campaignId, label: `${b.id} ${b.title}`, reportedSpendUsd: stats.spendUsd, billedSpendUsd: c.billedSpendUsd });
    let next: typeof c = { ...c, spendUsd: stats.spendUsd, billedSpendUsd: billed, clicks: stats.clicks, impressions: stats.impressions, lastSyncAt: at };
    const verdict = measureBet(b, events);
    let stopReason: string | null = null;
    if (verdict.state === "worse") stopReason = "it brought people who reach first value less often than everyone else";
    else if (monthlyAds > 0 && stats.spendUsd >= monthlyAds) stopReason = "it used this month's ad budget without a clear win";
    if (stopReason) {
      try {
        await ads.pause(c.campaignId);
        next = { ...next, status: "paused" };
        update(b.id, (x) => ({ ...x, status: "stopped", stoppedAt: at, stopReason: `Stopped by day2: ${stopReason}.`, campaign: next }));
        report.paused.push(b.id);
        log(logPath, { at, step: "ads", text: `Stopped ${b.id} — ${stopReason}.` });
      } catch (err) {
        update(b.id, (x) => ({ ...x, campaign: next }));
        log(logPath, { at, step: "skipped", text: `Couldn't stop the ad for ${b.id}: ${(err as Error).message}` });
      }
      continue;
    }
    if (verdict.state === "better" && (!c.lastScaledAt || now.getTime() - new Date(c.lastScaledAt).getTime() >= SCALE_EVERY_MS)) {
      const target = Math.min(Math.round(c.dailyBudgetUsd * SCALE_FACTOR * 100) / 100, monthlyAds / 30);
      if (target > c.dailyBudgetUsd) {
        const check = await authorize(deps.credits, { appId: app.id, appName: app.name, service: "paid_ads", maxCostUsd: target * AUTHORIZE_DAYS });
        if (check.ok) {
          try {
            await ads.setDailyBudget(c.campaignId, target);
            next = { ...next, dailyBudgetUsd: target, lastScaledAt: at };
            report.scaled.push(b.id);
            log(logPath, { at, step: "ads", text: `${b.id} is working — raised its daily ad budget to $${target.toFixed(2)}.` });
          } catch (err) {
            log(logPath, { at, step: "skipped", text: `Couldn't raise the budget for ${b.id}: ${(err as Error).message}` });
          }
        }
      }
    }
    update(b.id, (x) => ({ ...x, campaign: next }));
  }

  // Live experiments without an ad yet: launch when everything allows it.
  const waiting = file.bets.filter((b) => b.status === "live" && !b.campaign);
  if (!waiting.length) return;
  if (monthlyAds <= 0) {
    report.skipped.push("ads: the app has no monthly growth budget set, so day2 doesn't buy ads.");
    return;
  }
  const gate = await deps.paidGate(app, profile);
  if (!gate.unlocked) {
    report.skipped.push(`ads: ${gate.reason}`);
    return;
  }
  const pageId = await deps.metaPageId(app.id);
  if (!pageId) {
    report.skipped.push("ads: waiting for day2 to set up this app's Facebook Page.");
    return;
  }
  const running = file.bets.filter((b) => b.campaign?.status === "active").length;
  for (const b of waiting) {
    const link = betLink(b, app.appBaseUrl);
    if (!link) continue;
    // Start at half the experiment's share and earn the rest by working.
    const daily = Math.max(MIN_DAILY_AD_USD, Math.round((monthlyAds / 30 / Math.max(1, running + 1) / 2) * 100) / 100);
    const check = await authorize(deps.credits, { appId: app.id, appName: app.name, service: "paid_ads", maxCostUsd: daily * AUTHORIZE_DAYS });
    if (!check.ok) {
      report.skipped.push(`ads: ${check.reason}`);
      log(logPath, { at, step: "skipped", text: `Didn't launch the ad for ${b.id}: ${check.reason}` });
      continue;
    }
    try {
      const { campaignId } = await ads.launch({
        appName: app.name,
        appPurpose: profile.purpose,
        pageId,
        adAccountId: deps.adAccountId,
        link,
        idea: b.angle,
        audience: b.audience,
        dailyBudgetUsd: daily,
        campaignName: `day2 ${app.name} ${b.id}`,
      });
      update(b.id, (x) => ({
        ...x,
        campaign: { platform: "meta", campaignId, status: "active", dailyBudgetUsd: daily, launchedAt: at, spendUsd: 0, billedSpendUsd: 0, clicks: 0, impressions: 0, lastSyncAt: null, lastScaledAt: null },
      }));
      report.launched.push(b.id);
      log(logPath, { at, step: "ads", text: `Launched a Meta ad for ${b.id} at $${daily.toFixed(2)}/day.` });
    } catch (err) {
      log(logPath, { at, step: "skipped", text: `Couldn't launch the ad for ${b.id}: ${(err as Error).message}` });
    }
  }
}
