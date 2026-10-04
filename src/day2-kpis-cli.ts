import { resolve } from "node:path";
import { isAlreadyRejected } from "./evolution";
import {
  computeChangeSuccessRate,
  computeOwnerUndoRate,
  computeProposalApprovalRate,
  computeRollbackRate,
  type AutoAppliedChangeRecord,
  type MetricValue,
  type ProposalRecord,
  type ReleaseRecord,
} from "./metrics";
import { loadAuditEntries, type AuditEntry } from "./owner-feed";
import { listProposals, listRejections, type RecordedProposal, type RejectedProposal } from "./proposals";
import { loadReleaseResults, type RecordedReleaseResult } from "./release";

/**
 * CLI entrypoint for "day2 itself" system-health KPIs (docs/closed-loop-spec.md
 * §4.3, `metrics/day2-kpis.ts`). The math there (change-success rate,
 * rollback rate, proposal-approval rate, owner-undo rate) is real and
 * already tested, but — per that file's own header comment — "a thin
 * loader mapping a real audit file into these shapes is a fast-follow, not
 * built in this pass." Nothing ever built that loader, so the module had no
 * real production caller — a real orphaned-module finding from the
 * independent audit. This file is that loader + its CLI caller.
 *
 * Deliberately kept out of `day2-kpis.ts` itself: that file's own header
 * comment explains its input types are "structural ... not imported
 * directly, same cross-component decoupling growth-execution.ts::
 * StoredEventLike established in M1 ... this file's job is the metric math,
 * not coupling to five other files' exact JSONL shapes." Importing
 * release.ts/autonomy.ts/proposals.ts/evolution.ts directly into
 * day2-kpis.ts would undo exactly that decoupling. A CLI is this
 * codebase's own established place to do that coupling instead —
 * `growth-digest-cli.ts` already pulls together owner-feed.ts +
 * growth-feed.ts + proposals.ts + approvals.ts in exactly the same way.
 *
 * Usage:
 *   bun run src/day2-kpis-cli.ts --repo <path> \
 *     [--release-file <name>] [--audit-file <name>] \
 *     [--proposals-file <name>] [--rejections-file <name>] [--as-of <iso>]
 */

/**
 * `release.ts`'s real on-disk release-attempt log (`RecordedReleaseResult`,
 * written by `recordReleaseResult`, default file `day2-release-results.jsonl`
 * per `canary-cli.ts`/`auto-release-cli.ts`'s own real defaults) mapped into
 * day2-kpis.ts's `ReleaseRecord`.
 *
 * Only `"promoted"` and `"rolled_back"` attempts count as real releases:
 * `"smoke_check_failed"`/`"swarm_check_failed"` never shifted any real
 * production traffic, and `"dry_run_stopped_before_traffic_shift"`
 * deliberately stops before that same point (`release.ts`'s own
 * `isFailureStatus` doc comment) — none of those three are a "shipped
 * change" change-success-rate or rollback-rate should judge at all.
 */
export function toReleaseRecords(results: RecordedReleaseResult[]): ReleaseRecord[] {
  const records: ReleaseRecord[] = [];
  for (const r of results) {
    if (r.result.status === "promoted") {
      records.push({ shippedAt: r.timestamp, rolledBack: false });
    } else if (r.result.status === "rolled_back") {
      records.push({ shippedAt: r.timestamp, rolledBack: true });
    }
  }
  return records;
}

/**
 * `proposals.ts`'s real on-disk proposal log (`RecordedProposal`, default
 * file `day2-proposals.jsonl`) and rejection log (`RejectedProposal`,
 * default file `day2-proposal-rejections.jsonl`, both per
 * `evolution-cli.ts`'s own real defaults) mapped into day2-kpis.ts's
 * `ProposalRecord`. Join key is the same case-insensitive, trimmed title
 * match `evolution.ts::isAlreadyRejected` already uses to recognize a
 * previously-rejected idea — reused here rather than re-implemented, one
 * source of truth for "is this proposal the same one that was rejected".
 *
 * `approved: true` is never produced by this mapping: nothing in this
 * codebase persists a real "a human approved this proposal" event anywhere
 * — `recordProposal`/`recordRejection` are the only two writers that exist
 * for proposals. A proposal is either found in the rejections log
 * (`approved: false`) or still genuinely undecided (`approved: null`,
 * excluded from `computeProposalApprovalRate`'s denominator, same as every
 * other still-pending proposal). This is a real, disclosed gap, not a
 * fabricated value: until something records real approvals,
 * `proposal_approval_rate` can only ever report 0% or "no data" from real
 * data, never a positive rate.
 */
export function toProposalRecords(proposals: RecordedProposal[], rejections: RejectedProposal[]): ProposalRecord[] {
  return proposals.map((p) => ({
    proposedAt: p.recordedAt,
    approved: isAlreadyRejected(p.title, rejections) ? false : null,
  }));
}

/**
 * `autonomy.ts`'s real on-disk decision audit trail (`AuditEntry`, read via
 * `owner-feed.ts::loadAuditEntries`) — `autoShip: true` entries are exactly
 * day2-kpis.ts's own "auto-applied changes" population, the real "applied"
 * half of `AutoAppliedChangeRecord`.
 *
 * The "undone" half has no real on-disk source anywhere in this codebase:
 * `approvals.ts::undoChange` runs `gh pr close` directly and writes no
 * audit trail of its own, so there is no durable record linking one
 * specific auto-applied change to whether an owner later reversed it.
 * (`trust.ts`'s `AutonomyOutcome` records `"rolled_back"`, but that's a
 * materially different, already-separately-measured event — an automatic
 * canary rollback on an error-count guardrail, already
 * `computeRollbackRate`'s job — and conflating the two would double-count
 * the same real event under two metrics while also mislabeling pre-flight
 * smoke/swarm-check failures, which never shipped real traffic at all, as
 * "undone".)
 *
 * Rather than assert `undone: false` for every entry — which would make
 * `computeOwnerUndoRate` report a confident, specific 0% that reads as
 * "owners never undo anything" instead of the true "this isn't tracked
 * yet" — this returns an empty array, so the metric honestly reports
 * `value: null, sufficientData: false` (this codebase's own established
 * "null means genuinely no data, not zero" convention, `MetricValue`'s own
 * doc comment in metrics/types.ts) until `undoChange` gains a real audit
 * trail of its own to read from.
 */
export function toAutoAppliedChangeRecords(autoShipEntries: AuditEntry[]): AutoAppliedChangeRecord[] {
  void autoShipEntries; // intentionally unused today — see doc comment above
  return [];
}

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    repo: get("--repo"),
    releaseFile: get("--release-file") ?? "day2-release-results.jsonl",
    auditFile: get("--audit-file") ?? "day2-autonomy-audit.jsonl",
    proposalsFile: get("--proposals-file") ?? "day2-proposals.jsonl",
    rejectionsFile: get("--rejections-file") ?? "day2-proposal-rejections.jsonl",
    asOf: get("--as-of"),
  };
}

function fmt(mv: MetricValue): string {
  if (mv.value === null) return `no data (n=${mv.n})`;
  const pct = `${(mv.value * 100).toFixed(1)}%`;
  return mv.sufficientData ? `${pct} (n=${mv.n})` : `${pct} (n=${mv.n}, below confidence threshold)`;
}

export function renderDay2Kpis(
  changeSuccessRate: MetricValue,
  rollbackRate: MetricValue,
  proposalApprovalRate: MetricValue,
  ownerUndoRate: MetricValue,
  asOfIso: string,
): string {
  return [
    `Day2 system health, as of ${asOfIso}`,
    `  change_success_rate:    ${fmt(changeSuccessRate)}`,
    `  rollback_rate:          ${fmt(rollbackRate)}`,
    `  proposal_approval_rate: ${fmt(proposalApprovalRate)}`,
    `  owner_undo_rate:        ${fmt(ownerUndoRate)}`,
  ].join("\n");
}

function usage(): never {
  console.error(
    "Usage: bun run src/day2-kpis-cli.ts --repo <path> " +
      "[--release-file <name>] [--audit-file <name>] [--proposals-file <name>] " +
      "[--rejections-file <name>] [--as-of <iso>]",
  );
  process.exit(1);
}

function main() {
  const opts = parseArgs();
  if (!opts.repo) usage();
  const repoPath = resolve(opts.repo);
  const asOfIso = opts.asOf ?? new Date().toISOString();

  const releaseResults = loadReleaseResults(resolve(repoPath, opts.releaseFile));
  const auditEntries = loadAuditEntries(resolve(repoPath, opts.auditFile));
  const proposals = listProposals(resolve(repoPath, opts.proposalsFile));
  const rejections = listRejections(resolve(repoPath, opts.rejectionsFile));

  const releases = toReleaseRecords(releaseResults);
  const proposalRecords = toProposalRecords(proposals, rejections);
  const autoApplied = toAutoAppliedChangeRecords(auditEntries.filter((e) => e.autoShip));

  console.log(
    renderDay2Kpis(
      computeChangeSuccessRate(releases, asOfIso),
      computeRollbackRate(releases),
      computeProposalApprovalRate(proposalRecords),
      computeOwnerUndoRate(autoApplied),
      asOfIso,
    ),
  );
}

if (import.meta.main) {
  main();
}
