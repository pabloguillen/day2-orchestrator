import { describe, expect, test } from "bun:test";
import { parseFeatureProposal } from "./evolution";

const validProposalText = `I fetched all 3 profiles and found a pattern.

PROPOSAL_JSON:
\`\`\`json
{
  "title": "Quick re-add last expense",
  "rationale": "Several profiles show repeated same-category, same-amount entries in close succession, suggesting recurring purchases (e.g. a daily coffee) that users re-enter from scratch each time.",
  "observedEvidence": "3 of 3 established devices show >=5 expense_added events in the same category with amounts within $0.50 of each other.",
  "proposedContract": "{ lastExpense: { amount: number; category: string; note: string } | null; onQuickAdd: () => void }",
  "openQuestions": ["Should this apply per-category or only the single most-recent expense?"]
}
\`\`\``;

describe("parseFeatureProposal", () => {
  test("parses a well-formed real proposal", () => {
    const result = parseFeatureProposal(validProposalText, false);
    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.proposal.title).toBe("Quick re-add last expense");
      expect(result.proposal.openQuestions).toHaveLength(1);
    }
  });

  test("a literal null block is a legitimate no_proposal, not a failure", () => {
    const text = `I checked all profiles carefully; nothing stood out as a real repeated pattern.

PROPOSAL_JSON: null`;
    expect(parseFeatureProposal(text, false)).toEqual({ status: "no_proposal" });
  });

  test("a null block wrapped in a json fence is also a legitimate no_proposal", () => {
    const text = "PROPOSAL_JSON:\n```json\nnull\n```";
    expect(parseFeatureProposal(text, false)).toEqual({ status: "no_proposal" });
  });

  test("fails closed on an agent error, even with an otherwise well-formed proposal in the text", () => {
    const result = parseFeatureProposal(validProposalText, true);
    expect(result.status).toBe("parse_failed");
  });

  test("fails closed when there is no PROPOSAL_JSON marker at all", () => {
    const result = parseFeatureProposal("I looked at the data but forgot to conclude.", false);
    expect(result.status).toBe("parse_failed");
  });

  test("fails closed on malformed JSON after the marker", () => {
    const text = "PROPOSAL_JSON:\n```json\n{ not valid json\n```";
    expect(parseFeatureProposal(text, false).status).toBe("parse_failed");
  });

  test("fails closed when a required field is missing", () => {
    const text = `PROPOSAL_JSON:
\`\`\`json
{
  "title": "Missing fields",
  "rationale": "x"
}
\`\`\``;
    const result = parseFeatureProposal(text, false);
    expect(result.status).toBe("parse_failed");
  });

  test("fails closed when title is present but empty", () => {
    const text = `PROPOSAL_JSON:
\`\`\`json
{
  "title": "   ",
  "rationale": "x",
  "observedEvidence": "x",
  "proposedContract": "x",
  "openQuestions": []
}
\`\`\``;
    expect(parseFeatureProposal(text, false).status).toBe("parse_failed");
  });

  test("fails closed when openQuestions contains a non-string", () => {
    const text = `PROPOSAL_JSON:
\`\`\`json
{
  "title": "x",
  "rationale": "x",
  "observedEvidence": "x",
  "proposedContract": "x",
  "openQuestions": ["ok", 42]
}
\`\`\``;
    expect(parseFeatureProposal(text, false).status).toBe("parse_failed");
  });

  test("fails closed on an empty transcript", () => {
    expect(parseFeatureProposal("", false).status).toBe("parse_failed");
  });

  test("accepts an empty openQuestions array — not every proposal needs open questions", () => {
    const text = `PROPOSAL_JSON:
\`\`\`json
{
  "title": "x",
  "rationale": "x",
  "observedEvidence": "x",
  "proposedContract": "x",
  "openQuestions": []
}
\`\`\``;
    const result = parseFeatureProposal(text, false);
    expect(result.status).toBe("proposed");
  });

  test("accepts a proposal with no competitorContext key at all — it's optional, not required", () => {
    const result = parseFeatureProposal(validProposalText, false);
    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.proposal.competitorContext).toBeUndefined();
    }
  });

  test("a well-formed, non-empty competitorContext is captured", () => {
    const text = `PROPOSAL_JSON:
\`\`\`json
{
  "title": "x",
  "rationale": "x",
  "observedEvidence": "x",
  "proposedContract": "x",
  "openQuestions": [],
  "competitorContext": "YNAB requires manual approval of imported transactions before they count toward the budget (source: ynab.com/features)"
}
\`\`\``;
    const result = parseFeatureProposal(text, false);
    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.proposal.competitorContext).toContain("YNAB");
    }
  });

  test("fails closed when competitorContext is present but empty — omit the key, don't set it empty", () => {
    const text = `PROPOSAL_JSON:
\`\`\`json
{
  "title": "x",
  "rationale": "x",
  "observedEvidence": "x",
  "proposedContract": "x",
  "openQuestions": [],
  "competitorContext": "   "
}
\`\`\``;
    expect(parseFeatureProposal(text, false).status).toBe("parse_failed");
  });

  test("fails closed when competitorContext is present but not a string", () => {
    const text = `PROPOSAL_JSON:
\`\`\`json
{
  "title": "x",
  "rationale": "x",
  "observedEvidence": "x",
  "proposedContract": "x",
  "openQuestions": [],
  "competitorContext": 42
}
\`\`\``;
    expect(parseFeatureProposal(text, false).status).toBe("parse_failed");
  });
});
