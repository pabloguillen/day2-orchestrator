import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { FeatureProposal, RejectedProposal } from "./evolution";

/**
 * The review surface for evolution-engine proposals (COORDINATION.md W32,
 * Step 3 Component 3). Deliberately a separate file from `approvals.ts`,
 * not an extension of it: `approvals.ts`'s `ChangeCard` assumes a PR
 * number, branch, and diff — a proposal has none of those, it's a
 * document a human reads and decides on before any code exists at all.
 * Both surfaces share the same underlying idea (plain-language card, a
 * human makes the call) but are genuinely different review objects.
 */

export type RecordedProposal = FeatureProposal & { recordedAt: string };

/** Append-only JSONL audit trail, same idiom as `autonomy.ts`'s
 * `recordAutonomyAudit` and `calibration.ts`'s `recordCalibrationAudit` —
 * one JSON object per line, never rewritten or deduplicated here (a human
 * reviewing the list makes that call, not this function). */
export function recordProposal(proposalsFile: string, proposal: FeatureProposal): void {
  const entry: RecordedProposal = { ...proposal, recordedAt: new Date().toISOString() };
  appendFileSync(proposalsFile, JSON.stringify(entry) + "\n");
}

/** Read-only. An absent file is a normal case (no proposals recorded yet),
 * not an error — returns an empty list rather than throwing. */
export function listProposals(proposalsFile: string): RecordedProposal[] {
  if (!existsSync(proposalsFile)) return [];
  const lines = readFileSync(proposalsFile, "utf-8").split("\n").filter((l) => l.trim());
  return lines.map((line) => JSON.parse(line) as RecordedProposal);
}

/** Separate file from the proposals log on purpose, same reasoning as
 * `trust.ts`'s outcome log: `listProposals` parses every line as a
 * `RecordedProposal` and would break on a differently-shaped record mixed
 * in. Without this, nothing ever persisted a human's "no" — `evolution.ts`
 * had no way to know a proposal had already been reviewed and declined, so
 * the same idea could resurface every run the underlying pattern was still
 * present in the data. */
export function recordRejection(rejectionsFile: string, title: string, reason: string): void {
  const entry: RejectedProposal = { title, reason, rejectedAt: new Date().toISOString() };
  appendFileSync(rejectionsFile, JSON.stringify(entry) + "\n");
}

/** Read-only. An absent file means nothing has ever been rejected yet. */
export function listRejections(rejectionsFile: string): RejectedProposal[] {
  if (!existsSync(rejectionsFile)) return [];
  const lines = readFileSync(rejectionsFile, "utf-8").split("\n").filter((l) => l.trim());
  return lines.map((line) => JSON.parse(line) as RejectedProposal);
}

/** Plain-language rendering matching the source doc's own card framing —
 * what happened (the pattern noticed), the evidence, what's being
 * proposed, and what a reviewer still needs to decide. No Apply/Undo/Ask
 * buttons here on purpose: unlike `approvals.ts`'s cards (reviewing a
 * change that's already built, tested, and sitting in a real PR), a
 * proposal is pre-code — there's nothing to apply yet. A human's real next
 * action is "build this, ask a question about it, or reject it", which
 * happens outside this tool, not as a button click on this card. */
export function renderProposalCard(proposal: RecordedProposal | FeatureProposal): string {
  const lines: string[] = [];
  lines.push(`# Proposed: ${proposal.title}`);
  lines.push("");
  lines.push(`**Why:** ${proposal.rationale}`);
  lines.push("");
  lines.push(`**What we observed:** ${proposal.observedEvidence}`);
  lines.push("");
  lines.push("**Proposed contract:**");
  lines.push("```");
  lines.push(proposal.proposedContract);
  lines.push("```");
  if (proposal.competitorContext) {
    lines.push("");
    lines.push(`**Market context (supporting, not the primary justification):** ${proposal.competitorContext}`);
  }
  if (proposal.openQuestions.length > 0) {
    lines.push("");
    lines.push("**Open questions for the reviewer:**");
    for (const q of proposal.openQuestions) lines.push(`- ${q}`);
  }
  if ("recordedAt" in proposal) {
    lines.push("");
    lines.push(`_Proposed ${proposal.recordedAt}. Not built. A human decides whether this is worth building._`);
  }
  return lines.join("\n");
}
