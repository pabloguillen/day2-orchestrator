import { workedLines } from "../learning/runtime";
import type { AppEntry } from "../apps-registry";
import { filterProposals, proposalContext } from "../memory/runtime";
import type { ParsedStrategy } from "./strategy";

/**
 * Money and app memory: what day2 knows goes into the strategy research,
 * the whole research is skipped when the owner ruled money plans out, and
 * products or ad placements the owner declined aren't proposed again.
 */

export const moneyKnowledge = async (app: Pick<AppEntry, "id" | "repoPath">, now?: Date) => ({
  ...(await proposalContext(app, "money", ["money.strategy", "money.product", "money.ad", "money.test"], { now })),
  worked: await workedLines(app, "money"),
});

/** The hard filter on a researched plan: declined products and ad placements are dropped (and paywalls lose them). */
export async function dropDeclined(app: Pick<AppEntry, "id" | "repoPath">, s: ParsedStrategy, now = new Date()): Promise<ParsedStrategy> {
  const products = (await filterProposals(app, "money.product", s.products, (p) => p.key, now)).kept;
  const ads = (await filterProposals(app, "money.ad", s.ads, (a) => a.id, now)).kept;
  const keys = new Set(products.map((p) => p.key));
  const paywalls = s.paywalls
    .map((w) => ({ ...w, products: w.products.filter((k) => keys.has(k)), highlight: keys.has(w.highlight ?? "") ? w.highlight : (w.products.find((k) => keys.has(k)) ?? null) }))
    .filter((w) => w.products.length > 0);
  return { ...s, products, ads, paywalls };
}
