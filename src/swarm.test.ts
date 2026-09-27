import { describe, expect, test } from "bun:test";
import { DEFAULT_PERSONAS, parseComparisonResult, parseVerdict } from "./swarm";

describe("parseVerdict", () => {
  test("a clean PASS verdict passes", () => {
    const result = parseVerdict("Did some testing.\nSWARM_VERDICT: PASS", false);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe("SWARM_VERDICT: PASS");
  });

  test("a FAIL verdict with a reason fails and preserves the reason", () => {
    const result = parseVerdict(
      "Investigated the form.\nSWARM_VERDICT: FAIL — amount field has no focus style",
      false,
    );
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("amount field has no focus style");
  });

  test("isError true fails even if the transcript happens to contain PASS", () => {
    const result = parseVerdict("Ran out of turns.\nSWARM_VERDICT: PASS", true);
    expect(result.passed).toBe(false);
  });

  test("no verdict line at all fails closed rather than defaulting to a pass", () => {
    const result = parseVerdict("The agent rambled and never concluded.", false);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("rambled");
  });

  test("empty transcript fails closed with a placeholder summary", () => {
    const result = parseVerdict("", false);
    expect(result.passed).toBe(false);
    expect(result.summary).toBe("(no output)");
  });

  test("only uses the first SWARM_VERDICT line, ignoring stray mentions elsewhere", () => {
    const result = parseVerdict(
      "I will not write SWARM_VERDICT: PASS until I'm sure.\nSWARM_VERDICT: FAIL — found a bug",
      false,
    );
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("found a bug");
  });
});

describe("parseComparisonResult", () => {
  test("a well-formed completed run parses all three fields", () => {
    const result = parseComparisonResult(
      "Did the task.\nCOMPARISON_COMPLETED: true\nCOMPARISON_ACTIONS: 14\nCOMPARISON_FRICTION: none",
      false,
    );
    expect(result.completed).toBe(true);
    expect(result.actionCount).toBe(14);
    expect(result.friction).toBe("none");
  });

  test("COMPARISON_COMPLETED: false is not completed, even with other fields present", () => {
    const result = parseComparisonResult(
      "COMPARISON_COMPLETED: false\nCOMPARISON_ACTIONS: 5\nCOMPARISON_FRICTION: got stuck on the date picker",
      false,
    );
    expect(result.completed).toBe(false);
    expect(result.friction).toContain("date picker");
  });

  test("isError true fails closed even if the transcript claims completion", () => {
    const result = parseComparisonResult(
      "COMPARISON_COMPLETED: true\nCOMPARISON_ACTIONS: 10\nCOMPARISON_FRICTION: none",
      true,
    );
    expect(result.completed).toBe(false);
  });

  test("missing the completion line entirely fails closed, not defaults to completed", () => {
    const result = parseComparisonResult("The agent rambled and never finished.", false);
    expect(result.completed).toBe(false);
    expect(result.actionCount).toBeNull();
    expect(result.friction).toBe("(no friction line reported)");
  });

  test("a non-numeric action count is reported as null rather than 0 or NaN", () => {
    const result = parseComparisonResult(
      "COMPARISON_COMPLETED: true\nCOMPARISON_ACTIONS: several\nCOMPARISON_FRICTION: none",
      false,
    );
    expect(result.actionCount).toBeNull();
  });

  test("an error run gets an explicit placeholder friction message, not empty", () => {
    const result = parseComparisonResult("(agent run threw before producing a result: timeout)", true);
    expect(result.friction).toBe("(agent run did not complete)");
  });
});

describe("DEFAULT_PERSONAS", () => {
  test("every base persona runs at both desktop and mobile viewports", () => {
    expect(DEFAULT_PERSONAS).toHaveLength(6);
    const names = DEFAULT_PERSONAS.map((p) => p.name).sort();
    expect(names).toEqual(
      [
        "accessibility-auditor-desktop",
        "accessibility-auditor-mobile",
        "adversarial-input-desktop",
        "adversarial-input-mobile",
        "novice-user-desktop",
        "novice-user-mobile",
      ].sort(),
    );
  });

  test("a base persona's task text is identical across its two viewport variants", () => {
    const desktop = DEFAULT_PERSONAS.find((p) => p.name === "novice-user-desktop")!;
    const mobile = DEFAULT_PERSONAS.find((p) => p.name === "novice-user-mobile")!;
    expect(desktop.task).toBe(mobile.task);
    expect(desktop.viewport).toBe("desktop");
    expect(mobile.viewport).toBe("mobile");
  });

  test("accessibility-auditor is warned against the two real false positives hit live (W21)", () => {
    // Both were real, proven false positives, not hypothetical: a CSS
    // opacity transition read mid-animation (misreported as permanently
    // invisible), and document.activeElement reporting a shadow host
    // instead of the real focused node inside an open shadow root
    // (misreported a real, visible, labeled third-party widget button as an
    // invisible, unlabeled focus trap). Without this guidance the persona
    // keeps generating the exact same false blocks on every future run.
    const auditor = DEFAULT_PERSONAS.find((p) => p.name === "accessibility-auditor-desktop")!;
    expect(auditor.task).toMatch(/transition/i);
    expect(auditor.task).toMatch(/shadowRoot/);
    expect(auditor.task).toMatch(/activeElement/);
  });

  test("accessibility-auditor is warned that native form-control segments need a screenshot, not a computed-style check (W25)", () => {
    // A real third false positive: getComputedStyle() on a native
    // <input type="date">'s outer element can't see its own internal
    // day/month/year segment highlighting at all (browser-internal UI, not
    // a CSS property) — confirmed directly against both Chromium and real
    // WebKit before concluding it was a false positive, not guessed.
    const auditor = DEFAULT_PERSONAS.find((p) => p.name === "accessibility-auditor-desktop")!;
    expect(auditor.task).toMatch(/getComputedStyle/);
    expect(auditor.task).toMatch(/screenshot/i);
  });
});
