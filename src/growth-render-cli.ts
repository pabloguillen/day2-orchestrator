import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureProductDemo,
  renderTemplateGraphic,
  type BrandAssets,
  type DemoStep,
  type GraphicContent,
  type GraphicLayout,
} from "./growth-render";

/**
 * CLI for `growth-render.ts`'s two real rendering capabilities — the first
 * real caller for `renderTemplateGraphic` (HTML/CSS template -> branded
 * graphic image) and `captureProductDemo` (real Playwright screen-recording
 * of the live app) anywhere in this codebase; that file's own header used
 * to say neither function was wired into any orchestration path yet. Same
 * "do a real thing against real inputs, write a real result to disk" shape
 * as `growth-digest-cli.ts`, not `design-references-cli.ts`'s read/mutate-
 * config shape — there's no persisted config here, just one real rendering
 * invocation per run.
 *
 * Usage:
 *   bun run src/growth-render-cli.ts graphic --layout quote|stat-callout|feature-announcement \
 *     --headline "..." --body "..." --output out.png \
 *     [--stat-value "19.5%"] [--colors "#141414,#6B6B6B"] [--font-family "Inter"] [--logo-path logo.png]
 *
 *   bun run src/growth-render-cli.ts demo --output out.webm \
 *     [--app-url https://your-app.example.com] [--steps-file steps.json] \
 *     [--viewport-width 390] [--viewport-height 844]
 *
 * `--app-url`, if given, becomes a real leading `goto` step; `--steps-file`
 * (if given) is a JSON file holding a real `DemoStep[]` to run after it,
 * e.g.:
 *   [{"action":"click","selector":"#add-expense"},{"action":"type","selector":"#amount","text":"12.50"},{"action":"wait","ms":500}]
 * At least one of the two is required — otherwise there is no real flow to
 * record.
 */

export const GRAPHIC_LAYOUTS: readonly GraphicLayout[] = ["quote", "stat-callout", "feature-announcement"];

export type GraphicArgs = {
  mode: "graphic";
  layout: GraphicLayout;
  headline: string;
  body: string;
  statValue?: string;
  /** `[]` (not a hardcoded default) when `--colors` isn't given — real
   * fallback colors are `buildBrandedGraphicHtml`'s own job
   * (growth-render.ts), not duplicated here. */
  colors: string[];
  /** `""` when `--font-family` isn't given, same "let the real function own
   * its own fallback" reasoning as `colors` above. */
  fontFamily: string;
  logoPath?: string;
  output: string;
};

export type DemoArgs = {
  mode: "demo";
  appUrl?: string;
  stepsFile?: string;
  output: string;
  viewportWidth: number;
  viewportHeight: number;
};

export type ParsedArgs = { ok: true; args: GraphicArgs | DemoArgs } | { ok: false; error: string };

/** Pure — real argument parsing/validation, split out from `main` so it's
 * testable without touching `process.argv`/`process.exit`, same
 * "returns an honest result, caller decides how to fail" shape as
 * `health-scout-cli.ts`'s own `loadAppConfigs`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [mode, ...rest] = argv;
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i === -1 ? undefined : rest[i + 1];
  };

  if (mode === "graphic") {
    const layout = get("--layout");
    if (!layout || !(GRAPHIC_LAYOUTS as readonly string[]).includes(layout)) {
      return { ok: false, error: `--layout must be one of: ${GRAPHIC_LAYOUTS.join(", ")}` };
    }
    const headline = get("--headline");
    if (!headline) return { ok: false, error: "graphic mode requires --headline" };
    const body = get("--body");
    if (!body) return { ok: false, error: "graphic mode requires --body" };
    const output = get("--output");
    if (!output) return { ok: false, error: "graphic mode requires --output" };

    const colorsArg = get("--colors");
    return {
      ok: true,
      args: {
        mode: "graphic",
        layout: layout as GraphicLayout,
        headline,
        body,
        statValue: get("--stat-value"),
        colors: colorsArg ? colorsArg.split(",").map((c) => c.trim()).filter(Boolean) : [],
        fontFamily: get("--font-family") ?? "",
        logoPath: get("--logo-path"),
        output,
      },
    };
  }

  if (mode === "demo") {
    const output = get("--output");
    if (!output) return { ok: false, error: "demo mode requires --output" };
    const appUrl = get("--app-url");
    const stepsFile = get("--steps-file");
    if (!appUrl && !stepsFile) return { ok: false, error: "demo mode requires --app-url and/or --steps-file" };

    const viewportWidth = Number(get("--viewport-width") ?? 390);
    const viewportHeight = Number(get("--viewport-height") ?? 844);
    if (Number.isNaN(viewportWidth) || Number.isNaN(viewportHeight)) {
      return { ok: false, error: "--viewport-width/--viewport-height must be numbers" };
    }

    return { ok: true, args: { mode: "demo", appUrl, stepsFile, output, viewportWidth, viewportHeight } };
  }

  return { ok: false, error: `unknown mode "${mode ?? ""}" — expected "graphic" or "demo"` };
}

function usage(error?: string): never {
  if (error) console.error(`[day2-growth-render] ${error}\n`);
  console.error(
    "Usage:\n" +
      "  bun run src/growth-render-cli.ts graphic --layout quote|stat-callout|feature-announcement \\\n" +
      '    --headline "..." --body "..." --output out.png \\\n' +
      '    [--stat-value "19.5%"] [--colors "#141414,#6B6B6B"] [--font-family "Inter"] [--logo-path logo.png]\n\n' +
      "  bun run src/growth-render-cli.ts demo --output out.webm \\\n" +
      "    [--app-url https://your-app.example.com] [--steps-file steps.json] \\\n" +
      "    [--viewport-width 390] [--viewport-height 844]",
  );
  process.exit(1);
}

/** Pure. Real leading `goto` step from a real `--app-url`, followed by
 * whatever real steps `--steps-file` contributed — the exact order an
 * operator would expect their demo to run in. */
export function buildDemoSteps(appUrl: string | undefined, stepsFromFile: DemoStep[]): DemoStep[] {
  const steps: DemoStep[] = [];
  if (appUrl) steps.push({ action: "goto", url: appUrl });
  steps.push(...stepsFromFile);
  return steps;
}

/** Pure. Real JSON parsing/validation, split out from real file IO so it's
 * testable without touching disk — throws a real, descriptive error on
 * malformed input rather than silently producing an empty/garbage step
 * list. */
export function parseStepsJson(raw: string): DemoStep[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("steps file must contain a JSON array of DemoStep objects");
  return parsed as DemoStep[];
}

function loadStepsFile(path: string): DemoStep[] {
  return parseStepsJson(readFileSync(path, "utf-8"));
}

/** Thin IO wrapper around `renderTemplateGraphic` — `render` is injectable
 * (defaults to the real function) purely so a test can exercise this file's
 * own argument-assembly/output-path logic without launching a real headless
 * Chromium. Returns the real resolved output path it wrote to. */
export async function runGraphic(
  args: GraphicArgs,
  render: (layout: GraphicLayout, content: GraphicContent, brand: BrandAssets, outputPath: string) => Promise<void> = renderTemplateGraphic,
): Promise<string> {
  const brand: BrandAssets = { colors: args.colors, fontFamily: args.fontFamily, logoPath: args.logoPath };
  const content: GraphicContent = { headline: args.headline, body: args.body, statValue: args.statValue };
  const outputPath = resolve(args.output);
  await render(args.layout, content, brand, outputPath);
  return outputPath;
}

/** Thin IO wrapper around `captureProductDemo` — `capture`/`loadSteps` are
 * both injectable (default to the real functions) for the same reason as
 * `runGraphic` above. Returns the real resolved output path it wrote to. */
export async function runDemo(
  args: DemoArgs,
  capture: (steps: DemoStep[], outputPath: string, viewport: { width: number; height: number }) => Promise<void> = captureProductDemo,
  loadSteps: (path: string) => DemoStep[] = loadStepsFile,
): Promise<string> {
  const stepsFromFile = args.stepsFile ? loadSteps(resolve(args.stepsFile)) : [];
  const steps = buildDemoSteps(args.appUrl, stepsFromFile);
  const outputPath = resolve(args.output);
  await capture(steps, outputPath, { width: args.viewportWidth, height: args.viewportHeight });
  return outputPath;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) usage(parsed.error);

  if (parsed.args.mode === "graphic") {
    const outputPath = await runGraphic(parsed.args);
    console.log(`[day2-growth-render] Wrote graphic: ${outputPath}`);
    return;
  }

  const outputPath = await runDemo(parsed.args);
  console.log(`[day2-growth-render] Wrote demo recording: ${outputPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-growth-render] Fatal error:", err);
    process.exit(1);
  });
}
