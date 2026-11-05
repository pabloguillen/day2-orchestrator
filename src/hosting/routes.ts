import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { loadBacklog } from "../backlog";
import { backlogFile } from "../backlog-work";
import type { Tenant } from "../tenant";
import { currentTenant } from "../tenant";
import { parseApple, parseGoogle, smtpFromUrl, testApple, testGoogle } from "./auth";
import { eligibility } from "./eligibility";
import { parseSecret } from "./functions";
import { checkHealth, pauseEnv, RATES } from "./operations";
import { hostingEnabled } from "./operator";
import { apiFor, configureAuth, ensureEnv, HostingError, log, migrate, settlePlan, type HostingDeps } from "./provision";
import { registerHostingNativeNeeds } from "./native";
import { hostingDeps, hostingStore } from "./runtime";
import { checkBucket } from "./storage";
import type { HostingStore } from "./store";
import { adoptMovedProject, confirmTakeover, GUIDED_STEPS, previewTakeover } from "./takeover";
import { emptyProvider, REGION_PLACE, REGIONS, STEPS, type Bucket, type HostEnv, type HostingPlan, type HostingState, type Region, type SmtpSettings, type Step } from "./types";
import { resumeEnv } from "./provision";
import { SupabaseError } from "./supabase";

/**
 * /api/apps/:id/hosting/* — the Hosting page.
 *
 *   GET    /api/apps/:id/hosting                      status, region, usage (credits only), environments,
 *                                                     migrations, findings, keys (publishable only), takeover
 *   POST   /api/apps/:id/hosting                      "Host with day2" { region?, language?, countries?, buckets?, realtime? } — starts setup
 *   POST   /api/apps/:id/hosting/retry                carry on with a setup that stopped
 *   POST   /api/apps/:id/hosting/check                health now
 *   PUT    /api/apps/:id/hosting/sign-in/apple        { teamId, keyId, privateKey, servicesId? } — tested, then stored encrypted
 *   PUT    /api/apps/:id/hosting/sign-in/google       { webClientId, webClientSecret, iosClientId?, androidClientId? }
 *   DELETE /api/apps/:id/hosting/sign-in/:provider    turn Apple / Google off
 *   PUT    /api/apps/:id/hosting/email                { sender: "day2" } | { sender: "owner", smtpUrl, from }
 *   POST   /api/apps/:id/hosting/secrets              { name, value } — an edge function secret (value never shown again)
 *   POST   /api/apps/:id/hosting/migrations           apply pending migrations to staging now
 *   POST   /api/apps/:id/hosting/pause | resume       { env } — the owner's call (production never pauses by itself)
 *   POST   /api/apps/:id/hosting/takeover/preview     { token, orgSlug } — check the move to the owner's organization
 *   POST   /api/apps/:id/hosting/takeover/confirm     move it
 *   POST   /api/apps/:id/hosting/takeover/adopt       { token, orgSlug } — moved in Supabase's dashboard (guided)
 *
 * Registered with one line in api-server.ts. Never returns a secret, a cost
 * in money or a markup.
 */

export type RouteHelpers = {
  requireApp(t: Tenant, id: string): Promise<AppEntry>;
  /** Owners and admins only (keys, sign-in secrets, takeover). */
  requireManager(t: Tenant): void;
  fail(status: number, message: string): Error;
  actorName(t: Tenant): Promise<string | undefined>;
  deps?: (app: AppEntry) => HostingDeps;
  /** The state store the native needs read (tests). */
  store?: () => HostingStore;
};

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response>;
export type HostingRoute = { method: string; path: string; handler: Handler };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const GB = 1024 ** 3;

export const STEP_LABEL: Record<Step, string> = {
  project: "Creating the database",
  healthy: "Waiting for it to start",
  keys: "Getting the app's key",
  auth: "Setting up sign-in",
  storage: "Setting up file storage",
  migrations: "Applying database changes",
  functions: "Deploying server functions",
  advisors: "Checking security and speed",
  app_config: "Pointing the app at it",
  ticket: "Asking the build agent to connect the app",
};

/** Reads the deep link scheme and bundle id from app.json. */
export function appIds(repoPath: string): { scheme: string | null; bundleId: string | null } {
  const p = join(repoPath, "app.json");
  if (!existsSync(p)) return { scheme: null, bundleId: null };
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as { expo?: { scheme?: string | string[]; ios?: { bundleIdentifier?: string }; android?: { package?: string } } };
    const scheme = Array.isArray(j.expo?.scheme) ? j.expo?.scheme[0] : j.expo?.scheme;
    return { scheme: scheme ?? null, bundleId: j.expo?.ios?.bundleIdentifier ?? j.expo?.android?.package ?? null };
  } catch {
    return { scheme: null, bundleId: null };
  }
}

/** Pure. A plan from the console's "Host with day2" form. */
export function planFromBody(body: Record<string, unknown>, ids: { scheme: string | null; bundleId: string | null }, current: HostingPlan | null): HostingPlan {
  const region = typeof body.region === "string" && body.region ? body.region : undefined;
  if (region && !(REGIONS as readonly string[]).includes(region)) throw new Error(`"${region}" isn't a Supabase region.`);
  const countries = Array.isArray(body.countries) ? body.countries.filter((c): c is string => typeof c === "string" && /^[A-Za-z]{2}$/.test(c)) : undefined;
  const language = typeof body.language === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.language) ? body.language : (current?.language ?? "en");
  const buckets: Bucket[] = Array.isArray(body.buckets) ? (body.buckets as Bucket[]).map((b) => checkBucket({ name: String(b?.name ?? ""), public: Boolean(b?.public), ...(b?.maxBytes ? { maxBytes: Number(b.maxBytes) } : {}) })) : (current?.buckets ?? []);
  return {
    ...(region ? { region: region as Region } : current?.region ? { region: current.region } : {}),
    ...(countries?.length ? { audience: { countries } } : current?.audience ? { audience: current.audience } : {}),
    language,
    auth: current?.auth ?? { email: true, apple: false, google: false },
    buckets,
    realtime: typeof body.realtime === "boolean" ? body.realtime : (current?.realtime ?? false),
    scheme: ids.scheme ?? current?.scheme ?? null,
    bundleId: ids.bundleId ?? current?.bundleId ?? null,
  };
}

export type HostingView = ReturnType<typeof hostingView>;

/** Pure. What the page shows — credits only, the publishable key only. */
export function hostingView(o: { state: HostingState; available: boolean; reason: string | null; eligible: ReturnType<typeof eligibility>; ticket: { id: string; state: string } | null; secretKinds: string[]; now: Date }) {
  const s = o.state;
  const prod = s.projects.production ?? null;
  const done = new Set(s.done.production ?? []);
  const ready = Boolean(prod) && STEPS.every((x) => done.has(x));
  const status: "off" | "setting_up" | "ready" | "problem" | "moved" = !s.enabled ? "off" : s.takeover.state === "moved" && ready ? "moved" : !ready ? (s.problem && !s.working ? "problem" : "setting_up") : s.health && s.health.status !== "ACTIVE_HEALTHY" ? "problem" : "ready";
  const h = s.health;
  const days = s.usage.filter((u) => u.env === "production" || u.env === "staging").sort((a, b) => a.date.localeCompare(b.date));
  const since30 = new Date(o.now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const byDate = new Map<string, number>();
  for (const u of days) byDate.set(u.date, (byDate.get(u.date) ?? 0) + u.credits);
  const region = prod?.region ?? s.plan?.region ?? null;
  const env = (e: HostEnv) => {
    const p = s.projects[e];
    return p ? { env: e, ref: p.ref, url: p.url, status: p.pausedAt ? "PAUSED" : p.status, region: p.region, instanceSize: p.instanceSize, managedBy: p.managedBy, createdAt: p.createdAt, pausedAt: p.pausedAt ?? null } : null;
  };
  return {
    available: o.available,
    unavailableReason: o.reason,
    eligible: o.eligible,
    enabled: s.enabled,
    status,
    problem: s.problem,
    working: s.working ? { ...s.working, label: STEP_LABEL[s.working.step] } : null,
    steps: STEPS.map((step) => ({ step, label: STEP_LABEL[step], done: done.has(step) })),
    region: region ? { code: region, place: REGION_PLACE[region].en, eu: REGION_PLACE[region].eu } : null,
    keys: prod ? { url: prod.url, publishableKey: prod.publishableKey, envNames: { url: "EXPO_PUBLIC_SUPABASE_URL", key: "EXPO_PUBLIC_SUPABASE_KEY" } } : null,
    environments: {
      production: env("production"),
      staging: env("staging"),
      previews: s.previews.map((p) => ({ pr: p.pr, status: p.status, migrations: p.migrations, error: p.error ?? null, createdAt: p.createdAt, shared: p.branchId === "staging" })),
      branching: s.branching,
    },
    usage: {
      at: h?.at ?? null,
      database: { bytes: h?.dbBytes ?? null, includedBytes: RATES.includedDbGb * GB, diskBytes: h?.diskBytes ?? null, diskUsedBytes: h?.diskUsedBytes ?? null, connections: h?.connections ?? null, maxConnections: h?.maxConnections ?? null },
      storage: { bytes: h?.storageBytes ?? null, buckets: s.buckets },
      auth: { users: h?.authUsers ?? null, requests: h?.requests?.auth ?? null },
      requests: h?.requests ?? null,
      egressBytes: h?.egressBytes ?? null,
      functions: { invocations: h?.functionInvocations ?? null, errors: h?.functionErrors ?? null, deployed: s.functions, secretNames: s.secretNames },
      credits: {
        last30: days.filter((u) => u.date >= since30).reduce((a, u) => a + u.credits, 0),
        days: [...byDate.entries()].filter(([d]) => d >= since30).map(([date, credits]) => ({ date, credits })),
        billedByDay2: prod?.managedBy !== "owner",
      },
    },
    health: h ? { status: h.status, services: h.services, at: h.at } : null,
    migrations: [...s.migrations].reverse().slice(0, 40),
    findings: s.findings.map((f) => ({ key: f.key, kind: f.kind, level: f.level, title: f.title, detail: f.detail, ticketId: f.ticketId })),
    findingsAt: s.findingsAt,
    backups: s.backups,
    signIn: {
      planned: s.plan?.auth ?? { email: false, apple: false, google: false },
      siteUrl: s.auth.siteUrl,
      redirectUrls: s.auth.redirectUrls,
      emailSender: s.auth.smtp,
      emailLanguage: s.auth.templatesLang,
      apple: { ...s.auth.apple, stored: o.secretKinds.includes("apple") },
      google: { ...s.auth.google, stored: o.secretKinds.includes("google") },
      bundleId: s.plan?.bundleId ?? null,
      callbackUrl: prod ? `${prod.url}/auth/v1/callback` : null,
    },
    appConfig: s.appConfig,
    backendTicket: o.ticket,
    alerts: s.alerts.slice(-10).reverse(),
    takeover: { ...s.takeover, guidedSteps: GUIDED_STEPS },
    log: s.log.slice(0, 20),
  };
}

export function hostingRoutes(h: RouteHelpers): HostingRoute[] {
  registerHostingNativeNeeds(h.store ?? hostingStore);
  const depsOf = (app: AppEntry) => (h.deps ? h.deps(app) : hostingDeps(currentTenant() ?? null, app));
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HostingError) throw h.fail(err.code === "not_configured" ? 503 : err.code === "not_enabled" ? 409 : err.code === "blocked" ? 409 : 502, err.message);
      if (err instanceof SupabaseError) throw h.fail(502, err.message);
      if (err instanceof Error && !("status" in err)) throw h.fail(400, err.message);
      throw err;
    }
  };

  async function view(app: AppEntry, deps: HostingDeps) {
    const state = await deps.store.state(app.id);
    const available = hostingEnabled() && Boolean(deps.operator);
    const t = state.backendTicket ? loadBacklog(backlogFile(app)).tickets.find((x) => x.id === state.backendTicket) : undefined;
    const kinds = (await deps.secrets.list(app.id)).map((k) => k.kind);
    return hostingView({ state, available, reason: available ? null : "Hosting isn't set up on this day2 server yet.", eligible: eligibility(app.repoPath), ticket: t ? { id: t.id, state: t.state } : null, secretKinds: kinds, now: deps.now?.() ?? new Date() });
  }

  /** Setup runs in the background (a new project takes a few minutes); the page polls. */
  const running = new Set<string>();
  function startSetup(app: AppEntry, deps: HostingDeps): void {
    if (running.has(app.id)) return;
    running.add(app.id);
    void ensureEnv(app, "production", deps, { config: "ticket" })
      .catch(() => undefined)
      .finally(() => running.delete(app.id));
  }

  const r = (method: string, path: string, handler: (req: Request, app: AppEntry, deps: HostingDeps, t: Tenant, params: Record<string, string>) => Promise<Response>): HostingRoute => ({
    method,
    path: `/api/apps/:id/hosting${path}`,
    handler: async (req, params, t) => {
      const app = await h.requireApp(t, params.id!);
      const deps = depsOf(app);
      return guard(() => handler(req, app, deps, t, params));
    },
  });

  return [
    r("GET", "", async (_req, app, deps) => json(await view(app, deps))),

    r("POST", "", async (req, app, deps, t) => {
      h.requireManager(t);
      if (!hostingEnabled() || !deps.operator) throw h.fail(503, "Hosting isn't set up on this day2 server yet.");
      const e = eligibility(app.repoPath);
      if (!e.eligible) throw h.fail(409, e.why === "own_backend" ? `This app already has a backend (${e.backend}). day2 doesn't move existing backends — see "Apps that already have a backend" in the docs.` : "Hosting is for Expo apps.");
      const b = await body(req);
      const state = await deps.store.state(app.id);
      const plan = settlePlan(planFromBody(b, appIds(app.repoPath), state.plan), deps.operator.defaultRegion);
      const now = deps.now?.() ?? new Date();
      await deps.store.update(app.id, (s) => {
        if (!s.enabled) log(s, now, `Hosting switched on: the backend will live in ${REGION_PLACE[plan.region!].en}.`);
        s.enabled = true;
        s.plan = s.projects.production ? { ...plan, region: s.projects.production.region } : plan;
        s.problem = null;
      });
      startSetup(app, deps);
      return json(await view(app, deps), 202);
    }),

    r("POST", "/retry", async (_req, app, deps) => {
      const s = await deps.store.state(app.id);
      if (!s.enabled) throw h.fail(409, "Hosting isn't switched on for this app.");
      await deps.store.update(app.id, (x) => {
        x.problem = null;
      });
      startSetup(app, deps);
      return json(await view(app, deps), 202);
    }),

    r("POST", "/check", async (_req, app, deps) => {
      await checkHealth(app, deps);
      return json(await view(app, deps));
    }),

    r("PUT", "/sign-in/:provider", async (req, app, deps, t, params) => {
      h.requireManager(t);
      const provider = params.provider;
      if (provider !== "apple" && provider !== "google") throw h.fail(404, "Sign-in with Apple or Google.");
      const b = await body(req);
      const state = await deps.store.state(app.id);
      const now = deps.now?.() ?? new Date();
      const fetcher = deps.fetch ?? fetch;
      let result: { ok: true } | { ok: false; error: string };
      let label: string;
      if (provider === "apple") {
        const a = parseApple(b);
        const clientId = a.servicesId ?? state.plan?.bundleId;
        if (!clientId) throw h.fail(400, "Add the Services ID (or set the app's bundle id first).");
        result = await testApple(a, clientId, fetcher, now);
        label = `Apple key ${a.keyId}`;
        if (result.ok) await deps.secrets.set(app.id, "apple", a, label);
      } else {
        const g = parseGoogle(b);
        result = await testGoogle(g, fetcher);
        label = `Google client …${g.webClientId.split("-")[0]!.slice(-4)}`;
        if (result.ok) await deps.secrets.set(app.id, "google", g, label);
      }
      await deps.store.update(app.id, (s) => {
        s.auth[provider] = { state: result.ok ? "connected" : "failed", label, checkedAt: now.toISOString(), error: result.ok ? null : result.error };
        if (result.ok && s.plan) s.plan.auth[provider] = true;
      });
      if (!result.ok) throw h.fail(400, result.error);
      if ((await deps.store.state(app.id)).projects.production) await configureAuth(app, "production", deps);
      return json(await view(app, deps));
    }),

    r("DELETE", "/sign-in/:provider", async (_req, app, deps, t, params) => {
      h.requireManager(t);
      const provider = params.provider;
      if (provider !== "apple" && provider !== "google") throw h.fail(404, "Sign-in with Apple or Google.");
      await deps.secrets.remove(app.id, provider);
      await deps.store.update(app.id, (s) => {
        s.auth[provider] = emptyProvider();
        if (s.plan) s.plan.auth[provider] = false;
      });
      if ((await deps.store.state(app.id)).projects.production) await configureAuth(app, "production", deps);
      return json(await view(app, deps));
    }),

    r("PUT", "/email", async (req, app, deps, t) => {
      h.requireManager(t);
      const b = await body(req);
      if (b.sender === "owner") {
        const from = typeof b.from === "string" ? b.from.trim() : "";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) throw h.fail(400, "The From address is an email address on your domain.");
        const smtp: SmtpSettings = smtpFromUrl(String(b.smtpUrl ?? ""), from);
        await deps.secrets.set(app.id, "smtp", smtp, `SMTP ${smtp.host}`);
      } else if (b.sender === "day2") {
        await deps.secrets.remove(app.id, "smtp");
      } else throw h.fail(400, 'sender is "day2" or "owner".');
      if ((await deps.store.state(app.id)).projects.production) await configureAuth(app, "production", deps);
      return json(await view(app, deps));
    }),

    r("POST", "/secrets", async (req, app, deps, t) => {
      h.requireManager(t);
      const sec = parseSecret(await body(req));
      const { api, project } = await apiFor(app, "production", deps);
      if (!project) throw h.fail(409, "The backend isn't set up yet.");
      await api.setSecrets(project.ref, [sec]);
      await deps.store.update(app.id, (s) => {
        s.secretNames = [...new Set([...s.secretNames, sec.name])].sort();
        if (s.problem?.text.includes("need secrets")) s.problem = null;
      });
      return json(await view(app, deps));
    }),

    r("POST", "/migrations", async (_req, app, deps) => {
      const s = await deps.store.state(app.id);
      if (!s.projects.production) throw h.fail(409, "The backend isn't set up yet.");
      if (s.branching === "available" && !s.projects.staging) throw h.fail(409, "Database changes are checked on each pull request's own preview database, and reach production with the release that needs them.");
      await ensureEnv(app, "staging", deps);
      const out = await migrate(app, { env: "staging" }, deps);
      return json({ result: out, view: await view(app, deps) });
    }),

    r("POST", "/pause", async (req, app, deps, t) => {
      h.requireManager(t);
      const env = (await body(req)).env === "staging" ? "staging" : "production";
      await pauseEnv(app, env, "the owner paused it", deps);
      return json(await view(app, deps));
    }),

    r("POST", "/resume", async (req, app, deps, t) => {
      h.requireManager(t);
      const env = (await body(req)).env === "staging" ? "staging" : "production";
      await resumeEnv(app, env, deps);
      return json(await view(app, deps));
    }),

    r("POST", "/takeover/preview", async (req, app, deps, t) => {
      h.requireManager(t);
      const p = await previewTakeover(app, await body(req), deps);
      return json({ preview: p, view: await view(app, deps) });
    }),

    r("POST", "/takeover/confirm", async (_req, app, deps, t) => {
      h.requireManager(t);
      const r2 = await confirmTakeover(app, (await h.actorName(t)) ?? null, deps);
      return json({ moved: r2.moved, view: await view(app, deps) });
    }),

    r("POST", "/takeover/adopt", async (req, app, deps, t) => {
      h.requireManager(t);
      await adoptMovedProject(app, await body(req), (await h.actorName(t)) ?? null, deps);
      return json(await view(app, deps));
    }),
  ];
}
