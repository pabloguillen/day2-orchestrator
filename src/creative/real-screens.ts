import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeIdsFromRepo } from "../ads/app-links";
import type { AppEntry } from "../apps-registry";
import { dataDir } from "../day2-paths";
import { androidTarget, iosTarget } from "../device-checks/targets";
import { has, runCmd } from "../device-checks/run-cmd";
import { demoSupport, DemoError, type DemoClient, type DemoDeps } from "../hosting/demo";
import { ephemeralQueue, requirements, type EphemeralDeps } from "../hosting/ephemeral";
import { seedPlanView, type Planner } from "../hosting/seed-plan-cache";
import type { TunnelDeps } from "../hosting/tunnel";
import { hostingDeps } from "../hosting/runtime";
import { buildPlanPrompt, PLAN_MARKER } from "../hosting/seed-plan";
import { bunRunner } from "../mobile-release/eas";
import { gitWorkdirs } from "../mobile-release/git-workdir";
import { profileOf, languageOf } from "../social/runtime";
import { paidFor, ticketOnce } from "../store-listing/deps";
import { afterMarker, runText } from "../store-listing/research";
import { runMaestro } from "../store-listing/screenshots";
import { assetStore, releaseCredentials, type Tenant } from "../tenant";
import type { CreditCheck, CreditService } from "../credits";
import type { VisionRun } from "./vision";
import { ensureBrandKit, resolveKit } from "./brand-kit";
import { appVersion, capturePlan, loadCaptureSet, localeFor, type CaptureSet } from "./capture";
import { autoCaptureReason, captureMode, captureRunning, loadCaptureStatus, runCapture, type CaptureReason, type CaptureRunDeps } from "./capture-run";
import { generateCast, fakeCastModel, type CastModel } from "./demo-cast/generate";
import { addCastImages } from "./demo-cast/images";
import type { DemoCast } from "./demo-cast/schema";
import { loadCast, saveCast } from "./demo-cast/store";
import { openDemoSession } from "./demo-session";
import { DEMO_FLOW_KEY, demoFlowTicket, demoMoments } from "./demo-flow";
import { creatorKitFor } from "./kit";
import { loadCreativeState } from "./taste";
import { loadUploadSet, uploadLocales } from "./upload";

/**
 * Real screens for one app, wired to day2's stores (docs/creative-quality.md):
 * the demo cast (write → pictures → owner approves), the validated seed
 * plan (hosting/seed-plan-cache.ts), the Maestro flow ticket, captures
 * (capture-run.ts) against a temporary database per run
 * (demo-session.ts → hosting/ephemeral.ts) and the owner's uploads. No demo
 * database outlives a capture. Long steps run in the background, one per app and
 * kind, with a status the console polls.
 */

type JobKind = "cast" | "seed_plan";
export type JobStatus = { state: "idle" | "running" | "done" | "failed"; startedAt: string | null; finishedAt: string | null; note: string | null };
const jobFile = (appId: string, kind: JobKind) => join(dataDir(), "real-screens", appId.replace(/[^\w-]/g, "_"), `${kind}.json`);
const jobs = new Map<string, Promise<unknown>>();

export function jobStatus(appId: string, kind: JobKind): JobStatus {
  try {
    const s = JSON.parse(readFileSync(jobFile(appId, kind), "utf-8")) as JobStatus;
    if (s.state === "running" && !jobs.has(`${appId}:${kind}`)) return { ...s, state: "failed", note: "day2 restarted while this was running — try again." };
    return s;
  } catch {
    return { state: "idle", startedAt: null, finishedAt: null, note: null };
  }
}
function setJob(appId: string, kind: JobKind, s: JobStatus) {
  mkdirSync(join(jobFile(appId, kind), ".."), { recursive: true });
  writeFileSync(jobFile(appId, kind), JSON.stringify(s));
}
/** Runs `fn` now (awaited), recording it as the app's job of that kind (the pipeline's steps). */
export async function runJob<T>(appId: string, kind: JobKind, fn: () => Promise<{ note: string; value: T }>): Promise<T> {
  setJob(appId, kind, { state: "running", startedAt: new Date().toISOString(), finishedAt: null, note: null });
  try {
    const r = await fn();
    setJob(appId, kind, { ...jobStatus(appId, kind), state: "done", finishedAt: new Date().toISOString(), note: r.note });
    return r.value;
  } catch (err) {
    setJob(appId, kind, { ...jobStatus(appId, kind), state: "failed", finishedAt: new Date().toISOString(), note: (err as Error).message.slice(0, 300) });
    throw err;
  }
}
/** Tests and the pipeline: track a promise so settleRealScreens waits for it. */
export function trackJob(appId: string, kind: string, p: Promise<unknown>): void {
  const k = `${appId}:${kind}`;
  jobs.set(k, p);
  void p.catch(() => undefined).finally(() => {
    if (jobs.get(k) === p) jobs.delete(k);
  });
}
/** Starts `fn` in the background unless one of the same kind runs for the app. */
function background(appId: string, kind: JobKind, fn: () => Promise<string>): boolean {
  const k = `${appId}:${kind}`;
  if (jobs.has(k)) return false;
  setJob(appId, kind, { state: "running", startedAt: new Date().toISOString(), finishedAt: null, note: null });
  const p = fn()
    .then((note) => setJob(appId, kind, { ...jobStatus(appId, kind), state: "done", finishedAt: new Date().toISOString(), note }))
    .catch((err: Error) => setJob(appId, kind, { ...jobStatus(appId, kind), state: "failed", finishedAt: new Date().toISOString(), note: err.message.slice(0, 300) }))
    .finally(() => jobs.delete(k));
  jobs.set(k, p);
  return true;
}
/** Tests: wait for an app's background work. */
export async function settleRealScreens(appId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const open = [...jobs.entries()].filter(([k]) => k.startsWith(`${appId}:`));
    if (!open.length && !captureRunning(appId)) return;
    await Promise.all(open.map(([, p]) => p.catch(() => undefined)));
    while (captureRunning(appId)) await Bun.sleep(5);
  }
}

// ---------------------------------------------------------------- test hooks

type Hooks = {
  castModel?: CastModel | null;
  planner?: Planner | null;
  /** Hosting deps for the one-time removal of an old demo project (fake Supabase in tests). */
  demoDeps?: (app: AppEntry) => DemoDeps;
  /** The temporary database's runner (fake docker/CLI) and the tunnel's. */
  ephemeral?: () => EphemeralDeps;
  tunnel?: () => TunnelDeps;
  /** The seeding client for a temporary database (fake in tests). */
  seedClient?: (url: string, key: string) => DemoClient;
  /** A fake capture runner; `android` is the emulator fallback after a failed EAS download. */
  capture?: (app: AppEntry, o?: { android?: boolean }) => CaptureRunDeps;
  noImageKit?: boolean;
  /** The vision run for the automatic cast check (null: none available). */
  vision?: VisionRun | null;
  /** Credit checks (instead of the account's credits). */
  credits?: (service: CreditService, usd: number) => CreditCheck;
  /** Is growth/social on for the app. */
  growthOn?: (app: AppEntry) => boolean;
  /** Can this server run the Android emulator fallback. */
  android?: { ok: boolean; why: string | null };
  /** How long the first How it works post waits for the pipeline (ms). */
  postWaitMs?: number;
};
let hooks: Hooks = {};
/** Tests: fake models, a fake docker/CLI, fake capture runners. */
export function setRealScreensTestHooks(h: Hooks): void {
  hooks = h;
}
export const realScreensHooks = (): Hooks => hooks;

// ---------------------------------------------------------------- the real dependencies

const castModel = (t: Tenant, app: AppEntry): CastModel | null => {
  if ("castModel" in hooks) return hooks.castModel ?? null;
  if (process.env.DAY2_DEMO_CAST_MODEL === "fake") return fakeCastModel(Date.now() % 100_000);
  const paid = paidFor(t, app);
  return async (prompt) => (await paid("content_generation", "Demo cast", 0.4, () => runText(prompt, { service: "content_generation", label: "Demo cast", maxUsd: 0.4 }))).result;
};

/** Hosting deps (the operator's Supabase organization): only for removing an old demo project from before temporary databases. */
export function demoDeps(t: Tenant, app: AppEntry): DemoDeps {
  if (hooks.demoDeps) return hooks.demoDeps(app);
  return hostingDeps(t, app);
}

/** Writes the seed plan from the schema (a model run, metered), or null in tests without one. */
export function seedPlanner(t: Tenant, app: AppEntry): Planner | null {
  if ("planner" in hooks) return hooks.planner ?? null;
  const paid = paidFor(t, app);
  return async (schema, problems) => {
    const text = (await paid("agent_work", "Demo seed plan", 0.5, () => runText(buildPlanPrompt(schema, app.name, problems), { service: "agent_work", label: "Demo seed plan", maxUsd: 0.5 }))).result;
    return text ? afterMarker(text, PLAN_MARKER) : null;
  };
}

/** The temporary database's dependencies on this machine (docker, the Supabase CLI). */
export function ephemeralDeps(): EphemeralDeps {
  if (hooks.ephemeral) return hooks.ephemeral();
  return { run: async (cmd, o) => {
    const r = await runCmd(cmd, { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs });
    return { code: r.timedOut ? 124 : r.code, stdout: r.out, stderr: r.timedOut ? `${r.err}\ntimed out` : r.err };
  }, has };
}
export function tunnelDeps(): TunnelDeps {
  if (hooks.tunnel) return hooks.tunnel();
  return { has };
}

export function captureDeps(t: Tenant, app: AppEntry, o: { android?: boolean } = {}): CaptureRunDeps {
  if (hooks.capture) return hooks.capture(app, o);
  const ids = storeIdsFromRepo(app.repoPath);
  const mode = o.android ? "local" : captureMode({ has }).mode;
  const git = gitWorkdirs(app.id, app.repoPath);
  return {
    mode,
    checkout: async () => git.checkout((await git.head()).sha),
    demo: async ({ where, dir, log }) => {
      const cast = await loadCast(app.id, assetStore());
      if (!cast || cast.status !== "approved") return null;
      return openDemoSession({ appId: app.id, dir, cast, where, log }, { ephemeral: ephemeralDeps(), tunnel: tunnelDeps(), ...(hooks.seedClient ? { client: hooks.seedClient } : {}) });
    },
    local: { target: async (p) => (p === "ios" ? (o.android || !ids.bundleId ? { skip: "the Android emulator is used here" } : iosTarget(ids.bundleId, app.name)) : ids.packageName ? androidTarget(ids.packageName) : { skip: "the app has no Android package name" }), flow: runMaestro, run: (cmd) => runCmd(cmd, { timeoutMs: 120_000 }) },
    eas: { expoToken: async () => (await releaseCredentials().get(app.id, "expo"))?.value.token ?? null, run: (cmd, o) => bunRunner(cmd, o) },
  };
}

// ---------------------------------------------------------------- actions

/** Writes a new demo cast (draft) with pictures, in the background. */
export function startCast(t: Tenant, app: AppEntry): boolean {
  return background(app.id, "cast", async () => (await writeCast(t, app)).note);
}

/** Writes a new demo cast (draft) with pictures and saves it. */
export async function writeCast(t: Tenant, app: AppEntry): Promise<{ cast: DemoCast; note: string }> {
  {
    const profile = profileOf(app);
    const language = languageOf(app, profile);
    const kit = resolveKit(ensureBrandKit(app.repoPath), { repoPath: app.repoPath, appName: app.name, dna: profile?.brand ?? null });
    const seed = Math.floor(Math.random() * 1_000_000);
    const { cast, note } = await generateCast({ appId: app.id, appName: app.name, purpose: profile?.purpose ?? app.name, features: profile?.featureMap ?? [], audience: profile?.targetUsers ?? "", language, tone: kit.tone }, { model: castModel(t, app), seed });
    const imageKit = hooks.noImageKit ? null : await creatorKitFor(t.accountId, app, "posts", { billing: { credits: t.credits, appId: app.id, appName: app.name } }).catch(() => null);
    const withImages = await addCastImages(cast, { kit: imageKit, store: assetStore(), repoPath: app.repoPath, appName: app.name, colors: [kit.primary, kit.accent ?? kit.primary, kit.surface] });
    saveCast(withImages);
    return { cast: withImages, note: `${note}. ${withImages.images.note}` };
  }
}

export async function approveCast(app: AppEntry, by: string | null): Promise<DemoCast> {
  const cast = await loadCast(app.id, assetStore());
  if (!cast) throw new DemoError("There's no demo cast yet.", "not_approved");
  const next: DemoCast = { ...cast, status: "approved", approvedAt: new Date().toISOString(), approvedBy: by };
  saveCast(next);
  return next;
}

/** Is the demo flow (signing in with the demo account) in the app's checkout already? */
export function demoFlowInRepo(app: AppEntry): boolean {
  const profile = profileOf(app);
  const plan = capturePlan({ repoPath: app.repoPath, language: languageOf(app, profile), features: profile?.featureMap ?? [] });
  const f = join(app.repoPath, ".maestro/day2/store-screens.yaml");
  return Boolean(plan.flow && plan.moments.length && existsSync(f) && readFileSync(f, "utf-8").includes("MAESTRO_DAY2_DEMO"));
}

/** The Maestro flow ticket (once per app). */
export async function ensureFlowTicket(app: AppEntry, cast: DemoCast | null) {
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const plan = capturePlan({ repoPath: app.repoPath, language, features: profile?.featureMap ?? [] });
  if (demoFlowInRepo(app)) return null;
  return ticketOnce(app, demoFlowTicket({ appName: app.name, features: profile?.featureMap ?? [], locale: localeFor(language), cast, hasStoreFlow: Boolean(plan.flow), existingNotes: plan.flow ? plan.moments : [], record: true }));
}

export function startCapture(t: Tenant, app: AppEntry, reason: CaptureReason): boolean {
  if (captureRunning(app.id)) return false;
  const profile = profileOf(app);
  const ids = storeIdsFromRepo(app.repoPath);
  void runCapture({ appId: app.id, repoPath: app.repoPath, language: languageOf(app, profile), features: profile?.featureMap ?? [], bundleId: ids.bundleId, packageName: ids.packageName, reason }, captureDeps(t, app));
  return true;
}

/**
 * Before a post: real screens should be there. For an app the real-screens
 * pipeline can serve (real-screens-auto.ts: a Supabase app with migrations),
 * this kicks `ensureRealScreens` — cast, approval, seed plan, flow, capture
 * with a temporary database — and before the first How it works
 * post waits for it (at most DAY2_REAL_SCREENS_WAIT_MINUTES, default 45).
 * Otherwise the old path: a capture on its own for a new version or the
 * first How it works post when a flow exists. Never blocks a post for
 * good: the post goes ahead with the best screens there are (chooseScreens)
 * and the reason is recorded.
 */
export async function maybeAutoCapture(t: Tenant, app: AppEntry, o: { making: "how-it-works" | null; wait: boolean; log?: (text: string) => void }): Promise<CaptureReason | null> {
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const plan = capturePlan({ repoPath: app.repoPath, language, features: profile?.featureMap ?? [] });
  const auto = await import("./real-screens-auto");
  if (auto.pipelineApplies(t, app)) {
    const before = loadCaptureSet(app.id, plan.locale)?.capturedAt ?? null;
    const run = auto.ensureRealScreens(t, app, { trigger: o.making ? "first_post" : "post" });
    if (o.wait && o.making) {
      const limit = hooks.postWaitMs ?? Number(process.env.DAY2_REAL_SCREENS_WAIT_MINUTES ?? 45) * 60_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run.catch(() => null), new Promise((r) => (timer = setTimeout(r, limit)))]);
      clearTimeout(timer);
    }
    const after = loadCaptureSet(app.id, plan.locale)?.capturedAt ?? null;
    const captured = Boolean(after && after !== before);
    if (!captured) {
      const why = auto.pipelineWhy(app.id);
      if (why) {
        auto.recordPostScreens(app.id, why);
        o.log?.(`Real screens aren't ready (${why}) — this post uses the best screens day2 has.`);
      }
    }
    return captured ? (o.making ? "first_how_it_works" : "new_version") : null;
  }
  const mode = hooks.capture ? hooks.capture(app).mode : captureMode({ has }).mode;
  const reason = autoCaptureReason({ set: loadCaptureSet(app.id, plan.locale), version: appVersion(app.repoPath), howItWorksAt: loadCreativeState(app.repoPath).howItWorksAt, making: o.making, status: loadCaptureStatus(app.id), now: new Date(), ready: Boolean(plan.flow) && mode !== "off" });
  if (!reason) return null;
  if (!startCapture(t, app, reason)) return null;
  if (o.wait && reason === "first_how_it_works") while (captureRunning(app.id)) await Bun.sleep(hooks.capture ? 5 : 5000);
  return reason;
}

// ---------------------------------------------------------------- the view

const mediaUrl = (appId: string, assetId: string | null | undefined) => (assetId ? `/api/apps/${encodeURIComponent(appId)}/creative/demo-cast/images/${encodeURIComponent(assetId)}` : null);

let reqCache: { at: number; eas: boolean; value: Awaited<ReturnType<typeof requirements>> } | null = null;
/** Docker/CLI/cloudflared on this machine, checked at most once a minute (the console polls). */
async function cachedRequirements(eas: boolean) {
  if (reqCache && reqCache.eas === eas && Date.now() - reqCache.at < 60_000) return reqCache.value;
  const value = await requirements(ephemeralDeps(), { eas }).catch(() => []);
  reqCache = { at: Date.now(), eas, value };
  return value;
}

export async function realScreensView(t: Tenant, app: AppEntry) {
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const locale = localeFor(language);
  const cast = await loadCast(app.id, assetStore()).catch(() => null);
  const mode = hooks.capture ? { mode: hooks.capture(app).mode, why: null, maestro: true } : captureMode({ has });
  const reqs = await cachedRequirements(mode.mode === "eas");
  const set: CaptureSet | null = loadCaptureSet(app.id, locale);
  const tickets = await ticketsOf(app);
  const flowTicket = tickets.find((x) => x.source.key === DEMO_FLOW_KEY);
  return {
    capture: {
      ...loadCaptureStatus(app.id),
      running: captureRunning(app.id),
      mode: mode.mode,
      why: mode.why,
      maestro: mode.maestro,
      installHint: 'curl -fsSL "https://get.maestro.mobile.dev" | bash',
      /** What captures need on this machine: Docker and the Supabase CLI (temporary databases), cloudflared for EAS. */
      requirements: reqs,
      database: { ...(loadCaptureStatus(app.id).database ?? { state: null, note: null, at: null }), queue: ephemeralQueue() },
      last: set ? { capturedAt: set.capturedAt, version: set.version, screens: set.screens.length, device: set.device, aiContent: set.aiContent ?? null } : null,
    },
    uploads: uploadLocales(app.id).map((l) => {
      const u = loadUploadSet(app.id, l);
      return { locale: l, language: u?.language ?? l.slice(0, 2), at: u?.capturedAt ?? null, files: (u?.screens ?? []).map((s) => `/api/apps/${encodeURIComponent(app.id)}/creative/screens/${l}/${s.file.split("/").pop()}`) };
    }),
    pipeline: (await import("./real-screens-auto")).pipelineView(app.id),
    demo: {
      support: demoSupport(app.repoPath),
      castJob: jobStatus(app.id, "cast"),
      seedPlanJob: jobStatus(app.id, "seed_plan"),
      cast: cast
        ? {
            status: cast.status,
            approvedAt: cast.approvedAt,
            approvedBy: cast.approvedBy,
            createdAt: cast.createdAt,
            generator: cast.generator,
            language: cast.language,
            images: cast.images,
            self: cast.self,
            people: cast.people.map((p) => ({ key: p.key, displayName: p.displayName, username: p.username, age: p.age, city: p.city, bio: p.bio, avatar: mediaUrl(app.id, p.avatar?.assetId), aiPerson: Boolean(p.avatar?.aiPerson) })),
            moments: cast.moments.map((m) => ({ key: m.key, person: m.person, place: cast.places.find((x) => x.key === m.place)?.name ?? "", caption: m.caption, minutesAgo: m.minutesAgo, photo: mediaUrl(app.id, m.photo?.assetId) })),
            friends: cast.friendships.filter((f) => f.status === "accepted").length,
            leaderboard: cast.leaderboard.slice(0, 5),
          }
        : null,
      seedPlan: seedPlanView(app.id, app.repoPath),
      flowTicket: flowTicket ? { id: flowTicket.id, state: flowTicket.state } : null,
      moments: demoMoments(profile?.featureMap ?? [], []),
    },
  };
}

export async function ticketsOf(app: AppEntry) {
  const { withBacklog } = await import("../backlog");
  const { backlogFile } = await import("../backlog-work");
  return (await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b })).catch(() => ({ tickets: [] as Array<{ id: string; state: string; source: { key: string } }> }))).tickets;
}
