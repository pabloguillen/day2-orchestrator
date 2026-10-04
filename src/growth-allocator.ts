import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { GrowthCapability } from "./growth-tools-config";
import type { GrowthChannel } from "./growth-strategy";
import type { BudgetConfig } from "./spend-governance";
import { computeStagedReward, type StagedRewardInputs, type StagedRewardWeights } from "./growth-reward";

/**
 * Step 4 (self-distributing), Component 3 — adaptive format/content
 * allocator (COORDINATION.md W41, docs/step4-self-distributing-plan.md).
 *
 * Directly answers the user's own requirement: "try different things,
 * reinforce what works, as fast as possible... within the guardrails."
 * This is the genuinely new primitive this project didn't have before Step
 * 4 — confirmed by direct search that no bandit/Thompson-sampling/UCB code
 * exists anywhere else in this codebase. `experiments.ts`'s
 * `evaluateExperiment`/`assignVariant` are fixed-split, evaluate-after-the-
 * fact tools for a different question ("is this difference statistically
 * real"), not an allocator, and are not reused here.
 *
 * Within a channel (Component 2's macro allocation decides *how much*
 * budget a channel gets), this module decides *which specific format*
 * — an `Arm` — gets tried next, and reinforces the ones that demonstrably
 * work. Pure math throughout; `selectArm`/`recordOutcome` never call an
 * LLM, matching `spend-governance.ts`'s own "pure core, agent-invoking
 * pieces are a different file" discipline.
 *
 * One disclosed deviation from the plan doc's literal design, necessary
 * because of build order, not because the plan was wrong: `Arm.channel` is
 * typed as `GrowthChannel` (growth-strategy.ts, Component 2, already
 * landed), not `SpendCategory` (spend-governance.ts, Component 1).
 * Confirmed by reading the real, merged `growth-strategy.ts`: `GrowthChannel`
 * includes `referral_loops`, a real, mechanically-free growth channel
 * Component 1 deliberately excludes from `SpendCategory` since there's no
 * dollar spend to govern there. The allocator needs to reinforce formats
 * across every real growth channel, including the free one —
 * `SpendCategory` alone can't express that.
 *
 * `buildCandidateArms` takes a plain `resolvedCapabilities: GrowthCapability[]`
 * rather than a full `GrowthToolsConfig` — originally a forced deviation
 * while Component 4 (`growth-tools-config.ts`, W40) was still in progress;
 * W40 landed on `main` while this component was being built (`e9fd33a`),
 * confirmed to define the exact same `GrowthCapability` union used here
 * (byte-for-byte, same members and order), so this now imports the real
 * type instead of keeping a hand-synced local copy — the dedupe this file
 * originally flagged as a future TODO, done immediately rather than left
 * for someone else, since the collision window closed inside this same
 * workstream. `resolvedCapabilities` itself is still a plain array, not
 * `GrowthToolsConfig` — computing it is `growth-execution.ts`'s job
 * (Component 6, not yet built): `ALL_CAPABILITIES.filter(c =>
 * resolveBindings(config, c, appId).length > 0)`.
 */

export type Arm = {
  channel: GrowthChannel;
  assetType: "text" | "image" | "video";
  /** Only meaningful when `assetType === "video"` — motion-graphics-style
   * (raylight/autoAE/hyperframes-illustrative) vs. UGC-style AI-presented
   * testimonial content (Arcads.ai-illustrative). */
  videoFormat?: "motion_graphics" | "ugc";
  /** Free-text specifics, e.g. "15s-vertical-product-demo". */
  formatTag: string;
};

/** `totalWeightedReward` — additive, optional (closed-loop M3,
 * docs/closed-loop-spec.md §7): accumulates a real, continuous, staged
 * reward (`growth-reward.ts`'s `computeStagedReward`) per arm, for the new
 * `recordWeightedOutcome`/`selectArmWeighted` pair below — concretely wired
 * via `recordStagedOutcome` further down this file, which is the one place
 * that actually calls `computeStagedReward` and folds its result into
 * `recordWeightedOutcome`; callers with staged lifecycle data should go
 * through it rather than hand-computing a fraction. Never written by
 * `recordOutcome`/read by `selectArm` — those two keep their exact,
 * already-shipped, already-tested integer-only behavior untouched. A state
 * file can accumulate stats via either pathway (or both, on different
 * arms) without conflict, since `successes` and `totalWeightedReward` are
 * independent fields updated by independent functions. */
export type ArmStats = { arm: Arm; attempts: number; successes: number; spendUsd: number; totalWeightedReward?: number };
/** `reconciledCreativeIds` — additive, optional extension for Component 6
 * (`growth-execution.ts`, COORDINATION.md W43): tracks which real,
 * `executed` `GrowthActionRecord`s have already had their real-world
 * outcome folded into this state via `reconcileOutcomes`, so a repeated
 * on-demand reconciliation run never double-counts the same action.
 * Backward-compatible — absent on any state file written before this
 * existed; every reader treats `undefined` the same as `[]`. */
export type AllocatorState = { arms: ArmStats[]; updatedAt: string; reconciledCreativeIds?: string[] };

/** An arm below this many attempts is "still exploring" for the purposes of
 * `applyExplorationCeiling` and `renderAllocatorSummary`'s honesty caveat —
 * a disclosed judgment call, not derived from anything. */
export const MIN_ARM_OBSERVATIONS = 5;

/** Exported for `growth-execution.ts` (Component 6): the `acquisition_landing`
 * event's `armKey` metadata field is this exact encoding, so a device's
 * real landing can be matched back to the `Arm` that produced its
 * creative. See `decodeArmKey` for the inverse. */
export function armKey(arm: Arm): string {
  return `${arm.channel}|${arm.assetType}|${arm.videoFormat ?? ""}|${arm.formatTag}`;
}

/** Inverse of `armKey`. Returns `undefined` on anything that doesn't
 * round-trip to a well-formed `Arm` — a malformed or foreign key (e.g. from
 * a future format this version doesn't know about) is skipped by callers,
 * never guessed at. */
export function decodeArmKey(key: string): Arm | undefined {
  const parts = key.split("|");
  if (parts.length !== 4) return undefined;
  const [channel, assetType, videoFormat, formatTag] = parts as [string, string, string, string];
  if (assetType !== "text" && assetType !== "image" && assetType !== "video") return undefined;
  if (videoFormat !== "" && videoFormat !== "motion_graphics" && videoFormat !== "ugc") return undefined;
  if (!channel || !formatTag) return undefined;
  return {
    channel: channel as GrowthChannel,
    assetType,
    ...(videoFormat ? { videoFormat } : {}),
    formatTag,
  };
}

function findStats(state: AllocatorState, arm: Arm): ArmStats | undefined {
  const key = armKey(arm);
  return state.arms.find((s) => armKey(s.arm) === key);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Gamma(k, 1) for integer k, sampled as the sum of k independent
 * Exponential(1) draws (equivalently, -ln of their product) — the standard
 * construction for integer shape parameters, and the only one needed here
 * since `sampleBeta`'s two shape parameters are always `successes + 1` and
 * `failures + 1`, both always positive integers. No stats library exists in
 * this codebase (dependencies are just the Claude Agent SDK and Playwright)
 * and none is needed for this restricted, always-integer case. */
function sampleGamma(shapeInteger: number, rng: () => number): number {
  let logProduct = 0;
  for (let i = 0; i < shapeInteger; i++) {
    const u = Math.max(rng(), Number.EPSILON); // guard against log(0) on a degenerate rng
    logProduct += Math.log(u);
  }
  return -logProduct;
}

/** Beta(successes + 1, failures + 1) via two independent Gammas — the
 * standard Beta-Bernoulli Thompson-sampling posterior. Untried arms
 * (successes = failures = 0) sample from Beta(1, 1), the uniform
 * distribution — maximally uncertain, so they're just as likely to win a
 * given draw as anything else until real evidence narrows it. */
function sampleBeta(successes: number, failures: number, rng: () => number): number {
  const x = sampleGamma(successes + 1, rng);
  const y = sampleGamma(failures + 1, rng);
  return x / (x + y);
}

/**
 * Thompson sampling: draws one Beta sample per candidate arm from its
 * current posterior and returns the arm with the highest draw. Pure given
 * an injected `rng` — never calls `Math.random()` directly, so this is
 * fully reproducible under test (and consistent with this project's own
 * "no ambient randomness" discipline elsewhere).
 *
 * No fixed minimum sample size gates reinforcement, unlike `experiments.ts`'s
 * `MIN_SAMPLE_SIZE_PER_ARM` t-test gate — that answers "is this difference
 * statistically publishable," a different question from "which way should
 * I lean right now, honestly weighted by how sure I am." Reinforcement here
 * starts from the very first outcome, per the user's own "as soon as
 * possible" requirement — it just naturally reinforces gently at first
 * (wide posteriors) and more decisively as evidence accumulates.
 */
export function selectArm(state: AllocatorState, candidateArms: Arm[], rng: () => number): Arm {
  if (candidateArms.length === 0) {
    throw new Error("selectArm: no candidate arms to choose from — check applyExplorationCeiling's result before calling this.");
  }
  let best = candidateArms[0]!;
  let bestSample = -Infinity;
  for (const arm of candidateArms) {
    const stats = findStats(state, arm);
    const successes = stats?.successes ?? 0;
    const failures = (stats?.attempts ?? 0) - successes;
    const sample = sampleBeta(successes, failures, rng);
    if (sample > bestSample) {
      bestSample = sample;
      best = arm;
    }
  }
  return best;
}

/** Pure. Updates the chosen arm's stats; a new arm not yet in `state.arms`
 * is added on its first outcome. `spendUsd` accumulates across every call
 * for that arm — used by `applyExplorationCeiling` below. */
export function recordOutcome(
  state: AllocatorState,
  arm: Arm,
  success: boolean,
  spendUsd: number,
): AllocatorState {
  const key = armKey(arm);
  const index = state.arms.findIndex((s) => armKey(s.arm) === key);
  const updatedAt = new Date().toISOString();

  if (index === -1) {
    return {
      arms: [...state.arms, { arm, attempts: 1, successes: success ? 1 : 0, spendUsd: round2(spendUsd) }],
      updatedAt,
    };
  }

  const existing = state.arms[index]!;
  const updated: ArmStats = {
    arm: existing.arm,
    attempts: existing.attempts + 1,
    successes: existing.successes + (success ? 1 : 0),
    spendUsd: round2(existing.spendUsd + spendUsd),
  };
  const arms = [...state.arms];
  arms[index] = updated;
  return { arms, updatedAt };
}

// ---------------------------------------------------------------------------
// Closed loop M3 (docs/closed-loop-spec.md §7) — a real, continuous, staged
// reward instead of a single boolean. Additive: everything below is new,
// nothing above this point is touched. `selectArm`/`recordOutcome` and
// their existing tests keep their exact behavior.
// ---------------------------------------------------------------------------

/** Standard normal variate via Box-Muller — used only by the continuous
 * Gamma sampler below. */
function sampleStandardNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Marsaglia-Tsang: a real Gamma(shape, 1) sampler for any `shape > 0` — not
 * a replacement for `sampleGamma` above, which is exact but restricted to
 * integer shape (a sum of Exponentials). Needed here because a staged
 * reward (spec §7) is a real number in [0, 1], not a hard 0/1: its
 * pseudo-counts are genuinely fractional, and rounding/rescaling them into
 * integers before sampling would silently fabricate far more statistical
 * confidence than the real evidence supports (a rescale-then-reuse-
 * sampleGamma shortcut was considered and rejected for exactly this
 * reason — scaling both Beta shape parameters by a constant k doesn't
 * preserve the distribution, it concentrates it as if there were k times
 * more real observations). Kept fully separate from `sampleGamma` so
 * `selectArm`/`recordOutcome`'s exact, already-shipped behavior is
 * provably unaffected by this addition.
 */
function sampleGammaContinuous(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Boosting trick: Gamma(a) = Gamma(a+1) * U^(1/a).
    const u = Math.max(rng(), Number.EPSILON);
    return sampleGammaContinuous(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let iter = 0; iter < 1000; iter++) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), Number.EPSILON);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  // Rejection sampling converges almost immediately in practice for any
  // real rng this project uses; this is an honest fail-safe, never
  // expected to trigger — returning the mode rather than looping forever.
  return d;
}

function sampleBetaContinuous(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGammaContinuous(alpha, rng);
  const y = sampleGammaContinuous(beta, rng);
  if (x + y === 0) return 0.5;
  return x / (x + y);
}

/**
 * Pure. Fractional Bayesian update for a real, continuous `rewardFraction`
 * in [0, 1] — the currently-matured value of `growth-reward.ts`'s staged
 * reward (spec §7.1). Standard "soft-label" Beta-Bernoulli update: a
 * reward of `r` contributes `r` to the pseudo-success count and `1 - r` to
 * the pseudo-failure count (recovering the exact integer case when
 * `r` is always 0 or 1). Never writes `successes` — that field stays
 * reserved for `recordOutcome`'s own binary callers; the two pathways
 * accumulate independently so an arm observed via both never double-counts.
 */
export function recordWeightedOutcome(
  state: AllocatorState,
  arm: Arm,
  rewardFraction: number,
  spendUsd: number,
): AllocatorState {
  if (rewardFraction < 0 || rewardFraction > 1 || Number.isNaN(rewardFraction)) {
    throw new Error(`recordWeightedOutcome: rewardFraction must be in [0,1], got ${rewardFraction}`);
  }
  const key = armKey(arm);
  const index = state.arms.findIndex((s) => armKey(s.arm) === key);
  const updatedAt = new Date().toISOString();

  if (index === -1) {
    return {
      arms: [
        ...state.arms,
        { arm, attempts: 1, successes: 0, spendUsd: round2(spendUsd), totalWeightedReward: rewardFraction },
      ],
      updatedAt,
      ...(state.reconciledCreativeIds ? { reconciledCreativeIds: state.reconciledCreativeIds } : {}),
    };
  }

  const existing = state.arms[index]!;
  const updated: ArmStats = {
    arm: existing.arm,
    attempts: existing.attempts + 1,
    successes: existing.successes,
    spendUsd: round2(existing.spendUsd + spendUsd),
    totalWeightedReward: (existing.totalWeightedReward ?? 0) + rewardFraction,
  };
  const arms = [...state.arms];
  arms[index] = updated;
  return { arms, updatedAt, ...(state.reconciledCreativeIds ? { reconciledCreativeIds: state.reconciledCreativeIds } : {}) };
}

/**
 * Pure. The real wiring this file's own `ArmStats.totalWeightedReward` doc
 * above refers to: computes the device's current staged reward via
 * `growth-reward.ts`'s `computeStagedReward`, then folds the result
 * straight into `recordWeightedOutcome`. This is the only place in the
 * codebase that turns raw `StagedRewardInputs` (activation/retention/
 * revenue-or-LTV) into the `[0,1]` fraction `recordWeightedOutcome` expects
 * — callers who have staged lifecycle data should call this instead of
 * hand-computing a fraction and calling `recordWeightedOutcome` directly,
 * so there's exactly one definition of "staged reward" feeding the bandit.
 *
 * `computeStagedReward.normalizedReward` is `null` only when
 * `maturedWeight` is `0` — shouldn't happen in practice (R0 always matures
 * from day 1), but handled honestly here too: folded in as `0`, the same
 * "no evidence yet" default `selectArmWeighted` already applies to an arm
 * with no weighted evidence at all, rather than throwing or guessing.
 */
export function recordStagedOutcome(
  state: AllocatorState,
  arm: Arm,
  inputs: StagedRewardInputs,
  spendUsd: number,
  weights?: StagedRewardWeights,
): AllocatorState {
  const staged = computeStagedReward(inputs, weights);
  return recordWeightedOutcome(state, arm, staged.normalizedReward ?? 0, spendUsd);
}

/**
 * Thompson sampling over the real, continuous `totalWeightedReward`
 * pseudo-counts via `sampleBetaContinuous` — "learns from value, not
 * clicks" (spec §7's own framing). An arm never touched by
 * `recordWeightedOutcome` (only by the binary `recordOutcome`, or not at
 * all) samples from `Beta(1, attempts + 1)` — treated as zero accumulated
 * reward, same honest "no weighted evidence yet" default `selectArm`
 * itself applies to untried arms via `successes ?? 0`.
 */
export function selectArmWeighted(state: AllocatorState, candidateArms: Arm[], rng: () => number): Arm {
  if (candidateArms.length === 0) {
    throw new Error("selectArmWeighted: no candidate arms to choose from — check applyExplorationCeiling's result before calling this.");
  }
  let best = candidateArms[0]!;
  let bestSample = -Infinity;
  for (const arm of candidateArms) {
    const stats = findStats(state, arm);
    const totalReward = stats?.totalWeightedReward ?? 0;
    const attempts = stats?.attempts ?? 0;
    const alpha = 1 + totalReward;
    const beta = 1 + Math.max(0, attempts - totalReward);
    const sample = sampleBetaContinuous(alpha, beta, rng);
    if (sample > bestSample) {
      bestSample = sample;
      best = arm;
    }
  }
  return best;
}

type FormatSpec = {
  formatTag: string;
  assetType: Arm["assetType"];
  videoFormat?: Arm["videoFormat"];
  /** Absent means "text — no external tool needed," matching this
   * codebase's own precedent (`evolution.ts`'s proposal generation, this
   * stage's own creative-generation design) that an agent can always draft
   * text with zero MCP dependency. Image/video formats each name the one
   * capability their *real* intended artifact requires — never proposed as
   * a candidate unless that capability actually resolves, so exploration
   * budget is never spent testing a degraded text-only stand-in for what
   * was supposed to be a real image or video. */
  requiredCapability?: GrowthCapability;
};

/** Disclosed judgment call, not derived from anything: a starter catalog of
 * plausible formats per real growth channel (Component 2's `GrowthChannel`).
 * Deliberately small — this is what the allocator explores from on day
 * one, not an exhaustive taxonomy; growing it is a content decision for
 * whoever owns Component 5, not something to over-build here. */
const FORMATS_BY_CHANNEL: Record<GrowthChannel, FormatSpec[]> = {
  aso: [{ formatTag: "store-listing-copy", assetType: "text" }],
  seo_content: [
    { formatTag: "long-form-article", assetType: "text" },
    { formatTag: "faq-page", assetType: "text" },
  ],
  referral_loops: [{ formatTag: "referral-invite-copy", assetType: "text" }],
  social_content: [
    { formatTag: "text-post", assetType: "text" },
    { formatTag: "static-image-post", assetType: "image", requiredCapability: "creative_generation" },
    {
      formatTag: "motion-graphics-short-video",
      assetType: "video",
      videoFormat: "motion_graphics",
      requiredCapability: "motion_video_generation",
    },
    {
      formatTag: "ugc-style-short-video",
      assetType: "video",
      videoFormat: "ugc",
      requiredCapability: "ugc_video_generation",
    },
  ],
  paid_ads: [
    { formatTag: "single-image-ad", assetType: "image", requiredCapability: "creative_generation" },
    {
      formatTag: "motion-graphics-video-ad",
      assetType: "video",
      videoFormat: "motion_graphics",
      requiredCapability: "motion_video_generation",
    },
    {
      formatTag: "ugc-testimonial-video-ad",
      assetType: "video",
      videoFormat: "ugc",
      requiredCapability: "ugc_video_generation",
    },
  ],
  direct_outreach: [{ formatTag: "personalized-email", assetType: "text" }],
  website: [{ formatTag: "landing-page-copy", assetType: "text" }],
};

/** Fail-closed, same discipline as every other capability check in this
 * stage: an arm is only proposed if its real, intended artifact can
 * actually be produced today. Text is always includable (no external tool
 * needed); image/video formats are excluded unless their required
 * capability is in `resolvedCapabilities`. */
export function buildCandidateArms(channel: GrowthChannel, resolvedCapabilities: GrowthCapability[]): Arm[] {
  const specs = FORMATS_BY_CHANNEL[channel] ?? [];
  return specs
    .filter((s) => !s.requiredCapability || resolvedCapabilities.includes(s.requiredCapability))
    .map((s) => ({
      channel,
      assetType: s.assetType,
      ...(s.videoFormat ? { videoFormat: s.videoFormat } : {}),
      formatTag: s.formatTag,
    }));
}

/** `BudgetConfig.perCategoryCapUsd` is keyed by Component 1's `SpendCategory`,
 * which doesn't include every `GrowthChannel` (`referral_loops` has no
 * entry, by design — see the file header). Reading it with a channel that
 * isn't a valid key simply yields `undefined` at runtime, same as a
 * category that's a valid key but was never explicitly capped; both fall
 * back to the whole monthly budget as the ceiling basis. */
function categoryCeilingBasis(channelBudget: BudgetConfig, channel: GrowthChannel): number {
  const perCategoryCapUsd = channelBudget.perCategoryCapUsd as Partial<Record<string, number>> | undefined;
  return perCategoryCapUsd?.[channel] ?? channelBudget.monthlyBudgetUsd;
}

/**
 * Enforces safety rail 7 at the allocator level — a *soft*, selection-time
 * pre-filter, not a replacement for `spend-governance.ts`'s own hard,
 * unconditional per-request ceiling (defense in depth: this module can be
 * bypassed by a bug and the real money is still capped there). This one's
 * job is different: stop the allocator from even proposing more
 * under-observed arms once this channel's under-observed-arm spend
 * (summed across `state`, using each arm's own tracked `spendUsd`) has
 * reached `explorationCapFraction` of the channel's ceiling — so
 * `selectArm` isn't left repeatedly picking arms that would just get
 * denied at spend time anyway. Once an arm clears `MIN_ARM_OBSERVATIONS`,
 * it's no longer "exploration" and this filter never excludes it.
 */
export function applyExplorationCeiling(
  candidateArms: Arm[],
  state: AllocatorState,
  channelBudget: BudgetConfig,
): Arm[] {
  if (candidateArms.length === 0) return [];
  const channel = candidateArms[0]!.channel;
  const explorationFraction = channelBudget.explorationCapFraction ?? 0.3;
  const explorationCapUsd = categoryCeilingBasis(channelBudget, channel) * explorationFraction;

  const underObservedSpend = round2(
    state.arms
      .filter((s) => s.arm.channel === channel && s.attempts < MIN_ARM_OBSERVATIONS)
      .reduce((acc, s) => acc + s.spendUsd, 0),
  );

  if (underObservedSpend < explorationCapUsd) {
    return candidateArms;
  }

  return candidateArms.filter((arm) => (findStats(state, arm)?.attempts ?? 0) >= MIN_ARM_OBSERVATIONS);
}

function isValidAllocatorState(value: unknown): value is AllocatorState {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return Array.isArray(o.arms) && typeof o.updatedAt === "string";
}

export function loadAllocatorState(path: string): AllocatorState {
  if (!existsSync(path)) return { arms: [], updatedAt: new Date().toISOString() };
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but isn't valid JSON — fix or remove it by hand before using this tool.`);
  }
  if (!isValidAllocatorState(parsed)) {
    throw new Error(`${path} exists but doesn't look like a valid allocator state — refusing to guess or overwrite it.`);
  }
  return parsed;
}

export function saveAllocatorState(path: string, state: AllocatorState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Plain-language, no jargon — feeds directly into `growth-feed.ts`'s
 * transparency surface (Component 6, not yet built). States sample sizes
 * plainly alongside win rates, same honesty discipline as
 * `spend-governance.ts`'s `renderBudgetSummary` and `experiments.ts`'s own
 * sample-size framing — never implies confidence a handful of outcomes
 * can't support. */
export function renderAllocatorSummary(state: AllocatorState): string {
  if (state.arms.length === 0) return "No formats have been tried yet.";
  const sorted = [...state.arms].sort((a, b) => b.attempts - a.attempts);
  const lines = sorted.map((s) => {
    const winRate = s.attempts > 0 ? Math.round((s.successes / s.attempts) * 100) : 0;
    const label = `${s.arm.channel} / ${s.arm.assetType}${s.arm.videoFormat ? ` (${s.arm.videoFormat})` : ""} / ${s.arm.formatTag}`;
    const caveat = s.attempts < MIN_ARM_OBSERVATIONS ? " — still exploring, too early to call" : "";
    return `  - ${label}: ${s.successes}/${s.attempts} succeeded (${winRate}%), $${s.spendUsd.toFixed(2)} spent${caveat}`;
  });
  return `Format performance (${state.arms.length} tried):\n${lines.join("\n")}`;
}
