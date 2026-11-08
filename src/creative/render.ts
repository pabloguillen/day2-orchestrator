import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { addSound, type AudioPlan } from "./motion/audio";
import { ffmpeg, fileUri, openDoc, renderVideo, seek, withBrowser, type TextBox } from "./motion/engine";
import { TEMPLATES } from "./templates";
import type { Ratio, RenderInput, SlideComposition, TemplateId, VideoComposition } from "./templates/types";

/**
 * Renders a template for a shot list: the 9:16 video (with sound) and/or the
 * carousel slides (4:5 and 1:1), plus what the critique needs — sampled
 * frames and where every piece of text sat at those moments.
 */

export type RenderedVideo = { file: string; seconds: number; frames: Array<{ t: number; file: string; boxes: TextBox[] }>; cover: string };
export type RenderedSlides = { ratio: Ratio; files: string[]; boxes: TextBox[][] };
export type Rendered = { template: TemplateId; video: RenderedVideo | null; slides: RenderedSlides[] };

/** b-roll video frames as data URIs the page swaps per frame (pov-hook). */
async function brollFrames(file: string, dir: string, fps: number, seconds: number): Promise<string[]> {
  const out = join(dir, "broll");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await ffmpeg(["-i", file, "-t", String(seconds), "-vf", `fps=${fps},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`, "-q:v", "4", join(out, "f%04d.jpg")]);
  return readdirSync(out)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => fileUri(join(out, f))!)
    .filter(Boolean);
}

export async function renderVideoComposition(comp: VideoComposition, o: { dir: string; name: string; music?: string | null; broll?: string | null; browser?: Browser; fps?: number }): Promise<RenderedVideo> {
  mkdirSync(o.dir, { recursive: true });
  let html = comp.html;
  if (comp.brollFrames && o.broll) {
    const frames = await brollFrames(o.broll, o.dir, comp.brollFrames.fps, comp.seconds);
    if (frames.length) html = html.replace("</body>", `<script>window.__broll=${JSON.stringify(frames)};</script></body>`);
  }
  const silent = join(o.dir, `${o.name}.silent.mp4`);
  const r = await renderVideo({ html, W: comp.W, H: comp.H, seconds: comp.seconds, out: silent, fps: o.fps ?? 30, browser: o.browser, layoutAt: comp.sampleTimes });
  const plan: AudioPlan = { seconds: comp.seconds, cues: comp.cues, music: o.music ?? null };
  const file = join(o.dir, `${o.name}.mp4`);
  await addSound(silent, plan, file);
  rmSync(silent, { force: true });
  const frames: RenderedVideo["frames"] = [];
  for (const [n, s] of r.layout.entries()) {
    const f = join(o.dir, `${o.name}.frame${n}.jpg`);
    await ffmpeg(["-ss", s.t.toFixed(2), "-i", file, "-frames:v", "1", "-q:v", "3", f]);
    frames.push({ t: s.t, file: f, boxes: s.boxes });
  }
  return { file, seconds: comp.seconds, frames, cover: frames[0]?.file ?? file };
}

/** Each slide of the panorama as a JPEG (the page is one wide canvas; slide k is its k-th window). */
export async function renderSlideComposition(comp: SlideComposition, o: { dir: string; name: string; browser?: Browser }): Promise<RenderedSlides> {
  mkdirSync(o.dir, { recursive: true });
  return withBrowser(async (b) => {
    const page = await openDoc(b, comp.html, comp.W * comp.count, comp.H);
    try {
      await seek(page, 0);
      const files: string[] = [];
      const all = await page.evaluate(() => (window as unknown as { __layout: () => TextBox[] }).__layout());
      const boxes: TextBox[][] = Array.from({ length: comp.count }, () => []);
      for (const bx of all) {
        const k = Math.floor((bx.x + bx.w / 2) / comp.W);
        if (k >= 0 && k < comp.count) boxes[k]!.push({ ...bx, x: bx.x - k * comp.W });
      }
      for (let k = 0; k < comp.count; k++) {
        const f = join(o.dir, `${o.name}-${comp.ratio.replace(":", "x")}-${String(k + 1).padStart(2, "0")}.jpg`);
        await page.screenshot({ path: f, type: "jpeg", quality: 93, clip: { x: k * comp.W, y: 0, width: comp.W, height: comp.H } });
        files.push(f);
      }
      return { ratio: comp.ratio, files, boxes };
    } finally {
      await page.close().catch(() => {});
    }
  }, o.browser);
}

export async function renderTemplate(id: TemplateId, input: RenderInput, o: { dir: string; name: string; video?: boolean; ratios?: Ratio[]; music?: string | null; browser?: Browser; fps?: number }): Promise<Rendered> {
  const t = TEMPLATES[id];
  const out: Rendered = { template: id, video: null, slides: [] };
  return withBrowser(async (b) => {
    if (o.video !== false && t.video) {
      const broll = input.shots.broll !== null && input.broll[input.shots.broll]?.kind === "video" ? input.broll[input.shots.broll]!.file : null;
      out.video = await renderVideoComposition(t.video(input), { dir: o.dir, name: o.name, music: o.music, broll, browser: b, fps: o.fps });
    }
    if (t.slides) for (const r of o.ratios ?? ["4:5"]) out.slides.push(await renderSlideComposition(t.slides(input, r), { dir: o.dir, name: o.name, browser: b }));
    return out;
  }, o.browser);
}

/** A contact sheet (grid) of images, for reviews and the console gallery. */
export async function contactSheet(files: string[], out: string, o: { cols?: number; width?: number } = {}): Promise<string> {
  const cols = Math.max(1, Math.min(o.cols ?? files.length, files.length));
  const w = o.width ?? 360;
  const args: string[] = [];
  for (const f of files) args.push("-i", f);
  const scaled = files.map((_, k) => `[${k}:v]scale=${w}:-2,setsar=1,pad=${w + 16}:ih+16:8:8:color=0xf2f0ea[s${k}]`).join(";");
  const layout = files.map((_, k) => `${(k % cols) === 0 ? "0" : Array.from({ length: k % cols }, () => "w0").join("+")}_${Math.floor(k / cols) === 0 ? "0" : Array.from({ length: Math.floor(k / cols) }, () => "h0").join("+")}`).join("|");
  await ffmpeg([...args, "-filter_complex", `${scaled};${files.map((_, k) => `[s${k}]`).join("")}xstack=inputs=${files.length}:layout=${layout}:fill=0xf2f0ea[v]`, "-map", "[v]", "-frames:v", "1", "-q:v", "3", out]);
  return out;
}
