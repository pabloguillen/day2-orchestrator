import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AuditEntry } from "./owner-feed";
import type { AutonomyLevel } from "./types";

/**
 * Closes a real gap `autonomy.ts`'s own audit trail left open: it records
 * every *decision* ("this area is L3, eligible to auto-ship") but never the
 * canary's eventual *outcome* ("that change held up, or got rolled back").
 * Without the outcome, there is no way to ever answer "has this area earned
 * more trust" — autonomy levels can only ever be raised by a human guessing,
 * never by the system pointing at its own track record. This file is the
 * other half: a separate, append-only outcome log keyed by `sourceId` (the
 * same id `ChangeForAutonomy`/the audit entry already use), plus the pure
 * computation that turns (decisions + outcomes) into a track record and,
 * when it's genuinely clean for long enough, a level-up *suggestion* — never
 * an automatic change. Raising an area's configured level stays a human
 * decision made through `autonomy-config-cli.ts`, same as today; this only
 * gives that human something real to decide from instead of a guess.
 */

export type AutonomyOutcome = {
  timestamp: string;
  sourceId: string;
  status: "promoted" | "rolled_back";
  reason: string;
};

/** Separate file from the decision audit trail on purpose: `owner-feed.ts`'s
 * `loadAuditEntries`/`renderEntry` parse every line in the decision log as
 * a `AuditEntry` and would break on a differently-shaped record mixed in. */
export function recordAutonomyOutcome(outcomeFile: string, outcome: AutonomyOutcome): void {
  appendFileSync(outcomeFile, `${JSON.stringify(outcome)}\n`);
}

export function loadAutonomyOutcomes(outcomeFile: string): AutonomyOutcome[] {
  if (!existsSync(outcomeFile)) return [];
  const lines = readFileSync(outcomeFile, "utf-8").trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as AutonomyOutcome);
}

export type TrackRecord = {
  area: string;
  /** Auto-ships in this area, most-recent-first, whose canary outcome is
   * known, counted until the first (most recent) rollback. A decision whose
   * outcome isn't recorded yet (still soaking, or the outcome-recording
   * step predates this feature) is simply skipped — it neither extends nor
   * breaks the streak, since its real result isn't known. */
  consecutiveCleanAutoShips: number;
  /** Total auto-ships in this area with a known outcome, clean or not —
   * the honest denominator; a long streak over a tiny sample isn't the same
   * claim as a long streak over a real one. */
  totalAutoShipsWithKnownOutcome: number;
  totalRollbacks: number;
};

export function computeTrackRecord(
  decisions: AuditEntry[],
  outcomes: AutonomyOutcome[],
  area: string,
): TrackRecord {
  const outcomeBySourceId = new Map(outcomes.map((o) => [o.sourceId, o]));
  const areaAutoShips = decisions
    .filter((d) => d.area === area && d.autoShip)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const knownOutcomes = areaAutoShips
    .map((d) => outcomeBySourceId.get(d.sourceId))
    .filter((o): o is AutonomyOutcome => o !== undefined);

  const totalRollbacks = knownOutcomes.filter((o) => o.status === "rolled_back").length;

  let consecutiveCleanAutoShips = 0;
  for (let i = knownOutcomes.length - 1; i >= 0; i--) {
    if (knownOutcomes[i]!.status === "rolled_back") break;
    consecutiveCleanAutoShips++;
  }

  return {
    area,
    consecutiveCleanAutoShips,
    totalAutoShipsWithKnownOutcome: knownOutcomes.length,
    totalRollbacks,
  };
}

/** Disclosed, not calibrated — this project has no real production track
 * record yet to tune against, same honesty this project's other v1
 * constants carry (`experiments.ts::MIN_SAMPLE_SIZE_PER_ARM`). */
export const LEVEL_UP_STREAK_THRESHOLD = 10;

const NEXT_LEVEL: Partial<Record<AutonomyLevel, AutonomyLevel>> = {
  L0: "L1",
  L1: "L2",
  L2: "L3",
  L3: "L4",
  L4: "L5",
};

export type LevelUpSuggestion = {
  area: string;
  currentLevel: AutonomyLevel;
  suggestedLevel: AutonomyLevel;
  reason: string;
};

/**
 * Pure. Never applies anything — `autonomy-config-cli.ts` already owns the
 * only path that writes `.day2-autonomy.json`, and raising trust stays a
 * decision the source doc's own "autonomy is earned per area" model reserves
 * for a human to make, now backed by a real number instead of a guess.
 */
export function proposeLevelUp(
  trackRecord: TrackRecord,
  currentLevel: AutonomyLevel,
  threshold: number = LEVEL_UP_STREAK_THRESHOLD,
): LevelUpSuggestion | null {
  const suggestedLevel = NEXT_LEVEL[currentLevel];
  if (!suggestedLevel) return null; // already at L5 — nothing higher to suggest
  if (trackRecord.consecutiveCleanAutoShips < threshold) return null;

  return {
    area: trackRecord.area,
    currentLevel,
    suggestedLevel,
    reason:
      `${trackRecord.consecutiveCleanAutoShips} consecutive auto-shipped changes in "${trackRecord.area}" ` +
      `with no rollback (${trackRecord.totalAutoShipsWithKnownOutcome} with a known outcome total, ` +
      `${trackRecord.totalRollbacks} rollback(s) ever) — consider raising this area from ${currentLevel} ` +
      `to ${suggestedLevel}. This is a suggestion, not an automatic change: review and apply via ` +
      `autonomy-config-cli.ts if you agree.`,
  };
}
