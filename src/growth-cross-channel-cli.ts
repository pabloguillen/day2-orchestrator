import { resolve } from "node:path";
import { loadAllocatorState } from "./growth-allocator";
import { renderCrossChannelSuggestions, suggestCrossChannelPatterns } from "./growth-cross-channel";
import type { GrowthChannel } from "./growth-strategy";

/**
 * CLI for Step 4's cross-channel pattern-reinforcement suggester
 * (growth-cross-channel.ts) — previously a real, fully unit-tested, pure
 * function with zero caller anywhere in the codebase.
 *
 * `suggestCrossChannelPatterns` takes the real `AllocatorState`
 * (`growth-allocator.ts`) — the same real, persisted win/loss-by-format
 * history `growth-feed-cli.ts` already reads from `day2-allocator-state.json`
 * (via the identical `--allocator-state-file` flag/default) to render its
 * own transparency feed. This CLI reads that exact same real, on-disk arm
 * history (the actual "winning-pattern/channel history" this stage
 * persists) and asks a different question of it: not "what happened and
 * what's it cost" (growth-feed.ts's job) but "what's demonstrably winning
 * elsewhere that hasn't been tried in <target channel> yet" — a view this
 * codebase had no caller for before this CLI. `growth-feed.ts`'s own
 * `GrowthActionRecord` log is a per-event raw trail, not aggregated
 * attempts/successes-by-arm — re-deriving that aggregation here would
 * duplicate `growth-allocator.ts`'s own `recordOutcome`/`recordWeightedOutcome`,
 * exactly the "reuse, not a parallel system" discipline
 * `growth-cross-channel.ts`'s own file header already commits to.
 *
 * Pure, synchronous core (no agent call) — this CLI needs no `async main`.
 *
 * Usage:
 *   bun run src/growth-cross-channel-cli.ts --target-channel <channel> [--allocator-state-file path]
 */

/** A local, runtime-checkable mirror of `GrowthChannel`'s members — same
 * precedent as `growth-tools-config.ts`'s own `GROWTH_CAPABILITIES` mirroring
 * `GrowthCapability`, needed because a string flag has no type information
 * at runtime to validate against. */
const VALID_CHANNELS: readonly GrowthChannel[] = [
  "aso",
  "seo_content",
  "referral_loops",
  "social_content",
  "paid_ads",
  "direct_outreach",
  "website",
];

function isGrowthChannel(value: string): value is GrowthChannel {
  return (VALID_CHANNELS as readonly string[]).includes(value);
}

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    targetChannel: get("--target-channel"),
    allocatorStateFile: get("--allocator-state-file") ?? "day2-allocator-state.json",
  };
}

function usage(): never {
  console.error(
    "Usage: bun run src/growth-cross-channel-cli.ts --target-channel <channel> [--allocator-state-file path]\n" +
      `  <channel> is one of: ${VALID_CHANNELS.join(", ")}`,
  );
  process.exit(1);
}

function main() {
  const opts = parseArgs();
  if (!opts.targetChannel || !isGrowthChannel(opts.targetChannel)) usage();

  const state = loadAllocatorState(resolve(opts.allocatorStateFile));
  const suggestions = suggestCrossChannelPatterns(state, opts.targetChannel);
  console.log(renderCrossChannelSuggestions(suggestions));
}

if (import.meta.main) {
  main();
}
