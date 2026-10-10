import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  addApp,
  findApp,
  generateAppId,
  hasGitRemote,
  loadAppsRegistry,
  MANAGED_REPOS_DIR,
  removeApp,
  renderAppsSummary,
  setAppBaseUrl,
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
import {
  computeSpendBreakdown,
  loadSpendLedger,
  type GrowthConfig,
  type SpendCategory,
} from "./spend-governance";
import { deriveGrowthStrategy, fetchStageSignals } from "./growth-strategy";
import { loadAllocatorState, type AllocatorState } from "./growth-allocator";
import { loadGrowthActions } from "./growth-feed";
import { listProposals } from "./proposals";
import type { AutonomyLevel } from "./types";
import { summarizeApp } from "./app-overview";
import { parseBrandDna } from "./brand-dna";
import { ASK_LOG_FILENAME, ASK_MAX_BUDGET_USD, askDay2, buildAskContext, loadAskLog, recordAsk, validateQuestion } from "./ask-day2";
import { SCAN_MAX_BUDGET_USD } from "./onboarding";
import {
  appCreditUsage,
  authorize,
  buyTopUp,
  creditsForCost,
  creditsForListUsd,
  CreditsError,
  getSummary,
  listUsdForCredits,
  PLANS,
  readCredits,
  setPlan,
  TOPUP_PACKS,
  updateAccount,
  YEARLY_DISCOUNT,
  type BillingCycle,
  type CreditService,
  type PaidPlanId,
} from "./credits";
import { appsRegistryPath, creditStore, ORCHESTRATOR_ROOT } from "./day2-paths";
import { withCreditContext, type CreditContext } from "./metered-query";
import { dirname } from "node:path";
import {
  findTicket,
  parseSettingsPatch,
  rankBacklog,
  createTicket,
  updateTicket,
  deleteTicket,
  addActivity,
  putTicket,
  withBacklog,
  type Priority,
  type TicketPatch,
  type TicketType,
  type Ticket,
} from "./backlog";
import { backlogFile, isRunning, startTicket, syncAppTrackers, tick, trackerClientsFor } from "./backlog-work";
import {
  applyTellPlan,
  buildTellPrompt,
  loadTellLog,
  runTellAgent,
  saveTellLog,
  TELL_LOG_FILENAME,
  TELL_MAX_BUDGET_USD,
  undoTell,
  validateInstruction,
} from "./backlog-tell";
import {
  INTEGRATIONS_FILENAME,
  linearClient,
  loadIntegrations,
  publicIntegrations,
  saveIntegrations,
} from "./backlog-trackers";
import { gatherSignalsForApp } from "./health-scout-cli";
import { features } from "./features";
import {
  answerBuild,
  beginConnect,
  connectTools,
  defaultPushToGitHub,
  finishConnect,
  getBuild,
  loadBuilds,
  lovableStatus,
  startBuild,
  validateBuildRequest,
  type BuildDeps,
  type LovableSetup,
} from "./lovable";

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
  const registry = loadAppsRegistry(appsRegistryPath());
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

const SPEND_LEDGER_FILENAME = "day2-spend-ledger.jsonl";
const AUDIT_FILENAME = "day2-autonomy-audit.jsonl";

function spendFor(app: AppEntry) {
  const config = loadGrowthConfig(appFile(app, GROWTH_CONFIG_FILENAME));
  const ledger = loadSpendLedger(appFile(app, SPEND_LEDGER_FILENAME));
  return { config, ledger, spend: computeSpendBreakdown(config.budget, ledger) };
}

/** Pending day2 PRs for an app, or null when that can't be known (no git
 * remote, `gh` failing or slow) — callers show "unknown", never a fake 0. */
async function pendingCardsOrNull(app: AppEntry, timeoutMs = 8000) {
  if (!hasGitRemote(app.repoPath)) return null;
  try {
    return await Promise.race([
      fetchPendingChangeCards(app.repoPath),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

function killSwitchFor(app: AppEntry): boolean {
  return loadGrowthConfig(appFile(app, GROWTH_CONFIG_FILENAME)).budget.killSwitch;
}

/**
 * Runs an agent-backed action for an app, paid from the account's credits.
 * Checks the worst case up front (so the request fails fast with a clear
 * 402 instead of half-running), then lets every agent run inside `fn` be
 * charged through metered-query.ts. Returns how many credits it used.
 */
async function runWithCredits<T>(
  app: AppEntry,
  service: CreditService,
  description: string,
  maxCostUsd: number,
  fn: () => Promise<T>,
): Promise<{ result: T; credits: number }> {
  const killSwitch = killSwitchFor(app);
  const check = await authorize(creditStore(), { appId: app.id, appName: app.name, service, maxCostUsd, killSwitch });
  if (!check.ok) throw new CreditsError(check);
  const ctx: CreditContext = { appId: app.id, appName: app.name, service, description, killSwitch };
  const result = await withCreditContext(ctx, fn);
  return { result, credits: ctx.charged ?? 0 };
}

/** Plan limit on how many apps the account can have. */
async function requireAppSlot(): Promise<void> {
  const { account } = await readCredits(creditStore());
  const plan = PLANS[account.plan];
  const count = loadAppsRegistry(appsRegistryPath()).apps.length;
  if (count >= plan.maxApps) {
    throw new HttpError(
      402,
      `The ${plan.name} plan includes ${plan.maxApps} app${plan.maxApps === 1 ? "" : "s"} — switch plans to add another.`,
    );
  }
}

/** Growth spend categories map onto the credit services they're paid from. */
function serviceForChannel(channel: string): CreditService {
  return channel === "paid_ads" ? "paid_ads" : "content_generation";
}

/** Allocator arms carry day2's real spend per format — sent as credits. */
function publicAllocatorState(state: AllocatorState) {
  return {
    ...state,
    arms: state.arms.map(({ spendUsd, ...arm }) => ({
      ...arm,
      spendCredits: creditsForCost(spendUsd, serviceForChannel(arm.arm.channel)),
    })),
  };
}

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;
type Route = { method: string; pattern: URLPattern; handler: Handler };
const routes: Route[] = [];

function route(method: string, pathname: string, handler: Handler): void {
  routes.push({ method, pattern: new URLPattern({ pathname }), handler });
}

// ---- Apps registry (plan §4/§5) ----

route("GET", "/api/apps", () => {
  const registry = loadAppsRegistry(appsRegistryPath());
  return json({ apps: registry.apps, summary: renderAppsSummary(registry) });
});

/** Headline numbers for every app at once (console "Your apps" grid). */
route("GET", "/api/apps/overview", async () => {
  const registry = loadAppsRegistry(appsRegistryPath());
  const { account, events } = await readCredits(creditStore());
  const now = new Date();
  const apps = await Promise.all(
    registry.apps.map(async (app) => {
      const cards = await pendingCardsOrNull(app);
      return summarizeApp({
        id: app.id,
        hasGitRemote: hasGitRemote(app.repoPath),
        pendingApprovals: cards ? cards.length : null,
        audit: loadAuditEntries(appFile(app, AUDIT_FILENAME)),
        credits: appCreditUsage(account, events, app.id, now),
        killSwitch: killSwitchFor(app),
        now,
      });
    }),
  );
  return json({ apps });
});

/** Who is operating this console — the local git identity, so the UI can
 * greet the real operator instead of a hardcoded name. */
route("GET", "/api/operator", async () => {
  const fromGit = (await $`git config --global user.name`.quiet().nothrow().text()).trim();
  const name = fromGit || process.env.USER || "there";
  return json({ name, source: fromGit ? "git" : process.env.USER ? "env" : "default" });
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
  await requireAppSlot();
  const registry = loadAppsRegistry(appsRegistryPath());
  const result = addApp(registry, {
    name: body.name,
    repoPath: body.repoPath,
    connectionMethod: body.connectionMethod,
    githubRepo: body.githubRepo,
    appBaseUrl: body.appBaseUrl,
  });
  if (!result.ok) throw new HttpError(409, result.reason);
  saveAppsRegistry(appsRegistryPath(), result.registry);
  return json({ app: result.app }, { status: 201 });
});

route("PATCH", "/api/apps/:id", async (req, params) => {
  const body = (await req.json().catch(() => ({}))) as { appBaseUrl?: unknown };
  if (body.appBaseUrl !== undefined && body.appBaseUrl !== null && typeof body.appBaseUrl !== "string") {
    throw new HttpError(400, "appBaseUrl must be a string.");
  }
  const registry = loadAppsRegistry(appsRegistryPath());
  const result = setAppBaseUrl(registry, params.id!, (body.appBaseUrl as string | null | undefined) ?? undefined);
  if (!result.ok) throw new HttpError(result.reason.startsWith("No app registered") ? 404 : 400, result.reason);
  saveAppsRegistry(appsRegistryPath(), result.registry);
  return json({ app: result.app });
});

route("DELETE", "/api/apps/:id", (_req, params) => {
  const registry = loadAppsRegistry(appsRegistryPath());
  const next = removeApp(registry, params.id!);
  saveAppsRegistry(appsRegistryPath(), next);
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

/**
 * Defense in depth against zip-slip, independent of the system `unzip`
 * binary's own behavior. Verified on this machine's Info-ZIP build that a
 * `../../escaped.txt` entry is already stripped/rejected before
 * extraction — but that protection is implicit, varies across unzip
 * implementations (notably on Linux), and this app has no control over
 * which one ends up on whatever machine eventually runs it. Lists entries
 * via `unzip -Z1` (zipinfo, one name per line) and rejects the whole
 * upload — before a single byte is extracted — if any entry's resolved
 * path would land outside `destDir`, or is an absolute path.
 */
export async function assertZipEntriesAreContained(zipPath: string, destDir: string): Promise<void> {
  let listing: string;
  try {
    listing = await $`unzip -Z1 ${zipPath}`.quiet().text();
  } catch (err) {
    throw new HttpError(400, `Couldn't read the uploaded .zip's contents: ${(err as Error).message}`);
  }
  const entries = listing.split("\n").filter(Boolean);
  const destRoot = destDir.endsWith("/") ? destDir : `${destDir}/`;
  for (const entry of entries) {
    if (entry.startsWith("/")) {
      throw new HttpError(400, `Rejected upload: zip entry "${entry}" is an absolute path.`);
    }
    const resolved = resolve(destDir, entry);
    if (resolved !== destDir.replace(/\/$/, "") && !resolved.startsWith(destRoot)) {
      throw new HttpError(400, `Rejected upload: zip entry "${entry}" would extract outside the app's directory.`);
    }
  }
}

// ---- Connect, option C: zip upload ----

route("POST", "/api/apps/upload", async (req) => {
  const form = await req.formData();
  const file = form.get("file");
  const name = form.get("name");
  if (!(file instanceof File) || typeof name !== "string" || !name) {
    throw new HttpError(400, "multipart form with a `file` (.zip) and a `name` field is required.");
  }
  await requireAppSlot();
  const id = generateAppId();
  const destDir = resolve(ORCHESTRATOR_ROOT, MANAGED_REPOS_DIR, id);
  mkdirSync(destDir, { recursive: true });
  const zipPath = resolve(destDir, "upload.zip");
  try {
    await Bun.write(zipPath, file);
    await assertZipEntriesAreContained(zipPath, destDir);
    await $`unzip -o ${zipPath} -d ${destDir}`.quiet();
    rmSync(zipPath, { force: true });

    const registry = loadAppsRegistry(appsRegistryPath());
    const result = addApp(registry, { id, name, repoPath: destDir, connectionMethod: "upload" });
    if (!result.ok) {
      rmSync(destDir, { recursive: true, force: true });
      throw new HttpError(409, result.reason);
    }
    saveAppsRegistry(appsRegistryPath(), result.registry);
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
  const { result, credits } = await runWithCredits(app, "scan_answer", "App scan", SCAN_MAX_BUDGET_USD, () =>
    scanAppProfile(app.repoPath),
  );
  return json({ ...result, credits });
});

route("GET", "/api/apps/:id/onboarding/profile", (_req, params) => {
  const app = requireApp(params.id!);
  const profile = loadAppProfile(appFile(app, APP_PROFILE_FILENAME));
  return json({ profile, rendered: profile ? renderAppProfilePlainLanguage(profile) : null });
});

route("PUT", "/api/apps/:id/onboarding/profile", async (req, params) => {
  const app = requireApp(params.id!);
  const profile = (await req.json()) as AppProfile;
  // Brand DNA feeds every ad, post, email and outreach message — validate
  // and normalize it here rather than store something generation can't use.
  if (profile.brand !== undefined && profile.brand !== null) {
    const brand = parseBrandDna(profile.brand);
    if (!brand) throw new HttpError(400, "Brand DNA is incomplete — positioning, primary audience and voice tone are required.");
    profile.brand = brand;
  }
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
  const entries = loadAuditEntries(appFile(app, AUDIT_FILENAME), sinceParam(req));
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

route("GET", "/api/apps/:id/growth/config", async (_req, params) => {
  const app = requireApp(params.id!);
  const config = loadGrowthConfig(appFile(app, GROWTH_CONFIG_FILENAME));
  const { account, events } = await readCredits(creditStore());
  return json({ config, credits: appCreditUsage(account, events, app.id, new Date()) });
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
  // Budgets here are at credit list value (the per-app cap), so this is a
  // unit change, not a cost — no markup is revealed.
  return json({
    strategy: {
      ...strategy,
      totalCredits: creditsForListUsd(strategy.totalBudgetUsd),
      allocations: strategy.allocations.map((a) => ({ ...a, credits: creditsForListUsd(a.budgetUsd) })),
    },
  });
});

// ---- Growth formats / allocator (plan §3.6) ----

route("GET", "/api/apps/:id/growth/allocator", (_req, params) => {
  const app = requireApp(params.id!);
  const state = loadAllocatorState(appFile(app, "day2-allocator-state.json"));
  return json({ state: publicAllocatorState(state) });
});

// ---- Growth feed / creative library (plan §3.6) ----
// GrowthActionRecord.toolUsed is already the allowlisted DTO shape
// ({capability, mcpServerName, reason}) at the type level (growth-feed.ts) —
// no raw ToolBinding/credential ever exists on this object to scrub.

route("GET", "/api/apps/:id/growth/feed", (req, params) => {
  const app = requireApp(params.id!);
  const records = loadGrowthActions(appFile(app, "day2-growth-actions.jsonl"), sinceParam(req));
  // Spend on these records is day2's real cost — shown only as credits.
  return json({
    records: records.map(({ spend, ...r }) => ({
      ...r,
      spend: { credits: creditsForCost(spend.requested, serviceForChannel(r.strategy.channel)), allowed: spend.allowed },
    })),
  });
});

// ---- Feature proposals (plan §3.7) ----

route("GET", "/api/apps/:id/evolution/proposals", (_req, params) => {
  const app = requireApp(params.id!);
  const proposals = listProposals(appFile(app, "day2-proposals.jsonl"));
  return json({ proposals });
});

// ---- Ask day2 (console Home question bar) — read-only answers ----

route("GET", "/api/apps/:id/ask", (_req, params) => {
  const app = requireApp(params.id!);
  return json({ entries: loadAskLog(appFile(app, ASK_LOG_FILENAME)) });
});

route("POST", "/api/apps/:id/ask", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as { question?: unknown };
  const valid = validateQuestion(body.question);
  if (!valid.ok) throw new HttpError(400, valid.reason);

  const { spend } = spendFor(app);
  const remote = hasGitRemote(app.repoPath);
  const context = buildAskContext({
    appName: app.name,
    profile: loadAppProfile(appFile(app, APP_PROFILE_FILENAME)),
    spend,
    autonomySummary: remote ? renderConfigSummary(loadAutonomyConfig(appFile(app, AUTONOMY_CONFIG_FILENAME))) : null,
    audit: loadAuditEntries(appFile(app, AUDIT_FILENAME)),
    approvals: await pendingCardsOrNull(app),
    releases: loadReleaseResults(appFile(app, "day2-release-results.jsonl")),
    growth: loadGrowthActions(appFile(app, "day2-growth-actions.jsonl")),
    proposals: listProposals(appFile(app, "day2-proposals.jsonl")),
  });

  const { result, credits } = await runWithCredits(app, "scan_answer", "Answer", ASK_MAX_BUDGET_USD, () =>
    askDay2(app.repoPath, valid.question, context),
  );
  if (!result.ok) return json(result);
  recordAsk(appFile(app, ASK_LOG_FILENAME), { askedAt: result.askedAt, question: valid.question, answer: result.answer, credits });
  return json({ ok: true, answer: result.answer, askedAt: result.askedAt, credits });
});

// ---- Plan & credits (one balance for the whole account) ----

/** Nothing here exposes a cost or a markup — only credits and list prices. */
function catalog() {
  return {
    plans: Object.values(PLANS),
    topUps: TOPUP_PACKS,
    yearlyDiscount: YEARLY_DISCOUNT,
    // No payment provider is wired up yet: plan changes and top-ups are
    // recorded straight to the ledger. The console says so.
    paymentsConnected: false,
  };
}

route("GET", "/api/credits", async () => {
  return json({ ...(await getSummary(creditStore())), catalog: catalog() });
});

route("PUT", "/api/credits/plan", async (req) => {
  const body = (await req.json().catch(() => ({}))) as { plan?: unknown; billingCycle?: unknown };
  const plan = body.plan as PaidPlanId;
  const cycle = (body.billingCycle ?? "monthly") as BillingCycle;
  if (!["starter", "growth", "scale"].includes(plan)) throw new HttpError(400, "plan must be starter, growth or scale.");
  if (cycle !== "monthly" && cycle !== "yearly") throw new HttpError(400, "billingCycle must be monthly or yearly.");
  const { effective, summary } = await setPlan(creditStore(), plan, cycle);
  return json({ effective, ...summary, catalog: catalog() });
});

route("POST", "/api/credits/top-ups", async (req) => {
  const body = (await req.json().catch(() => ({}))) as { packId?: unknown };
  if (typeof body.packId !== "string" || !TOPUP_PACKS.some((p) => p.id === body.packId)) {
    throw new HttpError(400, `packId must be one of: ${TOPUP_PACKS.map((p) => p.id).join(", ")}.`);
  }
  try {
    await buyTopUp(creditStore(), body.packId);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
  return json({ ...(await getSummary(creditStore())), catalog: catalog() }, { status: 201 });
});

route("PUT", "/api/credits/auto-top-up", async (req) => {
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; packId?: unknown };
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
  const packId = typeof body.packId === "string" ? body.packId : TOPUP_PACKS[0]!.id;
  if (!TOPUP_PACKS.some((p) => p.id === packId)) throw new HttpError(400, "Unknown top-up pack.");
  const summary = await updateAccount(creditStore(), (a) => ({ ...a, autoTopUp: { enabled: body.enabled as boolean, packId } }));
  return json({ ...summary, catalog: catalog() });
});

function parseCap(v: unknown, name: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new HttpError(400, `${name} must be a whole number of credits, or null for no cap.`);
  return v;
}

/**
 * An app's share of the balance. The growth engine's own budget rails
 * (per-action cap, exploration ceiling — spend-governance.ts) are kept in
 * step at credit list value, so they scale with the cap instead of
 * disagreeing with it.
 */
route("PUT", "/api/apps/:id/credits/caps", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as { monthlyCredits?: unknown; dailyCredits?: unknown };
  const monthly = parseCap(body.monthlyCredits, "monthlyCredits");
  const daily = parseCap(body.dailyCredits, "dailyCredits");
  await updateAccount(creditStore(), (a) => {
    const prev = a.appCaps[app.id] ?? {};
    const next = { ...prev };
    if (monthly !== undefined) {
      if (monthly === null) delete next.monthlyCredits;
      else next.monthlyCredits = monthly;
    }
    if (daily !== undefined) {
      if (daily === null) delete next.dailyCredits;
      else next.dailyCredits = daily;
    }
    return { ...a, appCaps: { ...a.appCaps, [app.id]: next } };
  });
  const path = appFile(app, GROWTH_CONFIG_FILENAME);
  let config = loadGrowthConfig(path);
  if (typeof monthly === "number") config = setMonthlyBudget(config, listUsdForCredits(monthly));
  if (daily !== undefined) config = setDailyCap(config, daily === null ? undefined : listUsdForCredits(daily));
  if (monthly !== undefined || daily !== undefined) saveGrowthConfig(path, config);
  const { account, events } = await readCredits(creditStore());
  return json({ credits: appCreditUsage(account, events, app.id, new Date()), config });
});

// ---- Backlog (one board of bugs, features, improvements and tasks) ----

const TYPES: TicketType[] = ["bug", "feature", "improvement", "task"];
const isPriority = (p: unknown): p is Priority => p === 1 || p === 2 || p === 3 || p === 4;

function integrationsPath(): string {
  return resolve(dirname(appsRegistryPath()), INTEGRATIONS_FILENAME);
}

async function requirePlanFeature(feature: "trackerSync" | "createApps"): Promise<void> {
  const { account } = await readCredits(creditStore());
  const plan = PLANS[account.plan];
  if (!plan.features[feature]) {
    throw new HttpError(402, feature === "trackerSync" ? `JIRA and Linear sync aren't included in the ${plan.name} plan — switch to Growth or Scale.` : `Creating apps isn't included in the ${plan.name} plan — switch to Growth or Scale.`);
  }
}

/** Done tickets older than this stay in the file but aren't sent. */
const DONE_WINDOW_DAYS = 30;

function backlogResponse(app: AppEntry, b: Awaited<ReturnType<typeof loadBacklogFor>>) {
  const cutoff = Date.now() - DONE_WINDOW_DAYS * 86_400_000;
  return {
    tickets: b.tickets.filter((t) => t.state !== "done" || new Date(t.doneAt ?? t.updatedAt).getTime() >= cutoff),
    settings: b.settings,
    lastRankedAt: b.lastRankedAt ?? null,
    running: b.tickets.filter((t) => isRunning(app.id, t.id)).map((t) => t.id),
    canWork: hasGitRemote(app.repoPath),
    integrations: publicIntegrations(loadIntegrations(integrationsPath())[app.id]),
  };
}

function loadBacklogFor(app: AppEntry) {
  return withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
}

function trackerClients(appId: string) {
  return trackerClientsFor(integrationsPath(), appId);
}

function syncAll(app: AppEntry): Promise<string[]> {
  return syncAppTrackers(app, integrationsPath());
}

route("GET", "/api/apps/:id/backlog", async (_req, params) => {
  const app = requireApp(params.id!);
  return json(backlogResponse(app, await loadBacklogFor(app)));
});

route("POST", "/api/apps/:id/backlog/tickets", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new HttpError(400, "A ticket needs a title.");
  if (title.length > 200) throw new HttpError(400, "Keep the title under 200 characters.");
  if (!TYPES.includes(body.type as TicketType)) throw new HttpError(400, "type must be bug, feature, improvement or task.");
  if (body.priority !== undefined && body.priority !== null && !isPriority(body.priority)) throw new HttpError(400, "priority must be 1–4, or left out to let day2 decide.");
  const alsoIn = Array.isArray(body.alsoCreateIn) ? (body.alsoCreateIn as unknown[]).filter((x): x is "linear" | "jira" => x === "linear" || x === "jira") : [];
  const createdBy = (await $`git config --global user.name`.quiet().nothrow().text()).trim() || undefined;
  const ticket = await withBacklog(backlogFile(app), (b) => {
    const r = createTicket(
      b,
      {
        title,
        type: body.type as TicketType,
        description: typeof body.description === "string" ? body.description.slice(0, 8000) : "",
        doneWhen: Array.isArray(body.doneWhen) ? (body.doneWhen as unknown[]).filter((d): d is string => typeof d === "string").slice(0, 12) : [],
        ...(isPriority(body.priority) ? { priority: body.priority } : {}),
        source: { kind: "user", createdBy },
        actor: "user",
        actorName: createdBy,
      },
      new Date(),
    );
    return { backlog: rankBacklog(r.backlog, new Date()).backlog, result: r.ticket };
  });
  if (alsoIn.length) {
    await requirePlanFeature("trackerSync");
    for (const { client } of trackerClients(app.id).filter((c) => alsoIn.includes(c.client.system))) {
      const remote = await client.create(ticket);
      await withBacklog(backlogFile(app), (b) => {
        const t = findTicket(b, ticket.id)!;
        const linked: Ticket = {
          ...t,
          trackers: [
            ...t.trackers,
            { system: client.system, id: remote.id, key: remote.key, url: remote.url, remoteUpdatedAt: remote.updatedAt, syncedPriority: t.priority, syncedState: t.state, seenCommentIds: [], lastSyncedAt: new Date().toISOString() },
          ],
          activity: [...t.activity, { at: new Date().toISOString(), actor: "day2", kind: "sync", text: `Also created in ${client.system === "linear" ? "Linear" : "JIRA"} as ${remote.key}.` }],
        };
        return { backlog: putTicket(b, linked), result: null };
      });
    }
  }
  const b = await loadBacklogFor(app);
  return json({ ticket: findTicket(b, ticket.id) }, { status: 201 });
});

route("PATCH", "/api/apps/:id/backlog/tickets/:tid", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: TicketPatch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) throw new HttpError(400, "A ticket needs a title.");
    patch.title = body.title.slice(0, 200);
  }
  if (body.type !== undefined) {
    if (!TYPES.includes(body.type as TicketType)) throw new HttpError(400, "type must be bug, feature, improvement or task.");
    patch.type = body.type as TicketType;
  }
  if (body.description !== undefined) patch.description = String(body.description).slice(0, 8000);
  if (body.doneWhen !== undefined) {
    if (!Array.isArray(body.doneWhen)) throw new HttpError(400, "doneWhen must be a list.");
    patch.doneWhen = (body.doneWhen as unknown[]).filter((d): d is string => typeof d === "string").slice(0, 12);
  }
  if (body.priority !== undefined) {
    if (body.priority !== null && !isPriority(body.priority)) throw new HttpError(400, "priority must be 1–4, or null to let day2 decide.");
    patch.priority = body.priority as Priority | null;
  }
  if (body.state !== undefined) {
    if (!["todo", "done", "parked"].includes(body.state as string)) {
      throw new HttpError(400, "state can be set to todo, done or parked — day2 moves tickets into Doing and To be approved itself.");
    }
    patch.state = body.state as TicketPatch["state"];
  }
  const ticket = await withBacklog(backlogFile(app), (b) => {
    const t = findTicket(b, params.tid!);
    if (!t) throw new HttpError(404, `No ticket ${params.tid}.`);
    if (patch.state && t.state === "doing" && isRunning(app.id, t.id)) throw new HttpError(409, "day2 is working on this ticket right now.");
    const r = updateTicket(b, t.id, patch, new Date(), { kind: "user" });
    const ranked = patch.priority === null ? rankBacklog(r.backlog, new Date()).backlog : r.backlog;
    return { backlog: ranked, result: findTicket(ranked, t.id)! };
  });
  return json({ ticket });
});

route("DELETE", "/api/apps/:id/backlog/tickets/:tid", async (_req, params) => {
  const app = requireApp(params.id!);
  if (isRunning(app.id, params.tid!)) throw new HttpError(409, "day2 is working on this ticket right now.");
  await withBacklog(backlogFile(app), (b) => {
    if (!findTicket(b, params.tid!)) throw new HttpError(404, `No ticket ${params.tid}.`);
    return { backlog: deleteTicket(b, params.tid!), result: null };
  });
  return json({ ok: true });
});

route("POST", "/api/apps/:id/backlog/tickets/:tid/comments", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new HttpError(400, "The comment is empty.");
  if (text.length > 4000) throw new HttpError(400, "Keep a comment under 4,000 characters.");
  const name = (await $`git config --global user.name`.quiet().nothrow().text()).trim() || undefined;
  const ticket = await withBacklog(backlogFile(app), (b) => {
    if (!findTicket(b, params.tid!)) throw new HttpError(404, `No ticket ${params.tid}.`);
    const next = addActivity(b, params.tid!, { actor: "user", name, kind: "comment", text }, new Date());
    return { backlog: next, result: findTicket(next, params.tid!)! };
  });
  return json({ ticket }, { status: 201 });
});

route("POST", "/api/apps/:id/backlog/tickets/:tid/work", async (_req, params) => {
  const app = requireApp(params.id!);
  const r = await startTicket(app, params.tid!);
  if (!r.ok) throw new HttpError(r.status, r.reason);
  return json({ ticket: r.ticket, started: r.started }, { status: 202 });
});

/** OK on a plan (starts the build) or on a fix PR (merges it). */
route("POST", "/api/apps/:id/backlog/tickets/:tid/approve", async (_req, params) => {
  const app = requireApp(params.id!);
  const b = await loadBacklogFor(app);
  const t = findTicket(b, params.tid!);
  if (!t) throw new HttpError(404, `No ticket ${params.tid}.`);
  if (t.state !== "to_approve" || !t.approval) throw new HttpError(409, "Nothing on this ticket is waiting for approval.");
  if (t.approval.kind === "pr") {
    requireGitRemote(app);
    await applyChange(app.repoPath, t.approval.number);
    const ticket = await withBacklog(backlogFile(app), (bb) => {
      const r = updateTicket(bb, t.id, { state: "done" }, new Date(), { kind: "user" });
      return { backlog: r.backlog, result: r.ticket };
    });
    return json({ ticket });
  }
  // Plan approved: back to To do with the plan kept, then start building.
  await withBacklog(backlogFile(app), (bb) => {
    const cur = findTicket(bb, t.id)!;
    const ticket: Ticket = {
      ...cur,
      state: "todo",
      activity: [...cur.activity, { at: new Date().toISOString(), actor: "user", kind: "work", text: "approved the plan." }],
    };
    return { backlog: putTicket(bb, ticket), result: null };
  });
  const r = await startTicket(app, t.id);
  if (!r.ok) throw new HttpError(r.status, r.reason);
  return json({ ticket: r.ticket, started: r.started }, { status: 202 });
});

/** "Not this" on a plan, or close the fix PR without merging. */
route("POST", "/api/apps/:id/backlog/tickets/:tid/reject", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const b = await loadBacklogFor(app);
  const t = findTicket(b, params.tid!);
  if (!t) throw new HttpError(404, `No ticket ${params.tid}.`);
  if (t.state !== "to_approve" || !t.approval) throw new HttpError(409, "Nothing on this ticket is waiting for approval.");
  if (t.approval.kind === "pr") {
    requireGitRemote(app);
    await undoChange(app.repoPath, t.approval.number);
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? `: ${body.reason.trim().slice(0, 500)}` : ".";
  const what = t.approval.kind === "pr" ? `closed PR #${t.approval.number} without merging` : "sent the plan back";
  const ticket = await withBacklog(backlogFile(app), (bb) => {
    const r = updateTicket(bb, t.id, { state: "todo" }, new Date(), { kind: "user" });
    const next: Ticket = {
      ...r.ticket,
      activity: [...r.ticket.activity, { at: new Date().toISOString(), actor: "user", kind: "work", text: `${what}${reason}` }],
    };
    return { backlog: putTicket(r.backlog, next), result: next };
  });
  return json({ ticket });
});

route("PUT", "/api/apps/:id/backlog/settings", async (req, params) => {
  const app = requireApp(params.id!);
  const body = await req.json().catch(() => null);
  const settings = await withBacklog(backlogFile(app), (b) => {
    let next;
    try {
      next = parseSettingsPatch(body, b.settings);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const ranked = rankBacklog({ ...b, settings: next }, new Date());
    return { backlog: ranked.backlog, result: next };
  });
  return json({ settings });
});

route("POST", "/api/apps/:id/backlog/rerank", async (_req, params) => {
  const app = requireApp(params.id!);
  const changes = await withBacklog(backlogFile(app), (b) => {
    const r = rankBacklog(b, new Date());
    return { backlog: r.backlog, result: r.changes };
  });
  return json({ changes, ...backlogResponse(app, await loadBacklogFor(app)) });
});

/** Import new findings, re-rank, reconcile PRs, sync trackers. Never
 * starts work by itself — that's `bun run backlog tick` on a schedule. */
route("POST", "/api/apps/:id/backlog/refresh", async (_req, params) => {
  const app = requireApp(params.id!);
  const b0 = await loadBacklogFor(app);
  const sentry = b0.settings.sentry;
  const report = await tick(app, {
    gatherSignals:
      sentry && process.env.SENTRY_AUTH_TOKEN
        ? () => gatherSignalsForApp({ id: app.id, sentryOrg: sentry.org, sentryProject: sentry.project })
        : undefined,
  });
  const sync = trackerClients(app.id).length ? await syncAll(app) : [];
  return json({ report, sync, ...backlogResponse(app, await loadBacklogFor(app)) });
});

// ---- Tell day2 (plain-words instructions that change the backlog) ----

function tellLogPath(app: AppEntry) {
  return appFile(app, TELL_LOG_FILENAME);
}

route("GET", "/api/apps/:id/backlog/tell", (_req, params) => {
  const app = requireApp(params.id!);
  return json({ records: loadTellLog(tellLogPath(app)) });
});

route("POST", "/api/apps/:id/backlog/tell", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as { instruction?: unknown; answerTo?: unknown };
  const valid = validateInstruction(body.instruction);
  if (!valid.ok) throw new HttpError(400, valid.reason);
  const log = loadTellLog(tellLogPath(app));
  const earlier = typeof body.answerTo === "string" ? log.find((r) => r.id === body.answerTo) : undefined;
  if (typeof body.answerTo === "string" && !earlier?.question) throw new HttpError(404, "There's no open question with that id.");

  const profile = loadAppProfile(appFile(app, APP_PROFILE_FILENAME));
  const goals = loadGrowthConfig(appFile(app, GROWTH_CONFIG_FILENAME)).kpiGoals;
  const appContext = [
    profile ? renderAppProfilePlainLanguage(profile).slice(0, 4000) : "No app profile yet.",
    goals.length ? `Goals: ${goals.map((g) => `${g.metric} → ${g.target}${g.byDate ? ` by ${g.byDate}` : ""}`).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const backlog = await loadBacklogFor(app);
  const prompt = buildTellPrompt({
    instruction: valid.instruction,
    backlog,
    appName: app.name,
    appContext,
    ...(earlier?.question ? { earlierQuestion: { text: earlier.question.text, instruction: earlier.instruction } } : {}),
  });
  const { result, credits } = await runWithCredits(app, "scan_answer", "Backlog plan", TELL_MAX_BUDGET_USD, () => runTellAgent(app.repoPath, prompt));
  if (!result.ok) return json({ ok: false, reason: result.reason, credits });

  const record = await withBacklog(backlogFile(app), (b) => {
    const applied = applyTellPlan(b, result.plan, valid.instruction, new Date());
    return { backlog: rankBacklog(applied.backlog, new Date()).backlog, result: { ...applied.record, credits, ...(earlier ? { answerTo: earlier.id } : {}) } };
  });
  const nextLog = log.map((r) =>
    earlier && r.id === earlier.id && r.question ? { ...r, question: { ...r.question, answer: valid.instruction, answeredAt: record.at } } : r,
  );
  saveTellLog(tellLogPath(app), [record, ...nextLog]);
  return json({ ok: true, record, ...backlogResponse(app, await loadBacklogFor(app)) });
});

route("POST", "/api/apps/:id/backlog/tell/:rid/undo", async (req, params) => {
  const app = requireApp(params.id!);
  const body = (await req.json().catch(() => ({}))) as { index?: unknown };
  const log = loadTellLog(tellLogPath(app));
  const record = log.find((r) => r.id === params.rid);
  if (!record) throw new HttpError(404, "No such request.");
  const index = typeof body.index === "number" ? body.index : undefined;
  if (index !== undefined && !record.changes[index]) throw new HttpError(400, "No such change.");
  const undone = await withBacklog(backlogFile(app), (b) => {
    const r = undoTell(b, record, new Date(), index);
    return { backlog: r.backlog, result: r.record };
  });
  saveTellLog(tellLogPath(app), log.map((r) => (r.id === record.id ? undone : r)));
  return json({ record: undone, ...backlogResponse(app, await loadBacklogFor(app)) });
});

// ---- JIRA / Linear connections ----

route("GET", "/api/apps/:id/integrations", (_req, params) => {
  const app = requireApp(params.id!);
  return json(publicIntegrations(loadIntegrations(integrationsPath())[app.id]));
});

route("PUT", "/api/apps/:id/integrations/:system", async (req, params) => {
  const app = requireApp(params.id!);
  await requirePlanFeature("trackerSync");
  const system = params.system;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const all = loadIntegrations(integrationsPath());
  const current = all[app.id] ?? {};
  if (system === "linear") {
    const apiKey = s("apiKey") || current.linear?.apiKey || "";
    const teamKey = s("teamKey") || current.linear?.teamKey || "";
    if (!apiKey || !teamKey) throw new HttpError(400, "Linear needs an API key and a team key (like EXP).");
    const cfg = { apiKey, teamKey, mirror: body.mirror === undefined ? (current.linear?.mirror ?? true) : body.mirror === true };
    try {
      await linearClient(cfg).resolveTeam();
    } catch (err) {
      throw new HttpError(400, `Couldn't connect to Linear: ${(err as Error).message}`);
    }
    all[app.id] = { ...current, linear: { ...current.linear, ...cfg, lastError: null } };
  } else if (system === "jira") {
    const site = s("site") || current.jira?.site || "";
    const email = s("email") || current.jira?.email || "";
    const apiToken = s("apiToken") || current.jira?.apiToken || "";
    const projectKey = s("projectKey") || current.jira?.projectKey || "";
    if (!/^https:\/\/[^/]+$/.test(site.replace(/\/+$/, ""))) throw new HttpError(400, "JIRA site must look like https://your-team.atlassian.net");
    if (!email || !apiToken || !projectKey) throw new HttpError(400, "JIRA needs your email, an API token and a project key (like EB).");
    all[app.id] = {
      ...current,
      jira: {
        ...current.jira,
        site: site.replace(/\/+$/, ""),
        email,
        apiToken,
        projectKey,
        label: s("label") || current.jira?.label || "day2",
        mirror: body.mirror === undefined ? (current.jira?.mirror ?? false) : body.mirror === true,
        lastError: null,
      },
    };
  } else {
    throw new HttpError(404, "Only linear and jira can be connected.");
  }
  saveIntegrations(integrationsPath(), all);
  return json(publicIntegrations(all[app.id]));
});

route("DELETE", "/api/apps/:id/integrations/:system", (_req, params) => {
  const app = requireApp(params.id!);
  const all = loadIntegrations(integrationsPath());
  const current = { ...(all[app.id] ?? {}) };
  if (params.system === "linear") delete current.linear;
  else if (params.system === "jira") delete current.jira;
  else throw new HttpError(404, "Only linear and jira can be connected.");
  all[app.id] = current;
  saveIntegrations(integrationsPath(), all);
  return json(publicIntegrations(current));
});

route("POST", "/api/apps/:id/backlog/sync", async (_req, params) => {
  const app = requireApp(params.id!);
  await requirePlanFeature("trackerSync");
  if (!trackerClients(app.id).length) throw new HttpError(409, "Connect JIRA or Linear first.");
  const sync = await syncAll(app);
  return json({ sync, ...backlogResponse(app, await loadBacklogFor(app)) });
});

// ---- Create an app with Lovable (day2's own Lovable account) ----

function requireCreateApps(): void {
  if (!features().createApps) throw new HttpError(404, "Creating apps isn't available yet.");
}

route("GET", "/api/features", () => json(features()));

function lovableSetup(): LovableSetup {
  return { dir: dirname(appsRegistryPath()), callbackUrl: `http://localhost:${PORT}/api/lovable/oauth/callback` };
}

function buildDeps(): BuildDeps {
  const setup = lovableSetup();
  return {
    tools: () => connectTools(setup),
    repoDir: (id) => resolve(ORCHESTRATOR_ROOT, MANAGED_REPOS_DIR, id),
    pushToGitHub: defaultPushToGitHub,
    registryPath: appsRegistryPath(),
    credits: creditStore(),
  };
}

route("GET", "/api/lovable", () => {
  requireCreateApps();
  const setup = lovableSetup();
  return json({ ...lovableStatus(setup), builds: loadBuilds(setup).slice(0, 10) });
});

/** One-time: the operator signs day2's own Lovable account in. */
route("POST", "/api/lovable/connect", async () => {
  requireCreateApps();
  try {
    return json(await beginConnect(lovableSetup()));
  } catch (err) {
    throw new HttpError(502, `Couldn't reach Lovable to connect: ${(err as Error).message}`);
  }
});

route("GET", "/api/lovable/oauth/callback", async (req) => {
  const url = new URL(req.url);
  requireCreateApps();
  const code = url.searchParams.get("code");
  const back = `${CONSOLE_ORIGIN}/setup/create`;
  if (!code) return Response.redirect(`${back}?lovable=error`, 302);
  try {
    await finishConnect(lovableSetup(), code, url.searchParams.get("state"));
    return Response.redirect(`${back}?lovable=connected`, 302);
  } catch (err) {
    console.error("[day2-lovable] connect failed:", err);
    return Response.redirect(`${back}?lovable=error`, 302);
  }
});

route("POST", "/api/apps/create", async (req) => {
  requireCreateApps();
  await requirePlanFeature("createApps");
  const valid = validateBuildRequest(await req.json().catch(() => null));
  if (!valid.ok) throw new HttpError(400, valid.reason);
  await requireAppSlot();
  try {
    return json({ build: await startBuild(lovableSetup(), valid.request, buildDeps()) }, { status: 202 });
  } catch (err) {
    if (err instanceof CreditsError) throw err;
    throw new HttpError(409, (err as Error).message);
  }
});

route("GET", "/api/lovable/builds/:bid", (_req, params) => {
  requireCreateApps();
  const build = getBuild(lovableSetup(), params.bid!);
  if (!build) throw new HttpError(404, "No such build.");
  return json({ build });
});

route("POST", "/api/lovable/builds/:bid/answer", async (req, params) => {
  requireCreateApps();
  const body = (await req.json().catch(() => ({}))) as { decision?: unknown };
  if (body.decision !== "approved" && body.decision !== "rejected") throw new HttpError(400, "decision must be approved or rejected.");
  try {
    return json({ build: await answerBuild(lovableSetup(), params.bid!, body.decision, buildDeps()) });
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
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
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

/** Routes whose handler waits on a Claude agent run (tens of seconds+). */
export function isAgentBackedPath(pathname: string): boolean {
  return /^\/api\/apps\/[^/]+\/(onboarding\/scan|ask|backlog\/(tell|refresh|sync)|backlog\/tickets\/[^/]+\/(approve|reject)|integrations\/[^/]+)$/.test(pathname) || /^\/api\/lovable\/(connect|builds\/[^/]+\/answer)$/.test(pathname);
}

/**
 * The actual router, as a plain `Request -> Response` function — exported so
 * tests can call it directly (no port binding, no real network, no
 * conflict with a real running instance on the default port). Mirrors the
 * `import.meta.main` guard every CLI entrypoint in this codebase already
 * uses (see auto-release-cli.ts's own comment on why) — this file just
 * never had one, which is the real reason it had zero test coverage until
 * now: importing it for its logic used to start a real server as a side
 * effect.
 */
export async function handleRequest(req: Request): Promise<Response> {
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
      if (err instanceof CreditsError) {
        return withCors(json({ error: err.message, code: err.check.code }, { status: 402 }));
      }
      console.error(err);
      return withCors(json({ error: (err as Error).message ?? "Internal error" }, { status: 500 }));
    }
  }
  return withCors(json({ error: `No route for ${req.method} ${url.pathname}` }, { status: 404 }));
}

if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    hostname: "localhost",
    fetch(req, srv) {
      // Bun closes a connection after 10s idle by default — shorter than a
      // real agent call (onboarding scan, Ask day2), which silently dropped
      // those requests as "Failed to fetch". Agent-backed POSTs get no idle
      // limit; everything else keeps the default.
      if (req.method === "POST" && isAgentBackedPath(new URL(req.url).pathname)) srv.timeout(req, 0);
      return handleRequest(req);
    },
  });
  console.log(`[day2-console-api] Listening on http://localhost:${server.port}`);
}
