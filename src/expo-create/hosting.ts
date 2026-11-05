import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { BACKLOG_FILENAME, findTicket, updateTicket, withBacklog, type NewTicketInput } from "../backlog";
import {
  applyMigrations,
  deployAppFunctions,
  ensureHosting,
  hostedBackendTicket,
  HostingError,
  hostingPlanFrom,
  KEY_VAR,
  migrationProblems,
  monthlyEstimate,
  REGION_PLACE,
  regionFor,
  URL_VAR,
  writeEasJson,
  type HostingDeps,
  type HostingPlan,
  type Region,
} from "../hosting";
import { hostingReasons, HOSTING_REASON_TEXT } from "./plan";
import type { BuildHosting, ExpoBuild, HostingDecision, ProductPlan } from "./types";

/**
 * Create ↔ Hosting (docs/expo-apps.md "Hosting", docs/hosting.md). The plan
 * decides whether the app needs a hosted backend (accounts, shared data,
 * files, server functions, live updates). When it does and the operator set
 * up Supabase, the backend step:
 *
 *   1. ensureHosting(hostingPlanFrom(plan))  production project, sign-in,
 *      buckets, eas.json — remembered step by step, so a restart resumes;
 *   2. a staging project (applyMigrations "staging") for the device checks;
 *   3. the build agent writes supabase/migrations (RLS on every table),
 *      edge functions and src/backend/hosted.ts, with Hosting's brief;
 *   4. migrations and functions to staging, .env with staging's values,
 *      eas.json with both — then the step's checks (devices against staging);
 *   5. after they pass: production through applyMigrations (the release
 *      rules), the functions, and the hosted-backend ticket marked done.
 *
 * Without Supabase configured the app keeps its in-memory backend and gets
 * a "Host with day2" follow-up (done page and a backlog ticket).
 */

export const HOST_WITH_DAY2_KEY = "create:host-with-day2";

/** The Create build as an app for Hosting (registered under the same id at onboard). */
export const appEntryFor = (b: Pick<ExpoBuild, "appId" | "request" | "at">, dir: string): AppEntry => ({ id: b.appId, name: b.request.name, repoPath: dir, connectionMethod: "local_path", addedAt: b.at });

/** Pure. Hosting's plan from Create's product plan. */
export function hostingPlanFor(b: Pick<ExpoBuild, "identifiers" | "request">, plan: ProductPlan): HostingPlan {
  return hostingPlanFrom({
    plan,
    ids: { scheme: b.identifiers.scheme, bundleId: b.identifiers.bundleId },
    platforms: b.request.platforms,
    language: plan.language,
    audience: { countries: plan.countries ?? [], locales: [plan.language] },
    ...(plan.realtime !== undefined ? { realtime: plan.realtime } : {}),
  });
}

/** Pure. The plan's hosting decision, as the owner sees it at the flow approval. */
export function decideHosting(b: Pick<ExpoBuild, "identifiers" | "request">, plan: ProductPlan, o: { configured: boolean; defaultRegion: Region }): HostingDecision {
  const reasons = hostingReasons(plan);
  if (!reasons.length) return { needed: false, reasons, configured: o.configured, region: null, place: null, monthlyCredits: 0 };
  const hp = hostingPlanFor(b, plan);
  const region = hp.region ?? regionFor(hp.audience, o.defaultRegion);
  return { needed: true, reasons, configured: o.configured, region, place: REGION_PLACE[region].en, monthlyCredits: monthlyEstimate().credits };
}

export type HostingRun =
  | { mode: "hosted"; app: AppEntry; deps: HostingDeps; brief: string; hosting: BuildHosting }
  | { mode: "local"; why: "not_needed" | "not_configured" | "failed"; hosting: BuildHosting };

const placeOf = (r: string | undefined) => (r && r in REGION_PLACE ? REGION_PLACE[r as Region].en : undefined);

/**
 * Before the backend step's agent: the production and staging backends
 * (idempotent — after a restart Hosting carries on from its last step).
 * Never throws: a setup that stops leaves the app on its local backend
 * (Hosting finishes it on its own timer once the app is registered).
 */
export async function prepareHosting(b: ExpoBuild, dir: string, depsFor: ((app: AppEntry) => HostingDeps | null) | undefined, onProgress: (text: string) => Promise<void>): Promise<HostingRun> {
  const plan = b.plan!;
  const reasons = hostingReasons(plan);
  if (!reasons.length) return { mode: "local", why: "not_needed", hosting: { state: "not_needed", note: "This app keeps everything on the phone: it needs no server." } };
  const app = appEntryFor(b, dir);
  const base = depsFor?.(app) ?? null;
  const decision = decideHosting(b, plan, { configured: Boolean(base?.operator), defaultRegion: base?.operator?.defaultRegion ?? "eu-central-1" });
  const why = reasons.map((r) => HOSTING_REASON_TEXT[r]).join(", ");
  if (!base?.operator) {
    return {
      mode: "local",
      why: "not_configured",
      hosting: {
        state: "not_configured",
        ...(decision.region ? { region: decision.region, place: decision.place ?? undefined } : {}),
        monthlyCredits: decision.monthlyCredits,
        note: `${b.request.displayName} needs a backend (${why}), but hosting isn't set up on this day2 server yet. For now its data stays on each phone, so it works for one person on one device. Once Supabase is set up for day2, press “Host with day2” on the app's Hosting page and day2 connects it.`,
      },
    };
  }
  // A build that already fell back keeps its local backend (its files are written for it).
  if (b.hosting?.state === "failed") return { mode: "local", why: "failed", hosting: b.hosting };
  // Hosting's brief for the build agent: the hosted-backend ticket's text (the ticket itself is created once).
  let brief = "";
  const deps: HostingDeps = {
    ...base,
    ticket: async (input: NewTicketInput) => {
      if (input.source.key === "hosting:backend") brief = [input.description ?? "", "", "Done when:", ...(input.doneWhen ?? []).map((d) => `- ${d}`)].join("\n");
      return base.ticket(input);
    },
  };
  // Hosting only offers itself to apps with Create's adapter folder.
  mkdirSync(join(dir, "src", "backend"), { recursive: true });
  try {
    await onProgress(`Setting up the backend in ${decision.place}`);
    let prod: { projectRef: string; url: string } | null = null;
    for (let i = 0; !prod; i++) {
      try {
        prod = await ensureHosting(app, hostingPlanFor(b, plan), { config: "repo", deps });
      } catch (err) {
        // A new project can take a while to start: wait a few more rounds.
        if (!(err instanceof HostingError && err.code === "starting") || i >= 3) throw err;
        await onProgress(`Waiting for the backend in ${decision.place} to start`);
      }
    }
    await onProgress("Setting up a test copy of the backend (staging)");
    await applyMigrations(app, "staging", { deps });
    const ticket = await hostedBackendTicket(app, deps);
    const s = await deps.store.state(app.id);
    const region = s.projects.production?.region ?? decision.region ?? undefined;
    return {
      mode: "hosted",
      app,
      deps,
      brief,
      hosting: { state: "setting_up", region, place: placeOf(region), projectRef: prod.projectRef, url: prod.url, stagingRef: s.projects.staging?.ref, monthlyCredits: decision.monthlyCredits, ticketId: ticket.id, note: "The backend is up; the app is being connected to it." },
    };
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    return {
      mode: "local",
      why: "failed",
      hosting: {
        state: "failed",
        ...(decision.region ? { region: decision.region, place: decision.place ?? undefined } : {}),
        monthlyCredits: decision.monthlyCredits,
        error: msg,
        note: `Setting up the backend stopped (${msg}). The app works with its data on the phone for now. day2 keeps trying on the app's Hosting page, and connects the app once the backend is up.`,
      },
    };
  }
}

/** The app's public backend values (staging for development and device checks, production for store builds). */
async function envValues(run: Extract<HostingRun, { mode: "hosted" }>) {
  const s = await run.deps.store.state(run.app.id);
  const v = (p: { url: string; publishableKey: string | null } | undefined) => (p?.publishableKey ? { url: p.url, key: p.publishableKey } : null);
  return { production: v(s.projects.production), staging: v(s.projects.staging) };
}

/**
 * After the agent, before the step's checks: the migrations' rules, then
 * migrations and functions on staging, and the env values (.env → staging,
 * eas.json → production for store builds). Returns what failed (null: fine).
 */
export async function hostingAfterAgent(run: Extract<HostingRun, { mode: "hosted" }>, dir: string): Promise<string | null> {
  const problems = migrationProblems(dir);
  if (problems.length) return `The database changes break day2's rules:\n${problems.map((p) => `- ${p.file}: ${p.text}`).join("\n")}`;
  try {
    const r = await applyMigrations(run.app, "staging", { dir, deps: run.deps });
    if (r && "failed" in r && r.failed) return `A database change failed on staging (${r.failed.version}): ${r.failed.error}`;
    const fns = await deployAppFunctions(run.app, "staging", { dir, deps: run.deps });
    if (fns.failed.length) return `An edge function didn't deploy to staging (${fns.failed[0]!.slug}): ${fns.failed[0]!.error}`;
    const { production, staging } = await envValues(run);
    if (staging) writeEnvFile(dir, staging);
    if (production) writeEasJson(dir, production, staging);
    return null;
  } catch (err) {
    return `Setting up the staging backend failed: ${(err as Error).message.slice(0, 500)}`;
  }
}

/** .env: staging's public values (Expo loads it for development and the device checks; eas.json's env wins in store builds). */
export function writeEnvFile(dir: string, v: { url: string; key: string }): void {
  const p = join(dir, ".env");
  const keep = (existsSync(p) ? readFileSync(p, "utf-8") : "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith(`${URL_VAR}=`) && !l.startsWith(`${KEY_VAR}=`) && !l.startsWith("# day2:"));
  writeFileSync(p, [...keep, "# day2: the staging backend (public values; store builds use eas.json)", `${URL_VAR}=${v.url}`, `${KEY_VAR}=${v.key}`, ""].join("\n"));
}

/**
 * After the step passed: production. Migrations go through Hosting's
 * release rules (they passed on staging), then the functions; the
 * hosted-backend ticket is done (the agent just built it). Never throws —
 * what's left waits for the first release (it applies production
 * migrations by itself).
 */
export async function hostingToProduction(run: Extract<HostingRun, { mode: "hosted" }>, dir: string): Promise<BuildHosting> {
  const notes: string[] = [];
  try {
    const gate = await applyMigrations(run.app, "production", { dir, deps: run.deps });
    if (gate && "ok" in gate && !gate.ok) notes.push(`The database changes reach production with the first release (${gate.why}).`);
    const fns = await deployAppFunctions(run.app, "production", { dir, deps: run.deps });
    if (fns.failed.length) notes.push(`The server function ${fns.failed[0]!.slug} didn't deploy yet — see the Hosting page.`);
  } catch (err) {
    notes.push(`Production waits for the first release (${(err as Error).message.slice(0, 200)}).`);
  }
  const id = run.hosting.ticketId;
  const file = join(dir, BACKLOG_FILENAME);
  if (id && existsSync(file)) {
    await withBacklog(file, (bl) => (findTicket(bl, id) && findTicket(bl, id)!.state !== "done" ? { backlog: updateTicket(bl, id, { state: "done" }, new Date(), { kind: "day2" }).backlog, result: null } : { backlog: bl, result: null })).catch(() => null);
  }
  return { ...run.hosting, state: "hosted", note: [`The backend runs on day2's Supabase in ${run.hosting.place ?? run.hosting.region}: the app signs in and keeps its data there.`, ...notes].join(" ") };
}

/** Pure. The "Host with day2" follow-up when Supabase isn't set up on this server. */
export function hostWithDay2Ticket(b: Pick<ExpoBuild, "request" | "plan">): NewTicketInput {
  const why = hostingReasons(b.plan!).map((r) => HOSTING_REASON_TEXT[r]).join(", ");
  return {
    title: "Host the backend with day2",
    type: "task",
    description: [
      `${b.request.displayName} needs a backend (${why}). It was created while hosting wasn't set up on this day2 server, so it keeps its data on each phone for now (src/backend/local.ts).`,
      "",
      "What's needed:",
      "1. The day2 operator sets up Supabase once (docs/hosting.md, \"Operator setup\": SUPABASE_ACCESS_TOKEN and DAY2_SUPABASE_ORG_ID).",
      "2. On the app's Hosting page, press “Host with day2”. day2 creates the backend and then writes the ticket that connects the app (src/backend/hosted.ts with supabase-js, migrations with row level security).",
      "",
      "This ticket waits for those two steps; close it once the app is hosted.",
    ].join("\n"),
    doneWhen: ["The app's Hosting page shows the backend as ready", "The hosted-backend ticket is done"],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: HOST_WITH_DAY2_KEY },
    state: "parked",
    actor: "day2",
    createdNote: "Create: the app needs a backend, and hosting wasn't set up yet.",
  };
}
