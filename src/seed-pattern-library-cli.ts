import { resolve } from "node:path";
import { getOrResearchPatterns, type ResearchType } from "./pattern-library";

/**
 * Proactive seeding sweep (docs/distribution-intelligence.md, Phase 1
 * "proactive seeding sweep across common categories, run before specific
 * customer demand, so even a brand-new customer's first session shows
 * real, tiered research, not a blank slate").
 *
 * Deliberately scoped to `proven`/`organic`/`geo` only — `stage_comparable`
 * research needs a real target `AppStage`, which isn't knowable for a
 * category in the abstract (seeding a guessed stage would mean fabricating
 * a premise this project's whole discipline argues against). Stage-
 * comparable research stays reactive, researched per real app at
 * onboarding time via `getOrResearchPatterns`'s existing `targetStage`
 * parameter — this CLI doesn't touch it.
 *
 * A real, disclosed cost, run upfront before any revenue — this project's
 * "no silent cost" discipline applies here same as everywhere else: each
 * category/researchType combination is a real agent call (research) plus
 * one adversarial pass and one match call per candidate found. Not free,
 * on purpose disclosed as a cost, not hidden behind "it's just seeding."
 *
 * Usage:
 *   bun run src/seed-pattern-library-cli.ts -- --library-path <path> [--categories "a,b,c"] [--research-types "proven,organic,geo"]
 */

const DEFAULT_CATEGORIES = [
  "consumer personal-finance / budgeting app",
  "b2b saas productivity tool",
  "consumer social / community app",
  "e-commerce / shopping app",
  "health & fitness app",
  "consumer habit-tracking / productivity app",
];

const DEFAULT_RESEARCH_TYPES: ResearchType[] = ["proven", "organic", "geo"];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    libraryPath: get("--library-path"),
    categories: get("--categories")?.split(",").map((c) => c.trim()).filter(Boolean) ?? DEFAULT_CATEGORIES,
    researchTypes: (get("--research-types")?.split(",").map((t) => t.trim()).filter(Boolean) as ResearchType[] | undefined) ?? DEFAULT_RESEARCH_TYPES,
  };
}

async function main() {
  const opts = parseArgs();
  if (!opts.libraryPath) {
    console.error("Usage: bun run src/seed-pattern-library-cli.ts -- --library-path <path> [--categories \"a,b,c\"] [--research-types \"proven,organic,geo\"]");
    process.exit(1);
  }
  const libraryPath = resolve(opts.libraryPath);

  console.log(`[day2-seed] Seeding ${opts.categories.length} categories × ${opts.researchTypes.length} research types = ${opts.categories.length * opts.researchTypes.length} sweeps. This is a real, billed agent-call cost, not free.`);

  let swept = 0;
  let skippedFresh = 0;
  for (const category of opts.categories) {
    for (const researchType of opts.researchTypes) {
      console.log(`[day2-seed] (${swept + skippedFresh + 1}/${opts.categories.length * opts.researchTypes.length}) ${researchType} — "${category}"...`);
      const result = await getOrResearchPatterns(libraryPath, category, researchType);
      if (result.freshlyResearched) {
        swept++;
        console.log(`[day2-seed]   researched live — ${result.patterns.length} pattern(s) now in the library for this category.`);
      } else {
        skippedFresh++;
        console.log(`[day2-seed]   already fresh — skipped, zero cost.`);
      }
    }
  }

  console.log(`[day2-seed] Done. ${swept} swept live, ${skippedFresh} already fresh and skipped.`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-seed] Fatal error:", err);
    process.exit(1);
  });
}
