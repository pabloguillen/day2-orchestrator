import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AllocatorState, Arm } from "./growth-allocator";
import { renderAllocatorSummary } from "./growth-allocator";
import type { ChannelExecutionResult } from "./growth-execution";
import type { AuthenticityVerdict, ClaimCheckVerdict } from "./growth-creative";
import type { JudgePrediction } from "./growth-judge-model";
import type { AppStage } from "./growth-strategy";
import type { GrowthCapability } from "./growth-tools-config";

/**
 * Step 4 (self-distributing), Component 6 — transparency feed
 * (COORDINATION.md W43, docs/step4-self-distributing-plan.md).
 *
 * A `GrowthActionRecord` is a genuinely fourth kind of review object in
 * this codebase, deliberately not an extension of `approvals.ts` (a
 * `ChangeCard` assumes a real PR/branch/diff) or `proposals.ts` (a
 * `RecordedProposal` is pre-code, with nothing to apply yet) — this is
 * post-hoc and already-decided, with no Apply/Undo/Ask affordance at all,
 * because the whole point of Step 4's zero-per-action-approval design is
 * that no such affordance exists. This file's only job is to make every
 * such decision fully, plainly visible after the fact.
 *
 * Rendering extends `owner-feed.ts`'s real, established day-grouped
 * pattern (`renderFeed`/`renderEntry`/`dayKey`) with the one thing that
 * pattern never needed: a running "$X of $Y used this month" line — the
 * single most important fact for a zero-approval spend system, and the
 * one thing a plain day-grouped list doesn't surface on its own.
 */

export type GrowthActionRecord = {
  timestamp: string;
  /** Unique per action — links back to a real `acquisition_landing`
   * event's own `creativeId` metadata field for Component 6's own
   * reconciliation (`growth-execution.ts`'s `reconcileOutcomes`). */
  creativeId: string;
  strategy: { stage: AppStage; channel: string; competitorSignal?: string };
  arm: Arm;
  /** Passthrough from `Creative.groundedInPatternId` (growth-creative.ts,
   * Part 4) — set only when this action's creative was genuinely grounded
   * in a real, validated `TransferablePattern`. Absent on every record
   * written before this field existed; every reader treats `undefined`
   * the same as "not grounded in anything," same backward-compatible
   * discipline as `AllocatorState.reconciledCreativeIds`. */
  groundedInPatternId?: string;
  /** Which real app this action belongs to — absent on every record today
   * (day2 powers exactly one app; see `apps-registry.ts`'s own in-flight
   * `AppEntry.id`, the convention this should align with once real
   * multi-app operation exists). `growth-judge-model.ts`'s
   * `LabeledOutcome.appId` defaults to `UNKNOWN_APP_ID` when this is
   * absent, never silently dropped. */
  appId?: string;
  /** `null` for organic/free actions needing no external tool at all —
   * matches `growth-execution.ts`'s own `requiredCapability?`/`toolBinding?`
   * optionality; not every real action used a bound MCP tool. */
  toolUsed: { capability: GrowthCapability; mcpServerName: string; reason: string } | null;
  frequency: string;
  spend: { requested: number; allowed: boolean; runningMonthlyTotalUsd: number; monthlyBudgetUsd: number };
  claimsCheck: ClaimCheckVerdict;
  authenticityCheck: AuthenticityVerdict;
  executionResult: ChannelExecutionResult["status"];
  kpiSnapshot?: Record<string, number>;
  /** Advisory only, from `growth-judge-model.ts`'s `predictForCandidate`
   * (Part 4) — computed by whoever assembles this record, from the real
   * `claimsCheck`/`authenticityCheck` above plus `arm`/`strategy.stage`.
   * Never gates or alters anything here or in `growth-execution.ts`; purely
   * a transparency note. `basis: "no_model_fallback"` on every record
   * today (zero real executions exist to train on) — `renderActionLine`
   * deliberately suppresses the note in that case rather than printing
   * "no prediction" on every single line forever. */
  judgePrediction?: JudgePrediction;
};

/** Append-only JSONL, same idiom as `autonomy.ts`'s `recordAutonomyAudit` —
 * called unconditionally by whoever orchestrates a real action, regardless
 * of whether it was blocked, simulated, or (once real execution is wired
 * up) actually executed. The ledger is a complete record either way. */
export function recordGrowthAction(auditFile: string, record: GrowthActionRecord): void {
  appendFileSync(auditFile, `${JSON.stringify(record)}\n`);
}

export function loadGrowthActions(auditFile: string, since?: Date): GrowthActionRecord[] {
  if (!existsSync(auditFile)) return [];
  const lines = readFileSync(auditFile, "utf-8").trim().split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l) as GrowthActionRecord);
  return since ? records.filter((r) => new Date(r.timestamp) >= since) : records;
}

/** Counts how many of the most recent records for this exact
 * segment/channel were `blocked_by_authenticity_check`, stopping at the
 * first one that wasn't — i.e. the real "consecutive" count
 * `growth-execution.ts`'s `ChannelExecutionOptions.consecutiveGenericFlags`
 * needs, computed from the real audit trail rather than tracked
 * separately. Exported so a future orchestration script can call this
 * directly before invoking `executeChannelAction`, instead of
 * re-implementing the same scan. */
export function countConsecutiveGenericFlags(records: GrowthActionRecord[], segment: string, channel: string): number {
  const relevant = [...records]
    .filter((r) => r.strategy.channel === channel && r.claimsCheck.creative.segment === segment)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  let count = 0;
  for (const r of relevant) {
    if (r.executionResult !== "blocked_by_authenticity_check") break;
    count++;
  }
  return count;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** `undefined`/`no_model_fallback` renders as nothing — showing "no
 * prediction yet" on every single line, forever, until real execution
 * exists would be noise, not transparency. Only a real, trained
 * prediction is worth a line. */
function renderJudgeNote(prediction: JudgePrediction | undefined): string {
  if (!prediction || prediction.basis !== "learned_model") return "";
  const pct = Math.round(prediction.predictedSuccessProbability * 100);
  return ` — judge model: ${pct}% predicted (${prediction.confidence} confidence, n=${prediction.trainedOnExampleCount})`;
}

function renderActionLine(record: GrowthActionRecord): string {
  const toolNote = record.toolUsed
    ? `via ${record.toolUsed.mcpServerName} (${record.toolUsed.reason})`
    : "organic, no external tool";
  const formatLabel = `${record.arm.assetType}${record.arm.videoFormat ? ` (${record.arm.videoFormat})` : ""} / ${record.arm.formatTag}`;
  const genericFlag = record.authenticityCheck.readsAsGeneric ? " — ⚠ flagged as reading generic" : "";
  const judgeNote = renderJudgeNote(record.judgePrediction);
  return `  - [${record.strategy.channel}] ${formatLabel} — ${toolNote}, $${record.spend.requested.toFixed(2)} requested (${record.executionResult})${genericFlag}${judgeNote}`;
}

/** Plain-language, day-grouped, extends `owner-feed.ts`'s own pattern —
 * see the file header. Takes the real, current `AllocatorState` alongside
 * the action records so the feed can end with `renderAllocatorSummary`'s
 * own honest win-rate breakdown, giving the owner the full picture (what
 * happened, how much it cost, and what's winning) in one place. */
export function renderGrowthFeed(records: GrowthActionRecord[], allocatorState: AllocatorState): string {
  if (records.length === 0) {
    return `No growth actions recorded yet.\n\n${renderAllocatorSummary(allocatorState)}`;
  }

  const sorted = [...records].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const latest = sorted[0]!;
  const pct =
    latest.spend.monthlyBudgetUsd > 0
      ? Math.round((latest.spend.runningMonthlyTotalUsd / latest.spend.monthlyBudgetUsd) * 100)
      : 0;
  const genericCount = records.filter((r) => r.authenticityCheck.readsAsGeneric).length;

  const lines: string[] = [
    `$${latest.spend.runningMonthlyTotalUsd.toFixed(2)} of $${latest.spend.monthlyBudgetUsd.toFixed(2)} used this month (${pct}%).`,
    `${genericCount} of ${records.length} creatives flagged as generic this period.`,
    "",
  ];

  const days = [...new Set(sorted.map((r) => dayKey(r.timestamp)))];
  for (const day of days) {
    lines.push(day);
    for (const r of sorted.filter((r) => dayKey(r.timestamp) === day)) {
      lines.push(renderActionLine(r));
    }
    lines.push("");
  }

  lines.push(renderAllocatorSummary(allocatorState));
  return lines.join("\n").trimEnd();
}
