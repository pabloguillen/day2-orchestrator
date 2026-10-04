import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildDemoSteps,
  parseArgs,
  parseStepsJson,
  runDemo,
  runGraphic,
  type DemoArgs,
  type GraphicArgs,
} from "./growth-render-cli";
import type { BrandAssets, DemoStep, GraphicContent, GraphicLayout } from "./growth-render";

describe("parseArgs — graphic mode", () => {
  test("parses a full, valid graphic invocation", () => {
    const parsed = parseArgs([
      "graphic",
      "--layout",
      "quote",
      "--headline",
      "Track every dollar",
      "--body",
      "expense-buddy",
      "--output",
      "out.png",
      "--stat-value",
      "19.5%",
      "--colors",
      "#141414, #6B6B6B",
      "--font-family",
      "Inter",
      "--logo-path",
      "logo.png",
    ]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        mode: "graphic",
        layout: "quote",
        headline: "Track every dollar",
        body: "expense-buddy",
        statValue: "19.5%",
        colors: ["#141414", "#6B6B6B"],
        fontFamily: "Inter",
        logoPath: "logo.png",
        output: "out.png",
      },
    });
  });

  test("defaults colors to [] and fontFamily to '' when not given — real fallback stays growth-render.ts's job", () => {
    const parsed = parseArgs(["graphic", "--layout", "quote", "--headline", "h", "--body", "b", "--output", "out.png"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.args.mode === "graphic") {
      expect(parsed.args.colors).toEqual([]);
      expect(parsed.args.fontFamily).toBe("");
      expect(parsed.args.statValue).toBeUndefined();
      expect(parsed.args.logoPath).toBeUndefined();
    }
  });

  test("rejects an invalid --layout rather than passing it through", () => {
    const parsed = parseArgs(["graphic", "--layout", "bogus-layout", "--headline", "h", "--body", "b", "--output", "out.png"]);
    expect(parsed).toEqual({ ok: false, error: expect.stringContaining("--layout must be one of") });
  });

  test("rejects a missing --headline", () => {
    const parsed = parseArgs(["graphic", "--layout", "quote", "--body", "b", "--output", "out.png"]);
    expect(parsed).toEqual({ ok: false, error: "graphic mode requires --headline" });
  });

  test("rejects a missing --output", () => {
    const parsed = parseArgs(["graphic", "--layout", "quote", "--headline", "h", "--body", "b"]);
    expect(parsed).toEqual({ ok: false, error: "graphic mode requires --output" });
  });
});

describe("parseArgs — demo mode", () => {
  test("parses with --app-url only (no steps file needed to record just a load)", () => {
    const parsed = parseArgs(["demo", "--app-url", "https://expense-buddy.example.com", "--output", "out.webm"]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        mode: "demo",
        appUrl: "https://expense-buddy.example.com",
        stepsFile: undefined,
        output: "out.webm",
        viewportWidth: 390,
        viewportHeight: 844,
      },
    });
  });

  test("parses custom viewport dimensions", () => {
    const parsed = parseArgs([
      "demo",
      "--app-url",
      "https://a.example.com",
      "--output",
      "out.webm",
      "--viewport-width",
      "1280",
      "--viewport-height",
      "720",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.args.mode === "demo") {
      expect(parsed.args.viewportWidth).toBe(1280);
      expect(parsed.args.viewportHeight).toBe(720);
    }
  });

  test("rejects a missing --output", () => {
    const parsed = parseArgs(["demo", "--app-url", "https://a.example.com"]);
    expect(parsed).toEqual({ ok: false, error: "demo mode requires --output" });
  });

  test("rejects when neither --app-url nor --steps-file is given — nothing real to record", () => {
    const parsed = parseArgs(["demo", "--output", "out.webm"]);
    expect(parsed).toEqual({ ok: false, error: "demo mode requires --app-url and/or --steps-file" });
  });

  test("rejects a non-numeric --viewport-width", () => {
    const parsed = parseArgs(["demo", "--app-url", "https://a.example.com", "--output", "out.webm", "--viewport-width", "wide"]);
    expect(parsed).toEqual({ ok: false, error: "--viewport-width/--viewport-height must be numbers" });
  });
});

describe("parseArgs — unknown mode", () => {
  test("reports an honest error for an unrecognized first argument", () => {
    const parsed = parseArgs(["frobnicate"]);
    expect(parsed).toEqual({ ok: false, error: 'unknown mode "frobnicate" — expected "graphic" or "demo"' });
  });

  test("reports an honest error for no arguments at all", () => {
    const parsed = parseArgs([]);
    expect(parsed).toEqual({ ok: false, error: 'unknown mode "" — expected "graphic" or "demo"' });
  });
});

describe("buildDemoSteps", () => {
  test("a real --app-url becomes a leading goto step, before any file-supplied steps", () => {
    const steps = buildDemoSteps("https://a.example.com", [{ action: "click", selector: "#go" }]);
    expect(steps).toEqual([{ action: "goto", url: "https://a.example.com" }, { action: "click", selector: "#go" }]);
  });

  test("no --app-url means no goto step is fabricated — only the real file-supplied steps run", () => {
    const steps = buildDemoSteps(undefined, [{ action: "wait", ms: 10 }]);
    expect(steps).toEqual([{ action: "wait", ms: 10 }]);
  });

  test("neither appUrl nor file steps produces an empty, honest step list", () => {
    expect(buildDemoSteps(undefined, [])).toEqual([]);
  });
});

describe("parseStepsJson", () => {
  test("parses a real DemoStep[] JSON array", () => {
    const steps = parseStepsJson('[{"action":"click","selector":"#add"},{"action":"wait","ms":500}]');
    expect(steps).toEqual([{ action: "click", selector: "#add" }, { action: "wait", ms: 500 }]);
  });

  test("throws a descriptive error for a non-array JSON value, rather than silently coercing it", () => {
    expect(() => parseStepsJson('{"not":"an array"}')).toThrow("steps file must contain a JSON array");
  });

  test("throws (JSON.parse's own error) for genuinely malformed JSON", () => {
    expect(() => parseStepsJson("not json at all")).toThrow();
  });
});

describe("runGraphic — file-output logic, real browser call mocked out", () => {
  test("resolves the output path and forwards real args to the (mocked) renderer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-growth-render-cli-"));
    try {
      const args: GraphicArgs = {
        mode: "graphic",
        layout: "stat-callout",
        headline: "of users stay active",
        body: "Real, measured retention.",
        statValue: "19.5%",
        colors: ["#111111"],
        fontFamily: "Inter",
        logoPath: undefined,
        output: join(dir, "out.png"),
      };

      const calls: Array<{ layout: GraphicLayout; content: GraphicContent; brand: BrandAssets; outputPath: string }> = [];
      const mockRender = async (layout: GraphicLayout, content: GraphicContent, brand: BrandAssets, outputPath: string) => {
        calls.push({ layout, content, brand, outputPath });
        writeFileSync(outputPath, "fake-png-bytes");
      };

      const outputPath = await runGraphic(args, mockRender);

      expect(outputPath).toBe(resolve(args.output));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.layout).toBe("stat-callout");
      expect(calls[0]!.content).toEqual({ headline: "of users stay active", body: "Real, measured retention.", statValue: "19.5%" });
      expect(calls[0]!.brand).toEqual({ colors: ["#111111"], fontFamily: "Inter", logoPath: undefined });
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDemo — file-output logic, real browser call mocked out", () => {
  test("loads real steps from a steps file, prepends the app-url goto, writes the real output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-growth-render-cli-"));
    try {
      const stepsFile = join(dir, "steps.json");
      writeFileSync(stepsFile, JSON.stringify([{ action: "click", selector: "#add-expense" }]));

      const args: DemoArgs = {
        mode: "demo",
        appUrl: "https://expense-buddy.example.com",
        stepsFile,
        output: join(dir, "out.webm"),
        viewportWidth: 390,
        viewportHeight: 844,
      };

      const calls: Array<{ steps: DemoStep[]; outputPath: string; viewport: { width: number; height: number } }> = [];
      const mockCapture = async (steps: DemoStep[], outputPath: string, viewport: { width: number; height: number }) => {
        calls.push({ steps, outputPath, viewport });
        writeFileSync(outputPath, "fake-video-bytes");
      };

      const outputPath = await runDemo(args, mockCapture);

      expect(outputPath).toBe(resolve(args.output));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.steps).toEqual([
        { action: "goto", url: "https://expense-buddy.example.com" },
        { action: "click", selector: "#add-expense" },
      ]);
      expect(calls[0]!.viewport).toEqual({ width: 390, height: 844 });
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("works with --app-url only, no --steps-file — never reads a nonexistent file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-growth-render-cli-"));
    try {
      const args: DemoArgs = {
        mode: "demo",
        appUrl: "https://a.example.com",
        stepsFile: undefined,
        output: join(dir, "out.webm"),
        viewportWidth: 390,
        viewportHeight: 844,
      };

      let captured: DemoStep[] | undefined;
      const mockCapture = async (steps: DemoStep[], outputPath: string) => {
        captured = steps;
        writeFileSync(outputPath, "fake-video-bytes");
      };

      await runDemo(args, mockCapture);
      expect(captured).toEqual([{ action: "goto", url: "https://a.example.com" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
