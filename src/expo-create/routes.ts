import { authConfig } from "../auth";
import { CreditsError } from "../credits";
import { db } from "../db";
import { dataDir } from "../day2-paths";
import { runDeviceChecks } from "../device-checks";
import { features } from "../features";
import { placeLibrary } from "../field-work";
import { defaultPushToGitHub } from "../lovable";
import { bunRunner } from "../mobile-release/eas";
import { mockupDir, mockupPath } from "../mockups";
import { ingestKeys, loadAccountTenant, localOperatorName, localTenant, runAsTenant, serverMode, type Tenant } from "../tenant";
import { createAgents } from "./agents";
import { cancelCreate, getCreate, NotFound, parseReview, resumeAll, reviewMockups, reviewPlan, setOwnerStep, startCreate, unstick, type CreateDeps } from "./flow";
import { estimateCreate, validateCreateRequest } from "./request";
import { dbCreateStore, fileCreateStore, type CreateStore } from "./store";
import { PHASE_LABEL, PHASES, type ExpoBuild } from "./types";

/**
 * API for Create (registered from api-server.ts with one line):
 *
 *   GET  /api/expo-create                         estimate + this account's builds
 *   POST /api/expo-create                         start (the owner's description)
 *   GET  /api/expo-create/:cid                    one build (polled for progress)
 *   POST /api/expo-create/:cid/plan               { decision: "approve" } | { decision: "comment", comment }
 *   POST /api/expo-create/:cid/mockups            same, for the drawings
 *   POST /api/expo-create/:cid/unstick            { choice: "retry" | "continue" }
 *   POST /api/expo-create/:cid/cancel
 *   POST /api/expo-create/:cid/owner-steps/:sid   { done: boolean }
 *   GET  /api/expo-create/:cid/mockups/:file      a drawing (PNG)
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
    run: bunRunner,
    deviceChecks: (i) => runDeviceChecks({ appId: i.appId, repoPath: i.cwd, cwd: i.cwd, key: i.key, changedFiles: i.changedFiles }),
    placeLibrary: (dir) => placeLibrary(dir, "react-native"),
    pushToGitHub: defaultPushToGitHub,
    field: { key: (id) => ingestKeys().forApp(id), endpoint: authConfig().publicUrl },
    ownerName: await ownerName(t),
    local: t.mode === "local",
    runAs: (fn) => runAsTenant(t, fn),
  };
}

/** What the console gets: the build plus its phase list for the progress page. */
export function publicBuild(b: ExpoBuild) {
  const at = PHASES.indexOf(b.phase);
  return {
    ...b,
    repoDir: undefined,
    phases: PHASES.filter((p) => p !== "done").map((p, i) => ({ id: p, label: PHASE_LABEL[p], state: b.status === "done" || i < at ? "done" : i === at ? (b.status === "needs_you" ? "you" : b.status === "working" ? "now" : "stopped") : "next" })),
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
    const builds = (await createStore().list(t.accountId)).slice(0, 10).map(publicBuild);
    return json({ estimateCredits: e.credits, maxCredits: e.maxCredits, builds });
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

  for (const what of ["plan", "mockups"] as const) {
    route("POST", `/api/expo-create/:cid/${what}`, async (req, params, t) => {
      available();
      const review = parseReview(await req.json().catch(() => null));
      if (!review) throw httpError(400, 'Send { "decision": "approve" } or { "decision": "comment", "comment": "…" }.');
      const deps = await createDeps(t, h);
      const b = await wrap(() => (what === "plan" ? reviewPlan : reviewMockups)(params.cid!, review, deps));
      return json({ build: publicBuild(b) });
    });
  }

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
