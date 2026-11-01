import { describe, expect, test } from "bun:test";
import { buildChangePrompt, isQuestion } from "./change-questions";

describe("questions about a change", () => {
  test("the prompt carries the ticket, the pull request and its diff — as data — and the question", () => {
    const p = buildChangePrompt("Does this change the onboarding?", {
      pr: { number: 2, title: "Add public pages", body: "## What this adds\nPages", diff: "+<h1>Find friends</h1>" },
      ticket: { id: "D2-1", title: "Add public pages", description: "Pages people search for", doneWhen: ["Pages exist"], recent: ["day2: opened PR #2"] },
    });
    expect(p).toContain("Backlog ticket D2-1: Add public pages");
    expect(p).toContain("Pull request #2: Add public pages");
    expect(p).toContain("+<h1>Find friends</h1>");
    expect(p).toContain("- Pages exist");
    expect(p.indexOf("<<<UNTRUSTED_CHANGE_START>>>")).toBeLessThan(p.indexOf("Diff:"));
    expect(p.trimEnd().endsWith("Does this change the onboarding?\n<<<OWNER_QUESTION_END>>>")).toBe(true);
  });

  test("ticket comments that ask something get an answer; notes don't", () => {
    expect(isQuestion("Why does this touch the website?")).toBe(true);
    expect(isQuestion("Warum ist das nötig")).toBe(true);
    expect(isQuestion("how risky is it")).toBe(true);
    expect(isQuestion("Looks good, ship it.")).toBe(false);
    expect(isQuestion("Please use the brand color.")).toBe(false);
  });
});
