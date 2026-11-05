import type { AppEntry } from "../apps-registry";
import type { CreditService } from "../credits";
import type { Tenant } from "../tenant";
import { addItem, BLOCK_DAYS, editItem, MemoryError, setStatus, type ItemPatch } from "./core";
import { captureMemory, memoryStore, type CreditRunner } from "./runtime";
import { MEMORY_KINDS, PURPOSES, type MemoryDoc, type MemoryKind, type Purpose } from "./types";

/**
 * The memory API (/api/apps/:id/memory/*) behind the console's "What day2
 * knows" page: the items by kind with where each came from and when it was
 * last used, the ones that need confirming, recent changes, and the owner's
 * edits.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;

export type MemoryRouteHelpers = {
  json: (data: unknown, init?: ResponseInit) => Response;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  runWithCredits: <T>(t: Tenant, app: AppEntry, service: CreditService, description: string, maxCostUsd: number, fn: () => Promise<T>) => Promise<{ result: T; credits: number }>;
  actorName: (t: Tenant) => Promise<string | undefined>;
  httpError: (status: number, message: string) => Error;
};

const DAY = 86_400_000;

export function memoryView(d: MemoryDoc, now = new Date()) {
  const visible = d.items.filter((i) => i.status !== "retired");
  return {
    items: [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    needsConfirmation: visible.filter((i) => i.status === "needs_confirmation").length,
    retired: d.items.filter((i) => i.status === "retired").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30),
    changes: d.changes.slice(0, 20),
    declines: d.declines.filter((x) => Date.parse(x.at) + BLOCK_DAYS * DAY > now.getTime()).slice(0, 50),
    waiting: d.inbox.length,
    lastCaptureAt: d.lastCaptureAt,
    kinds: MEMORY_KINDS,
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const scopeOf = (v: unknown): Purpose[] | undefined => (Array.isArray(v) ? v.filter((p): p is Purpose => (PURPOSES as readonly string[]).includes(p as string)) : undefined);

export function registerMemoryRoutes(route: (method: string, pathname: string, handler: Handler) => void, h: MemoryRouteHelpers): void {
  const { json, requireApp, httpError } = h;
  const change = async <T>(app: AppEntry, fn: (d: MemoryDoc) => { doc: MemoryDoc; result: T }) => {
    try {
      return await memoryStore(app).update(app.id, fn);
    } catch (err) {
      if (err instanceof MemoryError) throw httpError(400, err.message);
      throw err;
    }
  };
  const respond = async (app: AppEntry, extra: Record<string, unknown> = {}) => json({ ...memoryView(await memoryStore(app).load(app.id)), ...extra });

  route("GET", "/api/apps/:id/memory", async (_req, p, t) => respond(await requireApp(t, p.id!)));

  /** "Add your own": written by the owner, so active at once. */
  route("POST", "/api/apps/:id/memory/items", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const b = await body(req);
    const kind = String(b.kind ?? "") as MemoryKind;
    if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw httpError(400, `kind must be one of ${MEMORY_KINDS.join(", ")}.`);
    const who = (await h.actorName(t)) ?? "the owner";
    const item = await change(app, (d) => {
      const r = addItem(d, { kind, text: String(b.text ?? ""), source: { kind: "owner_comment", ref: { type: "memory", id: "memory", label: "What day2 knows" } }, who, scope: scopeOf(b.scope) ?? [], keys: Array.isArray(b.keys) ? (b.keys as string[]) : [] }, new Date());
      return { doc: r.doc, result: r.item };
    });
    return respond(app, { created: item.id });
  });

  route("PATCH", "/api/apps/:id/memory/items/:mid", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const b = await body(req);
    const patch: ItemPatch = {};
    if (typeof b.text === "string") patch.text = b.text;
    if (typeof b.kind === "string") patch.kind = b.kind as MemoryKind;
    const scope = scopeOf(b.scope);
    if (scope) patch.scope = scope;
    if (Array.isArray(b.keys)) patch.keys = b.keys as string[];
    const who = (await h.actorName(t)) ?? "the owner";
    await change(app, (d) => {
      const r = editItem(d, p.mid!, patch, who, new Date());
      return { doc: r.doc, result: null };
    });
    return respond(app);
  });

  route("POST", "/api/apps/:id/memory/items/:mid/:action", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    if (p.action !== "confirm" && p.action !== "retire" && p.action !== "restore") throw httpError(404, "Unknown action.");
    await change(app, (d) => {
      const r = setStatus(d, p.mid!, p.action === "retire" ? "retired" : "active", new Date());
      return { doc: r.doc, result: null };
    });
    return respond(app);
  });

  /** Lift a decline's 90-day block ("you may propose this again"). */
  route("POST", "/api/apps/:id/memory/declines/lift", async (req, p, t) => {
    const app = await requireApp(t, p.id!);
    const key = String((await body(req)).key ?? "");
    await change(app, (d) => ({ doc: { ...d, declines: d.declines.filter((x) => x.key !== key) }, result: null }));
    return respond(app);
  });

  /** Distill what's waiting now instead of within the hour. */
  route("POST", "/api/apps/:id/memory/capture", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    const run: CreditRunner = (service, description, max, fn) => h.runWithCredits(t, app, service, description, max, fn);
    const r = await captureMemory(app, run, { force: true });
    return respond(app, { ran: r.ran, added: r.added, credits: r.credits });
  });
}
