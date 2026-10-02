import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrandedGraphicHtml, describeDemoSteps, planGraphicVariants, resolveBrandAssets } from "./growth-render";
import type { UploadedAsset } from "./design-references";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "day2-growth-render-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("buildBrandedGraphicHtml", () => {
  test("quote layout renders the real headline and body", () => {
    const html = buildBrandedGraphicHtml(
      "quote",
      { headline: "Track every dollar without the spreadsheet", body: "expense-buddy" },
      { colors: ["#141414", "#6B6B6B"], fontFamily: "Inter" },
    );
    expect(html).toContain("Track every dollar without the spreadsheet");
    expect(html).toContain("expense-buddy");
    expect(html).toContain("Inter");
  });

  test("stat-callout layout includes the real stat value", () => {
    const html = buildBrandedGraphicHtml(
      "stat-callout",
      { headline: "of users stay active past week one", body: "Real, measured retention.", statValue: "19.5%" },
      { colors: ["#141414"], fontFamily: "Inter" },
    );
    expect(html).toContain("19.5%");
    expect(html).toContain("of users stay active past week one");
  });

  test("feature-announcement layout ignores an irrelevant statValue rather than erroring", () => {
    const html = buildBrandedGraphicHtml(
      "feature-announcement",
      { headline: "New: bulk delete", body: "Clear out old expenses in one tap.", statValue: "99%" },
      { colors: ["#141414"], fontFamily: "Inter" },
    );
    expect(html).toContain("New: bulk delete");
    expect(html).not.toContain("99%");
  });

  test("escapes HTML-significant characters in real copy rather than injecting raw markup", () => {
    const html = buildBrandedGraphicHtml(
      "quote",
      { headline: `<script>alert("x")</script>`, body: "safe" },
      { colors: ["#141414"], fontFamily: "Inter" },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("falls back to default colors and font when brand assets are sparse", () => {
    const html = buildBrandedGraphicHtml("quote", { headline: "h", body: "b" }, { colors: [], fontFamily: "" });
    expect(html).toContain("#141414");
    expect(html).toContain("system-ui");
  });

  test("renders no <img> tag when no logo is configured", () => {
    const html = buildBrandedGraphicHtml("quote", { headline: "h", body: "b" }, { colors: ["#141414"], fontFamily: "Inter" });
    expect(html).not.toContain("<img");
  });

  test("inlines a real logo file as a data URI when configured", () => {
    withTmpDir((dir) => {
      const logoPath = join(dir, "logo.png");
      // Minimal real PNG bytes (1x1 transparent pixel) — real file, not a stub string.
      const onePixelPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      writeFileSync(logoPath, onePixelPng);
      const html = buildBrandedGraphicHtml("quote", { headline: "h", body: "b" }, { colors: ["#141414"], fontFamily: "Inter", logoPath });
      expect(html).toContain("<img src=\"data:image/png;base64,");
    });
  });

  test("omits the logo (not throwing) when the configured logo file doesn't exist", () => {
    const html = buildBrandedGraphicHtml(
      "quote",
      { headline: "h", body: "b" },
      { colors: ["#141414"], fontFamily: "Inter", logoPath: "/definitely/does/not/exist.png" },
    );
    expect(html).not.toContain("<img");
  });
});

describe("resolveBrandAssets", () => {
  test("picks the first image-extension uploaded asset as the logo", () => {
    const assets: UploadedAsset[] = [
      { filename: "brand-notes.pdf", description: "notes", uploadedAt: "2026-01-01T00:00:00.000Z" },
      { filename: "logo.png", description: "logo", uploadedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const brand = resolveBrandAssets(assets, "/repo/.day2-brand-assets", ["#111111"], "Inter");
    expect(brand.logoPath).toBe("/repo/.day2-brand-assets/logo.png");
    expect(brand.colors).toEqual(["#111111"]);
    expect(brand.fontFamily).toBe("Inter");
  });

  test("renders logo-less when no uploaded asset has an image extension", () => {
    const assets: UploadedAsset[] = [{ filename: "notes.txt", description: "notes", uploadedAt: "2026-01-01T00:00:00.000Z" }];
    const brand = resolveBrandAssets(assets, "/repo/.day2-brand-assets", ["#111111"], "Inter");
    expect(brand.logoPath).toBeUndefined();
  });

  test("falls back to default colors/font when the app has no scanned style guide yet", () => {
    const brand = resolveBrandAssets([], "/repo/.day2-brand-assets", undefined, undefined);
    expect(brand.colors.length).toBeGreaterThan(0);
    expect(brand.fontFamily.length).toBeGreaterThan(0);
  });
});

describe("describeDemoSteps", () => {
  test("describes each step type in order, matching what captureProductDemo would actually run", () => {
    const steps = describeDemoSteps([
      { action: "goto", url: "https://expense-buddy.example.com" },
      { action: "click", selector: "#add-expense" },
      { action: "type", selector: "#amount", text: "12.50" },
      { action: "wait", ms: 500 },
    ]);
    expect(steps).toEqual([
      "goto https://expense-buddy.example.com",
      "click #add-expense",
      'type "12.50" into #amount',
      "wait 500ms",
    ]);
  });

  test("an empty step list describes to an empty list, not an error", () => {
    expect(describeDemoSteps([])).toEqual([]);
  });
});

describe("planGraphicVariants", () => {
  test("skips stat-callout when content has no statValue", () => {
    const specs = planGraphicVariants({ headline: "h", body: "b" }, { colors: ["#111111", "#222222"], fontFamily: "Inter" });
    expect(specs.some((s) => s.layout === "stat-callout")).toBe(false);
    expect(specs.some((s) => s.layout === "quote")).toBe(true);
    expect(specs.some((s) => s.layout === "feature-announcement")).toBe(true);
  });

  test("includes stat-callout when content has a real statValue", () => {
    const specs = planGraphicVariants({ headline: "h", body: "b", statValue: "42%" }, { colors: ["#111111", "#222222"], fontFamily: "Inter" });
    expect(specs.some((s) => s.layout === "stat-callout")).toBe(true);
  });

  test("every formatTag is unique — never two specs silently merging allocator stats", () => {
    const specs = planGraphicVariants({ headline: "h", body: "b", statValue: "42%" }, { colors: ["#111111", "#222222"], fontFamily: "Inter" });
    const tags = specs.map((s) => s.formatTag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test("does not generate a color-swapped variant when the brand has fewer than 2 colors", () => {
    const specs = planGraphicVariants({ headline: "h", body: "b" }, { colors: ["#111111"], fontFamily: "Inter" });
    expect(specs.every((s) => s.swapColorOrder === false)).toBe(true);
  });

  test("generates both a base and a color-swapped variant per layout when 2+ colors are available", () => {
    const specs = planGraphicVariants({ headline: "h", body: "b" }, { colors: ["#111111", "#222222"], fontFamily: "Inter" });
    const quoteVariants = specs.filter((s) => s.layout === "quote");
    expect(quoteVariants).toHaveLength(2);
    expect(quoteVariants.some((s) => s.swapColorOrder)).toBe(true);
    expect(quoteVariants.some((s) => !s.swapColorOrder)).toBe(true);
  });

  test("an empty colors array (no brand assets scanned yet) still plans variants without crashing", () => {
    const specs = planGraphicVariants({ headline: "h", body: "b" }, { colors: [], fontFamily: "Inter" });
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((s) => s.swapColorOrder === false)).toBe(true);
  });
});
