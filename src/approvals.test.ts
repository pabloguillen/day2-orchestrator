import { describe, expect, test } from "bun:test";
import { classifyDefaultAction, parsePrBody, renderChangeCard, type ChangeCard } from "./approvals";

const realFixAgentBody = `## What happened
The "Amount" input in the add-expense form had no visible focus indicator.

## What changed
Added a visible focus outline to the Amount input specifically.

## Evidence
Added a test confirming the outline is invisible before the fix and visible
after; confirmed it fails against the original code; 51/51 tests passing.

---
_Opened automatically by Day2 in response to a manual signal (abc123). A human should review before merging — this is never auto-merged._`;

describe("parsePrBody", () => {
  test("parses the real fix-agent template exactly", () => {
    const result = parsePrBody(realFixAgentBody);
    expect(result.whatHappened).toContain("no visible focus indicator");
    expect(result.whatChanged).toContain("Added a visible focus outline");
    expect(result.evidence).toContain("51/51 tests passing");
    // The disclosure footer must not leak into any section's text.
    expect(result.evidence).not.toContain("Opened automatically");
  });

  test("falls back to the whole body under whatHappened when there's no template at all", () => {
    const result = parsePrBody("Just a plain PR description, no headers.");
    expect(result.whatHappened).toBe("Just a plain PR description, no headers.");
    expect(result.whatChanged).toBe("");
    expect(result.evidence).toBe("");
  });

  test("handles an empty body without throwing", () => {
    const result = parsePrBody("");
    expect(result.whatHappened).toBe("(no description provided)");
  });

  test("reports a missing individual section honestly rather than fabricating one", () => {
    const result = parsePrBody("## What happened\nSomething broke.\n\n## Evidence\nA test.");
    expect(result.whatHappened).toContain("Something broke.");
    expect(result.whatChanged).toBe("(not described)");
    expect(result.evidence).toContain("A test.");
  });
});

describe("classifyDefaultAction", () => {
  test("defaults ordinary UI bug fixes to auto-apply, per the source doc's own table", () => {
    const result = classifyDefaultAction(["src/routes/index.tsx", "src/routes/-index.test.tsx"]);
    expect(result.action).toBe("auto-apply");
  });

  test("always asks first for a change touching a payments path", () => {
    const result = classifyDefaultAction(["src/lib/payments/checkout.ts"]);
    expect(result.action).toBe("ask-first");
    expect(result.reason).toContain("sensitive path");
  });

  test("always asks first for a change touching an auth/login path", () => {
    const result = classifyDefaultAction(["src/routes/login.tsx"]);
    expect(result.action).toBe("ask-first");
  });

  test("always asks first for a database migration/schema change", () => {
    const result = classifyDefaultAction(["migrations/0007_add_users_table.sql"]);
    expect(result.action).toBe("ask-first");
  });

  test("a mix of an ordinary file and one sensitive file still asks first", () => {
    const result = classifyDefaultAction(["src/routes/index.tsx", "src/lib/auth/session.ts"]);
    expect(result.action).toBe("ask-first");
  });
});

describe("renderChangeCard", () => {
  const baseCard: ChangeCard = {
    number: 20,
    title: 'Fix: "Newest first" expense list shows same-day entries in the wrong order',
    branch: "day2-fix-newest-first-expense-list-shows-same-day-7b304e27",
    url: "https://github.com/pabloguillen/expense-buddy/pull/20",
    whatHappened: "Same-day expenses rendered oldest-first, not newest-first.",
    whatChanged: "Tie-break same-date entries by insertion index instead of array order.",
    evidence: "New regression test fails on the original code, passes on the fix. 51/51 tests.",
    filesChanged: ["src/routes/index.tsx"],
    defaultAction: "auto-apply",
    defaultReason: "Bug fix restoring intended behavior (Step 1).",
  };

  test("renders all card content, the recommended default, and all three actions", () => {
    const rendered = renderChangeCard(baseCard);
    expect(rendered).toContain(baseCard.whatHappened);
    expect(rendered).toContain(baseCard.whatChanged);
    expect(rendered).toContain(baseCard.evidence);
    expect(rendered).toContain("Recommended default: Apply");
    expect(rendered).toContain("Apply");
    expect(rendered).toContain("Undo");
    expect(rendered).toContain("Ask a question");
    expect(rendered).toContain("#20");
    expect(rendered).toContain(baseCard.url);
  });

  test("recommends asking first, not applying, for an ask-first card", () => {
    const rendered = renderChangeCard({
      ...baseCard,
      defaultAction: "ask-first",
      defaultReason: "Touches a sensitive path (src/lib/auth/session.ts).",
    });
    expect(rendered).toContain("Recommended default: Ask a question first");
    expect(rendered).not.toContain("Recommended default: Apply");
  });
});
