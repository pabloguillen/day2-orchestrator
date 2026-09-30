import { describe, expect, test } from "bun:test";
import {
  recordWeightedOutcome,
  selectArmWeighted,
  type AllocatorState,
  type Arm,
} from "./growth-allocator";

// Deterministic PRNG (mulberry32) — real, seeded, reproducible across runs,
// same "no ambient randomness, inject rng" discipline this project already
// applies to selectArm's own seeded-convergence test.
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

const armA: Arm = { channel: "social_content", assetType: "video", videoFormat: "ugc", formatTag: "angle-a" };
const armB: Arm = { channel: "social_content", assetType: "video", videoFormat: "ugc", formatTag: "angle-b" };

const emptyState: AllocatorState = { arms: [], updatedAt: new Date(0).toISOString() };

describe("recordWeightedOutcome", () => {
  test("adds a new arm with the real reward fraction as totalWeightedReward, successes left at 0", () => {
    const next = recordWeightedOutcome(emptyState, armA, 0.7, 10);
    expect(next.arms[0]).toMatchObject({ attempts: 1, successes: 0, totalWeightedReward: 0.7, spendUsd: 10 });
  });

  test("accumulates real fractional rewards across repeated calls for the same arm", () => {
    let state = recordWeightedOutcome(emptyState, armA, 0.5, 5);
    state = recordWeightedOutcome(state, armA, 0.3, 5);
    expect(state.arms[0]!.totalWeightedReward).toBeCloseTo(0.8, 10);
    expect(state.arms[0]!.attempts).toBe(2);
    expect(state.arms[0]!.spendUsd).toBe(10);
  });

  test("rejects an out-of-[0,1] reward rather than silently accepting a malformed value", () => {
    expect(() => recordWeightedOutcome(emptyState, armA, 1.5, 10)).toThrow();
    expect(() => recordWeightedOutcome(emptyState, armA, -0.1, 10)).toThrow();
    expect(() => recordWeightedOutcome(emptyState, armA, NaN, 10)).toThrow();
  });

  test("never writes `successes` — the binary and weighted pathways stay independent", () => {
    const next = recordWeightedOutcome(emptyState, armA, 1.0, 10);
    expect(next.arms[0]!.successes).toBe(0);
  });

  test("does not mutate the input state (pure)", () => {
    const before = JSON.stringify(emptyState);
    recordWeightedOutcome(emptyState, armA, 0.5, 10);
    expect(JSON.stringify(emptyState)).toBe(before);
  });

  test("preserves reconciledCreativeIds if already present on the state", () => {
    const stateWithReconciled: AllocatorState = { ...emptyState, reconciledCreativeIds: ["c1"] };
    const next = recordWeightedOutcome(stateWithReconciled, armA, 0.5, 10);
    expect(next.reconciledCreativeIds).toEqual(["c1"]);
  });
});

describe("selectArmWeighted — real statistical behavior, not just plumbing", () => {
  test("reinforces the arm with genuinely higher average reward over many rounds", () => {
    const rng = mulberry32(42);
    let state = emptyState;
    let armAPicks = 0;
    let armBPicks = 0;
    const rewardRng = mulberry32(7);

    for (let round = 0; round < 300; round++) {
      const picked = selectArmWeighted(state, [armA, armB], rng);
      if (picked === armA) armAPicks++;
      else armBPicks++;
      // armA genuinely earns ~0.7 average reward, armB genuinely ~0.3 —
      // real, injected randomness around each arm's true mean.
      const trueMean = picked === armA ? 0.7 : 0.3;
      const noise = (rewardRng() - 0.5) * 0.2;
      const reward = Math.min(1, Math.max(0, trueMean + noise));
      state = recordWeightedOutcome(state, picked, reward, 1);
    }

    expect(armAPicks).toBeGreaterThan(armBPicks);
    // Exploration never fully collapses to zero for the worse arm.
    expect(armBPicks).toBeGreaterThan(0);
  });

  test("an untried arm (no weighted evidence yet) is still selectable — wide, uninformative prior", () => {
    const rng = mulberry32(1);
    const stateWithOnlyA: AllocatorState = {
      arms: [{ arm: armA, attempts: 20, successes: 0, spendUsd: 20, totalWeightedReward: 18 }], // armA proven strong
      updatedAt: new Date(0).toISOString(),
    };
    let armBPickedAtLeastOnce = false;
    for (let i = 0; i < 200; i++) {
      if (selectArmWeighted(stateWithOnlyA, [armA, armB], rng) === armB) {
        armBPickedAtLeastOnce = true;
        break;
      }
    }
    expect(armBPickedAtLeastOnce).toBe(true);
  });

  test("is a pure function of its inputs — same state/candidates/rng sequence gives the same pick", () => {
    const rng1 = mulberry32(99);
    const rng2 = mulberry32(99);
    const state: AllocatorState = {
      arms: [{ arm: armA, attempts: 5, successes: 0, spendUsd: 5, totalWeightedReward: 2.5 }],
      updatedAt: new Date(0).toISOString(),
    };
    expect(selectArmWeighted(state, [armA, armB], rng1)).toBe(selectArmWeighted(state, [armA, armB], rng2));
  });

  test("throws on an empty candidate list rather than guessing", () => {
    expect(() => selectArmWeighted(emptyState, [], mulberry32(1))).toThrow();
  });
});

describe("sampleBetaContinuous — real distributional sanity check (via selectArmWeighted's internals)", () => {
  test("a Beta(1,1)-equivalent prior (no evidence) picks each of two identical arms roughly equally often", () => {
    const rng = mulberry32(123);
    let aCount = 0;
    let bCount = 0;
    for (let i = 0; i < 2000; i++) {
      if (selectArmWeighted(emptyState, [armA, armB], rng) === armA) aCount++;
      else bCount++;
    }
    // With zero evidence for either arm, the split should be roughly 50/50
    // — a generous tolerance (real sampling noise, not an exact-half
    // assertion) since this is a statistical property, not a deterministic one.
    const fraction = aCount / (aCount + bCount);
    expect(fraction).toBeGreaterThan(0.4);
    expect(fraction).toBeLessThan(0.6);
  });
});
