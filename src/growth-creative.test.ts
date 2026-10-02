import { describe, expect, test } from "bun:test";
import {
  generateCreatives,
  parseAuthenticityVerdict,
  parseClaimCheckVerdict,
  parseCreativeGenerationResult,
} from "./growth-creative";
import type { Creative } from "./growth-creative";
import type { Arm } from "./growth-allocator";
import type { AppProfile } from "./onboarding";

function makeArm(overrides: Partial<Arm> = {}): Arm {
  return { channel: "social_content", assetType: "text", formatTag: "v1", ...overrides };
}

function makeAppProfile(overrides: Partial<AppProfile> = {}): AppProfile {
  return {
    purpose: "Track personal expenses",
    targetUsers: "Budget-conscious individuals",
    featureMap: ["expense entry", "categorization"],
    styleGuide: { colors: ["#1a1a1a", "#f5f5f5"], framework: "Tailwind" },
    toneOfVoice: "calm, plain-spoken, no hype",
    businessModel: null,
    caveats: [],
    competitors: null,
    currentState: null,
    currentStateCaveat: "not scanned",
    scannedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function makeCreative(overrides: Partial<Creative> = {}): Creative {
  return {
    arm: makeArm(),
    segment: "new-users",
    headline: "Track every expense in seconds",
    body: "A quiet, simple expense tracker.",
    claimsCheckedAgainst: ["tracks expenses in seconds"],
    costUsd: 0.05,
    ...overrides,
  };
}

const GEN_MARKER = "CREATIVE_GENERATION_JSON:";
const CLAIM_MARKER = "CLAIM_CHECK_JSON:";
const AUTH_MARKER = "AUTHENTICITY_CHECK_JSON:";

describe("generateCreatives — mandatory grounding gate", () => {
  test("fails closed to no_creative_worth_generating when toneOfVoice is null, without calling the agent", async () => {
    const result = await generateCreatives(
      "https://example.com",
      makeAppProfile({ toneOfVoice: null }),
      makeArm(),
      "new-users",
    );
    expect(result.status).toBe("no_creative_worth_generating");
    if (result.status === "no_creative_worth_generating") {
      expect(result.reason).toContain("toneOfVoice");
    }
  });

  test("fails closed to no_creative_worth_generating when styleGuide is null, without calling the agent", async () => {
    const result = await generateCreatives(
      "https://example.com",
      makeAppProfile({ styleGuide: null }),
      makeArm(),
      "new-users",
    );
    expect(result.status).toBe("no_creative_worth_generating");
    if (result.status === "no_creative_worth_generating") {
      expect(result.reason).toContain("styleGuide");
    }
  });
});

describe("parseCreativeGenerationResult", () => {
  const arm = makeArm();

  test("parses a well-formed generated result and splits cost evenly across creatives", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({
      status: "generated",
      creatives: [
        { headline: "A", body: "B", claimsCheckedAgainst: ["x"] },
        { headline: "C", body: "D", claimsCheckedAgainst: ["y"] },
      ],
    })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0.1);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.creatives).toHaveLength(2);
      expect(result.creatives[0]!.costUsd).toBeCloseTo(0.05);
      expect(result.creatives[0]!.arm).toEqual(arm);
      expect(result.creatives[0]!.segment).toBe("new-users");
    }
  });

  test("parses an honest no_creative_worth_generating result", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({ status: "no_creative_worth_generating", reason: "not enough grounding" })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0);
    expect(result).toEqual({ status: "no_creative_worth_generating", reason: "not enough grounding" });
  });

  test("fails closed to parse_failed when the marker is missing", () => {
    const result = parseCreativeGenerationResult("no marker here", arm, "new-users", 0);
    expect(result.status).toBe("parse_failed");
  });

  test("fails closed to parse_failed on malformed JSON", () => {
    const result = parseCreativeGenerationResult(`${GEN_MARKER}\nnot json {{{`, arm, "new-users", 0);
    expect(result.status).toBe("parse_failed");
  });

  test("drops individually invalid creatives but keeps the valid ones", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({
      status: "generated",
      creatives: [
        { headline: "Valid", body: "Body", claimsCheckedAgainst: [] },
        { headline: "", body: "Missing headline", claimsCheckedAgainst: [] },
      ],
    })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0.06);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.creatives).toHaveLength(1);
      expect(result.creatives[0]!.headline).toBe("Valid");
      expect(result.creatives[0]!.costUsd).toBeCloseTo(0.06);
    }
  });

  test("fails closed to parse_failed when every creative in the array is invalid", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({ status: "generated", creatives: [{ headline: "" }] })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0);
    expect(result.status).toBe("parse_failed");
  });

  test("preserves optional imageDescription/videoAssetRef/videoStyle only when present", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({
      status: "generated",
      creatives: [{ headline: "A", body: "B", claimsCheckedAgainst: [], imageDescription: "a real screenshot description" }],
    })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0.02);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.creatives[0]!.imageDescription).toBe("a real screenshot description");
      expect(result.creatives[0]!.videoAssetRef).toBeUndefined();
    }
  });

  test("keeps groundedInPatternId when it matches a real, provided pattern id", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({
      status: "generated",
      creatives: [{ headline: "A", body: "B", claimsCheckedAgainst: [], groundedInPatternId: "pattern-1" }],
    })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0.02, new Set(["pattern-1", "pattern-2"]));
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.creatives[0]!.groundedInPatternId).toBe("pattern-1");
    }
  });

  test("drops a fabricated/stale groundedInPatternId that doesn't match anything the agent was actually shown", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({
      status: "generated",
      creatives: [{ headline: "A", body: "B", claimsCheckedAgainst: [], groundedInPatternId: "made-up-id" }],
    })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0.02, new Set(["pattern-1"]));
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.creatives[0]!.groundedInPatternId).toBeUndefined();
    }
  });

  test("drops groundedInPatternId by default (no valid ids passed) — fails closed, never trusts an unvalidated claim", () => {
    const text = `${GEN_MARKER}\n${JSON.stringify({
      status: "generated",
      creatives: [{ headline: "A", body: "B", claimsCheckedAgainst: [], groundedInPatternId: "pattern-1" }],
    })}`;
    const result = parseCreativeGenerationResult(text, arm, "new-users", 0.02);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.creatives[0]!.groundedInPatternId).toBeUndefined();
    }
  });
});

describe("parseClaimCheckVerdict", () => {
  test("parses a truthful, issue-free verdict", () => {
    const creative = makeCreative();
    const text = `${CLAIM_MARKER}\n${JSON.stringify({ truthful: true, issues: [] })}`;
    const verdict = parseClaimCheckVerdict(text, creative);
    expect(verdict.truthful).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(verdict.fabricatesTestimonialIdentity).toBeUndefined();
  });

  test("parses issues on a false claim", () => {
    const creative = makeCreative();
    const text = `${CLAIM_MARKER}\n${JSON.stringify({ truthful: false, issues: ["claims offline support but no evidence of that feature"] })}`;
    const verdict = parseClaimCheckVerdict(text, creative);
    expect(verdict.truthful).toBe(false);
    expect(verdict.issues).toHaveLength(1);
  });

  test("fails closed to truthful: false when the marker is missing", () => {
    const verdict = parseClaimCheckVerdict("no marker", makeCreative());
    expect(verdict.truthful).toBe(false);
  });

  test("fails closed to truthful: false on malformed JSON", () => {
    const verdict = parseClaimCheckVerdict(`${CLAIM_MARKER}\nnot json`, makeCreative());
    expect(verdict.truthful).toBe(false);
  });

  test("fabricatesTestimonialIdentity is populated for a UGC-format creative", () => {
    const ugcCreative = makeCreative({ arm: makeArm({ assetType: "video", videoFormat: "ugc" }) });
    const text = `${CLAIM_MARKER}\n${JSON.stringify({ truthful: true, issues: [], fabricatesTestimonialIdentity: false })}`;
    const verdict = parseClaimCheckVerdict(text, ugcCreative);
    expect(verdict.fabricatesTestimonialIdentity).toBe(false);
  });

  test("fabricatesTestimonialIdentity catches a fabricated real-person testimonial", () => {
    const ugcCreative = makeCreative({ arm: makeArm({ assetType: "video", videoFormat: "ugc" }) });
    const text = `${CLAIM_MARKER}\n${JSON.stringify({
      truthful: false,
      issues: ["claims to be a real testimonial from a named person, \"Sarah from Ohio\", with no evidence this is a real customer"],
      fabricatesTestimonialIdentity: true,
    })}`;
    const verdict = parseClaimCheckVerdict(text, ugcCreative);
    expect(verdict.fabricatesTestimonialIdentity).toBe(true);
    expect(verdict.truthful).toBe(false);
  });

  test("fabricatesTestimonialIdentity stays undefined for a non-UGC creative even if the agent tried to set it", () => {
    const textCreative = makeCreative({ arm: makeArm({ assetType: "text" }) });
    const text = `${CLAIM_MARKER}\n${JSON.stringify({ truthful: true, issues: [], fabricatesTestimonialIdentity: true })}`;
    const verdict = parseClaimCheckVerdict(text, textCreative);
    expect(verdict.fabricatesTestimonialIdentity).toBeUndefined();
  });
});

describe("parseAuthenticityVerdict", () => {
  test("parses a genuine, non-generic verdict", () => {
    const text = `${AUTH_MARKER}\n${JSON.stringify({ readsAsGeneric: false, matchedPatterns: [], suggestion: "specific and grounded" })}`;
    const verdict = parseAuthenticityVerdict(text, makeCreative());
    expect(verdict.readsAsGeneric).toBe(false);
    expect(verdict.matchedPatterns).toEqual([]);
  });

  test("parses a flagged verdict with matched pattern ids", () => {
    const text = `${AUTH_MARKER}\n${JSON.stringify({
      readsAsGeneric: true,
      matchedPatterns: ["fast-paced-world-opener", "formulaic-urgency-cta"],
      suggestion: "cut the generic opener and closer, be specific about the actual feature",
    })}`;
    const verdict = parseAuthenticityVerdict(text, makeCreative());
    expect(verdict.readsAsGeneric).toBe(true);
    expect(verdict.matchedPatterns).toEqual(["fast-paced-world-opener", "formulaic-urgency-cta"]);
  });

  test("fails closed to readsAsGeneric: true when the marker is missing", () => {
    const verdict = parseAuthenticityVerdict("no marker", makeCreative());
    expect(verdict.readsAsGeneric).toBe(true);
  });

  test("fails closed to readsAsGeneric: true on malformed JSON", () => {
    const verdict = parseAuthenticityVerdict(`${AUTH_MARKER}\nnot json`, makeCreative());
    expect(verdict.readsAsGeneric).toBe(true);
  });

  test("fails closed to readsAsGeneric: true on an invalid shape (missing suggestion)", () => {
    const text = `${AUTH_MARKER}\n${JSON.stringify({ readsAsGeneric: false, matchedPatterns: [] })}`;
    const verdict = parseAuthenticityVerdict(text, makeCreative());
    expect(verdict.readsAsGeneric).toBe(true);
  });
});
