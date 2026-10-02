import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { UploadedAsset } from "./design-references";

/**
 * Step 4 (self-distributing) extension — Tier 0 creative rendering: real
 * assets produced by Claude + deterministic browser automation, with zero
 * external generative-media vendor and zero markup-heavy SaaS middleman
 * (user-directed: "a content generation strategy which includes skills...
 * all without a SaaS intermediate").
 *
 * Deliberately NOT agent-invoking, unlike every other `query()`-based file
 * in this codebase. Rendering a known HTML template to an image, or
 * replaying a fixed, already-decided sequence of clicks/taps against the
 * real app, needs no LLM judgment at the point of execution — it's
 * mechanical, deterministic automation, same "pure/deterministic core,
 * agent-invoking pieces are a different file" split `spend-governance.ts`
 * established for its own domain. This is also the first *direct*
 * `import { chromium } from "playwright"` anywhere in `orchestrator/src` —
 * every prior use (`swarm.ts`) drives Playwright *through* an agent's own
 * sandboxed Bash access, appropriate there because persona testing needs
 * judgment; nothing here does.
 *
 * Two real capabilities, matching two of `Arm`'s existing asset shapes:
 *
 *   - `renderTemplateGraphic` — `assetType: "image"`. A branded graphic ad
 *     (quote-style, stat-callout, feature-announcement) authored as real
 *     HTML/CSS by Claude (the same skill exercised building the day2
 *     console's own design system), grounded in the app's *real* brand
 *     assets (`design-references.ts`'s `.day2-brand-assets/` uploads —
 *     logo, brand colors) rather than inventing them, then rasterized with
 *     a headless browser. This covers the same ground a template-driven
 *     image-ad library (e.g. Arcads' "37-template" library) sells as a
 *     paid feature — authored in-house instead.
 *
 *   - `captureProductDemo` — `assetType: "video"`, `videoFormat:
 *     "motion_graphics"`. A real screen-recording of the actual app
 *     performing a real, already-decided user flow (Playwright's own
 *     `recordVideo` context option) — genuine footage, not generated
 *     b-roll, which is *more* authentic, not less, and directly reinforces
 *     rather than fights `growth-creative.ts`'s own authenticity check.
 *
 * Deliberately NOT attempted here: `videoFormat: "ugc"` (a synthetic
 * presenter delivering a testimonial). That needs a licensed, consented
 * avatar identity no amount of local rendering can manufacture — the one
 * format this project's own research concluded still needs a real,
 * separately-metered external vendor (e.g. an avatar platform with its own
 * cleared roster), not a markup-stripping exercise. Scoped out on purpose,
 * not an oversight.
 *
 * Neither function here is wired into any orchestration path yet — same
 * disclosed, deliberately-unbuilt seam as `growth-execution.ts`'s own
 * `performLiveAction`: there is no orchestration script anywhere in this
 * codebase yet that decides *when* to call these versus resolving a real
 * `ToolBinding`. This file only provides the capability once that
 * orchestration exists; it does not create or modify any existing type
 * (`Creative`, `GrowthActionRecord`) to avoid guessing at that future
 * wiring's exact shape.
 */

export type BrandAssets = {
  /** Real, owner-uploaded files from `design-references.ts`'s
   * `.day2-brand-assets/` — never fabricated. Absent/empty is a normal,
   * honest state (falls back to the app's scanned `styleGuide` colors
   * with no logo), not an error. */
  logoPath?: string;
  /** Hex colors, most-important first — from the real onboarding scan's
   * `AppProfile.styleGuide.colors` or the owner's own design references. */
  colors: string[];
  fontFamily: string;
};

export type GraphicLayout = "quote" | "stat-callout" | "feature-announcement";

export type GraphicContent = {
  headline: string;
  body: string;
  /** Only meaningful for "stat-callout" — e.g. "19.5%", "4.8★". Ignored by
   * other layouts rather than erroring, so a caller can pass a full
   * `Creative` through without per-layout branching. */
  statValue?: string;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/** Real file, real bytes, inlined as a data URI — never a fabricated or
 * placeholder logo. Returns `null` (not a thrown error) for a missing/
 * unreadable file or an unrecognized extension, so a template render can
 * still proceed logo-less rather than fail outright over a cosmetic
 * asset. */
function logoDataUri(logoPath: string): string | null {
  if (!existsSync(logoPath)) return null;
  const mime = MIME_BY_EXT[extname(logoPath).toLowerCase()];
  if (!mime) return null;
  try {
    const bytes = readFileSync(logoPath);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Pure and unit-tested — the only part of this file that can be, and the
 * only part that actually needs to be: this is where real content (the
 * app's real brand colors, the app's real copy) either does or doesn't
 * end up in the output, which a screenshot-based test can't cheaply
 * assert on anyway. `renderTemplateGraphic` below is a thin, untested IO
 * wrapper around this, same split `onboarding.ts`'s `parseAppProfileFields`
 * vs `scanAppProfile` already established.
 */
export function buildBrandedGraphicHtml(layout: GraphicLayout, content: GraphicContent, brand: BrandAssets): string {
  const primary = brand.colors[0] ?? "#141414";
  const secondary = brand.colors[1] ?? "#6B6B6B";
  const logo = brand.logoPath ? logoDataUri(brand.logoPath) : null;
  const font = escapeHtml(brand.fontFamily || "system-ui, sans-serif");
  const headline = escapeHtml(content.headline);
  const body = escapeHtml(content.body);

  const logoMarkup = logo
    ? `<img src="${logo}" alt="" style="height:40px;width:auto;margin-bottom:24px;" />`
    : "";

  const bodyMarkup = (() => {
    if (layout === "quote") {
      return `
        <div style="font-size:22px;line-height:1.4;font-weight:600;max-width:820px;">&ldquo;${headline}&rdquo;</div>
        <div style="margin-top:20px;font-size:16px;color:${secondary};">${body}</div>`;
    }
    if (layout === "stat-callout") {
      const stat = content.statValue ? escapeHtml(content.statValue) : "";
      return `
        <div style="font-size:88px;font-weight:800;letter-spacing:-0.02em;color:${primary};">${stat}</div>
        <div style="margin-top:12px;font-size:26px;font-weight:600;max-width:760px;">${headline}</div>
        <div style="margin-top:10px;font-size:16px;color:${secondary};max-width:760px;">${body}</div>`;
    }
    return `
      <div style="font-size:40px;font-weight:700;letter-spacing:-0.01em;max-width:820px;">${headline}</div>
      <div style="margin-top:16px;font-size:18px;color:${secondary};max-width:760px;">${body}</div>`;
  })();

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;">
  <div style="width:1080px;height:1080px;box-sizing:border-box;padding:80px;display:flex;flex-direction:column;justify-content:center;font-family:${font};background:#ffffff;color:#141414;">
    ${logoMarkup}
    ${bodyMarkup}
  </div>
</body>
</html>`;
}

/** Real, owner-uploaded brand assets (`design-references.ts`) plus the
 * app's own scanned style guide, resolved down to what `buildBranded-
 * GraphicHtml` actually needs. The first uploaded asset with an image
 * extension is used as the logo — a small, disclosed v1 heuristic (no
 * `role: "logo"` field exists on `UploadedAsset` yet to pick one
 * unambiguously); absent any, renders logo-less rather than guessing at a
 * file that isn't a logo. */
export function resolveBrandAssets(
  uploadedAssets: UploadedAsset[],
  brandAssetsDir: string,
  styleGuideColors: string[] | undefined,
  fontFamily: string | undefined,
): BrandAssets {
  const logoAsset = uploadedAssets.find((a) => MIME_BY_EXT[extname(a.filename).toLowerCase()] !== undefined);
  return {
    logoPath: logoAsset ? `${brandAssetsDir}/${logoAsset.filename}` : undefined,
    colors: styleGuideColors && styleGuideColors.length > 0 ? styleGuideColors : ["#141414", "#6B6B6B"],
    fontFamily: fontFamily || "system-ui, sans-serif",
  };
}

/** Thin IO wrapper — zero unit coverage by nature (launches a real
 * browser), validated live. Renders at a fixed 1080x1080 (a standard
 * square social-ad crop) rather than taking an arbitrary viewport — every
 * layout in `buildBrandedGraphicHtml` is authored against that canvas. */
export async function renderTemplateGraphic(
  layout: GraphicLayout,
  content: GraphicContent,
  brand: BrandAssets,
  outputPath: string,
): Promise<void> {
  const html = buildBrandedGraphicHtml(layout, content, brand);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}

/**
 * Cheap variant generation (user-directed: "What we can learn from
 * Revnu... out-scale 'thousands of ad creative variants' on cost per
 * variant, not just match it"). `growth-allocator.ts`'s Thompson-sampling
 * bandit is architecturally built to benefit from more arms being tried —
 * `MIN_ARM_OBSERVATIONS = 5` only starts calling an arm "proven" after real
 * volume. A SaaS-middleman creative tool pays a per-generation markup for
 * volume; this pipeline's marginal cost per template-graphic variant is
 * just render time, since nothing here calls an external vendor. One real
 * `GraphicContent` in, several real `Arm`-ready variants out.
 */
export type GraphicVariantSpec = {
  layout: GraphicLayout;
  /** Distinct per spec, fed directly into an `Arm.formatTag` so the
   * allocator tracks each variant as its own arm — never two specs
   * sharing a tag, which would silently merge their stats. */
  formatTag: string;
  /** Swaps which brand color leads — `buildBrandedGraphicHtml` always
   * reads `colors[0]` as primary, so this is the only variant dimension
   * that needs the brand object itself, not just the layout. */
  swapColorOrder: boolean;
};

/** Pure, unit-tested. `stat-callout` is only planned when `content` has a
 * real `statValue` — generating it without one would render an empty
 * number (`buildBrandedGraphicHtml`'s own stat-callout branch has no
 * fallback for a missing stat, by design, since there's nothing honest to
 * show). Always includes at least one `swapColorOrder: false` variant per
 * layout; a second, color-swapped variant is only added when the brand
 * genuinely has 2+ colors to swap between — swapping a 1-color palette
 * would just render the identical graphic twice under two different arm
 * tags, double-counting a single real variant in the allocator. */
export function planGraphicVariants(content: GraphicContent, brand: BrandAssets): GraphicVariantSpec[] {
  const layouts: GraphicLayout[] = content.statValue ? ["quote", "stat-callout", "feature-announcement"] : ["quote", "feature-announcement"];
  const specs: GraphicVariantSpec[] = [];
  for (const layout of layouts) {
    specs.push({ layout, formatTag: `${layout}-a`, swapColorOrder: false });
    if (brand.colors.length >= 2) {
      specs.push({ layout, formatTag: `${layout}-b`, swapColorOrder: true });
    }
  }
  return specs;
}

function applyColorSwap(brand: BrandAssets, swap: boolean): BrandAssets {
  if (!swap || brand.colors.length < 2) return brand;
  return { ...brand, colors: [brand.colors[1]!, brand.colors[0]!, ...brand.colors.slice(2)] };
}

/** Thin IO wrapper — zero unit coverage by nature, validated live. Shares
 * ONE browser launch across every variant (open a page, screenshot, close
 * the page, repeat) rather than relaunching Chromium per variant like a
 * naive loop over `renderTemplateGraphic` would — the whole point of cheap
 * volume is not paying a fresh browser-launch cost for each one. */
export async function renderGraphicVariants(
  specs: GraphicVariantSpec[],
  content: GraphicContent,
  brand: BrandAssets,
  outputDir: string,
): Promise<Array<{ formatTag: string; path: string }>> {
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch();
  const results: Array<{ formatTag: string; path: string }> = [];
  try {
    for (const spec of specs) {
      const html = buildBrandedGraphicHtml(spec.layout, content, applyColorSwap(brand, spec.swapColorOrder));
      const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const path = join(outputDir, `${spec.formatTag}.png`);
        await page.screenshot({ path });
        results.push({ formatTag: spec.formatTag, path });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

export type DemoStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }
  | { action: "wait"; ms: number };

/** Pure — the only part of demo capture that can be unit-tested without a
 * real browser: given a step list, what Playwright calls would actually
 * run, in order. Kept separate from `captureProductDemo`'s real browser
 * driving so the step-to-action mapping itself has real coverage. */
export function describeDemoSteps(steps: DemoStep[]): string[] {
  return steps.map((step) => {
    switch (step.action) {
      case "goto":
        return `goto ${step.url}`;
      case "click":
        return `click ${step.selector}`;
      case "type":
        return `type "${step.text}" into ${step.selector}`;
      case "wait":
        return `wait ${step.ms}ms`;
    }
  });
}

/**
 * Thin IO wrapper — zero unit coverage by nature, validated live. Replays
 * an already-decided, fixed step sequence (never agent-driven at capture
 * time — the judgment of *what flow to demo* belongs upstream, to
 * whatever authors `steps`) against a real page, recording genuine screen
 * video via Playwright's own `recordVideo` context option. Playwright
 * writes the video to an auto-generated filename inside `recordVideo.dir`
 * and only finalizes it on `context.close()` — this function captures
 * that real path and renames it to the caller's `outputPath so the result
 * is a predictable, stable filename rather than Playwright's own generated
 * one.
 */
export async function captureProductDemo(
  steps: DemoStep[],
  outputPath: string,
  viewport: { width: number; height: number } = { width: 390, height: 844 },
): Promise<void> {
  const { mkdtempSync, renameSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const videoDir = mkdtempSync(join(tmpdir(), "day2-demo-capture-"));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport,
      recordVideo: { dir: videoDir, size: viewport },
    });
    const page = await context.newPage();
    for (const step of steps) {
      if (step.action === "goto") await page.goto(step.url);
      else if (step.action === "click") await page.click(step.selector);
      else if (step.action === "type") await page.fill(step.selector, step.text);
      else if (step.action === "wait") await page.waitForTimeout(step.ms);
    }
    const video = page.video();
    await context.close();
    if (!video) throw new Error("Playwright did not produce a video for this context — recordVideo may be misconfigured.");
    const recordedPath = await video.path();
    renameSync(recordedPath, outputPath);
  } finally {
    await browser.close();
    rmSync(videoDir, { recursive: true, force: true });
  }
}
