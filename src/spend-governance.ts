import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * Step 4 (self-distributing), Component 1 — budget/spend governance
 * (COORDINATION.md W37, docs/step4-self-distributing-plan.md).
 *
 * The hard gate underneath every real-world-facing action Step 4 will ever
 * take. Pure, deterministic, zero agent judgment — this is deliberately the
 * *opposite* kind of module from `evolution.ts`/`calibration.ts`: nothing
 * here calls an LLM, and nothing here should ever need to. `autonomy.ts`
 * has no numeric/spend dimension at all (confirmed by reading it before
 * this plan was written); this is the new, parallel primitive for that —
 * not a reuse or an extension of `autonomy.ts`.
 *
 * Required test bar, cited directly from the source spec's own red-team
 * section rather than invented here: "Exceeding ad budgets or spend caps
 * (property-based tests over millions of random scenarios; the allowed
 * breach count is zero)." `spend-governance.test.ts` holds that bar.
 *
 * Ordering note, a deliberate deviation from the plan doc's own literal
 * text: the plan lists "killSwitch -> idempotency -> ...", but idempotent
 * replay is implemented as the very first check, ahead of the kill switch.
 * A replayed request must return its already-recorded decision completely
 * unchanged — re-deriving it against whatever the kill switch happens to
 * be set to *now* would defeat the entire point of "never double-count a
 * retried submission." Flagged here and in STAGE4.md rather than silently
 * landing a design doc drift.
 */

export type SpendCategory =
  | "creative_generation"
  | "seo_content"
  | "aso"
  | "paid_ads"
  | "social_content"
  | "direct_outreach"
  | "website";

export type BudgetConfig = {
  monthlyBudgetUsd: number;
  /** ISO date, first-of-month boundary. The "current period" for every cap
   * below is the one calendar month starting here that a given request's
   * own `requestedAt` falls into — not "now" at evaluation time, so this
   * stays a pure function of its inputs. */
  periodStart: string;
  dailyCapUsd?: number;
  perCategoryCapUsd?: Partial<Record<SpendCategory, number>>;
  /** Safety rail 2. Default when unset: the lesser of $50 or 20% of the
   * remaining monthly budget at evaluation time. */
  perActionCapUsd?: number;
  /** Safety rail 7. Default when unset: 0.3 (30%). */
  explorationCapFraction?: number;
  /** Safety rail 3 — checked first (after idempotency), unconditionally. */
  killSwitch: boolean;
};

export type SpendRequest = {
  /** Idempotency key — see the ordering note above. */
  id: string;
  category: SpendCategory;
  amountUsd: number;
  description: string;
  requestedAt: string;
  /** Marks this request as spend on an under-observed allocator arm
   * (growth-allocator.ts), subjecting it to the exploration ceiling on top
   * of every other cap. */
  isExploration?: boolean;
};

export type SpendDecision =
  | { allowed: true; reason: string; remainingMonthlyUsd: number; remainingDailyUsd: number | null }
  | { allowed: false; reason: string; remainingMonthlyUsd: number; remainingDailyUsd: number | null };

export type SpendLedgerEntry = {
  timestamp: string;
  request: SpendRequest;
  decision: SpendDecision;
};

export type KpiGoal = { metric: string; target: number; byDate?: string };
/** Owner opt-in, default false — Component 7 (optional marketing website). */
export type WebsiteConfig = { enabled: boolean; templatePreference?: string };
export type GrowthConfig = { budget: BudgetConfig; kpiGoals: KpiGoal[]; website: WebsiteConfig };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumAmounts(entries: SpendLedgerEntry[]): number {
  return round2(entries.reduce((acc, e) => acc + e.request.amountUsd, 0));
}

/** Defense in depth alongside `recordSpend`'s own idempotency check: even if
 * a ledger somehow ends up with more than one entry sharing a `request.id`
 * (a duplicate written before this existed, a hand-edited file), every sum
 * in this module counts each id at most once — the first entry seen, which
 * is also what a replayed `evaluateSpend` call itself returns. */
function dedupedAllowed(ledger: SpendLedgerEntry[]): SpendLedgerEntry[] {
  const seen = new Set<string>();
  const result: SpendLedgerEntry[] = [];
  for (const entry of ledger) {
    if (!entry.decision.allowed || seen.has(entry.request.id)) continue;
    seen.add(entry.request.id);
    result.push(entry);
  }
  return result;
}

function periodBounds(periodStart: string): { startMs: number; endMs: number } {
  const start = new Date(periodStart);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function inPeriod(iso: string, bounds: { startMs: number; endMs: number }): boolean {
  const t = new Date(iso).getTime();
  return t >= bounds.startMs && t < bounds.endMs;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Pure. Order: idempotent replay (unconditional, ahead of everything —
 * see the file header) -> kill switch -> non-positive amount -> per-action
 * cap -> exploration ceiling (if `isExploration`) -> daily cap ->
 * per-category cap -> monthly total. The first cap a request fails is the
 * one reported; every denial still carries the real remaining-budget
 * figures so a caller/log never has to guess why.
 */
export function evaluateSpend(
  request: SpendRequest,
  config: BudgetConfig,
  ledger: SpendLedgerEntry[],
): SpendDecision {
  const existing = ledger.find((e) => e.request.id === request.id);
  if (existing) return existing.decision;

  const bounds = periodBounds(config.periodStart);
  const inCurrentPeriod = dedupedAllowed(ledger).filter((e) => inPeriod(e.request.requestedAt, bounds));
  const monthlySpent = sumAmounts(inCurrentPeriod);
  const remainingMonthlyUsd = round2(config.monthlyBudgetUsd - monthlySpent);

  const day = dayKey(request.requestedAt);
  const dailySpent = sumAmounts(inCurrentPeriod.filter((e) => dayKey(e.request.requestedAt) === day));
  const remainingDailyUsd = config.dailyCapUsd === undefined ? null : round2(config.dailyCapUsd - dailySpent);

  const deny = (reason: string): SpendDecision => ({
    allowed: false,
    reason,
    remainingMonthlyUsd,
    remainingDailyUsd,
  });

  if (config.killSwitch) {
    return deny("Kill switch is on — all growth spend is paused.");
  }

  if (!(request.amountUsd > 0)) {
    return deny("Spend amount must be positive.");
  }

  const perActionCap = config.perActionCapUsd ?? Math.min(50, Math.max(0, remainingMonthlyUsd) * 0.2);
  if (request.amountUsd > perActionCap) {
    return deny(
      `Exceeds the per-action cap ($${perActionCap.toFixed(2)}) — no single action may exceed the lesser of $50 or 20% of remaining monthly budget.`,
    );
  }

  if (request.isExploration) {
    const explorationFraction = config.explorationCapFraction ?? 0.3;
    const categoryCeiling = config.perCategoryCapUsd?.[request.category] ?? config.monthlyBudgetUsd;
    const explorationCapUsd = categoryCeiling * explorationFraction;
    const explorationSpent = sumAmounts(
      inCurrentPeriod.filter((e) => e.request.category === request.category && e.request.isExploration),
    );
    if (explorationSpent + request.amountUsd > explorationCapUsd) {
      return deny(
        `Exceeds the exploration spend ceiling for "${request.category}" ($${explorationCapUsd.toFixed(2)}, ${Math.round(explorationFraction * 100)}% of its budget) — under-observed formats can't consume more than this until they prove out.`,
      );
    }
  }

  if (config.dailyCapUsd !== undefined && dailySpent + request.amountUsd > config.dailyCapUsd) {
    return deny(`Exceeds the daily cap ($${config.dailyCapUsd.toFixed(2)}).`);
  }

  const categoryCap = config.perCategoryCapUsd?.[request.category];
  if (categoryCap !== undefined) {
    const categorySpent = sumAmounts(inCurrentPeriod.filter((e) => e.request.category === request.category));
    if (categorySpent + request.amountUsd > categoryCap) {
      return deny(`Exceeds "${request.category}"'s category cap ($${categoryCap.toFixed(2)}).`);
    }
  }

  if (monthlySpent + request.amountUsd > config.monthlyBudgetUsd) {
    return deny(`Exceeds the remaining monthly budget ($${Math.max(0, remainingMonthlyUsd).toFixed(2)} left).`);
  }

  return {
    allowed: true,
    reason: `Within budget — $${round2(monthlySpent + request.amountUsd).toFixed(2)} of $${config.monthlyBudgetUsd.toFixed(2)} used this month after this action.`,
    remainingMonthlyUsd: round2(remainingMonthlyUsd - request.amountUsd),
    remainingDailyUsd: remainingDailyUsd === null ? null : round2(remainingDailyUsd - request.amountUsd),
  };
}

/** Append-only JSONL, same idiom as `autonomy.ts`'s `recordAutonomyAudit` —
 * called unconditionally by a caller, allowed AND denied requests both get
 * written, so the ledger is a complete record regardless of outcome.
 *
 * Idempotent on `request.id`, same guarantee as `evaluateSpend` — a caller
 * that retries `evaluateSpend` + `recordSpend` after a crash (Open Question
 * 6 in the plan doc) must not be able to double-write the ledger just
 * because it double-called this function; a real bug caught by this
 * module's own fuzz suite before it shipped, not assumed away. */
export function recordSpend(ledgerFile: string, request: SpendRequest, decision: SpendDecision): void {
  if (loadSpendLedger(ledgerFile).some((e) => e.request.id === request.id)) return;
  const entry: SpendLedgerEntry = { timestamp: new Date().toISOString(), request, decision };
  appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`);
}

export function loadSpendLedger(ledgerFile: string): SpendLedgerEntry[] {
  if (!existsSync(ledgerFile)) return [];
  const lines = readFileSync(ledgerFile, "utf-8").trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as SpendLedgerEntry);
}

/** Plain-language rendering, matching `owner-feed.ts`/`autonomy-config.ts`'s
 * no-jargon style — this is the one summary this whole system leans on most
 * heavily for transparency, since zero-approval spend only stays defensible
 * if "how much, on what" is trivially readable. */
export function renderBudgetSummary(config: BudgetConfig, ledger: SpendLedgerEntry[]): string {
  const bounds = periodBounds(config.periodStart);
  const inCurrentPeriod = dedupedAllowed(ledger).filter((e) => inPeriod(e.request.requestedAt, bounds));
  const spent = sumAmounts(inCurrentPeriod);
  const pct = config.monthlyBudgetUsd > 0 ? Math.round((spent / config.monthlyBudgetUsd) * 100) : 0;

  const lines: string[] = [`$${spent.toFixed(2)} of $${config.monthlyBudgetUsd.toFixed(2)} used this month (${pct}%).`];
  if (config.killSwitch) {
    lines.push("Kill switch is ON — all growth spend is paused.");
  }

  const byCategory = new Map<string, number>();
  for (const e of inCurrentPeriod) {
    byCategory.set(e.request.category, (byCategory.get(e.request.category) ?? 0) + e.request.amountUsd);
  }
  if (byCategory.size > 0) {
    lines.push("");
    for (const [category, amount] of byCategory) {
      lines.push(`  - ${category}: $${round2(amount).toFixed(2)}`);
    }
  }
  return lines.join("\n");
}
