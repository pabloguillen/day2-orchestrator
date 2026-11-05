import type { AppEntry } from "../apps-registry";
import { currentTenant } from "../tenant";
import { eligibility } from "./eligibility";
import { previewForPr, releaseMigrations, type GateResult } from "./environments";
import { deployFunctions, readFunctions } from "./functions";
import { checkMigrations, readMigrations, type MigrationProblem } from "./migrations";
import { apiFor, backendTicket, ensureEnv, HostingError, log, migrate, settlePlan, type HostingDeps, type MigrationOutcome } from "./provision";
import { hostingDeps } from "./runtime";
import type { Bucket, HostEnv, HostingPlan } from "./types";

/**
 * Hosting's entry points for the rest of day2 — Create calls these after
 * its build step wrote the app's backend adapter (docs/expo-apps.md,
 * "Hosting"); the Hosting page and the backlog timer use the same code.
 * Every function takes optional `deps` (tests inject fakes; nothing here
 * talks to Supabase without them in tests).
 */

export { HostingError } from "./provision";
export type { HostingPlan, Bucket } from "./types";
export { hostingPass } from "./operations";
export { hostingAll } from "./runtime";
export { eligibility } from "./eligibility";
export { monthlyEstimate } from "./operations";
export { regionFor } from "./region";
export { hostingNativePackages } from "./native";
export { REGION_PLACE } from "./types";
export { operatorConfig, hostingEnabled } from "./operator";
export { writeEasJson, URL_VAR, KEY_VAR, type EnvValues } from "./app-config";
export type { HostingDeps } from "./provision";
export type { Region, HostEnv } from "./types";

const depsFor = (app: AppEntry, deps?: HostingDeps) => deps ?? hostingDeps(currentTenant() ?? null, app);

/**
 * The app's production backend: creates it the first time (region from the
 * audience, generated database password and secret key kept encrypted,
 * sign-in, buckets, migrations, functions, advisors, eas.json, the
 * hosted-backend ticket) and returns where it is. Calling it again returns
 * the same project. `config: "repo"` (default) writes eas.json in the app's
 * checkout — right for Create before its first push; "ticket" asks the
 * build agent instead.
 */
export async function ensureHosting(app: AppEntry, plan: HostingPlan, opts: { config?: "repo" | "ticket"; deps?: HostingDeps } = {}): Promise<{ projectRef: string; url: string; publishableKey: string }> {
  const deps = depsFor(app, opts.deps);
  if (!deps.operator) throw new HostingError("Hosting isn't set up on this day2 server (SUPABASE_ACCESS_TOKEN, DAY2_SUPABASE_ORG_ID).", "not_configured");
  const e = eligibility(app.repoPath);
  if (!e.eligible && e.why === "own_backend") throw new HostingError(`This app already has a backend (${e.backend}); day2 doesn't move it automatically.`, "blocked");
  const settled = settlePlan(plan, deps.operator.defaultRegion);
  await deps.store.update(app.id, (s) => {
    if (!s.enabled) log(s, deps.now?.() ?? new Date(), `Hosting switched on: the backend lives in ${settled.region}.`);
    s.enabled = true;
    // The region can't change once the project exists.
    s.plan = s.projects.production ? { ...settled, region: s.projects.production.region } : settled;
  });
  const p = await ensureEnv(app, "production", deps, { config: opts.config ?? "repo" });
  if (!p.publishableKey) throw new HostingError("The backend is up but has no publishable key yet.");
  return { projectRef: p.ref, url: p.url, publishableKey: p.publishableKey };
}

/** The build agent's ticket for the hosted side of src/backend/ (once per app; returns the existing one after). */
export async function hostedBackendTicket(app: AppEntry, deps?: HostingDeps): Promise<{ id: string }> {
  const d = depsFor(app, deps);
  const id = await backendTicket(app, d);
  await d.store.update(app.id, (s) => {
    s.backendTicket = id;
  });
  return { id };
}

/**
 * The app's pending migrations on one environment. Production goes through
 * the release rules (checked on a preview or staging first, RLS on every
 * table, expand before contract); `{ pr }` makes or reuses that pull
 * request's preview database. `dir`: a checkout to read migrations from.
 */
export async function applyMigrations(app: AppEntry, env: HostEnv | { pr: number }, opts: { dir?: string; deps?: HostingDeps } = {}): Promise<MigrationOutcome | GateResult | null> {
  const deps = depsFor(app, opts.deps);
  const dir = opts.dir ?? app.repoPath;
  if (typeof env === "object") {
    const p = await previewForPr(app, env.pr, dir, deps);
    return p ? { env: `pr-${env.pr}`, applied: [], pending: [], blocked: [], failed: p.migrations === "failed" ? { version: "", error: p.error ?? "failed" } : null, via: "api" } : null;
  }
  if (env === "production") return releaseMigrations(app, dir, deps);
  await ensureEnv(app, "staging", deps);
  return migrate(app, { env: "staging" }, deps, dir);
}

/** Before a release ships (mobile-release): production migrations, after their check. */
export async function beforeRelease(app: AppEntry, dir: string, deps?: HostingDeps): Promise<GateResult> {
  const d = depsFor(app, deps);
  if (!d.operator && !(await d.store.state(app.id)).enabled) return { ok: true, applied: [] };
  return releaseMigrations(app, dir, d);
}

/**
 * Pure. A hosting plan from Create's product plan and request: sign-in when
 * the plan has accounts (Apple on iOS, Google), a bucket when it stores
 * files, realtime when it says so.
 */
export function hostingPlanFrom(o: {
  plan: { accounts: boolean; data: Array<{ name: string; fields: string[]; where: "device" | "server" }> };
  ids: { scheme: string; bundleId: string };
  platforms: Array<"ios" | "android">;
  language?: string;
  audience?: { countries?: string[]; locales?: string[] };
  realtime?: boolean;
}): HostingPlan {
  const server = o.plan.data.filter((d) => d.where === "server");
  const fileLike = server.some((d) => d.fields.some((f) => /photo|image|picture|file|avatar|attachment|receipt|video|audio|document|bild|foto|datei/i.test(f)));
  const buckets: Bucket[] = fileLike ? [{ name: "uploads", public: false, maxBytes: 20 * 1024 * 1024 }] : [];
  return {
    language: o.language ?? "en",
    ...(o.audience ? { audience: o.audience } : {}),
    auth: { email: o.plan.accounts, apple: o.plan.accounts && o.platforms.includes("ios"), google: o.plan.accounts },
    buckets,
    realtime: o.realtime ?? server.some((d) => d.fields.some((f) => /live|chat|message|presence|realtime/i.test(f))),
    scheme: o.ids.scheme,
    bundleId: o.ids.bundleId,
  };
}

/** Pure-ish. What production refuses in a checkout's migrations (no RLS, unmarked destructive changes) — checked before anything is applied. */
export function migrationProblems(dir: string): MigrationProblem[] {
  const all = readMigrations(dir);
  return checkMigrations(all, all);
}

/**
 * Deploys the edge functions in a checkout's supabase/functions/ to one
 * environment (setup deploys what exists then; Create calls this after its
 * build agent wrote them). Failures come back, they don't throw.
 */
export async function deployAppFunctions(app: AppEntry, env: HostEnv, opts: { dir?: string; deps?: HostingDeps } = {}): Promise<{ deployed: string[]; failed: Array<{ slug: string; error: string }> }> {
  const deps = depsFor(app, opts.deps);
  const fns = readFunctions(opts.dir ?? app.repoPath);
  if (!fns.length) return { deployed: [], failed: [] };
  const { api, project } = await apiFor(app, env, deps);
  if (!project) throw new HostingError(`There's no ${env} backend yet.`, "not_enabled");
  const r = await deployFunctions(api, project.ref, fns);
  const now = deps.now?.() ?? new Date();
  await deps.store.update(app.id, (s) => {
    if (env === "production") s.functions = [...s.functions.filter((f) => !r.deployed.some((d) => d.slug === f.slug)), ...r.deployed.map((d) => ({ slug: d.slug, version: d.version, at: now.toISOString() }))];
    if (r.deployed.length) log(s, now, `Deployed ${r.deployed.length} edge function${r.deployed.length === 1 ? "" : "s"} to ${env}.`);
    if (r.failed.length) s.problem = { text: `Edge function ${r.failed[0]!.slug} didn't deploy to ${env}: ${r.failed[0]!.error}`, at: now.toISOString() };
  });
  return { deployed: r.deployed.map((d) => d.slug), failed: r.failed };
}
