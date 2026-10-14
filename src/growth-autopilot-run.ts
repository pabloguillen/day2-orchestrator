import type { AppEntry } from "./apps-registry";
import { work } from "./backlog-cli";
import { metaAdsViaAgent } from "./ads";
import { fetchAppEvents } from "./app-events";
import { researchCompetitorDistributionAngles } from "./competitor-feed";
import { authConfig } from "./auth";
import { connectorMcpServers, findConnector } from "./connectors";
import { authorize, CreditsError } from "./credits";
import { autopilotPass, type AutopilotDeps } from "./growth-autopilot";
import { GROWTH_CONFIG_FILENAME, loadGrowthConfig } from "./growth-config";
import { deriveGrowthStrategy, fetchStageSignals } from "./growth-strategy";
import { withCreditContext, type CreditContext } from "./metered-query";
import type { AppProfile } from "./onboarding";
import { adIdentities, platformTools, runAsTenant, type Tenant } from "./tenant";
import { resolve } from "node:path";

/**
 * Runs the growth autopilot (growth-autopilot.ts) for every app, each as its
 * own account — charged to that account's credits — with day2's own tools.
 * Called by the API server's timer; one app's failure never stops the rest.
 */

const RESEARCH_MAX_USD = 1;
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
    events: (a, since) => fetchAppEvents(a.appBaseUrl, since),
  };
}

export async function autopilotAll(): Promise<void> {
  for (const { tenant, app } of await work()) {
    await runAsTenant(tenant, async () => {
      try {
        const r = await autopilotPass(app, await autopilotDeps(tenant, app));
        const did = [
          r.ticketsCreated.length && `${r.ticketsCreated.length} growth tickets`,
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
    });
  }
}
