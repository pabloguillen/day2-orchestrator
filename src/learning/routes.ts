import type { AppEntry } from "../apps-registry";
import type { Tenant } from "../tenant";
import { publicOutcome } from "./library";
import { errorLabel } from "./playbook";
import { forgetAccount, learningStore, priorForApp, whatWorked, type Module } from "./runtime";
import { describePrior } from "./priors";
import { liveStore } from "../live/runtime";
import { CHANGE_KINDS, kindForKeys, type ChangeKind } from "./taxonomy";

/**
 * Learning API:
 *  - /api/apps/:id/learning/worked?module=… — "What worked elsewhere" next to a module's ideas;
 *  - /api/account/learning — the account's opt-out (default: shares anonymous outcomes);
 *  - /api/platform/learning/* — the operator's view of the library and the build playbook.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;

export type LearningRouteHelpers = {
  json: (data: unknown, init?: ResponseInit) => Response;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
  requireOperator: (t: Tenant) => void;
  httpError: (status: number, message: string) => Error;
};

const MODULES: Module[] = ["live", "money", "messages", "store", "retention", "create", "growth"];

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const SHARING_NOTE =
  "day2 learns which kinds of changes work across all the apps it runs — for example “a 7-day trial beat a 3-day trial in 7 of 9 fitness apps”. It shares only anonymous results: the kind of app, the kind of change and how much it moved a number, in relative terms (+6%). Never your app's name, texts, users, revenue or anything that identifies you. Turn it off and day2 stops sharing your apps' results and removes the ones already shared.";

export function registerLearningRoutes(route: (method: string, pathname: string, handler: Handler) => void, h: LearningRouteHelpers): void {
  const { json, requireApp, httpError } = h;

  route("GET", "/api/apps/:id/learning/worked", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const module = (new URL(req.url).searchParams.get("module") ?? "live") as Module;
    if (!MODULES.includes(module)) throw httpError(400, `module must be one of ${MODULES.join(", ")}.`);
    const lines = await whatWorked(app, module, { max: 3, accountId: t.accountId });
    // Live: the line for each new idea, from the kind of change it is.
    const ideas: Record<string, string> = {};
    if (module === "live") {
      const s = await liveStore().get(app.id);
      const cache = new Map<ChangeKind, string | null>();
      for (const i of s.ideas.filter((x) => x.status === "new")) {
        const kind = kindForKeys(i.keys, i.title);
        if (!cache.has(kind)) cache.set(kind, await priorForApp(app, kind, undefined, undefined, t.accountId).then((pr) => (pr ? describePrior(pr) : null)));
        const text = cache.get(kind);
        if (text) ideas[i.id] = text;
      }
    }
    return json({ lines: lines.map((l) => ({ kind: l.kind, text: l.text })), ideas });
  });

  route("GET", "/api/account/learning", async (_req, _p, t) => json({ share: await learningStore().sharing(t.accountId), note: SHARING_NOTE }));

  route("PUT", "/api/account/learning", async (req, _p, t) => {
    h.requireManager(t);
    const b = await body(req);
    if (typeof b.share !== "boolean") throw httpError(400, "Say share: true or false.");
    const store = learningStore();
    await store.setSharing(t.accountId, b.share);
    let removed = 0;
    if (!b.share) removed = await forgetAccount(t.accountId, (await t.apps.list()).map((a) => a.id), store);
    return json({ share: b.share, removed, note: SHARING_NOTE });
  });

  /** The operator's view: anonymous outcomes (no hashes), counts per kind, the playbook, false-positive candidates. */
  route("GET", "/api/platform/learning", async (_req, _p, t) => {
    h.requireOperator(t);
    const store = learningStore();
    const outcomes = await store.outcomes();
    const byKind = new Map<string, { kind: string; label: string; results: number; apps: Set<string>; better: number }>(); // hashes only counted, never returned
    for (const o of outcomes) {
      const k = byKind.get(o.kind) ?? byKind.set(o.kind, { kind: o.kind, label: CHANGE_KINDS[o.kind]?.label ?? o.kind, results: 0, apps: new Set(), better: 0 }).get(o.kind)!;
      k.results++;
      k.apps.add(o.appHash);
      if (o.verdict === "better") k.better++;
    }
    const pb = await store.playbook();
    return json({
      kinds: [...byKind.values()].map(({ apps, ...k }) => ({ ...k, apps: apps.size })).sort((a, b) => b.results - a.results),
      outcomes: outcomes.slice(-200).reverse().map(publicOutcome),
      playbook: pb.entries.map(({ apps, fixedIn, ...e }) => ({ ...e, errorLabel: errorLabel(e.errorType), apps: apps.length, fixedIn: fixedIn.length })),
      waiting: pb.open.length,
      candidates: await store.candidates(),
    });
  });

  route("POST", "/api/platform/learning/playbook/:pid", async (req, p, t) => {
    h.requireOperator(t);
    const b = await body(req);
    const status = b.status;
    if (status !== "approved" && status !== "retired" && status !== "candidate") throw httpError(400, "status must be approved, retired or candidate.");
    const fix = typeof b.fix === "string" ? b.fix.trim().slice(0, 300) : null;
    const found = await learningStore().updatePlaybook((s) => {
      const e = s.entries.find((x) => x.id === p.pid);
      if (!e) return { state: s, result: false };
      return { state: { ...s, entries: s.entries.map((x) => (x.id === e.id ? { ...x, status, ...(fix ? { fix } : {}), updatedAt: new Date().toISOString() } : x)) }, result: true };
    });
    if (!found) throw httpError(404, "No such playbook entry.");
    return json({ ok: true });
  });

  route("POST", "/api/platform/learning/candidates/:cid", async (req, p, t) => {
    h.requireOperator(t);
    const status = (await body(req)).status;
    if (status !== "approved" && status !== "dismissed") throw httpError(400, "status must be approved or dismissed.");
    const c = await learningStore().setCandidate(p.cid!, status, new Date());
    if (!c) throw httpError(404, "No such candidate.");
    return json({ ok: true, candidate: c });
  });
}
