import type { AppEntry } from "./apps-registry";
import { hasStores, refreshAppLinks, smartLink, storeScreenshots } from "./ads/app-links";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { work } from "./backlog-cli";
import { metaAdsViaAgent } from "./ads";
import { researchCompetitorDistributionAngles } from "./competitor-feed";
import { authConfig } from "./auth";
import { connectorMcpServers, findConnector } from "./connectors";
import { authorize, CreditsError } from "./credits";
import { AUTOPILOT_FILENAME, autopilotPass, loadAutopilot, type AutopilotDeps } from "./growth-autopilot";
import { benchmarkGrowthFeatures } from "./growth-optimizer";
import { GROWTH_CONFIG_FILENAME, loadGrowthConfig } from "./growth-config";
import { deriveGrowthStrategy, fetchStageSignals } from "./growth-strategy";
import { withCreditContext, type CreditContext } from "./metered-query";
import type { AppProfile } from "./onboarding";
import { adIdentities, fieldStore, platformTools, runAsTenant, type Tenant } from "./tenant";
import { appEvents, appKind, pageHealth } from "./field-work";
import { checkHandoff, handoffTicket } from "./ads/destination";
import { createTicket, rankBacklog, withBacklog } from "./backlog";
import { backlogFile } from "./backlog-work";
import { resolve } from "node:path";
import { researchRetention } from "./retention";
import { resolvePlatforms } from "./ads/registry";
import { adsVideoProviders } from "./creative/kit";
import { recheckIdentities } from "./ads/connect-flow";
import { refreshRates } from "./ads/fx";
import { CRASH_CONTRACT, USER_DAY_DAYS } from "./field-store";
import { liveStore } from "./live/runtime";
import { IDEAS_MAX_USD, proposeIdeas } from "./live/ideas";
import { adConnections, assetStore, platformIdentities, releaseCredentials, sentConversions } from "./tenant";
import { messagesStore, pushTokens } from "./messages/runtime";
import { draftTexts, reviewTexts } from "./messages/texts";
import { moneyPassDeps } from "./money/run";
import { storeDeps } from "./store-listing/deps";
import { numbersDaily } from "./numbers/run";
import { captureMemory, chargedRunner } from "./memory/runtime";
import { socialPassFor } from "./social/runtime";

/**
 * Runs the growth autopilot (growth-autopilot.ts) for every app, each as its
 * own account — charged to that account's credits — with day2's own tools.
 * Called by the API server's timer; one app's failure never stops the rest.
 */

const RESEARCH_MAX_USD = 1;
const BENCHMARK_MAX_USD = 1.5;
const MESSAGE_TEXTS_MAX_USD = 1;
const callbackUrl = () => `${authConfig().publicUrl}/api/connectors/callback`;

export async function autopilotDeps(tenant: Tenant, app: AppEntry): Promise<AutopilotDeps> {
  const tools = platformTools();
  const metaServers = await connectorMcpServers(tools, ["ad_platform"], callbackUrl());
  return {
    credits: tenant.credits,
    async research(topic) {
      const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service: "scan_answer", maxCostUsd: RESEARCH_MAX_USD });
      if (!check.ok) throw new CreditsError(check);
      const servers = await connectorMcpServers(tools, ["competitor_research"], callbackUrl());
      const names = Object.keys(servers).map((id) => findConnector(id)?.name ?? id);
      const ctx: CreditContext = { appId: app.id, appName: app.name, service: "scan_answer", description: "Market research (autopilot)" };
      const findings = await withCreditContext(ctx, () => researchCompetitorDistributionAngles(topic, Object.keys(servers).length ? servers : undefined, names));
      return { findings, usedTools: names, credits: ctx.charged ?? 0 };
    },
    async benchmark(input) {
      const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service: "scan_answer", maxCostUsd: BENCHMARK_MAX_USD });
      if (!check.ok) throw new CreditsError(check);
      const ctx: CreditContext = { appId: app.id, appName: app.name, service: "scan_answer", description: "Growth features vs. leading apps (autopilot)" };
      const result = await withCreditContext(ctx, () => benchmarkGrowthFeatures(input));
      return { result, credits: ctx.charged ?? 0 };
    },
    async paidGate(a: AppEntry, profile: AppProfile) {
      if (!a.appBaseUrl) return { unlocked: false, reason: "the app's live address isn't set, so day2 can't see whether people stick around" };
      try {
        const config = loadGrowthConfig(resolve(a.repoPath, GROWTH_CONFIG_FILENAME));
        const s = deriveGrowthStrategy(config.budget, profile, await fetchStageSignals(a.appBaseUrl), config.kpiGoals);
        return { unlocked: s.paidAcquisitionUnlocked, reason: s.unlockBasis };
      } catch (err) {
        return { unlocked: false, reason: `couldn't read the app's usage (${(err as Error).message.slice(0, 120)})` };
      }
    },
    ads: Object.keys(metaServers).length ? metaAdsViaAgent(metaServers) : null,
    adAccountId: process.env.DAY2_META_AD_ACCOUNT_ID?.trim() || null,
    metaPageId: async (appId) => (await adIdentities().get(appId))?.metaPageId ?? null,
    events: (a, since) => appEvents(a, since, fieldStore()),
    pageHealth: (a, path) => pageHealth(a, path, fieldStore()),
    platformAds: await (async () => {
      await refreshRates();
      const store = adConnections();
      // Pages/profiles waiting on the owner's approval: ready yet?
      await recheckIdentities({ store, identities: platformIdentities() }, app.id).catch(() => []);
      const resolved = await resolvePlatforms(app.id, store);
      const ids = [...resolved.keys()];
      return {
        platforms: new Map(ids.map((id) => [id, resolved.get(id)!.adapter])),
        infos: new Map(ids.map((id) => [id, resolved.get(id)!.info])),
        accounts: new Map(ids.map((id) => [id, { billing: resolved.get(id)!.billing, currency: resolved.get(id)!.currency }])),
        identities: platformIdentities(),
        assets: assetStore(),
        providers: await adsVideoProviders(tenant.accountId, app, tenant.credits).catch(() => ({ presenter: null, generated: null })),
        sentConversions: sentConversions(),
        users: async (a: AppEntry) => (await fieldStore().activity(a.id, new Date(Date.now() - USER_DAY_DAYS * 86_400_000).toISOString().slice(0, 10))).users,
        retention: (a: AppEntry) => fieldStore().retention(a.id),
        ...(await (async () => {
          // Apps in the App Store / Google Play: ads can lead straight to the stores through day2's smart link,
          // or to the website, which then sends phones on to the stores (the owner's choice, ads/destination.ts).
          if (appKind(app.repoPath) !== "react-native") return {};
          const links = await refreshAppLinks(app.repoPath, new Date()).catch(() => null);
          if (!links || !hasStores(links)) return {};
          const pub = authConfig().publicUrl;
          return {
            storeLink: smartLink(pub, app.id),
            storeScreens: () => storeScreenshots(links, join(tmpdir(), `day2-store-shots-${app.id}`)),
            handoff: {
              pageOk: (url: string) => checkHandoff(url, pub, app.id),
              async ensure() {
                if (!pub.startsWith("https://")) return { ready: false, ticketId: null, why: "day2 needs its public https address (DAY2_PUBLIC_URL) before the website can load its handoff script" };
                if (app.appBaseUrl && (await checkHandoff(app.appBaseUrl, pub, app.id))) return { ready: true, ticketId: null, why: null };
                const input = handoffTicket(app, pub, links);
                const t = await withBacklog(backlogFile(app), (b) => {
                  const have = b.tickets.find((x) => x.source.key === input.source.key && x.state !== "parked");
                  if (have) return { backlog: b, result: have };
                  const now = new Date();
                  const r = createTicket(b, input, now);
                  return { backlog: rankBacklog(r.backlog, now).backlog, result: r.ticket };
                });
                return { ready: false, ticketId: t.id, why: t.state === "done" ? "the website change is merged but the live website doesn't load day2's handoff script yet (is it deployed?)" : "the website doesn't send phones on to the App Store / Google Play yet" };
              },
            },
          };
        })()),
      };
    })(),
    live: {
      store: liveStore(),
      events: (since) => fieldStore().events(app.id, since),
      crashes: async (since) => (await fieldStore().failures(app.id, CRASH_CONTRACT, 5000)).filter((f) => f.at >= since.toISOString()).map((f) => ({ deviceId: f.deviceId, at: f.at })),
      releaseDevices: async (keys, since) => (await fieldStore().releaseHealth(app.id, keys, since)).reduce((n, h) => n + h.devices, 0),
      retention: () => fieldStore().retention(app.id),
      async ideas(input) {
        const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service: "agent_work", maxCostUsd: IDEAS_MAX_USD });
        if (!check.ok) throw new CreditsError(check);
        const ctx: CreditContext = { appId: app.id, appName: app.name, service: "agent_work", description: "Live experiment ideas (autopilot)" };
        const ideas = await withCreditContext(ctx, () => proposeIdeas(input));
        return { ideas, credits: ctx.charged ?? 0 };
      },
    },
    money: moneyPassDeps(tenant, app),
    ...(appKind(app.repoPath) === "react-native" ? { store: await storeDeps(tenant, app) } : {}),
    retention: {
      store: fieldStore(),
      async research(input) {
        const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service: "scan_answer", maxCostUsd: BENCHMARK_MAX_USD });
        if (!check.ok) throw new CreditsError(check);
        const ctx: CreditContext = { appId: app.id, appName: app.name, service: "scan_answer", description: "Retention research (autopilot)" };
        const result = await withCreditContext(ctx, () => researchRetention(input));
        return { result, credits: ctx.charged ?? 0 };
      },
    },
    messages: {
      store: messagesStore(),
      tokens: pushTokens(),
      field: fieldStore(),
      expo: { fetch: (url, init) => fetch(url, init), accessToken: async () => (await releaseCredentials().get(app.id, "expo"))?.value.token ?? null },
      async write(input) {
        const check = await authorize(tenant.credits, { appId: app.id, appName: app.name, service: "content_generation", maxCostUsd: MESSAGE_TEXTS_MAX_USD });
        if (!check.ok) throw new CreditsError(check);
        const ctx: CreditContext = { appId: app.id, appName: app.name, service: "content_generation", description: "Message texts (autopilot)" };
        const result = await withCreditContext(ctx, async () => {
          const draft = await draftTexts(input);
          return { draft, review: draft ? await reviewTexts(draft.texts, draft.claims, input) : null };
        });
        return { ...result, credits: ctx.charged ?? 0 };
      },
    },
  };
}

export async function autopilotAll(): Promise<void> {
  for (const { tenant, app } of await work()) {
    await runAsTenant(tenant, async () => {
      try {
        const r = await autopilotPass(app, await autopilotDeps(tenant, app));
        const did = [
          r.ticketsCreated.length && `${r.ticketsCreated.length} growth tickets`,
          r.benchmarked && "compared with leading apps",
          r.improvementsCreated.length && `${r.improvementsCreated.length} improvements`,
          r.retentionTickets.length && `${r.retentionTickets.length} retention and message tickets`,
          r.liveTickets.length && `${r.liveTickets.length} Live tickets`,
          r.liveDecided.length && `${r.liveDecided.length} experiments decided`,
          r.moneyTickets.length && `${r.moneyTickets.length} money tickets`,
          r.undone.length && `${r.undone.length} changes to undo`,
          r.researched && "research",
          r.experimentsCreated.length && `${r.experimentsCreated.length} experiments`,
          r.launched.length && `${r.launched.length} ads launched`,
          r.paused.length && `${r.paused.length} ads paused`,
          r.scaled.length && `${r.scaled.length} ads scaled`,
        ].filter(Boolean);
        if (did.length) console.log(`[day2-autopilot] ${app.name}: ${did.join(", ")}`);
      } catch (err) {
        console.error(`[day2-autopilot] ${app.name}: ${(err as Error).message}`);
      }
      // Social: make posts when due (autopilot on), publish approved ones at their time, read results.
      try {
        const on = loadAutopilot(resolve(app.repoPath, AUTOPILOT_FILENAME)).enabled;
        const r = await socialPassFor(tenant, app, { make: on });
        const did = r && [r.made.length && `${r.made.length} new post${r.made.length === 1 ? "" : "s"}`, r.publish?.published.length && `${r.publish.published.length} published`, r.publish?.failed.length && `${r.publish.failed.length} failed`, r.feedback?.collected && `${r.feedback.collected} results read`].filter(Boolean);
        if (did?.length) console.log(`[day2-social] ${app.name}: ${did.join(", ")}`);
      } catch (err) {
        console.error(`[day2-social] ${app.name}: ${(err as Error).message}`);
      }
      // Numbers: what the stores reported, once a day (read-only; runs even with the autopilot off).
      try {
        const r = await numbersDaily(app);
        if (r?.notes.length) console.log(`[day2-numbers] ${app.name}: ${r.notes.join(" ")}`);
      } catch (err) {
        console.error(`[day2-numbers] ${app.name}: ${(err as Error).message}`);
      }
      // The memory keeper: new owner input distilled into what day2 knows, at most hourly.
      try {
        const m = await captureMemory(app, chargedRunner(tenant, app));
        if (m.added) console.log(`[day2-memory] ${app.name}: learned ${m.added} thing${m.added === 1 ? "" : "s"} from the owner's input.`);
      } catch (err) {
        console.error(`[day2-memory] ${app.name}: ${(err as Error).message}`);
      }
    });
  }
}
