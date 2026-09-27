import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { FeatureProposal } from "./evolution";

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
