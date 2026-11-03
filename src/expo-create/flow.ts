import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRunResult } from "../agent";
import { generateAppId, type AppEntry } from "../apps-registry";
import type { AppsStore } from "../apps-store";
import { BACKLOG_FILENAME, createTicket, loadBacklog, rankBacklog, saveBacklog } from "../backlog";
import { authorize, CreditsError, type CreditStore } from "../credits";
import type { DeviceVerdict } from "../device-checks/types";
import { missingNative } from "../live/native-foundations";
import { withCreditContext, type CreditContext } from "../metered-query";
import { childEnv, EAS_CLI_VERSION, stripAnsi, type Runner } from "../mobile-release/eas";
import { readiness, setupTicket } from "../mobile-release/setup";
import type { BugReport } from "../types";
import { assistantActionsTicket, actionsFromPlan } from "../assistant-actions";
import { BUILD_PHASES, stepReport, stepTicket, type BuildPhase } from "./build-steps";
import { ownerSteps } from "./first-build";
import { buildPlanPrompt, newScreenMockupPrompt, parsePlan, renderPlan } from "./plan";
import { BUDGET_USD, estimateCreate, identifiersFor, MAX_ATTEMPTS, MAX_MOCKUPS } from "./request";
import { createExpoAppCommand, easJson, patchAppJson, privacyNotice, RELEASE_PACKAGES } from "./scaffold";
import type { CreateStore } from "./store";
import { PHASE_LABEL, PHASES, type CheckResult, type CreateRequest, type ExpoBuild, type Mockup, type Phase, type StepCheck } from "./types";

/**
 * Create — the flow, as a state machine kept in the CreateStore:
 *
 *   plan → plan_review (owner) → mockups → mockup_review (owner) → scaffold
 *   → prewire → screens → data → polish → publish → onboard → done
 *
 * Each phase is safe to run again from its start, so a build that was
 * "working" when the server stopped picks up where it was (resumeAll).
 * The owner is asked only at the plan and the mockups — and when the build
 * agent can't get a step past its checks twice (stuck: try again or go on).
 * Every agent run is charged to the account's credits as app_build.
 */

export type CreateAgents = {
  /** The product plan agent's reply. */
  plan(prompt: string): Promise<{ text: string; isError: boolean }>;
  /** Draws one screen and renders it to `out` (PNG). Null when it couldn't. */
  mockup(prompt: string, out: string): Promise<{ note: string } | null>;
  /** The build agent (agent.ts runBuildAgent) in the new app's checkout. */
  build(cwd: string, report: BugReport): Promise<AgentRunResult>;
};

export type CreateDeps = {
  store: CreateStore;
  accountId: string;
  credits: CreditStore;
  apps: AppsStore;
  /** Where the new app's checkout goes (managed-repos/<id>). */
  repoDir: (appId: string) => string;
  /** Where mockup images go (mockups.ts mockupDir). */
  mockupDir: (appId: string) => string;
  agents: CreateAgents;
  run: Runner;
  /** Runs the app on virtual devices (device-checks); absent = skipped. */
  deviceChecks?: (i: { appId: string; cwd: string; key: string; changedFiles: string[] }) => Promise<DeviceVerdict>;
  /** Puts the day2 field library into the checkout; returns the folder it used. */
  placeLibrary: (dir: string) => Promise<string>;
  /** Creates a private GitHub repo and pushes; "owner/name" or null without GitHub. */
  pushToGitHub: (dir: string, name: string) => Promise<string | null>;
  /** The field library's key for an app id, and day2's public https address (null: none yet). */
  field: { key: (appId: string) => Promise<string | null>; endpoint: string | null };
  /** The owner's Expo token, when one is connected (eas init). */
  expoToken?: () => Promise<string | null>;
  ownerName?: string | null;
  local: boolean;
  /** Runs work as the build's account (credits, GitHub access). */
  runAs?: <T>(fn: () => Promise<T>) => Promise<T>;
};

const now = () => new Date().toISOString();
const tail = (s: string, n = 1500) => stripAnsi(s).trim().slice(-n);

// ---------------------------------------------------------------------------
// Starting and the owner's decisions
// ---------------------------------------------------------------------------

/** Checks credits, plan and name, records the build and starts it in the background. Throws CreditsError. */
export async function startCreate(request: CreateRequest, deps: CreateDeps): Promise<ExpoBuild> {
  const est = estimateCreate();
  const check = await authorize(deps.credits, { appId: null, service: "app_build", maxCostUsd: est.usd });
  if (!check.ok) throw new CreditsError(check);
  if ((await deps.apps.list()).some((a) => a.name === request.name)) throw new Error(`There's already an app called "${request.name}".`);
  const active = (await deps.store.list(deps.accountId)).find((b) => b.request.name === request.name && (b.status === "working" || b.status === "needs_you"));
  if (active) throw new Error(`"${request.name}" is already being created.`);
  const at = now();
  const b = await deps.store.save({
    id: `create-${randomUUID().slice(0, 8)}`,
    accountId: deps.accountId,
    appId: generateAppId(),
    at,
    updatedAt: at,
    request,
    identifiers: identifiersFor(request, deps.ownerName),
    phase: "plan",
    status: "working",
    step: PHASE_LABEL.plan,
    planRevision: 0,
    planComments: [],
    mockups: [],
    mockupComments: [],
    checks: [],
    credits: 0,
    estimateCredits: est.credits,
    tickets: [],
    ownerSteps: [],
    log: [{ at, text: "Started." }],
  });
  kick(b.id, deps);
  return b;
}

export function getCreate(deps: Pick<CreateDeps, "store" | "accountId">, id: string) {
  return deps.store.get(id, deps.accountId);
}

async function mustGet(deps: CreateDeps, id: string): Promise<ExpoBuild> {
  const b = await deps.store.get(id, deps.accountId);
  if (!b) throw new NotFound("No such app being created.");
  return b;
}

export class NotFound extends Error {}

export type Review = { decision: "approve" } | { decision: "comment"; comment: string };

export function parseReview(raw: unknown): Review | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.decision === "approve") return { decision: "approve" };
  if (r.decision === "comment" && typeof r.comment === "string" && r.comment.trim().length >= 3) return { decision: "comment", comment: r.comment.trim().slice(0, 2000) };
  return null;
}

/** The owner's OK on the plan, or a comment (day2 writes a new version). */
export async function reviewPlan(id: string, review: Review, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await mustGet(deps, id);
  if (b.status !== "needs_you" || b.phase !== "plan_review") throw new Error("The plan isn't waiting for you.");
  const next =
    review.decision === "approve"
      ? { ...b, phase: "mockups" as Phase, status: "working" as const, step: PHASE_LABEL.mockups, log: addLog(b, "You approved the plan.") }
      : { ...b, phase: "plan" as Phase, status: "working" as const, step: "Changing the plan as you asked", planComments: [...b.planComments, review.comment], log: addLog(b, "You commented on the plan.") };
  const saved = await deps.store.save(next);
  kick(id, deps);
  return saved;
}

/** The owner's OK on the screens, or a comment (day2 draws them again). */
export async function reviewMockups(id: string, review: Review, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await mustGet(deps, id);
  if (b.status !== "needs_you" || b.phase !== "mockup_review") throw new Error("The screens aren't waiting for you.");
  const next =
    review.decision === "approve"
      ? { ...b, phase: "scaffold" as Phase, status: "working" as const, step: PHASE_LABEL.scaffold, log: addLog(b, "You approved the screens.") }
      : { ...b, phase: "mockups" as Phase, status: "working" as const, step: "Drawing the screens again as you asked", mockupComments: [...b.mockupComments, review.comment], log: addLog(b, "You commented on the screens.") };
  const saved = await deps.store.save(next);
  kick(id, deps);
  return saved;
}

/** A stuck step: try again (two more attempts) or go on without its checks passing. */
export async function unstick(id: string, choice: "retry" | "continue", deps: CreateDeps): Promise<ExpoBuild> {
  const b = await mustGet(deps, id);
  if (b.status !== "needs_you" || !b.stuck) throw new Error("Nothing is stuck.");
  const phase = choice === "retry" ? b.stuck.phase : nextPhase(b.stuck.phase);
  const saved = await deps.store.save({
    ...b,
    stuck: undefined,
    phase,
    attempt: 0,
    status: "working",
    step: PHASE_LABEL[phase],
    log: addLog(b, choice === "retry" ? "You asked day2 to try that step again." : "You chose to go on without that step's checks passing."),
  });
  kick(id, deps);
  return saved;
}

export async function cancelCreate(id: string, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await mustGet(deps, id);
  if (b.status === "done" || b.status === "canceled") throw new Error(b.status === "done" ? "This app is already created." : "Already canceled.");
  return deps.store.save({ ...b, status: "canceled", step: "Canceled", log: addLog(b, "You canceled. Nothing more is built or charged.") });
}

export async function setOwnerStep(id: string, stepId: string, done: boolean, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await mustGet(deps, id);
  if (!b.ownerSteps.some((s) => s.id === stepId)) throw new NotFound("No such step.");
  return deps.store.save({ ...b, ownerSteps: b.ownerSteps.map((s) => (s.id === stepId ? { ...s, done } : s)) });
}

/** After a restart: picks up every build that was working. */
export async function resumeAll(store: CreateStore, depsFor: (accountId: string) => Promise<CreateDeps | null>): Promise<string[]> {
  const resumed: string[] = [];
  for (const b of await store.list()) {
    if (b.status !== "working") continue;
    const deps = await depsFor(b.accountId);
    if (!deps) continue;
    kick(b.id, deps);
    resumed.push(b.id);
  }
  return resumed;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<void>>();

/** Starts the build's runner in the background (once per build at a time). */
export function kick(id: string, deps: CreateDeps): void {
  if (running.has(id)) return;
  const p = (deps.runAs ?? ((fn) => fn()))(() => advance(id, deps))
    .catch(async (err) => {
      const b = await deps.store.get(id);
      if (b && b.status === "working") await deps.store.save({ ...b, status: "failed", error: (err as Error).message, step: "Stopped", log: addLog(b, `Stopped: ${(err as Error).message}`) });
    })
    .finally(() => running.delete(id));
  running.set(id, p);
}

/** For tests: waits until the build's runner has stopped. */
export async function settled(id: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const p = running.get(id);
    if (!p) return;
    await p;
  }
}

function addLog(b: ExpoBuild, text: string): ExpoBuild["log"] {
  return [...b.log, { at: now(), text }].slice(-100);
}

export function nextPhase(p: Phase): Phase {
  return PHASES[Math.min(PHASES.indexOf(p) + 1, PHASES.length - 1)]!;
}

/** Saves unless the owner canceled meanwhile (a cancel always wins). */
async function save(deps: CreateDeps, b: ExpoBuild): Promise<ExpoBuild | null> {
  const cur = await deps.store.get(b.id);
  if (cur?.status === "canceled") return null;
  return deps.store.save(b);
}

async function moveOn(deps: CreateDeps, b: ExpoBuild, patch: Partial<ExpoBuild>, text: string): Promise<ExpoBuild | null> {
  const phase = patch.phase ?? nextPhase(b.phase);
  return save(deps, { ...b, ...patch, phase, attempt: 0, step: patch.step ?? PHASE_LABEL[phase], log: addLog(b, text) });
}

/** Runs an agent as app_build, adding what it cost to the build. */
async function charged<T>(deps: CreateDeps, b: ExpoBuild, description: string, fn: () => Promise<T>): Promise<{ result: T; credits: number }> {
  const ctx: CreditContext = { appId: null, appName: b.request.name, service: "app_build", description: `${b.request.name}: ${description}` };
  const result = await withCreditContext(ctx, fn);
  return { result, credits: ctx.charged ?? 0 };
}

async function advance(id: string, deps: CreateDeps): Promise<void> {
  for (;;) {
    const b = await deps.store.get(id);
    if (!b || b.status !== "working") return;
    const handler = HANDLERS[b.phase];
    if (!handler) return;
    const next = await handler(b, deps);
    if (!next) return; // canceled meanwhile
  }
}

type Handler = (b: ExpoBuild, deps: CreateDeps) => Promise<ExpoBuild | null>;

const git = (deps: CreateDeps, dir: string, ...args: string[]) => deps.run(["git", ...args], { cwd: dir, env: childEnv(null) });

async function commit(deps: CreateDeps, dir: string, message: string): Promise<void> {
  await git(deps, dir, "add", "-A");
  await git(deps, dir, "-c", "user.name=day2", "-c", "user.email=day2@localhost", "commit", "-q", "-m", message);
}

const readJson = (p: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const HANDLERS: Partial<Record<Phase, Handler>> = {
  async plan(b, deps) {
    let plan = null;
    let credits = 0;
    let lastError = "";
    for (let i = 0; i < 2 && !plan; i++) {
      const r = await charged(deps, b, "product plan", () => deps.agents.plan(buildPlanPrompt(b.request, b.plan, b.planComments)));
      credits += r.credits;
      plan = r.result.isError ? null : parsePlan(r.result.text);
      if (!plan) lastError = r.result.isError ? r.result.text.slice(0, 300) : "the plan came back incomplete";
    }
    if (!plan) throw new Error(`day2 couldn't write the product plan (${lastError}).`);
    return save(deps, { ...b, plan, planRevision: b.planRevision + 1, credits: b.credits + credits, phase: "plan_review", status: "needs_you", step: PHASE_LABEL.plan_review, log: addLog(b, `Plan ${b.planRevision + 1} is ready for you.`) });
  },

  async mockups(b, deps) {
    const plan = b.plan!;
    const screens = plan.screens.filter((s) => s.key).slice(0, MAX_MOCKUPS);
    const dir = deps.mockupDir(b.appId);
    mkdirSync(dir, { recursive: true });
    const round = b.mockupComments.length;
    const mockups: Mockup[] = [];
    let credits = 0;
    for (const s of screens) {
      const file = `${s.id}-r${round}.png`;
      const r = await charged(deps, b, `mockup of ${s.name}`, () => deps.agents.mockup(newScreenMockupPrompt(b.request, plan, s, b.mockupComments), join(dir, file))).catch(() => ({ result: null, credits: 0 }));
      credits += r.credits;
      if (r.result) mockups.push({ screenId: s.id, name: s.name, file, note: r.result.note });
    }
    const text = mockups.length ? `${mockups.length} screen${mockups.length === 1 ? " is" : "s are"} drawn for you.` : "day2 couldn't draw the screens — you can go on with the plan alone, or comment.";
    return save(deps, { ...b, mockups, credits: b.credits + credits, phase: "mockup_review", status: "needs_you", step: PHASE_LABEL.mockup_review, log: addLog(b, text) });
  },

  async scaffold(b, deps) {
    const dir = deps.repoDir(b.appId);
    // Again from the start after a restart: create-expo-app needs an empty folder.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    const r = await deps.run(createExpoAppCommand(dir), { cwd: dirname(dir), env: childEnv(null) });
    if (r.code !== 0 || !existsSync(join(dir, "package.json"))) throw new Error(`Expo's create-expo-app didn't finish: ${tail(r.stderr || r.stdout, 400)}`);
    if (!existsSync(join(dir, ".git"))) await git(deps, dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "PLAN.md"), `${renderPlan(b.plan!, b.request.displayName)}\n`);
    if (b.mockups.length) {
      mkdirSync(join(dir, "design", "mockups"), { recursive: true });
      for (const m of b.mockups) {
        const src = join(deps.mockupDir(b.appId), m.file);
        if (existsSync(src)) copyFileSync(src, join(dir, "design", "mockups", `${m.screenId}.png`));
      }
    }
    await commit(deps, dir, `New Expo app ${b.request.displayName} (create-expo-app), with its product plan`);
    return moveOn(deps, b, { repoDir: dir }, "The Expo app is set up.");
  },

  async prewire(b, deps) {
    const dir = b.repoDir!;
    const notes: string[] = [];
    // An EAS project for over-the-air updates, when the owner's Expo token is connected (not verified headless: see docs/expo-apps.md).
    const token = deps.expoToken ? await deps.expoToken().catch(() => null) : null;
    if (token) {
      const r = await deps.run(["npx", "--yes", `eas-cli@${EAS_CLI_VERSION}`, "init", "--non-interactive", "--force"], { cwd: dir, env: childEnv(token) });
      if (r.code !== 0) notes.push("Linking the app to Expo needs the first build (eas init).");
    }
    const appJsonPath = join(dir, "app.json");
    const appJson = readJson(appJsonPath) ?? { expo: {} };
    const projectId = ((((appJson.expo as Record<string, unknown>)?.extra as Record<string, unknown>)?.eas as { projectId?: string })?.projectId as string | undefined) ?? null;
    writeFileSync(appJsonPath, `${JSON.stringify(patchAppJson(appJson, b.identifiers, b.request, projectId), null, 2)}\n`);
    writeFileSync(join(dir, "eas.json"), `${JSON.stringify(easJson(readJson(join(dir, "eas.json"))), null, 2)}\n`);
    // The native packages day2's modules need (Live's native foundations) go in now, so the
    // first store build already has them and no extra "native foundations" release is needed.
    const native = await missingNative({ id: b.appId, name: b.request.name, repoPath: dir, connectionMethod: "local_path", addedAt: b.at }).catch(() => []);
    const packages = [...new Set([...RELEASE_PACKAGES, ...native.flatMap((n) => n.packages)])];
    const inst = await deps.run(["npx", "expo", "install", ...packages], { cwd: dir, env: childEnv(null) });
    if (inst.code !== 0) notes.push(`Installing ${packages.join(", ")} didn't finish — the release-setup and native foundations tickets cover it.`);
    const nativeInstructions = native.map((n) => `${n.module}: ${n.instructions}`);
    let fieldWired = false;
    if (deps.field.endpoint?.startsWith("https://")) {
      await deps.placeLibrary(dir);
      fieldWired = true;
    } else notes.push("day2 has no public address yet, so field checks come later through their own ticket.");
    writeFileSync(join(dir, "PRIVACY.md"), privacyNotice(b.request, b.plan!, fieldWired));
    await commit(deps, dir, "day2: app identifiers, releases (EAS Update, fingerprint runtime), field checks library, privacy notice draft");
    return moveOn(deps, b, { nativeInstructions }, ["Releases, identifiers and privacy are wired in.", ...notes].join(" "));
  },

  screens: (b, deps) => buildStep(b, deps, "screens"),
  data: (b, deps) => buildStep(b, deps, "data"),
  polish: (b, deps) => buildStep(b, deps, "polish"),

  async publish(b, deps) {
    const dir = b.repoDir!;
    const repo = b.githubRepo ?? (await deps.pushToGitHub(dir, b.request.name));
    return moveOn(deps, b, repo ? { githubRepo: repo } : {}, repo ? `The code is in your private GitHub repo ${repo}.` : "GitHub isn't connected on this machine: the code stays in a local repository for now.");
  },

  async onboard(b, deps) {
    const dir = b.repoDir!;
    if (!(await deps.apps.find(b.appId))) {
      const added = await deps.apps.add({ id: b.appId, name: b.request.name, repoPath: dir, connectionMethod: b.githubRepo ? "github" : "local_path", ...(b.githubRepo ? { githubRepo: b.githubRepo } : {}) });
      if (!added.ok) throw new Error(added.reason);
    }
    // Follow-up tickets in the new app's backlog (idempotent by source key).
    const file = join(dir, BACKLOG_FILENAME);
    let backlog = loadBacklog(file);
    const made: string[] = [];
    const add = (input: Parameters<typeof createTicket>[1]) => {
      if (backlog.tickets.some((t) => t.source.key === input.source.key)) return;
      const r = createTicket(backlog, input, new Date());
      backlog = r.backlog;
      made.push(r.ticket.id);
    };
    const ready = readiness(dir, null);
    if (ready.code.length) add(setupTicket(ready));
    const actions = actionsFromPlan(b.plan!);
    if (actions.length) add(assistantActionsTicket({ name: b.request.displayName, scheme: b.identifiers.scheme, bundleId: b.identifiers.bundleId, androidPackage: b.identifiers.androidPackage }, actions, "create"));
    saveBacklog(file, rankBacklog(backlog, new Date()).backlog);
    const steps = ownerSteps(b.request, b.identifiers, { appId: b.appId, githubRepo: b.githubRepo ?? null, repoDir: dir, local: deps.local });
    return save(deps, { ...b, tickets: [...b.tickets, ...made], ownerSteps: steps, phase: "done", status: "done", step: PHASE_LABEL.done, log: addLog(b, `Added to day2${made.length ? ` with ${made.length} follow-up ticket${made.length === 1 ? "" : "s"}` : ""}.`) });
  },
};

async function check(deps: CreateDeps, b: ExpoBuild, phase: BuildPhase, attempt: number): Promise<StepCheck> {
  const dir = b.repoDir!;
  const env = childEnv(null);
  const out: string[] = [];
  const tsc = await deps.run(["npx", "tsc", "--noEmit"], { cwd: dir, env });
  const typecheck: CheckResult = tsc.code === 0 ? "passed" : "failed";
  if (typecheck === "failed") out.push(`Type check failed:\n${tail(tsc.stdout + tsc.stderr)}`);
  const pkg = readJson(join(dir, "package.json")) as { scripts?: Record<string, string> } | null;
  let lint: CheckResult = "skipped";
  if (pkg?.scripts?.lint) {
    const l = await deps.run(["npm", "run", "lint", "--silent"], { cwd: dir, env });
    lint = l.code === 0 ? "passed" : "failed";
    if (lint === "failed") out.push(`Lint failed:\n${tail(l.stdout + l.stderr)}`);
  }
  let devices: CheckResult = "skipped";
  if (deps.deviceChecks) {
    const diff = await git(deps, dir, "diff", "--name-only", "HEAD~1", "HEAD");
    const v = await deps.deviceChecks({ appId: b.appId, cwd: dir, key: `create-${b.id}-${phase}-${attempt}`, changedFiles: diff.stdout.split("\n").filter(Boolean) });
    devices = v.status;
    if (v.status === "failed") out.push(`On virtual devices: ${v.summary}`);
  }
  const ok = typecheck === "passed" && lint !== "failed" && devices !== "failed";
  return { phase, attempt, typecheck, lint, devices, summary: ok ? "Checks passed." : out.join("\n\n"), at: now() };
}

async function buildStep(b: ExpoBuild, deps: CreateDeps, phase: BuildPhase): Promise<ExpoBuild | null> {
  const dir = b.repoDir!;
  const attempt = (b.attempt ?? 0) + 1;
  // Whatever an interrupted run left uncommitted goes; committed work stays.
  await git(deps, dir, "reset", "-q", "--hard");
  await git(deps, dir, "clean", "-qfd");
  // The field key needs the app registered in accounts mode — then the regular install ticket wires it in later.
  const key = deps.field.endpoint?.startsWith("https://") ? await deps.field.key(b.appId).catch(() => null) : null;
  const lib = key ? relative(dir, existsSync(join(dir, "src", "day2")) ? join(dir, "src", "day2") : join(dir, "day2")) : null;
  const ticket = stepTicket(b, b.plan!, phase, { fieldEndpoint: lib ? deps.field.endpoint : null, fieldKey: lib ? key : null, libraryDir: lib, nativeInstructions: b.nativeInstructions ?? [] });
  const lastFailed = attempt > 1 ? b.checks.filter((c) => c.phase === phase).at(-1)?.summary : undefined;
  const label = attempt > 1 ? `${PHASE_LABEL[phase]} — fixing what the checks found` : PHASE_LABEL[phase];
  const started = await save(deps, { ...b, attempt, step: label });
  if (!started) return null;
  const r = await charged(deps, b, ticket.title, () => deps.agents.build(dir, stepReport(b.id, phase, ticket, lastFailed)));
  await commit(deps, dir, `day2: ${ticket.title}${attempt > 1 ? " (fixes)" : ""}`);
  const result = await check(deps, b, phase, attempt);
  if (r.result.isError && result.summary === "Checks passed.") result.summary = `The build agent stopped early (${r.result.finalText.slice(0, 200)}), but the checks pass.`;
  const withCheck = { ...started, credits: started.credits + r.credits, checks: [...b.checks, result].slice(-30) };
  const ok = result.typecheck === "passed" && result.lint !== "failed" && result.devices !== "failed";
  if (ok) return moveOn(deps, withCheck, {}, `${ticket.title}: done, checks passed${result.devices === "passed" ? " (also on virtual devices)" : ""}.`);
  if (attempt < MAX_ATTEMPTS) return save(deps, { ...withCheck, log: addLog(b, `${ticket.title}: the checks found problems — fixing them.`) });
  return save(deps, {
    ...withCheck,
    status: "needs_you",
    stuck: { phase, reason: result.summary.slice(0, 2000) },
    step: `Stuck at “${PHASE_LABEL[phase].toLowerCase()}”`,
    log: addLog(b, `${ticket.title}: still failing its checks after ${attempt} tries — your call.`),
  });
}

export { BUILD_PHASES, BUDGET_USD };
