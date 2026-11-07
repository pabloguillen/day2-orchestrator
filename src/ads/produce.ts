import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { chromiumPath } from "../simulation";
import type { AssetStore, StoredAsset } from "./assets";
import { composeVideoAd, coverFrom, download, normalizeVideo, probe, recordPage, renderImageAd, screenshotPage, SIZE, type Brand } from "./content";
import type { AdCopyPlan } from "./copy";
import { captureScreens, pickTemplate, renderMotionAd } from "./motion";
import type { VideoProvider } from "./providers/video";
import type { AssetSpec, PlatformInfo, Ratio } from "./types";

/**
 * Makes the content for one experiment, for the platforms it will run on:
 *
 *  - images: the app's real page on a phone, in a branded frame, one per
 *    image format needed, per copy variant;
 *  - videos: a real screen recording of the page in the same frame, one per
 *    video format needed (first variant);
 *  - Motion videos (motion.ts): kinetic text + the app's real screenshots on
 *    a phone + CTA end card, rendered in-house — per variant and video
 *    format, at most MAX_MOTION_VIDEOS;
 *  - AI presenter video, from the creator tool picked for it (Creatify,
 *    HeyGen — docs/creator-tools.md), when the script passed both checks:
 *    9:16, plus 1:1 when needed;
 *  - generated motion shot of the 9:16 image (Runway, Luma, Google), when a
 *    creator tool may be used.
 *
 * Every file is stored as an Asset (served by day2) and labelled with what
 * made it. Generation costs are returned so the caller can bill them.
 */

/** `costUsd`: still to be billed by the caller; `prebilledUsd`: generations the creator tools already charged. */
export type Produced = { assets: Array<{ asset: StoredAsset; variant: number }>; costUsd: number; prebilledUsd?: number; notes: string[] };

export type ProduceInput = {
  appId: string;
  purpose: string; // the bet id
  pageUrl: string; // the landing page, untracked
  brand: Brand;
  copy: AdCopyPlan;
  platforms: PlatformInfo[];
  store: AssetStore;
  /** The creator tool picked for each kind of generated video (src/creative/kit.ts kitVideoProvider). */
  providers: { presenter?: VideoProvider | null; generated?: VideoProvider | null };
  /** Spend limit for generative video in this run, USD (0 = none). */
  generativeBudgetUsd: number;
  /** Don't make app walkthrough videos (they kept losing). */
  skipWalkthrough?: boolean;
  /** Don't make Motion videos. */
  skipMotion?: boolean;
  /** More same-origin pages of the app to show in Motion videos (read only: loaded, never tapped). */
  screens?: string[];
  /**
   * The app's real screens as image files (e.g. its App Store screenshots),
   * for apps without a web page: used instead of capturing `pageUrl`, and no
   * walkthrough recording is made.
   */
  screenshots?: string[];
  videoSeconds?: number;
  /** Motion video length (default 12 s) and render rate (default 30 fps; lower only for tests). */
  motionSeconds?: number;
  motionFps?: number;
};

/** Motion videos per experiment, at most. */
export const MAX_MOTION_VIDEOS = 4;

/** The image and video ratios the platforms need, most widely accepted first. */
export function neededRatios(platforms: PlatformInfo[]): { image: Ratio[]; video: Ratio[] } {
  const count = (kind: AssetSpec["kind"]) => {
    const m = new Map<Ratio, number>();
    for (const p of platforms) for (const r of new Set(p.formats.filter((f) => f.kind === kind).map((f) => f.ratio))) m.set(r, (m.get(r) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  };
  return { image: count("image"), video: count("video") };
}

export async function produceContent(i: ProduceInput): Promise<Produced> {
  const out: Produced = { assets: [], costUsd: 0, notes: [] };
  const need = neededRatios(i.platforms);
  const dir = mkdtempSync(join(tmpdir(), "day2-produce-"));
  const exe = chromiumPath();
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const seconds = i.videoSeconds ?? 14;
  const label = (what: string, r: Ratio, v?: number) => `${what} ${r}${v !== undefined ? ` · variant ${v + 1}` : ""}`;
  const store = async (file: string, meta: Parameters<AssetStore["put"]>[1], variant: number) => {
    const a = await i.store.put(file, meta);
    out.assets.push({ asset: a, variant });
    return a;
  };
  try {
    // The real page, as users see it.
    const shot = i.screenshots?.length ? i.screenshots[0]! : await screenshotPage(i.pageUrl, join(dir, "shot.png"), browser);

    // Images: every needed ratio, every variant.
    for (const [v, variant] of i.copy.variants.entries()) {
      for (const r of need.image) {
        const f = join(dir, `img-${v}-${r.replace(/[:.]/g, "x")}.jpg`);
        await renderImageAd(r, { headline: variant.frameHeadline, cta: variant.frameCta }, i.brand, shot, f, browser);
        const { w, h } = SIZE[r];
        await store(f, { appId: i.appId, purpose: i.purpose, label: label("App page image", r, v), kind: "image", ratio: r, width: w, height: h, mime: "image/jpeg", source: "screenshot", aiGenerated: false, aiPerson: false }, v);
      }
    }

    // Screen recording videos: every needed ratio, first variant's words.
    if (need.video.length && !i.skipWalkthrough && !i.screenshots?.length) {
      const v0 = i.copy.variants[0]!;
      const rec = await recordPage(i.pageUrl, dir, seconds, browser);
      for (const r of need.video) {
        const f = join(dir, `vid-${r.replace(/[:.]/g, "x")}.mp4`);
        await composeVideoAd(r, { headline: v0.frameHeadline, cta: v0.frameCta }, i.brand, rec, f, seconds, browser);
        const cover = await coverFrom(f, join(dir, `cover-${r.replace(/[:.]/g, "x")}.jpg`));
        const { w, h } = SIZE[r];
        const thumb = await i.store.put(cover, { appId: i.appId, purpose: i.purpose, label: label("Cover", r), kind: "image", ratio: r, width: w, height: h, mime: "image/jpeg", source: "screen_recording", aiGenerated: false, aiPerson: false });
        await store(f, { appId: i.appId, purpose: i.purpose, label: label("App walkthrough video", r), kind: "video", ratio: r, width: w, height: h, durationSec: seconds, mime: "video/mp4", source: "screen_recording", aiGenerated: false, aiPerson: false, thumbnailId: thumb.id }, 0);
      }
    }

    // Motion videos: per variant and video format (every format gets variant 1 first), in-house, no cost.
    if (need.video.length && !i.skipMotion) {
      try {
        const screens = i.screenshots?.length ? i.screenshots.slice(0, 4) : await captureScreens(i.pageUrl, dir, { screens: i.screens, landingShot: shot, browser });
        const jobs = i.copy.variants.flatMap((variant, v) => need.video.map((r) => ({ variant, v, r }))).slice(0, MAX_MOTION_VIDEOS);
        const mSeconds = i.motionSeconds ?? 12;
        for (const { variant, v, r } of jobs) {
          const what = label("Motion video", r, v);
          try {
            const tag = `${v}-${r.replace(/[:.]/g, "x")}`;
            const f = join(dir, `motion-${tag}.mp4`);
            await renderMotionAd({ ratio: r, template: pickTemplate(r, v), copy: variant, brand: i.brand, screenshots: screens, out: f, seconds: mSeconds, fps: i.motionFps, browser });
            const p = await probe(f);
            // Cover from the middle: phone and screens on show, not the half-built opening.
            const cover = await coverFrom(f, join(dir, `motion-cover-${tag}.jpg`), Math.round(mSeconds * 0.45 * 10) / 10);
            const { w, h } = SIZE[r];
            const thumb = await i.store.put(cover, { appId: i.appId, purpose: i.purpose, label: label("Cover", r, v), kind: "image", ratio: r, width: w, height: h, mime: "image/jpeg", source: "motion_template", aiGenerated: false, aiPerson: false });
            await store(f, { appId: i.appId, purpose: i.purpose, label: what, kind: "video", ratio: r, width: w, height: h, durationSec: p.durationSec, mime: "video/mp4", source: "motion_template", aiGenerated: false, aiPerson: false, costUsd: 0, thumbnailId: thumb.id }, v);
          } catch (err) {
            out.notes.push(`${what} failed: ${(err as Error).message.slice(0, 200)}`);
          }
        }
      } catch (err) {
        out.notes.push(`Motion videos failed: ${(err as Error).message.slice(0, 200)}`);
      }
    }

    // Generative video, within its budget.
    let budget = i.generativeBudgetUsd;
    const gen = async (provider: VideoProvider, job: Parameters<VideoProvider["generate"]>[0], ratios: Ratio[], what: string, aiGenerated: boolean) => {
      const est = provider.estimateUsd(job);
      if (est > budget) {
        out.notes.push(`${what} skipped: it would cost more than this run's budget for generated video.`);
        return;
      }
      try {
        const r = await provider.generate(job);
        budget -= r.costUsd;
        if (r.billed) out.prebilledUsd = (out.prebilledUsd ?? 0) + r.costUsd;
        else out.costUsd += r.costUsd;
        const raw = r.file ?? (await download(r.url, join(dir, `${provider.id}-${r.providerJobId}.mp4`), provider.id));
        for (const ratio of ratios) {
          const f = join(dir, `${provider.id}-${ratio.replace(/[:.]/g, "x")}.mp4`);
          await normalizeVideo(raw, ratio, f, { padColor: i.brand.colors[0], maxSeconds: 60 });
          const p = await probe(f);
          const cover = await coverFrom(f, join(dir, `${provider.id}-cover-${ratio.replace(/[:.]/g, "x")}.jpg`));
          const { w, h } = SIZE[ratio];
          const thumb = await i.store.put(cover, { appId: i.appId, purpose: i.purpose, label: label("Cover", ratio), kind: "image", ratio, width: w, height: h, mime: "image/jpeg", source: provider.id, aiGenerated, aiPerson: r.aiPerson });
          await store(f, { appId: i.appId, purpose: i.purpose, label: label(provider.name ? `${what} · ${provider.name}` : what, ratio), kind: "video", ratio, width: w, height: h, durationSec: p.durationSec, mime: "video/mp4", source: provider.id, aiGenerated, aiPerson: r.aiPerson, costUsd: r.costUsd / ratios.length, thumbnailId: thumb.id }, 0);
        }
      } catch (err) {
        out.notes.push(`${what} failed: ${(err as Error).message.slice(0, 200)}`);
      }
    };
    const presenterRatios = need.video.filter((r) => r === "9:16" || r === "1:1");
    if (i.providers.presenter && i.copy.script && presenterRatios.length) {
      await gen(i.providers.presenter, { kind: "avatar_ad", ratio: "9:16", durationSec: 30, script: i.copy.script, language: i.copy.languages[0], appName: i.brand.name }, presenterRatios, "AI presenter video", true);
    }
    const nine = out.assets.find((a) => a.asset.kind === "image" && a.asset.ratio === "9:16");
    if (i.providers.generated && nine && need.video.includes("9:16")) {
      await gen(
        i.providers.generated,
        { kind: "image_to_video", ratio: "9:16", durationSec: 5, imageUrl: `data:image/jpeg;base64,${readFileSync(nine.asset.path).toString("base64")}`, prompt: "Slow, steady camera push-in toward the phone; soft light; keep all text and the phone screen exactly as they are.", appName: i.brand.name },
        ["9:16"],
        "Generated motion video",
        true,
      );
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}
