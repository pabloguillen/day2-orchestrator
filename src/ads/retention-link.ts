import type { RetentionSnapshot } from "../retention";
import { STAY_AFTER_DAYS } from "./results";

/**
 * Where ads and the retention engine meet. Ads bring people; keeping them is
 * the product's and the retention engine's job. They're one loop:
 *  - ads are judged on what they control (cost, and fit against other new
 *    users at the same time — results.ts), never on absolute retention;
 *  - the retention engine sees which new users came from ads, and when they
 *    stay clearly less than other new users it works on the first minutes
 *    after an ad (retention-pass.ts: "continue the ad's promise");
 *  - while new users barely come back at all, buying more of them is waste:
 *    ads keep running but don't scale up until the retention engine has
 *    lifted it (this file).
 */

/** Below this share of new users coming back the next period, ads don't scale up. */
export const NEW_RETURN_FLOOR = 0.1;
/** New users needed in the last period before the floor applies. */
export const NEW_BASE_MIN = 30;

export type ScaleGate = { hold: false } | { hold: true; why: string };

/** Pure. Holds scale-ups (never running ads) while new users barely come back. */
export function scaleGate(snapshot: RetentionSnapshot | null): ScaleGate {
  if (!snapshot || snapshot.status !== "ready") return { hold: false };
  const rate = snapshot.rates.new;
  if (rate === null || snapshot.base.new < NEW_BASE_MIN || rate >= NEW_RETURN_FLOOR) return { hold: false };
  return {
    hold: true,
    why: `only ${Math.round(rate * 100)}% of new users come back the next ${snapshot.rhythm === "daily" ? "day" : snapshot.rhythm === "weekly" ? "week" : "month"}, so day2 doesn't buy more of them until the retention engine has lifted that`,
  };
}

/** Days after their first day a user must be seen again to count as staying, from the app's rhythm. */
export function stayAfterDays(snapshot: RetentionSnapshot | null): number {
  return STAY_AFTER_DAYS[snapshot?.rhythm ?? "daily"];
}
