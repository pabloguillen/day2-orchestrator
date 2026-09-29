import { loadAllocatorState } from "./growth-allocator";
import { loadGrowthActions, renderGrowthFeed } from "./growth-feed";

/**
 * CLI for the growth transparency feed (Component 6, COORDINATION.md W43) —
 * matches `owner-feed.ts`'s CLI-only, on-demand pattern exactly. No
 * scheduler runs this (this project has never built one anywhere); it's
 * meant to be checked whenever the owner wants a real, current picture of
 * what day2 has done, spent, and learned.
 *
 * Usage:
 *   bun run src/growth-feed-cli.ts [--audit-file path] [--allocator-state-file path] [--since date]
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    auditFile: get("--audit-file") ?? "day2-growth-actions.jsonl",
    allocatorStateFile: get("--allocator-state-file") ?? "day2-allocator-state.json",
    since: get("--since"),
  };
}

function main() {
  const opts = parseArgs();
  const since = opts.since ? new Date(opts.since) : undefined;
  const records = loadGrowthActions(opts.auditFile, since);
  const allocatorState = loadAllocatorState(opts.allocatorStateFile);
  console.log(renderGrowthFeed(records, allocatorState));
}

if (import.meta.main) {
  main();
}
