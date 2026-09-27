import { createHash } from "node:crypto";

/**
 * Experiments infrastructure (COORDINATION.md W31, Step 3 Component 2 —
 * docs/step3-self-evolving-plan.md). Formalizes what
 * swarm.ts's buildComparisonPrompt/runComparisonPersona/parseComparisonResult
 * already did ad-hoc across W16/W16b/W16c/W16d: real, deterministic variant
 * assignment (no more hand-seeding one specific KV entry for one specific
 * test device) and a real statistical-significance calculator (no more
 * eyeballing a handful of action counts, as W16d's own "47.0 control vs.
 * 48.0 treatment... plausibly reverses at larger N, untested" note did).
 *
 * Both pieces are pure and fully unit-tested — no agent, no network, no
 * storage. Wiring into the config plane and the event pipeline is additive
 * work on top of this, done separately in expense-buddy.
 */

export type ExperimentVariant = { name: string; weight: number };
export type ExperimentConfig = { name: string; variants: ExperimentVariant[] };

/**
 * Deterministic, stateless variant assignment: the same device always gets
 * the same variant for a given experiment, with no storage needed to
 * remember it — re-derivable from (deviceId, experiment.name) alone.
 * Weighted by each variant's `weight`, not necessarily an even split.
 *
 * Uses a real cryptographic hash (SHA-256) rather than a hand-rolled
 * string hash — well-distributed and not subject to the kind of skew a
 * naive hash can introduce, which matters here since a biased assignment
 * function would silently corrupt every experiment built on top of it.
 */
export function assignVariant(deviceId: string, experiment: ExperimentConfig): string {
  if (experiment.variants.length === 0) {
    throw new Error(`experiment "${experiment.name}" has no variants`);
  }
  const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
  if (!(totalWeight > 0)) {
    throw new Error(`experiment "${experiment.name}" has no positive-weight variants`);
  }

  const hash = createHash("sha256").update(`${experiment.name}:${deviceId}`).digest();
  const fraction = hash.readUInt32BE(0) / 0x100000000; // in [0, 1)

  let cumulative = 0;
  for (const variant of experiment.variants) {
    cumulative += variant.weight / totalWeight;
    if (fraction < cumulative) return variant.name;
  }
  // Floating-point rounding can leave `cumulative` a hair under 1 — the
  // last variant is the correct fallback, not an error case.
  return experiment.variants[experiment.variants.length - 1]!.name;
}

// --- Statistical significance -------------------------------------------
//
// Welch's t-test (unequal-variance two-sample t-test) — the right choice
// for the outcome type this project actually has (real-valued action
// counts per persona run, like W16d's, not proportions), and it doesn't
// assume the two arms have equal variance, which a plain Student's t-test
// does and a swarm-sized sample can't safely guarantee.
//
// Computing a p-value from a t-statistic requires the t-distribution's
// CDF, which is the regularized incomplete beta function evaluated at a
// transformed x — implemented below via the standard continued-fraction
// method (Numerical Recipes' betacf) rather than pulling in a stats
// dependency for one function.

function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) {
    y += 1;
    ser += c / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(x: number, a: number, b: number): number {
  const MAXIT = 200;
  const EPS = 3e-9;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b), x in [0, 1]. */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(x, a, b)) / a;
  }
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** Two-tailed p-value for a Student's t statistic: P(|T| > |t|) with `df`
 * degrees of freedom. Standard identity: P(|T| > |t|) = I_{df/(df+t^2)}(df/2, 1/2). */
function tDistributionTwoTailedPValue(t: number, df: number): number {
  if (df <= 0) return 1;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function sampleVariance(xs: number[], m: number): number {
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

/** Below this many samples per arm, a result is never labeled
 * "significant" no matter how small the computed p-value — small-N noise
 * can produce a misleadingly small p-value by chance. Deliberately a
 * plain, disclosed constant, not a tuned/calibrated one — this project has
 * no real per-arm sample sizes yet to calibrate against. */
export const MIN_SAMPLE_SIZE_PER_ARM = 30;

export type ExperimentEvaluation = {
  pValue: number;
  significant: boolean;
  controlN: number;
  treatmentN: number;
  controlMean: number;
  treatmentMean: number;
  sufficientPower: boolean;
  note: string;
};

/**
 * Reports a real, computed p-value on whatever data it's given — but
 * `significant` is only ever `true` when the per-arm sample size also
 * clears `MIN_SAMPLE_SIZE_PER_ARM`. Same honesty discipline this project's
 * per-user model already applies to `primaryGoal`/`habits`/
 * `statedPreferences`: report what's genuinely computed, but don't let a
 * technically-real number imply more confidence than the sample actually
 * supports. W16d's own comparison ("47.0 control vs. 48.0 treatment...
 * plausibly reverses at larger N, untested") is exactly the failure mode
 * this constant exists to name explicitly instead of eyeballing.
 */
export function evaluateExperiment(
  controlOutcomes: number[],
  treatmentOutcomes: number[],
): ExperimentEvaluation {
  const controlN = controlOutcomes.length;
  const treatmentN = treatmentOutcomes.length;
  const sufficientPower = controlN >= MIN_SAMPLE_SIZE_PER_ARM && treatmentN >= MIN_SAMPLE_SIZE_PER_ARM;

  if (controlN < 2 || treatmentN < 2) {
    return {
      pValue: 1,
      significant: false,
      controlN,
      treatmentN,
      controlMean: controlN > 0 ? mean(controlOutcomes) : NaN,
      treatmentMean: treatmentN > 0 ? mean(treatmentOutcomes) : NaN,
      sufficientPower: false,
      note: "not enough data in one or both arms to compute a t-test (need at least 2 samples per arm)",
    };
  }

  const controlMean = mean(controlOutcomes);
  const treatmentMean = mean(treatmentOutcomes);
  const controlVar = sampleVariance(controlOutcomes, controlMean);
  const treatmentVar = sampleVariance(treatmentOutcomes, treatmentMean);
  const standardError = Math.sqrt(controlVar / controlN + treatmentVar / treatmentN);

  if (standardError === 0) {
    return {
      pValue: controlMean === treatmentMean ? 1 : 0,
      // Never claim significance from a degenerate (zero-variance) case,
      // regardless of what the raw p-value says.
      significant: false,
      controlN,
      treatmentN,
      controlMean,
      treatmentMean,
      sufficientPower,
      note: "zero variance in both arms — a degenerate case, not treated as a real significance signal",
    };
  }

  const t = (treatmentMean - controlMean) / standardError;
  const df =
    (controlVar / controlN + treatmentVar / treatmentN) ** 2 /
    ((controlVar / controlN) ** 2 / (controlN - 1) + (treatmentVar / treatmentN) ** 2 / (treatmentN - 1));
  const pValue = tDistributionTwoTailedPValue(t, df);

  return {
    pValue,
    significant: sufficientPower && pValue < 0.05,
    controlN,
    treatmentN,
    controlMean,
    treatmentMean,
    sufficientPower,
    note: sufficientPower
      ? "sample size meets the minimum for a trustworthy comparison"
      : `sample size below the minimum (${MIN_SAMPLE_SIZE_PER_ARM} per arm) for a trustworthy result — reporting the computed p-value for transparency, not claiming significance`,
  };
}
