import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { authorize, CreditsError, type CreditService } from "../credits";
import { dataDir } from "../day2-paths";
import { has } from "../device-checks/run-cmd";
import { AUTOPILOT_FILENAME, loadAutopilot } from "../growth-autopilot";
import { DemoError, demoSupport, retireLegacyDemo } from "../hosting/demo";
import { janitor } from "../hosting/ephemeral";
import { readMigrations } from "../hosting/migrations";
import { ensureSeedPlan, migrationsHash, SeedPlanError, seedPlanState } from "../hosting/seed-plan-cache";
import { SupabaseError, type SupabaseApi } from "../hosting/supabase";
import { profileOf, languageOf, socialAccounts } from "../social/runtime";
import { paidFor } from "../store-listing/deps";
import { storeIdsFromRepo } from "../ads/app-links";
import { assetStore, type Tenant } from "../tenant";
import { appVersion, capturesDir, loadCaptureSet, localeFor } from "./capture";
import { androidEmulatorAvailable, captureRunning, runCapture, type CaptureStatus } from "./capture-run";
import { CAST_PURPOSE } from "./demo-cast/images";
import { validateCast, type DemoCast } from "./demo-cast/schema";
import { castDir, loadCast, saveCast } from "./demo-cast/store";
import { DEMO_FLOW_KEY } from "./demo-flow";
import { approveCast, captureDeps, demoDeps, demoFlowInRepo, ephemeralDeps, ensureFlowTicket, realScreensHooks, runJob, seedPlanner, ticketsOf, trackJob, writeCast } from "./real-screens";
import { jsonAfter, runVision, type VisionImage, type VisionRun } from "./vision";

/**
 * Real screens without manual steps (docs/creative-quality.md §2b): one
 * resumable state machine per app —
 *
 *   cast → approve → seed_plan → flow → flow_merged → capture → done
 *
 * persisted in `<data>/real-screens/<app>/pipeline.json`. Every step is
 * idempotent: before running, each step checks the world (is there a cast,
 * is it approved, is there a seed plan validated against the current
 * migrations, is the flow ticket there, is the flow merged, is there a
 * fresh capture) and only does what's missing. There is no demo database
 * between captures: the capture step starts a temporary one (Docker, the
 * app's migrations, the cast seeded through the plan), builds and runs the
 * flow against it, and removes it (creative/demo-session.ts,
 * hosting/ephemeral.ts). A failed step records its attempts, the last error
 * and when to try again (exponential backoff); after RETRY.max attempts — or
 * at once for problems day2 can't fix by itself (no Docker, a migration
 * that doesn't apply, a seed plan that doesn't fit, no Expo account, no
 * cloudflared for EAS) — it "needs attention" with a reason the owner can
 * act on, and a Retry button. One run per app at a time.
 *
 * Triggers: the backlog timer (growth/social on, daily maintenance, a new
 * app version, changed migrations), a post being made (maybeAutoCapture),
 * and the owner's buttons. Approval: `demoCast: "auto"` (default) approves
 * a cast that passes the schema check and a vision check of its pictures;
 * otherwise (or with "owner") the owner approves. The flow's pull request
 * is merged the way every day2 PR is (the owner, in Approvals) — the
 * pipeline only waits for it. Cleanup: the cast's pictures (and, on removal,
 * captures and state) are deleted when the app is removed, or after growth
 * has been off for 30 days. An old standing demo project (the previous
 * design) is deleted once through the guard.
 */

export const PIPELINE_STEPS = ["cast", "approve", "seed_plan", "flow", "flow_merged", "capture"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type StepStatus = "pending" | "running" | "done" | "waiting" | "needs_attention" | "skipped";
export type StepRecord = { status: StepStatus; attempts: number; lastError: string | null; nextRetryAt: string | null; note: string | null; updatedAt: string | null };
export type DemoCastPolicy = "auto" | "owner";
export type PipelineTrigger = "growth_on" | "tick" | "daily" | "post" | "first_post" | "new_version" | "migrations_changed" | "retry" | "regenerate" | "decline" | "approved" | "policy";
export type AutoApproval = { key: string; at: string; ok: boolean; problems: string[]; vision: boolean };

export type PipelineState = {
  version: 1;
  appId: string;
  settings: { demoCast: DemoCastPolicy };
  steps: Record<PipelineStep, StepRecord>;
  /** Why nothing runs at all (unsupported backend, …). */
  blocked: string | null;
  lastRunAt: string | null;
  lastTrigger: PipelineTrigger | null;
  /** The owner pressed Regenerate (or declined once): the next run writes a new cast. */
  regenerate: boolean;
  declines: number;
  /** The cast the owner declined (never auto-approved). */
  declined: string | null;
  autoApproval: AutoApproval | null;
  /** legacy: what happened to an old standing demo project (the previous design), once. */
  maintenance: { checkedAt: string | null; migrations: string | null; appVersion: string | null; legacy?: string | null };
  growthOffSince: string | null;
  cleanup: { at: string | null; reason: "removed" | "growth_off" | null; note: string | null };
  /** The last post that went ahead without fresh real screens, and why. */
  posts: { at: string; why: string } | null;
  log: Array<{ at: string; text: string }>;
};

const MIN = 60_000;
export const RETRY = { max: 5, capMs: 24 * 60 * MIN, base: { cast: 10 * MIN, approve: 30 * MIN, seed_plan: 15 * MIN, flow: 30 * MIN, flow_merged: 60 * MIN, capture: 60 * MIN } as Record<PipelineStep, number> };
export const GROWTH_OFF_CLEANUP_DAYS = 30;
const DAY = 24 * 60 * MIN;
/** Worst cases checked against the account's credits before a step spends. */
export const STEP_COST_USD = { cast: 1.2, check: 0.3, seedPlan: 0.5 };
export const AUTO_APPROVER = "day2 (automatic check)";

export const STEP_LABEL: Record<PipelineStep, string> = {
  cast: "Write the demo cast",
  approve: "Approve the cast",
  seed_plan: "Seed plan",
  flow: "Ask for the Maestro flow",
  flow_merged: "Flow pull request merged",
  capture: "Capture (temporary database)",
};

// ---------------------------------------------------------------- pure state helpers

const emptyStep = (): StepRecord => ({ status: "pending", attempts: 0, lastError: null, nextRetryAt: null, note: null, updatedAt: null });

export function emptyPipeline(appId: string): PipelineState {
  return {
    version: 1,
    appId,
    settings: { demoCast: "auto" },
    steps: Object.fromEntries(PIPELINE_STEPS.map((s) => [s, emptyStep()])) as Record<PipelineStep, StepRecord>,
    blocked: null,
    lastRunAt: null,
    lastTrigger: null,
    regenerate: false,
    declines: 0,
    declined: null,
    autoApproval: null,
    maintenance: { checkedAt: null, migrations: null, appVersion: null },
    growthOffSince: null,
    cleanup: { at: null, reason: null, note: null },
    posts: null,
    log: [],
  };
}

/** Pure. How long to wait after the n-th failed attempt of a step. */
export const backoffMs = (step: PipelineStep, attempts: number) => Math.min(RETRY.capMs, RETRY.base[step] * 2 ** Math.max(0, attempts - 1));

/** Pure. A failed attempt: try again later (backoff), or "needs attention" (a fatal problem, or out of attempts). */
export function failStep(rec: StepRecord, step: PipelineStep, error: string, now: Date, o: { fatal?: boolean } = {}): StepRecord {
  const attempts = rec.attempts + 1;
  const at = now.toISOString();
  if (o.fatal) return { ...rec, status: "needs_attention", attempts, lastError: error, nextRetryAt: null, note: error, updatedAt: at };
  if (attempts >= RETRY.max) return { ...rec, status: "needs_attention", attempts, lastError: error, nextRetryAt: null, note: `day2 tried ${attempts} times and stopped: ${error} Press Retry when it's fixed — day2 also tries once more each day.`, updatedAt: at };
  return { ...rec, status: "pending", attempts, lastError: error, nextRetryAt: new Date(now.getTime() + backoffMs(step, attempts)).toISOString(), note: `Trying again ${new Date(now.getTime() + backoffMs(step, attempts)).toISOString()} (attempt ${attempts + 1} of ${RETRY.max}).`, updatedAt: at };
}

/** Pure. May a pending step run now. */
export const isDue = (rec: StepRecord, now: Date) => rec.status !== "needs_attention" && (!rec.nextRetryAt || Date.parse(rec.nextRetryAt) <= now.getTime());

/** Pure. Re-arms steps for another try: all needs-attention/backed-off ones, or from `from` on. */
export function rearm(s: PipelineState, o: { from?: PipelineStep; attempts?: number; except?: PipelineStep[]; onlyAttention?: boolean } = {}): PipelineState {
  const start = o.from ? PIPELINE_STEPS.indexOf(o.from) : 0;
  const steps = { ...s.steps };
  for (const [i, k] of PIPELINE_STEPS.entries()) {
    if (i < start || o.except?.includes(k)) continue;
    const r = steps[k];
    if (r.status === "needs_attention" || (!o.onlyAttention && r.status === "pending" && r.nextRetryAt) || (o.from && i === start && r.status !== "done"))
      steps[k] = { ...r, status: "pending", attempts: o.attempts ?? 0, nextRetryAt: null, note: null };
  }
  return { ...s, steps };
}

/** Pure. The first step that isn't done (null: everything's done). */
export const currentStep = (s: PipelineState): PipelineStep | null => PIPELINE_STEPS.find((k) => s.steps[k].status !== "done" && s.steps[k].status !== "skipped") ?? null;

// ---------------------------------------------------------------- the store

const safe = (appId: string) => appId.replace(/[^\w-]/g, "_");
const pipelineFile = (appId: string) => join(dataDir(), "real-screens", safe(appId), "pipeline.json");
const clock = () => new Date();

export function loadPipeline(appId: string): PipelineState {
  try {
    const raw = JSON.parse(readFileSync(pipelineFile(appId), "utf-8")) as Partial<PipelineState>;
    const e = emptyPipeline(appId);
    // Only today's steps (an old "backend" step is dropped).
    const steps = Object.fromEntries(PIPELINE_STEPS.map((k) => [k, raw.steps?.[k] ?? e.steps[k]])) as PipelineState["steps"];
    return { ...e, ...raw, settings: { ...e.settings, ...(raw.settings ?? {}) }, steps, maintenance: { ...e.maintenance, ...(raw.maintenance ?? {}) }, cleanup: { ...e.cleanup, ...(raw.cleanup ?? {}) } };
  } catch {
    return emptyPipeline(appId);
  }
}

function savePipeline(s: PipelineState): void {
  const f = pipelineFile(s.appId);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify({ ...s, log: s.log.slice(0, 40) }, null, 2));
  renameSync(`${f}.tmp`, f);
}

/** Read-modify-write of an app's pipeline state (synchronous, so never interleaved within this process). */
export function updatePipeline(appId: string, fn: (s: PipelineState) => PipelineState | void): PipelineState {
  const cur = loadPipeline(appId);
  const next = fn(cur) ?? cur;
  savePipeline(next);
  return next;
}

const logLine = (s: PipelineState, text: string, now = clock()) => {
  s.log = [{ at: now.toISOString(), text }, ...s.log].slice(0, 40);
};
const setStep = (appId: string, step: PipelineStep, rec: Partial<StepRecord>, text?: string) =>
  updatePipeline(appId, (s) => {
    s.steps[step] = { ...s.steps[step], ...rec, updatedAt: clock().toISOString() };
    if (text) logLine(s, text);
  });

// ---------------------------------------------------------------- settings and owner actions

export function setDemoCastPolicy(appId: string, policy: DemoCastPolicy): PipelineState {
  return updatePipeline(appId, (s) => {
    s.settings.demoCast = policy;
    logLine(s, policy === "auto" ? "Demo casts are approved automatically when they pass day2's checks." : "Demo casts wait for your OK.");
  });
}

/** The owner wants a new cast: the next run writes one (the next capture seeds it once approved). */
export function regenerateCast(t: Tenant, app: AppEntry): Promise<PipelineState> {
  updatePipeline(app.id, (s) => {
    s.regenerate = true;
    s.autoApproval = null;
    s.steps.cast = emptyStep();
    s.steps.approve = emptyStep();
    logLine(s, "A new demo cast was asked for.");
  });
  return ensureRealScreens(t, app, { trigger: "regenerate" });
}

/** The owner declines the cast: the first time day2 writes a new one by itself; after that it waits for the owner. */
export async function declineCast(t: Tenant, app: AppEntry): Promise<{ state: PipelineState; run: Promise<PipelineState> | null }> {
  const cast = await loadCast(app.id, assetStore());
  if (!cast) throw new DemoError("There's no demo cast to decline.", "not_approved");
  if (cast.status === "approved") saveCast({ ...cast, status: "draft", approvedAt: null, approvedBy: null });
  const s = updatePipeline(app.id, (p) => {
    p.declines += 1;
    p.declined = castKey(cast);
    p.autoApproval = null;
    if (p.declines <= 1) {
      p.regenerate = true;
      p.steps.cast = emptyStep();
      p.steps.approve = emptyStep();
      logLine(p, "You declined the demo cast — day2 writes a new one.");
    } else {
      p.steps.approve = { ...p.steps.approve, status: "waiting", note: "You declined the demo cast again — press Regenerate for another one, or upload screenshots instead.", updatedAt: clock().toISOString() };
      logLine(p, "You declined the demo cast again.");
    }
  });
  return { state: s, run: s.declines <= 1 ? ensureRealScreens(t, app, { trigger: "decline" }) : null };
}

/** The owner approved the cast (Approve): carry on. */
export async function ownerApproved(t: Tenant, app: AppEntry, by: string | null): Promise<void> {
  await approveCast(app, by);
  updatePipeline(app.id, (s) => {
    s.declined = null;
    s.steps.approve = { ...s.steps.approve, status: "done", note: `Approved by ${by ?? "you"}.`, updatedAt: clock().toISOString() };
  });
  void ensureRealScreens(t, app, { trigger: "approved" });
}

/** Retry: re-arm a step (or every step that needs attention) and run now. */
export function retryRealScreens(t: Tenant, app: AppEntry, from?: PipelineStep): Promise<PipelineState> {
  updatePipeline(app.id, (s) => {
    const next = rearm(s, from ? { from } : {});
    logLine(next, from ? `Retry from "${STEP_LABEL[from]}".` : "Retry.");
    return next;
  });
  return ensureRealScreens(t, app, { trigger: "retry" });
}

export function recordPostScreens(appId: string, why: string): void {
  updatePipeline(appId, (s) => {
    s.posts = { at: clock().toISOString(), why };
  });
}

/** Why the pipeline isn't done, in a line (null: done or never ran). */
export function pipelineWhy(appId: string): string | null {
  const s = loadPipeline(appId);
  if (s.blocked) return s.blocked;
  const k = currentStep(s);
  if (!k) return null;
  const r = s.steps[k];
  return `${STEP_LABEL[k]}: ${r.note ?? r.lastError ?? (r.status === "running" ? "running" : "not done yet")}`;
}

// ---------------------------------------------------------------- the automatic cast check

const CHECK_MARKER = "CAST_CHECK_JSON:";

export function castKey(c: Pick<DemoCast, "seed" | "createdAt">): string {
  return `${c.seed}:${c.createdAt}`;
}

/** The images of a cast as the vision run sees them (labels say what each should show). */
function castImages(cast: DemoCast): VisionImage[] {
  const out: VisionImage[] = [];
  for (const p of cast.people) if (p.avatar?.file && p.avatar.aiGenerated) out.push({ label: `avatar:${p.key} (should show an invented ADULT, about ${p.age})`, file: p.avatar.file });
  for (const m of cast.moments) if (m.photo?.file && m.photo.aiGenerated) out.push({ label: `photo:${m.key} (a scene: ${m.scene.slice(0, 80)} — no people)`, file: m.photo.file });
  return out;
}

export function castCheckPrompt(n: number): string {
  return [
    `You check ${n} AI-made pictures for an app's demo account before they are shown publicly in marketing screenshots.`,
    "For each picture (by its label) decide: does it contain any readable text, letters, numbers, watermarks, logos or brand marks? For avatars: does the person clearly look like an adult (18+)? Is it a single plausible photo (no collage, no distorted face, nothing explicit or violent)?",
    `Answer with one line ${CHECK_MARKER} followed by JSON: {"text":[labels with text or logos],"notAdult":[labels whose person may be under 18 or whose age is unclear],"other":[labels with any other problem],"ok":true|false}`,
  ].join("\n");
}

/**
 * Should day2 approve this cast by itself? The schema check (validateCast),
 * every picture there (no placeholders, none missing), and — for AI-made
 * pictures — a vision check: no text or logos, faces look adult. Without a
 * vision run it can't check, so it doesn't approve.
 */
export async function autoApprovalCheck(cast: DemoCast, o: { vision: VisionRun | null; paid?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<{ ok: boolean; problems: string[]; vision: boolean }> {
  const problems: string[] = [];
  const v = validateCast(cast);
  if (!v.ok) problems.push(...v.problems.slice(0, 3).map((p) => `cast check: ${p}`));
  const imgs = [...cast.people.map((p) => ({ k: `avatar of ${p.displayName}`, i: p.avatar })), ...cast.moments.map((m) => ({ k: `photo of moment ${m.key}`, i: m.photo }))];
  const missing = imgs.filter((x) => !x.i?.file);
  if (missing.length) problems.push(`${missing.length} of ${imgs.length} pictures are missing`);
  const placeholders = imgs.filter((x) => x.i?.source === "placeholder");
  if (placeholders.length) problems.push(`${placeholders.length} pictures are coloured placeholders (no image tool is connected)`);
  const ai = castImages(cast);
  let usedVision = false;
  if (ai.length && !missing.length) {
    if (!o.vision) problems.push("day2 can't look at the AI-made pictures here (no vision run), so it doesn't approve them by itself");
    else {
      usedVision = true;
      const run = () => o.vision!({ prompt: castCheckPrompt(ai.length), images: ai, maxUsd: STEP_COST_USD.check, label: "Demo cast check" });
      const text = await (o.paid ? o.paid(run) : run()).catch((err: Error) => {
        problems.push(`the picture check didn't run (${err.message.slice(0, 80)})`);
        return null;
      });
      if (text !== null) {
        const j = jsonAfter(text, CHECK_MARKER) as { text?: unknown; notAdult?: unknown; other?: unknown; ok?: unknown } | null;
        const list = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string").slice(0, 6) : []);
        if (!j) problems.push("the picture check gave no clear answer");
        else {
          if (list(j.text).length) problems.push(`text or logos in ${list(j.text).join(", ")}`);
          if (list(j.notAdult).length) problems.push(`may not look adult: ${list(j.notAdult).join(", ")}`);
          if (list(j.other).length) problems.push(`other problems in ${list(j.other).join(", ")}`);
          if (j.ok !== true && !list(j.text).length && !list(j.notAdult).length && !list(j.other).length) problems.push("the picture check didn't pass the pictures");
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, vision: usedVision };
}

// ---------------------------------------------------------------- running it

const runs = new Map<string, Promise<PipelineState>>();
export const realScreensRunning = (appId: string) => runs.has(appId);

/** Can the pipeline serve this app (a Supabase app with its migrations)? Docker is checked by the capture step, which says what to install. */
export function pipelineApplies(_t: Tenant, app: AppEntry): boolean {
  if (process.env.DAY2_REAL_SCREENS === "off") return false;
  return demoSupport(app.repoPath).ok;
}

/**
 * Makes sure the app has real screens: runs the pipeline from where it
 * stopped. Single-flight per app (a second call while one runs gets the same
 * promise). Never throws: problems end up in the state.
 */
export function ensureRealScreens(t: Tenant, app: AppEntry, o: { trigger: PipelineTrigger }): Promise<PipelineState> {
  const have = runs.get(app.id);
  if (have) return have;
  const p = runPipeline(t, app, o.trigger)
    .catch((err: Error) => {
      console.error(`[day2-real-screens] ${app.name}: ${err.message}`);
      return loadPipeline(app.id);
    })
    .finally(() => runs.delete(app.id));
  runs.set(app.id, p);
  trackJob(app.id, "pipeline", p);
  return p;
}

type Outcome = { done: string } | { wait: string } | { attention: string };
const castOf = (app: AppEntry) => loadCast(app.id, assetStore()).catch(() => null);

/** The account's credits allow this step's worst case (null) or why not. */
async function budget(t: Tenant, app: AppEntry, service: CreditService, usd: number): Promise<string | null> {
  const h = realScreensHooks();
  if (h.credits) {
    const c = h.credits(service, usd);
    return c.ok ? null : c.reason;
  }
  try {
    const c = await authorize(t.credits, { appId: app.id, appName: app.name, service, maxCostUsd: usd });
    return c.ok ? null : c.reason;
  } catch {
    return null;
  }
}

async function flowTicket(app: AppEntry) {
  const tickets = (await ticketsOf(app)) as Array<{ id: string; state: string; source: { key: string }; approval?: { kind: string; number?: number; url?: string } }>;
  return tickets.filter((x) => x.source.key === DEMO_FLOW_KEY).sort((a, b) => (a.state === "parked" ? 1 : 0) - (b.state === "parked" ? 1 : 0))[0] ?? null;
}

function freshCapture(app: AppEntry, castApprovedAt: string | null): { ok: boolean; note: string | null } {
  const profile = profileOf(app);
  const set = loadCaptureSet(app.id, localeFor(languageOf(app, profile)));
  if (!set || set.source !== "capture") return { ok: false, note: null };
  const version = appVersion(app.repoPath);
  if (version && set.version && set.version !== version) return { ok: false, note: `The capture is from version ${set.version}; the app is at ${version}.` };
  if (castApprovedAt && Date.parse(set.capturedAt) < Date.parse(castApprovedAt)) return { ok: false, note: "A newer demo cast was approved after the capture." };
  return { ok: true, note: `${set.screens.length} screens captured ${set.capturedAt.slice(0, 10)}${set.device ? ` on ${set.device}` : ""}.` };
}

/** Is a step already done in the world (and why), or null. */
async function doneNote(t: Tenant, app: AppEntry, step: PipelineStep, st: PipelineState): Promise<string | null> {
  const cast = await castOf(app);
  switch (step) {
    case "cast":
      return cast && !st.regenerate ? `${cast.people.length} invented people, ${cast.moments.length} moments (${cast.images.source} pictures).` : null;
    case "approve":
      return cast?.status === "approved" ? `Approved${cast.approvedBy ? ` by ${cast.approvedBy}` : ""}.` : null;
    case "seed_plan": {
      const p = seedPlanState(app.id, app.repoPath);
      return p.state === "ready" ? `${p.plan.source === "model" ? "Written by a model" : "Built-in"}, ${p.plan.steps.length} tables (${p.plan.steps.map((x) => x.table).join(", ")}), valid for the current ${p.files.length} migrations.` : null;
    }
    case "flow": {
      if (demoFlowInRepo(app)) return "The flow is in the app's repo.";
      const tk = await flowTicket(app);
      return tk ? `Ticket ${tk.id}.` : null;
    }
    case "flow_merged": {
      if (demoFlowInRepo(app)) return "The flow is in the app's repo.";
      const tk = await flowTicket(app);
      return tk?.state === "done" ? `Ticket ${tk.id} is done (its pull request was merged).` : null;
    }
    case "capture": {
      const f = freshCapture(app, cast?.status === "approved" ? cast.approvedAt : null);
      return f.ok ? f.note : null;
    }
  }
}

function demoErrorOutcome(err: unknown): Outcome | null {
  if (err instanceof CreditsError) return { attention: `Not enough credits for this step: ${err.check.ok ? "" : err.check.reason}` };
  if (err instanceof SeedPlanError) return { attention: `${err.message} Fix the migration or table in the app's repo, then press Retry. Posts keep using the screens day2 already has.` };
  if (err instanceof DemoError && ["unsupported", "not_configured", "guard", "not_approved"].includes(err.code)) return { attention: err.message };
  return null;
}

async function runStep(t: Tenant, app: AppEntry, step: PipelineStep, st: PipelineState): Promise<Outcome> {
  const h = realScreensHooks();
  switch (step) {
    case "cast": {
      const why = await budget(t, app, "content_generation", STEP_COST_USD.cast);
      if (why) return { attention: `The demo cast needs credits: ${why}` };
      const r = await runJob(app.id, "cast", async () => {
        const w = await writeCast(t, app);
        return { note: w.note, value: w };
      });
      updatePipeline(app.id, (s) => {
        s.regenerate = false;
        s.autoApproval = null;
      });
      return { done: r.note };
    }
    case "approve": {
      const cast = await castOf(app);
      if (!cast) throw new Error("The demo cast is missing.");
      if (st.declined === castKey(cast)) return { wait: "You declined this cast — press Regenerate for another one, or upload screenshots instead." };
      if (st.settings.demoCast === "owner") return { wait: "Waiting for your OK on the demo cast (below). day2 approves casts by itself when the setting is Automatic." };
      let check = st.autoApproval?.key === castKey(cast) ? st.autoApproval : null;
      if (!check) {
        const vision = "vision" in h ? (h.vision ?? null) : process.env.DAY2_CREATIVE_VISION === "off" ? null : runVision;
        const needsVision = castImages(cast).length > 0;
        if (needsVision && vision) {
          const why = await budget(t, app, "content_generation", STEP_COST_USD.check);
          if (why) return { wait: `Waiting for your OK: day2 can't check the pictures by itself (${why}).` };
        }
        // Metered like every vision run, charged to the app's account (tests: no credits involved).
        const paid = "vision" in h ? undefined : <T>(fn: () => Promise<T>) => paidFor(t, app)("content_generation", "Demo cast check", STEP_COST_USD.check, fn).then((r) => r.result);
        const r = await autoApprovalCheck(cast, { vision, paid });
        check = { key: castKey(cast), at: clock().toISOString(), ...r };
        const c = check;
        updatePipeline(app.id, (s) => {
          s.autoApproval = c;
          logLine(s, c.ok ? "The demo cast passed day2's checks." : `The demo cast didn't pass day2's checks: ${c.problems.join("; ")}.`);
        });
      }
      if (!check.ok) return { wait: `Waiting for your OK — day2's automatic check didn't pass: ${check.problems.join("; ")}.` };
      await approveCast(app, AUTO_APPROVER);
      return { done: `Approved automatically: the cast passed the schema check${check.vision ? " and the picture check (no text or logos, adults only, every picture there)" : " and every picture is there"}.` };
    }
    case "seed_plan": {
      const planner = seedPlanner(t, app);
      if (planner) {
        const why = await budget(t, app, "agent_work", STEP_COST_USD.seedPlan);
        if (why) return { attention: `The seed plan needs credits: ${why}` };
      }
      return runJob(app.id, "seed_plan", async () => {
        const r = await ensureSeedPlan(app.id, app.repoPath, { planner, now: clock() });
        return { note: r.note, value: { done: r.note } as Outcome };
      });
    }
    case "flow": {
      const tk = await ensureFlowTicket(app, await castOf(app));
      return { done: tk ? `Asked day2's build agent for the flow: ticket ${tk.id}.` : "The flow is in the app's repo." };
    }
    case "flow_merged": {
      const tk = await flowTicket(app);
      if (!tk) {
        await ensureFlowTicket(app, await castOf(app));
        return { wait: "Waiting for the flow PR: day2 asked its build agent for the flow again." };
      }
      if (tk.state === "parked") return { attention: `The flow's pull request was closed without merging (ticket ${tk.id}). Move the ticket back to To do on the Backlog with what to change, or upload screenshots instead.` };
      if (tk.state === "to_approve" && tk.approval?.kind === "pr") return { wait: `Waiting for the flow PR #${tk.approval.number} to be merged — it's in Approvals (ticket ${tk.id}).` };
      return { wait: `Waiting for the flow PR: day2's build agent is writing the flow (ticket ${tk.id}, ${tk.state.replace("_", " ")}).` };
    }
    case "capture":
      return captureStep(t, app);
  }
}

/** A capture for the pipeline: EAS on a server, the Mac's simulator locally; when EAS's screenshots can't be fetched, the Android emulator if this server has one. */
async function captureStep(t: Tenant, app: AppEntry): Promise<Outcome> {
  const h = realScreensHooks();
  const profile = profileOf(app);
  const ids = storeIdsFromRepo(app.repoPath);
  const input = { appId: app.id, repoPath: app.repoPath, language: languageOf(app, profile), features: profile?.featureMap ?? [], bundleId: ids.bundleId, packageName: ids.packageName };
  while (captureRunning(app.id)) await Bun.sleep(h.capture ? 5 : 5000);
  const first: CaptureStatus = await runCapture({ ...input, reason: "pipeline" }, captureDeps(t, app));
  if (first.state === "done") return { done: first.note ?? "Captured." };
  const note = first.note ?? "The capture failed.";
  switch (first.code) {
    case "artifact": {
      const android = h.android ?? androidEmulatorAvailable({ has, exists: existsSync });
      if (android.ok && ids.packageName) {
        const second = await runCapture({ ...input, bundleId: null, reason: "fallback_android" }, captureDeps(t, app, { android: true }));
        if (second.state === "done") return { done: `${second.note ?? "Captured."} (Android emulator — EAS's screenshots couldn't be downloaded.)` };
        return { attention: `${note} The Android emulator here didn't work either (${(second.note ?? "").slice(0, 160)}). Upload 3–8 screenshots below — posts use them until a capture works.` };
      }
      return { attention: `${note} ${android.ok ? "The app has no Android build" : `There's no fallback: ${android.why ?? "no Android emulator"}`}. Upload 3–8 screenshots below — posts use them until a capture works.` };
    }
    case "no_token":
    case "off":
      return { attention: `${note} Until then posts use uploaded screenshots or the store's.` };
    case "no_docker":
    case "no_tunnel":
      return { attention: `${note} Until then posts use uploaded screenshots or the store's.` };
    case "migration":
      return { attention: `${note} Fix the migration in the app's repo, then press Retry. Posts keep using the screens day2 already has.` };
    case "database":
    case "no_flow":
    case "no_demo":
    case "device":
    default:
      throw new Error(note);
  }
}

async function runPipeline(t: Tenant, app: AppEntry, trigger: PipelineTrigger): Promise<PipelineState> {
  const now = clock();
  let st = updatePipeline(app.id, (s) => {
    s.lastRunAt = now.toISOString();
    s.lastTrigger = trigger;
  });
  const support = demoSupport(app.repoPath);
  if (!support.ok) {
    return updatePipeline(app.id, (s) => {
      s.blocked = support.why;
      for (const k of PIPELINE_STEPS) if (s.steps[k].status !== "done") s.steps[k] = { ...s.steps[k], status: "skipped", note: null };
    });
  }
  if (st.blocked)
    st = updatePipeline(app.id, (s) => {
      s.blocked = null;
      for (const k of PIPELINE_STEPS) if (s.steps[k].status === "skipped") s.steps[k] = emptyStep();
    });
  for (const step of PIPELINE_STEPS) {
      st = loadPipeline(app.id);
      const rec = st.steps[step];
      const done = await doneNote(t, app, step, st);
      if (done) {
        if (rec.status !== "done" || rec.note !== done) setStep(app.id, step, { status: "done", attempts: 0, lastError: null, nextRetryAt: null, note: done }, rec.status !== "done" ? `${STEP_LABEL[step]}: done. ${done}` : undefined);
        continue;
      }
      // Done before, not any more (a new version, a new cast, changed migrations): do it again.
      if (rec.status === "done" || rec.status === "skipped" || rec.status === "running") setStep(app.id, step, { status: "pending", attempts: 0, nextRetryAt: null, note: null });
      else if (rec.status === "needs_attention") break;
      else if (rec.status === "pending" && !isDue(rec, clock())) break;
      setStep(app.id, step, { status: "running", note: null });
      let out: Outcome;
      try {
        out = await runStep(t, app, step, loadPipeline(app.id));
      } catch (err) {
        const known = demoErrorOutcome(err);
        if (known) out = known;
        else {
          const msg = (err as Error).message.slice(0, 400);
          updatePipeline(app.id, (s) => {
            s.steps[step] = failStep(s.steps[step], step, msg, clock());
            logLine(s, `${STEP_LABEL[step]}: failed — ${msg}`);
          });
          break;
        }
      }
      if ("done" in out) {
        setStep(app.id, step, { status: "done", attempts: 0, lastError: null, nextRetryAt: null, note: out.done }, `${STEP_LABEL[step]}: done. ${out.done}`);
        continue;
      }
      if ("wait" in out) {
        const w = out.wait;
        setStep(app.id, step, { status: "waiting", note: w }, loadPipeline(app.id).steps[step].note !== w ? `${STEP_LABEL[step]}: ${w}` : undefined);
        break;
      }
      const a = out.attention;
      updatePipeline(app.id, (s) => {
        s.steps[step] = failStep(s.steps[step], step, a, clock(), { fatal: true });
        logLine(s, `${STEP_LABEL[step]} needs your attention: ${a}`);
      });
      break;
    }
  return loadPipeline(app.id);
}

// ---------------------------------------------------------------- the timer: triggers and maintenance

/** Is growth or social on for the app (the autopilot, or a connected social account)? */
export async function growthOn(app: AppEntry): Promise<boolean> {
  const h = realScreensHooks();
  if (h.growthOn) return h.growthOn(app);
  if (loadAutopilot(resolve(app.repoPath, AUTOPILOT_FILENAME)).enabled) return true;
  return (await socialAccounts().forApp(app.id).catch(() => [])).length > 0;
}

/**
 * One timer pass for an app (api-server's backlog timer): growth off for 30
 * days → clean up; otherwise remove an old standing demo project once,
 * notice a new app version and changed migrations (the seed plan is checked
 * again), re-arm stuck steps once a day, and run the pipeline (single-flight;
 * cheap when there's nothing to do). Returns what it started (tests await it).
 */
export async function realScreensTick(t: Tenant, app: AppEntry, o: { now?: Date } = {}): Promise<{ trigger: PipelineTrigger | null; cleaned: boolean; run: Promise<PipelineState> | null }> {
  const now = o.now ?? clock();
  if (!pipelineApplies(t, app)) return { trigger: null, cleaned: false, run: null };
  await migrateLegacyDemo(t, app, now);
  let st = loadPipeline(app.id);
  if (!(await growthOn(app))) {
    if (!st.growthOffSince) updatePipeline(app.id, (s) => void (s.growthOffSince = now.toISOString()));
    else if (now.getTime() - Date.parse(st.growthOffSince) >= GROWTH_OFF_CLEANUP_DAYS * DAY && !st.cleanup.at) {
      if (existsSync(castDir(app.id))) {
        await cleanupRealScreens(t, app, "growth_off");
        return { trigger: null, cleaned: true, run: null };
      }
    }
    return { trigger: null, cleaned: false, run: null };
  }
  let trigger: PipelineTrigger | null = null;
  st = updatePipeline(app.id, (s) => {
    if (s.growthOffSince || s.cleanup.at) {
      s.growthOffSince = null;
      s.cleanup = { at: null, reason: null, note: null };
    }
  });
  if (!st.lastRunAt) trigger = "growth_on";
  // The app's migrations changed: the seed plan is checked against them again (the next capture applies them all to a fresh database).
  const fp = migrationsHash(readMigrations(app.repoPath));
  if (st.maintenance.migrations && fp && fp !== st.maintenance.migrations) {
    trigger = "migrations_changed";
    updatePipeline(app.id, (s) => {
      s.steps.seed_plan = { ...emptyStep(), note: "The app's migrations changed — checking the seed plan against them again." };
      logLine(s, "The app's database migrations changed: the seed plan is checked against them again.", now);
    });
  }
  // A new app version: the capture is stale (the capture step sees it).
  const version = appVersion(app.repoPath);
  if (st.maintenance.appVersion && version && version !== st.maintenance.appVersion) {
    trigger ??= "new_version";
    updatePipeline(app.id, (s) => logLine(s, `New app version ${version}: capturing its screens again.`, now));
  }
  // Once a day: re-arm what needs attention for one more try.
  const daily = !st.maintenance.checkedAt || now.getTime() - Date.parse(st.maintenance.checkedAt) >= DAY;
  if (daily) {
    trigger ??= st.lastRunAt ? "daily" : trigger;
    updatePipeline(app.id, (s) => rearm(s, { attempts: RETRY.max - 1, except: ["approve"], onlyAttention: true }));
  }
  updatePipeline(app.id, (s) => {
    s.maintenance = { ...s.maintenance, checkedAt: daily ? now.toISOString() : s.maintenance.checkedAt, migrations: fp, appVersion: version };
  });
  const run = ensureRealScreens(t, app, { trigger: trigger ?? "tick" });
  return { trigger, cleaned: false, run };
}

/** The one-time migration from the old design: an app's recorded demo project is deleted through the guard, then forgotten. */
async function migrateLegacyDemo(t: Tenant, app: AppEntry, now = clock()): Promise<void> {
  const deps = demoDeps(t, app);
  const r = await retireLegacyDemo(app, deps).catch((err: Error) => ({ state: "kept" as const, note: err.message.slice(0, 200) }));
  if (r.state === "none") return;
  updatePipeline(app.id, (s) => {
    if (s.maintenance.legacy !== r.note) logLine(s, r.note ?? "", now);
    s.maintenance = { ...s.maintenance, legacy: r.note };
  });
  if (r.state === "deleted" || r.state === "forgotten") console.log(`[day2-real-screens] ${app.name}: ${r.note}`);
}

// ---------------------------------------------------------------- cleanup

type Orphan = { appId: string; ref: string; name: string; orgSlug: string; at: string; error: string };
const orphansFile = () => join(dataDir(), "real-screens", "orphans.json");
const loadOrphans = (): Orphan[] => {
  try {
    return JSON.parse(readFileSync(orphansFile(), "utf-8")) as Orphan[];
  } catch {
    return [];
  }
};
const saveOrphans = (o: Orphan[]) => {
  mkdirSync(join(orphansFile(), ".."), { recursive: true });
  writeFileSync(orphansFile(), JSON.stringify(o.slice(0, 200), null, 2));
};

/**
 * Deletes an app's demo assets: the app was removed ("removed": the cast,
 * its pictures, captures, the seed plan and pipeline state), or growth has
 * been off for 30 days ("growth_off": the cast and its pictures; captures
 * and the seed plan stay; the pipeline starts over when growth comes back).
 * There's no demo database to delete — only an old standing demo project
 * from the previous design, through the guard; one Supabase won't delete
 * now is remembered and retried by the timer (retryOrphanDemos).
 */
export async function cleanupRealScreens(t: Tenant, app: AppEntry, reason: "removed" | "growth_off"): Promise<{ deleted: string | null; assets: number; error: string | null }> {
  const deps = demoDeps(t, app);
  const old = (await deps.store.state(app.id).catch(() => null))?.demo ?? null;
  let deleted: string | null = null;
  let error: string | null = null;
  if (old) {
    const r = await retireLegacyDemo(app, deps).catch((err: Error) => ({ state: "kept" as const, note: err.message }));
    if (r.state === "deleted") deleted = old.ref;
    else if (r.state === "kept") {
      error = (r.note ?? "").slice(0, 300);
      if (reason === "removed") {
        saveOrphans([...loadOrphans().filter((x) => x.ref !== old.ref), { appId: app.id, ref: old.ref, name: old.name, orgSlug: old.orgSlug, at: clock().toISOString(), error }]);
        await deps.store.update(app.id, (s) => void (s.demo = null)).catch(() => undefined);
      }
    }
  }
  let assets = 0;
  const store = assetStore();
  for (const a of await store.list(app.id, CAST_PURPOSE).catch(() => [])) {
    await store.remove?.(a.id).catch(() => undefined);
    assets++;
  }
  rmSync(castDir(app.id), { recursive: true, force: true });
  if (reason === "removed") {
    rmSync(capturesDir(app.id), { recursive: true, force: true });
    rmSync(join(dataDir(), "real-screens", safe(app.id)), { recursive: true, force: true });
  } else {
    const note = `Growth has been off for ${GROWTH_OFF_CLEANUP_DAYS} days: day2 deleted the demo cast and its pictures. It writes a new one when growth is back on; screens captured before stay usable.`;
    updatePipeline(app.id, (s) => {
      const fresh = emptyPipeline(app.id);
      return { ...fresh, settings: s.settings, growthOffSince: s.growthOffSince, maintenance: s.maintenance, cleanup: { at: clock().toISOString(), reason, note }, log: [{ at: clock().toISOString(), text: note }, ...s.log].slice(0, 40) };
    });
  }
  console.log(`[day2-real-screens] ${app.name}: cleaned up (${reason})${deleted ? `, deleted the old demo project ${deleted}` : ""}${error ? `; couldn't delete the old demo project yet: ${error}` : ""}.`);
  return { deleted, assets, error };
}

/** Old demo projects of removed apps that couldn't be deleted at the time: tried again (only "-demo" projects in day2's organization). */
export async function retryOrphanDemos(deps: { operator: { token: string; orgSlug: string } | null; api: (token: string) => SupabaseApi }): Promise<number> {
  const list = loadOrphans();
  if (!list.length || !deps.operator) return 0;
  const api = deps.api(deps.operator.token);
  const left: Orphan[] = [];
  let n = 0;
  for (const o of list) {
    try {
      const p = await api.project(o.ref);
      if (!p.name.endsWith("-demo") || p.name !== o.name || p.organization_slug !== deps.operator.orgSlug) continue; // not ours to delete any more
      await api.deleteProject(o.ref);
      n++;
    } catch (err) {
      if (err instanceof SupabaseError && err.status === 404) {
        n++;
        continue;
      }
      left.push({ ...o, error: (err as Error).message.slice(0, 300) });
    }
  }
  saveOrphans(left);
  return n;
}

// ---------------------------------------------------------------- the view

export function pipelineView(appId: string) {
  const s = loadPipeline(appId);
  const running = realScreensRunning(appId);
  const current = currentStep(s);
  return {
    policy: s.settings.demoCast,
    running,
    blocked: s.blocked,
    current,
    done: !s.blocked && current === null,
    steps: PIPELINE_STEPS.map((k) => {
      const r = s.steps[k];
      // A "running" record without a run in this process: day2 restarted — it picks up again.
      const status: StepStatus = r.status === "running" && !running ? "pending" : r.status;
      return { id: k, label: STEP_LABEL[k], status, note: r.note, lastError: r.lastError, attempts: r.attempts, maxAttempts: RETRY.max, nextRetryAt: r.nextRetryAt, updatedAt: r.updatedAt };
    }),
    autoApproval: s.autoApproval ? { ok: s.autoApproval.ok, problems: s.autoApproval.problems, at: s.autoApproval.at } : null,
    declines: s.declines,
    lastRunAt: s.lastRunAt,
    lastTrigger: s.lastTrigger,
    growthOffSince: s.growthOffSince,
    cleanup: s.cleanup.at ? s.cleanup : null,
    posts: s.posts,
    log: s.log.slice(0, 12),
  };
}

/** Every app's real screens on the backlog timer (api-server.ts); one app's failure never stops the rest. */
export async function realScreensAll(): Promise<void> {
  if (process.env.DAY2_REAL_SCREENS === "off") return;
  const { work } = await import("../backlog-cli");
  const { runAsTenant } = await import("../tenant");
  const { operatorConfig } = await import("../hosting/operator");
  const { supabaseApi } = await import("../hosting/supabase");
  const op = operatorConfig();
  // Old demo projects of removed apps (the previous design), only while day2's Supabase organization is configured.
  if (op) await retryOrphanDemos({ operator: op, api: supabaseApi }).catch((err: Error) => console.error(`[day2-real-screens] orphan demo projects: ${err.message}`));
  for (const { tenant, app } of await work()) {
    await runAsTenant(tenant, async () => {
      try {
        await realScreensTick(tenant, app);
      } catch (err) {
        console.error(`[day2-real-screens] ${app.name}: ${(err as Error).message}`);
      }
    });
  }
}

/** Leftover temporary databases (a crash, a restart) on this machine: removed when older than two hours. On startup and on the timer, per server. */
export async function ephemeralJanitor(): Promise<string[]> {
  if (process.env.DAY2_REAL_SCREENS === "off") return [];
  return janitor(ephemeralDeps()).catch((err: Error) => {
    console.error(`[day2-ephemeral] janitor: ${err.message}`);
    return [];
  });
}
