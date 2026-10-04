import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { learnEntryPaths, type LearnedEntryPath } from "./entry-paths";
import type { EventLike } from "./metrics";

/**
 * CLI entrypoint for the M4 entry-path learning job (docs/closed-loop-spec.md
 * §6.1). `learnEntryPaths`/`evaluateHoldoutPromotion` in entry-paths.ts are
 * real, tested math (entry-paths.test.ts) with no caller anywhere in this
 * codebase — a real orphaned-module finding from the independent audit. This
 * file is that caller.
 *
 * Input is a `--events-file` JSON array of real `EventLike` records — the
 * same file-based-input idiom already established in this codebase
 * (`sources/manual.ts` reads a hand-written bug report from a file;
 * `onboarding-cli.ts`/`onboarding-rescan-cli.ts` read/write real JSON state
 * files by path) rather than inventing new telemetry-ingestion
 * infrastructure. Producing that file (e.g. by exporting events from
 * expense-buddy's own event store) is out of scope here, same as
 * `manual.ts` doesn't build the bug-report-authoring UI either.
 *
 * Output: a `--out` JSON file containing the real `LearnedEntryPath[]`
 * result. This shape is byte-for-byte structurally identical to
 * expense-buddy/src/server.ts's own `LearnedEntryPath` type (that file's own
 * doc comment: "Shape mirrors orchestrator/src/entry-paths.ts's
 * LearnedEntryPath ... Populated by that file's learnEntryPaths job;
 * LEARNED_ENTRY_PATHS ships empty ... a real, reachable, currently-always-
 * no-op code path below, not a placeholder"). `LEARNED_ENTRY_PATHS` in
 * server.ts is hardcoded to `[]` today — a deploy step for expense-buddy
 * (not built here; that's a separate deployable repo) could read this CLI's
 * `--out` file and inline its contents in place of that hardcoded `[]`
 * before building the Worker, the same way `ACTIVE_EXPERIMENTS` is a real,
 * manually-populated constant in that file already. This CLI only produces
 * the real data such a step would consume; it does not perform that wiring.
 *
 * Usage:
 *   bun run src/entry-paths-cli.ts --events-file <path> --out <path> \
 *     [--active-user-event <type>] [--as-of <iso>]
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    eventsFile: get("--events-file"),
    out: get("--out"),
    // "session_start" matches DEFAULT_EXPENSE_BUDDY_METRIC_CONFIG's own
    // activeUser.event (metrics/types.ts) — the same real active-user
    // signal every other KPI in this codebase treats as "the device came
    // back", not a new definition invented for this CLI.
    activeUserEvent: get("--active-user-event") ?? "session_start",
    asOf: get("--as-of"),
  };
}

/** Fail-closed: a missing or malformed events file is a real error, not a
 * silent "learn nothing" — same discipline `apps-registry.ts`'s and
 * `health-scout-cli.ts`'s own `--apps` loaders already apply to their own
 * JSON-array input. */
export function loadEventsFile(path: string): EventLike[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of events.`);
  }
  return parsed as EventLike[];
}

export function writeLearnedEntryPaths(outPath: string, learned: LearnedEntryPath[]): void {
  writeFileSync(outPath, JSON.stringify(learned, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run src/entry-paths-cli.ts --events-file <path> --out <path> " +
      "[--active-user-event <type>] [--as-of <iso>]",
  );
  process.exit(1);
}

function main() {
  const opts = parseArgs();
  if (!opts.eventsFile || !opts.out) usage();

  const eventsPath = resolve(opts.eventsFile);
  const outPath = resolve(opts.out);
  const asOfIso = opts.asOf ?? new Date().toISOString();

  const events = loadEventsFile(eventsPath);
  const learned = learnEntryPaths(events, opts.activeUserEvent, asOfIso);
  writeLearnedEntryPaths(outPath, learned);

  console.log(
    `[day2-entry-paths] Learned ${learned.length} entry path(s) from ${events.length} real event(s) ` +
      `(as of ${asOfIso}). Wrote ${outPath}.`,
  );
}

if (import.meta.main) {
  main();
}
