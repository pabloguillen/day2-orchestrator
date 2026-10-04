import { resolve } from "node:path";
import { DESIGN_REFERENCES_FILENAME, fetchFigmaDesignContext, loadDesignReferences, type FigmaDesignContext } from "./design-references";
import { GROWTH_CONFIG_FILENAME, loadGrowthConfig } from "./growth-config";
import { GROWTH_TOOLS_CONFIG_FILENAME, loadGrowthToolsConfig, resolveBindings } from "./growth-tools-config";
import { generateMarketingWebsite } from "./growth-website";
import { APP_PROFILE_FILENAME, loadAppProfile } from "./onboarding";

/**
 * CLI for Step 4's marketing-website generator (growth-website.ts, Component
 * 7) — previously a real, fully unit-tested function with zero caller
 * anywhere in the codebase. This is purely a wiring layer: every real
 * decision (owner opt-in, connected-tool gate, mandatory-grounding gate)
 * stays entirely inside `generateMarketingWebsite` itself, untouched here —
 * this CLI only assembles its four real inputs from where this codebase
 * already persists them, and prints whatever it honestly returns.
 *
 * Real inputs, each loaded from its own already-established on-disk format:
 *   - `AppProfile` — the owner-reviewed `.day2-app-profile.json`
 *     (`onboarding.ts`'s `loadAppProfile`, same file `onboarding-cli.ts`/
 *     `onboarding-rescan-cli.ts` already read/write).
 *   - `WebsiteConfig` — `.day2-budget.json`'s `website` field
 *     (`growth-config.ts`'s `loadGrowthConfig`, the owner's one config
 *     surface, toggled via `spend-config-cli.ts --website on`).
 *   - `ToolBinding | undefined` — resolved from the platform-level
 *     `.day2-platform-tools.json` (`growth-tools-config.ts`'s
 *     `loadGrowthToolsConfig` + `resolveBindings`), exactly the resolution
 *     step `growth-website.ts`'s own file header says its caller owns.
 *     There's no `Arm`/`GrowthStrategy` context for a website generation
 *     call (unlike a channel's creative arm), so this takes the first
 *     resolved, enabled, identity-connected binding rather than using
 *     `selectBestFitBinding` (which scores against an `Arm` this call
 *     doesn't have).
 *   - Uploaded brand assets + an optional connected Figma file — the
 *     owner-facing `.day2-design-references.json` (`design-references.ts`),
 *     the same file `design-references-cli.ts` manages. A Figma fetch
 *     failure is never fatal to the run: Figma context is explicitly
 *     supplemental grounding only (see `growth-website.ts`'s own W46 note),
 *     never one of its three fail-closed preconditions.
 *
 * `--app-id` is accepted and threaded through to `resolveBindings` for
 * forward compatibility only — inert today (day2 powers exactly one app;
 * see `resolveBindings`'s own v1 honesty note), defaults to "default".
 *
 * Usage:
 *   bun run src/growth-website-cli.ts --repo <path> [--app-id <id>] [--platform-tools-file <path>]
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    appId: get("--app-id"),
    platformToolsFile: get("--platform-tools-file"),
  };
}

function usage(): never {
  console.error("Usage: bun run src/growth-website-cli.ts --repo <path> [--app-id <id>] [--platform-tools-file <path>]");
  process.exit(1);
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo) usage();

  const repoPath = resolve(opts.repo);
  const profilePath = resolve(repoPath, APP_PROFILE_FILENAME);
  const appProfile = loadAppProfile(profilePath);
  if (!appProfile) {
    console.error(
      `[day2-website] No reviewed app profile found at ${profilePath} — run onboarding-cli.ts and complete ` +
        'the owner-confirmed "Go live" step first.',
    );
    process.exit(1);
  }

  const growthConfig = loadGrowthConfig(resolve(repoPath, GROWTH_CONFIG_FILENAME));
  const toolsConfig = loadGrowthToolsConfig(resolve(opts.platformToolsFile ?? GROWTH_TOOLS_CONFIG_FILENAME));
  const appId = opts.appId ?? "default";
  const toolBinding = resolveBindings(toolsConfig, "website_generation", appId)[0];

  const designRefs = loadDesignReferences(resolve(repoPath, DESIGN_REFERENCES_FILENAME));

  let figmaContext: FigmaDesignContext | undefined;
  if (designRefs.figmaFileUrl) {
    const figmaBinding = resolveBindings(toolsConfig, "design_reference", appId)[0];
    const figmaResult = await fetchFigmaDesignContext(designRefs.figmaFileUrl, figmaBinding);
    if (figmaResult.status === "fetched") {
      figmaContext = figmaResult.context;
    } else {
      console.error(`[day2-website] Figma context unavailable (${figmaResult.status}) — continuing without it, it's supplemental only.`);
    }
  }

  const result = await generateMarketingWebsite(appProfile, growthConfig.website, toolBinding, designRefs.uploadedAssets, figmaContext);

  if (result.status === "not_enabled") {
    console.log('[day2-website] Marketing website generation is not enabled for this app (see spend-config-cli.ts --website on).');
    return;
  }
  if (result.status === "blocked_by_unconnected_account") {
    console.log(
      "[day2-website] Enabled, but no connected website_generation tool is bound to this app yet " +
        `(platform-level ${GROWTH_TOOLS_CONFIG_FILENAME}).`,
    );
    return;
  }
  if (result.status === "generation_failed") {
    console.error(`[day2-website] Generation failed: ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Template: ${result.templateUsed}`);
  console.log(`Preview: ${result.previewRef}`);
  console.log(`Cost: $${result.costUsd.toFixed(2)}`);
  console.log("");
  console.log(result.pageContent);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-website] Fatal error:", err);
    process.exit(1);
  });
}
