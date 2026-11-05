import type { AppEntry } from "../apps-registry";
import { appKind } from "../field-work";
import { deviceMode } from "../device-checks";
import { encryptSecret, hasSecretsKey } from "../secrets";
import type { Tenant } from "../tenant";
import { demoContext, makingPreviews, storeDeps } from "./deps";
import type { RouteKit } from "./routes";
import type { Paid } from "./service";
import { countByStatus, decideFact, guidedVersion, setupItems, setupPass, type ChecklistContext } from "./setup";
import { setupFilePath } from "./setup-assets";
import { FACT_KEYS, type FactKey, type GuidedKey } from "./setup-types";

/**
 * /api/apps/:id/store/setup/* — the Store page's Setup tab: the checklist
 * per store, approving facts (optionally edited), confirming guided steps,
 * approving graphics, the App Review demo account (write-only), and a pass
 * on demand.
 */

const GUIDED: GuidedKey[] = ["ios.privacy", "ios.ageRating", "android.dataSafety", "android.contentRating", "android.targetAudience", "android.ads", "android.appAccess", "android.declarations", "android.category"];
const inRequest: Paid = async (_s, _l, _m, fn) => ({ result: await fn(), credits: 0 });

export async function setupView(app: AppEntry, t: Tenant) {
  const d = await storeDeps(t, app);
  const f = await d.store.load(app.id);
  const s = d.setup!;
  const [privacy, practices] = await Promise.all([s.privacy().catch(() => []), s.practices().catch(() => ({ ads: false, purchases: false }))]);
  const ctx: ChecklistContext = {
    appId: app.id,
    appName: d.appName,
    repoPath: app.repoPath,
    ids: d.ids,
    connected: { ios: Boolean(s.asc), android: Boolean(s.play) },
    privacy,
    practices,
    canRecord: deviceMode() === "local" && process.platform === "darwin",
    fileUrl: (file) => `/api/apps/${encodeURIComponent(app.id)}/store/setup/files/${encodeURIComponent(file)}`,
  };
  const items = setupItems(f, ctx);
  const stores = (["ios", "android"] as const).filter((x) => (x === "ios" ? d.ids.bundleId : d.ids.packageName)).map((store) => ({ store, connected: ctx.connected[store], items: items[store], counts: countByStatus(items[store]) }));
  return { stores, lastPassAt: f.setup.lastPassAt, recording: makingPreviews(app.id), ctx };
}

const publicView = async (app: AppEntry, t: Tenant) => {
  const { ctx: _ctx, ...v } = await setupView(app, t);
  return v;
};

const body = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, unknown>;

export function registerSetupRoutes(k: RouteKit): void {
  const { route, json, requireApp, requireManager, httpError } = k;
  const storeApp = async (t: Tenant, id: string) => {
    const app = await requireApp(t, id);
    if (appKind(app.repoPath) !== "react-native") throw httpError(409, "Only apps in the App Store and Google Play have a store setup.");
    return app;
  };
  const who = async (t: Tenant) => (await k.actorName(t)) ?? null;

  route("GET", "/api/apps/:id/store/setup", async (_req, p, t) => json(await publicView(await storeApp(t, p.id!), t)));

  /** A setup pass now: work out the answers (once), propose what's missing, write what's approved, read back. */
  route("POST", "/api/apps/:id/store/setup/run", async (_req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const d = (await storeDeps(t, app)).setup!;
    const { result } = await k.runWithCredits(t, app, "agent_work", "Store setup", 1, () => setupPass({ ...d, paid: inRequest }, { force: true }));
    return json({ ...(await publicView(app, t)), report: result });
  });

  /** Save a fact (as proposed, or edited) and approve it; or just save edits. */
  route("POST", "/api/apps/:id/store/setup/facts/:key", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    if (!FACT_KEYS.includes(p.key as FactKey)) throw httpError(404, "No such setup item.");
    const b = await body(req);
    const d = (await storeDeps(t, app)).setup!;
    const by = await who(t);
    await d.store.update(app.id, (f) => {
      try {
        return { file: decideFact(f, p.key as FactKey, { value: b.value && typeof b.value === "object" ? (b.value as Record<string, unknown>) : {}, approve: b.approve !== false, by, now: new Date() }), result: null };
      } catch (err) {
        throw httpError(400, (err as Error).message);
      }
    });
    if (b.approve !== false) await setupPass(d, { force: true }).catch(() => null);
    return json(await publicView(app, t));
  });

  /** The owner did a guided step (for the answers day2 showed). */
  route("POST", "/api/apps/:id/store/setup/steps/:key", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const key = p.key as GuidedKey;
    if (!GUIDED.includes(key)) throw httpError(404, "No such step.");
    const b = await body(req);
    const v = await setupView(app, t);
    const d = (await storeDeps(t, app)).setup!;
    const by = await who(t);
    if (key === "ios.privacy" || key === "android.dataSafety") throw httpError(409, "Confirm the privacy answers on the Privacy page — day2 keeps them there.");
    await d.store.update(app.id, (f) => {
      const version = guidedVersion(f, v.ctx, key);
      if (!version) throw httpError(409, "There's nothing to do for this step right now.");
      if (b.done === false) delete f.setup.confirmed[key];
      else {
        f.setup.confirmed[key] = { version, at: new Date().toISOString(), by };
        f.log.push({ at: new Date().toISOString(), text: `Store setup: ${by ?? "you"} did "${key.split(".")[1]}" in ${key.startsWith("ios") ? "App Store Connect" : "the Play Console"}.` });
      }
      return { file: f, result: null };
    });
    return json(await publicView(app, t));
  });

  /** Approve or discard a graphic or preview day2 made. */
  route("POST", "/api/apps/:id/store/setup/graphics/:gid", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const d = (await storeDeps(t, app)).setup!;
    await d.store.update(app.id, (f) => {
      const g = f.setup.graphics.find((x) => x.id === p.gid);
      if (!g) throw httpError(404, "No such picture.");
      if (g.status !== "draft") throw httpError(409, `This one is already ${g.status}.`);
      if (b.approve === true) g.status = "approved";
      else f.setup.graphics = f.setup.graphics.filter((x) => x.id !== g.id);
      return { file: f, result: null };
    });
    if (b.approve === true) await setupPass(d, { force: true }).catch(() => null);
    return json(await publicView(app, t));
  });

  /** The App Review demo account: stored encrypted, never returned. */
  route("PUT", "/api/apps/:id/store/setup/demo", async (req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const b = await body(req);
    const username = typeof b.username === "string" ? b.username.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!username || !password) throw httpError(400, "Enter the demo account's username and password.");
    if (username.length > 200 || password.length > 200) throw httpError(400, "That's longer than App Store Connect takes.");
    if (!hasSecretsKey()) throw httpError(409, "This server has no key to encrypt secrets with (DAY2_SECRETS_KEY) — see docs/deploying.md.");
    const d = (await storeDeps(t, app)).setup!;
    const by = await who(t);
    await d.store.update(app.id, (f) => {
      f.setup.demo = { secret: encryptSecret(JSON.stringify({ username, password }), demoContext(app.id)), label: "Demo account saved", setAt: new Date().toISOString(), setBy: by };
      f.log.push({ at: new Date().toISOString(), text: `Store setup: ${by ?? "you"} saved the App Review demo account.` });
      return { file: f, result: null };
    });
    await setupPass(d, { force: true }).catch(() => null);
    return json(await publicView(app, t));
  });

  route("DELETE", "/api/apps/:id/store/setup/demo", async (_req, p, t) => {
    const app = await storeApp(t, p.id!);
    requireManager(t);
    const d = (await storeDeps(t, app)).setup!;
    await d.store.update(app.id, (f) => {
      f.setup.demo = null;
      return { file: f, result: null };
    });
    return json(await publicView(app, t));
  });

  route("GET", "/api/apps/:id/store/setup/files/:file", async (_req, p, t) => {
    const app = await requireApp(t, p.id!);
    const path = setupFilePath(app.id, p.file!);
    if (!path) throw httpError(404, "Not found.");
    const type = path.endsWith(".mp4") ? "video/mp4" : path.endsWith(".jpg") ? "image/jpeg" : "image/png";
    return new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
  });
}
