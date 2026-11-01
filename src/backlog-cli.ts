import { allApps } from "./apps-store";
import { runReleases } from "./mobile-release/run";
import { createTicket, findTicket, loadBacklog, putTicket, updateTicket, withBacklog } from "./backlog";
import { openTurnOnPr, syncCheckout, TURN_ON_KEY } from "./field-turn-on";
import { backlogFile, isOrphan, syncAppTrackers, tick } from "./backlog-work";
import { db } from "./db";
import { gatherSignalsForApp } from "./health-scout-cli";
import type { AppEntry } from "./apps-registry";
import type { IncomingItem } from "./backlog";
import { fieldStore, ingestKeys, loadAccountTenant, localTenant, runAsTenant, serverMode, type Tenant } from "./tenant";
import { authConfig } from "./auth";
import { existingIntegration, fieldSignals, INSTALL_KEY, installItem, refreshContracts } from "./field-work";
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
        // Read the app as it is on GitHub now, not as it was when day2 last looked.
        await syncCheckout(app.repoPath);
        const sentry = loadBacklog(backlogFile(app)).settings.sentry;
        const field = fieldStore();
        // The app's field contracts follow its code.
        const contracts = await refreshContracts(app, field).catch((err: Error) => {
          console.warn(`[day2-field] ${app.name}: couldn't generate contracts: ${err.message}`);
          return null;
        });
        await retireInstallTicket(app, async () => installItem(app, { key: await ingestKeys().forApp(app.id), endpoint: authConfig().publicUrl, candidates: contracts?.candidates ?? [] }));
        await proposeTurnOn(app).catch((err: Error) => console.warn(`[day2-field] ${app.name}: couldn't open the pull request that turns day2 on: ${err.message}`));
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
        // Mobile apps: ship what's merged (over-the-air update or store release).
        if (startWork) await runReleases(app).catch((err: Error) => console.warn(`[day2-release] ${app.name}: ${err.message}`));
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

/**
 * An install ticket that shouldn't be built (yet): the app already has day2
 * wired in by hand, or day2 has no public address, so the app would get a
 * local one. Not started yet → parked with the reason; the launch checklist
 * says what's left.
 */
async function retireInstallTicket(app: AppEntry, fresh: () => Promise<IncomingItem | null>): Promise<void> {
  const existing = existingIntegration(app.repoPath);
  const local = !authConfig().publicUrl.startsWith("https://");
  if (!existing && !local) {
    // Public now: an install ticket parked for having a local address comes back, with the public one.
    const item = await fresh();
    if (!item) return;
    await withBacklog(backlogFile(app), (b) => {
      const t = b.tickets.find((x) => x.source.key === INSTALL_KEY && x.state === "parked" && /endpoint: "http:\/\//.test(x.description));
      if (!t) return { backlog: b, result: null };
      const moved = updateTicket(b, t.id, { state: "todo", description: item.description ?? t.description, doneWhen: item.doneWhen ?? t.doneWhen }, new Date(), { kind: "day2" });
      return { backlog: moved.backlog, result: null };
    });
    return;
  }
  const why = existing
    ? `parked: the app already starts day2 in ${existing.file}, so a second copy isn't needed — see the launch checklist on Home for what's left.`
    : "parked: day2 has no public address yet, so users' phones couldn't reach it — see the launch checklist on Home.";
  await withBacklog(backlogFile(app), (b) => {
    // Not started yet, or left in Doing by a restart (it would start again right away otherwise).
    const now = new Date();
    const t = b.tickets.find((x) => x.source.key === INSTALL_KEY && (x.state === "todo" || isOrphan(app.id, x, now)));
    if (!t) return { backlog: b, result: null };
    const moved = updateTicket(b, t.id, { state: "parked" }, new Date(), { kind: "day2" });
    const cur = findTicket(moved.backlog, t.id)!;
    return { backlog: putTicket(moved.backlog, { ...cur, activity: [...cur.activity, { at: new Date().toISOString(), actor: "day2", kind: "work", text: why }] }), result: null };
  });
}

/**
 * day2 wired in by hand, off until release builds get its settings: day2
 * opens the pull request that sets them (field-turn-on.ts), once, as a
 * ticket waiting for the owner's approval.
 */
async function proposeTurnOn(app: AppEntry): Promise<void> {
  const pub = authConfig().publicUrl;
  if (!pub.startsWith("https://")) return;
  const ex = existingIntegration(app.repoPath);
  if (!ex?.envKey || ex.envSetForRelease) return;
  const have = loadBacklog(backlogFile(app)).tickets.find((t) => t.source.key === TURN_ON_KEY);
  if (have) return; // once — merged, waiting, or declined
  const pr = await openTurnOnPr(app, ex, await ingestKeys().forApp(app.id), pub);
  if (!pr) return;
  const now = new Date();
  await withBacklog(backlogFile(app), (b) => {
    if (b.tickets.some((t) => t.source.key === TURN_ON_KEY)) return { backlog: b, result: null };
    const r = createTicket(b, { title: "Turn on day2 in release builds", type: "task", description: `day2 is in the app (${ex.file}) but off until release builds get its key and address. The pull request sets them in eas.json.`, doneWhen: ["eas.json's production build profile sets the day2 key and address"], priority: 1, prioritySource: "day2", source: { kind: "day2_proposal", key: TURN_ON_KEY }, actor: "day2", createdNote: "Needed before the next release." }, now);
    const moved = updateTicket(r.backlog, r.ticket.id, { state: "to_approve" }, now, { kind: "day2" });
    return { backlog: putTicket(moved.backlog, { ...moved.ticket, approval: { kind: "pr", number: pr.number, url: pr.url }, activity: [...moved.ticket.activity, { at: now.toISOString(), actor: "day2", kind: "work", text: `opened PR #${pr.number} — approve it and the next release build reports to day2.` }] }), result: null };
  });
}

