import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumPath } from "../simulation";
import { fileAssetStore } from "./assets";
import { frameLayout, probe, textOn } from "./content";
import type { AdCopyPlan } from "./copy";
import { neededRatios, produceContent } from "./produce";
import type { VideoProvider } from "./providers/video";
import type { PlatformInfo } from "./types";

/**
 * The content pipeline for real: a small app page, Chromium screenshots
 * and recordings, ffmpeg composition; a fake AI-presenter provider whose
 * "generated" video is a real clip of the wrong size (it must be fitted).
 */

const EXE = chromiumPath();
const FFMPEG = (() => {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const root = mkdtempSync(join(tmpdir(), "day2-produce-test-"));
let server: ReturnType<typeof Bun.serve>;
const clip = join(root, "clip.mp4");

beforeAll(() => {
  if (FFMPEG) execSync(`ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=size=640x360:rate=30 -t 3 -pix_fmt yuv420p ${clip}`);
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/clip.mp4") return new Response(Bun.file(clip));
      return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;margin:0">${Array.from({ length: 4 }, (_, i) => `<section style="padding:24px;min-height:400px"><h1>Section ${i + 1}</h1><p>${"Content. ".repeat(40)}</p></section>`).join("")}</body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const PLATFORMS = [
  { id: "tiktok", formats: [{ kind: "video", ratio: "9:16" }] },
  { id: "meta", formats: [{ kind: "video", ratio: "9:16" }, { kind: "image", ratio: "1:1" }, { kind: "video", ratio: "1:1" }] },
  { id: "linkedin", formats: [{ kind: "image", ratio: "1.91:1" }, { kind: "image", ratio: "1:1" }] },
] as unknown as PlatformInfo[];

const COPY: AdCopyPlan = {
  audience: "consumer",
  variants: [
    { headline: "Split a bill", shortHeadline: "Split a bill", body: "b", description: "d", cta: "sign_up", frameHeadline: "Split a dinner bill in 10 seconds", frameCta: "Try it", claims: [] },
    { headline: "Trips", shortHeadline: "Trips", body: "b", description: "d", cta: "sign_up", frameHeadline: "Trips without money talk", frameCta: "Try it", claims: [] },
  ],
  script: "Here's how a group settles a trip.",
  keywords: [],
  interests: [],
  countries: ["DE"],
  languages: ["de"],
};

describe("what to make", () => {
  test("the ratios the chosen platforms need, most shared first", () => {
    expect(neededRatios(PLATFORMS)).toEqual({ image: ["1:1", "1.91:1"], video: ["9:16", "1:1"] });
  });
  test("layout and contrast", () => {
    expect(textOn("#ffffff")).toBe("#111111");
    expect(textOn("#4f46e5")).toBe("#ffffff");
    const tall = frameLayout("9:16");
    expect(tall.text).toBe("top");
    expect(tall.screen.y + tall.screen.h).toBeLessThan(1920);
    const wide = frameLayout("16:9");
    expect(wide.text).toBe("side");
    expect(wide.screen.x + wide.screen.w).toBeLessThanOrEqual(1920);
  });
});

describe.skipIf(!EXE || !FFMPEG)("making the ads, for real", () => {
  test("images per variant and ratio, walkthrough and Motion videos per ratio with covers, an AI presenter fitted to size", async () => {
    const store = fileAssetStore(join(root, "assets"), "https://day2.example");
    let generated = 0;
    const creatify: VideoProvider = {
      id: "creatify",
      kinds: ["avatar_ad"],
      estimateUsd: () => 1,
      async generate(job) {
        generated++;
        expect(job).toMatchObject({ kind: "avatar_ad", script: COPY.script, language: "de" });
        // Creator tools hand over a file already on day2's disk (downloads from the tool go through creative/download.ts).
        const f = join(root, "clip-copy.mp4");
        copyFileSync(clip, f);
        return { url: "", file: f, aiPerson: true, costUsd: 0.99, providerJobId: "j1" };
      },
    };
    const r = await produceContent({
      appId: "app_p",
      purpose: "B-1",
      pageUrl: `http://localhost:${server.port}/`,
      brand: { name: "Buddy", colors: ["#4f46e5", "#a5b4fc"] },
      copy: COPY,
      platforms: PLATFORMS,
      store,
      providers: { presenter: creatify, generated: null },
      generativeBudgetUsd: 5,
      videoSeconds: 4,
      motionSeconds: 2,
      motionFps: 10,
    });
    expect(generated).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.99, 2);
    const by = (kind: string, source: string) => r.assets.filter((a) => a.asset.kind === kind && a.asset.source === source);
    expect(by("image", "screenshot").map((a) => `${a.asset.ratio}/${a.variant}`).sort()).toEqual(["1.91:1/0", "1.91:1/1", "1:1/0", "1:1/1"]);
    const walk = by("video", "screen_recording");
    expect(walk.map((a) => a.asset.ratio).sort()).toEqual(["1:1", "9:16"]);
    for (const w of walk) {
      const p = await probe(w.asset.path);
      expect([p.width, p.height]).toEqual([w.asset.width, w.asset.height]);
      expect(p.hasAudio).toBe(true);
      expect(w.asset.thumbnail?.kind).toBe("image");
    }
    // Motion videos: every variant × video ratio (4 = the cap), in-house, real screenshots, no AI.
    const motion = by("video", "motion_template");
    expect(motion.map((a) => `${a.asset.ratio}/${a.variant}`).sort()).toEqual(["1:1/0", "1:1/1", "9:16/0", "9:16/1"]);
    expect(motion.map((a) => a.asset.label)).toContain("Motion video 9:16 · variant 2");
    for (const m of motion) {
      expect(m.asset.aiGenerated || m.asset.aiPerson).toBe(false);
      expect(m.asset.costUsd).toBe(0);
      expect(m.asset.thumbnail?.kind).toBe("image");
      const p = await probe(m.asset.path);
      expect([p.width, p.height]).toEqual([m.asset.width, m.asset.height]);
      expect(p.hasAudio).toBe(true);
      expect(p.durationSec).toBeCloseTo(2, 0);
    }
    expect(r.notes.filter((n) => n.includes("Motion"))).toEqual([]);
    const presenter = by("video", "creatify");
    expect(presenter.map((a) => a.asset.ratio).sort()).toEqual(["1:1", "9:16"]);
    expect(presenter.every((a) => a.asset.aiPerson && a.asset.aiGenerated)).toBe(true);
    const p = await probe(presenter.find((a) => a.asset.ratio === "9:16")!.asset.path);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    // A real JPEG, not a placeholder.
    expect([...readFileSync(by("image", "screenshot")[0]!.asset.path).subarray(0, 2)]).toEqual([0xff, 0xd8]);
  }, 180_000);

  test("generated video is skipped when it would exceed its budget", async () => {
    const store = fileAssetStore(join(root, "assets2"), "https://day2.example");
    const pricey: VideoProvider = { id: "creatify", kinds: ["avatar_ad"], estimateUsd: () => 50, generate: async () => { throw new Error("must not run"); } };
    const r = await produceContent({ appId: "app_p", purpose: "B-2", pageUrl: `http://localhost:${server.port}/`, brand: { name: "Buddy", colors: ["#111111"] }, copy: COPY, platforms: [PLATFORMS[0]!], store, providers: { presenter: pricey, generated: null }, generativeBudgetUsd: 5, videoSeconds: 3, skipMotion: true });
    expect(r.notes[0]).toContain("skipped");
    expect(r.assets.some((a) => a.asset.source === "creatify")).toBe(false);
  }, 120_000);
});
