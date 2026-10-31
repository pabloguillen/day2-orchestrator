import { evaluateProportionExperiment } from "../experiments";
import type { ReleaseHealth } from "../field-store";
import { seeded } from "../growth-bets";

/**
 * Is a new release (an over-the-air update, or a store build in a staged
 * rollout) at least as healthy as the one before it? Measured with day2's
 * own field data: devices (launches) that ran each release, how many
 * crashed, and how many hit each failing check — same window, side by side.
 *
 *  - "wait": too few launches yet, or too early in this stage;
 *  - "regressed": crashes clearly up (posterior ≥ 95% that it's worse, and
 *    at least 3 crashes and +0.5 points), or a check failing on ≥ 3% of the
 *    new release's devices that barely fails on the old one;
 *  - "healthy": enough launches, long enough, and neither of the above.
 */

export const MIN_DEVICES = 50;
export const MIN_CRASHES_TO_BLAME = 3;
export const CHECK_FAIL_SHARE = 0.03;

export type Verdict = { state: "wait"; why: string } | { state: "healthy"; why: string } | { state: "regressed"; why: string };

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const bools = (n: number, bad: number) => Array.from({ length: n }, (_, i) => i >= bad);

export function verdict(next: ReleaseHealth, before: ReleaseHealth | null, o: { minutesInStage: number; minMinutes: number; minDevices?: number }): Verdict {
  const minDevices = o.minDevices ?? MIN_DEVICES;
  const rate = (h: ReleaseHealth) => (h.devices ? h.crashed / h.devices : 0);
  // Crashes up: judged as soon as there's enough evidence, even before the stage's time is up.
  if (before && before.devices >= 20 && next.crashed >= MIN_CRASHES_TO_BLAME && rate(next) - rate(before) >= 0.005) {
    const cmp = evaluateProportionExperiment(bools(before.devices, before.crashed), bools(next.devices, next.crashed), seeded(`${next.release}|${before.release}`), { minNPerArm: 20 });
    if (cmp.sufficientPower && cmp.posteriorProbabilityTreatmentBetter <= 0.05) return { state: "regressed", why: `${pct(rate(next))} of launches crashed, against ${pct(rate(before))} before` };
  }
  if (!before && next.devices >= minDevices && rate(next) >= 0.05 && next.crashed >= MIN_CRASHES_TO_BLAME) return { state: "regressed", why: `${pct(rate(next))} of launches crashed` };
  // A check that breaks with this release.
  for (const [check, n] of Object.entries(next.failing)) {
    const share = next.devices ? n / next.devices : 0;
    const was = before && before.devices ? (before.failing[check] ?? 0) / before.devices : 0;
    if (n >= 5 && share >= CHECK_FAIL_SHARE && share >= 5 * was + 0.01) return { state: "regressed", why: `"${check}" fails on ${pct(share)} of launches${before ? `, against ${pct(was)} before` : ""}` };
  }
  if (next.devices < minDevices) return { state: "wait", why: `${next.devices} of ${minDevices} launches needed so far` };
  if (o.minutesInStage < o.minMinutes) return { state: "wait", why: `watching for ${Math.ceil(o.minMinutes - o.minutesInStage)} more minutes` };
  return { state: "healthy", why: `${next.devices} launches, ${pct(rate(next))} crashed${before ? ` (before: ${pct(rate(before))})` : ""}` };
}
