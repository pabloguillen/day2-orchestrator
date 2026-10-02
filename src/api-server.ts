import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  addApp,
  APPS_REGISTRY_FILENAME,
  findApp,
  generateAppId,
  hasGitRemote,
  loadAppsRegistry,
  MANAGED_REPOS_DIR,
  removeApp,
  renderAppsSummary,
  saveAppsRegistry,
  type AppEntry,
  type ConnectionMethod,
} from "./apps-registry";
import {
  APP_PROFILE_FILENAME,
  loadAppProfile,
  renderAppProfilePlainLanguage,
  saveAppProfile,
  scanAppProfile,
  type AppProfile,
} from "./onboarding";
import {
  AUTONOMY_CONFIG_FILENAME,
  loadAutonomyConfig,
  previewArea,
  removeArea,
  renderConfigSummary,
  saveAutonomyConfig,
  setArea,
} from "./autonomy-config";
import { loadAuditEntries, renderFeed } from "./owner-feed";
import { applyChange, askQuestion, fetchPendingChangeCards, undoChange } from "./approvals";
import { loadReleaseResults } from "./release";
import {
  GROWTH_CONFIG_FILENAME,
  loadGrowthConfig,
  removeKpiGoal,
  renderGrowthConfigSummary,
  saveGrowthConfig,
  setCategoryCap,
  setDailyCap,
  setKillSwitch,
  setKpiGoal,
  setMonthlyBudget,
  setWebsiteEnabled,
} from "./growth-config";
import { loadSpendLedger, renderBudgetSummary, type GrowthConfig, type SpendCategory } from "./spend-governance";
import { deriveGrowthStrategy, fetchStageSignals, renderGrowthStrategySummary } from "./growth-strategy";
import { loadAllocatorState, renderAllocatorSummary } from "./growth-allocator";
import { loadGrowthActions, renderGrowthFeed } from "./growth-feed";
import { listProposals } from "./proposals";
import type { AutonomyLevel } from "./types";

/**
 * day2 console API server (day2 console plan §5) — Bun.serve, no new
 * dependencies. Every endpoint is a thin wrapper over an existing (or
 * newly-added, see apps-registry.ts/release.ts/onboarding.ts) pure function;
 * this file adds no business logic of its own beyond request parsing,
 * appId->repoPath resolution, and the git-remote capability gate.
 *
 * Hand-rolled router (URLPattern + a manual dispatch loop) rather than
 * Bun.serve's built-in `routes` object: every route needs the same CORS +
 * JSON-error wrapping, which is simpler to apply once here than to repeat
 * per route.
 *
 * No auth, no multi-tenancy, in this phase — acceptable only because this
 * binds to localhost only (day2 console plan §5/§8 open question 2) and
 * there is exactly one operator and, today, one real app. **Documented
 * decision, not an oversight (2026-10-03):** this is deliberately deferred
 * until there's a second real app or a second real user of the console —
 * neither exists yet, so building a login/session/tenant model now would be
 * speculative. A hard blocker before any of the following become true:
 * this server binds to anything but localhost, a second person needs their
 * own view/permissions, or app data needs to be isolated between operators.
 * See `docs/platform-audit-findings.md` (Cross-cutting #8) for the audit
 * that raised this; the CORS header below was tightened as part of this
 * same pass since a wildcard origin is a real localhost drive-by exposure
 * regardless of the auth decision.
 */

const PORT = Number(process.env.DAY2_CONSOLE_API_PORT ?? 4700);
const ORCHESTRATOR_ROOT = resolve(import.meta.dir, "..");
const APPS_REGISTRY_PATH = resolve(ORCHESTRATOR_ROOT, APPS_REGISTRY_FILENAME);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function requireApp(id: string): AppEntry {
  const registry = loadAppsRegistry(APPS_REGISTRY_PATH);
  const app = findApp(registry, id);
  if (!app) throw new HttpError(404, `No app registered with id "${id}".`);
  return app;
}

/** Real, checked fact (apps-registry.ts's `hasGitRemote`) — never inferred
 * from `connectionMethod` alone. Gates Autonomy/Approvals, which need a real
 * git remote for `gh pr` actions to target. */
function requireGitRemote(app: AppEntry): void {
  if (!hasGitRemote(app.repoPath)) {
    throw new HttpError(
      409,
      `"${app.name}" has no connected git remote — connect a GitHub remote to enable this.`,
    );
  }
}

function appFile(app: AppEntry, filename: string): string {
  return resolve(app.repoPath, filename);
}

function sinceParam(req: Request): Date | undefined {
  const since = new URL(req.url).searchParams.get("since");
  return since ? new Date(since) : undefined;
}

async function updateGrowthConfig(
  appId: string,
  updater: (config: GrowthConfig) => GrowthConfig,
): Promise<Response> {
  const app = requireApp(appId);
  const path = appFile(app, GROWTH_CONFIG_FILENAME);
  const config = loadGrowthConfig(path);
  const next = updater(config);
  saveGrowthConfig(path, next);
  return json({ config: next, summary: renderGrowthConfigSummary(next) });
}

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;
type Route = { method: string; pattern: URLPattern; handler: Handler };
const routes: Route[] = [];

function route(method: string, pathname: string, handler: Handler): void {
  routes.push({ method, pattern: new URLPattern({ pathname }), handler });
}

// ---- Apps registry (plan §4/§5) ----

route("GET", "/api/apps", () => {
  const registry = loadAppsRegistry(APPS_REGISTRY_PATH);
  return json({ apps: registry.apps, summary: renderAppsSummary(registry) });
});

route("POST", "/api/apps", async (req) => {
  const body = (await req.json()) as {
    name?: string;
    repoPath?: string;
    connectionMethod?: ConnectionMethod;
    githubRepo?: string;
    appBaseUrl?: string;
  };
  if (!body.name || !body.repoPath || !body.connectionMethod) {
    throw new HttpError(400, "name, repoPath, and connectionMethod are required.");
  }
  const registry = loadAppsRegistry(APPS_REGISTRY_PATH);
  const result = addApp(registry, {
    name: body.name,
    repoPath: body.repoPath,
    connectionMethod: body.connectionMethod,
    githubRepo: body.githubRepo,
    appBaseUrl: body.appBaseUrl,
  });
  if (!result.ok) throw new HttpError(409, result.reason);
  saveAppsRegistry(APPS_REGISTRY_PATH, result.registry);
  return json({ app: result.app }, { status: 201 });
});

route("DELETE", "/api/apps/:id", (_req, params) => {
  const registry = loadAppsRegistry(APPS_REGISTRY_PATH);
  const next = removeApp(registry, params.id!);
  saveAppsRegistry(APPS_REGISTRY_PATH, next);
  return json({ ok: true });
});

// ---- Connect, option A: GitHub via the operator's own `gh` session ----

route("GET", "/api/github/repos", async () => {
  try {
    const out = await $`gh repo list --json name,owner,url,sshUrl,updatedAt --limit 200`.quiet().text();
    return json({ repos: JSON.parse(out) });
  } catch (err) {
    throw new HttpError(
      400,
      `Couldn't list GitHub repos — is \`gh\` authenticated on this machine? Run \`gh auth login\` first. (${(err as Error).message})`,
    );
  }
});

// ---- Connect, option C: zip upload ----

route("POST", "/api/apps/upload", async (req) => {
  const form = await req.formData();
  const file = form.get("file");
  const name = form.get("name");
  if (!(file instanceof File) || typeof name !== "string" || !name) {
    throw new HttpError(400, "multipart form with a `file` (.zip) and a `name` field is required.");
  }
  const id = generateAppId();
  const destDir = resolve(ORCHESTRATOR_ROOT, MANAGED_REPOS_DIR, id);
  mkdirSync(destDir, { recursive: true });
  const zipPath = resolve(destDir, "upload.zip");
  try {
    await Bun.write(zipPath, file);
    await $`unzip -o ${zipPath} -d ${destDir}`.quiet();
    rmSync(zipPath, { force: true });

    const registry = loadAppsRegistry(APPS_REGISTRY_PATH);
    const result = addApp(registry, { id, name, repoPath: destDir, connectionMethod: "upload" });
    if (!result.ok) {
      rmSync(destDir, { recursive: true, force: true });
      throw new HttpError(409, result.reason);
    }
    saveAppsRegistry(APPS_REGISTRY_PATH, result.registry);
    return json({ app: result.app }, { status: 201 });
  } catch (err) {
    rmSync(destDir, { recursive: true, force: true });
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Couldn't extract the uploaded .zip: ${(err as Error).message}`);
  }
});

// ---- Onboarding (plan §2/§3.1) ----

route("POST", "/api/apps/:id/onboarding/scan", async (_req, params) => {
  const app = requireApp(params.id!);
  const result = await scanAppProfile(app.repoPath);
  return json(result);
});

route("GET", "/api/apps/:id/onboarding/profile", (_req, params) => {
  const app = requireApp(params.id!);
  const profile = loadAppProfile(appFile(app, APP_PROFILE_FILENAME));
  return json({ profile, rendered: profile ? renderAppProfilePlainLanguage(profile) : null });
});

route("PUT", "/api/apps/:id/onboarding/profile", async (req, params) => {
  const app = requireApp(params.id!);
  const profile = (await req.json()) as AppProfile;
  saveAppProfile(appFile(app, APP_PROFILE_FILENAME), profile);
  return json({ ok: true, profile });
});

// ---- Autonomy (plan §3.3) ----

route("GET", "/api/apps/:id/autonomy/config", (_req, params) => {
  const app = requireApp(params.id!);
  if (!hasGitRemote(app.repoPath)) {
    return json({ available: false, reason: `"${app.name}" has no connected git remote — connect one to enable this.` });
  }
  const config = loadAutonomyConfig(appFile(app, AUTONOMY_CONFIG_FILENAME));
  return json({ available: true, config, summary: renderConfigSummary(config) });
});

route("PUT", "/api/apps/:id/autonomy/areas/:area", async (req, params) => {
  const app = requireApp(params.id!);
  requireGitRemote(app);
  const body = (await req.json()) as { pathGlobs: string[]; level: AutonomyLevel };
  const path = appFile(app, AUTONOMY_CONFIG_FILENAME);
  const config = loadAutonomyConfig(path);
  const area = params.area!;
  const next = setArea(config, area, body.pathGlobs, body.level);
  saveAutonomyConfig(path, next);
  const preview = previewArea(next, { area, pathGlobs: body.pathGlobs, level: body.level });
  return json({ config: next, summary: renderConfigSummary(next), preview });
});

route("DELETE", "/api/apps/:id/autonomy/areas/:area", (_req, params) => {
  const app = requireApp(params.id!);
  requireGitRemote(app);
  const path = appFile(app, AUTONOMY_CONFIG_FILENAME);
  const config = loadAutonomyConfig(path);
  const next = removeArea(config, params.area!);
  saveAutonomyConfig(path, next);
  return json({ config: next, summary: renderConfigSummary(next) });
});

route("POST", "/api/apps/:id/autonomy/preview", async (req, params) => {
  const app = requireApp(params.id!);
  requireGitRemote(app);
  const body = (await req.json()) as { area: string; pathGlobs: string[]; level: AutonomyLevel };
  const config = loadAutonomyConfig(appFile(app, AUTONOMY_CONFIG_FILENAME));
  return json(previewArea(config, body));
});

route("GET", "/api/apps/:id/autonomy/audit", (req, params) => {
  const app = requireApp(params.id!);
  const entries = loadAuditEntries(appFile(app, "day2-autonomy-audit.jsonl"), sinceParam(req));
  return json({ entries, rendered: renderFeed(entries) });
});

// ---- Approvals (plan §3.4) — real, hard-to-reverse GitHub actions ----

route("GET", "/api/apps/:id/approvals", async (_req, params) => {
  const app = requireApp(params.id!);
  if (!hasGitRemote(app.repoPath)) {
    return json({ available: false, reason: `"${app.name}" has no connected git remote — connect one to enable this.`, cards: [] });
  }
  const cards = await fetchPendingChangeCards(app.repoPath);
  return json({ available: true, cards });
});

route("POST", "/api/apps/:id/approvals/:pr/apply", async (_req, params) => {
  const app = requireApp(params.id!);
  requireGitRemote(app);
  await applyChange(app.repoPath, Number(params.pr));
  return json({ ok: true });
});

route("POST", "/api/apps/:id/approvals/:pr/undo", async (_req, params) => {
  const app = requireApp(params.id!);
  requireGitRemote(app);
  await undoChange(app.repoPath, Number(params.pr));
  return json({ ok: true });
});

route("POST", "/api/apps/:id/approvals/:pr/ask", async (req, params) => {
  const app = requireApp(params.id!);
  requireGitRemote(app);
  const body = (await req.json()) as { question?: string };
  if (!body.question) throw new HttpError(400, "question is required.");
  await askQuestion(app.repoPath, Number(params.pr), body.question);
  return json({ ok: true });
});

// ---- Releases (plan §3.2) ----

route("GET", "/api/apps/:id/releases", (req, params) => {
  const app = requireApp(params.id!);
  const results = loadReleaseResults(appFile(app, "day2-release-results.jsonl"), sinceParam(req));
  return json({ results });
});

// ---- Budget & Spend (plan §3.5) ----

route("GET", "/api/apps/:id/growth/config", (_req, params) => {
  const app = requireApp(params.id!);
  const config = loadGrowthConfig(appFile(app, GROWTH_CONFIG_FILENAME));
  const ledger = loadSpendLedger(appFile(app, "day2-spend-ledger.jsonl"));
  return json({
    config,
    summary: renderGrowthConfigSummary(config),
    budgetSummary: renderBudgetSummary(config.budget, ledger),
  });
});

route("PUT", "/api/apps/:id/growth/budget", async (req, params) => {
  const body = (await req.json()) as { monthlyBudgetUsd: number };
  return updateGrowthConfig(params.id!, (c) => setMonthlyBudget(c, body.monthlyBudgetUsd));
});

route("PUT", "/api/apps/:id/growth/kill-switch", async (req, params) => {
  const body = (await req.json()) as { killSwitch: boolean };
  return updateGrowthConfig(params.id!, (c) => setKillSwitch(c, body.killSwitch));
});

route("PUT", "/api/apps/:id/growth/daily-cap", async (req, params) => {
  const body = (await req.json()) as { dailyCapUsd?: number };
  return updateGrowthConfig(params.id!, (c) => setDailyCap(c, body.dailyCapUsd));
});

route("PUT", "/api/apps/:id/growth/category-cap/:cat", async (req, params) => {
  const body = (await req.json()) as { capUsd: number };
  return updateGrowthConfig(params.id!, (c) => setCategoryCap(c, params.cat as SpendCategory, body.capUsd));
});

route("PUT", "/api/apps/:id/growth/kpi-goals/:metric", async (req, params) => {
  const body = (await req.json()) as { target: number; byDate?: string };
  return updateGrowthConfig(params.id!, (c) =>
    setKpiGoal(c, { metric: params.metric!, target: body.target, byDate: body.byDate }),
  );
});

route("DELETE", "/api/apps/:id/growth/kpi-goals/:metric", async (_req, params) => {
  return updateGrowthConfig(params.id!, (c) => removeKpiGoal(c, params.metric!));
});

route("PUT", "/api/apps/:id/growth/website", async (req, params) => {
  const body = (await req.json()) as { enabled: boolean; templatePreference?: string };
  return updateGrowthConfig(params.id!, (c) => setWebsiteEnabled(c, body.enabled, body.templatePreference));
});

// ---- Growth strategy (plan §3.6) ----

route("GET", "/api/apps/:id/growth/strategy", async (_req, params) => {
  const app = requireApp(params.id!);
  if (!app.appBaseUrl) {
    throw new HttpError(400, `"${app.name}" has no appBaseUrl configured — strategy needs a live /api/day2-stats endpoint to derive stage signals from.`);
  }
  const profile = loadAppProfile(appFile(app, APP_PROFILE_FILENAME));
  if (!profile) {
    throw new HttpError(409, `"${app.name}" hasn't completed onboarding yet — no app profile to derive a strategy from.`);
  }
  const config = loadGrowthConfig(appFile(app, GROWTH_CONFIG_FILENAME));
  const signals = await fetchStageSignals(app.appBaseUrl);
  const strategy = deriveGrowthStrategy(config.budget, profile, signals, config.kpiGoals);
  return json({ strategy, summary: renderGrowthStrategySummary(strategy) });
});

// ---- Growth formats / allocator (plan §3.6) ----

route("GET", "/api/apps/:id/growth/allocator", (_req, params) => {
  const app = requireApp(params.id!);
  const state = loadAllocatorState(appFile(app, "day2-allocator-state.json"));
  return json({ state, summary: renderAllocatorSummary(state) });
});

// ---- Growth feed / creative library (plan §3.6) ----
// GrowthActionRecord.toolUsed is already the allowlisted DTO shape
// ({capability, mcpServerName, reason}) at the type level (growth-feed.ts) —
// no raw ToolBinding/credential ever exists on this object to scrub.

route("GET", "/api/apps/:id/growth/feed", (req, params) => {
  const app = requireApp(params.id!);
  const records = loadGrowthActions(appFile(app, "day2-growth-actions.jsonl"), sinceParam(req));
  const state = loadAllocatorState(appFile(app, "day2-allocator-state.json"));
  return json({ records, rendered: renderGrowthFeed(records, state) });
});

// ---- Feature proposals (plan §3.7) ----

route("GET", "/api/apps/:id/evolution/proposals", (_req, params) => {
  const app = requireApp(params.id!);
  const proposals = listProposals(appFile(app, "day2-proposals.jsonl"));
  return json({ proposals });
});

// ---- Dispatch ----

/** Scoped to the console's own origin, not "*" — this server binds to
 * localhost only, so a wildcard CORS header's one real effect is letting
 * ANY webpage open in the operator's browser read responses from it (a
 * classic localhost drive-by: the exposure CORS exists to prevent is same-
 * machine-different-origin, not off-machine). Override via
 * DAY2_CONSOLE_ORIGIN if the console is ever served from somewhere other
 * than its `vite dev --port 3000` default. */
const CONSOLE_ORIGIN = process.env.DAY2_CONSOLE_ORIGIN ?? "http://localhost:3000";

const CORS_HEADERS = {
  "access-control-allow-origin": CONSOLE_ORIGIN,
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

const server = Bun.serve({
  port: PORT,
  hostname: "localhost",
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(req.url);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(url);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(match.pathname.groups)) {
        if (v !== undefined) params[k] = v;
      }
      try {
        return withCors(await r.handler(req, params));
      } catch (err) {
        if (err instanceof HttpError) {
          return withCors(json({ error: err.message }, { status: err.status }));
        }
        console.error(err);
        return withCors(json({ error: (err as Error).message ?? "Internal error" }, { status: 500 }));
      }
    }
    return withCors(json({ error: `No route for ${req.method} ${url.pathname}` }, { status: 404 }));
  },
});

console.log(`[day2-console-api] Listening on http://localhost:${server.port}`);
