import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { storeIdsFromRepo } from "../ads/app-links";
import { createTicket, rankBacklog, withBacklog } from "../backlog";
import { backlogFile } from "../backlog-work";
import { renderBrandBrief } from "../brand-dna";
import { CreditsError } from "../credits";
import { indexRepo } from "../distribution-loops";
import { appKind } from "../field-work";
import type { FieldStore } from "../field-store";
import type { AppProfile } from "../onboarding";
import type { AppleCatalog } from "./catalog-apple";
import type { GoogleCatalog } from "./catalog-google";
import { adRevenueRecords, computeKpis } from "./kpis";
import type { MoneyLedger } from "./ledger";
import { addTest, nextTest, syncTests, testTarget, type LiveExperimentsPort } from "./offer-tests";
import { dropDeclined, moneyKnowledge } from "./memory";
import { applyProducts, productsForStrategy } from "./products";
import { minorsHint, notYet, NOT_YET_USERS, propose, strategyDue, type ParsedStrategy, type StrategyInput } from "./strategy";
import { PAYWALL_KEY, registerMoneyNativeNeeds, repoHas, ticketsFor, usesRevenueCat } from "./tickets";
import { addLog, currentStrategy, proposedStrategy, type MoneyFile, type Strategy } from "./types";
import { drainQueue, type VerifyDeps } from "./verify";
import { knownUsers, loadAppMoney, saveAppMoney } from "./wiring";

/**
 * Money's pass in the growth autopilot (like retention-pass.ts), cheap when
 * nothing changed:
 *  1. Verification queue: store notifications waiting for a lookup.
 *  2. Ad revenue the app reported → the ledger.
 *  3. KPI snapshot, once a day.
 *  4. Strategy: "not yet" while too few users; researched every 60 days or
 *     when users grew 5× — proposed to the owner, never applied by itself.
 *  5. An approved strategy → products in the stores (approved ones), tickets
 *     for the app's code, paywalls and placements in Live config.
 *  6. Tests of offers through Live, one at a time, once the paywall shipped.
 */

registerMoneyNativeNeeds(loadAppMoney);

export const KPI_EVERY_MS = 24 * 3_600_000;
const DAY = 86_400_000;

export type MoneyPassDeps = {
  ledger: MoneyLedger;
  store: FieldStore;
  verify: () => Promise<VerifyDeps>;
  catalogs: () => Promise<{ apple: AppleCatalog | null; google: GoogleCatalog | null }>;
  research: (input: StrategyInput) => Promise<{ result: ParsedStrategy | null; credits: number }>;
  experiments: LiveExperimentsPort | null;
};

export type MoneyReport = { verified: number; retrying: number; strategy: "none" | "not_yet" | "proposed" | "kept"; productsCreated: string[]; ticketsCreated: string[]; testsStarted: string[]; skipped: string[] };

const PAY_CODE = /(purchase|paywall|subscri|premium|\bpro\b|iap|billing|ads?\b|admob|monet|unlock|shop|store)/i;

function excerpts(repoPath: string): Array<{ file: string; text: string }> {
  const repo = indexRepo(repoPath);
  return repo.files
    .filter((f) => PAY_CODE.test(f) && /\.(t|j)sx?$/.test(f) && !/(test|spec|\.d\.ts|day2\/)/.test(f))
    .slice(0, 6)
    .map((file) => {
      const text = repo.read(file);
      return { file, text: text.length > 3000 ? `${text.slice(0, 3000)}\n… (trimmed)` : text };
    });
}

function existing(repoPath: string): string[] {
  const known: Array<[string, string]> = [
    ["expo-iap", "expo-iap"],
    ["react-native-iap", "react-native-iap"],
    ["react-native-purchases", "react-native-purchases (RevenueCat)"],
    ["react-native-google-mobile-ads", "react-native-google-mobile-ads (AdMob)"],
    ["react-native-applovin-max", "AppLovin MAX"],
  ];
  return known.filter(([p]) => repoHas(repoPath, p)).map(([, l]) => l);
}

/** Pure. An approved strategy's paywalls and ad placements, keeping what the owner set (unit ids, switches). */
export function adoptStrategy(file: MoneyFile, s: Strategy, o: { idBase: string; stores: { ios: boolean; android: boolean }; now: Date }): MoneyFile {
  if (s.verdict !== "monetize") return file;
  let f = productsForStrategy(file, s, o).file;
  const keys = new Set(s.products.map((p) => p.key));
  // Products the new plan no longer lists stop being offered (buyers keep them).
  f = { ...f, products: f.products.map((p) => (!keys.has(p.key) && !p.retiredAt && !p.test ? { ...p, retiredAt: o.now.toISOString() } : p)) };
  f = {
    ...f,
    paywalls: s.paywalls.map((w) => ({ ...w, enabled: f.paywalls.find((x) => x.placement === w.placement)?.enabled ?? true })),
    ads: s.ads.map((a) => {
      const was = f.ads.find((x) => x.id === a.id);
      return { ...a, enabled: was?.enabled ?? true, unitId: was?.unitId ?? {} };
    }),
  };
  return f;
}

/** Tickets for the app's code an approved strategy needs (created once). */
export async function ensureTickets(app: AppEntry, file: MoneyFile, s: Strategy, now: Date): Promise<{ file: MoneyFile; created: string[] }> {
  const backlog = await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
  const haveKeys = new Set(backlog.tickets.filter((t) => t.state !== "parked").map((t) => t.source.key ?? ""));
  const inputs = ticketsFor(file, s, { haveKeys, usesRevenueCat: file.settings.revenueCat || usesRevenueCat(app.repoPath) });
  let f = file;
  const created: string[] = [];
  for (const input of inputs) {
    const t = await withBacklog(backlogFile(app), (b) => {
      const r = createTicket(b, input, now);
      return { backlog: rankBacklog(r.backlog, now).backlog, result: r.ticket };
    });
    f = addLog({ ...f, tickets: { ...f.tickets, [input.source.key!]: t.id } }, `Added ${t.id}: ${input.title}.`, now);
    created.push(t.id);
  }
  return { file: f, created };
}

export async function moneyPass(app: AppEntry, profile: AppProfile, deps: MoneyPassDeps, log: (text: string, credits?: number) => void, now: Date): Promise<MoneyReport> {
  const report: MoneyReport = { verified: 0, retrying: 0, strategy: "none", productsCreated: [], ticketsCreated: [], testsStarted: [], skipped: [] };
  if (appKind(app.repoPath) !== "react-native") return report;
  let file = loadAppMoney(app);
  if (!file.settings.enabled) return report;
  const ids = storeIdsFromRepo(app.repoPath);
  const stores = { ios: Boolean(ids.bundleId), android: Boolean(ids.packageName) };
  const idBase = ids.bundleId ?? ids.packageName ?? app.id;

  // 1. Verification queue.
  try {
    const q = await drainQueue(app.id, await deps.verify());
    report.verified = q.done;
    report.retrying = q.retrying;
    if (q.failed) log(`${q.failed} store notification${q.failed === 1 ? "" : "s"} couldn't be checked after many tries — see Money → Revenue.`);
  } catch (err) {
    report.skipped.push(`verification: ${(err as Error).message}`);
  }

  // 2 + 3. Ad revenue and the daily snapshot (users, variants, sources from the field store).
  const kpisDue = !file.kpis || now.getTime() - Date.parse(file.kpis.at) >= KPI_EVERY_MS;
  let users = file.kpis?.users ?? 0;
  if (kpisDue) {
    const known = await knownUsers(app, deps.store, now, 30);
    const ads = adRevenueRecords(known.events);
    if (ads.length) await deps.ledger.record(app.id, ads);
    const records = await deps.ledger.records(app.id, new Date(now.getTime() - 30 * DAY));
    file = { ...file, kpis: computeKpis({ records, users: known.users, currency: file.settings.currency, days: 30, now }) };
    users = known.users.length;
  }

  // 4. Strategy.
  const proposed = proposedStrategy(file);
  if (!proposed && strategyDue(file, users, now)) {
    const minors = minorsHint(profile.targetUsers, profile.brand?.audience.primary, profile.purpose);
    if (users < NOT_YET_USERS) {
      if (!file.strategies.length || currentStrategy(file)?.verdict !== "not_yet" || now.getTime() - Date.parse(file.strategies[0]!.at) >= 60 * DAY) {
        file = addLog({ ...file, strategies: [notYet(users, now, minors), ...file.strategies.map((s) => (s.status === "approved" && s.verdict === "not_yet" ? { ...s, status: "superseded" as const } : s))] }, `Not planning prices yet: ${users} identified users in 30 days.`, now);
        report.strategy = "not_yet";
      }
    } else {
      const known = await moneyKnowledge(app, now);
      if (known.blocked.blocked) report.skipped.push(`money strategy: ${known.blocked.why}`);
      else try {
        const snap = await deps.store.retention(app.id).catch(() => null);
        const r = await deps.research({
          memory: known.memory,
          avoid: known.avoid,
          worked: known.worked,
          appName: app.name,
          purpose: profile.purpose,
          targetUsers: profile.targetUsers,
          featureMap: profile.featureMap.join(", "),
          businessModel: profile.businessModel,
          brandBrief: renderBrandBrief(profile.brand ?? null),
          users,
          rhythm: snap?.rhythm ?? null,
          d7: snap?.rates.new ?? null,
          currency: file.settings.currency,
          baseRegion: file.settings.baseRegion,
          existing: existing(app.repoPath),
          minorsHint: minors,
          excerpts: excerpts(app.repoPath),
        });
        if (r.result) {
          file = propose(file, await dropDeclined(app, r.result, now), { users, rhythm: snap?.rhythm ?? null, credits: r.credits, now }).file;
          report.strategy = "proposed";
          log(`Proposed how ${app.name} earns (${r.result.models.join(" + ") || "not yet"}), from how ${r.result.leaders.map((l) => l.app).slice(0, 3).join(", ")} do it. It waits for your approval on the Money page.`, r.credits);
        } else log("Couldn't verify how leading apps of this kind earn this time — day2 proposes nothing rather than guess.", r.credits);
      } catch (err) {
        const why = err instanceof CreditsError ? err.message : (err as Error).message;
        report.skipped.push(`money strategy: ${why}`);
      }
    }
  } else if (currentStrategy(file)) report.strategy = "kept";

  // 5. The approved strategy in the stores and the app.
  const s = currentStrategy(file);
  if (s && s.verdict === "monetize") {
    try {
      const catalogs = await deps.catalogs();
      const r = await applyProducts(file, { ...catalogs, bundleId: ids.bundleId, packageName: ids.packageName, locale: localeOf(app.repoPath) ?? file.settings.locale, groupName: `${app.name} subscriptions`, now });
      file = r.file;
      report.productsCreated.push(...r.created);
      for (const c of r.created) log(`Created ${c}.`);
    } catch (err) {
      report.skipped.push(`products: ${(err as Error).message}`);
    }
    const t = await ensureTickets(app, file, s, now);
    file = t.file;
    report.ticketsCreated.push(...t.created);
    for (const id of t.created) log(`Added ${id} to build what the approved plan needs in the app.`);

    // 6. Tests once the paywall is in the app.
    const backlog = await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
    const paywallLive = backlog.tickets.some((x) => x.source.key === PAYWALL_KEY && x.state === "done");
    if (paywallLive) {
      const avoid = new Set((await moneyKnowledge(app, now)).avoid);
      const next = nextTest(file, { idBase, stores, now, skip: (kind, key) => avoid.has(`money.test:${testTarget({ kind, keys: [key] })}`) });
      if (next) {
        file = addTest(next.file, next.test, now);
        log(`Planned a test: ${next.test.title} (revenue per user, with D7 retention as a guardrail).`);
      }
    }
    try {
      const synced = await syncTests(app, file, deps.experiments, now);
      file = synced.file;
      report.testsStarted.push(...synced.started);
      if (!deps.experiments && file.tests.some((x) => x.state === "proposed")) report.skipped.push("tests: waiting for Live's experiments engine");
    } catch (err) {
      report.skipped.push(`tests: ${(err as Error).message}`);
    }
  }
  saveAppMoney(app, file);
  return report;
}

/** The app's main locale for store listings (app.json expo.locales or the default), e.g. "de-DE". */
export function localeOf(repoPath: string): string | null {
  try {
    const p = join(repoPath, "app.json");
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf-8")) as { expo?: { locales?: Record<string, unknown>; extra?: { day2?: { locale?: string } } } };
      const l = j.expo?.extra?.day2?.locale ?? Object.keys(j.expo?.locales ?? {})[0];
      if (l) return l.includes("-") ? l : ({ de: "de-DE", en: "en-US", fr: "fr-FR", es: "es-ES", it: "it" } as Record<string, string>)[l] ?? l;
    }
  } catch {
    /* none */
  }
  return null;
}
