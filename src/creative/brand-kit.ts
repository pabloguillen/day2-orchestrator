import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { BrandDna } from "../brand-dna";
import { guessLanguage } from "../social/state";

/**
 * The app's design language, read from its own repo (docs/creative-quality.md):
 * colours and tokens (theme files, StyleSheet constants, Tailwind/NativeWind
 * config, CSS variables), fonts (expo-font, font files), corner radii, the
 * app icon, a logo, the icon/illustration style, the UI copy's tone and its
 * language. Every post, slide and ad day2 renders uses it, so they look like
 * the app instead of a template.
 *
 * Layers, last wins: what day2 read from the repo → Brand DNA (owner-
 * confirmed palette) → the owner's edits on Growth → Formats (`overrides`)
 * → an optional Figma file's styles (figma.ts), which the owner connected on
 * purpose. Stored per app next to its other day2 files (`day2-brand-kit.json`).
 *
 * Reading is pure file I/O over the checkout (no code from the app runs);
 * the icon's average colour comes from ffmpeg when it's there.
 */

export const BRAND_KIT_FILENAME = "day2-brand-kit.json";
const HEX6 = /^#[0-9a-f]{6}$/i;

export type KitColor = { hex: string; name: string; uses: number };
export type FontRef = { family: string; weight: number; path: string };

export type BrandKit = {
  version: 1;
  appName: string;
  extractedAt: string;
  /** Repo-relative files day2 read it from (shown in the console). */
  sources: string[];
  colors: {
    /** The brand colour (backgrounds of hero moments, highlights). */
    primary: string;
    /** A second colour for accents (may be null). */
    accent: string | null;
    /** Text on light surfaces. */
    ink: string;
    inkSoft: string;
    background: string;
    surface: string;
    palette: KitColor[];
  };
  fonts: { display: FontRef | null; body: FontRef | null; files: FontRef[]; families: string[] };
  radii: { card: number; button: number; pill: boolean };
  /** Repo-relative paths. */
  icon: { path: string | null; background: string | null; average: string | null };
  logo: string | null;
  style: {
    illustration: "3d-icons" | "flat-icons" | "photos" | "emoji" | null;
    emoji: boolean;
    shadows: "soft" | "strong" | "none";
    buttons: "3d" | "flat" | null;
    mode: "light" | "dark";
    notes: string[];
  };
  copy: { samples: string[]; tone: string; language: string; casualYou: boolean };
};

/** What the owner changed on Growth → Formats (every field optional). */
export type BrandKitOverrides = {
  primary?: string;
  accent?: string | null;
  ink?: string;
  background?: string;
  displayFont?: string;
  bodyFont?: string;
  language?: string;
  tone?: string;
  notes?: string;
};

export type FigmaTokens = { fileKey: string; fetchedAt: string; colors: Array<{ name: string; hex: string }>; fonts: Array<{ name: string; family: string; weight: number }> };

export type StoredBrandKit = { extracted: BrandKit | null; overrides: BrandKitOverrides; figma?: FigmaTokens | null; updatedAt: string; updatedBy?: string | null };

// ---------------------------------------------------------------- colour helpers

export function normHex(v: string): string | null {
  let h = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  if (/^#[0-9a-f]{8}$/.test(h)) h = h.slice(0, 7);
  return HEX6.test(h) ? h : null;
}
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
export const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
/** HSL saturation 0..1. */
export function saturation(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const l = (max + min) / 2;
  if (max === min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}
const distance = (a: string, b: string) => {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
};
export const isNeutral = (hex: string) => saturation(hex) < 0.12;
/** Readable text colour on a background: the kit's ink or white. */
export const onColor = (bg: string, ink = "#111111") => (contrast(bg, ink) >= contrast(bg, "#ffffff") ? ink : "#ffffff");
/** Mix two colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

// ---------------------------------------------------------------- reading the repo

const SKIP_DIRS = new Set(["node_modules", ".git", "ios", "android", "build", "dist", ".expo", "vendor", "coverage", "__tests__", "supabase", "scripts", ".next", "web-build", "Pods"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".scss"]);

function walk(root: string, dir: string, out: string[], depth = 0, max = 4000): void {
  if (depth > 8 || out.length >= max) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".maestro") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, p, out, depth + 1, max);
    } else if (e.isFile()) out.push(p);
  }
}

const read = (p: string, max = 400_000): string => {
  try {
    if (statSync(p).size > max) return "";
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
};

type AppConfig = {
  name?: string;
  icon?: string;
  primaryColor?: string;
  backgroundColor?: string;
  userInterfaceStyle?: string;
  android?: { adaptiveIcon?: { backgroundColor?: string; foregroundImage?: string } };
  splash?: { backgroundColor?: string; image?: string };
  plugins?: unknown[];
};

function appConfig(repo: string): AppConfig {
  for (const f of ["app.json", "app.config.json"]) {
    const t = read(join(repo, f));
    if (!t) continue;
    try {
      const j = JSON.parse(t) as { expo?: AppConfig } & AppConfig;
      return j.expo ?? j;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

const WEIGHTS: Array<[RegExp, number]> = [
  [/black|heavy/i, 900],
  [/extra-?bold|ultra-?bold/i, 800],
  [/semi-?bold|demi-?bold/i, 600],
  [/bold/i, 700],
  [/medium/i, 500],
  [/light/i, 300],
  [/thin|hairline/i, 100],
  [/regular|book|normal/i, 400],
];
export function fontFromFile(path: string): FontRef {
  const name = basename(path, extname(path));
  const weight = WEIGHTS.find(([re]) => re.test(name))?.[1] ?? 400;
  const family = name.replace(/[-_ ]?(black|heavy|extra-?bold|ultra-?bold|semi-?bold|demi-?bold|bold|medium|light|thin|hairline|regular|book|normal|italic)+$/i, "").replace(/[-_]+$/, "") || name;
  return { family, weight, path };
}

/** The average colour of an image (ffmpeg scales it to one pixel); null without ffmpeg. */
export function averageColor(file: string): string | null {
  try {
    const r = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=1:1:flags=area,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { timeout: 15_000 });
    if (r.status !== 0 || !r.stdout || r.stdout.length < 3) return null;
    return toHex(r.stdout[0]!, r.stdout[1]!, r.stdout[2]!);
  } catch {
    return null;
  }
}

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Reads the design language from an app's repo. Pure apart from reading
 * files (and ffmpeg for the icon's colour, when `iconColor` isn't given).
 */
export function extractBrandKit(repoPath: string, opts: { now?: Date; iconColor?: (file: string) => string | null } = {}): BrandKit {
  const repo = resolve(repoPath);
  const rel = (p: string) => relative(repo, p).split(sep).join("/");
  const cfg = appConfig(repo);
  const files: string[] = [];
  walk(repo, repo, files);
  const sources = new Set<string>();
  if (existsSync(join(repo, "app.json"))) sources.add("app.json");

  // Colours: named tokens in theme-like files weigh most; every hex use in code counts.
  const uses = new Map<string, number>();
  const names = new Map<string, string>();
  const isTheme = (p: string) => /(^|\/)(theme|tokens?|colou?rs?|palette|design|styles?)(\/|\.|$)|tailwind\.config|global\.css|variables\.css/i.test(rel(p));
  const radiiSeen: number[] = [];
  let tokenRadii: number[] = [];
  const fontFamilies = new Map<string, number>();
  const copy: string[] = [];
  let shadowSoft = 0;
  let shadowStrong = 0;
  let threeD = 0;
  let buttons3d = 0;
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!CODE_EXT.has(ext) && !/tailwind\.config/.test(f)) continue;
    const text = read(f);
    if (!text) continue;
    const theme = isTheme(f);
    if (theme) sources.add(rel(f));
    for (const m of text.matchAll(/([A-Za-z_$][\w$-]*)['"]?\s*[:=]\s*['"`](#[0-9a-fA-F]{3,8})\b/g)) {
      const hex = normHex(m[2]!);
      if (!hex) continue;
      uses.set(hex, (uses.get(hex) ?? 0) + (theme ? 6 : 1));
      if (theme && !names.has(hex)) names.set(hex, m[1]!);
    }
    for (const m of text.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
      const hex = normHex(m[2]!);
      if (!hex) continue;
      uses.set(hex, (uses.get(hex) ?? 0) + 6);
      if (!names.has(hex)) names.set(hex, m[1]!);
    }
    for (const m of text.matchAll(/(?<![\w-])(#[0-9a-fA-F]{6})\b/g)) {
      const hex = normHex(m[1]!);
      if (hex) uses.set(hex, (uses.get(hex) ?? 0) + 0.5);
    }
    // Radii: a `radius` token object, else borderRadius values.
    const radiusObj = /export\s+const\s+radii?\s*=\s*\{([^}]+)\}/.exec(text);
    if (radiusObj) tokenRadii = [...radiusObj[1]!.matchAll(/:\s*(\d{1,4})/g)].map((x) => Number(x[1])).filter((n) => n > 0);
    for (const m of text.matchAll(/(?:borderRadius|rounded-\[)\s*:?\s*(\d{1,3})/g)) radiiSeen.push(Number(m[1]));
    for (const m of text.matchAll(/fontFamily\s*:\s*['"]([^'"]{2,60})['"]/g)) fontFamilies.set(m[1]!, (fontFamilies.get(m[1]!) ?? 0) + 1);
    for (const m of text.matchAll(/shadowOpacity\s*:\s*(0?\.\d+)/g)) (Number(m[1]) > 0.25 ? shadowStrong++ : shadowSoft++);
    if (/button3d|Button3D|3d button/i.test(text)) buttons3d++;
    if (/icons3d|3d\/|Icon3d/.test(text)) threeD++;
    // UI copy: string literals and JSX text in screens and UI components.
    if (/(screens?|ui|components?|app|pages?)\//i.test(rel(f)) && /\.(t|j)sx?$/.test(ext)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
      for (const m of code.matchAll(/(?:>\s*([^<>{}\n]{6,90}?)\s*<|['"]([^'"\n{}]{6,90})['"])/g)) {
        const s = (m[1] ?? m[2] ?? "").trim();
        if (/^[A-ZÀ-Þ0-9].*\s/u.test(s) && /\p{L}{2,}\s+\p{L}{2,}/u.test(s) && !/[=;()[\]\\/@]|^\w+\.\w+|https?:|^[a-z]+[A-Z]/.test(s) && !/^(import|export|const|return|use)\b/.test(s)) copy.push(s);
      }
    }
  }
  for (const f of files) if (/(^|\/)(3d|icons3d)(\/|$)/i.test(rel(f)) && /\.png$/i.test(f)) threeD++;

  // App config colours count too: they are what the app's owner chose for the icon and splash.
  const cfgColors: Array<[string | undefined, string, number]> = [
    [cfg.android?.adaptiveIcon?.backgroundColor, "iconBackground", 10],
    [cfg.primaryColor, "primaryColor", 4],
    [cfg.backgroundColor, "backgroundColor", 2],
    [cfg.splash?.backgroundColor, "splash", 2],
  ];
  for (const p of cfg.plugins ?? []) {
    if (Array.isArray(p) && p[0] === "expo-notifications" && typeof (p[1] as { color?: string })?.color === "string") cfgColors.push([(p[1] as { color: string }).color, "notificationColor", 6]);
    if (Array.isArray(p) && p[0] === "expo-splash-screen" && typeof (p[1] as { backgroundColor?: string })?.backgroundColor === "string") cfgColors.push([(p[1] as { backgroundColor: string }).backgroundColor, "splash", 2]);
  }
  for (const [v, name, w] of cfgColors) {
    const hex = v ? normHex(v) : null;
    if (!hex) continue;
    uses.set(hex, (uses.get(hex) ?? 0) + w);
    if (!names.has(hex)) names.set(hex, name);
  }

  // Icon.
  const iconRel = typeof cfg.icon === "string" ? cfg.icon.replace(/^\.\//, "") : null;
  const iconPath = iconRel && existsSync(join(repo, iconRel)) ? iconRel : (files.map(rel).find((p) => /(^|\/)(icon|app-icon|appicon)\.png$/i.test(p)) ?? null);
  const iconAvg = iconPath ? (opts.iconColor ?? averageColor)(join(repo, iconPath)) : null;
  const iconBg = normHex(cfg.android?.adaptiveIcon?.backgroundColor ?? "") ?? null;
  const logo = files.map(rel).find((p) => /(^|\/)logo[\w-]*\.(png|svg)$/i.test(p) && !/node_modules/.test(p)) ?? null;

  const palette: KitColor[] = [...uses.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([hex, n]) => ({ hex, name: names.get(hex) ?? "", uses: Math.round(n * 10) / 10 }));

  // Roles. Brand colour: the saturated colour closest to the icon (what people recognise), else the most used saturated one.
  const saturated = palette.filter((c) => !isNeutral(c.hex) && luminance(c.hex) > 0.04);
  const brandish = (c: KitColor) => /brand|primary|accent|yellow|main|me\b|theme/i.test(c.name);
  const iconRef = iconBg ?? (iconAvg && !isNeutral(iconAvg) ? iconAvg : null);
  const primary =
    (iconRef ? [...saturated].sort((a, b) => distance(a.hex, iconRef) - distance(b.hex, iconRef))[0]?.hex : null) ??
    saturated.find(brandish)?.hex ??
    saturated[0]?.hex ??
    "#141414";
  const neutrals = palette.filter((c) => isNeutral(c.hex));
  const darks = palette.filter((c) => luminance(c.hex) < 0.035 && (isNeutral(c.hex) || /ink|text|fore|dark|title|body/i.test(c.name)) && !/shadow/i.test(c.name));
  const ink = darks.find((c) => /ink|text|fore|black|dark/i.test(c.name))?.hex ?? darks[0]?.hex ?? "#111111";
  const mids = neutrals.filter((c) => luminance(c.hex) > 0.08 && luminance(c.hex) < 0.35);
  const inkSoft = mids.find((c) => /secondary|muted|soft|gray|grey|sub/i.test(c.name))?.hex ?? mids[0]?.hex ?? mix(ink, "#ffffff", 0.45);
  const lights = neutrals.filter((c) => luminance(c.hex) > 0.8);
  const mode: "light" | "dark" = cfg.userInterfaceStyle === "dark" ? "dark" : "light";
  const background = normHex(cfg.backgroundColor ?? "") ?? lights.find((c) => c.hex === "#ffffff")?.hex ?? lights[0]?.hex ?? (mode === "dark" ? "#111111" : "#ffffff");
  const surface = lights.find((c) => c.hex !== background && /well|surface|card|thumb|muted|subtle/i.test(c.name))?.hex ?? lights.find((c) => c.hex !== background)?.hex ?? mix(background, ink, 0.05);
  const accent = saturated.find((c) => c.hex !== primary && distance(c.hex, primary) > 90 && c.uses >= 2)?.hex ?? null;

  // Fonts: files the app bundles; display = heaviest, body = semibold/medium/regular.
  const fontFiles = files.filter((f) => /\.(ttf|otf)$/i.test(f) && !/node_modules/.test(f)).map((f) => fontFromFile(rel(f)));
  const registered = new Set<string>();
  for (const p of cfg.plugins ?? []) if (Array.isArray(p) && p[0] === "expo-font") for (const f of ((p[1] as { fonts?: string[] })?.fonts ?? [])) registered.add(f.replace(/^\.\//, ""));
  const pool = (registered.size ? fontFiles.filter((f) => registered.has(f.path)) : fontFiles).sort((a, b) => a.weight - b.weight);
  for (const f of pool) sources.add(f.path);
  const display = [...pool].reverse().find((f) => f.weight >= 800) ?? [...pool].reverse()[0] ?? null;
  const body = pool.find((f) => f.weight === 600) ?? pool.find((f) => f.weight === 500) ?? pool.find((f) => f.weight === 400) ?? pool[0] ?? null;
  const families = [...new Set([...pool.map((f) => f.family), ...[...fontFamilies.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f.replace(/-(Black|ExtraBold|Bold|SemiBold|Medium|Regular)$/i, ""))])].slice(0, 6);

  // Radii.
  const common = (xs: number[]) => {
    const c = new Map<number, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const r = tokenRadii.filter((x) => x < 200).length ? tokenRadii.filter((x) => x < 200) : common(radiiSeen.filter((x) => x > 0 && x < 100));
  const sortedR = [...r].sort((a, b) => a - b);
  const card = sortedR.length ? (sortedR[Math.min(sortedR.length - 1, Math.floor(sortedR.length * 0.6))] ?? 16) : 16;
  const button = sortedR.length ? (sortedR[Math.floor(sortedR.length / 2)] ?? 12) : 12;
  const pill = tokenRadii.some((x) => x >= 500) || radiiSeen.some((x) => x >= 99);

  // Copy: dedupe, keep human lines, guess language and tone.
  const seen = new Set<string>();
  const samples = copy.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k) || s.split(/\s+/).length < 2) return false;
    seen.add(k);
    return true;
  });
  const language = guessLanguage(samples.slice(0, 400));
  const emojiLines = samples.filter((s) => EMOJI.test(s)).length;
  const casualYou = language === "de" ? samples.filter((s) => /\b(du|dein\w*|dich|dir)\b/i.test(s)).length > samples.filter((s) => /\b(Sie|Ihr\w*|Ihnen)\b/.test(s)).length : false;
  const slangy = samples.filter((s) => /\b(literally|peak|vibe|aura|main.character|lol|omg)\b/i.test(s)).length;
  const toneBits = [casualYou ? "casual (du)" : language === "de" ? "polite" : "plain", emojiLines > 3 ? "uses emoji" : null, slangy > 1 ? "playful, current slang" : null, samples.some((s) => s.length < 30 && /!$/.test(s)) ? "short and upbeat" : null].filter(Boolean);
  const notes: string[] = [];
  if (threeD > 3) notes.push("3D icons (glossy, rounded) instead of flat icons");
  if (buttons3d) notes.push("3D buttons with a darker lip");
  if (pill) notes.push("pill-shaped buttons and chips");
  if (display) notes.push(`${display.family} in heavy weights for titles`);

  return {
    version: 1,
    appName: cfg.name ?? basename(repo),
    extractedAt: (opts.now ?? new Date()).toISOString(),
    sources: [...sources].slice(0, 30),
    colors: { primary, accent, ink, inkSoft, background, surface, palette },
    fonts: { display, body, files: pool, families },
    radii: { card, button, pill },
    icon: { path: iconPath, background: iconBg, average: iconAvg },
    logo,
    style: {
      illustration: threeD > 3 ? "3d-icons" : emojiLines > 6 ? "emoji" : null,
      emoji: emojiLines > 3,
      shadows: shadowStrong > shadowSoft ? "strong" : shadowSoft ? "soft" : "none",
      buttons: buttons3d ? "3d" : null,
      mode,
      notes,
    },
    copy: { samples: samples.filter((s) => s.length <= 70).slice(0, 24), tone: toneBits.join(", "), language, casualYou },
  };
}

// ---------------------------------------------------------------- the kit renderers use

/** Everything a template needs, resolved: no nulls where a renderer needs a value. */
export type ResolvedKit = {
  appName: string;
  primary: string;
  /** Text on the primary colour. */
  onPrimary: string;
  accent: string;
  ink: string;
  inkSoft: string;
  background: string;
  surface: string;
  /** Absolute font files, embedded into renders. */
  displayFont: { family: string; weight: number; file: string | null };
  bodyFont: { family: string; weight: number; file: string | null };
  radius: number;
  pill: boolean;
  /** Absolute path to the real app icon (end cards), or null (then no logo is drawn — never a placeholder letter). */
  icon: string | null;
  /** Absolute paths to the app's own 3D icons/stickers, by name (e.g. fire, sparkles), when it has them. */
  stickers: Record<string, string>;
  illustration: BrandKit["style"]["illustration"];
  language: string;
  tone: string;
  casualYou: boolean;
};

const FALLBACK_FONT = { family: "Inter", weight: 800, file: null };

/** Owner edits and the confirmed Brand DNA on top of what day2 read. Pure (apart from checking files exist). */
export function resolveKit(stored: StoredBrandKit | null, o: { repoPath: string; appName: string; dna?: BrandDna | null }): ResolvedKit {
  const k = stored?.extracted ?? null;
  const ov = stored?.overrides ?? {};
  const abs = (p: string | null | undefined) => (p ? (existsSync(resolve(o.repoPath, p)) ? resolve(o.repoPath, p) : null) : null);
  const dnaPrimary = o.dna?.visual.palette.find((c) => /primary|brand|main/i.test(c.role))?.hex ?? null;
  const figmaPrimary = stored?.figma?.colors.find((c) => /primary|brand/i.test(c.name))?.hex ?? null;
  const pick = (...xs: Array<string | null | undefined>) => xs.map((x) => (x ? normHex(x) : null)).find(Boolean) ?? null;
  const primary = pick(ov.primary, figmaPrimary, k?.colors.primary, dnaPrimary) ?? "#141414";
  const ink = pick(ov.ink, k?.colors.ink) ?? "#111111";
  const background = pick(ov.background, k?.colors.background) ?? "#ffffff";
  const accent = pick(ov.accent ?? undefined, k?.colors.accent) ?? ink;
  const fontByFamily = (family: string | undefined, want: "display" | "body") => {
    if (!family || !k) return null;
    const files = k.fonts.files.filter((f) => f.family.toLowerCase() === family.toLowerCase());
    const f = want === "display" ? [...files].sort((a, b) => b.weight - a.weight)[0] : (files.find((x) => x.weight === 600) ?? files[0]);
    return f ? { family: f.family, weight: f.weight, file: abs(f.path) } : { family, weight: want === "display" ? 800 : 600, file: null };
  };
  const display = fontByFamily(ov.displayFont, "display") ?? (k?.fonts.display ? { family: k.fonts.display.family, weight: k.fonts.display.weight, file: abs(k.fonts.display.path) } : FALLBACK_FONT);
  const body = fontByFamily(ov.bodyFont, "body") ?? (k?.fonts.body ? { family: k.fonts.body.family, weight: k.fonts.body.weight, file: abs(k.fonts.body.path) } : { ...FALLBACK_FONT, weight: 600 });
  const stickers: Record<string, string> = {};
  if (k?.style.illustration === "3d-icons") {
    const dirs = [join(o.repoPath, "src", "assets", "3d"), join(o.repoPath, "assets", "3d"), join(o.repoPath, "assets", "icons3d")];
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) {
        const m = /^([a-z0-9-]+)(@3x)?\.png$/i.exec(f);
        if (!m) continue;
        if (m[2] || !stickers[m[1]!]) stickers[m[1]!] = join(d, f);
      }
    }
  }
  return {
    appName: o.appName || k?.appName || "App",
    primary,
    onPrimary: onColor(primary, ink),
    accent,
    ink,
    inkSoft: pick(k?.colors.inkSoft) ?? mix(ink, background, 0.45),
    background,
    surface: pick(k?.colors.surface) ?? mix(background, ink, 0.05),
    displayFont: display,
    bodyFont: body,
    radius: Math.max(8, Math.min(40, k?.radii.card ?? 20)),
    pill: k?.radii.pill ?? true,
    icon: abs(k?.icon.path),
    stickers,
    illustration: k?.style.illustration ?? null,
    language: ov.language ?? k?.copy.language ?? "en",
    tone: ov.tone ?? k?.copy.tone ?? "",
    casualYou: k?.copy.casualYou ?? false,
  };
}

// ---------------------------------------------------------------- storage

export const brandKitPath = (repoPath: string) => resolve(repoPath, BRAND_KIT_FILENAME);

export function loadBrandKit(repoPath: string): StoredBrandKit | null {
  const p = brandKitPath(repoPath);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as StoredBrandKit;
    return { extracted: j.extracted ?? null, overrides: cleanOverrides(j.overrides ?? {}), figma: j.figma ?? null, updatedAt: j.updatedAt ?? new Date(0).toISOString(), updatedBy: j.updatedBy ?? null };
  } catch {
    return null;
  }
}

export function saveBrandKit(repoPath: string, kit: StoredBrandKit): void {
  const p = brandKitPath(repoPath);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kit, null, 2)}\n`);
  renameSync(tmp, p);
}

/** The kit for an app: read from the repo the first time (and again when `refresh`), owner edits kept. */
export function ensureBrandKit(repoPath: string, opts: { refresh?: boolean; now?: Date } = {}): StoredBrandKit {
  const cur = loadBrandKit(repoPath);
  if (cur?.extracted && !opts.refresh) return cur;
  const next: StoredBrandKit = { extracted: extractBrandKit(repoPath, { now: opts.now }), overrides: cur?.overrides ?? {}, figma: cur?.figma ?? null, updatedAt: (opts.now ?? new Date()).toISOString(), updatedBy: cur?.updatedBy ?? null };
  saveBrandKit(repoPath, next);
  return next;
}

/** Validates the owner's edits (colours must be hex, fonts must be names, short texts). Pure. */
export function cleanOverrides(raw: unknown): BrandKitOverrides {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: BrandKitOverrides = {};
  for (const k of ["primary", "ink", "background"] as const) {
    const v = typeof b[k] === "string" ? normHex(b[k] as string) : null;
    if (v) out[k] = v;
  }
  if (b.accent === null) out.accent = null;
  else if (typeof b.accent === "string" && normHex(b.accent)) out.accent = normHex(b.accent);
  for (const k of ["displayFont", "bodyFont"] as const) if (typeof b[k] === "string" && /^[\w .-]{2,40}$/.test((b[k] as string).trim())) out[k] = (b[k] as string).trim();
  if (typeof b.language === "string" && /^[a-z]{2}$/.test(b.language)) out.language = b.language;
  if (typeof b.tone === "string" && b.tone.trim()) out.tone = b.tone.replace(/[<>]/g, "").trim().slice(0, 200);
  if (typeof b.notes === "string" && b.notes.trim()) out.notes = b.notes.replace(/[<>]/g, "").trim().slice(0, 400);
  return out;
}

/** For the art director's prompt: the design language in words (owner-trusted data). Pure. */
export function kitBrief(k: ResolvedKit, stored?: StoredBrandKit | null): string {
  const ex = stored?.extracted;
  return [
    `Brand colour ${k.primary} (text on it: ${k.onPrimary}); ink ${k.ink}; background ${k.background}${k.accent !== k.ink ? `; accent ${k.accent}` : ""}.`,
    `Type: ${k.displayFont.family} ${k.displayFont.weight} for titles, ${k.bodyFont.family} for text. Corner radius ~${k.radius}px${k.pill ? ", pill buttons" : ""}.`,
    ex?.style.notes.length ? `Design language: ${ex.style.notes.join("; ")}.` : "",
    Object.keys(k.stickers).length ? `The app's own 3D stickers available: ${Object.keys(k.stickers).slice(0, 24).join(", ")}.` : "",
    `UI copy tone: ${k.tone || "plain"}; language ${k.language}.`,
    ex?.copy.samples.length ? `Real lines from the app: ${ex.copy.samples.slice(0, 8).map((s) => `"${s}"`).join(" ")}` : "",
    stored?.overrides.notes ? `Owner's notes: ${stored.overrides.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
