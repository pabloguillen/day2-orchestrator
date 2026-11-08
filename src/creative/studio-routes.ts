import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { assetStore, type Tenant } from "../tenant";
import { dataDir } from "../day2-paths";
import { decryptSecret, encryptSecret } from "../secrets";
import { fallbackShotList } from "./art-director";
import { cleanOverrides, ensureBrandKit, extractBrandKit, loadBrandKit, resolveKit, saveBrandKit } from "./brand-kit";
import { capturePlan } from "./capture";
import { fetchFigmaTokens, figmaFileKey } from "./figma";
import { renderStill } from "./motion/engine";
import { renderSlideComposition } from "./render";
import { BROLL_PURPOSE, brollFor, screensFor } from "./runtime";
import { loadCreativeState, preferenceLines, templateLiking } from "./taste";
import { CURRENT_RUBRIC } from "./taste";
import { TEMPLATE_LIST, TEMPLATES } from "./templates";
import { isTemplateId } from "./templates/types";
import { profileOf, languageOf } from "../social/runtime";
import { refreshAppLinks } from "../ads/app-links";
import { appKind } from "../field-work";
import { approveCast, realScreensView, startBackend, startCapture, startCast } from "./real-screens";
import { loadUploadSet, removeUploadSet, saveUploadSet, uploadFile, UploadError, UPLOAD } from "./upload";
import { appVersion } from "./capture";
import { CAST_PURPOSE } from "./demo-cast/images";

/**
 * Growth → Formats (/api/apps/:id/creative/*): the app's brand kit (read
 * from its repo, editable), the template gallery with sample renders in the
 * app's own look, where its screens come from, the owner's clips (b-roll),
 * an optional Figma file, and what day2 learned about the owner's taste.
 * Every route is scoped to an app of the signed-in account; changes need an
 * owner or admin. The Figma token is stored encrypted and never returned.
 */

type Handler = (req: Request, params: Record<string, string>, t: Tenant) => Promise<Response> | Response;
export type CreativeRouteHelpers = {
  json: (data: unknown, init?: ResponseInit) => Response;
  requireApp: (t: Tenant, id: string) => Promise<AppEntry>;
  requireManager: (t: Tenant) => void;
  actorName: (t: Tenant) => Promise<string | undefined>;
  httpError: (status: number, message: string) => Error;
  serveFile: (req: Request, path: string, mime: string, cache: string) => Response;
};

const samplesDir = (appId: string) => join(dataDir(), "creative-samples", appId.replace(/[^\w-]/g, "_"));
const FIGMA_FILE = (appId: string) => join(dataDir(), "creative-figma", `${appId.replace(/[^\w-]/g, "_")}.json`);
const MAX_BROLL_BYTES = 60 * 1024 * 1024;
const BROLL_MIME: Record<string, "video" | "image"> = { "video/mp4": "video", "video/quicktime": "video", "image/jpeg": "image", "image/png": "image" };

async function creativeView(app: AppEntry, t: Tenant) {
  const stored = ensureBrandKit(app.repoPath);
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const kit = resolveKit(stored, { repoPath: app.repoPath, appName: app.name, dna: profile?.brand ?? null });
  const state = loadCreativeState(app.repoPath);
  const liking = templateLiking(state);
  const samples = existsSync(samplesDir(app.id)) ? readdirSync(samplesDir(app.id)) : [];
  const links = appKind(app.repoPath) === "react-native" ? await refreshAppLinks(app.repoPath, new Date()).catch(() => null) : null;
  const screens = await screensFor(app, language, { links }).catch(() => null);
  const plan = capturePlan({ repoPath: app.repoPath, language, features: profile?.featureMap ?? [] });
  const broll = await assetStore().list(app.id, BROLL_PURPOSE).catch(() => []);
  const figma = loadFigma(app.id);
  const ex = stored.extracted;
  return {
    brandKit: {
      extractedAt: ex?.extractedAt ?? null,
      sources: ex?.sources ?? [],
      colors: { primary: kit.primary, accent: kit.accent, ink: kit.ink, background: kit.background, surface: kit.surface, palette: (ex?.colors.palette ?? []).slice(0, 12) },
      fonts: { display: `${kit.displayFont.family} ${kit.displayFont.weight}`, body: `${kit.bodyFont.family} ${kit.bodyFont.weight}`, families: ex?.fonts.families ?? [], embedded: Boolean(kit.displayFont.file) },
      radius: kit.radius,
      icon: kit.icon ? `/api/apps/${encodeURIComponent(app.id)}/creative/icon` : null,
      stickers: Object.keys(kit.stickers).slice(0, 30),
      style: ex?.style ?? null,
      copy: { language: kit.language, tone: kit.tone, samples: (ex?.copy.samples ?? []).slice(0, 8) },
      overrides: stored.overrides,
      figma: figma ? { fileKey: figma.fileKey, fetchedAt: stored.figma?.fetchedAt ?? null, colors: stored.figma?.colors.length ?? 0, fonts: stored.figma?.fonts.length ?? 0 } : null,
    },
    screens: screens ? { source: screens.source, count: screens.screens.length, warning: screens.warning, stale: Boolean(screens.stale), aiContent: screens.aiContent ?? null, plan: { locale: plan.locale, flow: plan.flow, moments: plan.moments, version: plan.version } } : null,
    real: await realScreensView(t, app),
    templates: TEMPLATE_LIST().map((t) => ({ id: t.id, label: t.label, description: t.description, bestFor: t.bestFor, outputs: t.outputs, liking: Math.round(liking[t.id] * 100) / 100, sample: samples.includes(`${t.id}.jpg`) ? `/api/apps/${encodeURIComponent(app.id)}/creative/samples/${t.id}.jpg?v=${Math.round(statSync(join(samplesDir(app.id), `${t.id}.jpg`)).mtimeMs)}` : null, tally: state.templates[t.id] ?? null })),
    broll: broll.map((a) => ({ id: a.id, kind: a.kind, label: a.label, durationSec: a.durationSec ?? null, url: `/api/apps/${encodeURIComponent(app.id)}/social/media/${encodeURIComponent(a.id)}` })),
    taste: { rubricVersion: CURRENT_RUBRIC, preferences: preferenceLines(state), howItWorksAt: state.howItWorksAt, log: state.log.slice(0, 10) },
  };
}

function loadFigma(appId: string): { fileKey: string; token: string } | null {
  const p = FIGMA_FILE(appId);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as { fileKey: string; sealed: string };
    return { fileKey: j.fileKey, token: decryptSecret(j.sealed, `figma:${appId}`) };
  } catch {
    return null;
  }
}

/** Sample renders of every template in the app's own look (one still each). */
export async function renderSamples(app: AppEntry): Promise<string[]> {
  const profile = profileOf(app);
  const language = languageOf(app, profile);
  const stored = ensureBrandKit(app.repoPath);
  const kit = resolveKit(stored, { repoPath: app.repoPath, appName: app.name, dna: profile?.brand ?? null });
  kit.language = language;
  const links = appKind(app.repoPath) === "react-native" ? await refreshAppLinks(app.repoPath, new Date()).catch(() => null) : null;
  const screens = await screensFor(app, language, { links });
  if (!screens.screens.length) throw new Error("day2 has no screens of the app yet — capture or upload them first (Screens, above).");
  const broll = await brollFor(app.id, assetStore());
  const dir = samplesDir(app.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(tmpdir(), `day2-samples-${app.id}-${Date.now()}`);
  const made: string[] = [];
  const features = profile?.featureMap ?? [];
  try {
    for (const t of TEMPLATE_LIST()) {
      const shots = fallbackShotList({ idea: { title: features[0]?.split(/\s+/).slice(0, 6).join(" ") ?? app.name, lines: features.slice(0, 4), topic: "feature", hook: "feature_demo", cta: "" }, template: t.id, screens: screens.screens, language, kit });
      const input = { shots, kit, screens: screens.screens, broll };
      const out = join(dir, `${t.id}.jpg`);
      if (t.slides) {
        const r = await renderSlideComposition(t.slides(input, "4:5"), { dir: tmp, name: t.id });
        writeFileSync(out, readFileSync(r.files[0]!));
      } else if (t.video) {
        const comp = t.video(input);
        await renderStill({ html: comp.html, W: comp.W, H: comp.H, t: comp.sampleTimes[0] ?? 1, out });
      }
      made.push(t.id);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return made;
}

export function registerCreativeRoutes(route: (method: string, pathname: string, handler: Handler) => void, h: CreativeRouteHelpers): void {
  const fail = h.httpError;

  route("GET", "/api/apps/:id/creative", async (_req, p, t) => h.json(await creativeView(await h.requireApp(t, p.id!), t)));

  // ---- Real screens (docs/creative-quality.md): demo cast, demo backend, captures, uploads ----

  /** Write a (new) demo cast with pictures — in the background; the view shows the job. */
  route("POST", "/api/apps/:id/creative/demo-cast", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    startCast(t, app);
    return h.json(await creativeView(app, t), { status: 202 });
  });

  /** The owner approves the cast; only an approved cast goes into the demo backend. */
  route("POST", "/api/apps/:id/creative/demo-cast/approve", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    try {
      await approveCast(app, (await h.actorName(t)) ?? null);
    } catch (err) {
      throw fail(409, (err as Error).message);
    }
    return h.json(await creativeView(app, t));
  });

  /** A demo cast picture — only this app's "demo-cast" assets, signed in. */
  route("GET", "/api/apps/:id/creative/demo-cast/images/:asset", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    const a = await assetStore().get(p.asset ?? "").catch(() => null);
    if (!a || a.appId !== app.id || a.purpose !== CAST_PURPOSE || !existsSync(a.path)) throw fail(404, "Not found.");
    return h.serveFile(req, a.path, a.mime, "private, max-age=600");
  });

  /** Create (once) and fill the separate demo backend, then ask for the flow — in the background. */
  route("POST", "/api/apps/:id/creative/demo-backend", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    startBackend(t, app);
    return h.json(await creativeView(app, t), { status: 202 });
  });

  /** Capture screens now (on this Mac's simulator or on EAS) — in the background. */
  route("POST", "/api/apps/:id/creative/capture", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    startCapture(t, app, "button");
    return h.json(await creativeView(app, t), { status: 202 });
  });

  /** The owner's screenshots for one language (multipart: language + 3–8 files). */
  route("POST", "/api/apps/:id/creative/screens", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > UPLOAD.maxTotal + 1024 * 1024) throw fail(413, "Together the screenshots are over 60 MB.");
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw fail(400, "Send the screenshots as a form (language and files).");
    }
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const v of form.getAll("files")) if (typeof v !== "string") files.push({ name: (v as File).name ?? "screenshot", bytes: new Uint8Array(await (v as Blob).arrayBuffer()) });
    try {
      saveUploadSet(app.id, String(form.get("language") ?? "").trim().toLowerCase(), files, { version: appVersion(app.repoPath), by: (await h.actorName(t)) ?? null });
    } catch (err) {
      if (err instanceof UploadError) throw fail(err.status, err.message);
      throw err;
    }
    return h.json(await creativeView(app, t));
  });

  route("DELETE", "/api/apps/:id/creative/screens/:locale", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    if (!loadUploadSet(app.id, p.locale ?? "")) throw fail(404, "No screenshots for that language.");
    removeUploadSet(app.id, p.locale!);
    return h.json(await creativeView(app, t));
  });

  route("GET", "/api/apps/:id/creative/screens/:locale/:file", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    const f = uploadFile(app.id, p.locale ?? "", p.file ?? "");
    if (!f) throw fail(404, "Not found.");
    return h.serveFile(req, f, "image/png", "private, max-age=600");
  });

  /** The owner's edits to the brand kit (colours, fonts, language, tone, notes). */
  route("PUT", "/api/apps/:id/creative/brand-kit", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const cur = ensureBrandKit(app.repoPath);
    saveBrandKit(app.repoPath, { ...cur, overrides: cleanOverrides(b.overrides ?? b), updatedAt: new Date().toISOString(), updatedBy: (await h.actorName(t)) ?? null });
    return h.json(await creativeView(app, t));
  });

  /** Read the design language from the repo again (after a redesign). Owner edits stay. */
  route("POST", "/api/apps/:id/creative/brand-kit/refresh", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const cur = loadBrandKit(app.repoPath);
    saveBrandKit(app.repoPath, { extracted: extractBrandKit(app.repoPath), overrides: cur?.overrides ?? {}, figma: cur?.figma ?? null, updatedAt: new Date().toISOString(), updatedBy: (await h.actorName(t)) ?? null });
    return h.json(await creativeView(app, t));
  });

  /** The app icon (end cards), for the console. */
  route("GET", "/api/apps/:id/creative/icon", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    const kit = resolveKit(loadBrandKit(app.repoPath), { repoPath: app.repoPath, appName: app.name });
    if (!kit.icon || !existsSync(kit.icon)) throw fail(404, "No icon.");
    return h.serveFile(req, kit.icon, "image/png", "private, max-age=3600");
  });

  /** Renders a sample of every template in the app's look (takes ~30 s). */
  route("POST", "/api/apps/:id/creative/samples", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    try {
      await renderSamples(app);
    } catch (err) {
      throw fail(409, (err as Error).message.slice(0, 200));
    }
    return h.json(await creativeView(app, t));
  });

  route("GET", "/api/apps/:id/creative/samples/:file", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    const id = (p.file ?? "").replace(/\.jpg$/, "");
    if (!isTemplateId(id)) throw fail(404, "Not found.");
    const f = join(samplesDir(app.id), `${id}.jpg`);
    if (!existsSync(f)) throw fail(404, "Not found.");
    return h.serveFile(req, f, "image/jpeg", "private, max-age=600");
  });

  /** The owner's own clips and photos for POV posts (raw body, ≤ 60 MB, mp4/mov/jpeg/png). */
  route("POST", "/api/apps/:id/creative/broll", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const mime = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const kind = BROLL_MIME[mime];
    if (!kind) throw fail(415, "Upload an MP4 or MOV video, or a JPEG or PNG photo.");
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BROLL_BYTES) throw fail(413, "That file is over 60 MB.");
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.byteLength || buf.byteLength > MAX_BROLL_BYTES) throw fail(413, "That file is empty or over 60 MB.");
    const name = (req.headers.get("x-file-name") ?? "clip").replace(/[^\w .-]/g, "").slice(0, 60) || "clip";
    const tmp = join(tmpdir(), `day2-broll-${Date.now()}${mime === "image/png" ? ".png" : mime.startsWith("image") ? ".jpg" : ".mp4"}`);
    writeFileSync(tmp, buf);
    const outMime = mime === "video/quicktime" ? "video/mp4" : mime;
    await assetStore().put(tmp, { appId: app.id, purpose: BROLL_PURPOSE, label: name, kind, ratio: "9:16", width: 1080, height: 1920, mime: outMime, source: "upload", aiGenerated: false, aiPerson: false });
    rmSync(tmp, { force: true });
    return h.json(await creativeView(app, t));
  });

  /** Connect a Figma file (optional): its colour and text styles join the brand kit. The token is stored encrypted, never shown again. */
  route("PUT", "/api/apps/:id/creative/figma", async (req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    const b = (await req.json().catch(() => ({}))) as { fileUrl?: string; token?: string };
    const key = typeof b.fileUrl === "string" ? figmaFileKey(b.fileUrl.trim()) : null;
    if (!key) throw fail(400, "Paste the Figma file's link (figma.com/design/…).");
    const token = typeof b.token === "string" ? b.token.trim() : loadFigma(app.id)?.token;
    if (!token || token.length < 20 || token.length > 200) throw fail(400, "Paste a Figma personal access token (read access to file content).");
    let tokens;
    try {
      tokens = await fetchFigmaTokens(key, token);
    } catch (err) {
      throw fail(502, (err as Error).message.slice(0, 160));
    }
    mkdirSync(join(dataDir(), "creative-figma"), { recursive: true });
    writeFileSync(FIGMA_FILE(app.id), JSON.stringify({ fileKey: key, sealed: encryptSecret(token, `figma:${app.id}`) }), { mode: 0o600 });
    const cur = ensureBrandKit(app.repoPath);
    saveBrandKit(app.repoPath, { ...cur, figma: tokens, updatedAt: new Date().toISOString(), updatedBy: (await h.actorName(t)) ?? null });
    return h.json(await creativeView(app, t));
  });

  route("DELETE", "/api/apps/:id/creative/figma", async (_req, p, t) => {
    const app = await h.requireApp(t, p.id!);
    h.requireManager(t);
    rmSync(FIGMA_FILE(app.id), { force: true });
    const cur = ensureBrandKit(app.repoPath);
    saveBrandKit(app.repoPath, { ...cur, figma: null, updatedAt: new Date().toISOString() });
    return h.json(await creativeView(app, t));
  });
}

export { TEMPLATES };
