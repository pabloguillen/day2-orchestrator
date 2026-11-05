import { sampleBeta } from "../experiments";

/**
 * P(treatment's rate > control's) with an informative prior on the log of
 * their ratio (learning/priors.ts `experimentPrior`), by importance
 * weighting the usual Beta(1,1) posterior draws. With no prior this is the
 * same number evaluateProportionExperiment gives.
 */
export function probBetterWithPrior(control: boolean[], treatment: boolean[], prior: { mean: number; sd: number } | null, rng: () => number, draws = 4000): number {
  const cn = control.length;
  const tn = treatment.length;
  const cs = control.filter(Boolean).length;
  const ts = treatment.filter(Boolean).length;
  let wins = 0;
  let total = 0;
  for (let i = 0; i < draws; i++) {
    const pt = sampleBeta(1 + ts, 1 + (tn - ts), rng);
    const pc = sampleBeta(1 + cs, 1 + (cn - cs), rng);
    let w = 1;
    if (prior) {
      const z = (Math.log(Math.max(pt, 1e-9) / Math.max(pc, 1e-9)) - prior.mean) / prior.sd;
      w = Math.exp(-0.5 * z * z);
    }
    total += w;
    if (pt > pc) wins += w;
  }
  return total > 0 ? wins / total : 0.5;
}
