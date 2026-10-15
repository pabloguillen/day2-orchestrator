import { allApps } from "./apps-store";
import { loadBacklog } from "./backlog";
import { backlogFile, syncAppTrackers, tick } from "./backlog-work";
import { db } from "./db";
import { gatherSignalsForApp } from "./health-scout-cli";
import type { AppEntry } from "./apps-registry";
import { fieldStore, ingestKeys, loadAccountTenant, localTenant, runAsTenant, serverMode, type Tenant } from "./tenant";
import { authConfig } from "./auth";
import { fieldSignals, installItem, refreshContracts } from "./field-work";
/**
 * Keeps every app's backlog moving. The API server does this on its own
 * every DAY2_BACKLOG_TICK_MINUTES (default 15); by hand:
 *
 *   bun run backlog tick            # all apps
 *   bun run backlog tick --app <id> # one app
 *   bun run backlog tick --no-start # import, rank, sync, but start nothing
 *
 * Each pass imports new Sentry/health/proposal findings, re-ranks, picks up
 * merged or closed PRs, syncs JIRA/Linear, and — within the owner's
 * "Start on its own" and in-progress limit — starts work. All agent work is
 * paid from the account's credits like everything else.
 */
export async function work(): Promise<Array<{ tenant: Tenant; app: AppEntry }>> {
  if (serverMode() === "local") {
    const t = localTenant();
    return (await t.apps.list()).map((app) => ({ tenant: t, app }));
  }
  const out: Array<{ tenant: Tenant; app: AppEntry }> = [];
  const tenants = new Map<string, Tenant | null>();
  for (const { accountId, app } of await allApps(db())) {
    if (!tenants.has(accountId)) tenants.set(accountId, await loadAccountTenant(accountId));
    const tenant = tenants.get(accountId);
    if (tenant) out.push({ tenant, app });
  }
  return out;
}

/** One pass over every app (every account's, in accounts mode). The API
 * server runs this on a timer; the CLI below runs it once. */
export async function tickAll(opts: { only?: string; startWork: boolean }): Promise<void> {
  const { only, startWork } = opts;
  for (const { tenant, app } of await work()) {
    if (only && app.id !== only) continue;
    // Each app's work runs as its own account: charged to that account's
    // credits, using that account's GitHub access and tracker connections.
    await runAsTenant(tenant, async () => {
      try {
        const sentry = loadBacklog(backlogFile(app)).settings.sentry;
        const field = fieldStore();
        // The app's field contracts follow its code.
        const contracts = await refreshContracts(app, field).catch((err: Error) => {
          console.warn(`[day2-field] ${app.name}: couldn't generate contracts: ${err.message}`);
          return null;
        });
        const report = await tick(app, {
          startWork,
          gatherSignals: async () => [
            ...(await gatherSignalsForApp({
              id: app.id,
              appBaseUrl: app.appBaseUrl,
              ...(sentry && process.env.SENTRY_AUTH_TOKEN ? { sentryOrg: sentry.org, sentryProject: sentry.project } : {}),
            })),
            ...(await fieldSignals(app, field)),
          ],
          extraItems: async () => {
            if (await field.meta(app.id)) return []; // already reporting
            const item = installItem(app, { key: await ingestKeys().forApp(app.id), endpoint: authConfig().publicUrl, candidates: contracts?.candidates ?? [] });
            return item ? [item] : [];
          },
        });
        const sync = await syncAppTrackers(app, tenant.integrations);
        console.log(
          `[day2-backlog] ${app.name}: ${report.created.length} new, ${report.updated.length} updated, ${report.reranked} re-ranked, ` +
            `${report.reconciled.length} PRs settled, ${report.started.length} started${sync.length ? ` · ${sync.join(" · ")}` : ""}`,
        );
      } catch (err) {
        // One app's failure doesn't stop the others.
        console.error(`[day2-backlog] ${app.name}: ${(err as Error).message}`);
      }
    });
  }
}

async function main(args: string[]): Promise<void> {
  if (args[0] !== "tick") throw new Error("Usage: bun run backlog tick [--app <id>] [--no-start]");
  await tickAll({ only: args.includes("--app") ? args[args.indexOf("--app") + 1] : undefined, startWork: !args.includes("--no-start") });
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
