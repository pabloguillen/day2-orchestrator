import type { AllocatorState, ArmStats } from "./growth-allocator";
import { MIN_ARM_OBSERVATIONS } from "./growth-allocator";
import type { GrowthChannel } from "./growth-strategy";

/**
 * Pattern-level cross-channel reinforcement (user-directed: "What we can
 * learn from Revnu... day2 already has the real allocator mechanism,
 * extend it to let a winning pattern cross-pollinate across channels").
 *
 * Deliberately a fully separate, additive file — does NOT modify
 * `ArmStats`/`AllocatorState` in `growth-allocator.ts` (an actively-built
 * file this session doesn't own) to add a `patternId` field. Instead, a
 * lightweight convention on `Arm.formatTag` itself: when an arm is created
 * from a researched pattern (`growth-patterns.ts`'s `ProvenPattern`/
 * `OrganicPattern`, or `growth-geo.ts`'s `GeoPattern`), its id is encoded
 * as a prefix — `buildFormatTagForPattern`/`patternIdFromFormatTag` are the
 * encode/decode pair. Arms built some other way (a one-off manual format,
 * organic content with no researched pattern behind it) simply have no
 * decodable prefix and are correctly never surfaced as "pattern wins" —
 * cross-channel suggestion only ever applies to the subset of arms that
 * actually trace back to a real, evidence-tagged pattern.
 *
 * Reinforcement direction: a pattern that's winning in one channel gets
 * suggested as worth trying in a channel it hasn't been tried in yet —
 * never the other way around, and never auto-applied. This is a
 * suggestion surface, the same spirit as `proposals.ts`'s view-only
 * feature proposals: a human (or a future orchestration step) decides
 * whether to actually spin up the suggested arm, this file only notices
 * the real pattern.
 */

const PATTERN_TAG_SEPARATOR = "::";

export function buildFormatTagForPattern(patternId: string, variant: string): string {
  return `${patternId}${PATTERN_TAG_SEPARATOR}${variant}`;
}

/** Pure. Returns `undefined` for any `formatTag` not built by
 * `buildFormatTagForPattern` — a plain/manual format tag with no `::` is a
 * normal, expected case, not a malformed one. */
export function patternIdFromFormatTag(formatTag: string): string | undefined {
  const idx = formatTag.indexOf(PATTERN_TAG_SEPARATOR);
  if (idx === -1) return undefined;
  const patternId = formatTag.slice(0, idx);
  return patternId.length > 0 ? patternId : undefined;
}

export type CrossChannelSuggestion = {
  patternId: string;
  /** The channel(s) this pattern has already been tried in, with real
   * observed stats — plural, since the same pattern can legitimately be
   * tried in more than one channel already. */
  provenIn: Array<{ channel: GrowthChannel; attempts: number; successes: number; winRate: number }>;
  suggestedForChannel: GrowthChannel;
  reason: string;
};

function winRate(stats: ArmStats): number {
  return stats.attempts > 0 ? stats.successes / stats.attempts : 0;
}

/**
 * Pure, unit-tested — the entire real logic of this file. "Winning" is
 * deliberately relative, not a fixed magic-number threshold: an arm
 * counts as proven-winning only once it has real volume
 * (`MIN_ARM_OBSERVATIONS`, the same bar `growth-allocator.ts` already
 * uses elsewhere) AND its win rate is strictly above the average win rate
 * of every other sufficiently-observed arm in its own channel — "actually
 * outperforming its real peers," not an arbitrary absolute bar invented
 * here. A pattern already tried (at all, regardless of outcome) in
 * `targetChannel` is never suggested for it again — this surfaces genuine
 * gaps, not a pattern someone's already acting on.
 */
export function suggestCrossChannelPatterns(state: AllocatorState, targetChannel: GrowthChannel): CrossChannelSuggestion[] {
  const observed = state.arms.filter((s) => s.attempts >= MIN_ARM_OBSERVATIONS);

  const byChannel = new Map<GrowthChannel, ArmStats[]>();
  for (const stats of observed) {
    const list = byChannel.get(stats.arm.channel) ?? [];
    list.push(stats);
    byChannel.set(stats.arm.channel, list);
  }

  const alreadyTriedPatternIds = new Set(
    state.arms
      .filter((s) => s.arm.channel === targetChannel)
      .map((s) => patternIdFromFormatTag(s.arm.formatTag))
      .filter((id): id is string => id !== undefined),
  );

  const byPattern = new Map<string, CrossChannelSuggestion>();

  for (const [channel, arms] of byChannel) {
    if (channel === targetChannel) continue;
    const channelAverage = arms.reduce((sum, s) => sum + winRate(s), 0) / arms.length;

    for (const stats of arms) {
      const patternId = patternIdFromFormatTag(stats.arm.formatTag);
      if (!patternId || alreadyTriedPatternIds.has(patternId)) continue;
      if (winRate(stats) <= channelAverage) continue;

      const existing = byPattern.get(patternId);
      const entry = { channel, attempts: stats.attempts, successes: stats.successes, winRate: winRate(stats) };
      if (existing) {
        existing.provenIn.push(entry);
      } else {
        byPattern.set(patternId, {
          patternId,
          provenIn: [entry],
          suggestedForChannel: targetChannel,
          reason: `Outperforming its own channel's average (${(winRate(stats) * 100).toFixed(0)}% vs ${(channelAverage * 100).toFixed(0)}% average in ${channel}, over ${stats.attempts} real attempts) and not yet tried in ${targetChannel}.`,
        });
      }
    }
  }

  return [...byPattern.values()].sort((a, b) => Math.max(...b.provenIn.map((p) => p.winRate)) - Math.max(...a.provenIn.map((p) => p.winRate)));
}

/** Plain-language rendering, matching every other summary function's style. */
export function renderCrossChannelSuggestions(suggestions: CrossChannelSuggestion[]): string {
  if (suggestions.length === 0) return "No cross-channel pattern suggestions yet — nothing proven enough to recommend elsewhere.";
  return suggestions
    .map((s) => {
      const provenSummary = s.provenIn.map((p) => `${p.channel} (${(p.winRate * 100).toFixed(0)}% over ${p.attempts} attempts)`).join(", ");
      return `- "${s.patternId}" → try in ${s.suggestedForChannel}. Proven in: ${provenSummary}. ${s.reason}`;
    })
    .join("\n");
}
