import { startingPoints } from "../learning/runtime";
import { categorize } from "../learning/taxonomy";
import { memoryFor } from "../memory/runtime";
import { authConfig } from "../auth";
import { CreditsError } from "../credits";
import { db } from "../db";
import { dataDir } from "../day2-paths";
import { runDeviceChecks } from "../device-checks";
import { features } from "../features";
import { placeLibrary } from "../field-work";
import { defaultPushToGitHub } from "../lovable";
import { bunRunner } from "../mobile-release/eas";
import { loadDeviceReport, shotPath } from "../device-checks";
import { flowFilePath, mockupDir, mockupPath } from "../mockups";
import { ingestKeys, loadAccountTenant, localOperatorName, localTenant, runAsTenant, serverMode, type Tenant } from "../tenant";
import { hostingDeps } from "../hosting/runtime";
import { hostingEnabled, monthlyEstimate, operatorConfig, type Region } from "../hosting";
import { createAgents, createRender } from "./agents";
import { decideHosting } from "./hosting";
import { exportZip } from "./export";
import { layoutFlowMap } from "./flow-map";
import { latest, parseChangeRequest, parseComment } from "./screen-flow";
import { addComment, approveFlow, cancelCreate, deleteComment, flowDir, getCreate, NotFound, requestChanges, resumeAll, setOwnerStep, setScreenApproved, startCreate, unstick, type CreateDeps, type DeviceShot } from "./flow";
import { estimateCreate, validateCreateRequest } from "./request";
import { dbCreateStore, fileCreateStore, type CreateStore } from "./store";
import { PHASE_LABEL, PHASES, type ExpoBuild, type Phase } from "./types";

/**
 * API for Create (registered from api-server.ts with one line):
 *
 *   GET    /api/expo-create                               estimate + this account's builds
 *   POST   /api/expo-create                               start (the owner's description)
 *   GET    /api/expo-create/:cid                          one build (polled for progress)
 *   POST   /api/expo-create/:cid/flow/comments            { screenId, text, pin?: { x, y } } (screenId "style" or "flow" too)
 *   DELETE /api/expo-create/:cid/flow/comments/:mid
 *   POST   /api/expo-create/:cid/flow/screens/:sid        { approved: boolean } (approve one screen early)
 *   POST   /api/expo-create/:cid/flow/changes             { note?, add?: [{ name, purpose }], remove?: [screen ids] } → next version
 *   POST   /api/expo-create/:cid/flow/approve             the whole flow: building starts
 *   GET    /api/expo-create/:cid/flow/files/:file         a drawing, style card or flow map (PNG or HTML)
 *   GET    /api/expo-create/:cid/flow/export.zip?v=N      the screen flow for Claude Design / Figma
 *   GET    /api/expo-create/:cid/shots/:key?f=…           a simulator screenshot (next to its drawing)
 *   POST   /api/expo-create/:cid/unstick                  { choice: "retry" | "continue" }
 *   POST   /api/expo-create/:cid/cancel
 *   POST   /api/expo-create/:cid/owner-steps/:sid         { done: boolean }
 *   GET    /api/expo-create/:cid/mockups/:file            an old key-screen drawing (PNG; builds from before the screen flow)
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;

export type ExpoRouteHelpers = {
  route: (method: string, pathname: string, handler: Handler) => void;
  httpError: (status: number, message: string) => Error;
  json: (data: unknown, init?: ResponseInit) => Response;
  requirePlan: (t: Tenant) => Promise<void>;
  requireAppSlot: (t: Tenant) => Promise<void>;
  managedRepoDir: (t: Tenant, appId: string) => string;
};

export function createStore(): CreateStore {
  return serverMode() === "accounts" ? dbCreateStore(db()) : fileCreateStore(dataDir());
}

async function ownerName(t: Tenant): Promise<string | null> {
  if (t.session) return t.session.user.name ?? t.session.user.login ?? null;
  const n = await localOperatorName();
  return n === "there" ? null : n;
}

export async function createDeps(t: Tenant, h: Pick<ExpoRouteHelpers, "managedRepoDir">): Promise<CreateDeps> {
  return {
    store: createStore(),
    accountId: t.accountId,
    credits: t.credits,
    apps: t.apps,
    repoDir: (id) => h.managedRepoDir(t, id),
    mockupDir,
    agents: createAgents,
    render: createRender,
    run: bunRunner,
    deviceChecks: (i) => runDeviceChecks({ appId: i.appId, repoPath: i.cwd, cwd: i.cwd, key: i.key, changedFiles: i.changedFiles }),
    deviceShots,
    placeLibrary: (dir) => placeLibrary(dir, "react-native"),
    pushToGitHub: defaultPushToGitHub,
    field: { key: (id) => ingestKeys().forApp(id), endpoint: authConfig().publicUrl },
    ownerName: await ownerName(t),
    local: t.mode === "local",
    runAs: (fn) => runAsTenant(t, fn),
    hosting: (app) => (hostingEnabled() ? hostingDeps(t, app) : null),
    // Read-only: a new app has no memory file yet, and memoryFor never creates one.
    knowledge: async (b) => {
      const memory = await memoryFor({ id: b.appId, repoPath: h.managedRepoDir(t, b.appId) }, "create", { hint: b.request.description });
      // A new app starts from what worked for similar apps — as defaults to test with a holdout, never as facts.
      const start = await startingPoints(categorize(b.request.description, b.request.audience));
      const worked = start.length ? `## Starting points from similar apps (anonymous results; build them as Live settings so they can be tested against a control)\n${start.map((x) => `- ${x}`).join("\n")}` : "";
      return [memory, worked].filter(Boolean).join("\n\n");
    },
  };
}

/** Whether this server hosts apps' backends (Supabase set up by the operator), and its default region. */
export function hostingConfig(): { configured: boolean; defaultRegion: Region } {
  const op = hostingEnabled() ? operatorConfig() : null;
  return { configured: Boolean(op), defaultRegion: op?.defaultRegion ?? "eu-central-1" };
}

/** The screenshots of a device check, by platform (the "after" side: the app as built). */
export function deviceShots(appId: string, key: string): DeviceShot[] {
  const r = loadDeviceReport(appId, key);
  if (!r) return [];
  return r.runs.flatMap((run) => run.shots.flatMap((s) => (s.after && shotPath(appId, key, s.after) ? [{ platform: run.platform, name: s.name, rel: s.after, file: shotPath(appId, key, s.after)! }] : [])));
}

/** The phases the progress list shows (the review loop's flow_revise shows as drawing). */
const SHOWN: Phase[] = PHASES.filter((p) => p !== "done" && p !== "flow_revise");

/** What the console gets: the build, its phase list, and each version's flow map layout. */
export function publicBuild(b: ExpoBuild, hosting = hostingConfig()) {
  const at = SHOWN.indexOf(b.phase === "flow_revise" ? "design" : b.phase);
  const plan = latest(b)?.plan ?? b.plan;
  const done = b.status === "done";
  const draft = b.flow.draft;
  return {
    ...b,
    repoDir: undefined,
    flow: {
      ...b.flow,
      draft: draft ? { n: draft.n, total: draft.redraw.length, drawn: draft.designs.filter((d) => d.drawnIn === draft.n).length } : undefined,
      versions: b.flow.versions.map((v) => ({ ...v, layout: layoutFlowMap(v.plan.screens) })),
    },
    /** The plan's hosting decision (needed, why, region, credits a month), shown at the flow approval. */
    hostingDecision: plan ? decideHosting(b, plan, hosting) : null,
    phases: SHOWN.map((p, i) => ({ id: p, label: PHASE_LABEL[p], state: done || (at !== -1 && i < at) || (at === -1 && b.phase === "done") ? "done" : i === at ? (b.status === "needs_you" ? "you" : b.status === "working" ? "now" : "stopped") : "next" })),
  };
}

export function registerExpoCreateRoutes(h: ExpoRouteHelpers): void {
  const { route, json, httpError } = h;
  const available = () => {
    if (!features().createExpoApps) throw httpError(404, "Creating native apps isn't available on this server.");
  };
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotFound) throw httpError(404, err.message);
      if (err instanceof CreditsError || typeof (err as { status?: unknown }).status === "number") throw err;
      throw httpError(409, (err as Error).message);
    }
  };

  route("GET", "/api/expo-create", async (_req, _params, t) => {
    available();
    const e = estimateCreate();
    const builds = (await createStore().list(t.accountId)).slice(0, 10).map((b) => publicBuild(b));
    // Hosting is a separate monthly line (service "Hosting"), only when the plan needs a backend.
    return json({ estimateCredits: e.credits, maxCredits: e.maxCredits, hostingMonthlyCredits: monthlyEstimate().credits, hostingConfigured: hostingConfig().configured, builds });
  });

  route("POST", "/api/expo-create", async (req, _params, t) => {
    available();
    await h.requirePlan(t);
    const valid = validateCreateRequest(await req.json().catch(() => null));
    if (!valid.ok) throw httpError(400, valid.reason);
    await h.requireAppSlot(t);
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => startCreate(valid.request, deps))) }, { status: 202 });
  });

  route("GET", "/api/expo-create/:cid", async (_req, params, t) => {
    available();
    const b = await getCreate({ store: createStore(), accountId: t.accountId }, params.cid!);
    if (!b) throw httpError(404, "No such app being created.");
    return json({ build: publicBuild(b) });
  });

  const screensOf = (b: ExpoBuild) => latest(b)?.plan.screens.map((s) => s.id) ?? [];
  const build = async (t: Tenant, cid: string) => {
    const b = await getCreate({ store: createStore(), accountId: t.accountId }, cid);
    if (!b) throw httpError(404, "No such app being created.");
    return b;
  };

  route("POST", "/api/expo-create/:cid/flow/comments", async (req, params, t) => {
    available();
    const b = await build(t, params.cid!);
    const c = parseComment(await req.json().catch(() => null), screensOf(b));
    if (!c) throw httpError(400, "Write a comment and pick the screen it's about.");
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => addComment(b.id, c, deps))) });
  });

  route("DELETE", "/api/expo-create/:cid/flow/comments/:mid", async (_req, params, t) => {
    available();
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => deleteComment(params.cid!, params.mid!, deps))) });
  });

  route("POST", "/api/expo-create/:cid/flow/screens/:sid", async (req, params, t) => {
    available();
    const body = (await req.json().catch(() => ({}))) as { approved?: unknown };
    if (typeof body.approved !== "boolean") throw httpError(400, "approved must be true or false.");
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => setScreenApproved(params.cid!, params.sid!, body.approved as boolean, deps))) });
  });

  route("POST", "/api/expo-create/:cid/flow/changes", async (req, params, t) => {
    available();
    const b = await build(t, params.cid!);
    const change = parseChangeRequest(await req.json().catch(() => null), screensOf(b));
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => requestChanges(b.id, change, deps))) });
  });

  route("POST", "/api/expo-create/:cid/flow/approve", async (_req, params, t) => {
    available();
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => approveFlow(params.cid!, deps))) });
  });

  route("GET", "/api/expo-create/:cid/flow/files/:file", async (_req, params, t) => {
    available();
    const b = await build(t, params.cid!);
    const f = params.file!;
    const known = b.flow.versions.some((v) => v.style.png === f || v.style.html === f || v.map?.png === f || v.map?.html === f || v.designs.some((d) => [d.png, d.html, d.androidPng, d.androidHtml].includes(f)));
    if (!known) throw httpError(404, "No such drawing.");
    // Builds from before the screen flow keep their key-screen drawings in the old folder.
    const p = flowFilePath(b.appId, f) ?? (b.mockups.some((m) => m.file === f) ? mockupPath(b.appId, f) : null);
    if (!p) throw httpError(404, "No such drawing.");
    const html = f.endsWith(".html");
    return new Response(Bun.file(p), {
      headers: {
        "content-type": html ? "text/html; charset=utf-8" : "image/png",
        "cache-control": "private, max-age=3600",
        // The drawings are day2's HTML: shown as documents, never with scripts or outside requests.
        ...(html ? { "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" } : {}),
      },
    });
  });

  route("GET", "/api/expo-create/:cid/flow/export.zip", async (req, params, t) => {
    available();
    const b = await build(t, params.cid!);
    const n = Number(new URL(req.url).searchParams.get("v") ?? "");
    const v = (Number.isInteger(n) && n > 0 ? b.flow.versions.find((x) => x.n === n) : undefined) ?? latest(b);
    if (!v) throw httpError(404, "There's no screen flow to download yet.");
    const bytes = exportZip(b, v, flowDir({ mockupDir }, b.appId));
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${b.request.name}-screens-v${v.n}.zip"`, "cache-control": "private, no-store" } });
  });

  route("GET", "/api/expo-create/:cid/shots/:key", async (req, params, t) => {
    available();
    const b = await build(t, params.cid!);
    const key = params.key!;
    const rel = new URL(req.url).searchParams.get("f") ?? "";
    if (!b.comparisons.some((c) => c.key === key && c.pairs.some((p) => p.shot === rel))) throw httpError(404, "No such screenshot.");
    const p = shotPath(b.appId, key, rel);
    if (!p) throw httpError(404, "No such screenshot.");
    return new Response(Bun.file(p), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  });

  route("POST", "/api/expo-create/:cid/unstick", async (req, params, t) => {
    available();
    const body = (await req.json().catch(() => ({}))) as { choice?: unknown };
    if (body.choice !== "retry" && body.choice !== "continue") throw httpError(400, "choice must be retry or continue.");
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => unstick(params.cid!, body.choice as "retry" | "continue", deps))) });
  });

  route("POST", "/api/expo-create/:cid/cancel", async (_req, params, t) => {
    available();
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => cancelCreate(params.cid!, deps))) });
  });

  route("POST", "/api/expo-create/:cid/owner-steps/:sid", async (req, params, t) => {
    available();
    const body = (await req.json().catch(() => ({}))) as { done?: unknown };
    if (typeof body.done !== "boolean") throw httpError(400, "done must be true or false.");
    const deps = await createDeps(t, h);
    return json({ build: publicBuild(await wrap(() => setOwnerStep(params.cid!, params.sid!, body.done as boolean, deps))) });
  });

  route("GET", "/api/expo-create/:cid/mockups/:file", async (_req, params, t) => {
    available();
    const b = await getCreate({ store: createStore(), accountId: t.accountId }, params.cid!);
    if (!b || !b.mockups.some((m) => m.file === params.file)) throw httpError(404, "No such drawing.");
    const p = mockupPath(b.appId, params.file!);
    if (!p) throw httpError(404, "No such drawing.");
    return new Response(Bun.file(p), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  });
}

/** On server start: carry on with builds that were working when it stopped. */
export async function resumeExpoCreates(h: Pick<ExpoRouteHelpers, "managedRepoDir">): Promise<void> {
  if (!features().createExpoApps) return;
  const store = createStore();
  const ids = await resumeAll(store, async (accountId) => {
    const t = serverMode() === "accounts" ? await loadAccountTenant(accountId) : localTenant();
    return t ? createDeps(t, h) : null;
  });
  if (ids.length) console.log(`[day2-create] Carrying on with ${ids.length} app${ids.length === 1 ? "" : "s"} being created: ${ids.join(", ")}`);
}
