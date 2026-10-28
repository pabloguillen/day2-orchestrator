import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, devices, type Browser } from "playwright";
import { chromiumPath } from "../simulation";
import type { Ratio } from "./types";

/**
 * Turns an app into ad images and videos, without generative AI:
 *
 *  - a real screenshot of the app's page, on a phone, inside a branded
 *    frame with the headline and call to action — one image per format;
 *  - a real screen recording of the page (scrolling through it, never
 *    tapping or typing on the live app), composed into the same frame —
 *    one short video per format, with a cover image.
 *
 * Generated videos (Creatify, Runway) come in through `normalizeVideo`,
 * which fits any video to a format's exact size and encoding.
 * Rendering is HTML in Chromium; video is ffmpeg.
 */

export const SIZE: Record<Ratio, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "16:9": { w: 1920, h: 1080 },
  "1.91:1": { w: 1200, h: 628 },
  "2:3": { w: 1000, h: 1500 },
};

export type Brand = { name: string; colors: string[]; logoPath?: string; font?: string };
export type FrameCopy = { headline: string; cta: string };

/** HTML-escapes text from copy. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const dataUri = (path: string) => {
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" }[extname(path).toLowerCase()];
  return mime && existsSync(path) ? `data:${mime};base64,${readFileSync(path).toString("base64")}` : null;
};

/** Readable text on a brand color: dark or light. */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4 ? "#111111" : "#ffffff";
}

/**
 * Where the phone screen sits in a frame of this ratio, and the layout
 * around it. Pure: shared by image rendering and video composition.
 */
export function frameLayout(ratio: Ratio): { w: number; h: number; screen: { x: number; y: number; w: number; h: number }; text: "top" | "side" } {
  const { w, h } = SIZE[ratio];
  const wide = w / h >= 1;
  // The phone keeps the app's 390×844 proportions.
  const phoneAspect = 390 / 844;
  if (wide) {
    const sh = Math.round(h * 0.84);
    const sw = Math.round(sh * phoneAspect);
    const x = Math.round(w * (w / h > 1.2 ? 0.66 : 0.6));
    return { w, h, screen: { x: Math.min(x, w - sw - Math.round(w * 0.06)), y: Math.round((h - sh) / 2), w: sw, h: sh }, text: "side" };
  }
  const textBand = ratio === "4:5" || ratio === "2:3" ? 0.3 : 0.27;
  const sh = Math.round(h * (1 - textBand) * 0.9);
  const sw = Math.round(sh * phoneAspect);
  return { w, h, screen: { x: Math.round((w - sw) / 2), y: Math.round(h * textBand), w: sw, h: sh }, text: "top" };
}

/**
 * The frame as HTML. `screenshot` = a path: the full image ad.
 * "background": brand background and text only (video base layer).
 * "bezel": only the phone's rim, transparent elsewhere (video top layer,
 * which also rounds the recording's corners).
 */
export function frameHtml(ratio: Ratio, copy: FrameCopy, brand: Brand, screenshot: string | "background" | "bezel"): string {
  const layer = screenshot === "background" || screenshot === "bezel" ? screenshot : "image";
  const L = frameLayout(ratio);
  const bg = brand.colors[0] ?? "#141414";
  const accent = brand.colors[1] ?? textOn(bg);
  const fg = textOn(bg);
  const font = brand.font || "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const logo = brand.logoPath ? dataUri(brand.logoPath) : null;
  const bezel = Math.round(L.screen.w * 0.035);
  const radius = Math.round(L.screen.w * 0.12);
  const scale = L.w / 1080;
  const headSize = Math.round((L.text === "side" ? (L.w / L.h > 1.2 ? 72 : 60) : copy.headline.length > 40 ? 64 : 76) * scale);
  const textBox =
    L.text === "side"
      ? `left:${Math.round(L.w * 0.07)}px;top:0;bottom:0;width:${L.screen.x - Math.round(L.w * 0.12)}px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;`
      : `left:${Math.round(L.w * 0.08)}px;right:${Math.round(L.w * 0.08)}px;top:${Math.round(L.h * 0.045)}px;height:${L.screen.y - Math.round(L.h * 0.07)}px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${L.w}px;height:${L.h}px;background:transparent;overflow:hidden}
body{font-family:${font};color:${fg};position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(120% 90% at 20% 0%, ${accent}33 0%, transparent 60%), ${bg}}
.text{position:absolute;${textBox}gap:${Math.round(28 * scale)}px}
.brand{display:flex;align-items:center;gap:${Math.round(14 * scale)}px;font-weight:600;font-size:${Math.round(30 * scale)}px;opacity:.9}
.brand img{height:${Math.round(48 * scale)}px;width:auto;border-radius:${Math.round(10 * scale)}px}
h1{font-size:${headSize}px;line-height:1.05;font-weight:800;letter-spacing:-.02em}
.cta{display:inline-block;padding:${Math.round(20 * scale)}px ${Math.round(40 * scale)}px;border-radius:999px;background:${fg};color:${bg};font-weight:700;font-size:${Math.round(32 * scale)}px}
.shadow{position:absolute;left:${L.screen.x - bezel}px;top:${L.screen.y - bezel}px;width:${L.screen.w + 2 * bezel}px;height:${L.screen.h + 2 * bezel}px;border-radius:${radius + bezel}px;box-shadow:0 ${Math.round(30 * scale)}px ${Math.round(80 * scale)}px rgba(0,0,0,.35);background:#fff}
.phone{position:absolute;left:${L.screen.x - bezel}px;top:${L.screen.y - bezel}px;width:${L.screen.w + 2 * bezel}px;height:${L.screen.h + 2 * bezel}px;border-radius:${radius + bezel}px;border:${bezel}px solid #0b0b0c}
.screen{position:absolute;left:${L.screen.x}px;top:${L.screen.y}px;width:${L.screen.w}px;height:${L.screen.h}px;border-radius:${radius}px;overflow:hidden;background:#fff}
.screen img{width:100%;height:100%;object-fit:cover;object-position:top}
.wrap{position:absolute;inset:0${layer === "bezel" ? `;-webkit-mask:url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${L.w}' height='${L.h}'><path fill-rule='evenodd' d='M0 0H${L.w}V${L.h}H0Z M${L.screen.x + radius} ${L.screen.y}H${L.screen.x + L.screen.w - radius}A${radius} ${radius} 0 0 1 ${L.screen.x + L.screen.w} ${L.screen.y + radius}V${L.screen.y + L.screen.h - radius}A${radius} ${radius} 0 0 1 ${L.screen.x + L.screen.w - radius} ${L.screen.y + L.screen.h}H${L.screen.x + radius}A${radius} ${radius} 0 0 1 ${L.screen.x} ${L.screen.y + L.screen.h - radius}V${L.screen.y + radius}A${radius} ${radius} 0 0 1 ${L.screen.x + radius} ${L.screen.y}Z'/></svg>`)}") 0 0/100% 100% no-repeat` : ""}}
</style></head><body>
<div class="wrap">
<div class="bg"></div>
<div class="text">
  <div class="brand">${logo ? `<img src="${logo}" alt="">` : ""}<span>${esc(brand.name)}</span></div>
  <h1>${esc(copy.headline)}</h1>
  <span class="cta">${esc(copy.cta)}</span>
</div>
${layer === "background" ? "" : '<div class="shadow"></div>'}
${layer === "image" ? `<div class="screen"><img src="${dataUri(screenshot) ?? ""}" alt=""></div>` : ""}
${layer === "background" ? "" : '<div class="phone"></div>'}
</div>
</body></html>`;
}

/** A phone the size the frame's screen expects (390×844 CSS px). */
export const PHONE = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: `${devices["iPhone 13"].userAgent} day2-ads` };

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>, browser?: Browser): Promise<T> {
  if (browser) return fn(browser);
  const exe = chromiumPath();
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}

/** A phone-sized screenshot of a page of the live app. */
export async function screenshotPage(url: string, out: string, browser?: Browser): Promise<string> {
  return withBrowser(async (b) => {
    const ctx = await b.newContext({ ...PHONE, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out });
    await ctx.close();
    return out;
  }, browser);
}

/** The image ad for one format: the branded frame with the screenshot on the phone. */
export async function renderImageAd(ratio: Ratio, copy: FrameCopy, brand: Brand, screenshot: string, out: string, browser?: Browser): Promise<string> {
  return withBrowser(async (b) => {
    const { w, h } = SIZE[ratio];
    const page = await b.newPage({ viewport: { width: w, height: h } });
    await page.setContent(frameHtml(ratio, copy, brand, screenshot), { waitUntil: "load" });
    await page.screenshot({ path: out, type: out.endsWith(".jpg") ? "jpeg" : "png", ...(out.endsWith(".jpg") ? { quality: 90 } : {}) });
    await page.close();
    return out;
  }, browser);
}

/**
 * A screen recording of the page: load, pause, scroll smoothly to the end
 * and back. Reads only — nothing is tapped, typed or submitted.
 */
export async function recordPage(url: string, outDir: string, seconds = 14, browser?: Browser): Promise<string> {
  return withBrowser(async (b) => {
        // Recordings are at CSS size (Playwright ignores the pixel ratio); ffmpeg scales them up.
    const ctx = await b.newContext({ ...PHONE, recordVideo: { dir: outDir, size: PHONE.viewport } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(async (ms: number) => {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const step = async (from: number, to: number, dur: number) => {
        const t0 = performance.now();
        for (;;) {
          const k = Math.min(1, (performance.now() - t0) / dur);
          window.scrollTo(0, from + (to - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
          if (k >= 1) break;
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      await step(0, Math.min(max, window.innerHeight * 3), ms * 0.6);
      await new Promise((r) => setTimeout(r, ms * 0.1));
      await step(window.scrollY, 0, ms * 0.3);
    }, (seconds - 2) * 1000);
    await page.waitForTimeout(500);
    const video = page.video();
    await ctx.close();
    if (!video) throw new Error("No screen recording was produced.");
    return video.path();
  }, browser);
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`))));
  });
}

export const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart"];

/** A cover image from a video (1 second in, or `atSec`). */
export async function coverFrom(video: string, out: string, atSec = 1): Promise<string> {
  await ffmpeg(["-ss", String(atSec), "-i", video, "-frames:v", "1", "-q:v", "3", out]);
  return out;
}

/**
 * The video ad for one format: the branded frame (rendered once, with the
 * phone's screen left transparent) over the brand background, and the
 * screen recording playing on the phone. Silent audio track included
 * (some platforms require one). H.264/AAC MP4.
 */
export async function composeVideoAd(ratio: Ratio, copy: FrameCopy, brand: Brand, recording: string, out: string, seconds = 14, browser?: Browser): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "day2-compose-"));
  try {
    const L = frameLayout(ratio);
    const bgPng = join(dir, "bg.png");
    const framePng = join(dir, "frame.png");
    await withBrowser(async (b) => {
      const page = await b.newPage({ viewport: { width: L.w, height: L.h } });
      // Background and text below the recording; above it, the whole frame
      // with a phone-screen-shaped hole (which also rounds its corners).
      await page.setContent(frameHtml(ratio, copy, brand, "background"), { waitUntil: "load" });
      await page.screenshot({ path: bgPng });
      await page.setContent(frameHtml(ratio, copy, brand, "bezel"), { waitUntil: "load" });
      await page.screenshot({ path: framePng, omitBackground: true });
      await page.close();
    }, browser);
    const s = L.screen;
    await ffmpeg([
      "-loop", "1", "-i", bgPng,
      "-i", recording,
      "-loop", "1", "-i", framePng,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-filter_complex",
      `[1:v]scale=${s.w}:${s.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${s.w}:${s.h},setsar=1[rec];` +
        `[0:v][rec]overlay=${s.x}:${s.y}:shortest=1[mid];[mid][2:v]overlay=0:0:shortest=1,format=yuv420p[v]`,
      "-map", "[v]", "-map", "3:a",
      "-t", String(seconds),
      ...ENCODE,
      out,
    ]);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fits any video (e.g. from Creatify or Runway) to a format exactly: scaled and padded with the brand color, H.264/AAC, at most `maxSeconds`. */
export async function normalizeVideo(input: string, ratio: Ratio, out: string, opts: { padColor?: string; maxSeconds?: number } = {}): Promise<string> {
  const { w, h } = SIZE[ratio];
  const pad = (opts.padColor ?? "#000000").replace("#", "0x");
  await ffmpeg([
    "-i", input,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-filter_complex", `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${pad},setsar=1,format=yuv420p[v];[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    "-map", "[v]", "-map", "[a]",
    ...(opts.maxSeconds ? ["-t", String(opts.maxSeconds)] : []),
    "-shortest",
    ...ENCODE,
    out,
  ]).catch(async () =>
    // Inputs without an audio track: add silence instead of mixing.
    ffmpeg([
      "-i", input,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-filter_complex", `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${pad},setsar=1,format=yuv420p[v]`,
      "-map", "[v]", "-map", "1:a",
      ...(opts.maxSeconds ? ["-t", String(opts.maxSeconds)] : []),
      "-shortest",
      ...ENCODE,
      out,
    ]),
  );
  return out;
}

/** Duration, width and height of a video file (ffprobe). */
export async function probe(file: string): Promise<{ durationSec: number; width: number; height: number; hasAudio: boolean }> {
  const text = await new Promise<string>((resolve, reject) => {
    const p = spawn(process.env.FFPROBE_PATH ?? "ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe failed on ${file}`))));
  });
  const j = JSON.parse(text) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  return { durationSec: Math.round(Number(j.format.duration ?? 0) * 10) / 10, width: v?.width ?? 0, height: v?.height ?? 0, hasAudio: j.streams.some((s) => s.codec_type === "audio") };
}

/** Downloads a provider's result to a file. */
export async function download(url: string, out: string, doFetch: typeof fetch = fetch): Promise<string> {
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`Couldn't download the generated video (${res.status}).`);
  writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
  return out;
}
