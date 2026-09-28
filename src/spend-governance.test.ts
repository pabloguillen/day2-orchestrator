import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateSpend,
  loadSpendLedger,
  recordSpend,
  renderBudgetSummary,
  type BudgetConfig,
  type SpendCategory,
  type SpendDecision,
  type SpendLedgerEntry,
  type SpendRequest,
} from "./spend-governance";

const baseConfig: BudgetConfig = {
  monthlyBudgetUsd: 200,
  periodStart: "2026-09-01T00:00:00.000Z",
  killSwitch: false,
};

const CATEGORIES: SpendCategory[] = [
  "creative_generation",
  "seo_content",
  "aso",
  "paid_ads",
  "social_content",
  "direct_outreach",
  "website",
];

function req(overrides: Partial<SpendRequest>): SpendRequest {
  return {
    id: overrides.id ?? `req-${Math.random()}`,
    category: "social_content",
    amountUsd: 10,
    description: "test spend",
    requestedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

/** Applies a request against a growing ledger, exactly like a real caller
 * (evaluateSpend then unconditionally record the decision) — used by every
 * multi-request test below so the ledger accumulates real state. */
function apply(ledger: SpendLedgerEntry[], config: BudgetConfig, request: SpendRequest): SpendDecision {
  const decision = evaluateSpend(request, config, ledger);
  ledger.push({ timestamp: new Date().toISOString(), request, decision });
  return decision;
}

describe("evaluateSpend", () => {
  test("allows a request within budget", () => {
    const decision = evaluateSpend(req({}), baseConfig, []);
    expect(decision.allowed).toBe(true);
  });

  test("kill switch denies unconditionally, even a trivially small request", () => {
    const decision = evaluateSpend(req({ amountUsd: 1 }), { ...baseConfig, killSwitch: true }, []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/kill switch/i);
  });

  test("non-positive amount is denied", () => {
    expect(evaluateSpend(req({ amountUsd: 0 }), baseConfig, []).allowed).toBe(false);
    expect(evaluateSpend(req({ amountUsd: -5 }), baseConfig, []).allowed).toBe(false);
  });

  test("per-action cap: denies a single action over $50 even with huge remaining budget", () => {
    const config: BudgetConfig = { ...baseConfig, monthlyBudgetUsd: 10_000 };
    const decision = evaluateSpend(req({ amountUsd: 51 }), config, []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/per-action cap/i);
  });

  test("per-action cap: denies a single action over 20% of a small remaining budget, below $50", () => {
    const config: BudgetConfig = { ...baseConfig, monthlyBudgetUsd: 100 };
    // 20% of $100 remaining = $20, below the $50 ceiling — $21 should be denied.
    const decision = evaluateSpend(req({ amountUsd: 21 }), config, []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/per-action cap/i);
  });

  test("explicit perActionCapUsd overrides the computed default", () => {
    const config: BudgetConfig = { ...baseConfig, perActionCapUsd: 5 };
    expect(evaluateSpend(req({ amountUsd: 6 }), config, []).allowed).toBe(false);
    expect(evaluateSpend(req({ amountUsd: 5 }), config, []).allowed).toBe(true);
  });

  test("idempotent replay: the same request id returns the original decision unchanged, even if the kill switch flips after", () => {
    const ledger: SpendLedgerEntry[] = [];
    const original = apply(ledger, baseConfig, req({ id: "same-id", amountUsd: 10 }));
    expect(original.allowed).toBe(true);

    // Kill switch turns on after the fact — a naive re-evaluation would now deny it.
    const replay = evaluateSpend(req({ id: "same-id", amountUsd: 10 }), { ...baseConfig, killSwitch: true }, ledger);
    expect(replay).toEqual(original);
  });

  test("idempotent replay does not double-count spend", () => {
    const config: BudgetConfig = { ...baseConfig, perActionCapUsd: 1000 };
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, config, req({ id: "dup", amountUsd: 190 }));
    apply(ledger, config, req({ id: "dup", amountUsd: 190 })); // same id, replayed
    const summary = renderBudgetSummary(config, ledger);
    expect(summary).toContain("$190.00 of $200.00");
  });

  test("exploration ceiling: caps under-observed-arm spend within a category independent of the category's own cap", () => {
    const config: BudgetConfig = {
      ...baseConfig,
      monthlyBudgetUsd: 1000,
      perCategoryCapUsd: { social_content: 100 },
      explorationCapFraction: 0.3, // 30% of 100 = $30
    };
    const ledger: SpendLedgerEntry[] = [];
    const first = apply(
      ledger,
      config,
      req({ id: "e1", category: "social_content", amountUsd: 25, isExploration: true }),
    );
    expect(first.allowed).toBe(true);
    const second = evaluateSpend(
      req({ id: "e2", category: "social_content", amountUsd: 10, isExploration: true }),
      config,
      ledger,
    );
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/exploration/i);
  });

  test("exploration ceiling does not apply to non-exploration requests", () => {
    const config: BudgetConfig = {
      ...baseConfig,
      monthlyBudgetUsd: 1000,
      perCategoryCapUsd: { social_content: 100 },
      explorationCapFraction: 0.1, // 10% of 100 = $10
    };
    // A non-exploration $50 request should only be bounded by the category cap, not the exploration ceiling.
    const decision = evaluateSpend(req({ category: "social_content", amountUsd: 50 }), config, []);
    expect(decision.allowed).toBe(true);
  });

  test("daily cap denies once the day's spend would be exceeded, independent of monthly headroom", () => {
    const config: BudgetConfig = { ...baseConfig, monthlyBudgetUsd: 10_000, dailyCapUsd: 40 };
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, config, req({ id: "d1", amountUsd: 30, requestedAt: "2026-09-05T08:00:00.000Z" }));
    const denied = evaluateSpend(
      req({ id: "d2", amountUsd: 15, requestedAt: "2026-09-05T20:00:00.000Z" }),
      config,
      ledger,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/daily cap/i);

    // Different day — resets.
    const nextDay = evaluateSpend(
      req({ id: "d3", amountUsd: 15, requestedAt: "2026-09-06T08:00:00.000Z" }),
      config,
      ledger,
    );
    expect(nextDay.allowed).toBe(true);
  });

  test("per-category cap denies once that category's spend would be exceeded, other categories unaffected", () => {
    const config: BudgetConfig = {
      ...baseConfig,
      monthlyBudgetUsd: 10_000,
      perCategoryCapUsd: { paid_ads: 20 },
    };
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, config, req({ id: "c1", category: "paid_ads", amountUsd: 20 }));
    const deniedSameCategory = evaluateSpend(req({ id: "c2", category: "paid_ads", amountUsd: 1 }), config, ledger);
    expect(deniedSameCategory.allowed).toBe(false);
    expect(deniedSameCategory.reason).toMatch(/category cap/i);

    const otherCategory = evaluateSpend(req({ id: "c3", category: "seo_content", amountUsd: 1 }), config, ledger);
    expect(otherCategory.allowed).toBe(true);
  });

  test("monthly total denies once the whole budget would be exceeded", () => {
    const config: BudgetConfig = { ...baseConfig, monthlyBudgetUsd: 50, perActionCapUsd: 1000 };
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, config, req({ id: "m1", amountUsd: 49 }));
    const denied = evaluateSpend(req({ id: "m2", amountUsd: 2 }), config, ledger);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/monthly budget/i);
  });

  test("spend outside the current period doesn't count against this month's cap", () => {
    const config: BudgetConfig = {
      ...baseConfig,
      monthlyBudgetUsd: 50,
      periodStart: "2026-09-01T00:00:00.000Z",
      perActionCapUsd: 1000,
    };
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, config, req({ id: "prev", amountUsd: 49, requestedAt: "2026-08-15T00:00:00.000Z" }));
    const decision = evaluateSpend(req({ id: "curr", amountUsd: 49, requestedAt: "2026-09-15T00:00:00.000Z" }), config, ledger);
    expect(decision.allowed).toBe(true);
  });

  test("denied requests never count toward any cap", () => {
    const config: BudgetConfig = { ...baseConfig, monthlyBudgetUsd: 20, perActionCapUsd: 1000 };
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, config, req({ id: "big", amountUsd: 21 })); // denied, over budget
    const decision = evaluateSpend(req({ id: "small", amountUsd: 20 }), config, ledger);
    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateSpend — property-based fuzz suite (source spec's own red-team bar: zero allowed breaches)", () => {
  // Deterministic, seeded PRNG (mulberry32) rather than Math.random() — a
  // failure here needs to be reproducible, not a one-off flake.
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

  test("sum of allowed spend never exceeds monthlyBudgetUsd, across many random scenarios", () => {
    for (let scenario = 0; scenario < 200; scenario++) {
      const rng = mulberry32(scenario * 7919 + 13);
      const monthlyBudgetUsd = 10 + rng() * 990;
      const config: BudgetConfig = {
        monthlyBudgetUsd,
        periodStart: "2026-09-01T00:00:00.000Z",
        killSwitch: false,
        dailyCapUsd: rng() < 0.5 ? undefined : 5 + rng() * 200,
        perCategoryCapUsd:
          rng() < 0.5
            ? undefined
            : CATEGORIES.reduce<Partial<Record<SpendCategory, number>>>((acc, c) => {
                if (rng() < 0.4) acc[c] = 5 + rng() * 150;
                return acc;
              }, {}),
        explorationCapFraction: rng() < 0.5 ? undefined : rng(),
      };

      const ledger: SpendLedgerEntry[] = [];
      const day = 1 + Math.floor(rng() * 27);
      for (let i = 0; i < 150; i++) {
        const requestedAt = `2026-09-${String(1 + Math.floor(rng() * 27)).padStart(2, "0")}T${String(
          Math.floor(rng() * 24),
        ).padStart(2, "0")}:00:00.000Z`;
        const request: SpendRequest = {
          id: `s${scenario}-${i}`,
          category: CATEGORIES[Math.floor(rng() * CATEGORIES.length)]!,
          amountUsd: rng() * 120 - 10, // occasionally non-positive, on purpose
          description: "fuzz",
          requestedAt,
          isExploration: rng() < 0.3,
        };
        apply(ledger, config, request);
      }
      // Occasionally replay an already-seen id to fuzz the idempotency path too.
      if (day % 2 === 0 && ledger.length > 0) {
        const replayed = ledger[Math.floor(rng() * ledger.length)]!.request;
        apply(ledger, config, replayed);
      }

      const totalAllowed = ledger
        .filter((e) => e.decision.allowed)
        .reduce((acc, e) => acc + e.request.amountUsd, 0);
      expect(totalAllowed).toBeLessThanOrEqual(config.monthlyBudgetUsd + 1e-9);
    }
  });

  test("kill switch: zero requests are ever allowed while it's on, across many random scenarios", () => {
    for (let scenario = 0; scenario < 50; scenario++) {
      const rng = mulberry32(scenario * 104729 + 1);
      const config: BudgetConfig = {
        monthlyBudgetUsd: 10 + rng() * 990,
        periodStart: "2026-09-01T00:00:00.000Z",
        killSwitch: true,
      };
      const ledger: SpendLedgerEntry[] = [];
      for (let i = 0; i < 30; i++) {
        const decision = apply(
          ledger,
          config,
          req({ id: `k${scenario}-${i}`, amountUsd: rng() * 40, category: CATEGORIES[i % CATEGORIES.length]! }),
        );
        expect(decision.allowed).toBe(false);
      }
    }
  });
});

describe("recordSpend / loadSpendLedger", () => {
  test("appends one JSON line per call, round-trips correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-spend-"));
    const ledgerFile = join(dir, "ledger.jsonl");
    try {
      const decisionA = evaluateSpend(req({ id: "a" }), baseConfig, []);
      recordSpend(ledgerFile, req({ id: "a" }), decisionA);
      const afterA = loadSpendLedger(ledgerFile);
      const decisionB = evaluateSpend(req({ id: "b" }), baseConfig, afterA);
      recordSpend(ledgerFile, req({ id: "b" }), decisionB);

      expect(existsSync(ledgerFile)).toBe(true);
      const entries = loadSpendLedger(ledgerFile);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.request.id).toBe("a");
      expect(entries[1]!.request.id).toBe("b");
      const raw = readFileSync(ledgerFile, "utf-8").trim().split("\n");
      expect(raw).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadSpendLedger returns [] for a nonexistent file", () => {
    expect(loadSpendLedger("/tmp/does-not-exist-day2-spend-ledger.jsonl")).toEqual([]);
  });
});

describe("renderBudgetSummary", () => {
  test("shows real spend and percentage, broken down by category", () => {
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, baseConfig, req({ id: "r1", category: "seo_content", amountUsd: 30 }));
    apply(ledger, baseConfig, req({ id: "r2", category: "social_content", amountUsd: 20 }));
    const summary = renderBudgetSummary(baseConfig, ledger);
    expect(summary).toContain("$50.00 of $200.00 used this month (25%)");
    expect(summary).toContain("seo_content: $30.00");
    expect(summary).toContain("social_content: $20.00");
  });

  test("flags the kill switch prominently when on", () => {
    const summary = renderBudgetSummary({ ...baseConfig, killSwitch: true }, []);
    expect(summary).toMatch(/kill switch is on/i);
  });

  test("denied requests are excluded from the summary", () => {
    const config: BudgetConfig = { ...baseConfig, monthlyBudgetUsd: 10, perActionCapUsd: 1000 };
    const ledger: SpendLedgerEntry[] = [];
    apply(ledger, config, req({ id: "ok", amountUsd: 5 }));
    apply(ledger, config, req({ id: "denied", amountUsd: 50 }));
    const summary = renderBudgetSummary(config, ledger);
    expect(summary).toContain("$5.00 of $10.00");
  });
});
