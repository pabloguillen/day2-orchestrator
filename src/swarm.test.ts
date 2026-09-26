import { describe, expect, test } from "bun:test";
import { DEFAULT_PERSONAS, parseVerdict } from "./swarm";

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
});
