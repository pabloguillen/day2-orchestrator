import { randomBytes } from "node:crypto";
import type { AppEntry } from "../apps-registry";
import type { NewTicketInput, TicketState } from "../backlog";
import type { CreditStore } from "../credits";
import { appConfigTicket, hasEasProject, setEasEnv, writeEasJson, type EnvValues } from "./app-config";
import { appleClientSecret, authPatch, emailTemplates, redirects, smtpFromUrl } from "./auth";
import { deployFunctions, deployWithCli, neededSecrets, readFunctions } from "./functions";
import { appliedVersions, applyPending, checkMigrations, databaseUrl, pushWithCli, readMigrations, type MigrationFile, type Runner } from "./migrations";
import { hasBranching, type OperatorConfig } from "./operator";
import { regionFor } from "./region";
import { storageSql } from "./storage";
import type { HostingSecrets, HostingStore } from "./store";
import { projectUrl, type SupabaseApi } from "./supabase";
import { backendTicketInput, findingTickets, migrationProblemTicket, typesTicket } from "./tickets";
import type { AppleSignIn, Finding, GoogleSignIn, HostEnv, HostingPlan, HostingState, ProjectRecord, ProjectStatus, SmtpSettings, Step } from "./types";
import { STEPS } from "./types";

/**
 * Setting up an app's backend, step by step (types.ts STEPS). Each step is
 * done once and remembered, so a restart or a failure picks up where it
 * stopped; calling it again when everything is done only refreshes keys.
 */

export type HostingDeps = {
  store: HostingStore;
  secrets: HostingSecrets;
  operator: OperatorConfig | null;
  /** A Management API client for a token (supabase.ts; a fake in tests). */
  api: (token: string) => SupabaseApi;
  /** Creates a backlog ticket once per source key (or returns the open one). */
  ticket: (input: NewTicketInput) => Promise<{ id: string; state: TicketState }>;
  /** Subprocesses for the CLI fallbacks and eas env:set. */
  run: Runner;
  /** The app's Expo token (Releases page), for EAS environment variables. */
  expoToken: () => Promise<string | null>;
  credits?: CreditStore;
  /** For the Apple / Google connection tests. */
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a new project to come up (default 15 minutes). */
  waitMs?: number;
};

export class HostingError extends Error {
  constructor(
    message: string,
    public code: "not_configured" | "not_enabled" | "starting" | "failed" | "blocked" = "failed",
  ) {
    super(message);
  }
}

const nowOf = (d: HostingDeps) => (d.now ? d.now() : new Date());
const sleepOf = (d: HostingDeps) => d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

export function log(s: HostingState, at: Date, text: string, credits?: number): void {
  s.log.unshift({ at: at.toISOString(), text, ...(credits ? { credits } : {}) });
}

/** The token that manages this app's projects: day2's, or the owner's after a takeover. */
export async function tokenFor(appId: string, project: ProjectRecord | undefined, deps: HostingDeps): Promise<string> {
  if (project?.managedBy === "owner") {
    const t = await deps.secrets.get<{ token: string }>(appId, "owner_token");
    if (!t) throw new HostingError("The project moved to your own Supabase organization, but day2 has no access token for it — add one on the Hosting page.", "not_configured");
    return t.token;
  }
  if (!deps.operator) throw new HostingError("Hosting isn't set up on this day2 server yet (SUPABASE_ACCESS_TOKEN, DAY2_SUPABASE_ORG_ID).", "not_configured");
  return deps.operator.token;
}

export async function apiFor(app: AppEntry, env: HostEnv, deps: HostingDeps): Promise<{ api: SupabaseApi; project: ProjectRecord | undefined; state: HostingState }> {
  const state = await deps.store.state(app.id);
  const project = state.projects[env];
  return { api: deps.api(await tokenFor(app.id, project ?? state.projects.production, deps)), project, state };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";
/** Unique per app (names of different accounts' apps can be the same). */
export const projectName = (app: AppEntry, env: HostEnv) => `${slug(app.name)}-${app.id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}${env === "staging" ? "-staging" : ""}`;

/** Pure. The plan with its region decided. */
export function settlePlan(plan: HostingPlan, fallback: OperatorConfig["defaultRegion"]): HostingPlan {
  return { ...plan, region: plan.region ?? regionFor(plan.audience, fallback) };
}

async function smtpFor(appId: string, deps: HostingDeps): Promise<{ settings: SmtpSettings | null; who: HostingState["auth"]["smtp"] }> {
  const own = await deps.secrets.get<SmtpSettings>(appId, "smtp");
  if (own) return { settings: own, who: "owner" };
  if (deps.operator?.smtp) {
    try {
      return { settings: smtpFromUrl(deps.operator.smtp.url, deps.operator.smtp.from), who: "day2" };
    } catch {
      /* misconfigured: fall back to Supabase's sender */
    }
  }
  return { settings: null, who: "supabase" };
}

/** Applies the auth settings (also after the owner adds Apple/Google or an email sender). */
export async function configureAuth(app: AppEntry, env: HostEnv, deps: HostingDeps): Promise<void> {
  const { api, project, state } = await apiFor(app, env, deps);
  if (!project || !state.plan) throw new HostingError("The backend isn't set up yet.", "not_enabled");
  const now = nowOf(deps);
  const smtp = await smtpFor(app.id, deps);
  const apple = await deps.secrets.get<AppleSignIn>(app.id, "apple");
  const google = await deps.secrets.get<GoogleSignIn>(app.id, "google");
  const appleIds = [apple?.servicesId, state.plan.bundleId].filter((x): x is string => Boolean(x));
  const appleSecret = apple?.servicesId ? appleClientSecret(apple, apple.servicesId, now) : null;
  const patch = authPatch({ appName: app.name, plan: state.plan, env, appBaseUrl: app.appBaseUrl ?? null, smtp: smtp.settings, apple: apple && appleIds.length ? { clientIds: appleIds, secret: appleSecret?.jwt ?? null } : null, google });
  await api.updateAuthConfig(project.ref, patch);
  const r = redirects(state.plan, env, app.appBaseUrl ?? null);
  await deps.store.update(app.id, (s) => {
    s.auth.siteUrl = r.siteUrl;
    s.auth.redirectUrls = r.redirectUrls;
    s.auth.templatesLang = emailTemplates(app.name, state.plan!.language).lang;
    s.auth.smtp = smtp.who;
    if (state.plan!.auth.apple) s.auth.apple = apple ? { ...s.auth.apple, state: s.auth.apple.state === "failed" ? "failed" : "connected", renewBy: appleSecret?.expiresAt ? new Date(Date.parse(appleSecret.expiresAt) - 30 * 86_400_000).toISOString() : null } : { ...s.auth.apple, state: "needs_setup" };
    if (state.plan!.auth.google) s.auth.google = google ? { ...s.auth.google, state: s.auth.google.state === "failed" ? "failed" : "connected" } : { ...s.auth.google, state: "needs_setup" };
    if (state.plan!.auth.email && smtp.who === "supabase") s.problem = { text: "Email sign-in only reaches your own team until an email sender is set up (Supabase's built-in sender is for testing: 2 emails an hour).", at: now.toISOString() };
    else if (s.problem?.text.startsWith("Email sign-in only")) s.problem = null;
  });
}

export type MigrationOutcome = { env: string; applied: string[]; pending: string[]; blocked: string[]; failed: { version: string; error: string } | null; via: "api" | "cli" | null };

/**
 * Applies the app's pending migrations to one database. `dir` is the
 * checkout to read them from (default: the app's repo). Production refuses
 * migrations that break the rules (a ticket says why).
 */
export async function migrate(app: AppEntry, target: { env: HostEnv } | { pr: number; ref: string }, deps: HostingDeps, dir = app.repoPath): Promise<MigrationOutcome> {
  const env = "env" in target ? target.env : "production";
  const label = "env" in target ? target.env : (`pr-${target.pr}` as const);
  const { api, project, state } = await apiFor(app, env, deps);
  const ref = "ref" in target ? target.ref : project?.ref;
  if (!ref) throw new HostingError(`There's no ${env} database yet.`, "not_enabled");
  const now = nowOf(deps);
  const all = readMigrations(dir);
  // The SQL endpoint is beta: when it's unavailable (not when the SQL is wrong), the CLI does the same job.
  const outage = (msg: string) => /: (404|5\d\d) /.test(msg) || /can't be reached/.test(msg);
  let applied: Set<string> | null = null;
  try {
    applied = await appliedVersions(api, ref);
  } catch (err) {
    if (!outage((err as Error).message) || !("env" in target)) throw new HostingError(`Couldn't read which migrations are applied (${(err as Error).message}).`);
  }
  // Without the history (outage): what day2 itself recorded as applied there.
  const known = applied ?? new Set(state.migrations.filter((m) => m.env === label && m.ok).map((m) => m.version));
  const pending = all.filter((m) => !known.has(m.version));
  const out: MigrationOutcome = { env: label, applied: [], pending: pending.map((m) => m.file), blocked: [], failed: null, via: null };
  if (!pending.length) return out;
  if (label === "production") {
    const problems = checkMigrations(all, pending);
    if (problems.length) {
      const t = await deps.ticket(migrationProblemTicket(problems));
      out.blocked = problems.map((p) => p.text);
      await deps.store.update(app.id, (s) => {
        s.problem = { text: `Database changes are waiting: ${problems[0]!.text} (${t.id})`, at: now.toISOString() };
        log(s, now, `Held back ${pending.length} database change${pending.length === 1 ? "" : "s"} for production — ${t.id} says why.`);
      });
      return out;
    }
  }
  type Result = { applied: Array<{ version: string; name: string }>; failed: { version: string; name: string; error: string } | null; via: "api" | "cli" };
  let r: Result | null = applied ? await applyPending(api, ref, pending) : null;
  if ((!r || (r.failed && r.applied.length === 0 && outage(r.failed.error))) && "env" in target) {
    const pw = await deps.secrets.get<{ password: string }>(app.id, `db_password:${env}`);
    const pooler = pw ? (await api.pooler(ref).catch(() => []))[0] : undefined;
    if (pw && pooler) {
      const cli = await pushWithCli(deps.run, dir, databaseUrl(pooler.connection_string, pw.password), { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });
      r = cli.ok ? { applied: pending.map((m) => ({ version: m.version, name: m.name })), failed: null, via: "cli" } : { applied: [], failed: { version: pending[0]!.version, name: pending[0]!.name, error: cli.error }, via: "cli" };
    }
  }
  if (!r) throw new HostingError("Supabase's SQL endpoint isn't answering and the CLI fallback has no database password or address.");
  out.applied = r.applied.map((a) => a.version);
  out.failed = r.failed ? { version: r.failed.version, error: r.failed.error } : null;
  out.via = r.via;
  const done = r;
  await deps.store.update(app.id, (s) => {
    for (const a of done.applied) s.migrations.push({ env: label, version: a.version, name: a.name, at: now.toISOString(), via: done.via, ok: true });
    if (done.failed) s.migrations.push({ env: label, version: done.failed.version, name: done.failed.name, at: now.toISOString(), via: done.via, ok: false, error: done.failed.error });
    if (label === "production" && s.problem?.text.startsWith("Database changes are waiting")) s.problem = null;
    const p = s.projects[env];
    if (p && "env" in target) p.lastUsedAt = now.toISOString();
    log(s, now, done.failed ? `A database change failed on ${label}: ${done.failed.name} (${done.failed.error.slice(0, 120)}).` : `Applied ${done.applied.length} database change${done.applied.length === 1 ? "" : "s"} to ${label}.`);
  });
  return out;
}

/** Supabase's security and performance advisors → findings (and tickets for production). */
export async function runAdvisors(app: AppEntry, env: HostEnv, deps: HostingDeps): Promise<Finding[]> {
  const { api, project } = await apiFor(app, env, deps);
  if (!project) return [];
  const now = nowOf(deps);
  const findings: Finding[] = [];
  for (const kind of ["security", "performance"] as const) {
    const lints = await api.advisors(project.ref, kind).catch(() => []);
    for (const l of lints) {
      findings.push({ key: l.cache_key, kind, name: l.name, level: l.level, title: l.title, detail: l.detail, remediation: l.remediation, table: l.metadata?.name ?? null, ticketId: null, seenAt: now.toISOString() });
    }
  }
  if (env === "production") {
    for (const t of findingTickets(findings)) {
      const made = await deps.ticket(t.input);
      for (const f of findings) if (t.names.includes(f.key)) f.ticketId = made.id;
    }
  }
  await deps.store.update(app.id, (s) => {
    if (env === "production") {
      s.findings = findings;
      s.findingsAt = now.toISOString();
    }
  });
  return findings;
}

async function envValues(state: HostingState): Promise<{ production: EnvValues | null; staging: EnvValues | null }> {
  const v = (p: ProjectRecord | undefined) => (p?.publishableKey ? { url: p.url, key: p.publishableKey } : null);
  return { production: v(state.projects.production), staging: v(state.projects.staging) };
}

/** eas.json (in the repo for a new app, else a ticket) and EAS environment variables. */
export async function writeAppConfig(app: AppEntry, deps: HostingDeps, mode: "repo" | "ticket"): Promise<void> {
  const state = await deps.store.state(app.id);
  const { production, staging } = await envValues(state);
  if (!production) return;
  let easJson: "written" | "pending" | "failed" = "pending";
  let note: string | null = null;
  try {
    if (mode === "repo") {
      writeEasJson(app.repoPath, production, staging);
      easJson = "written";
    } else {
      const t = await deps.ticket(appConfigTicket(production, staging));
      easJson = t.state === "done" ? "written" : "pending";
      note = `eas.json: ${t.id}`;
    }
  } catch (err) {
    easJson = "failed";
    note = (err as Error).message.slice(0, 200);
  }
  let easEnv: "set" | "skipped" | "failed" = "skipped";
  const token = await deps.expoToken();
  if (token && hasEasProject(app.repoPath)) {
    const a = await setEasEnv(deps.run, app.repoPath, token, "production", production);
    const b = a.ok ? await setEasEnv(deps.run, app.repoPath, token, "preview", staging ?? production) : a;
    easEnv = a.ok && b.ok ? "set" : "failed";
    if (!b.ok) note = `EAS environment variables: ${b.error}`;
  } else note = note ?? (token ? "EAS environment variables: the app isn't linked to an EAS project yet (after the first build)." : "EAS environment variables: connect Expo on the Releases page.");
  await deps.store.update(app.id, (s) => {
    s.appConfig = { easJson, easEnv, note };
  });
}

/** One environment, from nothing to ready. Returns the project. */
export async function ensureEnv(app: AppEntry, env: HostEnv, deps: HostingDeps, opts: { config: "repo" | "ticket" } = { config: "ticket" }): Promise<ProjectRecord> {
  const op = deps.operator;
  let state = await deps.store.state(app.id);
  if (!state.plan) throw new HostingError("Hosting isn't switched on for this app.", "not_enabled");
  const plan = state.plan;
  const done = new Set(state.done[env] ?? []);
  const mark = async (step: Step, fn?: (s: HostingState) => void) => {
    done.add(step);
    state = await deps.store.update(app.id, (s) => {
      s.done[env] = STEPS.filter((x) => done.has(x));
      s.working = null;
      fn?.(s);
    });
  };
  const working = (step: Step) => deps.store.update(app.id, (s) => {
    s.working = { env, step, since: nowOf(deps).toISOString() };
  });

  for (const step of STEPS) {
    if (done.has(step)) continue;
    if (env === "staging" && (step === "advisors" || step === "app_config" || step === "ticket")) {
      await mark(step);
      continue;
    }
    await working(step);
    const now = nowOf(deps);
    try {
      if (step === "project") {
        if (!op) throw new HostingError("Hosting isn't set up on this day2 server yet.", "not_configured");
        const api = deps.api(op.token);
        const region = plan.region!;
        const size = plan.instanceSize ?? op.instanceSize;
        const name = projectName(app, env);
        // A crash right after creating it: the project exists with the password already stored — adopt it.
        const earlier = (await deps.secrets.get(app.id, `db_password:${env}`)) ? (await api.orgProjects(op.orgSlug, name).catch(() => [])).find((x) => x.name === name && !x.is_branch && x.status !== "REMOVED") : undefined;
        let p: { ref: string; name: string; status: ProjectStatus };
        if (earlier) p = { ref: earlier.ref, name: earlier.name, status: earlier.status };
        else {
          const password = randomBytes(24).toString("base64url");
          await deps.secrets.set(app.id, `db_password:${env}`, { password }, `Database password (${env})`);
          p = await api.createProject({ name, organization_slug: op.orgSlug, db_pass: password, region, desired_instance_size: size });
        }
        const branching = state.branching === "unknown" ? ((await hasBranching(api, op.orgSlug, (await api.organization(op.orgSlug).catch(() => ({ plan: "unknown" }))).plan ?? "unknown")) ? "available" : "unavailable") : state.branching;
        await mark(step, (s) => {
          s.projects[env] = { env, ref: p.ref, name: p.name, region, orgSlug: op.orgSlug, status: p.status, url: projectUrl(p.ref), publishableKey: null, instanceSize: size, createdAt: now.toISOString(), managedBy: "day2", lastUsedAt: now.toISOString() };
          s.branching = branching;
          log(s, now, `Created the ${env} backend in ${region}.`);
        });
      } else if (step === "healthy") {
        const { api, project } = await apiFor(app, env, deps);
        const deadline = Date.now() + (deps.waitMs ?? 15 * 60_000);
        let status = project!.status;
        for (;;) {
          status = (await api.project(project!.ref)).status;
          if (status === "ACTIVE_HEALTHY") {
            const services = await api.health(project!.ref).catch(() => []);
            if (services.length && services.every((x) => x.status === "ACTIVE_HEALTHY")) break;
          }
          if (status === "INIT_FAILED") throw new HostingError("Supabase couldn't start the project (INIT_FAILED). day2 will try again.");
          if (Date.now() >= deadline) throw new HostingError("The backend is still starting — day2 checks again shortly.", "starting");
          await sleepOf(deps)(10_000);
        }
        await mark(step, (s) => {
          s.projects[env]!.status = status;
        });
      } else if (step === "keys") {
        const { api, project } = await apiFor(app, env, deps);
        let keys = await api.apiKeys(project!.ref);
        let pub = keys.find((k) => k.type === "publishable") ?? keys.find((k) => k.name === "anon");
        if (!pub?.api_key) {
          pub = await api.createApiKey(project!.ref, "publishable", "day2-app");
          keys = [...keys, pub];
        }
        let sec = keys.find((k) => k.type === "secret") ?? keys.find((k) => k.name === "service_role");
        if (!sec?.api_key) sec = await api.createApiKey(project!.ref, "secret", "day2-server");
        await deps.secrets.set(app.id, `secret_key:${env}`, { key: sec.api_key }, `Secret key (${env})`);
        await mark(step, (s) => {
          s.projects[env]!.publishableKey = pub!.api_key ?? null;
        });
      } else if (step === "auth") {
        await configureAuth(app, env, deps);
        await mark(step);
      } else if (step === "storage") {
        if (plan.buckets.length) {
          const { api, project } = await apiFor(app, env, deps);
          await api.query(project!.ref, storageSql(plan.buckets));
        }
        await mark(step, (s) => {
          s.buckets = plan.buckets.map((b) => b.name);
        });
      } else if (step === "migrations") {
        await migrate(app, { env }, deps);
        await mark(step);
      } else if (step === "functions") {
        const fns = readFunctions(app.repoPath);
        const { api, project } = await apiFor(app, env, deps);
        const r = await deployFunctions(api, project!.ref, fns);
        for (const f of [...r.failed]) {
          const token = await tokenFor(app.id, project, deps);
          const cli = await deployWithCli(deps.run, app.repoPath, project!.ref, f.slug, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SUPABASE_ACCESS_TOKEN: token });
          if (cli.ok) {
            r.failed.splice(r.failed.indexOf(f), 1);
            r.deployed.push({ slug: f.slug, version: 0 });
          }
        }
        const have = await api.secretNames(project!.ref).catch(() => [] as string[]);
        const missing = neededSecrets(app.repoPath).filter((n) => !have.includes(n));
        await mark(step, (s) => {
          s.functions = r.deployed.map((d) => ({ slug: d.slug, version: d.version, at: now.toISOString() }));
          if (r.failed.length) s.problem = { text: `Edge function ${r.failed[0]!.slug} didn't deploy: ${r.failed[0]!.error}`, at: now.toISOString() };
          else if (missing.length && !s.problem) s.problem = { text: `The edge functions need secrets you haven't added yet: ${missing.join(", ")}.`, at: now.toISOString() };
          if (r.deployed.length) log(s, now, `Deployed ${r.deployed.length} edge function${r.deployed.length === 1 ? "" : "s"} to ${env}.`);
        });
      } else if (step === "advisors") {
        await runAdvisors(app, env, deps);
        await mark(step);
      } else if (step === "app_config") {
        await writeAppConfig(app, deps, opts.config);
        await mark(step);
      } else if (step === "ticket") {
        const id = await backendTicket(app, deps);
        await mark(step, (s) => {
          s.backendTicket = id;
        });
      }
    } catch (err) {
      await deps.store.update(app.id, (s) => {
        s.working = null;
        if (!(err instanceof HostingError && err.code === "starting")) s.problem = { text: `Setting up the ${env} backend stopped at "${step}": ${(err as Error).message.slice(0, 300)}`, at: now.toISOString() };
      });
      throw err instanceof HostingError ? err : new HostingError((err as Error).message);
    }
  }
  return (await deps.store.state(app.id)).projects[env]!;
}

/** Wakes a paused environment; its "healthy" step runs again. */
export async function resumeEnv(app: AppEntry, env: HostEnv, deps: HostingDeps): Promise<void> {
  const { api, project } = await apiFor(app, env, deps);
  if (!project?.pausedAt) return;
  await api.restore(project.ref);
  const now = nowOf(deps);
  await deps.store.update(app.id, (s) => {
    const p = s.projects[env]!;
    p.pausedAt = null;
    p.status = "RESTORING";
    p.lastUsedAt = now.toISOString();
    s.done[env] = (s.done[env] ?? []).filter((x) => x !== "healthy");
    log(s, now, `Woke the ${env} backend.`);
  });
}

/** The hosted-backend ticket, with generated types when the database already has tables. */
export async function backendTicket(app: AppEntry, deps: HostingDeps): Promise<string> {
  const state = await deps.store.state(app.id);
  if (!state.plan) throw new HostingError("Hosting isn't switched on for this app.", "not_enabled");
  let types: string | null = null;
  const prod = state.projects.production;
  if (prod) {
    const { api } = await apiFor(app, "production", deps);
    types = (await api.typescriptTypes(prod.ref).catch(() => null))?.types ?? null;
  }
  const t = await deps.ticket(backendTicketInput({ appName: app.name, plan: state.plan, types }));
  return t.id;
}

/** New types after the schema changed (staging/production), once per migration version. */
export async function typesAfter(app: AppEntry, env: HostEnv, version: string, deps: HostingDeps): Promise<string | null> {
  const { api, project } = await apiFor(app, env, deps);
  if (!project) return null;
  const types = (await api.typescriptTypes(project.ref).catch(() => null))?.types;
  if (!types) return null;
  return (await deps.ticket(typesTicket(types, version))).id;
}

export type { MigrationFile };
