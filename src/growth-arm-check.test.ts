import { describe, expect, test } from "bun:test";
import {
  evaluateArmLaunchGate,
  parseArmReachabilityVerdict,
  ruleIdForFailedArmCheck,
  traceForFailedArmCheck,
  type ArmReachabilityVerdict,
} from "./growth-arm-check";
import type { Arm } from "./growth-allocator";
import type { ClaimCheckVerdict, Creative } from "./growth-creative";

const arm: Arm = { channel: "social_content", assetType: "video", videoFormat: "ugc", formatTag: "angle-1" };
const creative: Creative = {
  arm,
  segment: "novice",
  headline: "Track every expense",
  body: "Real-time budget tracking",
  claimsCheckedAgainst: ["real-time budget tracking"],
  costUsd: 0.01,
};

function truthfulClaims(): ClaimCheckVerdict {
  return { creative, truthful: true, issues: [] };
}
function untruthfulClaims(): ClaimCheckVerdict {
  return { creative, truthful: false, issues: ["claims real-time sync; app has no backend/sync"] };
}
function passingReachability(): ArmReachabilityVerdict {
  return {
    reachedActivationWithinSteps: true,
    stepsToActivation: 3,
    maxSteps: 10,
    errorsSeen: [],
    accessibilityIssues: [],
    isError: false,
    summary: "Reached activation in 3 step(s).",
    costUsd: 0.02,
  };
}

describe("parseArmReachabilityVerdict — fail-closed parser", () => {
  test("a well-formed, real success verdict parses correctly", () => {
    const finalText = `I clicked the form and added an expense.
ARM_REACHABILITY_JSON:
{"reached": true, "stepsToActivation": 3, "errorsSeen": [], "accessibilityIssues": []}`;
    const result = parseArmReachabilityVerdict(finalText, false);
    expect(result.reachedActivationWithinSteps).toBe(true);
    expect(result.stepsToActivation).toBe(3);
  });

  test("isError always fails closed, even with an otherwise well-formed marker", () => {
    const finalText = `ARM_REACHABILITY_JSON:\n{"reached": true, "stepsToActivation": 2, "errorsSeen": [], "accessibilityIssues": []}`;
    const result = parseArmReachabilityVerdict(finalText, true);
    expect(result.reachedActivationWithinSteps).toBe(false);
  });

  test("a missing marker fails closed", () => {
    const result = parseArmReachabilityVerdict("I looked around but never found the marker.", false);
    expect(result.reachedActivationWithinSteps).toBe(false);
  });

  test("malformed JSON after the marker fails closed", () => {
    const result = parseArmReachabilityVerdict("ARM_REACHABILITY_JSON:\n{not json", false);
    expect(result.reachedActivationWithinSteps).toBe(false);
  });

  test("a claimed step count beyond the real 10-step bound fails closed even if reached:true", () => {
    const finalText = `ARM_REACHABILITY_JSON:\n{"reached": true, "stepsToActivation": 15, "errorsSeen": [], "accessibilityIssues": []}`;
    const result = parseArmReachabilityVerdict(finalText, false);
    expect(result.reachedActivationWithinSteps).toBe(false);
  });

  test("reached:false with a real errors list parses through correctly, doesn't lose the error evidence", () => {
    const finalText = `ARM_REACHABILITY_JSON:\n{"reached": false, "stepsToActivation": null, "errorsSeen": ["TypeError: cannot read undefined"], "accessibilityIssues": []}`;
    const result = parseArmReachabilityVerdict(finalText, false);
    expect(result.reachedActivationWithinSteps).toBe(false);
    expect(result.errorsSeen).toEqual(["TypeError: cannot read undefined"]);
  });

  test("an invalid shape (missing required fields) fails closed", () => {
    const result = parseArmReachabilityVerdict('ARM_REACHABILITY_JSON:\n{"reached": true}', false);
    expect(result.reachedActivationWithinSteps).toBe(false);
  });
});

describe("evaluateArmLaunchGate", () => {
  test("a genuinely clean arm (truthful claims, reachable, no errors) is allowed", () => {
    const result = evaluateArmLaunchGate(truthfulClaims(), passingReachability());
    expect(result.allowed).toBe(true);
  });

  test("untruthful claims block launch even when the path is perfectly reachable", () => {
    const result = evaluateArmLaunchGate(untruthfulClaims(), passingReachability());
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("unsupported_claims");
  });

  test("a broken path blocks launch even with truthful claims", () => {
    const broken: ArmReachabilityVerdict = { ...passingReachability(), reachedActivationWithinSteps: false, stepsToActivation: null };
    const result = evaluateArmLaunchGate(truthfulClaims(), broken);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("broken_path");
  });

  test("a real crash/error seen along an otherwise-reachable path blocks as a quality issue", () => {
    const buggy: ArmReachabilityVerdict = { ...passingReachability(), errorsSeen: ["Uncaught TypeError"] };
    const result = evaluateArmLaunchGate(truthfulClaims(), buggy);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("quality_issue");
  });

  test("a real accessibility issue along an otherwise-reachable path also blocks as a quality issue", () => {
    const inaccessible: ArmReachabilityVerdict = { ...passingReachability(), accessibilityIssues: ["missing focus indicator on Amount input"] };
    const result = evaluateArmLaunchGate(truthfulClaims(), inaccessible);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("quality_issue");
  });

  test("claims are checked before reachability — an untruthful AND broken arm reports the claims reason", () => {
    const broken: ArmReachabilityVerdict = { ...passingReachability(), reachedActivationWithinSteps: false };
    const result = evaluateArmLaunchGate(untruthfulClaims(), broken);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("unsupported_claims");
  });
});

describe("ruleIdForFailedArmCheck / traceForFailedArmCheck", () => {
  test("broken_path maps to D3, carries the real reachability summary as its trace", () => {
    const broken: ArmReachabilityVerdict = { ...passingReachability(), reachedActivationWithinSteps: false, stepsToActivation: null, summary: "Did not reach activation within 10 steps." };
    const result = evaluateArmLaunchGate(truthfulClaims(), broken);
    if (result.allowed) throw new Error("unreachable");
    expect(ruleIdForFailedArmCheck(result)).toBe("D3");
    expect(traceForFailedArmCheck(result)).toContain("Did not reach activation");
  });

  test("unsupported_claims and quality_issue both map to D2", () => {
    const claimsResult = evaluateArmLaunchGate(untruthfulClaims(), passingReachability());
    const buggy: ArmReachabilityVerdict = { ...passingReachability(), errorsSeen: ["real crash"] };
    const qualityResult = evaluateArmLaunchGate(truthfulClaims(), buggy);
    if (claimsResult.allowed || qualityResult.allowed) throw new Error("unreachable");
    expect(ruleIdForFailedArmCheck(claimsResult)).toBe("D2");
    expect(ruleIdForFailedArmCheck(qualityResult)).toBe("D2");
  });

  test("traceForFailedArmCheck carries the real claim issues for an unsupported-claims failure", () => {
    const result = evaluateArmLaunchGate(untruthfulClaims(), passingReachability());
    if (result.allowed) throw new Error("unreachable");
    expect(traceForFailedArmCheck(result)).toContain("real-time sync");
  });
});
