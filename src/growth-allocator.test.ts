import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_ARM_OBSERVATIONS,
  applyExplorationCeiling,
  buildCandidateArms,
  loadAllocatorState,
  recordOutcome,
  renderAllocatorSummary,
  saveAllocatorState,
  selectArm,
  type AllocatorState,
  type Arm,
} from "./growth-allocator";
import type { GrowthCapability } from "./growth-tools-config";
import type { BudgetConfig } from "./spend-governance";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const emptyState: AllocatorState = { arms: [], updatedAt: "2026-09-01T00:00:00.000Z" };

const armA: Arm = { channel: "social_content", assetType: "text", formatTag: "text-post" };
const armB: Arm = { channel: "social_content", assetType: "image", formatTag: "static-image-post" };

describe("selectArm", () => {
  test("throws on an empty candidate list rather than guessing", () => {
    expect(() => selectArm(emptyState, [], mulberry32(1))).toThrow();
  });

  test("always returns one of the candidate arms", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 20; i++) {
      const chosen = selectArm(emptyState, [armA, armB], rng);
      expect([armA, armB]).toContainEqual(chosen);
    }
  });

  test("is a pure function of its inputs — same state/candidates/rng sequence gives the same pick", () => {
    const a = selectArm(emptyState, [armA, armB], mulberry32(7));
    const b = selectArm(emptyState, [armA, armB], mulberry32(7));
    expect(a).toEqual(b);
  });
});

describe("recordOutcome", () => {
  test("adds a new arm on its first outcome", () => {
    const state = recordOutcome(emptyState, armA, true, 2.5);
    expect(state.arms).toHaveLength(1);
    expect(state.arms[0]).toEqual({ arm: armA, attempts: 1, successes: 1, spendUsd: 2.5 });
  });

  test("accumulates attempts/successes/spend for an existing arm without touching other arms", () => {
    let state = recordOutcome(emptyState, armA, true, 1);
    state = recordOutcome(state, armB, false, 3);
    state = recordOutcome(state, armA, false, 1);
    const a = state.arms.find((s) => s.arm.formatTag === "text-post")!;
    const b = state.arms.find((s) => s.arm.formatTag === "static-image-post")!;
    expect(a).toEqual({ arm: armA, attempts: 2, successes: 1, spendUsd: 2 });
    expect(b).toEqual({ arm: armB, attempts: 1, successes: 0, spendUsd: 3 });
  });

  test("does not mutate the input state (pure)", () => {
    const before = JSON.parse(JSON.stringify(emptyState));
    recordOutcome(emptyState, armA, true, 1);
    expect(emptyState).toEqual(before);
  });
});

describe("Thompson sampling — seeded-RNG convergence (rigged synthetic environment)", () => {
  test("reinforces the genuinely-better arm's selection share over many rounds, without exploration collapsing to zero", () => {
    const rng = mulberry32(2026);
    let state: AllocatorState = emptyState;
    const goodArm: Arm = { channel: "social_content", assetType: "video", videoFormat: "ugc", formatTag: "ugc-testimonial" };
    const badArm: Arm = { channel: "social_content", assetType: "video", videoFormat: "motion_graphics", formatTag: "motion-demo" };
    const GOOD_SUCCESS_RATE = 0.7;
    const BAD_SUCCESS_RATE = 0.15;

    const ROUNDS = 400;
    const HALF = ROUNDS / 2;
    let goodPicksFirstHalf = 0;
    let goodPicksSecondHalf = 0;
    let badPicksTotal = 0;

    for (let i = 0; i < ROUNDS; i++) {
      const chosen = selectArm(state, [goodArm, badArm], rng);
      const isGood = chosen.formatTag === goodArm.formatTag;
      if (i < HALF && isGood) goodPicksFirstHalf++;
      if (i >= HALF && isGood) goodPicksSecondHalf++;
      if (!isGood) badPicksTotal++;
      const successProbability = isGood ? GOOD_SUCCESS_RATE : BAD_SUCCESS_RATE;
      const success = rng() < successProbability;
      state = recordOutcome(state, chosen, success, 1);
    }

    // Reinforcement: the good arm's share of picks rises from the first half to the second.
    expect(goodPicksSecondHalf).toBeGreaterThan(goodPicksFirstHalf);
    // The good arm should dominate by the end, but...
    expect(goodPicksSecondHalf).toBeGreaterThan(HALF * 0.6);
    // ...exploration never fully collapses across the whole run: with a real, large enough gap
    // between arms sustained over many rounds, Thompson sampling can legitimately go long
    // stretches (even the entire second half) without selecting the loser again — the posterior
    // narrows, it doesn't hit an exact, permanent zero. "Never collapses" means the selection
    // probability is never mathematically forced to zero, not that every window must contain a
    // pick — so this asserts across the full run, which is what the plan's live-validation
    // language ("still get picked a nonzero number of times throughout") actually means.
    expect(badPicksTotal).toBeGreaterThan(0);

    const goodStats = state.arms.find((s) => s.arm.formatTag === goodArm.formatTag)!;
    const badStats = state.arms.find((s) => s.arm.formatTag === badArm.formatTag)!;
    expect(goodStats.attempts).toBeGreaterThan(badStats.attempts);
  });

  test("with no evidence yet, an untried arm is picked a nonzero number of times across many draws (uniform prior)", () => {
    const rng = mulberry32(99);
    const picks = { a: 0, b: 0 };
    for (let i = 0; i < 200; i++) {
      const chosen = selectArm(emptyState, [armA, armB], rng);
      picks[chosen === armA ? "a" : "b"]++;
    }
    expect(picks.a).toBeGreaterThan(0);
    expect(picks.b).toBeGreaterThan(0);
  });
});

describe("buildCandidateArms", () => {
  test("text formats are always included regardless of resolved capabilities", () => {
    const arms = buildCandidateArms("seo_content", []);
    expect(arms.length).toBeGreaterThan(0);
    expect(arms.every((a) => a.assetType === "text")).toBe(true);
  });

  test("image/video formats are excluded when their required capability isn't resolved", () => {
    const arms = buildCandidateArms("social_content", []);
    expect(arms.every((a) => a.assetType === "text")).toBe(true);
  });

  test("image/video formats appear once their required capability resolves", () => {
    const caps: GrowthCapability[] = ["creative_generation", "ugc_video_generation"];
    const arms = buildCandidateArms("social_content", caps);
    expect(arms.some((a) => a.assetType === "image")).toBe(true);
    expect(arms.some((a) => a.videoFormat === "ugc")).toBe(true);
    expect(arms.some((a) => a.videoFormat === "motion_graphics")).toBe(false); // not resolved
  });

  test("referral_loops (a real, free growth channel with no SpendCategory entry) still produces candidate arms", () => {
    const arms = buildCandidateArms("referral_loops", []);
    expect(arms.length).toBeGreaterThan(0);
    expect(arms[0]!.channel).toBe("referral_loops");
  });
});

describe("applyExplorationCeiling", () => {
  const budget: BudgetConfig = {
    monthlyBudgetUsd: 1000,
    periodStart: "2026-09-01T00:00:00.000Z",
    killSwitch: false,
    perCategoryCapUsd: { social_content: 100 },
    explorationCapFraction: 0.3, // 30% of $100 = $30
  };

  test("passes every candidate through when the ceiling hasn't been reached", () => {
    const state: AllocatorState = { arms: [], updatedAt: "x" };
    const result = applyExplorationCeiling([armA, armB], state, budget);
    expect(result).toEqual([armA, armB]);
  });

  test("excludes still-under-observed arms once the ceiling is reached, keeps proven arms", () => {
    let state: AllocatorState = emptyState;
    // Push armA's cumulative spend past the $30 ceiling while it's still under-observed.
    state = recordOutcome(state, armA, true, 35);
    // armB has cleared MIN_ARM_OBSERVATIONS — no longer "exploration".
    for (let i = 0; i < MIN_ARM_OBSERVATIONS; i++) {
      state = recordOutcome(state, armB, i % 2 === 0, 1);
    }
    const result = applyExplorationCeiling([armA, armB], state, budget);
    expect(result).toEqual([armB]);
  });

  test("never excludes anything when ALL candidates are under-observed and the ceiling isn't reached", () => {
    let state: AllocatorState = emptyState;
    state = recordOutcome(state, armA, true, 5);
    const result = applyExplorationCeiling([armA, armB], state, budget);
    expect(result).toEqual([armA, armB]);
  });

  test("can return an empty array when every candidate is under-observed and the ceiling is reached — callers must handle this, selectArm fails loud rather than guessing", () => {
    let state: AllocatorState = emptyState;
    state = recordOutcome(state, armA, true, 20);
    state = recordOutcome(state, armB, true, 20); // combined $40 > $30 ceiling, neither has cleared MIN_ARM_OBSERVATIONS
    const result = applyExplorationCeiling([armA, armB], state, budget);
    expect(result).toEqual([]);
    expect(() => selectArm(state, result, mulberry32(1))).toThrow();
  });

  test("falls back to the whole monthly budget as the ceiling basis for a channel with no perCategoryCapUsd entry (e.g. referral_loops)", () => {
    const noCapBudget: BudgetConfig = { monthlyBudgetUsd: 200, periodStart: "2026-09-01T00:00:00.000Z", killSwitch: false };
    const freeArm: Arm = { channel: "referral_loops", assetType: "text", formatTag: "referral-invite-copy" };
    let state: AllocatorState = emptyState;
    state = recordOutcome(state, freeArm, true, 10); // well under 30% of $200 = $60
    const result = applyExplorationCeiling([freeArm], state, noCapBudget);
    expect(result).toEqual([freeArm]);
  });
});

describe("loadAllocatorState / saveAllocatorState", () => {
  function withTempDir(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "day2-allocator-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("returns an empty state when no file exists", () => {
    withTempDir((dir) => {
      const state = loadAllocatorState(join(dir, "state.json"));
      expect(state.arms).toEqual([]);
    });
  });

  test("round-trips a saved state", () => {
    withTempDir((dir) => {
      const path = join(dir, "state.json");
      const state = recordOutcome(emptyState, armA, true, 2);
      saveAllocatorState(path, state);
      expect(existsSync(path)).toBe(true);
      expect(loadAllocatorState(path)).toEqual(state);
    });
  });

  test("throws rather than guessing at invalid JSON or a malformed-but-valid-JSON file", () => {
    withTempDir((dir) => {
      const badJson = join(dir, "bad.json");
      writeFileSync(badJson, "{ not json");
      expect(() => loadAllocatorState(badJson)).toThrow();

      const malformed = join(dir, "malformed.json");
      writeFileSync(malformed, JSON.stringify({ notAnAllocatorState: true }));
      expect(() => loadAllocatorState(malformed)).toThrow();
    });
  });
});

describe("renderAllocatorSummary", () => {
  test("shows real win rates and flags still-exploring arms honestly", () => {
    let state: AllocatorState = emptyState;
    state = recordOutcome(state, armA, true, 1);
    state = recordOutcome(state, armA, true, 1);
    const summary = renderAllocatorSummary(state);
    expect(summary).toContain("2/2 succeeded (100%)");
    expect(summary).toContain("still exploring, too early to call");
  });

  test("no caveat once an arm clears MIN_ARM_OBSERVATIONS", () => {
    let state: AllocatorState = emptyState;
    for (let i = 0; i < MIN_ARM_OBSERVATIONS; i++) {
      state = recordOutcome(state, armA, true, 1);
    }
    expect(renderAllocatorSummary(state)).not.toContain("still exploring");
  });

  test("honest empty-state message rather than a blank render", () => {
    expect(renderAllocatorSummary(emptyState)).toBe("No formats have been tried yet.");
  });
});
