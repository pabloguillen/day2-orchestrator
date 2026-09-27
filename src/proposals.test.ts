import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProposals, recordProposal, renderProposalCard } from "./proposals";
import type { FeatureProposal } from "./evolution";

const sampleProposal: FeatureProposal = {
  title: "Quick re-add last expense",
  rationale: "Repeated same-category, same-amount entries suggest a recurring purchase.",
  observedEvidence: "3 of 3 profiles show >=5 same-category entries within $0.50 of each other.",
  proposedContract: "{ lastExpense: {...} | null; onQuickAdd: () => void }",
  openQuestions: ["Per-category or single most-recent expense?"],
};

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordProposal / listProposals", () => {
  test("listProposals returns an empty array when the file doesn't exist yet", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "day2-proposals-"));
    expect(listProposals(join(tmpDir, "nonexistent.jsonl"))).toEqual([]);
  });

  test("records a proposal and reads it back with a real timestamp", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "day2-proposals-"));
    const file = join(tmpDir, "proposals.jsonl");
    recordProposal(file, sampleProposal);
    expect(existsSync(file)).toBe(true);

    const recorded = listProposals(file);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.title).toBe(sampleProposal.title);
    expect(typeof recorded[0]!.recordedAt).toBe("string");
    expect(new Date(recorded[0]!.recordedAt).toString()).not.toBe("Invalid Date");
  });

  test("multiple recordings append, never overwrite", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "day2-proposals-"));
    const file = join(tmpDir, "proposals.jsonl");
    recordProposal(file, sampleProposal);
    recordProposal(file, { ...sampleProposal, title: "Second proposal" });

    const recorded = listProposals(file);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.title).toBe("Quick re-add last expense");
    expect(recorded[1]!.title).toBe("Second proposal");
  });
});

describe("renderProposalCard", () => {
  test("renders every field into plain language", () => {
    const rendered = renderProposalCard(sampleProposal);
    expect(rendered).toContain(sampleProposal.title);
    expect(rendered).toContain(sampleProposal.rationale);
    expect(rendered).toContain(sampleProposal.observedEvidence);
    expect(rendered).toContain(sampleProposal.proposedContract);
    expect(rendered).toContain("Per-category or single most-recent expense?");
  });

  test("omits the open-questions section entirely when there are none", () => {
    const rendered = renderProposalCard({ ...sampleProposal, openQuestions: [] });
    expect(rendered).not.toContain("Open questions");
  });

  test("includes the recorded timestamp only for a RecordedProposal, not a bare FeatureProposal", () => {
    const bare = renderProposalCard(sampleProposal);
    expect(bare).not.toContain("Proposed 20"); // no ISO-timestamp prefix rendered

    const recorded = renderProposalCard({ ...sampleProposal, recordedAt: "2026-09-27T12:00:00.000Z" });
    expect(recorded).toContain("Proposed 2026-09-27T12:00:00.000Z");
    expect(recorded).toContain("Not built");
  });

  test("never renders Apply/Undo/Ask buttons — a proposal is pre-code, unlike approvals.ts's cards", () => {
    const rendered = renderProposalCard(sampleProposal);
    expect(rendered).not.toContain("[ Apply ]");
  });

  test("omits the market-context section entirely when no competitorContext is present", () => {
    const rendered = renderProposalCard(sampleProposal);
    expect(rendered).not.toContain("Market context");
  });

  test("renders competitorContext as a clearly-labeled, supporting-only section when present", () => {
    const rendered = renderProposalCard({
      ...sampleProposal,
      competitorContext: "YNAB requires manual approval of imported transactions (source: ynab.com/features)",
    });
    expect(rendered).toContain("Market context");
    expect(rendered).toContain("not the primary justification");
    expect(rendered).toContain("YNAB requires manual approval");
  });
});
