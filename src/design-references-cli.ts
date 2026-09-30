import { resolve } from "node:path";
import {
  DESIGN_REFERENCES_FILENAME,
  addUploadedAsset,
  loadDesignReferences,
  removeUploadedAsset,
  renderDesignReferencesSummary,
  saveDesignReferences,
  setFigmaFileUrl,
} from "./design-references";

/**
 * CLI for the app owner's design-reference config — uploaded brand assets
 * and an optional connected Figma file (COORDINATION.md W46). Same
 * "read by default, mutate on an explicit flag" shape `spend-config-cli.ts`
 * already established.
 *
 * Usage:
 *   bun run src/design-references-cli.ts --repo <path>
 *   bun run src/design-references-cli.ts --repo <path> --add-asset <file-path> --description "..."
 *   bun run src/design-references-cli.ts --repo <path> --remove-asset <filename>
 *   bun run src/design-references-cli.ts --repo <path> --set-figma-url <url>
 *   bun run src/design-references-cli.ts --repo <path> --clear-figma-url
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    addAsset: get("--add-asset"),
    description: get("--description"),
    removeAsset: get("--remove-asset"),
    setFigmaUrl: get("--set-figma-url"),
    clearFigmaUrl: args.includes("--clear-figma-url"),
  };
}

function usage(): never {
  console.error(
    "Usage: bun run src/design-references-cli.ts --repo <path>\n" +
      "         [--add-asset <file-path> --description \"...\"]\n" +
      "         [--remove-asset <filename>]\n" +
      "         [--set-figma-url <url>] [--clear-figma-url]\n\n" +
      "No mutating flag: prints the current design references (read-only).",
  );
  process.exit(1);
}

async function main() {
  const opts = parseArgs();
  if (!opts.repo) usage();
  const configPath = resolve(opts.repo, DESIGN_REFERENCES_FILENAME);
  let refs = loadDesignReferences(configPath);
  let mutated = false;

  if (opts.addAsset !== undefined) {
    if (!opts.description) {
      console.error("[day2-design-references] --add-asset requires --description.");
      usage();
    }
    refs = addUploadedAsset(configPath, refs, resolve(opts.addAsset), opts.description, new Date().toISOString());
    mutated = true;
    console.log(`[day2-design-references] Asset added: ${opts.addAsset}`);
  }

  if (opts.removeAsset !== undefined) {
    refs = removeUploadedAsset(refs, opts.removeAsset);
    mutated = true;
    console.log(`[day2-design-references] Asset removed from manifest: ${opts.removeAsset}`);
  }

  if (opts.setFigmaUrl !== undefined) {
    refs = setFigmaFileUrl(refs, opts.setFigmaUrl, new Date().toISOString());
    mutated = true;
    console.log(`[day2-design-references] Figma file connected: ${opts.setFigmaUrl}`);
  }

  if (opts.clearFigmaUrl) {
    refs = setFigmaFileUrl(refs, undefined, new Date().toISOString());
    mutated = true;
    console.log("[day2-design-references] Figma file disconnected.");
  }

  if (mutated) {
    saveDesignReferences(configPath, refs);
    return;
  }

  console.log(renderDesignReferencesSummary(refs));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-design-references] Fatal error:", err);
    process.exit(1);
  });
}
