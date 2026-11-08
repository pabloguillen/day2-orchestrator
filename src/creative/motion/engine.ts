import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { chromiumPath } from "../../simulation";
import type { ResolvedKit } from "../brand-kit";

/**
 * day2's motion engine (docs/creative-quality.md): a composition is plain
 * HTML whose CSS animations all sit on one paused timeline. Rendering seeks
 * every animation to the frame's time, screenshots it through the DevTools
 * protocol and pipes the frames to ffmpeg — frame N is always the same
 * picture, so renders are deterministic and testable.
 *
 * Why not Remotion: the same technique (headless Chromium frames + ffmpeg)
 * without a React bundle step, extra binaries or a per-render company
 * licence; compositions here are data-driven templates (an agent writes a
 * shot list, never code), so nothing would use Remotion's React authoring.
 * See docs/creative-quality.md → "Remotion".
 */

export const EASE = {
  /** Fast in, soft landing — most entrances. */
  out: "cubic-bezier(.16,1,.3,1)",
  /** Overshoots a little — pops, stickers, the icon. */
  pop: "cubic-bezier(.34,1.56,.64,1)",
  /** Symmetric — camera moves, pushes between screens. */
  inOut: "cubic-bezier(.65,0,.35,1)",
  /** Accelerating — exits. */
  in: "cubic-bezier(.7,0,.84,0)",
  linear: "linear",
} as const;

export type Stop = [number, string, string?];

/** Keyframe tracks on one shared timeline of `T` seconds. */
export class Timeline {
  private rules: string[] = [];
  private n = 0;
  constructor(readonly T: number) {}
  /** Stops are [time s, css, easing into this stop]. Returns the class to put on the element. */
  track(stops: Stop[]): string {
    const id = `k${this.n++}`;
    const pts = stops.map(([t, css, e]) => ({ p: Math.min(100, Math.max(0, (t / this.T) * 100)), css, e }));
    for (let i = 1; i < pts.length; i++) if (pts[i]!.p <= pts[i - 1]!.p) pts[i]!.p = Math.min(100, pts[i - 1]!.p + 0.01);
    const frames: string[] = [];
    if (pts[0]!.p > 0) frames.push(`0%{${pts[0]!.css}}`);
    pts.forEach((x, i) => {
      const next = pts[i + 1];
      if (i > 0 && x.p === pts[i - 1]!.p) return;
      frames.push(`${+x.p.toFixed(3)}%{${x.css}${next?.e ? `;animation-timing-function:${next.e}` : ""}}`);
    });
    if (pts[pts.length - 1]!.p < 100) frames.push(`100%{${pts[pts.length - 1]!.css}}`);
    this.rules.push(`@keyframes ${id}{${frames.join("")}}.${id}{animation:${id} ${this.T}s linear 0s 1 normal both paused}`);
    return id;
  }
  css(): string {
    return this.rules.join("\n");
  }
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
/** opacity + transform in one declaration. */
export const tf = (o: number, x = 0, y = 0, s = 1, rot = 0) => `opacity:${o};transform:translate3d(${r1(x)}px,${r1(y)}px,0) scale(${+s.toFixed(4)})${rot ? ` rotate(${r1(rot)}deg)` : ""}`;

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2", ".woff": "font/woff", ".mp4": "video/mp4" };
const uriCache = new Map<string, string>();
/** A local file as a data URI (renders never touch the network). */
export function fileUri(path: string | null | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) return null;
  const hit = uriCache.get(path);
  if (hit) return hit;
  const v = `data:${mime};base64,${readFileSync(path).toString("base64")}`;
  if (uriCache.size > 64) uriCache.clear();
  uriCache.set(path, v);
  return v;
}

/** Only #rrggbb gets into CSS. */
export const color = (c: string | null | undefined, d: string) => (c && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : d);

/** The app's own fonts, embedded (families "Display" and "Body"), with system fallbacks. */
export function fontCss(kit: Pick<ResolvedKit, "displayFont" | "bodyFont">): string {
  const face = (name: string, f: ResolvedKit["displayFont"]) => {
    const uri = fileUri(f.file);
    return uri ? `@font-face{font-family:"${name}";src:url("${uri}");font-weight:100 1000;font-display:block}` : "";
  };
  return `${face("Display", kit.displayFont)}${face("Body", kit.bodyFont)}`;
}
const safeFamily = (s: string) => s.replace(/[^\w .-]/g, "").trim();
export const displayStack = (kit: Pick<ResolvedKit, "displayFont">) => `"Display","${safeFamily(kit.displayFont.family)}",Inter,"Helvetica Neue",Arial,sans-serif`;
export const bodyStack = (kit: Pick<ResolvedKit, "bodyFont">) => `"Body","${safeFamily(kit.bodyFont.family)}",Inter,"Helvetica Neue",Arial,sans-serif`;

/**
 * Text fitting in the page (before the first frame): elements with
 * data-fit shrink until their text fits the box without breaking a word —
 * long German compounds included. Then every animation is paused.
 */
const FIT_SCRIPT = `
window.__fit = () => {
  for (const el of document.querySelectorAll('[data-fit]')) {
    const min = Number(el.dataset.min || 24);
    let size = parseFloat(getComputedStyle(el).fontSize);
    const box = el.parentElement.dataset.fitBox ? el.parentElement : el;
    const maxH = Number(el.dataset.maxh || 0) || box.clientHeight;
    const fits = () => {
      if (el.scrollWidth > el.clientWidth + 1) return false;
      if (maxH && el.scrollHeight > maxH + 1) return false;
      for (const w of el.querySelectorAll('.w,.cw')) if (w.offsetWidth > el.clientWidth + 1) return false;
      return true;
    };
    let guard = 0;
    while (!fits() && size > min && guard++ < 80) { size -= 2; el.style.fontSize = size + 'px'; }
  }
};
window.__layout = () => [...document.querySelectorAll('[data-text]')].map((el) => {
  const range = document.createRange(); range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  const cs = getComputedStyle(el);
  let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity || 1);
  // Covered by a layer on top (a scene revealed over it) → not visible.
  const cx = Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2)), cy = Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2));
  const top = document.elementFromPoint(cx, cy);
  const onTop = !top || el.contains(top) || top.contains(el);
  return { role: el.dataset.text, x: r.x, y: r.y, w: r.width, h: r.height, px: parseFloat(cs.fontSize), visible: o > 0.5 && r.width > 0 && onTop, text: (el.textContent || '').trim().slice(0, 120) };
});`;

export type Doc = { W: number; H: number; lang: string; css: string; body: string; kit: Pick<ResolvedKit, "displayFont" | "bodyFont" | "background">; timeline?: Timeline };

export function docHtml(d: Doc): string {
  return `<!doctype html><html lang="${esc(d.lang)}"><head><meta charset="utf-8"><style>
${fontCss(d.kit)}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${d.W}px;height:${d.H}px;overflow:hidden;background:${color(d.kit.background, "#ffffff")}}
body{position:relative;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;font-kerning:normal}
.abs{position:absolute}
.w,.cw{display:inline-block;white-space:nowrap}
img{display:block}
${d.css}
${d.timeline?.css() ?? ""}
</style></head><body>${d.body}<script>${FIT_SCRIPT}</script></body></html>`;
}

// ---------------------------------------------------------------- rendering

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>, browser?: Browser): Promise<T> {
  if (browser) return fn(browser);
  const exe = chromiumPath();
  const b = await chromium.launch(exe ? { executablePath: exe, args: ["--font-render-hinting=none"] } : { args: ["--font-render-hinting=none"] });
  try {
    return await fn(b);
  } finally {
    await b.close().catch(() => {});
  }
}

export async function openDoc(b: Browser, html: string, W: number, H: number): Promise<Page> {
  const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // No network: everything is inline (fonts, screens, icons are data URIs).
  await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((im) => im.decode().catch(() => {})));
    (window as unknown as { __fit: () => void }).__fit();
    for (const a of document.getAnimations()) a.pause();
  });
  return page;
}

export async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate(async (ms: number) => {
    for (const a of document.getAnimations()) a.currentTime = ms;
    // Compositions with per-frame media (b-roll video frames) swap them here.
    const hook = (window as unknown as { __onSeek?: (t: number) => Promise<void> | void }).__onSeek;
    if (hook) await hook(ms / 1000);
  }, Math.round(t * 1000));
}

export type TextBox = { role: string; x: number; y: number; w: number; h: number; px: number; visible: boolean; text: string };

/** Where the text is at `t` (for the layout checks of the critique). */
export async function layoutAt(page: Page, t: number): Promise<TextBox[]> {
  await seek(page, t);
  return page.evaluate(() => (window as unknown as { __layout: () => TextBox[] }).__layout());
}

/** A still (JPEG for .jpg, else PNG); with `t`, the composition's frame at that time. */
export async function renderStill(o: { html: string; W: number; H: number; out: string; t?: number; browser?: Browser; layout?: boolean }): Promise<{ file: string; layout: TextBox[] }> {
  return withBrowser(async (b) => {
    const page = await openDoc(b, o.html, o.W, o.H);
    try {
      const layout = o.layout ? await layoutAt(page, o.t ?? 0) : (await seek(page, o.t ?? 0), []);
      const jpg = /\.jpe?g$/i.test(o.out);
      await page.screenshot({ path: o.out, type: jpg ? "jpeg" : "png", ...(jpg ? { quality: 92 } : {}), animations: "allow", caret: "initial" });
      return { file: o.out, layout };
    } finally {
      await page.close().catch(() => {});
    }
  }, o.browser);
}

export type VideoRender = { file: string; seconds: number; layout: Array<{ t: number; boxes: TextBox[] }> };

/**
 * The composition as a silent H.264 MP4 (yuv420p, `fps`, faststart) — the
 * sound is mixed in afterwards (audio.ts). `layoutAt` samples text
 * positions at those times for the critique.
 */
export async function renderVideo(o: { html: string; W: number; H: number; seconds: number; out: string; fps?: number; browser?: Browser; layoutAt?: number[] }): Promise<VideoRender> {
  const fps = Math.max(1, Math.min(60, Math.round(o.fps ?? 30)));
  const frames = Math.round(o.seconds * fps);
  return withBrowser(async (b) => {
    const page = await openDoc(b, o.html, o.W, o.H);
    const layout: VideoRender["layout"] = [];
    for (const t of o.layoutAt ?? []) layout.push({ t, boxes: await layoutAt(page, t) });
    const ff = spawn(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-vf", "scale=in_range=full:out_range=tv,format=yuv420p,setsar=1", "-t", String(o.seconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart", o.out],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let err = "";
    ff.stderr.on("data", (d) => (err += String(d)));
    const done = new Promise<void>((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`))));
    });
    done.catch(() => {});
    const cdp = await page.context().newCDPSession(page);
    try {
      for (let f = 0; f < frames; f++) {
        await seek(page, f / fps);
        const { data } = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 94, optimizeForSpeed: true } as never)) as { data: string };
        if (ff.exitCode !== null) break;
        if (!ff.stdin.write(Buffer.from(data, "base64"))) await new Promise((r) => ff.stdin.once("drain", r));
      }
    } finally {
      ff.stdin.end();
      await page.close().catch(() => {});
    }
    await done;
    return { file: o.out, seconds: o.seconds, layout };
  }, o.browser);
}

/** Runs ffmpeg with arguments; rejects with its last error lines. */
export async function ffmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-300)}`))));
  });
}
