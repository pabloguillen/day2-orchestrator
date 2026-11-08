import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeIdsFromRepo } from "../ads/app-links";
import type { AppEntry } from "../apps-registry";
import { dataDir } from "../day2-paths";
import { androidTarget, iosTarget } from "../device-checks/targets";
import { has, runCmd } from "../device-checks/run-cmd";
import { ensureDemoBackend, pauseDemo, resumeDemo, demoSupport, demoView, DemoError, type DemoDeps } from "../hosting/demo";
import { hostingDeps } from "../hosting/runtime";
import { buildPlanPrompt, PLAN_MARKER } from "../hosting/seed-plan";
import { bunRunner } from "../mobile-release/eas";
import { gitWorkdirs } from "../mobile-release/git-workdir";
import { profileOf, languageOf } from "../social/runtime";
import { paidFor, ticketOnce } from "../store-listing/deps";
import { afterMarker, runText } from "../store-listing/research";
import { runMaestro } from "../store-listing/screenshots";
import { assetStore, releaseCredentials, type Tenant } from "../tenant";
import { ensureBrandKit, resolveKit } from "./brand-kit";
import { appVersion, capturePlan, loadCaptureSet, localeFor, type CaptureSet } from "./capture";
import { autoCaptureReason, captureMode, captureRunning, loadCaptureStatus, runCapture, type CaptureReason, type CaptureRunDeps } from "./capture-run";
import { generateCast, fakeCastModel, type CastModel } from "./demo-cast/generate";
import { addCastImages } from "./demo-cast/images";
import type { DemoCast } from "./demo-cast/schema";
import { castAiFlags, loadCast, saveCast } from "./demo-cast/store";
import { DEMO_FLOW_KEY, demoFlowTicket, demoMoments } from "./demo-flow";
import { creatorKitFor } from "./kit";
import { loadCreativeState } from "./taste";
import { loadUploadSet, uploadLocales } from "./upload";

/**
 * Real screens for one app, wired to day2's stores (docs/creative-quality.md):
 * the demo cast (write → pictures → owner approves), the demo backend
 * (hosting/demo.ts), the Maestro flow ticket, captures (capture-run.ts) and
 * the owner's uploads. Long steps run in the background, one per app and
 * kind, with a status the console polls.
 */

type JobKind = "cast" | "backend";
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
  await Promise.all([...jobs.entries()].filter(([k]) => k.startsWith(`${appId}:`)).map(([, p]) => p.catch(() => undefined)));
  while (captureRunning(appId)) await Bun.sleep(5);
}

// ---------------------------------------------------------------- test hooks

type Hooks = { castModel?: CastModel | null; planner?: DemoDeps["planner"]; demoDeps?: (app: AppEntry) => DemoDeps; capture?: (app: AppEntry) => CaptureRunDeps; noImageKit?: boolean };
let hooks: Hooks = {};
/** Tests: fake models, a fake Supabase and fake capture runners. */
export function setRealScreensTestHooks(h: Hooks): void {
  hooks = h;
}

// ---------------------------------------------------------------- the real dependencies

const castModel = (t: Tenant, app: AppEntry): CastModel | null => {
  if ("castModel" in hooks) return hooks.castModel ?? null;
  if (process.env.DAY2_DEMO_CAST_MODEL === "fake") return fakeCastModel(Date.now() % 100_000);
  const paid = paidFor(t, app);
  return async (prompt) => (await paid("content_generation", "Demo cast", 0.4, () => runText(prompt, { service: "content_generation", label: "Demo cast", maxUsd: 0.4 }))).result;
};

function demoDeps(t: Tenant, app: AppEntry): DemoDeps {
  if (hooks.demoDeps) return hooks.demoDeps(app);
  const paid = paidFor(t, app);
  return {
    ...hostingDeps(t, app),
    planner:
      "planner" in hooks
        ? hooks.planner
        : async (schema, problems) => {
            const text = (await paid("agent_work", "Demo seed plan", 0.5, () => runText(buildPlanPrompt(schema, app.name, problems), { service: "agent_work", label: "Demo seed plan", maxUsd: 0.5 }))).result;
            return text ? afterMarker(text, PLAN_MARKER) : null;
          },
  };
}

function captureDeps(t: Tenant, app: AppEntry): CaptureRunDeps {
  if (hooks.capture) return hooks.capture(app);
  const ids = storeIdsFromRepo(app.repoPath);
  const mode = captureMode({ has }).mode;
  const d = demoDeps(t, app);
  const git = gitWorkdirs(app.id, app.repoPath);
  return {
    mode,
    checkout: async () => git.checkout((await git.head()).sha),
    demo: async () => {
      const state = await d.store.state(app.id);
      const demo = state.demo;
      if (!demo?.seededAt || !demo.publishableKey) return null;
      if (demo.pausedAt) {
        await resumeDemo(app, d);
        const cast = await loadCast(app.id, assetStore());
        if (cast) await ensureDemoBackend(app, cast, d);
      }
      const login = await d.secrets.get<{ email: string; password: string }>(app.id, "demo_login");
      return { url: demo.url, key: demo.publishableKey, login, ai: castAiFlags(await loadCast(app.id, assetStore())) };
    },
    local: { target: (p) => (p === "ios" ? iosTarget(ids.bundleId!, app.name) : androidTarget(ids.packageName!)), flow: runMaestro, run: (cmd) => runCmd(cmd, { timeoutMs: 120_000 }) },
    eas: { expoToken: async () => (await releaseCredentials().get(app.id, "expo"))?.value.token ?? null, run: (cmd, o) => bunRunner(cmd, o) },
    after: async () => {
      if (process.env.DAY2_DEMO_PAUSE_AFTER_CAPTURE === "off") return;
      if ((await d.store.state(app.id)).demo?.seededAt) await pauseDemo(app, d).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------- actions

/** Writes a new demo cast (draft) with pictures, in the background. */
export function startCast(t: Tenant, app: AppEntry): boolean {
  return background(app.id, "cast", async () => {
    const profile = profileOf(app);
    const language = languageOf(app, profile);
    const kit = resolveKit(ensureBrandKit(app.repoPath), { repoPath: app.repoPath, appName: app.name, dna: profile?.brand ?? null });
    const seed = Math.floor(Math.random() * 1_000_000);
    const { cast, note } = await generateCast({ appId: app.id, appName: app.name, purpose: profile?.purpose ?? app.name, features: profile?.featureMap ?? [], audience: profile?.targetUsers ?? "", language, tone: kit.tone }, { model: castModel(t, app), seed });
    const imageKit = hooks.noImageKit ? null : await creatorKitFor(t.accountId, app, "posts", { billing: { credits: t.credits, appId: app.id, appName: app.name } }).catch(() => null);
    const withImages = await addCastImages(cast, { kit: imageKit, store: assetStore(), repoPath: app.repoPath, appName: app.name, colors: [kit.primary, kit.accent ?? kit.primary, kit.surface] });
    saveCast(withImages);
    return `${note}. ${withImages.images.note}`;
  });
}

export async function approveCast(app: AppEntry, by: string | null): Promise<DemoCast> {
  const cast = await loadCast(app.id, assetStore());
  if (!cast) throw new DemoError("There's no demo cast yet.", "not_approved");
  const next: DemoCast = { ...cast, status: "approved", approvedAt: new Date().toISOString(), approvedBy: by };
  saveCast(next);
  return next;
}

/** Creates/fills the demo backend, then asks the build agent for the flow, in the background. */
export function startBackend(t: Tenant, app: AppEntry): boolean {
  return background(app.id, "backend", async () => {
    const cast = await loadCast(app.id, assetStore());
    if (!cast) throw new DemoError("Write and approve a demo cast first.", "not_approved");
    const d = demoDeps(t, app);
    const demo = await ensureDemoBackend(app, cast, d);
    const t2 = await ensureFlowTicket(app, cast);
    return `The demo backend is ready (${demo.rows} rows, ${demo.uploads} pictures).${t2 ? ` The flow is ticket ${t2.id}.` : ""}`;
  });
}

/** The Maestro flow ticket (once per app). */
export async function ensureFlowTicket(app: AppEntry, cast: DemoCast | null) {
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const plan = capturePlan({ repoPath: app.repoPath, language, features: profile?.featureMap ?? [] });
  if (plan.flow && plan.moments.length && existsSync(join(app.repoPath, ".maestro/day2/store-screens.yaml")) && readFileSync(join(app.repoPath, ".maestro/day2/store-screens.yaml"), "utf-8").includes("MAESTRO_DAY2_DEMO")) return null;
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
 * Before a post: start a capture on its own when the app has a new version
 * or before its first How it works post (waits for that one — up to the
 * capture's own time limits — so the first post has real screens).
 */
export async function maybeAutoCapture(t: Tenant, app: AppEntry, o: { making: "how-it-works" | null; wait: boolean }): Promise<CaptureReason | null> {
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const plan = capturePlan({ repoPath: app.repoPath, language, features: profile?.featureMap ?? [] });
  const mode = hooks.capture ? hooks.capture(app).mode : captureMode({ has }).mode;
  const reason = autoCaptureReason({ set: loadCaptureSet(app.id, plan.locale), version: appVersion(app.repoPath), howItWorksAt: loadCreativeState(app.repoPath).howItWorksAt, making: o.making, status: loadCaptureStatus(app.id), now: new Date(), ready: Boolean(plan.flow) && mode !== "off" });
  if (!reason) return null;
  if (!startCapture(t, app, reason)) return null;
  if (o.wait && reason === "first_how_it_works") while (captureRunning(app.id)) await Bun.sleep(hooks.capture ? 5 : 5000);
  return reason;
}

// ---------------------------------------------------------------- the view

const mediaUrl = (appId: string, assetId: string | null | undefined) => (assetId ? `/api/apps/${encodeURIComponent(appId)}/creative/demo-cast/images/${encodeURIComponent(assetId)}` : null);

export async function realScreensView(t: Tenant, app: AppEntry) {
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const locale = localeFor(language);
  const cast = await loadCast(app.id, assetStore()).catch(() => null);
  const hosting = demoDeps(t, app);
  const state = await hosting.store.state(app.id).catch(() => null);
  const mode = hooks.capture ? { mode: hooks.capture(app).mode, why: null, maestro: true } : captureMode({ has });
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
      last: set ? { capturedAt: set.capturedAt, version: set.version, screens: set.screens.length, device: set.device, aiContent: set.aiContent ?? null } : null,
    },
    uploads: uploadLocales(app.id).map((l) => {
      const u = loadUploadSet(app.id, l);
      return { locale: l, language: u?.language ?? l.slice(0, 2), at: u?.capturedAt ?? null, files: (u?.screens ?? []).map((s) => `/api/apps/${encodeURIComponent(app.id)}/creative/screens/${l}/${s.file.split("/").pop()}`) };
    }),
    demo: {
      support: demoSupport(app.repoPath),
      castJob: jobStatus(app.id, "cast"),
      backendJob: jobStatus(app.id, "backend"),
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
      backend: demoView(state?.demo),
      flowTicket: flowTicket ? { id: flowTicket.id, state: flowTicket.state } : null,
      moments: demoMoments(profile?.featureMap ?? [], []),
    },
  };
}

async function ticketsOf(app: AppEntry) {
  const { withBacklog } = await import("../backlog");
  const { backlogFile } = await import("../backlog-work");
  return (await withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b })).catch(() => ({ tickets: [] as Array<{ id: string; state: string; source: { key: string } }> }))).tickets;
}
