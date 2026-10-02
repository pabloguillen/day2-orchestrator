/**
 * docs/closed-loop-spec.md M3's own "Done when" bar, taken literally:
 * "allocator shifts budget toward the arm with the best value per euro,
 * not the most installs." Real scenario: Arm "volume" gets MORE
 * attempts/clicks (more raw installs) but a LOW staged reward per device;
 * Arm "value" gets fewer attempts but a HIGH staged reward per device.
 * Confirms selectArmWeighted converges toward "value", proving the
 * allocator is reinforcing real value, not raw volume.
 */

import { describe, expect, test } from "bun:test";
import { recordWeightedOutcome, selectArmWeighted, type AllocatorState, type Arm } from "./growth-allocator";
import { computeStagedReward } from "./growth-reward";

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

const volumeArm: Arm = { channel: "social_content", assetType: "video", videoFormat: "ugc", formatTag: "high-volume-low-value" };
const valueArm: Arm = { channel: "social_content", assetType: "video", videoFormat: "ugc", formatTag: "low-volume-high-value" };

describe("M3 integration — allocator reinforces value per euro, not install volume", () => {
  test("an arm with MORE raw attempts but a LOW real staged reward loses out to an arm with FEWER attempts but real value", () => {
    const rng = mulberry32(2026);
    let state: AllocatorState = { arms: [], updatedAt: new Date(0).toISOString() };

    // Seed real history matching the scenario: volumeArm has been shown to
    // 3x as many devices (more installs) but each one barely activates and
    // almost never retains or pays back — a classic "cheap clicks, no real
    // value" creative. valueArm reaches fewer devices but each one is a
    // real, staged win: activates, retains, and pays back its own CAC.
    for (let i = 0; i < 60; i++) {
      const staged = computeStagedReward({
        activated: i % 3 !== 0, // ~67% activate
        d7Retained: false, // never really retains
        d30Retained: false,
        revenueOrLtvUsd: 0,
        cacUsd: 10,
      });
      state = recordWeightedOutcome(state, volumeArm, staged.normalizedReward!, 1);
    }
    for (let i = 0; i < 20; i++) {
      const staged = computeStagedReward({
        activated: true,
        d7Retained: true,
        d30Retained: true,
        revenueOrLtvUsd: 15, // clears its own $10 CAC
        cacUsd: 10,
      });
      state = recordWeightedOutcome(state, valueArm, staged.normalizedReward!, 1);
    }

    // Both arms have real evidence now; valueArm's per-attempt reward is
    // genuinely higher even though volumeArm has 3x the raw attempts.
    const volumeStats = state.arms.find((s) => s.arm.formatTag === "high-volume-low-value")!;
    const valueStats = state.arms.find((s) => s.arm.formatTag === "low-volume-high-value")!;
    expect(volumeStats.attempts).toBeGreaterThan(valueStats.attempts); // volume really does have more raw installs
    expect(valueStats.totalWeightedReward! / valueStats.attempts).toBeGreaterThan(
      volumeStats.totalWeightedReward! / volumeStats.attempts,
    ); // but a much lower per-device value

    // Thompson sampling should now lean toward the higher-VALUE arm despite
    // its lower raw volume.
    let valuePicks = 0;
    let volumePicks = 0;
    for (let round = 0; round < 500; round++) {
      const picked = selectArmWeighted(state, [volumeArm, valueArm], rng);
      if (picked === valueArm) valuePicks++;
      else volumePicks++;
    }
    expect(valuePicks).toBeGreaterThan(volumePicks);
  });
});
