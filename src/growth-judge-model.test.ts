import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JUDGE_MODEL_LEDGER_FILENAME,
  MIN_LABELED_EXAMPLES_TO_TRAIN,
  UNKNOWN_APP_ID,
  appendLabeledOutcome,
  buildFeatureVocabulary,
  buildGroundingPatternLookup,
  compareModelVersions,
  computeCalibrationCurve,
  deriveNewLabeledOutcomes,
  detectDrift,
  encodeFeatureVector,
  evaluateGeneralization,
  extractFeatures,
  loadLabeledOutcomes,
  meanCalibrationError,
  predict,
  predictForCandidate,
  recordLabeledOutcomesFromRecords,
  shouldRetrain,
  splitByApp,
  trainLogisticRegression,
  type GroundingPatternLookup,
  type GrowthActionRecordForJudgeModel,
  type JudgeModelFeatures,
  type JudgeModelWeights,
  type JudgePredictionInputs,
  type LabeledOutcome,
} from "./growth-judge-model";
import type { AcquisitionEvent, ActivationEvent } from "./growth-execution";

function tmpLedgerPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "day2-judge-model-"));
  return { dir, file: join(dir, JUDGE_MODEL_LEDGER_FILENAME) };
}

function baseRecord(overrides: Partial<GrowthActionRecordForJudgeModel> = {}): GrowthActionRecordForJudgeModel {
  return {
    creativeId: "creative-1",
    arm: { channel: "social_content", assetType: "text", formatTag: "text-post" },
    executionResult: "executed",
    spend: { requested: 10 },
    strategy: { stage: "traction" },
    toolUsed: null,
    claimsCheck: { truthful: true },
    authenticityCheck: { readsAsGeneric: false },
    ...overrides,
  };
}

const sampleFeatures: JudgeModelFeatures = {
  channel: "social_content",
  assetType: "text",
  videoFormat: "none",
  stage: "traction",
  toolCapability: "none",
  authenticityFlagged: false,
  claimsFlagged: false,
  groundingPatternTier: "none",
  groundingPatternEvidenceBasis: "none",
};

describe("extractFeatures", () => {
  test("projects a real action record's relevant fields, nothing invented", () => {
    const record = baseRecord({
      arm: { channel: "paid_ads", assetType: "video", videoFormat: "ugc", formatTag: "ugc-15s" },
      strategy: { stage: "growth" },
      toolUsed: { capability: "ugc_video_generation", mcpServerName: "arcads", reason: "fits" },
      claimsCheck: { truthful: false },
      authenticityCheck: { readsAsGeneric: true },
    });
    expect(extractFeatures(record)).toEqual({
      channel: "paid_ads",
      assetType: "video",
      videoFormat: "ugc",
      stage: "growth",
      toolCapability: "ugc_video_generation",
      authenticityFlagged: true,
      claimsFlagged: true,
      groundingPatternTier: "none",
      groundingPatternEvidenceBasis: "none",
    });
  });

  test("defaults videoFormat to 'none' and toolCapability to 'none' for a plain organic arm", () => {
    const record = baseRecord();
    const features = extractFeatures(record);
    expect(features.videoFormat).toBe("none");
    expect(features.toolCapability).toBe("none");
  });

  test("resolves groundingPatternTier/evidenceBasis from a real lookup when groundedInPatternId is set", () => {
    const record = baseRecord({ groundedInPatternId: "pattern-1" });
    const lookup: GroundingPatternLookup = { "pattern-1": { tier: "replicated_cross_context", evidenceBasis: "first_party" } };
    const features = extractFeatures(record, lookup);
    expect(features.groundingPatternTier).toBe("replicated_cross_context");
    expect(features.groundingPatternEvidenceBasis).toBe("first_party");
  });

  test("degrades honestly to 'none' when groundedInPatternId doesn't resolve in the lookup — never throws", () => {
    const record = baseRecord({ groundedInPatternId: "stale-or-removed-pattern" });
    const features = extractFeatures(record, {});
    expect(features.groundingPatternTier).toBe("none");
    expect(features.groundingPatternEvidenceBasis).toBe("none");
  });
});

describe("predictForCandidate — the real pre-execution call site", () => {
  function candidateInput(overrides: Partial<JudgePredictionInputs> = {}): JudgePredictionInputs {
    return {
      arm: { channel: "social_content", assetType: "text", formatTag: "text-post" },
      strategy: { stage: "traction" },
      toolUsed: null,
      claimsCheck: { truthful: true },
      authenticityCheck: { readsAsGeneric: false },
      ...overrides,
    };
  }

  test("matches calling extractFeatures + predict by hand", () => {
    const viaConvenience = predictForCandidate(candidateInput(), null);
    const viaManual = predict(null, extractFeatures(candidateInput()));
    expect(viaConvenience).toEqual(viaManual);
  });

  test("returns the honest fallback with no trained model — true for every real call today", () => {
    const result = predictForCandidate(candidateInput(), null);
    expect(result.basis).toBe("no_model_fallback");
    expect(result.predictedSuccessProbability).toBe(0.5);
  });

  test("resolves a real grounding pattern end to end through the convenience function", () => {
    const lookup: GroundingPatternLookup = { "pattern-9": { tier: "replicated_cross_context", evidenceBasis: "first_party" } };
    const vocabulary = buildFeatureVocabulary();
    const weights: JudgeModelWeights = {
      vocabulary,
      weights: new Array(vocabulary.length + 1).fill(0),
      trainedOnExampleCount: 200,
      trainedAt: "x",
    };
    const result = predictForCandidate(candidateInput({ groundedInPatternId: "pattern-9" }), weights, lookup);
    expect(result.basis).toBe("learned_model");
  });
});

describe("buildGroundingPatternLookup", () => {
  test("projects a real pattern library's patterns into the lookup extractFeatures needs", () => {
    const lookup = buildGroundingPatternLookup([
      { id: "pattern-1", tier: "replicated_same_context", evidenceBasis: "mixed" },
      { id: "pattern-2", tier: "single_observation", evidenceBasis: "inferred_only" },
    ]);
    const features = extractFeatures(baseRecord({ groundedInPatternId: "pattern-2" }), lookup);
    expect(features.groundingPatternTier).toBe("single_observation");
    expect(features.groundingPatternEvidenceBasis).toBe("inferred_only");
  });
});

describe("deriveNewLabeledOutcomes", () => {
  const acquisitionEvents: AcquisitionEvent[] = [
    { creativeId: "creative-1", armKey: "k1", deviceId: "device-1", landedAt: "2026-09-01T00:00:00.000Z" },
  ];

  test("labels success=true when a real activation signal follows within the window", () => {
    const activationEvents: ActivationEvent[] = [{ deviceId: "device-1", occurredAt: "2026-09-02T00:00:00.000Z" }];
    const outcomes = deriveNewLabeledOutcomes(
      [baseRecord()],
      acquisitionEvents,
      activationEvents,
      new Set(),
      "2026-09-05T00:00:00.000Z",
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].creativeId).toBe("creative-1");
    expect(outcomes[0].spendUsd).toBe(10);
    expect(outcomes[0].appId).toBe(UNKNOWN_APP_ID); // baseRecord() carries no appId
  });

  test("passes through a real appId when the record has one", () => {
    const activationEvents: ActivationEvent[] = [{ deviceId: "device-1", occurredAt: "2026-09-02T00:00:00.000Z" }];
    const outcomes = deriveNewLabeledOutcomes(
      [baseRecord({ appId: "vibecoded-app-1" })],
      acquisitionEvents,
      activationEvents,
      new Set(),
      "2026-09-05T00:00:00.000Z",
    );
    expect(outcomes[0]!.appId).toBe("vibecoded-app-1");
  });

  test("labels success=false when no activation signal ever followed", () => {
    const outcomes = deriveNewLabeledOutcomes([baseRecord()], acquisitionEvents, [], new Set(), "2026-09-05T00:00:00.000Z");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(false);
  });

  test("skips a record with no acquisition landing yet — never fabricates a label", () => {
    const outcomes = deriveNewLabeledOutcomes([baseRecord()], [], [], new Set(), "2026-09-05T00:00:00.000Z");
    expect(outcomes).toHaveLength(0);
  });

  test("skips a record that never actually executed — nothing to label", () => {
    const outcomes = deriveNewLabeledOutcomes(
      [baseRecord({ executionResult: "simulated_stopped_before_live_action" })],
      acquisitionEvents,
      [],
      new Set(),
      "2026-09-05T00:00:00.000Z",
    );
    expect(outcomes).toHaveLength(0);
  });

  test("skips a creativeId already labeled — idempotent re-derivation", () => {
    const outcomes = deriveNewLabeledOutcomes(
      [baseRecord()],
      acquisitionEvents,
      [],
      new Set(["creative-1"]),
      "2026-09-05T00:00:00.000Z",
    );
    expect(outcomes).toHaveLength(0);
  });
});

describe("ledger persistence", () => {
  test("round-trips through appendLabeledOutcome/loadLabeledOutcomes", () => {
    const { dir, file } = tmpLedgerPath();
    try {
      expect(loadLabeledOutcomes(file)).toEqual([]);
      const outcome: LabeledOutcome = {
        creativeId: "creative-1",
        appId: "app-a",
        features: sampleFeatures,
        success: true,
        spendUsd: 5,
        recordedAt: "2026-09-05T00:00:00.000Z",
      };
      appendLabeledOutcome(file, outcome);
      expect(loadLabeledOutcomes(file)).toEqual([outcome]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recordLabeledOutcomesFromRecords is idempotent across repeated runs", () => {
    const { dir, file } = tmpLedgerPath();
    try {
      const acquisitionEvents: AcquisitionEvent[] = [
        { creativeId: "creative-1", armKey: "k1", deviceId: "device-1", landedAt: "2026-09-01T00:00:00.000Z" },
      ];
      const activationEvents: ActivationEvent[] = [{ deviceId: "device-1", occurredAt: "2026-09-02T00:00:00.000Z" }];
      const records = [baseRecord()];

      const first = recordLabeledOutcomesFromRecords(file, records, acquisitionEvents, activationEvents, "2026-09-05T00:00:00.000Z");
      expect(first).toHaveLength(1);

      const second = recordLabeledOutcomesFromRecords(file, records, acquisitionEvents, activationEvents, "2026-09-06T00:00:00.000Z");
      expect(second).toHaveLength(0); // already labeled — never double-counted

      expect(loadLabeledOutcomes(file)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("feature encoding", () => {
  test("vocabulary is stable and one-hot encoding activates exactly the right columns", () => {
    const vocabulary = buildFeatureVocabulary();
    const vector = encodeFeatureVector(sampleFeatures, vocabulary);
    expect(vector).toHaveLength(vocabulary.length);

    const activeColumns = vocabulary.filter((_, i) => vector[i] === 1);
    expect(activeColumns).toEqual(
      expect.arrayContaining([
        "channel:social_content",
        "assetType:text",
        "videoFormat:none",
        "stage:traction",
        "toolCapability:none",
        "groundingPatternTier:none",
        "groundingPatternEvidenceBasis:none",
      ]),
    );
    expect(vector.reduce((a, b) => a + b, 0)).toBe(7); // exactly 7 active one-hot columns, flags both 0
  });

  test("boolean flags encode independently of the one-hot columns", () => {
    const vocabulary = buildFeatureVocabulary();
    const flagged: JudgeModelFeatures = { ...sampleFeatures, authenticityFlagged: true, claimsFlagged: true };
    const vector = encodeFeatureVector(flagged, vocabulary);
    expect(vector.reduce((a, b) => a + b, 0)).toBe(9); // 7 one-hot + 2 flags
  });

  test("a real grounding pattern activates its own tier/evidenceBasis columns instead of the 'none' ones", () => {
    const vocabulary = buildFeatureVocabulary();
    const grounded: JudgeModelFeatures = {
      ...sampleFeatures,
      groundingPatternTier: "replicated_cross_context",
      groundingPatternEvidenceBasis: "first_party",
    };
    const vector = encodeFeatureVector(grounded, vocabulary);
    const activeColumns = vocabulary.filter((_, i) => vector[i] === 1);
    expect(activeColumns).toEqual(
      expect.arrayContaining(["groundingPatternTier:replicated_cross_context", "groundingPatternEvidenceBasis:first_party"]),
    );
    expect(activeColumns).not.toContain("groundingPatternTier:none");
    expect(activeColumns).not.toContain("groundingPatternEvidenceBasis:none");
  });
});

describe("predict — fail-closed fallback", () => {
  test("returns the honest no-model fallback when weights are null", () => {
    const result = predict(null, sampleFeatures);
    expect(result).toEqual({
      predictedSuccessProbability: 0.5,
      confidence: "none",
      basis: "no_model_fallback",
      trainedOnExampleCount: 0,
    });
  });

  test("returns the fallback when trained on fewer than MIN_LABELED_EXAMPLES_TO_TRAIN", () => {
    const weights: JudgeModelWeights = {
      vocabulary: buildFeatureVocabulary(),
      weights: new Array(buildFeatureVocabulary().length + 1).fill(10), // extreme weights, must still be ignored
      trainedOnExampleCount: MIN_LABELED_EXAMPLES_TO_TRAIN - 1,
      trainedAt: "2026-09-05T00:00:00.000Z",
    };
    const result = predict(weights, sampleFeatures);
    expect(result.basis).toBe("no_model_fallback");
    expect(result.predictedSuccessProbability).toBe(0.5);
    expect(result.confidence).toBe("none");
  });

  test("confidence tiers rise with trainedOnExampleCount once the model is trusted at all", () => {
    const vocabulary = buildFeatureVocabulary();
    const zeroWeights = new Array(vocabulary.length + 1).fill(0);
    const low = predict({ vocabulary, weights: zeroWeights, trainedOnExampleCount: 60, trainedAt: "x" }, sampleFeatures);
    const medium = predict({ vocabulary, weights: zeroWeights, trainedOnExampleCount: 300, trainedAt: "x" }, sampleFeatures);
    const high = predict({ vocabulary, weights: zeroWeights, trainedOnExampleCount: 2000, trainedAt: "x" }, sampleFeatures);
    expect(low.confidence).toBe("low");
    expect(medium.confidence).toBe("medium");
    expect(high.confidence).toBe("high");
    expect(low.basis).toBe("learned_model");
  });
});

describe("trainLogisticRegression + predict — synthetic convergence", () => {
  test("separates a planted winning feature from a planted losing one", () => {
    const winning: JudgeModelFeatures = { ...sampleFeatures, channel: "paid_ads", assetType: "video" };
    const losing: JudgeModelFeatures = { ...sampleFeatures, channel: "aso", assetType: "text" };

    const outcomes: LabeledOutcome[] = [];
    for (let i = 0; i < 120; i++) {
      // Winning combo succeeds ~85% of the time, losing combo ~15% — a real,
      // noisy-but-genuine signal, not a deterministic giveaway.
      outcomes.push({ creativeId: `win-${i}`, appId: "app-a", features: winning, success: i % 20 !== 0, spendUsd: 5, recordedAt: "x" });
      outcomes.push({ creativeId: `lose-${i}`, appId: "app-a", features: losing, success: i % 20 === 0, spendUsd: 5, recordedAt: "x" });
    }

    const weights = trainLogisticRegression(outcomes, "2026-09-05T00:00:00.000Z");
    expect(weights.trainedOnExampleCount).toBe(outcomes.length);

    const winningPrediction = predict(weights, winning);
    const losingPrediction = predict(weights, losing);

    expect(winningPrediction.basis).toBe("learned_model");
    expect(winningPrediction.predictedSuccessProbability).toBeGreaterThan(0.6);
    expect(losingPrediction.predictedSuccessProbability).toBeLessThan(0.4);
    expect(winningPrediction.predictedSuccessProbability).toBeGreaterThan(losingPrediction.predictedSuccessProbability);
  });

  test("training is deterministic — same input always produces the same weights", () => {
    const outcomes: LabeledOutcome[] = Array.from({ length: 60 }, (_, i) => ({
      creativeId: `c-${i}`,
      appId: "app-a",
      features: sampleFeatures,
      success: i % 2 === 0,
      spendUsd: 1,
      recordedAt: "x",
    }));
    const a = trainLogisticRegression(outcomes, "2026-09-05T00:00:00.000Z");
    const b = trainLogisticRegression(outcomes, "2026-09-05T00:00:00.000Z");
    expect(a.weights).toEqual(b.weights);
  });
});

function makeOutcome(appId: string, creativeId: string, channel: JudgeModelFeatures["channel"], success: boolean): LabeledOutcome {
  return { creativeId, appId, features: { ...sampleFeatures, channel }, success, spendUsd: 1, recordedAt: "x" };
}

function makeSuccessOutcomes(n: number, successRate: number): LabeledOutcome[] {
  return Array.from({ length: n }, (_, i) => ({
    creativeId: `o-${i}`,
    appId: "app-a",
    features: sampleFeatures,
    success: i < n * successRate,
    spendUsd: 1,
    recordedAt: "x",
  }));
}

describe("splitByApp", () => {
  test("splits by appId, never by individual example", () => {
    const outcomes: LabeledOutcome[] = [
      makeOutcome("app-a", "a1", "paid_ads", true),
      makeOutcome("app-a", "a2", "paid_ads", false),
      makeOutcome("app-b", "b1", "paid_ads", true),
    ];
    const { train, test } = splitByApp(outcomes, new Set(["app-b"]));
    expect(train.map((o) => o.creativeId)).toEqual(["a1", "a2"]);
    expect(test.map((o) => o.creativeId)).toEqual(["b1"]);
  });
});

describe("evaluateGeneralization — synthetic cross-app transfer", () => {
  test("insufficient_data when there's too little to train or nothing held out to test on", () => {
    const tiny = [makeOutcome("app-a", "a1", "paid_ads", true)];
    expect(evaluateGeneralization(tiny, [], "x")).toEqual({ status: "insufficient_data", trainExampleCount: 1, testExampleCount: 0 });
  });

  test("reports a near-zero gap when the real relationship genuinely transfers to a never-seen app", () => {
    const train: LabeledOutcome[] = [];
    const test: LabeledOutcome[] = [];
    for (let i = 0; i < 40; i++) {
      // Same true rule in both apps: paid_ads succeeds ~90%, aso succeeds ~10%.
      train.push(makeOutcome("app-a", `a-paid-${i}`, "paid_ads", i % 10 !== 0));
      train.push(makeOutcome("app-a", `a-aso-${i}`, "aso", i % 10 === 0));
      test.push(makeOutcome("app-b", `b-paid-${i}`, "paid_ads", i % 10 !== 0));
      test.push(makeOutcome("app-b", `b-aso-${i}`, "aso", i % 10 === 0));
    }
    const report = evaluateGeneralization(train, test, "x");
    expect(report.status).toBe("evaluated");
    if (report.status === "evaluated") {
      expect(Math.abs(report.generalizationGap)).toBeLessThan(0.15);
    }
  });

  test("reports a large positive gap when training only memorized an app-specific confound that doesn't transfer", () => {
    const train: LabeledOutcome[] = [];
    const test: LabeledOutcome[] = [];
    for (let i = 0; i < 40; i++) {
      // In app A, paid_ads happens to correlate with success — a coincidence specific to A.
      train.push(makeOutcome("app-a", `a-paid-${i}`, "paid_ads", i % 10 !== 0));
      train.push(makeOutcome("app-a", `a-aso-${i}`, "aso", i % 10 === 0));
      // In app B, that same combination carries no real signal — a coin flip.
      test.push(makeOutcome("app-b", `b-paid-${i}`, "paid_ads", i % 2 === 0));
      test.push(makeOutcome("app-b", `b-aso-${i}`, "aso", i % 2 === 0));
    }
    const report = evaluateGeneralization(train, test, "x");
    expect(report.status).toBe("evaluated");
    if (report.status === "evaluated") {
      expect(report.trainAccuracy).toBeGreaterThan(0.75);
      expect(report.generalizationGap).toBeGreaterThan(0.2);
    }
  });
});

describe("computeCalibrationCurve + meanCalibrationError — synthetic calibration", () => {
  test("reports near-zero error for a perfectly calibrated synthetic prediction set", () => {
    // 0.75/0.25 land solidly inside their own bucket ([0.7,0.8)/[0.2,0.3)),
    // whose midpoints are exactly 0.75/0.25 — a boundary value like 0.7
    // would land in [0.7,0.8) too, whose midpoint is 0.75, not 0.7, which
    // would make this a test-construction bug, not a real miscalibration.
    const predictions: { predicted: number; actual: boolean }[] = [];
    for (let i = 0; i < 100; i++) predictions.push({ predicted: 0.75, actual: i < 75 });
    for (let i = 0; i < 100; i++) predictions.push({ predicted: 0.25, actual: i < 25 });
    const error = meanCalibrationError(computeCalibrationCurve(predictions, 10));
    expect(error).toBeLessThan(0.02);
  });

  test("reports high error for a badly miscalibrated synthetic prediction set", () => {
    const predictions: { predicted: number; actual: boolean }[] = [];
    for (let i = 0; i < 100; i++) predictions.push({ predicted: 0.9, actual: i < 10 }); // claims 90%, actually 10%
    const error = meanCalibrationError(computeCalibrationCurve(predictions, 10));
    expect(error).toBeGreaterThan(0.5);
  });

  test("an empty bucket reports null, never a fabricated 0", () => {
    const buckets = computeCalibrationCurve([{ predicted: 0.95, actual: true }], 10);
    const emptyBucket = buckets.find((b) => b.rangeLabel === "[0.0, 0.1)");
    expect(emptyBucket?.sampleCount).toBe(0);
    expect(emptyBucket?.actualSuccessRate).toBeNull();
  });

  test("meanCalibrationError is NaN, not 0, when every bucket is empty", () => {
    expect(meanCalibrationError([])).toBeNaN();
  });
});

describe("detectDrift", () => {
  test("no_drift_detected when success rates stay close", () => {
    const signal = detectDrift(makeSuccessOutcomes(100, 0.75), makeSuccessOutcomes(100, 0.78));
    expect(signal.status).toBe("no_drift_detected");
  });

  test("drift_detected when success rates shift beyond the threshold", () => {
    const signal = detectDrift(makeSuccessOutcomes(100, 0.8), makeSuccessOutcomes(100, 0.4));
    expect(signal.status).toBe("drift_detected");
    expect(signal.absoluteDifference).toBeCloseTo(0.4, 1);
  });
});

describe("shouldRetrain", () => {
  test("false below the threshold, true at or above it", () => {
    expect(shouldRetrain(49)).toBe(false);
    expect(shouldRetrain(50)).toBe(true);
    expect(shouldRetrain(5, 10)).toBe(false);
    expect(shouldRetrain(10, 10)).toBe(true);
  });
});

describe("compareModelVersions", () => {
  test("insufficient_data_to_compare with no held-out test set", () => {
    const weights = trainLogisticRegression(makeSuccessOutcomes(60, 0.6), "x");
    expect(compareModelVersions(null, weights, [])).toEqual({
      decision: "insufficient_data_to_compare",
      reason: "no held-out test examples to compare against",
    });
  });

  test("promotes a genuinely better new version over having no prior version at all", () => {
    const train: LabeledOutcome[] = [];
    const test: LabeledOutcome[] = [];
    for (let i = 0; i < 40; i++) {
      train.push(makeOutcome("app-a", `w-${i}`, "paid_ads", i % 10 !== 0));
      train.push(makeOutcome("app-a", `l-${i}`, "aso", i % 10 === 0));
      test.push(makeOutcome("app-a", `tw-${i}`, "paid_ads", i % 10 !== 0));
      test.push(makeOutcome("app-a", `tl-${i}`, "aso", i % 10 === 0));
    }
    const newWeights = trainLogisticRegression(train, "x");
    const result = compareModelVersions(null, newWeights, test);
    expect(result.decision).toBe("promote_new_version");
  });

  test("keeps the current version when a new one isn't a meaningful improvement", () => {
    const weights = trainLogisticRegression(makeSuccessOutcomes(60, 0.6), "x");
    const result = compareModelVersions(weights, weights, makeSuccessOutcomes(40, 0.6));
    expect(result.decision).toBe("keep_current_version");
  });
});
