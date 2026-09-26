import { resolve } from "node:path";
import {
  AUTONOMY_CONFIG_FILENAME,
  loadAutonomyConfig,
  previewArea,
  removeArea,
  renderConfigSummary,
  saveAutonomyConfig,
  setArea,
} from "./autonomy-config";
import type { AutonomyLevel } from "./types";

/**
 * CLI for opting an area into automatic shipping — the plain-language
 * counterpart to hand-editing `.day2-autonomy.json` (COORDINATION.md W21).
 *
 * Default mode (no `--area`/`--remove`) is read-only: prints the current
 * config in plain language, including what each configured area actually
 * buys today (some may look opted-in but never auto-ship, e.g. if their
 * glob also matches a sensitive path).
 *
 * Usage:
 *   bun run src/autonomy-config-cli.ts --repo <path>
 *   bun run src/autonomy-config-cli.ts --repo <path> --area <name> --glob <glob> [--glob <glob>...] --auto-ship <yes|no>
 *   bun run src/autonomy-config-cli.ts --repo <path> --remove <area>
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const getAll = (flag: string) =>
    args.reduce<string[]>((acc, a, i) => (a === flag ? [...acc, args[i + 1]] : acc), []);
  return {
    repo: get("--repo"),
    area: get("--area"),
    globs: getAll("--glob"),
    autoShip: get("--auto-ship"),
    remove: get("--remove"),
  };
}

function usage(): never {
  console.error(
    "Usage: bun run src/autonomy-config-cli.ts --repo <path>\n" +
      "         [--area <name> --glob <glob> [--glob <glob>...] --auto-ship <yes|no>]\n" +
      "         [--remove <area>]\n\n" +
      "No flag: prints the current config in plain language (read-only).",
  );
  process.exit(1);
}

async function main() {
  const { repo, area, globs, autoShip, remove } = parseArgs();
  if (!repo) usage();
  const configPath = resolve(repo, AUTONOMY_CONFIG_FILENAME);
  let config = loadAutonomyConfig(configPath);

  if (remove) {
    config = removeArea(config, remove);
    saveAutonomyConfig(configPath, config);
    console.log(
      `[day2-autonomy] Removed "${remove}" — it now falls back to the default (${config.defaultLevel}: every fix opens a PR, a human merges it).`,
    );
    return;
  }

  if (area) {
    if (globs.length === 0) usage();
    if (autoShip !== "yes" && autoShip !== "no") usage();
    const level: AutonomyLevel = autoShip === "yes" ? "L3" : "L2";
    config = setArea(config, area, globs, level);
    saveAutonomyConfig(configPath, config);

    const { willAutoShip, reason } = previewArea(config, { area, pathGlobs: globs, level });
    console.log(`[day2-autonomy] Saved "${area}" (${globs.join(", ")}) at ${level}.`);
    if (autoShip === "yes" && !willAutoShip) {
      console.log(
        `[day2-autonomy] ⚠ This won't actually auto-ship yet, even though you asked for it: ${reason}`,
      );
    } else if (autoShip === "yes") {
      console.log("[day2-autonomy] Verified low-risk bug fixes here will now ship automatically, with one-tap undo.");
    } else {
      console.log("[day2-autonomy] Fixes here will keep opening a PR for a human to merge.");
    }
    return;
  }

  console.log(renderConfigSummary(config));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-autonomy] Fatal error:", err);
    process.exit(1);
  });
}
