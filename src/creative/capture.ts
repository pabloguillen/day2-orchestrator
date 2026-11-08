import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { dataDir } from "../day2-paths";
import type { ScreenAsset } from "./templates/types";

/**
 * Actual screens, in the audience's language (docs/creative-quality.md).
 *
 * Capture plan per app: the 3–6 moments that explain the app — from the
 * store-screens notes (.maestro/day2/store-screens.json), a dedicated
 * social flow (.maestro/day2/social-moments.yaml) when the app has one, else
 * the app profile's features. Captured on the owner's Mac (iPhone
 * Simulator: locale set to the audience's language, a clean status bar,
 * `simctl io screenshot`, short `recordVideo` clips of key flows) with the
 * demo data the device checks use, and refreshed when the app's version
 * changes. The EAS cloud runner's screenshots are used the same way when
 * they're there.
 *
 * Which screens a post gets, in this order:
 *   1. fresh captures in the audience's language;
 *   1b. screenshots the owner uploaded for that language (Growth → Formats);
 *   1c. older captures (from before the app's latest version);
 *   2. the store screenshot pipeline's raw captures for that locale;
 *   3. App Store screenshots (language unknown or different) — marked with a
 *      warning ("Screens are in English") on the post instead of silently
 *      mixing languages. A localized re-render of foreign screens isn't
 *      possible (they're pictures).
 */

export const SOCIAL_FLOW = ".maestro/day2/social-moments.yaml";
export const STORE_FLOW = ".maestro/day2/store-screens.yaml";
export const STORE_NOTES = ".maestro/day2/store-screens.json";

export type Moment = { name: string; shows: string };
export type CapturePlan = { version: string | null; locale: string; language: string; flow: string | null; moments: Moment[]; record: boolean };

const LOCALE: Record<string, string> = { de: "de-DE", en: "en-US", fr: "fr-FR", es: "es-ES", it: "it-IT", nl: "nl-NL", pt: "pt-BR", pl: "pl-PL" };
export const localeFor = (language: string) => LOCALE[language] ?? `${language}-${language.toUpperCase()}`;

export function appVersion(repoPath: string): string | null {
  try {
    const j = JSON.parse(readFileSync(join(repoPath, "app.json"), "utf-8")) as { expo?: { version?: string }; version?: string };
    return j.expo?.version ?? j.version ?? null;
  } catch {
    return null;
  }
}

/** The moments to capture. Pure apart from reading the repo's notes. */
export function capturePlan(o: { repoPath: string; language: string; features: string[] }): CapturePlan {
  let moments: Moment[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(o.repoPath, STORE_NOTES), "utf-8")) as unknown;
    const list = Array.isArray(raw) ? raw : ((raw as { screens?: unknown[] })?.screens ?? []);
    moments = (list as Array<{ name?: string; shows?: string }>).filter((x) => x?.name).map((x) => ({ name: String(x.name).slice(0, 40), shows: String(x.shows ?? "").slice(0, 120) }));
  } catch {
    /* no notes yet */
  }
  if (!moments.length) moments = o.features.slice(0, 5).map((f, k) => ({ name: `moment-${k + 1}`, shows: f.slice(0, 120) }));
  const flow = existsSync(join(o.repoPath, SOCIAL_FLOW)) ? SOCIAL_FLOW : existsSync(join(o.repoPath, STORE_FLOW)) ? STORE_FLOW : null;
  return { version: appVersion(o.repoPath), locale: localeFor(o.language), language: o.language, flow, moments: moments.slice(0, 6), record: flow === SOCIAL_FLOW };
}

/**
 * Android emulator commands for the same: the locale (emulators allow
 * setprop as root) and the SystemUI demo mode's clean status bar. Pure.
 */
export function adbCommands(serial: string, o: { locale: string }): string[][] {
  const sh = (...a: string[]) => ["adb", "-s", serial, "shell", ...a];
  return [
    ["adb", "-s", serial, "root"],
    sh("setprop", "persist.sys.locale", o.locale),
    sh("setprop", "ctl.restart", "zygote"),
    sh("settings", "put", "global", "sysui_demo_allowed", "1"),
    sh("am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "enter"),
    sh("am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "clock", "-e", "hhmm", "0941"),
    sh("am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "battery", "-e", "level", "100", "-e", "plugged", "false"),
    sh("am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "network", "-e", "wifi", "show", "-e", "level", "4"),
    sh("am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "notifications", "-e", "visible", "false"),
  ];
}

/**
 * The simulator commands for one capture session (iPhone): language and
 * region, a clean status bar (9:41, full battery), then screenshots — or a
 * screen recording. Pure: runCmd executes them.
 */
export function simctlCommands(udid: string, o: { locale: string; screenshot?: string; record?: string }): string[][] {
  const [lang, region] = o.locale.split("-");
  const cmds: string[][] = [
    ["xcrun", "simctl", "spawn", udid, "defaults", "write", "-g", "AppleLanguages", "-array", lang!],
    ["xcrun", "simctl", "spawn", udid, "defaults", "write", "-g", "AppleLocale", `${lang}_${region ?? lang!.toUpperCase()}`],
    ["xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"],
  ];
  if (o.screenshot) cmds.push(["xcrun", "simctl", "io", udid, "screenshot", "--type=png", o.screenshot]);
  if (o.record) cmds.push(["xcrun", "simctl", "io", udid, "recordVideo", "--codec=h264", "--force", o.record]);
  return cmds;
}

// ---------------------------------------------------------------- the cache of captured screens

export type CaptureSet = {
  version: string | null;
  locale: string;
  language: string;
  capturedAt: string;
  /** "upload": screenshots the owner uploaded (creative/upload.ts). */
  source: "capture" | "recording" | "store" | "upload";
  device: string | null;
  screens: Array<Omit<ScreenAsset, "file"> & { file: string; shows?: string }>;
  recordings: Array<{ file: string; name: string; seconds: number }>;
  /** The screens show day2's demo cast: AI-generated pictures (and people) — posts carry the AI label. */
  aiContent?: { aiGenerated: boolean; aiPerson: boolean } | null;
  /** Where it ran: this Mac's simulator, or EAS. */
  mode?: "local" | "eas" | null;
};

export const capturesDir = (appId: string) => join(dataDir(), "creative-screens", appId.replace(/[^\w-]/g, "_"));

export function loadCaptureSet(appId: string, locale: string): CaptureSet | null {
  const p = join(capturesDir(appId), locale, "set.json");
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf-8")) as CaptureSet;
    const dir = join(capturesDir(appId), locale);
    // Only files inside the set's own folder.
    s.screens = s.screens.filter((x) => resolve(dir, x.file).startsWith(dir) && existsSync(resolve(dir, x.file))).map((x) => ({ ...x, file: resolve(dir, x.file) }));
    s.recordings = (s.recordings ?? []).filter((x) => resolve(dir, x.file).startsWith(dir) && existsSync(resolve(dir, x.file))).map((x) => ({ ...x, file: resolve(dir, x.file) }));
    return s;
  } catch {
    return null;
  }
}

export function saveCaptureSet(appId: string, set: CaptureSet): void {
  const dir = join(capturesDir(appId), set.locale);
  mkdirSync(dir, { recursive: true });
  const rel = { ...set, screens: set.screens.map((x) => ({ ...x, file: x.file.startsWith(dir) ? x.file.slice(dir.length + 1) : x.file })), recordings: set.recordings.map((x) => ({ ...x, file: x.file.startsWith(dir) ? x.file.slice(dir.length + 1) : x.file })) };
  writeFileSync(join(dir, "set.json.tmp"), JSON.stringify(rel, null, 2));
  renameSync(join(dir, "set.json.tmp"), join(dir, "set.json"));
}

/** A capture set is stale when the app's version moved on (a new release) or after 30 days. Pure. */
export function isStale(set: CaptureSet | null, version: string | null, now = new Date()): boolean {
  if (!set) return true;
  if (version && set.version && version !== set.version) return true;
  return now.getTime() - Date.parse(set.capturedAt) > 30 * 86_400_000;
}

export type ScreenChoice = {
  screens: Array<ScreenAsset & { shows?: string }>;
  source: "capture" | "upload" | "store-locale" | "store" | "web" | "none";
  warning: string | null;
  recordings: CaptureSet["recordings"];
  /** The screens show AI-generated pictures or people (the demo cast). */
  aiContent?: { aiGenerated: boolean; aiPerson: boolean } | null;
  /** A capture from before the app's latest version. */
  stale?: boolean;
};

const LANG_NAME: Record<string, string> = { de: "German", en: "English", fr: "French", es: "Spanish", it: "Italian", nl: "Dutch" };

/** Picks the post's screens by the fallback order above. Pure. */
export function chooseScreens(o: { language: string; capture: CaptureSet | null; upload?: CaptureSet | null; version?: string | null; now?: Date; storeLocale: Array<{ file: string; name: string; shows?: string }>; store: Array<{ file: string; language: string | null }>; web: string[]; dims?: (file: string) => { width: number; height: number } }): ScreenChoice {
  const dims = o.dims ?? (() => ({ width: 1290, height: 2796 }));
  const usable = (s: CaptureSet | null | undefined): s is CaptureSet => Boolean(s && s.screens.length && s.language === o.language);
  const fresh = usable(o.capture) && (o.version === undefined || !isStale(o.capture, o.version ?? null, o.now));
  if (fresh && o.capture) return { screens: o.capture.screens, source: "capture", warning: null, recordings: o.capture.recordings, aiContent: o.capture.aiContent ?? null, stale: false };
  if (usable(o.upload)) return { screens: o.upload.screens, source: "upload", warning: null, recordings: [], aiContent: null };
  if (usable(o.capture)) return { screens: o.capture.screens, source: "capture", warning: null, recordings: o.capture.recordings, aiContent: o.capture.aiContent ?? null, stale: true };
  if (o.storeLocale.length) return { screens: o.storeLocale.map((s) => ({ file: s.file, ...dims(s.file), language: o.language, source: "store" as const, name: s.name, shows: s.shows, statusBar: 0.055 })), source: "store-locale", warning: null, recordings: [] };
  if (o.store.length) {
    const lang = o.store.find((s) => s.language)?.language ?? null;
    const warning = lang && lang !== o.language ? `Screens are in ${LANG_NAME[lang] ?? lang}: day2 has no ${LANG_NAME[o.language] ?? o.language} screens yet. Capture them (Growth → Formats → Capture screens) or upload screenshots, and day2 uses them from the next post.` : !lang ? `Screens are App Store screenshots in an unknown language — check they're in ${LANG_NAME[o.language] ?? o.language}.` : null;
    return { screens: o.store.map((s) => ({ file: s.file, ...dims(s.file), language: s.language, source: "store" as const, name: "store", statusBar: 0 })), source: "store", warning, recordings: [] };
  }
  if (o.web.length) return { screens: o.web.map((f) => ({ file: f, width: 1170, height: 2532, language: o.language, source: "web" as const, name: "web", statusBar: 0 })), source: "web", warning: null, recordings: [] };
  return { screens: [], source: "none", warning: "No screens of the app yet.", recordings: [] };
}

/** PNG/JPEG size from the file header (no decoder needed). */
export function imageSize(file: string | Uint8Array): { width: number; height: number } {
  return headerSize(file) ?? { width: 1290, height: 2796 };
}

/** PNG/JPEG size from the header, or null when it can't be read. */
export function headerSize(file: string | Uint8Array): { width: number; height: number } | null {
  try {
    const b = typeof file === "string" ? readFileSync(file) : Buffer.from(file.buffer, file.byteOffset, file.byteLength);
    if (b[0] === 0x89 && b[1] === 0x50) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** The raw captures in a store screenshot set for a locale (the store pipeline already captured them in that language). */
export function storeRawFor(sets: Array<{ locale: string; status: string; shots: Array<{ name: string; raw: string; caption: string }> }>, language: string): Array<{ file: string; name: string; shows?: string }> {
  const set = [...sets].reverse().find((s) => s.locale.split("-")[0] === language && s.shots.some((x) => existsSync(x.raw)));
  return set ? set.shots.filter((x) => existsSync(x.raw)).map((x) => ({ file: x.raw, name: x.name, shows: x.caption })) : [];
}

/** A screenshot's moment name: "day2-shot-01-karte.png" → "01-karte". Pure. */
export const shotName = (file: string) => basename(file).replace(/\.png$/i, "").replace(/^day2-shot-/, "");

/** The screenshots a flow took (any folder below), oldest name first; Maestro's own failure shots are left out. */
export function flowScreenshots(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      // Regular files only (an archive's symlink is never followed).
      else if (/\.png$/i.test(e.name) && !/^screenshot-|❌|✅|failure/i.test(e.name) && lstatSync(p).isFile() && lstatSync(p).size > 64) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => shotName(a).localeCompare(shotName(b)));
}

/**
 * Captures the plan's moments on a simulator/emulator. `deps` wrap the
 * device runner (device-checks targets + Maestro), so it's testable and the
 * same code runs on the owner's Mac or with EAS's screenshots
 * (capture-run.ts). `secretEnv` (the demo login) reaches Maestro through
 * its environment (MAESTRO_* variables), never the command line. Returns
 * the new set, or why it couldn't.
 */
export type CaptureDeps = {
  /** Boots a device with the current build installed; `skip` when this computer can't (not a Mac, no Xcode). */
  device: () => Promise<{ id: string; name: string; platform?: "ios" | "android"; run: (cmd: string[]) => Promise<{ code: number }> } | { skip: string }>;
  /** Runs the Maestro flow with variables; screenshots land in outDir. */
  flow: (o: { deviceId: string; flow: string; outDir: string; env: Record<string, string>; secretEnv?: Record<string, string> }) => Promise<{ ok: boolean; why: string | null }>;
  now?: () => Date;
};

export async function captureMoments(o: { appId: string; repoPath: string; bundleId: string; plan: CapturePlan; secretEnv?: Record<string, string>; aiContent?: CaptureSet["aiContent"]; mode?: CaptureSet["mode"] }, d: CaptureDeps): Promise<{ set: CaptureSet | null; note: string }> {
  if (!o.plan.flow) return { set: null, note: "no Maestro flow yet (day2 adds one with the demo screens ticket)" };
  const dev = await d.device();
  if ("skip" in dev) return { set: null, note: dev.skip };
  const dir = join(capturesDir(o.appId), o.plan.locale, `run-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  const cmds = dev.platform === "android" ? adbCommands(dev.id, { locale: o.plan.locale }) : simctlCommands(dev.id, { locale: o.plan.locale });
  for (const c of cmds) await dev.run(c);
  const r = await d.flow({ deviceId: dev.id, flow: join(o.repoPath, o.plan.flow), outDir: dir, env: { APP_ID: o.bundleId, DAY2_LOCALE: o.plan.locale, DAY2_LOCALE_LANG: o.plan.language, DAY2_DEMO: "1" }, secretEnv: o.secretEnv });
  if (!r.ok) return { set: null, note: r.why ?? "the flow failed" };
  return importScreens({ appId: o.appId, plan: o.plan, dir, device: dev.name, at: d.now?.() ?? new Date(), aiContent: o.aiContent ?? null, mode: o.mode ?? "local" });
}

/** Turns a folder of flow screenshots (local run or EAS artifacts) into the app's capture set for the locale. */
export function importScreens(o: { appId: string; plan: CapturePlan; dir: string; device: string | null; at: Date; aiContent: CaptureSet["aiContent"]; mode: CaptureSet["mode"] }): { set: CaptureSet | null; note: string } {
  const notes = new Map(o.plan.moments.map((m) => [m.name, m.shows]));
  const base = join(capturesDir(o.appId), o.plan.locale);
  // Files from elsewhere (EAS artifacts) are copied into a run folder of the app's own.
  let dir = o.dir;
  if (!resolve(dir).startsWith(`${base}/`)) {
    dir = join(base, `run-${o.at.getTime().toString(36)}`);
    mkdirSync(dir, { recursive: true });
    for (const f of flowScreenshots(o.dir).slice(0, 8)) copyFileSync(f, join(dir, basename(f)));
  }
  const pngs = flowScreenshots(dir).slice(0, 8);
  const set: CaptureSet = {
    version: o.plan.version,
    locale: o.plan.locale,
    language: o.plan.language,
    capturedAt: o.at.toISOString(),
    source: "capture",
    device: o.device,
    screens: pngs.map((file) => {
      const name = shotName(file);
      return { file, ...imageSize(file), language: o.plan.language, source: "capture" as const, name, shows: notes.get(name) ?? notes.get(name.replace(/^\d+-/, "")), statusBar: 0.055 };
    }),
    recordings: [],
    aiContent: o.aiContent,
    mode: o.mode,
  };
  const mp4 = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? mp4(join(d, e.name)) : /\.mp4$/i.test(e.name) ? [join(d, e.name)] : [])) : []);
  set.recordings = mp4(dir).slice(0, 4).map((f) => ({ file: f, name: basename(f).replace(/\.mp4$/i, ""), seconds: 0 }));
  if (!set.screens.length) return { set: null, note: "the flow ran but took no screenshots" };
  saveCaptureSet(o.appId, set);
  // Only the newest run is kept.
  for (const e of readdirSync(base)) if (e.startsWith("run-") && join(base, e) !== dir) rmSync(join(base, e), { recursive: true, force: true });
  return { set, note: `captured ${set.screens.length} screens on ${o.device ?? "a device"} in ${o.plan.locale}` };
}
