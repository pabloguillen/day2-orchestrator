import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Browser } from "playwright";
import type { AppEntry } from "../apps-registry";
import type { NewTicketInput } from "../backlog";
import type { BrandDna } from "../brand-dna";
import { dataUri, esc, textOn, withBrowser } from "../ads/content";
import { dataDir } from "../day2-paths";
import { pngsIn } from "../device-checks/plan";
import { has, runCmd, tail } from "../device-checks/run-cmd";
import type { Target } from "../device-checks/targets";
import type { AppProfile } from "../onboarding";
import { afterMarker, runText } from "./research";
import type { ScreenshotShot, ScreenshotSize, StoreId } from "./types";

/**
 * Store screenshots: the app's key screens, captured on this computer's
 * iPhone Simulator / Android emulator by a Maestro flow
 * (.maestro/day2/store-screens.yaml, written by the build agent as a
 * ticket), then framed with a caption in the brand's colors — an HTML page
 * rendered by Chromium at each size the stores require, with every web
 * request blocked (the same way mockups are drawn).
 */

export const FLOW_PATH = ".maestro/day2/store-screens.yaml";
export const SCREENS_PATH = ".maestro/day2/store-screens.json";
export const FLOW_KEY = "store:screenshots-flow";
export const CAPTIONS_MAX_USD = 0.3;
const CAPTIONS = "STORE_CAPTIONS_JSON:";

/**
 * Sizes day2 makes. Apple: the 6.9" iPhone (1320×2868) and 6.5" (1284×2778)
 * portrait; the 13" iPad only for apps that support tablets. Google Play: a
 * 9:16 phone screenshot (1080×1920), and 7" (1080×1920) and 10" (1440×2560)
 * tablet screenshots when tablets are on (9:16, at least 1080 px, so Google
 * can show them on tablets). For Play, displayType is the edits.images type.
 */
export const SIZES: ScreenshotSize[] = [
  { id: "iphone-6.9", store: "ios", label: 'iPhone 6.9"', width: 1320, height: 2868, displayType: "APP_IPHONE_67" },
  { id: "iphone-6.5", store: "ios", label: 'iPhone 6.5"', width: 1284, height: 2778, displayType: "APP_IPHONE_65" },
  { id: "ipad-13", store: "ios", label: 'iPad 13"', width: 2064, height: 2752, displayType: "APP_IPAD_PRO_3GEN_129" },
  { id: "android-phone", store: "android", label: "Android phone", width: 1080, height: 1920, displayType: null },
  { id: "android-tablet-7", store: "android", label: 'Android 7" tablet', width: 1080, height: 1920, displayType: "sevenInchScreenshots" },
  { id: "android-tablet-10", store: "android", label: 'Android 10" tablet', width: 1440, height: 2560, displayType: "tenInchScreenshots" },
];

const TABLET_SIZES = ["ipad-13", "android-tablet-7", "android-tablet-10"];
export const sizesFor = (tablet: boolean) => SIZES.filter((s) => tablet || !TABLET_SIZES.includes(s.id));
export const sizeById = (id: string) => SIZES.find((s) => s.id === id) ?? null;

export const shotsDir = (appId: string, setId: string) => join(dataDir(), "store-screens", appId.replace(/[^\w-]/g, "_"), setId.replace(/[^\w-]/g, "_"));

/** A store screenshot by set and file name, only from day2's folder. */
export function storeShotPath(appId: string, setId: string, name: string): string | null {
  if (!/^[\w.-]+\.png$/.test(name) || !/^[\w-]+$/.test(setId)) return null;
  const p = join(shotsDir(appId, setId), name);
  return existsSync(p) ? p : null;
}

export const hasFlow = (repoPath: string) => existsSync(join(repoPath, FLOW_PATH));

/** What the flow says each screen shows (the build agent writes it next to the flow). */
export function screenNotes(repoPath: string): Array<{ name: string; shows: string }> {
  try {
    const j = JSON.parse(readFileSync(join(repoPath, SCREENS_PATH), "utf-8")) as { screens?: Array<{ name?: unknown; shows?: unknown }> };
    return (j.screens ?? []).filter((s) => typeof s.name === "string").map((s) => ({ name: String(s.name), shows: typeof s.shows === "string" ? s.shows : "" })).slice(0, 10);
  } catch {
    return [];
  }
}

/** The ticket for the build agent: a Maestro flow through the app's key screens, for store screenshots. */
export function flowTicket(app: AppEntry, profile: AppProfile | null, locales: string[]): NewTicketInput {
  return {
    title: "Store screenshots: a Maestro flow through the app's key screens",
    type: "task",
    description: [
      `day2 makes ${app.name}'s App Store and Google Play screenshots itself: it runs a Maestro flow on the iPhone Simulator and the Android emulator, takes a screenshot of each key screen, and frames them with captions. This ticket adds that flow.`,
      "",
      `1. Add ${FLOW_PATH}: \`appId: \${APP_ID}\` at the top (day2 passes the bundle id / package with -e APP_ID=…), then launch the app with a clean state and walk to the 4–6 screens that show best what the app does${profile?.featureMap.length ? ` (${profile.featureMap.slice(0, 6).join("; ")})` : ""}. On each, \`takeScreenshot: 01-<screen>\`, \`02-<screen>\`, … in the order a new user should see them.`,
      "2. The screens must look real and full: sign in with a demo account or seed demo data the app already supports (never a real person's data), no debug banners, no keyboard, no permission dialogs (dismiss or pre-allow them).",
      `3. The flow reads \`\${DAY2_LOCALE}\` (day2 passes -e DAY2_LOCALE=${locales.join(" / ")}). If the app picks its language from the device, launch it in that language — e.g. \`launchApp: { clearState: true, arguments: { AppleLanguages: "(\${DAY2_LOCALE_LANG})", AppleLocale: "\${DAY2_LOCALE}" } }\` on iOS (day2 passes DAY2_LOCALE_LANG too) — or switch the app's own language setting in the flow.`,
      `4. Add ${SCREENS_PATH}: {"screens":[{"name":"01-<screen>","shows":"one sentence: what the user sees and can do here"}]}, matching the screenshot names.`,
      "5. Run it once on a simulator (`maestro test` with the variables) to make sure every step passes.",
    ].join("\n"),
    doneWhen: [`${FLOW_PATH} walks to the key screens and takes a screenshot of each`, `${SCREENS_PATH} describes each screenshot`, "The flow passes on the iPhone Simulator"],
    priority: 3,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: FLOW_KEY },
    actor: "day2",
    createdNote: "Needed for store screenshots (Store page).",
  };
}

// ---- Captions ----

export function buildCaptionsPrompt(appName: string, profile: AppProfile, screens: Array<{ name: string; shows: string }>, locales: string[]): string {
  return `Write App Store screenshot captions for ${appName} — ${profile.purpose}. For: ${profile.targetUsers}.
Tone: ${profile.toneOfVoice ?? "plain and friendly"}. Real features (only claim these): ${profile.featureMap.join("; ")}.

Screens, in order:
${screens.map((s) => `- ${s.name}: ${s.shows || "(no description)"}`).join("\n")}

For each screen and each locale (${locales.join(", ")}): a caption of 2–6 words that says the benefit the screen shows (not the screen's name), written natively in that language. The first screen carries the main promise. No prices, rankings or emoji.

End with this marker on its own line, then JSON, nothing after:
${CAPTIONS}
{"captions":{"${locales[0] ?? "en-US"}":{"${screens[0]?.name ?? "01-home"}":"…"}}}`;
}

/** Pure. Captions per locale and screen (≤ 40 characters each). */
export function parseCaptions(text: string, locales: string[], screens: string[]): Record<string, Record<string, string>> {
  const raw = afterMarker(text, CAPTIONS) as { captions?: Record<string, Record<string, unknown>> } | null;
  const out: Record<string, Record<string, string>> = {};
  for (const l of locales) {
    out[l] = {};
    for (const s of screens) {
      const c = raw?.captions?.[l]?.[s];
      if (typeof c === "string" && c.trim()) out[l]![s] = c.replace(/\s+/g, " ").trim().slice(0, 40);
    }
  }
  return out;
}

export async function writeCaptions(appName: string, profile: AppProfile, screens: Array<{ name: string; shows: string }>, locales: string[]) {
  const text = await runText(buildCaptionsPrompt(appName, profile, screens, locales), { service: "content_generation", label: "Store screenshot captions", maxUsd: CAPTIONS_MAX_USD });
  return text ? parseCaptions(text, locales, screens.map((s) => s.name)) : {};
}

// ---- Framing ----

export type FrameStyle = { background: string; accent: string; font: string };

/** Pure. Colors and font from the brand DNA (first palette color as the background). */
export function frameStyle(brand: BrandDna | null | undefined, fallback: string[] = []): FrameStyle {
  const palette = brand?.visual.palette.map((c) => c.hex) ?? fallback;
  const bg = palette.find((h) => /^#[0-9a-f]{6}$/i.test(h)) ?? "#111111";
  const accent = palette.find((h) => h !== bg && /^#[0-9a-f]{6}$/i.test(h)) ?? textOn(bg);
  const font = brand?.visual.typography?.match(/^[\w\s-]{2,40}/)?.[0]?.trim();
  return { background: bg, accent, font: font ? `"${font}", -apple-system, "Helvetica Neue", Arial, sans-serif` : `-apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif` };
}

/** Pure. One framed screenshot as a self-contained page of exactly the size's pixels: caption on top, the screen below with rounded corners. */
export function frameHtml(size: Pick<ScreenshotSize, "width" | "height">, caption: string, style: FrameStyle, screenshot: string): string {
  const { width: w, height: h } = size;
  const pad = Math.round(w * 0.07);
  const capH = Math.round(h * 0.17);
  const fontPx = Math.round(w * 0.072);
  const shotW = w - pad * 2;
  const shotH = h - capH - pad;
  const radius = Math.round(w * 0.06);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${style.background}}
.cap{position:absolute;left:${pad}px;right:${pad}px;top:0;height:${capH}px;display:flex;align-items:center;justify-content:center;text-align:center;color:${textOn(style.background)};font:700 ${fontPx}px/1.12 ${style.font};letter-spacing:-0.01em}
.shot{position:absolute;left:${pad}px;top:${capH}px;width:${shotW}px;height:${shotH}px;border-radius:${radius}px;overflow:hidden;box-shadow:0 ${Math.round(w * 0.02)}px ${Math.round(w * 0.05)}px rgba(0,0,0,.28);outline:${Math.max(4, Math.round(w * 0.008))}px solid ${style.accent}}
.shot img{width:100%;height:100%;object-fit:cover;object-position:top}
</style></head><body><div class="cap">${esc(caption)}</div><div class="shot"><img src="${screenshot}" alt=""></div></body></html>`;
}

/** Renders a framed screenshot to a PNG of the size's exact pixels; no web requests (everything is inline). */
export async function renderFrame(html: string, size: Pick<ScreenshotSize, "width" | "height">, out: string, browser?: Browser): Promise<string> {
  return withBrowser(async (b) => {
    const page = await b.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
    await page.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.screenshot({ path: out, type: "png" });
    await page.close();
    return out;
  }, browser);
}

/** Frames every raw screenshot at every size (one browser for all). */
export async function frameAll(o: { shots: Array<{ name: string; caption: string; raw: string }>; sizes: ScreenshotSize[]; style: FrameStyle; outDir: string; render?: typeof renderFrame }): Promise<ScreenshotShot[]> {
  mkdirSync(o.outDir, { recursive: true });
  const render = o.render ?? renderFrame;
  const run = async (browser?: Browser) => {
    const out: ScreenshotShot[] = [];
    for (const s of o.shots) {
      const uri = dataUri(s.raw);
      if (!uri) continue;
      const framed: Record<string, string> = {};
      for (const size of o.sizes) {
        const file = join(o.outDir, `${s.name}-${size.id}.png`);
        await render(frameHtml(size, s.caption, o.style, uri), size, file, browser);
        framed[size.id] = basename(file);
      }
      out.push({ name: s.name, caption: s.caption, raw: basename(s.raw), framed });
    }
    return out;
  };
  return o.render ? run() : withBrowser((b) => run(b));
}

// ---- Capture ----

export type CaptureDeps = {
  target: (p: StoreId) => Promise<Target | { skip: string }>;
  runFlow?: (o: { deviceId: string; flow: string; outDir: string; env: Record<string, string> }) => Promise<{ ok: boolean; why: string | null }>;
  log?: (t: string) => void;
};

export const MAESTRO_INSTALL = 'curl -fsSL "https://get.maestro.mobile.dev" | bash';

/**
 * Runs Maestro's flow on a device with variables; screenshots land in
 * outDir. `secretEnv` (e.g. the demo login, MAESTRO_* names) goes into
 * Maestro's environment — which flows can read — never onto the command
 * line, and is cut out of any error text.
 */
export async function runMaestro(o: { deviceId: string; flow: string; outDir: string; env: Record<string, string>; secretEnv?: Record<string, string> }): Promise<{ ok: boolean; why: string | null }> {
  if (!has("maestro")) return { ok: false, why: `Maestro isn't installed (${MAESTRO_INSTALL})` };
  mkdirSync(o.outDir, { recursive: true });
  const vars = Object.entries(o.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await runCmd(["maestro", "--device", o.deviceId, "test", o.flow, ...vars, "--test-output-dir", o.outDir], { cwd: o.outDir, env: { MAESTRO_CLI_NO_ANALYTICS: "1", ...(o.secretEnv ?? {}) }, timeoutMs: 20 * 60_000 });
  let why = r.timedOut ? "the flow took longer than 20 minutes" : `the flow failed: ${tail(r.out + r.err, 4)}`;
  for (const v of Object.values(o.secretEnv ?? {})) if (v) why = why.split(v).join("[hidden]");
  return r.code === 0 ? { ok: true, why: null } : { ok: false, why };
}

/**
 * Builds the app once per platform, then runs the store flow once per
 * locale; returns the raw screenshots per platform and locale (Maestro's
 * own screenshot names, e.g. "01-home").
 */
export async function captureRaw(o: { cwd: string; appId: string; bundleId: string | null; packageName: string | null; locales: string[]; outDir: string; env?: Record<string, string> }, deps: CaptureDeps): Promise<{ shots: Partial<Record<StoreId, Record<string, string[]>>>; notes: string[] }> {
  const run = deps.runFlow ?? runMaestro;
  const shots: Partial<Record<StoreId, Record<string, string[]>>> = {};
  const notes: string[] = [];
  for (const p of ["ios", "android"] as StoreId[]) {
    const id = p === "ios" ? o.bundleId : o.packageName;
    if (!id) continue;
    const t = await deps.target(p);
    if ("skip" in t) {
      notes.push(`${p === "ios" ? "iPhone" : "Android"}: ${t.skip}`);
      continue;
    }
    deps.log?.(`${t.device}: building the app for screenshots…`);
    const built = await t.build(o.cwd, o.env ?? {});
    if ("error" in built) {
      notes.push(`${t.device}: ${built.error}`);
      continue;
    }
    await t.uninstall();
    await t.install(built.app);
    for (const locale of o.locales) {
      const dir = join(o.outDir, "raw", p, locale);
      rmSync(dir, { recursive: true, force: true });
      const r = await run({ deviceId: t.id, flow: join(o.cwd, FLOW_PATH), outDir: dir, env: { APP_ID: id, DAY2_LOCALE: locale, DAY2_LOCALE_LANG: locale.split("-")[0]! } });
      if (!r.ok) {
        notes.push(`${t.device} (${locale}): ${r.why}`);
        continue;
      }
      (shots[p] ??= {})[locale] = pngsIn(dir);
    }
  }
  return { shots, notes };
}
