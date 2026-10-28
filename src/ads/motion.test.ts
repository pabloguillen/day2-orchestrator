import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { chromiumPath } from "../simulation";
import { probe, SIZE } from "./content";
import { benefitLines, captureScreens, MOTION_TEMPLATES, motionHtml, motionSafeArea, pickTemplate, renderMotionAd, renderMotionStill, type MotionCopy, type MotionTemplate } from "./motion";
import type { Ratio } from "./types";

/**
 * Motion videos for real: a small app served locally, real Chromium
 * screenshots, frames stepped on one timeline, ffmpeg encoding.
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

const COPY: MotionCopy = {
  frameHeadline: "Split a dinner bill in 10 seconds",
  frameCta: "Try it free",
  headline: "Split bills without the maths",
  shortHeadline: "Split bills fast",
  body: "Add an expense, pick who was there, done. Everyone sees who owes what.",
  description: "One tap settles up the whole group.",
};
const BRAND = { name: "Buddy", colors: ["#4f46e5", "#a5b4fc"] };

describe("templates (pure)", () => {
  test("every ratio gets a template; variants rotate through the ones that suit it", () => {
    for (const r of Object.keys(SIZE) as Ratio[]) {
      const picks = new Set([0, 1, 2, 3].map((v) => pickTemplate(r, v)));
      for (const p of picks) expect(MOTION_TEMPLATES.find((t) => t.id === p)!.bestFor).toContain(r);
      expect(picks.size).toBeGreaterThan(1);
    }
    expect(pickTemplate("9:16", 0)).toBe("hook-reveal");
    expect(pickTemplate("16:9", 0)).toBe("split-benefits");
  });

  test("benefit lines are the copy's own sentences, deduplicated, never the headline again", () => {
    expect(benefitLines(COPY)).toEqual(["Add an expense, pick who was there, done", "Everyone sees who owes what", "One tap settles up the whole group"]);
    expect(benefitLines({ frameHeadline: "Split a bill", frameCta: "Go", body: "Split a bill.", description: "b" })).toEqual([]);
    expect(benefitLines({ frameHeadline: "Split a bill", frameCta: "Go", headline: "Trips without money talk" })).toEqual(["Trips without money talk"]);
  });

  test("everything from copy and brand is escaped; no network in the page; same input, same HTML", () => {
    const evil: MotionCopy = { frameHeadline: `<script>alert(1)</script> "fast"`, frameCta: "<img src=x onerror=alert(1)>", body: "Totally <b>safe</b> & sound sentence here." };
    for (const t of MOTION_TEMPLATES) {
      const html = motionHtml({ ratio: "9:16", template: t.id, copy: evil, brand: { name: "<script>x</script>", colors: ["red;}</style><script>", "#fff"], font: "x}</style><script>" }, screenshots: [], seconds: 4 });
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<b>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toMatch(/(src|href)=["']?https?:/i);
      expect(html).not.toMatch(/url\(\s*["']?https?:/i);
      expect(motionHtml({ ratio: "1:1", template: t.id, copy: COPY, brand: BRAND, screenshots: [], seconds: 6 })).toBe(motionHtml({ ratio: "1:1", template: t.id, copy: COPY, brand: BRAND, screenshots: [], seconds: 6 }));
    }
  });
});

const root = mkdtempSync(join(tmpdir(), "day2-motion-test-"));
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let screens: string[] = [];
const hits: string[] = [];

const appPage = (title: string, rows: number) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;margin:0;padding:20px;background:#f6f7fb"><h1>${title}</h1>${Array.from({ length: rows }, (_, i) => `<div style="background:#fff;border-radius:12px;padding:14px;margin:10px 0">Expense ${i + 1} <b style="float:right">€${(i + 1) * 7}.00</b></div>`).join("")}<button>Add expense</button></body></html>`;

describe.skipIf(!EXE || !FFMPEG)("rendering, for real", () => {
  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        hits.push(p);
        return new Response(appPage(p === "/settle" ? "Settle up" : "Lisbon trip", p === "/settle" ? 3 : 6), { headers: { "content-type": "text/html" } });
      },
    });
    browser = await chromium.launch({ executablePath: EXE! });
    const base = `http://localhost:${server.port}`;
    screens = await captureScreens(`${base}/`, root, { screens: [`${base}/settle`, "https://elsewhere.example/x", `${base}/`], browser });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("screens: the landing page plus same-origin pages only, as phone screenshots", () => {
    expect(screens.length).toBe(2);
    expect(hits.filter((h) => h === "/settle").length).toBe(1);
    for (const s of screens) expect([...readFileSync(s).subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  });

  for (const ratio of ["9:16", "1:1", "16:9"] as Ratio[]) {
    test(`${ratio}: exact size, audio track, the requested length`, async () => {
      const out = join(root, `m-${ratio.replace(":", "x")}.mp4`);
      const t0 = Date.now();
      await renderMotionAd({ ratio, template: pickTemplate(ratio, 0), copy: COPY, brand: BRAND, screenshots: screens, out, seconds: 2, fps: 10, browser });
      expect(existsSync(out)).toBe(true);
      const p = await probe(out);
      expect([p.width, p.height]).toEqual([SIZE[ratio].w, SIZE[ratio].h]);
      expect(p.hasAudio).toBe(true);
      expect(Math.abs(p.durationSec - 2)).toBeLessThanOrEqual(0.15);
      expect(Date.now() - t0).toBeLessThan(60_000);
    }, 90_000);
  }

  test("frames are deterministic: the same moment renders to the same pixels", async () => {
    for (const template of ["hook-reveal", "screens-carousel"] as MotionTemplate[]) {
      const a = join(root, `${template}-a.png`);
      const b = join(root, `${template}-b.png`);
      const i = { ratio: "9:16" as Ratio, template, copy: COPY, brand: BRAND, screenshots: screens, seconds: 6 };
      await renderMotionStill({ ...i, t: 3.3, out: a, browser });
      await renderMotionStill({ ...i, t: 3.3, out: b, browser });
      expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    }
  }, 60_000);

  test("visible text stays inside the safe area (away from TikTok/Reels overlays on 9:16)", async () => {
    for (const ratio of ["9:16", "4:5", "1:1", "16:9"] as Ratio[]) {
      for (const t of MOTION_TEMPLATES) {
        const { w, h } = SIZE[ratio];
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        await page.setContent(motionHtml({ ratio, template: t.id, copy: COPY, brand: BRAND, screenshots: screens, seconds: 12 }));
        const safe = motionSafeArea(ratio);
        for (const sec of [1, 3, 5, 7, 9, 11.5]) {
          const boxes = await page.evaluate((ms) => {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = ms;
            }
            const visible = (el: Element | null): number => (el && el instanceof HTMLElement ? Number(getComputedStyle(el).opacity) * visible(el.parentElement) : 1);
            return [...document.querySelectorAll(".hl,.cta,.li,.name")]
              .filter((el) => visible(el) > 0.05)
              .map((el) => {
                // The glyphs, not the (wider) block around them.
                const range = document.createRange();
                range.selectNodeContents(el);
                const r = el.classList.contains("cta") ? el.getBoundingClientRect() : range.getBoundingClientRect();
                return { text: el.textContent?.slice(0, 30), x: r.left, y: r.top, r: r.right, b: r.bottom };
              });
          }, sec * 1000);
          // Between two captions there's a short moment with no text; the end card always has some.
          if (sec === 11.5) expect(boxes.length).toBeGreaterThan(0);
          for (const b of boxes) {
            const inside = b.x >= safe.x - 2 && b.y >= safe.y - 2 && b.r <= safe.x + safe.w + 2 && b.b <= safe.y + safe.h + 2;
            if (!inside) throw new Error(`${ratio} ${t.id} @${sec}s: "${b.text}" at ${JSON.stringify(b)} is outside ${JSON.stringify(safe)}`);
          }
        }
        await page.close();
      }
    }
  }, 60_000);
});
