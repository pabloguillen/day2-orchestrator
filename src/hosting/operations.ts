import type { AppEntry } from "../apps-registry";
import { creditsForCost, recordCharge } from "../credits";
import { closePreviews, previewForPr } from "./environments";
import { apiFor, configureAuth, ensureEnv, log, resumeEnv, runAdvisors, type HostingDeps } from "./provision";

export { resumeEnv };
import type { Addon, SupabaseApi } from "./supabase";
import { alertTicket } from "./tickets";
import type { HealthSnapshot, HostEnv, HostingState, ProjectRecord, UsageDay } from "./types";
import { STEPS } from "./types";

/**
 * Keeping an app's backend healthy and paid for, on the backlog timer:
 *  - every hour: status, database size, connections, requests, egress and
 *    edge function errors → alert tickets when a limit comes close;
 *  - every day: the day's cost as credits (service `infra`, the usual
 *    markup; owners only ever see credits), backups, the advisors, pause
 *    rules, and a fresh Apple sign-in secret before the old one runs out.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const GB = 1024 ** 3;

/**
 * Supabase's list prices day2 passes on (pricing page, November 2026 —
 * check current prices before relying on them; the compute price comes from
 * the project's own billing add-ons when the API returns it).
 */
export const RATES = {
  /** Compute when the add-ons don't say: Micro, $10/month. */
  computeMonthlyUsd: 10,
  /** Database size included per project on Pro, and the price beyond it. */
  includedDbGb: 8,
  dbGbMonthUsd: 0.125,
  egressGbUsd: 0.09,
  storageGbMonthUsd: 0.0213,
  functionMillionUsd: 2,
  /** A preview branch, per hour. */
  branchHourUsd: 0.01344,
};

/**
 * Pure. What hosting one app is expected to cost a month, as credits (the
 * owner never sees money): its production compute (Micro unless the plan
 * says otherwise). Usage beyond what's included (database over 8 GB, files,
 * data sent, function calls) and preview databases come on top — rarely
 * anything for a new app. Shown before an app is created (Create's plan).
 */
export function monthlyEstimate(o: { computeMonthlyUsd?: number } = {}): { usd: number; credits: number } {
  const usd = o.computeMonthlyUsd ?? RATES.computeMonthlyUsd;
  return { usd, credits: creditsForCost(usd, "infra") };
}

/** Alerts at these shares of a limit. */
export const LIMITS = { db: 0.8, disk: 0.85, connections: 0.8, functionErrorShare: 0.05, functionErrorMin: 20 };

const nowOf = (d: HostingDeps) => (d.now ? d.now() : new Date());
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Pure. Compute cost per day from the project's add-ons (hourly or monthly price), else Micro. */
export function computePerDay(addons: Addon[] | null): number {
  const c = addons?.find((a) => a.type === "compute_instance");
  if (c?.variant.price.amount !== undefined) return c.variant.price.interval === "hourly" ? c.variant.price.amount * 24 : (c.variant.price.amount * 12) / 365;
  return (RATES.computeMonthlyUsd * 12) / 365;
}

/** Pure. One day's cost for one project, in parts. */
export function dailyCost(o: { addons: Addon[] | null; health: HealthSnapshot | null; previews: number }): { costUsd: number; parts: Record<string, number> } {
  const h = o.health;
  const parts: Record<string, number> = {
    compute: computePerDay(o.addons),
    database: Math.max(0, (h?.dbBytes ?? 0) / GB - RATES.includedDbGb) * (RATES.dbGbMonthUsd / 30),
    storage: ((h?.storageBytes ?? 0) / GB) * (RATES.storageGbMonthUsd / 30),
    egress: ((h?.egressBytes ?? 0) / GB) * RATES.egressGbUsd,
    functions: ((h?.functionInvocations ?? 0) / 1e6) * RATES.functionMillionUsd,
    previews: o.previews * 24 * RATES.branchHourUsd,
  };
  for (const k of Object.keys(parts)) parts[k] = Math.round(parts[k]! * 1e6) / 1e6;
  return { costUsd: Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 1e6) / 1e6, parts };
}

/** Pure. Which limits are close. */
export function alertsFrom(h: HealthSnapshot): Array<{ kind: "database" | "disk" | "connections" | "functions"; text: string }> {
  const out: Array<{ kind: "database" | "disk" | "connections" | "functions"; text: string }> = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (h.dbBytes !== null && h.dbBytes > LIMITS.db * RATES.includedDbGb * GB) out.push({ kind: "database", text: `The database holds ${(h.dbBytes / GB).toFixed(1)} GB of the ${RATES.includedDbGb} GB included; more is charged per GB.` });
  if (h.diskBytes && h.diskUsedBytes !== null && h.diskUsedBytes / h.diskBytes > LIMITS.disk) out.push({ kind: "disk", text: `The database disk is ${pct(h.diskUsedBytes / h.diskBytes)} full.` });
  if (h.connections !== null && h.maxConnections && h.connections / h.maxConnections > LIMITS.connections) out.push({ kind: "connections", text: `${h.connections} of ${h.maxConnections} database connections are in use.` });
  if (h.functionErrors !== null && h.functionInvocations && h.functionErrors >= LIMITS.functionErrorMin && h.functionErrors / h.functionInvocations > LIMITS.functionErrorShare) out.push({ kind: "functions", text: `${h.functionErrors} of ${h.functionInvocations} edge function calls failed in the last 24 hours.` });
  return out;
}

const STATS_SQL = `SELECT pg_database_size(current_database()) AS db,
  (SELECT count(*) FROM pg_stat_activity) AS conns,
  current_setting('max_connections')::int AS max_conns,
  (SELECT coalesce(sum((metadata->>'size')::bigint), 0) FROM storage.objects) AS storage,
  (SELECT count(*) FROM auth.users) AS users`;
/** Log queries (Supabase's log SQL). Not verified against real logs; a failure leaves the number empty. */
const FUNCTION_LOG_SQL = "select count(*) as invocations, countif(response.status_code >= 500) as errors from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.response) as response";
const EGRESS_LOG_SQL = "select sum(safe_cast(h.content_length as int64)) as bytes from edge_logs cross join unnest(metadata) as m cross join unnest(m.response) as r cross join unnest(r.headers) as h";

export async function healthOf(api: SupabaseApi, p: ProjectRecord, now: Date): Promise<HealthSnapshot> {
  const project = await api.project(p.ref);
  const services = project.status === "ACTIVE_HEALTHY" ? await api.health(p.ref).catch(() => []) : [];
  const disk = await api.diskUtil(p.ref).catch(() => null);
  const stats = project.status === "ACTIVE_HEALTHY" ? ((await api.query(p.ref, STATS_SQL, true).catch(() => []))[0] ?? null) : null;
  const counts = await api.apiCounts(p.ref, "1day").catch(() => null);
  const since = new Date(now.getTime() - DAY);
  const fn = (await api.logs(p.ref, FUNCTION_LOG_SQL, since, now).catch(() => null))?.result?.[0] ?? null;
  const eg = (await api.logs(p.ref, EGRESS_LOG_SQL, since, now).catch(() => null))?.result?.[0] ?? null;
  const rows = counts?.result ?? [];
  const sum = (k: "total_rest_requests" | "total_auth_requests" | "total_storage_requests" | "total_realtime_requests") => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    at: now.toISOString(),
    status: project.status,
    services: services.map((s) => ({ name: s.name, status: s.status })),
    dbBytes: num(stats?.db),
    diskBytes: disk?.metrics.fs_size_bytes ?? null,
    diskUsedBytes: disk?.metrics.fs_used_bytes ?? null,
    connections: num(stats?.conns),
    maxConnections: num(stats?.max_conns),
    requests: rows.length ? { rest: sum("total_rest_requests"), auth: sum("total_auth_requests"), storage: sum("total_storage_requests"), realtime: sum("total_realtime_requests") } : null,
    egressBytes: num(eg?.bytes),
    functionInvocations: num(fn?.invocations),
    functionErrors: num(fn?.errors),
    storageBytes: num(stats?.storage),
    authUsers: num(stats?.users),
  };
}

/** Hourly: health and alerts. */
export async function checkHealth(app: AppEntry, deps: HostingDeps): Promise<HealthSnapshot | null> {
  const { api, project } = await apiFor(app, "production", deps);
  if (!project) return null;
  const now = nowOf(deps);
  const h = await healthOf(api, project, now);
  const alerts = alertsFrom(h);
  const month = now.toISOString().slice(0, 7);
  const made: Array<{ key: string; id: string; text: string }> = [];
  for (const a of alerts) {
    const t = await deps.ticket(alertTicket(a.kind, a.text, month));
    made.push({ key: `${a.kind}:${month}`, id: t.id, text: a.text });
  }
  await deps.store.update(app.id, (s) => {
    s.health = h;
    if (s.projects.production) s.projects.production.status = h.status;
    for (const m of made) {
      if (s.alerts.some((x) => x.key === m.key)) continue;
      s.alerts.push({ key: m.key, at: now.toISOString(), ticketId: m.id, text: m.text });
      log(s, now, `${m.text} Added ${m.id}.`);
    }
  });
  return h;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily: bills the days since the last bill (at most 7 back) per
 * environment day2 pays for. Idempotent per app, environment and date.
 */
export async function billUsage(app: AppEntry, deps: HostingDeps): Promise<UsageDay[]> {
  const state = await deps.store.state(app.id);
  const now = nowOf(deps);
  const yesterday = day(new Date(now.getTime() - DAY));
  const out: UsageDay[] = [];
  for (const env of ["production", "staging"] as HostEnv[]) {
    const p = state.projects[env];
    if (!p || p.managedBy === "owner") continue; // after a takeover the owner pays Supabase directly
    const from = state.billedThrough[env] ?? day(new Date(Date.parse(p.createdAt) - DAY));
    if (from >= yesterday) continue;
    const { api } = await apiFor(app, env, deps);
    const addons = (await api.addons(p.ref).catch(() => null))?.selected_addons ?? null;
    const previews = env === "production" ? state.previews.filter((x) => x.branchId !== "staging").length : 0;
    let d = new Date(Math.max(Date.parse(from) + DAY, now.getTime() - 7 * DAY));
    while (day(d) <= yesterday) {
      const date = day(d);
      const paused = Boolean(p.pausedAt && p.pausedAt.slice(0, 10) <= date);
      const c = paused ? { costUsd: 0, parts: {} } : dailyCost({ addons, health: env === "production" ? state.health : null, previews });
      let credits = creditsForCost(c.costUsd, "infra");
      let charged = false;
      if (deps.credits && c.costUsd > 0) {
        const r = await recordCharge(deps.credits, { id: `hosting:${app.id}:${env}:${date}`, appId: app.id, service: "infra", costUsd: c.costUsd, description: `Hosting (${env === "production" ? "database, sign-in, files" : "staging"}) ${date}` }, now);
        // null: this day was already charged (same id).
        charged = r ? r.uncollectedCredits === 0 : true;
        if (r) credits = r.credits;
      }
      out.push({ date, env, costUsd: c.costUsd, credits, charged, parts: c.parts });
      d = new Date(d.getTime() + DAY);
    }
  }
  if (!out.length) return out;
  const short = out.filter((u) => !u.charged && u.costUsd > 0 && deps.credits);
  if (short.length) await deps.ticket(alertTicket("credits", `Hosting used more credits than the account has left (${short.map((u) => u.date).join(", ")}).`, now.toISOString().slice(0, 7)));
  await deps.store.update(app.id, (s) => {
    for (const u of out) {
      s.usage = [...s.usage.filter((x) => !(x.date === u.date && x.env === u.env)), u];
      if (!s.billedThrough[u.env] || s.billedThrough[u.env]! < u.date) s.billedThrough[u.env] = u.date;
    }
    const total = out.reduce((a, u) => a + u.credits, 0);
    if (total) log(s, now, `Hosting for ${out.length === 1 ? out[0]!.date : `${out.length} days`}.`, total);
  });
  return out;
}

export async function refreshBackups(app: AppEntry, deps: HostingDeps): Promise<void> {
  const { api, project } = await apiFor(app, "production", deps);
  if (!project) return;
  const b = await api.backups(project.ref);
  const done = b.backups.filter((x) => x.status === "COMPLETED").sort((x, y) => y.inserted_at.localeCompare(x.inserted_at));
  await deps.store.update(app.id, (s) => {
    s.backups = { at: nowOf(deps).toISOString(), pitr: b.pitr_enabled, daily: done.length, latest: done[0]?.inserted_at ?? null };
  });
}

/**
 * Pure. Pause rules:
 *  - production never pauses by itself (people use the app at any time; a
 *    paid organization doesn't pause it for inactivity either). Running out
 *    of credits makes a ticket and keeps it running; pausing is the owner's
 *    call on the Hosting page.
 *  - staging pauses after 7 days without use and wakes when a pull request
 *    or release needs it.
 */
export function pauseDecisions(state: HostingState, now: Date): Array<{ env: HostEnv; why: string }> {
  const s = state.projects.staging;
  if (!s || s.pausedAt || s.managedBy === "owner") return [];
  const last = Date.parse(s.lastUsedAt ?? s.createdAt);
  return now.getTime() - last >= 7 * DAY ? [{ env: "staging", why: "unused for a week" }] : [];
}

export async function pauseEnv(app: AppEntry, env: HostEnv, why: string, deps: HostingDeps): Promise<void> {
  const { api, project } = await apiFor(app, env, deps);
  if (!project || project.pausedAt) return;
  await api.pause(project.ref);
  const now = nowOf(deps);
  await deps.store.update(app.id, (s) => {
    s.projects[env]!.pausedAt = now.toISOString();
    s.projects[env]!.status = "PAUSING";
    log(s, now, `Paused the ${env} backend (${why}).`);
  });
}

export type PullRequest = { number: number; dir: string; touchesBackend: boolean; done: () => Promise<void> };

export type PassDeps = HostingDeps & {
  /** Open pull requests with a checkout of their head (optional). */
  pullRequests?: () => Promise<PullRequest[]>;
};

export type PassReport = { did: string[]; skipped: string[] };

/** One pass for one app: cheap when nothing is due. */
export async function hostingPass(app: AppEntry, deps: PassDeps): Promise<PassReport> {
  const report: PassReport = { did: [], skipped: [] };
  let state = await deps.store.state(app.id);
  if (!state.enabled || !state.plan) return report;
  const now = nowOf(deps);
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      report.did.push(name);
    } catch (err) {
      report.skipped.push(`${name}: ${(err as Error).message.slice(0, 200)}`);
    }
  };
  // Unfinished setup (a restart, a project still starting): carry on.
  const prodDone = state.done.production ?? [];
  if (!STEPS.every((x) => prodDone.includes(x))) {
    if (state.working && now.getTime() - Date.parse(state.working.since) < 20 * 60_000) return report;
    await step("setup", () => ensureEnv(app, "production", deps));
    state = await deps.store.state(app.id);
    if (!state.projects.production || !(state.done.production ?? []).includes("keys")) return report;
  }
  if (!state.health || now.getTime() - Date.parse(state.health.at) >= HOUR - 5 * 60_000) await step("health", () => checkHealth(app, deps));
  const lastBill = state.billedThrough.production;
  if (!lastBill || lastBill < day(new Date(now.getTime() - DAY))) await step("usage", () => billUsage(app, deps));
  if (!state.backups || now.getTime() - Date.parse(state.backups.at) >= DAY) await step("backups", () => refreshBackups(app, deps));
  if (!state.findingsAt || now.getTime() - Date.parse(state.findingsAt) >= DAY) await step("advisors", () => runAdvisors(app, "production", deps));
  if (state.auth.apple.renewBy && Date.parse(state.auth.apple.renewBy) <= now.getTime()) await step("apple sign-in secret", () => configureAuth(app, "production", deps));
  for (const d of pauseDecisions(state, now)) await step(`pause ${d.env}`, () => pauseEnv(app, d.env, d.why, deps));
  if (deps.pullRequests) {
    await step("previews", async () => {
      const prs = await deps.pullRequests!();
      try {
        for (const pr of prs.filter((p) => p.touchesBackend)) {
          const have = state.previews.find((p) => p.pr === pr.number);
          if (have && have.migrations !== "pending") continue;
          if (state.projects.staging?.pausedAt && state.branching !== "available") await resumeEnv(app, "staging", deps);
          await previewForPr(app, pr.number, pr.dir, deps);
        }
        if (state.branching === "available") await closePreviews(app, prs.map((p) => p.number), deps);
      } finally {
        await Promise.all(prs.map((p) => p.done().catch(() => undefined)));
      }
    });
  }
  return report;
}
