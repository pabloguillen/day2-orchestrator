import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Browser } from "playwright";
import { dataUri, esc, textOn, withBrowser } from "../ads/content";
import { dataDir } from "../day2-paths";
import { has, runCmd, tail } from "../device-checks/run-cmd";
import type { Target } from "../device-checks/targets";
import { FLOW_PATH, runMaestro, type FrameStyle } from "./screenshots";

/**
 * Store setup's pictures and video:
 *
 *  - the App Store icon comes from the build, so day2 checks the app
 *    config's icon instead: a 1024×1024 PNG without an alpha channel;
 *  - Google Play's hi-res icon (512×512 PNG, from the app icon) and feature
 *    graphic (1024×500, the brand's colors, the app name and its promise) —
 *    HTML pages rendered by Chromium with every web request blocked, like
 *    the screenshots;
 *  - App Store app previews: the iPhone Simulator records the screen
 *    (`xcrun simctl io <udid> recordVideo`) while a Maestro flow walks
 *    through the app, then ffmpeg trims it to 15–30 s and encodes it the way
 *    Apple asks (H.264 High ≤ 4.0, 30 fps, 886×1920, stereo AAC 256 kbps).
 */

export const setupDir = (appId: string) => join(dataDir(), "store-setup", appId.replace(/[^\w-]/g, "_"));

/** A setup file (graphic or preview) by name, only from day2's folder. */
export function setupFilePath(appId: string, name: string): string | null {
  if (!/^[\w.-]+\.(png|jpg|mp4)$/.test(name)) return null;
  const p = join(setupDir(appId), name);
  return existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// The app icon
// ---------------------------------------------------------------------------

/** Pure. A PNG's size and whether it can hold transparency (alpha channel or tRNS chunk). Null when it isn't a PNG. */
export function pngInfo(bytes: Uint8Array): { width: number; height: number; alpha: boolean } | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = bytes[25]!;
  let alpha = colorType === 4 || colorType === 6;
  let off = 8;
  while (!alpha && off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (type === "tRNS") alpha = true;
    if (type === "IDAT" || type === "IEND") break;
    off += 12 + len;
  }
  return { width, height, alpha };
}

/** The icon the app config names (ios.icon first, then icon), as a path in the repo. */
export function appIconPath(repoPath: string): string | null {
  try {
    const j = JSON.parse(readFileSync(join(repoPath, "app.json"), "utf-8")) as { expo?: Record<string, unknown> } & Record<string, unknown>;
    const expo = (j.expo ?? j) as { icon?: string; ios?: { icon?: string | { light?: string } } };
    const ios = typeof expo.ios?.icon === "string" ? expo.ios.icon : expo.ios?.icon?.light;
    const rel = ios ?? expo.icon;
    return rel ? resolve(repoPath, rel) : null;
  } catch {
    return null;
  }
}

export type IconCheck = { ok: boolean; path: string | null; problems: string[] };

/** Apple's rule for the App Store icon: 1024×1024 PNG, no transparency. */
export function checkAppIcon(repoPath: string): IconCheck {
  const path = appIconPath(repoPath);
  if (!path) return { ok: false, path: null, problems: ["The app config (app.json) names no icon."] };
  if (!existsSync(path)) return { ok: false, path, problems: [`The icon file ${basename(path)} isn't in the repository.`] };
  const info = pngInfo(new Uint8Array(readFileSync(path)));
  if (!info) return { ok: false, path, problems: [`${basename(path)} isn't a PNG.`] };
  const problems: string[] = [];
  if (info.width !== 1024 || info.height !== 1024) problems.push(`It's ${info.width}×${info.height}; the App Store needs 1024×1024.`);
  if (info.alpha) problems.push("It has an alpha channel (transparency); the App Store needs an icon without one.");
  return { ok: problems.length === 0, path, problems };
}

export function iconTicket(check: IconCheck) {
  return {
    title: "App icon: 1024×1024 PNG without transparency",
    type: "task" as const,
    description: [
      "The App Store takes the app icon from the build. Apple rejects icons that aren't 1024×1024 or that have an alpha channel.",
      "",
      ...check.problems.map((p) => `- ${p}`),
      "",
      `Fix the icon the app config points to${check.path ? ` (${basename(check.path)})` : ""}: export it again at 1024×1024 as a PNG with no alpha channel (flatten it onto the background colour; keep the same artwork). Keep the Android adaptive icon as it is.`,
    ].join("\n"),
    doneWhen: ["app.json's icon is a 1024×1024 PNG", "The PNG has no alpha channel", "The app builds"],
    priority: 2 as const,
    prioritySource: "day2" as const,
    source: { kind: "day2_proposal" as const, key: "store-setup:icon" },
    actor: "day2" as const,
    createdNote: "Store setup: the App Store icon check.",
  };
}

// ---------------------------------------------------------------------------
// Google Play graphics
// ---------------------------------------------------------------------------

export const PLAY_ICON = { width: 512, height: 512 };
export const FEATURE_GRAPHIC = { width: 1024, height: 500 };

/** Pure. The hi-res icon: the app icon, scaled to 512×512 (Google adds the rounded mask itself). */
export function playIconHtml(icon: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:512px;height:512px;overflow:hidden;background:transparent}img{width:512px;height:512px;display:block}</style></head><body><img src="${icon}" alt=""></body></html>`;
}

/** Pure. The feature graphic: brand background, the icon, the app's name and promise. No text near the edges (Google crops on some surfaces). */
export function featureGraphicHtml(o: { name: string; tagline: string; style: FrameStyle; icon: string | null }): string {
  const fg = textOn(o.style.background);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1024px;height:500px;overflow:hidden;background:${o.style.background}}
.wrap{position:absolute;inset:0;display:flex;align-items:center;gap:56px;padding:0 96px}
.icon{width:220px;height:220px;border-radius:48px;overflow:hidden;flex:none;box-shadow:0 18px 48px rgba(0,0,0,.25);outline:6px solid ${o.style.accent}}
.icon img{width:100%;height:100%;display:block}
.name{color:${fg};font:800 68px/1.05 ${o.style.font};letter-spacing:-0.02em}
.tag{color:${fg};opacity:.85;font:500 34px/1.25 ${o.style.font};margin-top:18px;max-width:560px}
</style></head><body><div class="wrap">${o.icon ? `<div class="icon"><img src="${o.icon}" alt=""></div>` : ""}<div><div class="name">${esc(o.name)}</div>${o.tagline ? `<div class="tag">${esc(o.tagline)}</div>` : ""}</div></div></body></html>`;
}

/** Renders a page to an image of exactly its size (PNG keeps transparency; JPEG has none — Google wants the feature graphic without alpha). */
export async function renderGraphic(html: string, size: { width: number; height: number }, out: string, type: "png" | "jpeg", browser?: Browser): Promise<string> {
  return withBrowser(async (b) => {
    const page = await b.newPage({ viewport: size, deviceScaleFactor: 1 });
    await page.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.screenshot({ path: out, type, ...(type === "jpeg" ? { quality: 92 } : { omitBackground: true }) });
    await page.close();
    return out;
  }, browser);
}

export type GraphicsInput = { appId: string; name: string; tagline: string; style: FrameStyle; iconPath: string | null; render?: typeof renderGraphic };

/** Makes the Play icon and feature graphic; returns their file names in the setup folder. */
export async function makePlayGraphics(o: GraphicsInput, kinds: Array<"playIcon" | "featureGraphic">): Promise<Partial<Record<"playIcon" | "featureGraphic", string>>> {
  const dir = setupDir(o.appId);
  mkdirSync(dir, { recursive: true });
  const render = o.render ?? renderGraphic;
  const icon = o.iconPath ? dataUri(o.iconPath) : null;
  const stamp = Date.now().toString(36);
  const out: Partial<Record<"playIcon" | "featureGraphic", string>> = {};
  if (kinds.includes("playIcon") && icon) out.playIcon = basename(await render(playIconHtml(icon), PLAY_ICON, join(dir, `play-icon-${stamp}.png`), "png"));
  if (kinds.includes("featureGraphic")) out.featureGraphic = basename(await render(featureGraphicHtml({ name: o.name, tagline: o.tagline, style: o.style, icon }), FEATURE_GRAPHIC, join(dir, `feature-graphic-${stamp}.jpg`), "jpeg"));
  return out;
}

// ---------------------------------------------------------------------------
// App previews (App Store video)
// ---------------------------------------------------------------------------

/**
 * Apple's preview types day2 fills, and the resolution each takes (App
 * Store Connect Help → App preview specifications). One recording on an
 * iPhone serves both iPhone sizes: both accept 886×1920 portrait.
 */
export const PREVIEW_TYPES = [
  { previewType: "IPHONE_67", label: 'iPhone 6.9"', width: 886, height: 1920 },
  { previewType: "IPHONE_65", label: 'iPhone 6.5"', width: 886, height: 1920 },
];
export const PREVIEW_MIN_SEC = 15;
export const PREVIEW_MAX_SEC = 30;
/** The flow for the preview: its own, if the app has one, else the screenshot flow. */
export const PREVIEW_FLOW_PATH = ".maestro/day2/store-preview.yaml";

/** Pure. Which part of a recording to keep: skip the launch second, at most 30 s; null when it's too short. */
export function trimWindow(totalSec: number): { start: number; duration: number } | null {
  const start = totalSec - 1 >= PREVIEW_MIN_SEC ? 1 : 0;
  const duration = Math.min(PREVIEW_MAX_SEC, totalSec - start);
  return duration >= PREVIEW_MIN_SEC ? { start, duration: Math.floor(duration * 10) / 10 } : null;
}

/** Pure. The ffmpeg command for Apple's preview spec, with a silent stereo track (previews need audio tracks to be valid stereo AAC). */
export function ffmpegArgs(o: { input: string; output: string; start: number; duration: number; width: number; height: number; pad: string }): string[] {
  const vf = `fps=30,scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=${o.pad.replace("#", "0x")},setsar=1,format=yuv420p`;
  return [
    "ffmpeg", "-y", "-ss", String(o.start), "-t", String(o.duration), "-i", o.input,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-map", "0:v:0", "-map", "1:a:0", "-vf", vf,
    "-c:v", "libx264", "-profile:v", "high", "-level", "4.0", "-b:v", "10M", "-maxrate", "12M", "-bufsize", "20M", "-r", "30",
    "-c:a", "aac", "-b:a", "256k", "-ar", "44100", "-ac", "2", "-shortest", "-movflags", "+faststart", o.output,
  ];
}

export type PreviewDeps = {
  target: () => Promise<Target | { skip: string }>;
  /** Starts recording the simulator's screen; the returned function stops it and waits for the file. */
  record?: (udid: string, file: string) => Promise<() => Promise<void>>;
  runFlow?: typeof runMaestro;
  run?: typeof runCmd;
  has?: (bin: string) => boolean;
  log?: (t: string) => void;
};

/** `xcrun simctl io <udid> recordVideo` until stopped (SIGINT makes it finish the file). */
export async function recordSimulator(udid: string, file: string): Promise<() => Promise<void>> {
  const proc = Bun.spawn(["xcrun", "simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file], { stdout: "ignore", stderr: "pipe" });
  await Bun.sleep(1500); // recordVideo needs a moment before frames arrive
  return async () => {
    proc.kill("SIGINT");
    await Promise.race([proc.exited, Bun.sleep(15_000)]);
  };
}

/**
 * Records one app preview: the app built and installed on the iPhone
 * Simulator, the screen recorded while the flow runs (in the locale), then
 * trimmed and encoded. Returns the encoded file, or why it couldn't.
 */
export async function recordPreview(o: { cwd: string; bundleId: string; locale: string; outDir: string; pad: string }, deps: PreviewDeps): Promise<{ file: string } | { error: string }> {
  const hasBin = deps.has ?? has;
  const run = deps.run ?? runCmd;
  if (!hasBin("ffmpeg")) return { error: "ffmpeg isn't installed on this computer (brew install ffmpeg) — day2 needs it to encode the preview the way Apple asks." };
  const flow = [PREVIEW_FLOW_PATH, FLOW_PATH].map((p) => join(o.cwd, p)).find((p) => existsSync(p));
  if (!flow) return { error: `the app has no flow to record (${FLOW_PATH}).` };
  const t = await deps.target();
  if ("skip" in t) return { error: t.skip };
  deps.log?.(`${t.device}: building the app for the preview…`);
  const built = await t.build(o.cwd, {});
  if ("error" in built) return { error: built.error };
  await t.uninstall();
  await t.install(built.app);
  mkdirSync(o.outDir, { recursive: true });
  const raw = join(o.outDir, `preview-raw-${o.locale}.mov`);
  const stop = await (deps.record ?? recordSimulator)(t.id, raw);
  let flowResult: { ok: boolean; why: string | null };
  try {
    flowResult = await (deps.runFlow ?? runMaestro)({ deviceId: t.id, flow, outDir: join(o.outDir, "flow", o.locale), env: { APP_ID: o.bundleId, DAY2_LOCALE: o.locale, DAY2_LOCALE_LANG: o.locale.split("-")[0]! } });
  } finally {
    await stop();
  }
  if (!flowResult.ok) return { error: flowResult.why ?? "the flow failed" };
  const probe = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", raw], { timeoutMs: 60_000 });
  const total = Number(probe.out.trim());
  if (!Number.isFinite(total) || total <= 0) return { error: `couldn't read the recording (${tail(probe.err, 2)})` };
  const win = trimWindow(total);
  if (!win) return { error: `the flow ran ${Math.round(total)} s; an App Store preview has to be 15–30 s. Make ${PREVIEW_FLOW_PATH} a little longer.` };
  const size = PREVIEW_TYPES[0]!;
  const file = join(o.outDir, `preview-${o.locale.replace(/[^\w-]/g, "")}-${Date.now().toString(36)}.mp4`);
  const enc = await run(ffmpegArgs({ input: raw, output: file, ...win, width: size.width, height: size.height, pad: o.pad }), { timeoutMs: 10 * 60_000 });
  if (enc.code !== 0) return { error: `ffmpeg couldn't encode the preview: ${tail(enc.err, 3)}` };
  return { file };
}
