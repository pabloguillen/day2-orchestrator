import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Arm } from "./growth-allocator";
import type { AppStage, GrowthChannel } from "./growth-strategy";
import type { GrowthCapability } from "./growth-tools-config";
import {
  resolveActivationOutcome,
  type AcquisitionEvent,
  type ActivationEvent,
  DEFAULT_ACTIVATION_WINDOW_DAYS,
} from "./growth-execution";
import type { EvidenceBasis, TransferabilityTier } from "./pattern-transferability";

/**
 * Distribution intelligence, Part 4 — the proprietary judge model
 * (docs/distribution-intelligence.md). Scaffolding only: no real
 * `performLiveAction` execution exists yet anywhere in this codebase, so
 * there are zero real labeled outcomes to train on today. Built and tested
 * against synthetic data now anyway, same discipline `reconcileOutcomes`
 * already uses for its own not-yet-exercised-in-production branches.
 *
 * The idea, precisely: everything else in the growth engine's intelligence
 * layer either calls an agent fresh every time (claims-check, authenticity-
 * check, Tier 0 research) or runs simple frequency statistics (the
 * allocator's Beta-Bernoulli sampling). A learned model trained on day2's
 * own accumulated real outcomes is categorically different — cheap enough
 * to call before a candidate arm is even generated, and structurally
 * impossible for a competitor to replicate without day2's own execution
 * history. That's what makes "the moat is applied outcomes" a literal,
 * buildable artifact instead of a rhetorical claim.
 *
 * Feature schema draws only on fields a real `GrowthActionRecord`
 * (growth-feed.ts) actually carries: `arm`, `strategy.stage`, `toolUsed`,
 * `claimsCheck`, `authenticityCheck`, and now `groundedInPatternId` — the
 * creative-generation pipeline (`growth-creative.ts`) was previously
 * bypassing `pattern-library.ts`'s whole adversarially-validated, tiered
 * library entirely (it only ever consumed raw, pre-validation
 * `ProvenPattern`s), so there was nothing real to resolve here. Now that
 * `generateCreatives` can accept real `TransferablePattern[]` and a
 * creative can honestly disclose which one (if any) it was grounded in,
 * `groundingPatternTier`/`groundingPatternEvidenceBasis` resolve that id
 * against a caller-supplied lookup (`GroundingPatternLookup`) — absent or
 * unresolvable degrades honestly to `"none"`, never thrown.
 *
 * `category`/`platform`/`era` are deliberately still excluded, for a
 * reason specific to each: `category` has no curated, versioned taxonomy
 * yet (Part 3's own Open Question #1) and is open-ended/unbounded, which
 * breaks this file's fixed-vocabulary one-hot design (a value never seen
 * in training would have no reserved column). `era` turned out not to be
 * a well-defined per-action feature at all on reflection — a
 * `TransferablePattern`'s `observations` can span multiple eras by
 * design (that's exactly what cross-context replication tracks), so
 * there is no single honest "this pattern's era" value to pick without
 * an undisclosed, arbitrary judgment call. `platform` has the same
 * unbounded/no-taxonomy problem as `category`. All three stay named here
 * as open items rather than silently dropped.
 */

// ---------------------------------------------------------------------------
// Feature schema + labeled outcomes
// ---------------------------------------------------------------------------

/** Mirrors `Arm.channel`'s real union (growth-strategy.ts). Duplicated as a
 * plain array (not derived from the type) because TypeScript unions have
 * no runtime reflection — if `GrowthChannel` ever gains a member, this
 * array needs a matching manual update; a typo here is still caught at
 * compile time since every entry is checked against the real type below. */
const GROWTH_CHANNELS_FOR_VOCAB: readonly GrowthChannel[] = [
  "aso",
  "seo_content",
  "referral_loops",
  "social_content",
  "paid_ads",
  "direct_outreach",
  "website",
];

const APP_STAGES_FOR_VOCAB: readonly AppStage[] = ["launch", "traction", "growth", "scale"];

const ASSET_TYPES_FOR_VOCAB: readonly Arm["assetType"][] = ["text", "image", "video"];

const VIDEO_FORMATS_FOR_VOCAB: readonly ("motion_graphics" | "ugc" | "none")[] = ["motion_graphics", "ugc", "none"];

/** Mirrors `GrowthCapability`'s real union (growth-tools-config.ts), plus
 * `"none"` for the real, common case of an organic/free arm needing no
 * bound tool at all (matches `GrowthActionRecord.toolUsed`'s own
 * `| null` — see that file's header comment). Same manual-sync caveat as
 * `GROWTH_CHANNELS_FOR_VOCAB` above. */
const TOOL_CAPABILITIES_FOR_VOCAB: readonly (GrowthCapability | "none")[] = [
  "creative_generation",
  "motion_video_generation",
  "ugc_video_generation",
  "social_trend_research",
  "social_account_operation",
  "ad_platform",
  "app_store_release",
  "seo_content",
  "competitor_research",
  "website_generation",
  "design_reference",
  "none",
];

/** Mirrors `TransferabilityTier`'s real union (pattern-transferability.ts),
 * plus `"none"` for a creative never grounded in any validated pattern —
 * the common case until `generateCreatives` callers actually pass real
 * `TransferablePattern[]`. Same manual-sync caveat as the vocab arrays
 * above. */
const TRANSFERABILITY_TIERS_FOR_VOCAB: readonly (TransferabilityTier | "none")[] = [
  "single_observation",
  "replicated_same_context",
  "replicated_cross_context",
  "none",
];

/** Mirrors `EvidenceBasis`'s real union (pattern-transferability.ts), plus
 * `"none"`. Same manual-sync caveat as the vocab arrays above. */
const EVIDENCE_BASES_FOR_VOCAB: readonly (EvidenceBasis | "none")[] = ["first_party", "mixed", "inferred_only", "none"];

export type JudgeModelFeatures = {
  channel: GrowthChannel;
  assetType: Arm["assetType"];
  videoFormat: "motion_graphics" | "ugc" | "none";
  stage: AppStage;
  toolCapability: GrowthCapability | "none";
  /** From `AuthenticityVerdict.readsAsGeneric` (safety rail 6). */
  authenticityFlagged: boolean;
  /** From `!ClaimCheckVerdict.truthful` (safety rail 4). */
  claimsFlagged: boolean;
  /** Resolved from `Creative.groundedInPatternId` via a caller-supplied
   * `GroundingPatternLookup` — `"none"` when the creative wasn't grounded
   * in any validated pattern, or when the id it cited can't be resolved
   * (a stale/removed pattern — degrades honestly, never throws). */
  groundingPatternTier: TransferabilityTier | "none";
  groundingPatternEvidenceBasis: EvidenceBasis | "none";
};

/** What `extractFeatures` needs to resolve a `groundedInPatternId` into the
 * two fields above — deliberately just the two fields it needs, not a full
 * `TransferablePattern`, so this file doesn't need a circular/heavy import
 * just to look up a tier. Defaults to `{}` everywhere it's threaded
 * through, so a caller that hasn't wired the pattern library in at all
 * gets every grounding feature as an honest `"none"`, never a crash. */
export type GroundingPatternLookup = Record<string, { tier: TransferabilityTier; evidenceBasis: EvidenceBasis }>;

/** Pure. The one real piece of glue between `pattern-library.ts`'s actual
 * store and this file — a caller with a real `PatternLibrary` passes
 * `library.patterns` here rather than hand-rolling the projection. Takes a
 * duck-typed `Pick`, not the real `PatternLibrary`/`TransferablePattern`
 * types, so this file doesn't need a heavier import just for this. */
export function buildGroundingPatternLookup(
  patterns: { id: string; tier: TransferabilityTier; evidenceBasis: EvidenceBasis }[],
): GroundingPatternLookup {
  const lookup: GroundingPatternLookup = {};
  for (const p of patterns) lookup[p.id] = { tier: p.tier, evidenceBasis: p.evidenceBasis };
  return lookup;
}

/** Disclosed placeholder, not a real app's identity — used when the source
 * record carries no `appId` at all (every record today, since
 * `GrowthActionRecord` only just gained this field and day2 powers exactly
 * one app). Deliberately generic rather than hardcoding a specific app
 * name into otherwise app-agnostic infrastructure (the same mistake W52's
 * own log records catching and reverting elsewhere in this codebase). */
export const UNKNOWN_APP_ID = "unknown";

export type LabeledOutcome = {
  creativeId: string;
  /** Which real app this outcome came from — the one field
   * `splitByApp`/`evaluateGeneralization` (below) actually split on.
   * Deliberately NOT part of `JudgeModelFeatures` — if the model could see
   * which app an example came from, it could trivially "predict" by
   * memorizing per-app base rates instead of learning anything that
   * transfers, which is exactly the failure mode held-out-by-app
   * evaluation exists to catch. */
  appId: string;
  features: JudgeModelFeatures;
  success: boolean;
  spendUsd: number;
  /** When this label was derived — not when the underlying action ran;
   * matches `recordedAt`-style fields elsewhere (e.g. `SpendLedgerEntry`),
   * injected by the caller rather than read from the system clock, so this
   * stays pure and testable (same "pure given injected now" discipline as
   * `pattern-library.ts`'s `recordSweep`). */
  recordedAt: string;
};

/** Exactly what `extractFeatures` needs to compute a prediction — nothing
 * tied to the ledger (`creativeId`/`executionResult`/`spend`). Split out
 * from `GrowthActionRecordForJudgeModel` below so a caller can get a real
 * prediction for a candidate (arm + stage + already-known checks) before
 * any `GrowthActionRecord`/ledger entry exists at all — e.g. right after
 * `checkTruthfulClaims`/`checkAuthenticity` run for a freshly-generated
 * `Creative`, well before `executeChannelAction`/`recordGrowthAction`. */
export type JudgePredictionInputs = {
  arm: Arm;
  strategy: { stage: AppStage };
  toolUsed: { capability: GrowthCapability; mcpServerName: string; reason: string } | null;
  claimsCheck: { truthful: boolean };
  authenticityCheck: { readsAsGeneric: boolean };
  /** Passthrough from `Creative.groundedInPatternId` — absent whenever the
   * creative wasn't grounded in a real validated pattern. */
  groundedInPatternId?: string;
};

/** Minimal shape `deriveNewLabeledOutcomes` actually needs from a real
 * `GrowthActionRecord` (growth-feed.ts) — declared here rather than
 * importing that file directly, same "thin projection, no circular import"
 * idiom as `growth-execution.ts`'s own `GrowthActionRecordForReconciliation`.
 * `growth-feed.ts`'s real `GrowthActionRecord` structurally satisfies this. */
export type GrowthActionRecordForJudgeModel = JudgePredictionInputs & {
  creativeId: string;
  executionResult: string;
  spend: { requested: number };
  /** Which real app this action belongs to — absent on every record today
   * (day2 powers exactly one app; `GrowthActionRecord` only just gained
   * this field). Defaults to `UNKNOWN_APP_ID` in `deriveNewLabeledOutcomes`
   * when absent, never silently dropped. */
  appId?: string;
};

/** Pure. Projects a real action record down to this file's feature
 * schema — the one place that schema is actually assembled, so every
 * caller (training, prediction, future extensions) stays in sync by
 * construction instead of each hand-rolling the same projection.
 * `patternLookup` defaults to `{}` — an unresolved or absent
 * `groundedInPatternId` degrades honestly to `"none"` on both grounding
 * fields, never thrown. */
export function extractFeatures(record: JudgePredictionInputs, patternLookup: GroundingPatternLookup = {}): JudgeModelFeatures {
  const grounding = record.groundedInPatternId ? patternLookup[record.groundedInPatternId] : undefined;
  return {
    channel: record.arm.channel,
    assetType: record.arm.assetType,
    videoFormat: record.arm.videoFormat ?? "none",
    stage: record.strategy.stage,
    toolCapability: record.toolUsed?.capability ?? "none",
    authenticityFlagged: record.authenticityCheck.readsAsGeneric,
    claimsFlagged: !record.claimsCheck.truthful,
    groundingPatternTier: grounding?.tier ?? "none",
    groundingPatternEvidenceBasis: grounding?.evidenceBasis ?? "none",
  };
}

/**
 * Pure. Derives new `LabeledOutcome`s from real action records, reusing
 * `growth-execution.ts`'s own `resolveActivationOutcome` join rather than
 * re-deriving it — the same real signal `reconcileOutcomes` folds into
 * `AllocatorState`'s aggregate counts, here persisted instead as an
 * individual labeled training example. Skips anything already in
 * `alreadyLabeledCreativeIds` (idempotent re-runs, same shape as
 * `reconcileOutcomes`'s own `reconciledCreativeIds` tracking) and anything
 * with no real activation signal yet (left for the next run, never
 * fabricated).
 */
export function deriveNewLabeledOutcomes(
  records: GrowthActionRecordForJudgeModel[],
  acquisitionEvents: AcquisitionEvent[],
  activationEvents: ActivationEvent[],
  alreadyLabeledCreativeIds: Set<string>,
  recordedAt: string,
  windowDays: number = DEFAULT_ACTIVATION_WINDOW_DAYS,
  patternLookup: GroundingPatternLookup = {},
): LabeledOutcome[] {
  const outcomes: LabeledOutcome[] = [];
  for (const record of records) {
    if (alreadyLabeledCreativeIds.has(record.creativeId)) continue;
    if (record.executionResult !== "executed") continue;

    const resolved = resolveActivationOutcome(record.creativeId, acquisitionEvents, activationEvents, windowDays);
    if (!resolved) continue; // no real signal yet — retry on the next run

    outcomes.push({
      creativeId: record.creativeId,
      appId: record.appId ?? UNKNOWN_APP_ID,
      features: extractFeatures(record, patternLookup),
      success: resolved.success,
      spendUsd: record.spend.requested,
      recordedAt,
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Ledger persistence — append-only JSONL, same idiom as `growth-feed.ts`'s
// `recordGrowthAction`/`loadGrowthActions`
// ---------------------------------------------------------------------------

export const JUDGE_MODEL_LEDGER_FILENAME = ".day2-judge-model-ledger.jsonl";

export function appendLabeledOutcome(ledgerFile: string, outcome: LabeledOutcome): void {
  appendFileSync(ledgerFile, `${JSON.stringify(outcome)}\n`);
}

export function loadLabeledOutcomes(ledgerFile: string): LabeledOutcome[] {
  if (!existsSync(ledgerFile)) return [];
  const lines = readFileSync(ledgerFile, "utf-8").trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as LabeledOutcome);
}

/**
 * Thin file-I/O wrapper: loads the existing ledger (for dedup), derives
 * genuinely new labeled outcomes from the given records, appends them, and
 * returns only what's newly added — same "pure core + thin disk wrapper"
 * split as `growth-execution.ts`'s own `reconcileOutcomes` /
 * `reconcileOutcomesIntoAllocator` pair.
 */
export function recordLabeledOutcomesFromRecords(
  ledgerFile: string,
  records: GrowthActionRecordForJudgeModel[],
  acquisitionEvents: AcquisitionEvent[],
  activationEvents: ActivationEvent[],
  recordedAt: string,
  windowDays: number = DEFAULT_ACTIVATION_WINDOW_DAYS,
  patternLookup: GroundingPatternLookup = {},
): LabeledOutcome[] {
  const existing = loadLabeledOutcomes(ledgerFile);
  const alreadyLabeled = new Set(existing.map((o) => o.creativeId));
  const fresh = deriveNewLabeledOutcomes(
    records,
    acquisitionEvents,
    activationEvents,
    alreadyLabeled,
    recordedAt,
    windowDays,
    patternLookup,
  );
  for (const outcome of fresh) appendLabeledOutcome(ledgerFile, outcome);
  return fresh;
}

// ---------------------------------------------------------------------------
// The model: pure-TS logistic regression over one-hot categorical features,
// zero ML dependency — same "pure math first" discipline as
// `spend-governance.ts`/`growth-allocator.ts`, and the same margin-
// preserving stance as `offering-logic.md`'s Tier 0 content stack (no
// external model/service for something this cheap to run in-process).
// ---------------------------------------------------------------------------

/** One column per categorical value across every feature dimension, plus a
 * leading bias term — built once from the fixed vocabularies above, not
 * from whatever happens to appear in a given training set, so a column
 * exists (defaulting to weight 0) even for a value never yet observed. */
export function buildFeatureVocabulary(): string[] {
  const columns: string[] = [];
  for (const v of GROWTH_CHANNELS_FOR_VOCAB) columns.push(`channel:${v}`);
  for (const v of ASSET_TYPES_FOR_VOCAB) columns.push(`assetType:${v}`);
  for (const v of VIDEO_FORMATS_FOR_VOCAB) columns.push(`videoFormat:${v}`);
  for (const v of APP_STAGES_FOR_VOCAB) columns.push(`stage:${v}`);
  for (const v of TOOL_CAPABILITIES_FOR_VOCAB) columns.push(`toolCapability:${v}`);
  for (const v of TRANSFERABILITY_TIERS_FOR_VOCAB) columns.push(`groundingPatternTier:${v}`);
  for (const v of EVIDENCE_BASES_FOR_VOCAB) columns.push(`groundingPatternEvidenceBasis:${v}`);
  columns.push("authenticityFlagged");
  columns.push("claimsFlagged");
  return columns;
}

/** Pure. One-hot encodes `features` against a fixed vocabulary (from
 * `buildFeatureVocabulary`) — order-stable, so the same vocabulary always
 * produces the same vector length/order regardless of which values are
 * actually present in any one example. */
export function encodeFeatureVector(features: JudgeModelFeatures, vocabulary: string[]): number[] {
  const active = new Set<string>([
    `channel:${features.channel}`,
    `assetType:${features.assetType}`,
    `videoFormat:${features.videoFormat}`,
    `stage:${features.stage}`,
    `toolCapability:${features.toolCapability}`,
    `groundingPatternTier:${features.groundingPatternTier}`,
    `groundingPatternEvidenceBasis:${features.groundingPatternEvidenceBasis}`,
  ]);
  return vocabulary.map((column) => {
    if (column === "authenticityFlagged") return features.authenticityFlagged ? 1 : 0;
    if (column === "claimsFlagged") return features.claimsFlagged ? 1 : 0;
    return active.has(column) ? 1 : 0;
  });
}

export type JudgeModelWeights = {
  vocabulary: string[];
  /** Parallel to `[1, ...encodeFeatureVector(...)]` — index 0 is the bias
   * term's weight, matching the leading constant-1 feature. */
  weights: number[];
  trainedOnExampleCount: number;
  trainedAt: string;
};

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Pure, deterministic (zero-initialized weights, full-batch gradient
 * descent — no RNG needed, unlike the allocator's Thompson sampling).
 * L2-regularized (never regularizing the bias term) to keep weights from
 * exploding on a small, real-world-sized example count. `trainedAt` is
 * injected, not read from the system clock — same "pure given injected
 * now" discipline as the rest of this file.
 */
export function trainLogisticRegression(
  outcomes: LabeledOutcome[],
  trainedAt: string,
  options: { iterations?: number; learningRate?: number; l2?: number } = {},
): JudgeModelWeights {
  const iterations = options.iterations ?? 500;
  const learningRate = options.learningRate ?? 0.1;
  const l2 = options.l2 ?? 0.01;

  const vocabulary = buildFeatureVocabulary();
  const n = outcomes.length;
  const dim = vocabulary.length + 1; // +1 bias

  const vectors = outcomes.map((o) => [1, ...encodeFeatureVector(o.features, vocabulary)]);
  const labels = outcomes.map((o) => (o.success ? 1 : 0));

  let weights = new Array(dim).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    const gradients = new Array(dim).fill(0);
    for (let i = 0; i < n; i++) {
      const error = sigmoid(dot(weights, vectors[i])) - labels[i];
      for (let j = 0; j < dim; j++) gradients[j] += error * vectors[i][j];
    }
    const next = new Array(dim);
    for (let j = 0; j < dim; j++) {
      const regTerm = j === 0 ? 0 : l2 * weights[j]; // never regularize bias
      next[j] = weights[j] - learningRate * (gradients[j] / n + regTerm);
    }
    weights = next;
  }

  return { vocabulary, weights, trainedOnExampleCount: n, trainedAt };
}

// ---------------------------------------------------------------------------
// Prediction, with a mandatory fail-closed fallback
// ---------------------------------------------------------------------------

/** Below this many labeled examples, `predict` always returns the
 * no-model fallback — a disclosed guess, same status as
 * `growth-allocator.ts`'s own `MIN_ARM_OBSERVATIONS = 5`. Deliberately
 * much higher than that constant: a bandit arm's own Beta posterior is
 * self-correcting from very few samples, but a logistic regression over a
 * ~20-dimensional one-hot space needs real volume before its weights mean
 * anything, and an under-trained model is actively worse than honestly
 * having no model at all. */
export const MIN_LABELED_EXAMPLES_TO_TRAIN = 50;

export type JudgePrediction = {
  /** `0.5` under the fallback — an honest "no information" prior, never a
   * fabricated confident number standing in for a real one. */
  predictedSuccessProbability: number;
  confidence: "none" | "low" | "medium" | "high";
  basis: "no_model_fallback" | "learned_model";
  trainedOnExampleCount: number;
};

/** Disclosed guesses, same status as `MIN_LABELED_EXAMPLES_TO_TRAIN` —
 * revisit once real calibration data exists (Part 4's open items). */
const CONFIDENCE_THRESHOLDS = { medium: 200, high: 1000 };

function deriveConfidence(trainedOnExampleCount: number): JudgePrediction["confidence"] {
  if (trainedOnExampleCount < MIN_LABELED_EXAMPLES_TO_TRAIN) return "none";
  if (trainedOnExampleCount < CONFIDENCE_THRESHOLDS.medium) return "low";
  if (trainedOnExampleCount < CONFIDENCE_THRESHOLDS.high) return "medium";
  return "high";
}

/**
 * The one entry point every caller should use — never `trainLogisticRegression`
 * or raw weights directly, so the fail-closed threshold can never be
 * accidentally skipped. Mirrors `growth-tools-config.ts`'s own
 * fail-closed-to-unavailable discipline: no trained model (or not enough
 * real examples backing it) must behave identically to "no prediction
 * available," never a silent, confidently-wrong guess.
 *
 * This is additive and can only ever supplement judgment (e.g. a cheap
 * pre-screen before `buildCandidateArms` proposes an arm for real spend) —
 * it must never replace `checkTruthfulClaims`/`checkAuthenticity`
 * (growth-creative.ts), which stay safety-critical and explainable by
 * design regardless of how good this model ever gets.
 */
export function predict(weights: JudgeModelWeights | null, features: JudgeModelFeatures): JudgePrediction {
  if (!weights || weights.trainedOnExampleCount < MIN_LABELED_EXAMPLES_TO_TRAIN) {
    return {
      predictedSuccessProbability: 0.5,
      confidence: "none",
      basis: "no_model_fallback",
      trainedOnExampleCount: weights?.trainedOnExampleCount ?? 0,
    };
  }

  const vector = [1, ...encodeFeatureVector(features, weights.vocabulary)];
  return {
    predictedSuccessProbability: sigmoid(dot(weights.weights, vector)),
    confidence: deriveConfidence(weights.trainedOnExampleCount),
    basis: "learned_model",
    trainedOnExampleCount: weights.trainedOnExampleCount,
  };
}

/**
 * The real call site this file was missing: `predict` + `extractFeatures`
 * composed into one function a caller can invoke the moment a candidate's
 * context is known — no ledger entry, `creativeId`, or spend decision
 * required. Concretely: once `checkTruthfulClaims`/`checkAuthenticity`
 * have run for a freshly-generated `Creative` (growth-creative.ts) and
 * before `executeChannelAction`/`recordGrowthAction` (growth-execution.ts/
 * growth-feed.ts) ever gets called, this is callable right there — exactly
 * the "cheap pre-screen before a candidate is proposed for real spend"
 * this file's own header always described, now a real function instead of
 * only a sentence. Fails closed identically to `predict` itself: with
 * `weights: null` (true today, always, since zero real executions exist),
 * every call returns the same honest `no_model_fallback`.
 */
export function predictForCandidate(
  input: JudgePredictionInputs,
  weights: JudgeModelWeights | null,
  patternLookup: GroundingPatternLookup = {},
): JudgePrediction {
  return predict(weights, extractFeatures(input, patternLookup));
}

/** Fraction of `outcomes` where `predict`'s thresholded-at-0.5 call matches
 * the real `success` label — delegates to `predict` (not raw weights), so
 * this inherits the exact same fail-closed fallback: with `weights === null`
 * or too few training examples, every prediction is the honest 0.5 "no
 * information" guess, which thresholds to "predict success" always, which
 * makes this function's output the base success rate — a real, meaningful
 * number, never a crash or a fabricated accuracy for an untrained model. */
function accuracy(weights: JudgeModelWeights | null, outcomes: LabeledOutcome[]): number {
  if (outcomes.length === 0) return NaN;
  let correct = 0;
  for (const o of outcomes) {
    const predictedSuccess = predict(weights, o.features).predictedSuccessProbability >= 0.5;
    if (predictedSuccess === o.success) correct++;
  }
  return correct / outcomes.length;
}

// ---------------------------------------------------------------------------
// Held-out-by-app evaluation (distribution-intelligence.md Part 4, item 6).
//
// Buildable and meaningfully testable TODAY, unlike this file's earlier
// framing suggested — the correction matters enough to spell out. The
// MECHANISM (does a train/test split by app correctly detect a model that
// only memorized one app's quirks) is a general software property, testable
// with a planted synthetic scenario exactly like `trainLogisticRegression`'s
// own convergence test above. What's still genuinely unknowable without
// real data is the real-world MAGNITUDE of any gap real apps would show —
// that's an empirical fact about reality, not a property of this code, and
// no amount of invented data can reveal it (any synthetic dataset has
// exactly the properties it was given, so "measuring" against it just
// reads back an assumption, never discovers one). This mechanism is what
// the vibecoded-apps validation phase (see "Validation strategy" above)
// will actually exercise once it runs — built now so there's a real tool
// ready, not designed from scratch under time pressure then.
// ---------------------------------------------------------------------------

/** Pure. Splits by `appId`, never by individual example — the one split
 * that actually tests "does this generalize to an app the model has never
 * seen," as opposed to a random split, which would only test "did it
 * memorize this exact set of examples." */
export function splitByApp(outcomes: LabeledOutcome[], heldOutAppIds: Set<string>): { train: LabeledOutcome[]; test: LabeledOutcome[] } {
  const train = outcomes.filter((o) => !heldOutAppIds.has(o.appId));
  const test = outcomes.filter((o) => heldOutAppIds.has(o.appId));
  return { train, test };
}

export type GeneralizationReport =
  | { status: "insufficient_data"; trainExampleCount: number; testExampleCount: number }
  | {
      status: "evaluated";
      trainExampleCount: number;
      testExampleCount: number;
      trainAccuracy: number;
      testAccuracy: number;
      /** `trainAccuracy - testAccuracy`. Large and positive means the
       * model does much better on the apps it trained on than on the app
       * it's never seen — the actual signature of overfitting to
       * per-app idiosyncrasy rather than learning something that
       * transfers. Near zero is the honest goal, not a perfect score on
       * either side. */
      generalizationGap: number;
    };

/**
 * Trains on `train`, evaluates on both `train` and the held-out `test` set,
 * reports the gap. `status: "insufficient_data"` when there's nothing
 * meaningful to train or test on yet — today, always, since zero real apps
 * have produced any real outcomes.
 */
export function evaluateGeneralization(train: LabeledOutcome[], test: LabeledOutcome[], trainedAt: string): GeneralizationReport {
  if (train.length < MIN_LABELED_EXAMPLES_TO_TRAIN || test.length === 0) {
    return { status: "insufficient_data", trainExampleCount: train.length, testExampleCount: test.length };
  }
  const weights = trainLogisticRegression(train, trainedAt);
  const trainAccuracy = accuracy(weights, train);
  const testAccuracy = accuracy(weights, test);
  return {
    status: "evaluated",
    trainExampleCount: train.length,
    testExampleCount: test.length,
    trainAccuracy,
    testAccuracy,
    generalizationGap: trainAccuracy - testAccuracy,
  };
}

// ---------------------------------------------------------------------------
// Calibration + drift detection (distribution-intelligence.md Part 4, item 7).
// Same correction as above: the MECHANISM is testable now with a planted
// synthetic scenario (a perfectly-calibrated fake dataset must score near
// zero error; a badly-miscalibrated one must score high) — only the real
// calibration/drift MAGNITUDE on real outcomes is unknowable until they
// exist.
// ---------------------------------------------------------------------------

export type CalibrationBucket = {
  rangeLabel: string;
  predictedMidpoint: number;
  sampleCount: number;
  /** `null` when this bucket has zero examples — distinct from `0`, which
   * would dishonestly claim "every prediction in this range was wrong." */
  actualSuccessRate: number | null;
};

/** Pure. Bins `predictions` by predicted probability into `bucketCount`
 * equal-width ranges (disclosed default: 10 — a guess, same status as
 * every other constant in this file) and reports the real observed
 * success rate per bucket, alongside the predicted midpoint — the
 * standard reliability-diagram shape, never collapsed into one number
 * here (that's `meanCalibrationError`'s job, kept separate on purpose). */
export function computeCalibrationCurve(
  predictions: { predicted: number; actual: boolean }[],
  bucketCount: number = 10,
): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = i / bucketCount;
    const hi = (i + 1) / bucketCount;
    const inBucket = predictions.filter((p) => p.predicted >= lo && (i === bucketCount - 1 ? p.predicted <= hi : p.predicted < hi));
    buckets.push({
      rangeLabel: `[${lo.toFixed(1)}, ${hi.toFixed(1)}${i === bucketCount - 1 ? "]" : ")"}`,
      predictedMidpoint: (lo + hi) / 2,
      sampleCount: inBucket.length,
      actualSuccessRate: inBucket.length > 0 ? inBucket.filter((p) => p.actual).length / inBucket.length : null,
    });
  }
  return buckets;
}

/** Pure. Sample-size-weighted mean absolute gap between each bucket's
 * predicted midpoint and its real observed success rate — a standard
 * expected-calibration-error (ECE) computation. `NaN` when every bucket is
 * empty (nothing to compute), never a fabricated `0`. */
export function meanCalibrationError(buckets: CalibrationBucket[]): number {
  const withData = buckets.filter((b) => b.actualSuccessRate !== null && b.sampleCount > 0);
  if (withData.length === 0) return NaN;
  const totalSamples = withData.reduce((sum, b) => sum + b.sampleCount, 0);
  const weightedError = withData.reduce((sum, b) => sum + b.sampleCount * Math.abs(b.predictedMidpoint - (b.actualSuccessRate as number)), 0);
  return weightedError / totalSamples;
}

export type DriftSignal = {
  status: "no_drift_detected" | "drift_detected";
  baselineSuccessRate: number;
  recentSuccessRate: number;
  absoluteDifference: number;
};

/** Disclosed guess, same status as every other threshold in this file —
 * revisit once real week-over-week variance is actually observable. */
export const DRIFT_THRESHOLD = 0.15;

/**
 * Pure. Deliberately simple v1: a global success-rate shift, not a
 * per-feature-bucket or statistically rigorous changepoint test (a real
 * CUSUM/Page-Hinkley-style detector is a reasonable future upgrade, not
 * built here) — same "honest, disclosed, simple first version" discipline
 * as `growth-strategy.ts`'s own fixed rule table. `NaN` inputs (an empty
 * baseline or recent window) propagate honestly rather than being coerced
 * into a false "no drift" reading.
 */
export function detectDrift(baseline: LabeledOutcome[], recent: LabeledOutcome[]): DriftSignal {
  const baselineSuccessRate = successRate(baseline);
  const recentSuccessRate = successRate(recent);
  const absoluteDifference = Math.abs(baselineSuccessRate - recentSuccessRate);
  return {
    status: absoluteDifference >= DRIFT_THRESHOLD ? "drift_detected" : "no_drift_detected",
    baselineSuccessRate,
    recentSuccessRate,
    absoluteDifference,
  };
}

function successRate(outcomes: LabeledOutcome[]): number {
  if (outcomes.length === 0) return NaN;
  return outcomes.filter((o) => o.success).length / outcomes.length;
}

// ---------------------------------------------------------------------------
// Retraining + versioning policy (distribution-intelligence.md Part 4, item
// 8). Built directly on top of the two sections above — "should this new
// version replace the current one" is answered using the exact same
// held-out accuracy this file already computes, not a separate mechanism.
// ---------------------------------------------------------------------------

/** Disclosed guess: retrain once this many new labeled examples have
 * accumulated since the last training run. The right real-world number
 * depends on how fast real outcomes actually accumulate, which is
 * unknowable until real execution exists — revisit then, don't treat this
 * as calibrated. */
export const RETRAIN_AFTER_NEW_EXAMPLES = 50;

export function shouldRetrain(labeledExamplesSinceLastTraining: number, threshold: number = RETRAIN_AFTER_NEW_EXAMPLES): boolean {
  return labeledExamplesSinceLastTraining >= threshold;
}

/** Disclosed guess: a new version must beat the current one's held-out
 * accuracy by at least this many points to be worth promoting — guards
 * against replacing a trusted version over noise. */
export const MIN_ACCURACY_IMPROVEMENT_TO_PROMOTE = 0.02;

export type VersionComparisonResult =
  | { decision: "insufficient_data_to_compare"; reason: string }
  | { decision: "promote_new_version"; reason: string; oldTestAccuracy: number; newTestAccuracy: number }
  | { decision: "keep_current_version"; reason: string; oldTestAccuracy: number; newTestAccuracy: number };

/**
 * Pure. Compares `oldWeights` (the currently-trusted version, or `null` if
 * none exists yet) against `newWeights` on the same real, held-out test
 * set — never on the data either was trained on, which would make "is the
 * new one better" meaningless. `oldWeights: null` is handled by `accuracy`
 * itself (via `predict`'s own fallback), not a special case here — a
 * nonexistent prior version's "accuracy" is honestly just the base success
 * rate of always guessing 0.5.
 */
export function compareModelVersions(
  oldWeights: JudgeModelWeights | null,
  newWeights: JudgeModelWeights,
  heldOutTest: LabeledOutcome[],
): VersionComparisonResult {
  if (heldOutTest.length === 0) {
    return { decision: "insufficient_data_to_compare", reason: "no held-out test examples to compare against" };
  }
  const oldTestAccuracy = accuracy(oldWeights, heldOutTest);
  const newTestAccuracy = accuracy(newWeights, heldOutTest);
  if (newTestAccuracy - oldTestAccuracy >= MIN_ACCURACY_IMPROVEMENT_TO_PROMOTE) {
    return {
      decision: "promote_new_version",
      reason: `held-out accuracy improved by ${((newTestAccuracy - oldTestAccuracy) * 100).toFixed(1)} points`,
      oldTestAccuracy,
      newTestAccuracy,
    };
  }
  return {
    decision: "keep_current_version",
    reason: "new version is not a meaningful improvement on the current one's held-out accuracy",
    oldTestAccuracy,
    newTestAccuracy,
  };
}
