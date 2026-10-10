import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  generateAppId,
  hasGitRemote,
  MANAGED_REPOS_DIR,
  renderAppsSummary,
  type AppEntry,
  type ConnectionMethod,
} from "./apps-registry";
import {
  attachInstallation,
  authConfig,
  canManage,
  clearedSessionCookie,
  consumeOAuthState,
  createOAuthState,
  createSession,
  deleteSession,
  fetchGitHubProfile,
  githubAuthorizeUrl,
  hashToken,
  invite,
  listAccounts,
  listMembers,
  readCookie,
  removeMember,
  resolveSession,
  revokeInvite,
  safeNextPath,
  seatUsage,
  SESSION_COOKIE,
  sessionCookie,
  setRole,
  signInUser,
  switchAccount,
  type MemberResult,
  type Role,
} from "./auth";
import { db, migrate } from "./db";
import { cloneWithInstallation, GitHubAccessError, hasGitHubApp, installUrl, listInstallationRepos, type InstallationRepo } from "./github-app";
import {
  assertProductionReady,
  localOperatorName,
  localTenant,
  runAsTenant,
  serverMode,
  sessionTenant,
  type Tenant,
} from "./tenant";
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
import { dataDir, ORCHESTRATOR_ROOT } from "./day2-paths";
import { withCreditContext, type CreditContext } from "./metered-query";
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
import { linearClient, publicIntegrations, type AppIntegrations } from "./backlog-trackers";
import { gatherSignalsForApp } from "./health-scout-cli";
import { tickAll } from "./backlog-cli";
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
 * day2 API server — Bun.serve, no framework. Every endpoint is a thin
 * wrapper over the modules' own functions; this file adds request parsing,
 * who-is-asking (sign-in and account scoping), and the capability gates.
 *
 * Two modes (tenant.ts):
 *  - accounts (production, DATABASE_URL set): every request outside
 *    `/api/auth/*` needs a signed-in session, and everything it reads or
 *    writes goes through stores scoped to that session's account — one
 *    customer can never see or touch another's apps, credits or tokens.
 *    The console and this API are served from one origin (Caddy), so the
 *    session cookie is SameSite=Lax + HttpOnly, and state-changing requests
 *    must come from that origin (checked below) — together the CSRF defence.
 *  - local (development, no DATABASE_URL): one operator on their own machine,
 *    no sign-in, JSON files. Binds to localhost only.
 */

const PORT = Number(process.env.DAY2_CONSOLE_API_PORT ?? 4700);

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function requireApp(t: Tenant, id: string): Promise<AppEntry> {
  const app = await t.apps.find(id);
  if (!app) throw new HttpError(404, `No app registered with id "${id}".`);
  return app;
}

/** Owners and admins only: billing, people, connections, removing apps. */
function requireManager(t: Tenant): void {
  if (!canManage(t.role)) throw new HttpError(403, "Only the account's owners and admins can do this.");
}

/** Who to name on tickets and comments. */
async function actorName(t: Tenant): Promise<string | undefined> {
  if (t.session) return t.session.user.name ?? t.session.user.login;
  return (await localOperatorName()) || undefined;
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
  t: Tenant,
  appId: string,
  updater: (config: GrowthConfig) => GrowthConfig,
): Promise<Response> {
  const app = await requireApp(t, appId);
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
  t: Tenant,
  app: AppEntry,
  service: CreditService,
  description: string,
  maxCostUsd: number,
  fn: () => Promise<T>,
): Promise<{ result: T; credits: number }> {
  const killSwitch = killSwitchFor(app);
  const check = await authorize(t.credits, { appId: app.id, appName: app.name, service, maxCostUsd, killSwitch });
  if (!check.ok) throw new CreditsError(check);
  const ctx: CreditContext = { appId: app.id, appName: app.name, service, description, killSwitch };
  const result = await withCreditContext(ctx, fn);
  return { result, credits: ctx.charged ?? 0 };
}

/** Plan limit on how many apps the account can have. */
async function requireAppSlot(t: Tenant): Promise<void> {
  const { account } = await readCredits(t.credits);
  const plan = PLANS[account.plan];
  const count = (await t.apps.list()).length;
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

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;
/** `public`: no sign-in needed (sign-in itself, feature flags, OAuth callbacks). */
type Route = { method: string; pattern: URLPattern; handler: Handler; public: boolean };
const routes: Route[] = [];

function route(method: string, pathname: string, handler: Handler, opts: { public?: boolean } = {}): void {
  routes.push({ method, pattern: new URLPattern({ pathname }), handler, public: opts.public ?? false });
}

// ---- Apps (plan §4/§5) ----

route("GET", "/api/apps", async (_req, _params, t) => {
  const apps = await t.apps.list();
  return json({ apps, summary: renderAppsSummary({ apps }) });
});

/** Headline numbers for every app at once (console "Your apps" grid). */
route("GET", "/api/apps/overview", async (_req, _params, t) => {
  const list = await t.apps.list();
  const { account, events } = await readCredits(t.credits);
  const now = new Date();
  const apps = await Promise.all(
    list.map(async (app) => {
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

/** Who is using the console — the signed-in person, or locally the git
 * identity, so the UI greets the real person instead of a hardcoded name. */
route("GET", "/api/operator", async (_req, _params, t) => {
  if (t.session) return json({ name: t.session.user.name ?? t.session.user.login, source: "account" });
  const fromGit = (await $`git config --global user.name`.quiet().nothrow().text()).trim();
  const name = fromGit || process.env.USER || "there";
  return json({ name, source: fromGit ? "git" : process.env.USER ? "env" : "default" });
});

/** Where an account's server-side app checkouts live. */
function managedRepoDir(t: Tenant, appId: string): string {
  return t.mode === "accounts"
    ? resolve(ORCHESTRATOR_ROOT, MANAGED_REPOS_DIR, t.accountId, appId)
    : resolve(ORCHESTRATOR_ROOT, MANAGED_REPOS_DIR, appId);
}

/** Pointing day2 at a folder on the server is for local development only —
 * in production it would let a customer read any path on the machine. */
function allowLocalPaths(t: Tenant): boolean {
  return t.mode === "local" || (process.env.DAY2_ALLOW_LOCAL_PATHS === "on" && process.env.NODE_ENV !== "production");
}

function requireGitHubConnected(t: Tenant): number {
  if (t.githubInstallationId === null) {
    throw new HttpError(409, "Connect GitHub first — day2 only sees the repositories you choose there.", "github_not_connected");
  }
  return t.githubInstallationId;
}

route("POST", "/api/apps", async (req, _params, t) => {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    repoPath?: string;
    connectionMethod?: ConnectionMethod;
    githubRepo?: string;
    appBaseUrl?: string;
  };
  if (!body.name || !body.connectionMethod) throw new HttpError(400, "name and connectionMethod are required.");

  if (t.mode === "accounts" && body.connectionMethod === "github") {
    // Production: the repo comes through day2's GitHub App, cloned here.
    const installationId = requireGitHubConnected(t);
    const full = typeof body.githubRepo === "string" ? body.githubRepo.trim() : "";
    if (!full) throw new HttpError(400, "githubRepo (owner/name) is required.");
    await requireAppSlot(t);
    let repos: InstallationRepo[];
    try {
      repos = await listInstallationRepos(installationId);
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
    const repo = repos.find((r) => r.fullName.toLowerCase() === full.toLowerCase());
    if (!repo) throw new HttpError(404, `day2 can't see ${full} — add it to day2's access on GitHub first.`, "repo_not_granted");
    const id = generateAppId();
    const dir = managedRepoDir(t, id);
    mkdirSync(dirname(dir), { recursive: true });
    try {
      await cloneWithInstallation(installationId, repo.fullName, dir);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw new HttpError(502, (err as Error).message);
    }
    const result = await t.apps.add({ id, name: body.name, repoPath: dir, connectionMethod: "github", githubRepo: repo.fullName, appBaseUrl: body.appBaseUrl });
    if (!result.ok) {
      rmSync(dir, { recursive: true, force: true });
      throw new HttpError(409, result.reason);
    }
    return json({ app: result.app }, { status: 201 });
  }

  if (!body.repoPath) throw new HttpError(400, "repoPath is required.");
  if (body.connectionMethod === "local_path" && !allowLocalPaths(t)) {
    throw new HttpError(400, "Connecting a folder on the server isn't available — connect a GitHub repository or upload a .zip.");
  }
  if (t.mode === "accounts" && body.connectionMethod !== "local_path") {
    throw new HttpError(400, "Connect a GitHub repository or upload a .zip.");
  }
  await requireAppSlot(t);
  const result = await t.apps.add({
    name: body.name,
    repoPath: body.repoPath,
    connectionMethod: body.connectionMethod,
    githubRepo: body.githubRepo,
    appBaseUrl: body.appBaseUrl,
  });
  if (!result.ok) throw new HttpError(409, result.reason);
  return json({ app: result.app }, { status: 201 });
});

route("PATCH", "/api/apps/:id", async (req, params, t) => {
  const body = (await req.json().catch(() => ({}))) as { appBaseUrl?: unknown };
  if (body.appBaseUrl !== undefined && body.appBaseUrl !== null && typeof body.appBaseUrl !== "string") {
    throw new HttpError(400, "appBaseUrl must be a string.");
  }
  const result = await t.apps.setBaseUrl(params.id!, (body.appBaseUrl as string | null | undefined) ?? undefined);
  if (!result.ok) throw new HttpError(result.reason.startsWith("No app registered") ? 404 : 400, result.reason);
  return json({ app: result.app });
});

route("DELETE", "/api/apps/:id", async (_req, params, t) => {
  requireManager(t);
  const app = await t.apps.find(params.id!);
  await t.apps.remove(params.id!);
  // A checkout day2 made for this account goes with it.
  if (app && t.mode === "accounts" && app.repoPath === managedRepoDir(t, app.id)) rmSync(app.repoPath, { recursive: true, force: true });
  return json({ ok: true });
});

// ---- Connect, option A: GitHub ----

route("GET", "/api/github/repos", async (_req, _params, t) => {
  if (t.mode === "accounts") {
    const installationId = requireGitHubConnected(t);
    try {
      const repos = await listInstallationRepos(installationId);
      return json({
        repos: repos.map((r) => ({ name: r.name, owner: { login: r.owner }, url: r.url, sshUrl: `git@github.com:${r.fullName}.git`, updatedAt: r.updatedAt, private: r.private })),
      });
    } catch (err) {
      throw new HttpError(err instanceof GitHubAccessError ? 409 : 502, (err as Error).message, err instanceof GitHubAccessError ? "github_not_connected" : undefined);
    }
  }
  // Local mode: the operator's own `gh` session.
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

/** Starts "Connect GitHub": GitHub's install page, where the person picks
 * which repos day2 may use. GitHub returns to /api/auth/github/callback. */
route("POST", "/api/github/install", async (_req, _params, t) => {
  requireManager(t);
  if (t.mode !== "accounts" || !hasGitHubApp()) throw new HttpError(409, "day2's GitHub App isn't set up on this server.");
  const state = await createOAuthState(db(), "/setup", t.accountId);
  return json({ url: installUrl(state) });
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

route("POST", "/api/apps/upload", async (req, _params, t) => {
  const form = await req.formData();
  const file = form.get("file");
  const name = form.get("name");
  if (!(file instanceof File) || typeof name !== "string" || !name) {
    throw new HttpError(400, "multipart form with a `file` (.zip) and a `name` field is required.");
  }
  await requireAppSlot(t);
  const id = generateAppId();
  const destDir = managedRepoDir(t, id);
  mkdirSync(destDir, { recursive: true });
  const zipPath = resolve(destDir, "upload.zip");
  try {
    await Bun.write(zipPath, file);
    await assertZipEntriesAreContained(zipPath, destDir);
    await $`unzip -o ${zipPath} -d ${destDir}`.quiet();
    rmSync(zipPath, { force: true });

    const result = await t.apps.add({ id, name, repoPath: destDir, connectionMethod: "upload" });
    if (!result.ok) {
      rmSync(destDir, { recursive: true, force: true });
      throw new HttpError(409, result.reason);
    }
    return json({ app: result.app }, { status: 201 });
  } catch (err) {
    rmSync(destDir, { recursive: true, force: true });
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Couldn't extract the uploaded .zip: ${(err as Error).message}`);
  }
});

// ---- Onboarding (plan §2/§3.1) ----

route("POST", "/api/apps/:id/onboarding/scan", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const { result, credits } = await runWithCredits(t, app, "scan_answer", "App scan", SCAN_MAX_BUDGET_USD, () =>
    scanAppProfile(app.repoPath),
  );
  return json({ ...result, credits });
});

route("GET", "/api/apps/:id/onboarding/profile", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const profile = loadAppProfile(appFile(app, APP_PROFILE_FILENAME));
  return json({ profile, rendered: profile ? renderAppProfilePlainLanguage(profile) : null });
});

route("PUT", "/api/apps/:id/onboarding/profile", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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

route("GET", "/api/apps/:id/autonomy/config", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  if (!hasGitRemote(app.repoPath)) {
    return json({ available: false, reason: `"${app.name}" has no connected git remote — connect one to enable this.` });
  }
  const config = loadAutonomyConfig(appFile(app, AUTONOMY_CONFIG_FILENAME));
  return json({ available: true, config, summary: renderConfigSummary(config) });
});

route("PUT", "/api/apps/:id/autonomy/areas/:area", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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

route("DELETE", "/api/apps/:id/autonomy/areas/:area", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  requireGitRemote(app);
  const path = appFile(app, AUTONOMY_CONFIG_FILENAME);
  const config = loadAutonomyConfig(path);
  const next = removeArea(config, params.area!);
  saveAutonomyConfig(path, next);
  return json({ config: next, summary: renderConfigSummary(next) });
});

route("POST", "/api/apps/:id/autonomy/preview", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
  requireGitRemote(app);
  const body = (await req.json()) as { area: string; pathGlobs: string[]; level: AutonomyLevel };
  const config = loadAutonomyConfig(appFile(app, AUTONOMY_CONFIG_FILENAME));
  return json(previewArea(config, body));
});

route("GET", "/api/apps/:id/autonomy/audit", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
  const entries = loadAuditEntries(appFile(app, AUDIT_FILENAME), sinceParam(req));
  return json({ entries, rendered: renderFeed(entries) });
});

// ---- Approvals (plan §3.4) — real, hard-to-reverse GitHub actions ----

route("GET", "/api/apps/:id/approvals", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  if (!hasGitRemote(app.repoPath)) {
    return json({ available: false, reason: `"${app.name}" has no connected git remote — connect one to enable this.`, cards: [] });
  }
  const cards = await fetchPendingChangeCards(app.repoPath);
  return json({ available: true, cards });
});

route("POST", "/api/apps/:id/approvals/:pr/apply", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  requireGitRemote(app);
  await applyChange(app.repoPath, Number(params.pr));
  return json({ ok: true });
});

route("POST", "/api/apps/:id/approvals/:pr/undo", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  requireGitRemote(app);
  await undoChange(app.repoPath, Number(params.pr));
  return json({ ok: true });
});

route("POST", "/api/apps/:id/approvals/:pr/ask", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
  requireGitRemote(app);
  const body = (await req.json()) as { question?: string };
  if (!body.question) throw new HttpError(400, "question is required.");
  await askQuestion(app.repoPath, Number(params.pr), body.question);
  return json({ ok: true });
});

// ---- Releases (plan §3.2) ----

route("GET", "/api/apps/:id/releases", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
  const results = loadReleaseResults(appFile(app, "day2-release-results.jsonl"), sinceParam(req));
  return json({ results });
});

// ---- Budget & Spend (plan §3.5) ----

route("GET", "/api/apps/:id/growth/config", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const config = loadGrowthConfig(appFile(app, GROWTH_CONFIG_FILENAME));
  const { account, events } = await readCredits(t.credits);
  return json({ config, credits: appCreditUsage(account, events, app.id, new Date()) });
});

route("PUT", "/api/apps/:id/growth/budget", async (req, params, t) => {
  const body = (await req.json()) as { monthlyBudgetUsd: number };
  return updateGrowthConfig(t, params.id!, (c) => setMonthlyBudget(c, body.monthlyBudgetUsd));
});

route("PUT", "/api/apps/:id/growth/kill-switch", async (req, params, t) => {
  const body = (await req.json()) as { killSwitch: boolean };
  return updateGrowthConfig(t, params.id!, (c) => setKillSwitch(c, body.killSwitch));
});

route("PUT", "/api/apps/:id/growth/daily-cap", async (req, params, t) => {
  const body = (await req.json()) as { dailyCapUsd?: number };
  return updateGrowthConfig(t, params.id!, (c) => setDailyCap(c, body.dailyCapUsd));
});

route("PUT", "/api/apps/:id/growth/category-cap/:cat", async (req, params, t) => {
  const body = (await req.json()) as { capUsd: number };
  return updateGrowthConfig(t, params.id!, (c) => setCategoryCap(c, params.cat as SpendCategory, body.capUsd));
});

route("PUT", "/api/apps/:id/growth/kpi-goals/:metric", async (req, params, t) => {
  const body = (await req.json()) as { target: number; byDate?: string };
  return updateGrowthConfig(t, params.id!, (c) =>
    setKpiGoal(c, { metric: params.metric!, target: body.target, byDate: body.byDate }),
  );
});

route("DELETE", "/api/apps/:id/growth/kpi-goals/:metric", async (_req, params, t) => {
  return updateGrowthConfig(t, params.id!, (c) => removeKpiGoal(c, params.metric!));
});

route("PUT", "/api/apps/:id/growth/website", async (req, params, t) => {
  const body = (await req.json()) as { enabled: boolean; templatePreference?: string };
  return updateGrowthConfig(t, params.id!, (c) => setWebsiteEnabled(c, body.enabled, body.templatePreference));
});

// ---- Growth strategy (plan §3.6) ----

route("GET", "/api/apps/:id/growth/strategy", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
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

route("GET", "/api/apps/:id/growth/allocator", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const state = loadAllocatorState(appFile(app, "day2-allocator-state.json"));
  return json({ state: publicAllocatorState(state) });
});

// ---- Growth feed / creative library (plan §3.6) ----
// GrowthActionRecord.toolUsed is already the allowlisted DTO shape
// ({capability, mcpServerName, reason}) at the type level (growth-feed.ts) —
// no raw ToolBinding/credential ever exists on this object to scrub.

route("GET", "/api/apps/:id/growth/feed", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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

route("GET", "/api/apps/:id/evolution/proposals", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const proposals = listProposals(appFile(app, "day2-proposals.jsonl"));
  return json({ proposals });
});

// ---- Ask day2 (console Home question bar) — read-only answers ----

route("GET", "/api/apps/:id/ask", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  return json({ entries: loadAskLog(appFile(app, ASK_LOG_FILENAME)) });
});

route("POST", "/api/apps/:id/ask", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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

  const { result, credits } = await runWithCredits(t, app, "scan_answer", "Answer", ASK_MAX_BUDGET_USD, () =>
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

route("GET", "/api/credits", async (_req, _params, t) => {
  return json({ ...(await getSummary(t.credits)), catalog: catalog() });
});

route("PUT", "/api/credits/plan", async (req, _params, t) => {
  requireManager(t);
  const body = (await req.json().catch(() => ({}))) as { plan?: unknown; billingCycle?: unknown };
  const plan = body.plan as PaidPlanId;
  const cycle = (body.billingCycle ?? "monthly") as BillingCycle;
  if (!["starter", "growth", "scale"].includes(plan)) throw new HttpError(400, "plan must be starter, growth or scale.");
  if (cycle !== "monthly" && cycle !== "yearly") throw new HttpError(400, "billingCycle must be monthly or yearly.");
  const { effective, summary } = await setPlan(t.credits, plan, cycle);
  return json({ effective, ...summary, catalog: catalog() });
});

route("POST", "/api/credits/top-ups", async (req, _params, t) => {
  requireManager(t);
  const body = (await req.json().catch(() => ({}))) as { packId?: unknown };
  if (typeof body.packId !== "string" || !TOPUP_PACKS.some((p) => p.id === body.packId)) {
    throw new HttpError(400, `packId must be one of: ${TOPUP_PACKS.map((p) => p.id).join(", ")}.`);
  }
  try {
    await buyTopUp(t.credits, body.packId);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
  return json({ ...(await getSummary(t.credits)), catalog: catalog() }, { status: 201 });
});

route("PUT", "/api/credits/auto-top-up", async (req, _params, t) => {
  requireManager(t);
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; packId?: unknown };
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
  const packId = typeof body.packId === "string" ? body.packId : TOPUP_PACKS[0]!.id;
  if (!TOPUP_PACKS.some((p) => p.id === packId)) throw new HttpError(400, "Unknown top-up pack.");
  const summary = await updateAccount(t.credits, (a) => ({ ...a, autoTopUp: { enabled: body.enabled as boolean, packId } }));
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
route("PUT", "/api/apps/:id/credits/caps", async (req, params, t) => {
  requireManager(t);
  const app = await requireApp(t, params.id!);
  const body = (await req.json().catch(() => ({}))) as { monthlyCredits?: unknown; dailyCredits?: unknown };
  const monthly = parseCap(body.monthlyCredits, "monthlyCredits");
  const daily = parseCap(body.dailyCredits, "dailyCredits");
  await updateAccount(t.credits, (a) => {
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
  const { account, events } = await readCredits(t.credits);
  return json({ credits: appCreditUsage(account, events, app.id, new Date()), config });
});

// ---- Backlog (one board of bugs, features, improvements and tasks) ----

const TYPES: TicketType[] = ["bug", "feature", "improvement", "task"];
const isPriority = (p: unknown): p is Priority => p === 1 || p === 2 || p === 3 || p === 4;

async function requirePlanFeature(t: Tenant, feature: "trackerSync" | "createApps"): Promise<void> {
  const { account } = await readCredits(t.credits);
  const plan = PLANS[account.plan];
  if (!plan.features[feature]) {
    throw new HttpError(402, feature === "trackerSync" ? `JIRA and Linear sync aren't included in the ${plan.name} plan — switch to Growth or Scale.` : `Creating apps isn't included in the ${plan.name} plan — switch to Growth or Scale.`);
  }
}

/** Done tickets older than this stay in the file but aren't sent. */
const DONE_WINDOW_DAYS = 30;

async function backlogResponse(t: Tenant, app: AppEntry, b: Awaited<ReturnType<typeof loadBacklogFor>>) {
  const cutoff = Date.now() - DONE_WINDOW_DAYS * 86_400_000;
  return {
    tickets: b.tickets.filter((t) => t.state !== "done" || new Date(t.doneAt ?? t.updatedAt).getTime() >= cutoff),
    settings: b.settings,
    lastRankedAt: b.lastRankedAt ?? null,
    running: b.tickets.filter((t) => isRunning(app.id, t.id)).map((t) => t.id),
    canWork: hasGitRemote(app.repoPath),
    integrations: publicIntegrations(await t.integrations.get(app.id)),
  };
}

function loadBacklogFor(app: AppEntry) {
  return withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
}

route("GET", "/api/apps/:id/backlog", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  return json(await backlogResponse(t, app, await loadBacklogFor(app)));
});

route("POST", "/api/apps/:id/backlog/tickets", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw new HttpError(400, "A ticket needs a title.");
  if (title.length > 200) throw new HttpError(400, "Keep the title under 200 characters.");
  if (!TYPES.includes(body.type as TicketType)) throw new HttpError(400, "type must be bug, feature, improvement or task.");
  if (body.priority !== undefined && body.priority !== null && !isPriority(body.priority)) throw new HttpError(400, "priority must be 1–4, or left out to let day2 decide.");
  const alsoIn = Array.isArray(body.alsoCreateIn) ? (body.alsoCreateIn as unknown[]).filter((x): x is "linear" | "jira" => x === "linear" || x === "jira") : [];
  const createdBy = await actorName(t);
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
    await requirePlanFeature(t, "trackerSync");
    for (const { client } of (await trackerClientsFor(t.integrations, app.id)).filter((c) => alsoIn.includes(c.client.system))) {
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

route("PATCH", "/api/apps/:id/backlog/tickets/:tid", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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

route("DELETE", "/api/apps/:id/backlog/tickets/:tid", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  if (isRunning(app.id, params.tid!)) throw new HttpError(409, "day2 is working on this ticket right now.");
  await withBacklog(backlogFile(app), (b) => {
    if (!findTicket(b, params.tid!)) throw new HttpError(404, `No ticket ${params.tid}.`);
    return { backlog: deleteTicket(b, params.tid!), result: null };
  });
  return json({ ok: true });
});

route("POST", "/api/apps/:id/backlog/tickets/:tid/comments", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new HttpError(400, "The comment is empty.");
  if (text.length > 4000) throw new HttpError(400, "Keep a comment under 4,000 characters.");
  const name = await actorName(t);
  const ticket = await withBacklog(backlogFile(app), (b) => {
    if (!findTicket(b, params.tid!)) throw new HttpError(404, `No ticket ${params.tid}.`);
    const next = addActivity(b, params.tid!, { actor: "user", name, kind: "comment", text }, new Date());
    return { backlog: next, result: findTicket(next, params.tid!)! };
  });
  return json({ ticket }, { status: 201 });
});

route("POST", "/api/apps/:id/backlog/tickets/:tid/work", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const r = await startTicket(app, params.tid!);
  if (!r.ok) throw new HttpError(r.status, r.reason);
  return json({ ticket: r.ticket, started: r.started }, { status: 202 });
});

/** OK on a plan (starts the build) or on a fix PR (merges it). */
route("POST", "/api/apps/:id/backlog/tickets/:tid/approve", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const b = await loadBacklogFor(app);
  const tk = findTicket(b, params.tid!);
  if (!tk) throw new HttpError(404, `No ticket ${params.tid}.`);
  if (tk.state !== "to_approve" || !tk.approval) throw new HttpError(409, "Nothing on this ticket is waiting for approval.");
  if (tk.approval.kind === "pr") {
    requireGitRemote(app);
    await applyChange(app.repoPath, tk.approval.number);
    const ticket = await withBacklog(backlogFile(app), (bb) => {
      const r = updateTicket(bb, tk.id, { state: "done" }, new Date(), { kind: "user" });
      return { backlog: r.backlog, result: r.ticket };
    });
    return json({ ticket });
  }
  // Plan approved: back to To do with the plan kept, then start building.
  await withBacklog(backlogFile(app), (bb) => {
    const cur = findTicket(bb, tk.id)!;
    const ticket: Ticket = {
      ...cur,
      state: "todo",
      activity: [...cur.activity, { at: new Date().toISOString(), actor: "user", kind: "work", text: "approved the plan." }],
    };
    return { backlog: putTicket(bb, ticket), result: null };
  });
  const r = await startTicket(app, tk.id);
  if (!r.ok) throw new HttpError(r.status, r.reason);
  return json({ ticket: r.ticket, started: r.started }, { status: 202 });
});

/** "Not this" on a plan, or close the fix PR without merging. */
route("POST", "/api/apps/:id/backlog/tickets/:tid/reject", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const b = await loadBacklogFor(app);
  const tk = findTicket(b, params.tid!);
  if (!tk) throw new HttpError(404, `No ticket ${params.tid}.`);
  if (tk.state !== "to_approve" || !tk.approval) throw new HttpError(409, "Nothing on this ticket is waiting for approval.");
  if (tk.approval.kind === "pr") {
    requireGitRemote(app);
    await undoChange(app.repoPath, tk.approval.number);
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? `: ${body.reason.trim().slice(0, 500)}` : ".";
  const what = tk.approval.kind === "pr" ? `closed PR #${tk.approval.number} without merging` : "sent the plan back";
  const ticket = await withBacklog(backlogFile(app), (bb) => {
    const r = updateTicket(bb, tk.id, { state: "todo" }, new Date(), { kind: "user" });
    const next: Ticket = {
      ...r.ticket,
      activity: [...r.ticket.activity, { at: new Date().toISOString(), actor: "user", kind: "work", text: `${what}${reason}` }],
    };
    return { backlog: putTicket(r.backlog, next), result: next };
  });
  return json({ ticket });
});

route("PUT", "/api/apps/:id/backlog/settings", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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

route("POST", "/api/apps/:id/backlog/rerank", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const changes = await withBacklog(backlogFile(app), (b) => {
    const r = rankBacklog(b, new Date());
    return { backlog: r.backlog, result: r.changes };
  });
  return json({ changes, ...(await backlogResponse(t, app, await loadBacklogFor(app))) });
});

/** Import new findings, re-rank, reconcile PRs, sync trackers. Never
 * starts work by itself — that's `bun run backlog tick` on a schedule. */
route("POST", "/api/apps/:id/backlog/refresh", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  const b0 = await loadBacklogFor(app);
  const sentry = b0.settings.sentry;
  const report = await tick(app, {
    gatherSignals:
      sentry && process.env.SENTRY_AUTH_TOKEN
        ? () => gatherSignalsForApp({ id: app.id, sentryOrg: sentry.org, sentryProject: sentry.project })
        : undefined,
  });
  const sync = (await trackerClientsFor(t.integrations, app.id)).length ? await syncAppTrackers(app, t.integrations) : [];
  return json({ report, sync, ...(await backlogResponse(t, app, await loadBacklogFor(app))) });
});

// ---- Tell day2 (plain-words instructions that change the backlog) ----

function tellLogPath(app: AppEntry) {
  return appFile(app, TELL_LOG_FILENAME);
}

route("GET", "/api/apps/:id/backlog/tell", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  return json({ records: loadTellLog(tellLogPath(app)) });
});

route("POST", "/api/apps/:id/backlog/tell", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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
  const { result, credits } = await runWithCredits(t, app, "scan_answer", "Backlog plan", TELL_MAX_BUDGET_USD, () => runTellAgent(app.repoPath, prompt));
  if (!result.ok) return json({ ok: false, reason: result.reason, credits });

  const record = await withBacklog(backlogFile(app), (b) => {
    const applied = applyTellPlan(b, result.plan, valid.instruction, new Date());
    return { backlog: rankBacklog(applied.backlog, new Date()).backlog, result: { ...applied.record, credits, ...(earlier ? { answerTo: earlier.id } : {}) } };
  });
  const nextLog = log.map((r) =>
    earlier && r.id === earlier.id && r.question ? { ...r, question: { ...r.question, answer: valid.instruction, answeredAt: record.at } } : r,
  );
  saveTellLog(tellLogPath(app), [record, ...nextLog]);
  return json({ ok: true, record, ...(await backlogResponse(t, app, await loadBacklogFor(app))) });
});

route("POST", "/api/apps/:id/backlog/tell/:rid/undo", async (req, params, t) => {
  const app = await requireApp(t, params.id!);
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
  return json({ record: undone, ...(await backlogResponse(t, app, await loadBacklogFor(app))) });
});

// ---- JIRA / Linear connections ----

route("GET", "/api/apps/:id/integrations", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  return json(publicIntegrations(await t.integrations.get(app.id)));
});

route("PUT", "/api/apps/:id/integrations/:system", async (req, params, t) => {
  requireManager(t);
  const app = await requireApp(t, params.id!);
  await requirePlanFeature(t, "trackerSync");
  const system = params.system;
  if (system !== "linear" && system !== "jira") throw new HttpError(404, "Only linear and jira can be connected.");
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const current = (await t.integrations.get(app.id)) ?? {};
  let next: AppIntegrations;
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
    next = { ...current, linear: { ...current.linear, ...cfg, lastError: null } };
  } else {
    const site = s("site") || current.jira?.site || "";
    const email = s("email") || current.jira?.email || "";
    const apiToken = s("apiToken") || current.jira?.apiToken || "";
    const projectKey = s("projectKey") || current.jira?.projectKey || "";
    if (!/^https:\/\/[^/]+$/.test(site.replace(/\/+$/, ""))) throw new HttpError(400, "JIRA site must look like https://your-team.atlassian.net");
    if (!email || !apiToken || !projectKey) throw new HttpError(400, "JIRA needs your email, an API token and a project key (like EB).");
    next = {
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
  }
  // Keep fields another request changed meanwhile (sync times), replace ours.
  const saved = await t.integrations.update(app.id, (cur) => ({ ...cur, [system]: next[system] }));
  return json(publicIntegrations(saved));
});

route("DELETE", "/api/apps/:id/integrations/:system", async (_req, params, t) => {
  requireManager(t);
  const app = await requireApp(t, params.id!);
  if (params.system !== "linear" && params.system !== "jira") throw new HttpError(404, "Only linear and jira can be connected.");
  const system = params.system;
  const saved = await t.integrations.update(app.id, (cur) => {
    const next = { ...cur };
    delete next[system];
    return next;
  });
  return json(publicIntegrations(saved));
});

route("POST", "/api/apps/:id/backlog/sync", async (_req, params, t) => {
  const app = await requireApp(t, params.id!);
  await requirePlanFeature(t, "trackerSync");
  if (!(await trackerClientsFor(t.integrations, app.id)).length) throw new HttpError(409, "Connect JIRA or Linear first.");
  const sync = await syncAppTrackers(app, t.integrations);
  return json({ sync, ...(await backlogResponse(t, app, await loadBacklogFor(app))) });
});

// ---- Create an app with Lovable (day2's own Lovable account) ----

function requireCreateApps(): void {
  if (!features().createApps) throw new HttpError(404, "Creating apps isn't available yet.");
}

/** Public: what the console should offer, before anyone signs in. */
route(
  "GET",
  "/api/features",
  () =>
    json({
      ...features(),
      mode: serverMode(),
      signIn: serverMode() === "accounts" ? { github: Boolean(authConfig().githubClientId), dev: authConfig().devLogin } : null,
    }),
  { public: true },
);

/** day2-level actions (connecting day2's own Lovable account) are for the
 * people running day2, not for customers: DAY2_OPERATOR_LOGINS lists their
 * GitHub usernames. Locally, the one operator. */
function requireOperator(t: Tenant): void {
  if (t.mode === "local") return;
  const ops = (process.env.DAY2_OPERATOR_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!t.session || !ops.includes(t.session.user.login.toLowerCase())) throw new HttpError(403, "Only day2's operators can do this.");
}

function lovableSetup(): LovableSetup {
  const callbackBase = serverMode() === "accounts" ? authConfig().publicUrl : `http://localhost:${PORT}`;
  return { dir: dataDir(), callbackUrl: `${callbackBase}/api/lovable/oauth/callback` };
}

function buildDeps(t: Tenant): BuildDeps {
  const setup = lovableSetup();
  return {
    tools: () => connectTools(setup),
    repoDir: (id) => managedRepoDir(t, id),
    pushToGitHub: defaultPushToGitHub,
    apps: t.apps,
    accountId: t.accountId,
    credits: t.credits,
  };
}

route("GET", "/api/lovable", (_req, _params, t) => {
  requireCreateApps();
  const setup = lovableSetup();
  return json({ ...lovableStatus(setup), builds: loadBuilds(setup, t.accountId).slice(0, 10) });
});

/** One-time: the operator signs day2's own Lovable account in. */
route("POST", "/api/lovable/connect", async (_req, _params, t) => {
  requireCreateApps();
  requireOperator(t);
  try {
    return json(await beginConnect(lovableSetup()));
  } catch (err) {
    throw new HttpError(502, `Couldn't reach Lovable to connect: ${(err as Error).message}`);
  }
});

route(
  "GET",
  "/api/lovable/oauth/callback",
  async (req) => {
    const url = new URL(req.url);
    requireCreateApps();
    const code = url.searchParams.get("code");
    const back = `${consoleOrigin()}/setup/create`;
    if (!code) return Response.redirect(`${back}?lovable=error`, 302);
    try {
      // The OAuth state (checked inside) ties this to a connect the operator started.
      await finishConnect(lovableSetup(), code, url.searchParams.get("state"));
      return Response.redirect(`${back}?lovable=connected`, 302);
    } catch (err) {
      console.error("[day2-lovable] connect failed:", err);
      return Response.redirect(`${back}?lovable=error`, 302);
    }
  },
  { public: true },
);

route("POST", "/api/apps/create", async (req, _params, t) => {
  requireCreateApps();
  await requirePlanFeature(t, "createApps");
  const valid = validateBuildRequest(await req.json().catch(() => null));
  if (!valid.ok) throw new HttpError(400, valid.reason);
  await requireAppSlot(t);
  try {
    return json({ build: await startBuild(lovableSetup(), valid.request, buildDeps(t)) }, { status: 202 });
  } catch (err) {
    if (err instanceof CreditsError) throw err;
    throw new HttpError(409, (err as Error).message);
  }
});

route("GET", "/api/lovable/builds/:bid", (_req, params, t) => {
  requireCreateApps();
  const build = getBuild(lovableSetup(), params.bid!, t.accountId);
  if (!build) throw new HttpError(404, "No such build.");
  return json({ build });
});

route("POST", "/api/lovable/builds/:bid/answer", async (req, params, t) => {
  requireCreateApps();
  const body = (await req.json().catch(() => ({}))) as { decision?: unknown };
  if (body.decision !== "approved" && body.decision !== "rejected") throw new HttpError(400, "decision must be approved or rejected.");
  try {
    return json({ build: await answerBuild(lovableSetup(), params.bid!, body.decision, buildDeps(t)) });
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
});

// ---- Sign-in, the signed-in person, and the account's people ----

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function requireAccounts(t?: Tenant): void {
  if ((t?.mode ?? serverMode()) !== "accounts") throw new HttpError(404, "Sign-in isn't used when day2 runs locally.");
}

/** Start GitHub sign-in. `?next=/apps/x` returns there afterwards. */
route(
  "GET",
  "/api/auth/github",
  async (req) => {
    requireAccounts();
    if (!authConfig().githubClientId) throw new HttpError(503, "GitHub sign-in isn't configured on this server.");
    const state = await createOAuthState(db(), new URL(req.url).searchParams.get("next") ?? "/");
    return redirect(githubAuthorizeUrl(state));
  },
  { public: true },
);

/**
 * GitHub sends people back here after signing in — and after installing
 * day2's GitHub App ("Connect GitHub"), with `installation_id`, because the
 * App asks for user authorization during installation. Either way: who is
 * this, open a session, and (for an install) link the installation to the
 * account that started it, once GitHub confirms this person can see it.
 */
route(
  "GET",
  "/api/auth/github/callback",
  async (req) => {
    requireAccounts();
    const url = new URL(req.url);
    const sql = db();
    const fail = (reason: string) => redirect(`${consoleOrigin()}/login?error=${encodeURIComponent(reason)}`);
    const state = await consumeOAuthState(sql, url.searchParams.get("state"));
    const code = url.searchParams.get("code");
    if (!state || !code) return fail("That sign-in link expired — please try again.");
    const installationParam = url.searchParams.get("installation_id");
    const installationId = installationParam && /^\d+$/.test(installationParam) ? Number(installationParam) : undefined;
    let profile;
    try {
      profile = await fetchGitHubProfile(code, fetch, installationId !== undefined ? { installationId } : {});
    } catch (err) {
      console.error("[day2-auth] GitHub sign-in failed:", (err as Error).message);
      return fail("GitHub sign-in didn't work — please try again.");
    }
    const signedIn = await signInUser(sql, profile);
    let accountId = signedIn.accountId;
    let next = state.nextPath;
    if (installationId !== undefined) {
      const target = state.accountId ?? signedIn.accountId;
      const linked = profile.installationVerified
        ? await attachInstallation(sql, target, signedIn.userId, installationId)
        : { ok: false as const, status: 403, reason: "GitHub didn't confirm you can use that installation." };
      if (linked.ok) accountId = target;
      next = `${safeNextPath(next)}${next.includes("?") ? "&" : "?"}github=${linked.ok ? "connected" : encodeURIComponent(linked.reason)}`;
    } else if (state.accountId) {
      const member = await sql`SELECT 1 FROM memberships WHERE account_id = ${state.accountId} AND user_id = ${signedIn.userId}`;
      if (member.length) accountId = state.accountId;
    }
    const token = await createSession(sql, signedIn.userId, accountId, req.headers.get("user-agent"));
    return redirect(`${consoleOrigin()}${safeNextPath(next)}`, sessionCookie(token));
  },
  { public: true },
);

/** Development only (DAY2_DEV_LOGIN=on, never in production): sign in as a
 * GitHub username without GitHub, for local testing of accounts mode. */
route(
  "POST",
  "/api/auth/dev",
  async (req) => {
    requireAccounts();
    if (!authConfig().devLogin) throw new HttpError(404, `No route for POST /api/auth/dev`);
    const body = (await req.json().catch(() => ({}))) as { login?: unknown };
    const login = typeof body.login === "string" ? body.login.trim() : "";
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new HttpError(400, "login must be a GitHub username.");
    // Dev users get ids far outside GitHub's range so they never collide.
    const id = 9_000_000_000_000 + (parseInt(hashToken(login.toLowerCase()).slice(0, 10), 16) % 1_000_000_000);
    const signedIn = await signInUser(db(), { id, login, name: login, email: null, avatarUrl: null });
    const token = await createSession(db(), signedIn.userId, signedIn.accountId, req.headers.get("user-agent"));
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
  },
  { public: true },
);

route("POST", "/api/auth/logout", async (_req, _params, t) => {
  requireAccounts(t);
  await deleteSession(db(), t.session!.tokenHash);
  return json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie() } });
});

route("GET", "/api/me", async (_req, _params, t) => {
  if (t.mode === "local") {
    const name = await localOperatorName();
    return json({
      mode: "local",
      user: { login: name, name, avatarUrl: null },
      account: { id: t.accountId, name, role: "owner" },
      accounts: [],
      github: { connected: true, canConnect: false },
    });
  }
  const s = t.session!;
  return json({
    mode: "accounts",
    user: { id: s.user.id, login: s.user.login, name: s.user.name, avatarUrl: s.user.avatarUrl },
    account: { id: s.account.id, name: s.account.name, role: s.account.role },
    accounts: await listAccounts(db(), s.user.id),
    github: { connected: s.account.githubInstallationId !== null, canConnect: hasGitHubApp() && canManage(s.account.role), available: hasGitHubApp() },
    devLogin: authConfig().devLogin,
  });
});

route("POST", "/api/auth/switch", async (req, _params, t) => {
  requireAccounts(t);
  const body = (await req.json().catch(() => ({}))) as { accountId?: unknown };
  if (typeof body.accountId !== "string" || !(await switchAccount(db(), t.session!, body.accountId))) {
    throw new HttpError(404, "You aren't a member of that account.");
  }
  return json({ ok: true });
});

route("PATCH", "/api/account", async (req, _params, t) => {
  requireAccounts(t);
  requireManager(t);
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) throw new HttpError(400, "Give the account a name (up to 80 characters).");
  await db()`UPDATE accounts SET name = ${name} WHERE id = ${t.accountId}`;
  return json({ ok: true, name });
});

async function membersResponse(t: Tenant) {
  const sql = db();
  return { ...(await listMembers(sql, t.accountId)), seats: await seatUsage(sql, t.accountId), you: t.session!.user.id, canManage: canManage(t.role) };
}

function memberResult(r: MemberResult): void {
  if (!r.ok) throw new HttpError(r.status, r.reason);
}

route("GET", "/api/account/members", async (_req, _params, t) => {
  requireAccounts(t);
  return json(await membersResponse(t));
});

route("POST", "/api/account/invites", async (req, _params, t) => {
  requireAccounts(t);
  const body = (await req.json().catch(() => ({}))) as { login?: unknown; role?: unknown };
  const login = typeof body.login === "string" ? body.login.trim().replace(/^@/, "") : "";
  memberResult(await invite(db(), t.accountId, t.session!, login, (body.role ?? "member") as Role));
  return json(await membersResponse(t), { status: 201 });
});

route("DELETE", "/api/account/invites/:inviteId", async (_req, params, t) => {
  requireAccounts(t);
  if (!/^[0-9a-f-]{36}$/.test(params.inviteId!)) throw new HttpError(404, "No such invite.");
  memberResult(await revokeInvite(db(), t.accountId, t.session!, params.inviteId!));
  return json(await membersResponse(t));
});

route("PUT", "/api/account/members/:userId", async (req, params, t) => {
  requireAccounts(t);
  if (!/^[0-9a-f-]{36}$/.test(params.userId!)) throw new HttpError(404, "No such member.");
  const body = (await req.json().catch(() => ({}))) as { role?: unknown };
  memberResult(await setRole(db(), t.accountId, t.session!, params.userId!, body.role as Role));
  return json(await membersResponse(t));
});

route("DELETE", "/api/account/members/:userId", async (_req, params, t) => {
  requireAccounts(t);
  if (!/^[0-9a-f-]{36}$/.test(params.userId!)) throw new HttpError(404, "No such member.");
  const self = params.userId === t.session!.user.id;
  memberResult(await removeMember(db(), t.accountId, t.session!, params.userId!));
  if (self) return json({ ok: true, left: true }, { headers: { "set-cookie": clearedSessionCookie() } });
  return json(await membersResponse(t));
});

// ---- Dispatch ----

/** Where the console is. In production it's the same origin as this API
 * (DAY2_PUBLIC_URL); in local development, vite on :3000. */
function consoleOrigin(): string {
  if (serverMode() === "accounts") return authConfig().publicUrl;
  return process.env.DAY2_CONSOLE_ORIGIN ?? "http://localhost:3000";
}

/** Local mode only: the console on :3000 calls this API on :4700. Scoped
 * to that origin, never "*" — a wildcard would let any web page open in the
 * operator's browser read responses from localhost. Production needs no
 * CORS at all: console and API share one origin. */
function withCors(res: Response): Response {
  if (serverMode() === "accounts") return res;
  res.headers.set("access-control-allow-origin", consoleOrigin());
  res.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  res.headers.set("access-control-allow-credentials", "true");
  return res;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** CSRF defence for cookie sessions: a state-changing request must come
 * from day2's own origin. Browsers always send Origin on these. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === new URL(authConfig().publicUrl).origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/** Routes whose handler waits on a Claude agent run (tens of seconds+). */
export function isAgentBackedPath(pathname: string): boolean {
  return /^\/api\/apps\/[^/]+\/(onboarding\/scan|ask|backlog\/(tell|refresh|sync)|backlog\/tickets\/[^/]+\/(approve|reject)|integrations\/[^/]+)$/.test(pathname) || /^\/api\/lovable\/(connect|builds\/[^/]+\/answer)$/.test(pathname) || pathname === "/api/apps";
}

const SIGNED_OUT = () => json({ error: "Sign in to continue.", code: "signed_out" }, { status: 401 });

/**
 * The router, as a plain `Request -> Response` function — exported so tests
 * can call it directly (no port binding, no real network).
 */
export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  const url = new URL(req.url);
  const accounts = serverMode() === "accounts";
  if (accounts && !SAFE_METHODS.has(req.method) && !sameOrigin(req)) {
    return json({ error: "Requests must come from day2 itself." }, { status: 403 });
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.pattern.exec(url);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(match.pathname.groups)) {
      if (v !== undefined) params[k] = v;
    }
    try {
      let tenant: Tenant;
      if (!accounts) tenant = localTenant();
      else {
        const session = await resolveSession(db(), readCookie(req, SESSION_COOKIE));
        if (!session && !r.public) return SIGNED_OUT();
        // Public routes don't touch account data; they get a placeholder.
        tenant = session ? sessionTenant(session) : (null as unknown as Tenant);
      }
      return withCors(await runAsTenant(tenant, () => r.handler(req, params, tenant)));
    } catch (err) {
      if (err instanceof HttpError) {
        return withCors(json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status }));
      }
      if (err instanceof CreditsError) {
        return withCors(json({ error: err.message, code: err.check.code }, { status: 402 }));
      }
      console.error(err);
      // Internal details stay in the server log in production.
      const message = accounts ? "Something went wrong on day2's side." : ((err as Error).message ?? "Internal error");
      return withCors(json({ error: message }, { status: 500 }));
    }
  }
  return withCors(json({ error: `No route for ${req.method} ${url.pathname}` }, { status: 404 }));
}

if (import.meta.main) {
  assertProductionReady();
  if (serverMode() === "accounts") {
    const applied = await migrate();
    if (applied.length) console.log(`[day2-db] Applied: ${applied.join(", ")}`);
  }
  // Production listens on all interfaces inside its container (Caddy in
  // front is the only way in); locally, localhost only.
  const hostname = process.env.DAY2_API_HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost");
  const server = Bun.serve({
    port: PORT,
    hostname,
    fetch(req, srv) {
      // Bun closes a connection after 10s idle by default — shorter than a
      // real agent call (onboarding scan, Ask day2), which silently dropped
      // those requests as "Failed to fetch". Agent-backed POSTs get no idle
      // limit; everything else keeps the default.
      if (req.method === "POST" && isAgentBackedPath(new URL(req.url).pathname)) srv.timeout(req, 0);
      return handleRequest(req);
    },
  });
  console.log(`[day2-api] ${serverMode()} mode, listening on http://${hostname}:${server.port}`);
  startBacklogTimer();
}

/**
 * Keeps every backlog moving (import findings, re-rank, settle PRs, sync
 * JIRA/Linear, start allowed work) every DAY2_BACKLOG_TICK_MINUTES (default
 * 15; 0 turns it off). With several servers on one database, a Postgres
 * advisory lock lets only one of them run each pass.
 */
function startBacklogTimer(): void {
  const minutes = Number(process.env.DAY2_BACKLOG_TICK_MINUTES ?? 15);
  if (!(minutes > 0)) return;
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      if (serverMode() === "accounts") {
        await db().begin(async (tx) => {
          const [got] = (await tx`SELECT pg_try_advisory_xact_lock(${BACKLOG_TICK_LOCK}) AS ok`) as Array<{ ok: boolean }>;
          if (got?.ok) await tickAll({ startWork: true });
        });
      } else {
        await tickAll({ startWork: true });
      }
    } catch (err) {
      console.error("[day2-backlog] tick failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(() => void pass(), minutes * 60_000);
}

const BACKLOG_TICK_LOCK = 7_207_208;
