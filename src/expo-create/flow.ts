import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { COMMIT_EXCLUDES } from "../day2-state-files";
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
import { hostingNativePackages, type HostingDeps } from "../hosting";
import { backendAdapterFiles } from "./backend-adapter";
import { BUILD_PHASES, stepReport, stepTicket, visualFixReport, type BuildPhase } from "./build-steps";
import { appEntryFor, hostingAfterAgent, hostingPlanFor, hostingToProduction, hostWithDay2Ticket, prepareHosting, type HostingRun } from "./hosting";
import { ANDROID, buildDesignSystemPrompt, buildScreenPrompt, IPHONE, parseDesignSystem, parseScreenReply, styleCardHtml, themeTokensTs, withTokens } from "./design";
import { flowMapHtml } from "./flow-map";
import { ownerSteps } from "./first-build";
import { buildPlanPrompt, hostingReasons, parsePlan, renderPlan } from "./plan";
import { BUDGET_USD, estimateCreate, estimateRound, identifiersFor, MAX_ATTEMPTS } from "./request";
import { createExpoAppCommand, easJson, patchAppJson, privacyNotice, RELEASE_PACKAGES } from "./scaffold";
import { affectedScreens, describeChange, draftFrom, enforceLocks, ensureAdded, isEmptyChange, latest, openComments, screenFromShot, screensMaestroFlow, STYLE, WHOLE_FLOW } from "./screen-flow";
import type { CreateStore } from "./store";
import { RECORD_VERSION } from "./migrate";
import {
  PHASE_LABEL,
  PHASES,
  type ChangeRequest,
  type CheckResult,
  type CreateRequest,
  type DesignSystem,
  type ExpoBuild,
  type FlowComment,
  type FlowVersion,
  type Hotspot,
  type Phase,
  type Platform,
  type PlanScreen,
  type ScreenComparison,
  type ScreenDesign,
  type StepCheck,
} from "./types";

/**
 * Create — the flow, as a state machine kept in the CreateStore:
 *
 *   plan → style → design → flow_review (owner) ⇄ flow_revise → design → …
 *   → (approved) scaffold → prewire → theme → screens → backend → polish
 *   → publish → onboard → done
 *
 * The screen flow comes first: every screen (with its states and where
 * each button goes) is drawn in one design system and shown as a flow map
 * and a clickable prototype. The owner comments, asks for changes (only
 * the affected screens are redrawn: v1, v2…), approves single screens
 * early, and approves the whole flow. Only then is anything built.
 *
 * Each phase is safe to run again from its start, so a build that was
 * "working" when the server stopped picks up where it was (resumeAll);
 * drawing is resumable screen by screen. The owner is asked at the flow —
 * and when the build agent can't get a step past its checks twice (stuck:
 * try again or go on). Every agent run is charged to the account's
 * credits as app_build.
 */

export type CreateAgents = {
  /** The product plan (screen inventory) agent's reply. */
  plan(prompt: string): Promise<{ text: string; isError: boolean }>;
  /** The design system agent's reply. */
  style(prompt: string): Promise<{ text: string; isError: boolean }>;
  /** One screen's drawing (HTML in the reply). */
  screen(prompt: string): Promise<{ text: string; isError: boolean }>;
  /** The build agent (agent.ts runBuildAgent) in the new app's checkout. */
  build(cwd: string, report: BugReport): Promise<AgentRunResult>;
};

/** Rendering with Playwright (mockups.ts); tests inject fakes. */
export type CreateRender = {
  /** A screen to a PNG at the phone's size; the tappable areas it marked (data-goto). */
  screen(html: string, png: string, size: { width: number; height: number }): Promise<Hotspot[]>;
  /** A whole page (style card, flow map) to a PNG. */
  page(html: string, png: string, width: number): Promise<void>;
};

export type DeviceShot = { platform: Platform; name: string; rel: string; file: string };

export type CreateDeps = {
  /**
   * What day2 knows for this new app — the owner's memory once it exists,
   * and what worked for similar apps (memory/runtime.ts, learning/). A block
   * added to the planning and design prompts; absent or "" = nothing.
   */
  knowledge?: (b: ExpoBuild) => Promise<string>;
  store: CreateStore;
  accountId: string;
  credits: CreditStore;
  apps: AppsStore;
  /** Where the new app's checkout goes (managed-repos/<id>). */
  repoDir: (appId: string) => string;
  /** Where drawings go (mockups.ts mockupDir); the screen flow is in its flow/ folder. */
  mockupDir: (appId: string) => string;
  agents: CreateAgents;
  render: CreateRender;
  run: Runner;
  /** Runs the app on virtual devices (device-checks); absent = skipped. */
  deviceChecks?: (i: { appId: string; cwd: string; key: string; changedFiles: string[] }) => Promise<DeviceVerdict>;
  /** The screenshots a device check took (to put next to the drawings). */
  deviceShots?: (appId: string, key: string) => DeviceShot[];
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
  /** Hosting's dependencies for the new app (docs/hosting.md); absent or without an operator = Supabase isn't set up here. */
  hosting?: (app: AppEntry) => HostingDeps | null;
};

const now = () => new Date().toISOString();
const tail = (s: string, n = 1500) => stripAnsi(s).trim().slice(-n);
export const flowDir = (deps: Pick<CreateDeps, "mockupDir">, appId: string) => join(deps.mockupDir(appId), "flow");

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
    v: RECORD_VERSION,
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
    flow: { versions: [], comments: [], approved: [] },
    mockups: [],
    mockupComments: [],
    comparisons: [],
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

/** The screen flow is waiting on the owner (comments, approvals and changes are only taken then). */
async function inReview(deps: CreateDeps, id: string): Promise<ExpoBuild & { flow: { versions: [FlowVersion, ...FlowVersion[]] } }> {
  const b = await mustGet(deps, id);
  if (b.status !== "needs_you" || b.phase !== "flow_review" || !latest(b)) throw new Error("The screens aren't waiting for you.");
  return b as ExpoBuild & { flow: { versions: [FlowVersion, ...FlowVersion[]] } };
}

/** A comment on one screen (pinned or as text), on the style card ("style") or on everything ("flow"). */
export async function addComment(id: string, c: { screenId: string; text: string; pin?: { x: number; y: number } }, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await inReview(deps, id);
  if (b.flow.approved.includes(c.screenId)) throw new Error("You approved this screen, so it stays as it is. Take the approval back to change it.");
  const comment: FlowComment = { id: `c${randomUUID().slice(0, 8)}`, screenId: c.screenId, version: latest(b)!.n, text: c.text, ...(c.pin ? { pin: c.pin } : {}), at: now() };
  return deps.store.save({ ...b, flow: { ...b.flow, comments: [...b.flow.comments, comment].slice(-300) } });
}

export async function deleteComment(id: string, commentId: string, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await inReview(deps, id);
  const c = b.flow.comments.find((x) => x.id === commentId);
  if (!c) throw new NotFound("No such comment.");
  if (c.doneIn !== undefined) throw new Error("That comment is already part of a version.");
  return deps.store.save({ ...b, flow: { ...b.flow, comments: b.flow.comments.filter((x) => x.id !== commentId) } });
}

/** Marks one screen approved early (it won't change in later rounds), or takes that back. */
export async function setScreenApproved(id: string, screenId: string, approved: boolean, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await inReview(deps, id);
  const v = latest(b)!;
  if (!v.plan.screens.some((s) => s.id === screenId)) throw new NotFound("No such screen.");
  if (approved && !v.designs.some((d) => d.screenId === screenId)) throw new Error("This screen isn't drawn yet.");
  const set = new Set(b.flow.approved);
  if (approved) set.add(screenId);
  else set.delete(screenId);
  const name = v.plan.screens.find((s) => s.id === screenId)!.name;
  return deps.store.save({ ...b, flow: { ...b.flow, approved: [...set] }, log: addLog(b, approved ? `You approved “${name}”.` : `You took back your approval of “${name}”.`) });
}

/** The owner's round of changes: the open comments plus screens to add or remove. Only the affected screens are redrawn. */
export async function requestChanges(id: string, change: ChangeRequest, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await inReview(deps, id);
  const v = latest(b)!;
  const open = openComments(b);
  const undrawn = v.plan.screens.filter((s) => !v.designs.some((d) => d.screenId === s.id));
  if (isEmptyChange(change, open) && !undrawn.length) throw new Error("Add a comment, a screen to add or remove, or a note first.");
  const lockedRemove = change.remove.filter((s) => b.flow.approved.includes(s));
  if (lockedRemove.length) throw new Error("You approved a screen you want to remove. Take the approval back first.");
  if (change.remove.length >= v.plan.screens.length) throw new Error("The app needs at least one screen.");
  const est = estimateRound(open.filter((c) => c.screenId !== STYLE).length + change.add.length + undrawn.length, open.some((c) => c.screenId === STYLE));
  const check = await authorize(deps.credits, { appId: null, service: "app_build", maxCostUsd: est.usd });
  if (!check.ok) throw new CreditsError(check);
  const saved = await deps.store.save({
    ...b,
    phase: "flow_revise",
    status: "working",
    step: PHASE_LABEL.flow_revise,
    flow: { ...b.flow, pending: { ...change, commentIds: open.map((c) => c.id) } },
    log: addLog(b, `You asked for changes (${describeChange(change, open, new Map(v.plan.screens.map((s) => [s.id, s.name]))) || "draw the missing screens"}).`),
  });
  kick(id, deps);
  return saved;
}

/** The owner approves the whole flow: building starts. */
export async function approveFlow(id: string, deps: CreateDeps): Promise<ExpoBuild> {
  const b = await inReview(deps, id);
  const v = latest(b)!;
  const missing = v.plan.screens.filter((s) => !v.designs.some((d) => d.screenId === s.id));
  if (missing.length) throw new Error(`Some screens aren't drawn yet (${missing.map((s) => s.name).join(", ")}). Ask day2 to draw them first.`);
  const saved = await deps.store.save({
    ...b,
    plan: v.plan,
    designSystem: v.designSystem,
    flow: { ...b.flow, approved: v.plan.screens.map((s) => s.id) },
    phase: "scaffold",
    status: "working",
    step: PHASE_LABEL.scaffold,
    log: addLog(b, `You approved the screen flow (version ${v.n}, ${v.plan.screens.length} screens).`),
  });
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

/** The next phase on the way forward (the review loop's flow_revise is skipped). */
export function nextPhase(p: Phase): Phase {
  let i = PHASES.indexOf(p) + 1;
  if (PHASES[i] === "flow_revise") i++;
  return PHASES[Math.min(i, PHASES.length - 1)]!;
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
  await git(deps, dir, "add", "-A", "--", ".", ...COMMIT_EXCLUDES);
  await git(deps, dir, "-c", "user.name=day2", "-c", "user.email=day2@localhost", "commit", "-q", "-m", message);
}

const readJson = (p: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The screen flow: design system, every screen, the map
// ---------------------------------------------------------------------------

/** The knowledge block for a prompt (context only; the reply format asked above still applies). */
async function knowledgeFor(deps: CreateDeps, b: ExpoBuild): Promise<string> {
  const k = deps.knowledge ? await deps.knowledge(b).catch(() => "") : "";
  return k ? `\n\n(Context — the reply format asked above still applies.)\n${k}` : "";
}

/** Writes the design system (2 tries) and draws its style card. */
async function makeStyle(deps: CreateDeps, b: ExpoBuild, n: number, previous?: DesignSystem, comments: string[] = []): Promise<{ ds: DesignSystem; style: FlowVersion["style"]; credits: number }> {
  let ds: DesignSystem | null = null;
  let credits = 0;
  let lastError = "";
  for (let i = 0; i < 2 && !ds; i++) {
    const k = await knowledgeFor(deps, b);
    const r = await charged(deps, b, "design system", () => deps.agents.style(buildDesignSystemPrompt(b.request, b.plan!, previous, comments) + k));
    credits += r.credits;
    ds = r.result.isError ? null : parseDesignSystem(r.result.text);
    if (!ds) lastError = r.result.isError ? r.result.text.slice(0, 300) : "the design system came back incomplete";
  }
  if (!ds) throw new Error(`day2 couldn't choose the design system (${lastError}).`);
  const dir = flowDir(deps, b.appId);
  mkdirSync(dir, { recursive: true });
  const html = `style-v${n}.html`;
  const png = `style-v${n}.png`;
  writeFileSync(join(dir, html), styleCardHtml(ds, b.request.displayName));
  await deps.render.page(readFileSync(join(dir, html), "utf-8"), join(dir, png), 1200);
  return { ds, style: { png, html, drawnIn: n }, credits };
}

/** Draws one screen (2 tries) for one platform. Null when it couldn't. */
async function drawScreen(
  deps: CreateDeps,
  b: ExpoBuild,
  v: FlowVersion,
  s: PlanScreen,
  o: { android: boolean; comments: FlowComment[]; previousHtml: string | null },
): Promise<{ png: string; html: string; note: string; hotspots: Hotspot[]; credits: number } | null> {
  const dir = flowDir(deps, b.appId);
  const size = o.android ? ANDROID : IPHONE;
  const base = `v${v.n}-${s.id}${o.android ? ".android" : ""}`;
  let credits = 0;
  for (let i = 0; i < 2; i++) {
    const k = await knowledgeFor(deps, b);
    const r = await charged(deps, b, `drawing of ${s.name}${o.android ? " (Android)" : ""}`, () => deps.agents.screen(buildScreenPrompt(b.request, v.plan, v.designSystem, s, o) + k));
    credits += r.credits;
    const parsed = r.result.isError ? null : parseScreenReply(r.result.text);
    if (!parsed) continue;
    const html = withTokens(parsed.html, v.designSystem, size);
    writeFileSync(join(dir, `${base}.html`), html);
    const targets = new Set(s.links.map((l) => l.to));
    const hotspots = (await deps.render.screen(html, join(dir, `${base}.png`), size).catch(() => null))?.filter((h) => targets.has(h.to));
    if (!hotspots || !existsSync(join(dir, `${base}.png`))) continue;
    return { png: `${base}.png`, html: `${base}.html`, note: parsed.note, hotspots, credits };
  }
  return credits ? { png: "", html: "", note: "", hotspots: [], credits } : null;
}

const pngData = (file: string): string | null => (existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString("base64")}` : null);

const HANDLERS: Partial<Record<Phase, Handler>> = {
  async plan(b, deps) {
    let plan = null;
    let credits = 0;
    let lastError = "";
    for (let i = 0; i < 2 && !plan; i++) {
      const k = await knowledgeFor(deps, b);
      const r = await charged(deps, b, "screen list", () => deps.agents.plan(buildPlanPrompt(b.request, b.plan, b.planComments) + k));
      credits += r.credits;
      plan = r.result.isError ? null : parsePlan(r.result.text);
      if (!plan) lastError = r.result.isError ? r.result.text.slice(0, 300) : "the plan came back incomplete";
    }
    if (!plan) throw new Error(`day2 couldn't write the list of screens (${lastError}).`);
    return moveOn(deps, { ...b, credits: b.credits + credits }, { plan, planRevision: b.planRevision + 1 }, `The list of screens is written: ${plan.screens.length} screens.`);
  },

  async style(b, deps) {
    const n = (latest(b)?.n ?? 0) + 1;
    const { ds, style, credits } = await makeStyle(deps, b, n);
    const plan = b.plan!;
    const draft = { n, at: now(), plan, designSystem: ds, style, designs: [], changed: [], redraw: plan.screens.map((s) => s.id), styleChanged: true };
    return moveOn(deps, { ...b, credits: b.credits + credits }, { designSystem: ds, flow: { ...b.flow, draft } }, `The design system is chosen (${ds.name}).`);
  },

  async design(b, deps) {
    let cur = b;
    const draft = cur.flow.draft;
    if (!draft) return moveOn(deps, cur, { phase: "style" }, "Choosing the design system first.");
    const dir = flowDir(deps, cur.appId);
    mkdirSync(dir, { recursive: true });
    const last = latest(cur);
    const comments = cur.flow.pending ? cur.flow.comments.filter((c) => cur.flow.pending!.commentIds.includes(c.id)) : [];
    const todo = draft.plan.screens.filter((s) => draft.redraw.includes(s.id) && !draft.designs.some((d) => d.screenId === s.id && d.drawnIn === draft.n));
    let i = draft.redraw.length - todo.length;
    for (const s of todo) {
      i++;
      const started = await save(deps, { ...cur, step: `Drawing ${s.name} (${i} of ${draft.redraw.length})` });
      if (!started) return null;
      cur = started;
      const prev = last?.designs.find((d) => d.screenId === s.id);
      const mine = comments.filter((c) => c.screenId === s.id);
      const previousHtml = prev?.html && mine.length ? readText(join(dir, prev.html)) : null;
      const ios = await drawScreen(deps, cur, draft, s, { android: false, comments: mine, previousHtml });
      let credits = ios?.credits ?? 0;
      let design: ScreenDesign | null = ios && ios.png ? { screenId: s.id, drawnIn: draft.n, png: ios.png, html: ios.html, note: ios.note, hotspots: ios.hotspots } : null;
      if (design && s.androidDiffers && cur.request.platforms.includes("android")) {
        const prevAndroid = prev?.androidHtml && mine.length ? readText(join(dir, prev.androidHtml)) : null;
        const a = await drawScreen(deps, cur, draft, s, { android: true, comments: mine, previousHtml: prevAndroid });
        credits += a?.credits ?? 0;
        if (a?.png) design = { ...design, androidPng: a.png, androidHtml: a.html };
      }
      const designs = [...draft.designs.filter((d) => d.screenId !== s.id), ...(design ? [design] : [])];
      draft.designs = designs;
      const saved = await save(deps, { ...cur, credits: cur.credits + credits, flow: { ...cur.flow, draft: { ...draft, designs } }, log: design ? cur.log : addLog(cur, `day2 couldn't draw “${s.name}” this time — ask for changes to try again.`) });
      if (!saved) return null;
      cur = saved;
    }
    // The flow map, and the version is done.
    const ids = new Set(draft.plan.screens.map((s) => s.id));
    const designs = draft.plan.screens.flatMap((s) => draft.designs.filter((d) => d.screenId === s.id)).map((d) => ({ ...d, hotspots: d.hotspots.filter((h) => ids.has(h.to)) }));
    const byId = new Map(designs.map((d) => [d.screenId, d]));
    const mapHtml = flowMapHtml(cur.request.displayName, draft, (sid) => (byId.get(sid) ? pngData(join(dir, byId.get(sid)!.png)) : null));
    const map = { png: `map-v${draft.n}.png`, html: `map-v${draft.n}.html` };
    writeFileSync(join(dir, map.html), mapHtml);
    await deps.render.page(mapHtml, join(dir, map.png), 1400).catch(() => undefined);
    const { redraw, styleChanged: _s, ...rest } = draft;
    const version: FlowVersion = { ...rest, designs, map, changed: designs.filter((d) => d.drawnIn === draft.n).map((d) => d.screenId) };
    const doneIds = cur.flow.pending?.commentIds ?? [];
    const flow = {
      ...cur.flow,
      versions: [...cur.flow.versions, version],
      draft: undefined,
      pending: undefined,
      comments: cur.flow.comments.map((c) => (doneIds.includes(c.id) ? { ...c, doneIn: version.n } : c)),
      approved: cur.flow.approved.filter((id) => ids.has(id)),
    };
    const missing = draft.plan.screens.length - designs.length;
    const text = `Version ${version.n} is ready: ${version.changed.length} screen${version.changed.length === 1 ? "" : "s"} drawn${version.n > 1 ? `, ${designs.length - version.changed.length} unchanged` : ""}${missing ? `, ${missing} couldn't be drawn` : ""}.`;
    return save(deps, { ...cur, plan: draft.plan, designSystem: draft.designSystem, flow, phase: "flow_review", status: "needs_you", step: PHASE_LABEL.flow_review, log: addLog(cur, text) });
  },

  async flow_revise(b, deps) {
    const last = latest(b);
    const pending = b.flow.pending;
    if (!last || !pending) return moveOn(deps, b, { phase: "flow_review", status: "needs_you" }, "Nothing to change.");
    const comments = b.flow.comments.filter((c) => pending.commentIds.includes(c.id));
    const styleComments = comments.filter((c) => c.screenId === STYLE).map((c) => c.text);
    const flowComments = comments.filter((c) => c.screenId === WHOLE_FLOW).map((c) => c.text);
    const names = new Map(last.plan.screens.map((s) => [s.id, s.name]));
    const screenComments = comments.filter((c) => names.has(c.screenId));
    const n = last.n + 1;
    let credits = 0;
    let cur = { ...b, plan: last.plan };
    const k = await knowledgeFor(deps, b);
    // A new design system when the owner commented on the style card (or the version has none).
    const styleChanged = styleComments.length > 0 || !last.style.png;
    let ds = last.designSystem;
    let style = last.style;
    if (styleChanged) {
      const r = await makeStyle(deps, cur, n, last.style.png ? last.designSystem : undefined, styleComments);
      ds = r.ds;
      style = r.style;
      credits += r.credits;
    }
    // A revised list of screens when anything but the style was asked for.
    let next = last.plan;
    const asksPlan = pending.note || pending.add.length || pending.remove.length || flowComments.length || screenComments.length;
    if (asksPlan) {
      let parsed = null;
      for (let i = 0; i < 2 && !parsed; i++) {
        const r = await charged(deps, cur, "screen list changes", () =>
          deps.agents.plan(buildPlanPrompt(cur.request, last.plan, flowComments, { change: pending, locked: cur.flow.approved, screenComments: screenComments.map((c) => ({ screen: names.get(c.screenId)!, text: c.text })) }) + k),
        );
        credits += r.credits;
        parsed = r.result.isError ? null : parsePlan(r.result.text);
      }
      next = parsed ?? last.plan;
    }
    next = enforceLocks(last.plan, ensureAdded(next, pending.add), cur.flow.approved, pending.remove);
    const locked = cur.flow.approved.filter((id) => next.screens.some((s) => s.id === id));
    const redraw = affectedScreens({ prev: last.plan, next, designs: last.designs, commented: screenComments.map((c) => c.screenId), styleChanged, locked });
    const draft = { ...draftFrom(last, next, redraw, now(), describeChange(pending, comments, names) || "Draw the missing screens"), designSystem: ds, style, styleChanged };
    cur = { ...cur, credits: cur.credits + credits };
    return moveOn(deps, cur, { phase: "design", plan: next, planRevision: b.planRevision + 1, designSystem: ds, flow: { ...cur.flow, draft, approved: locked } }, `Version ${n}: ${redraw.length} screen${redraw.length === 1 ? "" : "s"} to draw, the rest stay as they are.`);
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
    const v = latest(b);
    if (v) copyFlowIntoRepo(deps, b, v, dir);
    else if (b.mockups.length) {
      mkdirSync(join(dir, "design", "mockups"), { recursive: true });
      for (const m of b.mockups) {
        const src = join(deps.mockupDir(b.appId), m.file);
        if (existsSync(src)) copyFileSync(src, join(dir, "design", "mockups", `${m.screenId}.png`));
      }
    }
    mkdirSync(join(dir, ".maestro", "day2"), { recursive: true });
    writeFileSync(join(dir, ".maestro", "day2", "screens.yaml"), screensMaestroFlow(b.plan!, b.identifiers));
    const ignore = readText(join(dir, ".gitignore")) ?? "";
    if (!ignore.includes("design/compare/")) writeFileSync(join(dir, ".gitignore"), `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}\n# day2: simulator screenshots next to the drawings\ndesign/compare/\n`);
    await commit(deps, dir, `New Expo app ${b.request.displayName} (create-expo-app), with its approved screen flow`);
    return moveOn(deps, b, { repoDir: dir }, "The Expo app is set up, with the approved screens in design/.");
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
    // A hosted backend's native packages (secure session storage, Apple/Google sign-in) go in now too.
    const hosted = b.plan && hostingReasons(b.plan).length > 0 && Boolean(deps.hosting?.(appEntryFor(b, dir))?.operator);
    const packages = [...new Set([...RELEASE_PACKAGES, ...native.flatMap((n) => n.packages), ...(hosted ? hostingNativePackages(hostingPlanFor(b, b.plan!)) : [])])];
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

  theme: (b, deps) => buildStep(b, deps, "theme"),
  screens: (b, deps) => buildStep(b, deps, "screens"),
  backend: (b, deps) => buildStep(b, deps, "backend"),
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
    // The backend: a "Host with day2" follow-up when Supabase isn't set up here.
    if (b.hosting?.state === "not_configured") add(hostWithDay2Ticket(b));
    saveBacklog(file, rankBacklog(backlog, new Date()).backlog);
    let hosting = b.hosting;
    // Went on past a stuck backend step: the backend exists, connecting the app is its ticket.
    if (hosting?.state === "setting_up") hosting = { ...hosting, state: "hosted", note: `The backend runs on day2's Supabase in ${hosting.place ?? hosting.region}. Connecting the app to it is a ticket in its backlog${hosting.ticketId ? ` (${hosting.ticketId})` : ""}.` };
    if (hosting?.state === "not_configured") hosting = { ...hosting, ticketId: backlog.tickets.find((t) => t.source.key === "create:host-with-day2")?.id };
    const steps = ownerSteps(b.request, b.identifiers, { appId: b.appId, githubRepo: b.githubRepo ?? null, repoDir: dir, local: deps.local });
    return save(deps, { ...b, ...(hosting ? { hosting } : {}), tickets: [...b.tickets, ...made], ownerSteps: steps, phase: "done", status: "done", step: PHASE_LABEL.done, log: addLog(b, `Added to day2${made.length ? ` with ${made.length} follow-up ticket${made.length === 1 ? "" : "s"}` : ""}.`) });
  },
};

/** The approved screen flow in the new repo's design/ folder: what the build agent builds from. */
function copyFlowIntoRepo(deps: CreateDeps, b: ExpoBuild, v: FlowVersion, dir: string): void {
  const src = flowDir(deps, b.appId);
  const out = join(dir, "design");
  mkdirSync(join(out, "screens"), { recursive: true });
  const cp = (from: string, to: string) => existsSync(join(src, from)) && copyFileSync(join(src, from), to);
  for (const d of v.designs) {
    if (d.png) cp(d.png, join(out, "screens", `${d.screenId}.png`));
    if (d.html) cp(d.html, join(out, "screens", `${d.screenId}.html`));
    if (d.androidPng) cp(d.androidPng, join(out, "screens", `${d.screenId}.android.png`));
    if (d.androidHtml) cp(d.androidHtml, join(out, "screens", `${d.screenId}.android.html`));
  }
  if (v.style.png) cp(v.style.png, join(out, "style.png"));
  if (v.style.html) cp(v.style.html, join(out, "style.html"));
  if (v.map?.png) cp(v.map.png, join(out, "flow-map.png"));
  writeFileSync(join(out, "design-system.json"), `${JSON.stringify(v.designSystem, null, 2)}\n`);
  const designs = new Map(v.designs.map((d) => [d.screenId, d]));
  const flow = { version: v.n, screens: v.plan.screens.map((s) => ({ ...s, hotspots: designs.get(s.id)?.hotspots ?? [] })) };
  writeFileSync(join(out, "flow.json"), `${JSON.stringify(flow, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

async function check(deps: CreateDeps, b: ExpoBuild, phase: BuildPhase, attempt: number, keySuffix = ""): Promise<StepCheck> {
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
  let deviceKey: string | null = null;
  if (deps.deviceChecks) {
    const diff = await git(deps, dir, "diff", "--name-only", "HEAD~1", "HEAD");
    const v = await deps.deviceChecks({ appId: b.appId, cwd: dir, key: `create-${b.id}-${phase}-${attempt}${keySuffix}`, changedFiles: diff.stdout.split("\n").filter(Boolean) });
    devices = v.status;
    deviceKey = v.key;
    if (v.status === "failed") out.push(`On virtual devices: ${v.summary}`);
  }
  const ok = typecheck === "passed" && lint !== "failed" && devices !== "failed";
  return { phase, attempt, typecheck, lint, devices, summary: ok ? "Checks passed." : out.join("\n\n"), at: now(), deviceKey };
}

const passed = (c: StepCheck) => c.typecheck === "passed" && c.lint !== "failed" && c.devices !== "failed" && c.backend !== "failed";

/** Simulator screenshots of the approved screens next to their drawings (when the device check took any). */
function compare(deps: CreateDeps, b: ExpoBuild, phase: BuildPhase, attempt: number, key: string | null | undefined): ScreenComparison | null {
  const v = latest(b);
  // The theme step has no screens yet.
  if (phase === "theme" || !key || !v || !deps.deviceShots) return null;
  const designs = new Map(v.designs.map((d) => [d.screenId, d]));
  const names = new Map(v.plan.screens.map((s) => [s.id, s.name]));
  const pairs: ScreenComparison["pairs"] = [];
  for (const shot of deps.deviceShots(b.appId, key)) {
    const id = screenFromShot(shot.name);
    const d = id ? designs.get(id) : undefined;
    if (!id || !d) continue;
    const design = shot.platform === "android" && d.androidPng ? d.androidPng : d.png;
    pairs.push({ screenId: id, name: names.get(id) ?? id, design, shot: shot.rel, platform: shot.platform });
    // For the agent's one round of fixes: the screenshot inside the checkout (git-ignored).
    if (b.repoDir && existsSync(shot.file)) {
      mkdirSync(join(b.repoDir, "design", "compare"), { recursive: true });
      copyFileSync(shot.file, join(b.repoDir, "design", "compare", `${id}.${shot.platform}.png`));
    }
  }
  return pairs.length ? { phase, attempt, key, pairs } : null;
}

async function buildStep(b: ExpoBuild, deps: CreateDeps, phase: BuildPhase): Promise<ExpoBuild | null> {
  const dir = b.repoDir!;
  const attempt = (b.attempt ?? 0) + 1;
  // Whatever an interrupted run left uncommitted goes; committed work stays.
  await git(deps, dir, "reset", "-q", "--hard");
  await git(deps, dir, "clean", "-qfd");
  const v = latest(b);
  // day2's own files for the step: the design tokens and the backend adapter's skeleton (kept once the agent changed them).
  if (phase === "theme" && v?.style.png) {
    mkdirSync(join(dir, "src", "theme"), { recursive: true });
    writeFileSync(join(dir, "src", "theme", "tokens.ts"), themeTokensTs(v.designSystem));
  }
  // The backend: hosted on day2's Supabase when the plan needs it and Supabase is set up (resumes a half-done setup).
  let host: HostingRun | null = null;
  if (phase === "backend") {
    let cur = b;
    host = await prepareHosting(b, dir, deps.hosting, async (text) => {
      const s = await save(deps, { ...cur, step: text });
      if (s) cur = s;
    });
    const was = b.hosting?.state;
    const said = host.mode === "local" && host.why !== "not_needed" && was !== host.hosting.state ? [host.hosting.note ?? ""] : host.mode === "hosted" && was !== "setting_up" ? [`The backend is up in ${host.hosting.place ?? host.hosting.region} (production and a staging copy).`] : [];
    const saved = await save(deps, { ...cur, hosting: host.hosting, log: said.length ? addLog(cur, said.join(" ")) : cur.log });
    if (!saved) return null;
    b = saved;
  }
  if (phase === "backend") {
    for (const [path, content] of Object.entries(backendAdapterFiles(b.plan!, { hosted: host?.mode === "hosted" }))) {
      if (existsSync(join(dir, path))) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  // The field key needs the app registered in accounts mode — then the regular install ticket wires it in later.
  const key = deps.field.endpoint?.startsWith("https://") ? await deps.field.key(b.appId).catch(() => null) : null;
  const lib = key ? relative(dir, existsSync(join(dir, "src", "day2")) ? join(dir, "src", "day2") : join(dir, "day2")) : null;
  const hostingCtx = host ? (host.mode === "hosted" ? { mode: "hosted" as const, brief: host.brief, place: host.hosting.place ?? host.hosting.region ?? "its region" } : { mode: "local" as const, why: host.why }) : undefined;
  const ticket = stepTicket(b, b.plan!, phase, { fieldEndpoint: lib ? deps.field.endpoint : null, fieldKey: lib ? key : null, libraryDir: lib, nativeInstructions: b.nativeInstructions ?? [], legacyMockups: !v, ...(hostingCtx ? { hosting: hostingCtx } : {}) });
  const lastFailed = attempt > 1 ? b.checks.filter((c) => c.phase === phase).at(-1)?.summary : undefined;
  const label = attempt > 1 ? `${PHASE_LABEL[phase]} — fixing what the checks found` : PHASE_LABEL[phase];
  const started = await save(deps, { ...b, attempt, step: label });
  if (!started) return null;
  const r = await charged(deps, b, ticket.title, () => deps.agents.build(dir, stepReport(b.id, phase, ticket, lastFailed)));
  // Hosted: migrations and functions to staging, and the env values — before the checks, so the device checks run against staging.
  if (host?.mode === "hosted") await save(deps, { ...started, step: "Applying the database changes to staging" });
  const hostingFailure = host?.mode === "hosted" ? await hostingAfterAgent(host, dir) : null;
  await commit(deps, dir, `day2: ${ticket.title}${attempt > 1 ? " (fixes)" : ""}`);
  let result = await check(deps, b, phase, attempt);
  if (host?.mode === "hosted") {
    result.backend = hostingFailure ? "failed" : "passed";
    if (hostingFailure) result.summary = result.summary === "Checks passed." ? hostingFailure : `${result.summary}\n\n${hostingFailure}`;
  }
  if (r.result.isError && result.summary === "Checks passed.") result.summary = `The build agent stopped early (${r.result.finalText.slice(0, 200)}), but the checks pass.`;
  let credits = r.credits;
  let checks = [...b.checks, result].slice(-30);
  let comparisons = b.comparisons;
  const shots = compare(deps, b, phase, attempt, result.deviceKey);
  if (shots) comparisons = [...comparisons, shots].slice(-20);
  // Once per step: the agent fixes clear mismatches between the screenshots and the drawings.
  if (passed(result) && shots && !b.comparisons.some((c) => c.phase === phase && c.fixed)) {
    const again = await save(deps, { ...started, credits: started.credits + credits, checks, comparisons, step: `${PHASE_LABEL[phase]} — matching the drawings` });
    if (!again) return null;
    const fix = await charged(deps, b, `${ticket.title}: match the drawings`, () => deps.agents.build(dir, visualFixReport(b.id, phase, b.request.displayName, shots)));
    credits += fix.credits;
    await commit(deps, dir, `day2: ${ticket.title} (matched to the drawings)`);
    result = await check(deps, b, phase, attempt, "-matched");
    result.summary = passed(result) ? "Checks passed after matching the drawings." : result.summary;
    checks = [...checks, result].slice(-30);
    const after = compare(deps, b, phase, attempt, result.deviceKey);
    comparisons = [...comparisons.filter((c) => c !== shots), { ...shots, fixed: true }, ...(after ? [{ ...after, fixed: true }] : [])].slice(-20);
  }
  const withCheck = { ...started, credits: started.credits + credits, checks, comparisons };
  if (passed(result)) {
    let hosting = withCheck.hosting;
    if (host?.mode === "hosted") {
      const live = await save(deps, { ...withCheck, step: "Applying the database changes to production" });
      if (!live) return null;
      hosting = await hostingToProduction(host, dir);
      await commit(deps, dir, "day2: the hosted backend is live");
    }
    return moveOn(deps, { ...withCheck, ...(hosting ? { hosting } : {}) }, {}, `${ticket.title}: done, checks passed${result.devices === "passed" ? ` (also on virtual devices${host?.mode === "hosted" ? ", against staging" : ""})` : ""}.${host?.mode === "hosted" ? " The backend is live." : ""}`);
  }
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
