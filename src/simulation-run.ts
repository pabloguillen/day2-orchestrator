import { work } from "./backlog-cli";
import { authorize, recordCharge } from "./credits";
import { creditsEnabled } from "./metered-query";
import { appKind } from "./field-work";
import type { FieldStore } from "./field-store";
import { chromiumPath, simulate, type SimInput, type SimOutput } from "./simulation";
import { fieldStore, runAsTenant, type Tenant } from "./tenant";
import type { AppEntry } from "./apps-registry";

/**
 * Runs day2's simulation (simulation.ts) once a day for every web app that
 * has a live address and generated contracts. What it finds is recorded
 * like any field report — confirmed failures become tickets on the next
 * backlog pass. Billed as a little server time (infra) to the account.
 */

export const SIMULATION_EVERY_MS = 24 * 3_600_000;
/** Server time is cheap: about half a cent per minute of browser time (before markup). */
const USD_PER_MINUTE = 0.005;
/** The most a run can cost (its 5-minute budget). */
const MAX_COST_USD = 5 * USD_PER_MINUTE;

export type SimDeps = {
  store: FieldStore;
  run?: (input: SimInput) => Promise<SimOutput>;
  now?: Date;
};

export async function simulateApp(tenant: Tenant, app: AppEntry, deps: SimDeps): Promise<{ ran: boolean; reason: string }> {
  const now = deps.now ?? new Date();
  if (appKind(app.repoPath) !== "web") return { ran: false, reason: "not a web app" };
  if (!app.appBaseUrl) return { ran: false, reason: "no live address" };
  const contracts = await deps.store.contracts(app.id);
  if (!contracts) return { ran: false, reason: "no contracts yet" };
  const last = await deps.store.simulation(app.id);
  if (last && now.getTime() - Date.parse(last.at) < SIMULATION_EVERY_MS) return { ran: false, reason: "ran in the last day" };
  if (creditsEnabled()) {
    const ok = await authorize(tenant.credits, { appId: app.id, appName: app.name, service: "infra", maxCostUsd: MAX_COST_USD });
    if (!ok.ok) return { ran: false, reason: ok.reason };
  }
  const out = await (deps.run ?? simulate)({ baseUrl: app.appBaseUrl, contracts: contracts.file.contracts, now: () => now });
  for (const b of out.batches) await deps.store.record(app.id, b, now);
  await deps.store.setSimulation(app.id, out.run);
  const costUsd = Math.min(MAX_COST_USD, Math.max(0.001, (out.run.durationMs / 60_000) * USD_PER_MINUTE));
  if (creditsEnabled()) await recordCharge(tenant.credits, { id: `sim:${app.id}:${out.run.at.slice(0, 10)}`, appId: app.id, service: "infra", costUsd, description: "Daily simulation" });
  return { ran: true, reason: `${out.run.screens} screens, ${out.run.actions} actions, ${out.run.links} links on ${out.run.profiles.length} profiles: ${out.run.failures} confirmed problems` };
}

export async function simulateAll(): Promise<void> {
  if (!chromiumPath()) return; // no browser on this server
  for (const { tenant, app } of await work()) {
    await runAsTenant(tenant, async () => {
      try {
        const r = await simulateApp(tenant, app, { store: fieldStore() });
        if (r.ran) console.log(`[day2-simulation] ${app.name}: ${r.reason}`);
      } catch (err) {
        console.error(`[day2-simulation] ${app.name}: ${(err as Error).message}`);
      }
    });
  }
}
