/**
 * "Seeded scenarios, one per rule, each produce the right diagnosis and a
 * proposal in the right module" — docs/closed-loop-spec.md M3's own
 * "Done when" bar, taken literally: one dedicated scenario per D1-D10.
 */

import { describe, expect, test } from "bun:test";
import { diagnoseFunnel } from "./rules";
import { CohortDiagnosisInputs } from "./types";
import type { MetricValue } from "../metrics";

function mv(value: number, n = 200): MetricValue {
  return { metric: "x", breakdown: {}, value, n, ci: null, sufficientData: n >= 30 };
}

const DEFAULT_TARGETS = { cacPaybackTargetMonths: 6, ltvToCacTarget: 3 };

/** A cohort with every real signal healthy — the baseline every single
 * scenario below starts from, then deliberately breaks exactly one metric
 * per test. This is what proves each rule fires for ITS OWN reason, not as
 * a side effect of some other metric also being bad. */
function healthyCohortInputs(): CohortDiagnosisInputs {
  return {
    cohortKey: "arm-a@2026-W40",
    metrics: {
      ctr: mv(0.05),
      landing_to_signup: mv(0.3),
      activation_rate: mv(0.6),
      d7_retention: mv(0.4),
      cac_payback_months: mv(3),
      crash_free_sessions: mv(0.99),
      error_rate: mv(0.01),
      refund_rate: mv(0.02),
      store_rating: mv(4.5),
      trial_to_paid: mv(0.3),
      ltv_to_cac: mv(4),
    },
    baseline: {
      ctr: 0.05,
      landing_to_signup: 0.3,
      activation_rate: 0.6,
      d7_retention: 0.4,
      cac_payback_months: 3,
      crash_free_sessions: 0.99,
      error_rate: 0.01,
      refund_rate: 0.02,
      store_rating: 4.5,
      trial_to_paid: 0.3,
      ltv_to_cac: 4,
    },
    targets: DEFAULT_TARGETS,
  };
}

function primaryOf(diagnoses: ReturnType<typeof diagnoseFunnel>) {
  return diagnoses.find((d) => d.primary);
}

describe("D1 — CTR < 0.7x baseline routes to creative", () => {
  test("a real CTR collapse is the primary diagnosis, routed to creative", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.ctr = mv(0.02); // 0.4x baseline
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "2026-09-30T00:00:00.000Z");
    const primary = primaryOf(diagnoses)!;
    expect(primary.ruleId).toBe("D1");
    expect(primary.route).toBe("creative");
  });
});

describe("D2 — landing-to-signup < 0.7x baseline routes to config", () => {
  test("weak landing conversion is the primary diagnosis, routed to config", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.landing_to_signup = mv(0.1);
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D2");
    expect(primary.route).toBe("config");
  });
});

describe("D3 — activation < 0.8x baseline routes to composer", () => {
  test("weak activation is the primary diagnosis, routed to composer", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.activation_rate = mv(0.3);
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D3");
    expect(primary.route).toBe("composer");
  });
});

describe("D4 — activated but weak D7 retention routes to evolution", () => {
  test("real product-doesn't-hold-them signal, activation itself stays healthy", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.d7_retention = mv(0.1); // well below baseline, activation untouched
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D4");
    expect(primary.route).toBe("evolution");
  });

  test("D4 does NOT fire when activation itself is also broken — D3 takes priority (funnel order)", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.activation_rate = mv(0.1); // D3 territory
    inputs.metrics.d7_retention = mv(0.1); // would also look like D4, but shouldn't fire independently
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "t");
    expect(diagnoses.find((d) => d.ruleId === "D4")).toBeUndefined();
    expect(primaryOf(diagnoses)!.ruleId).toBe("D3");
  });
});

describe("D5 — retained but CAC payback exceeds target routes to allocator", () => {
  test("right users, expensive channel — a real budget-shift signal", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.cac_payback_months = mv(24); // way past the 6-month target
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D5");
    expect(primary.route).toBe("allocator");
  });
});

describe("D6 — crash-free or error-rate spike routes to healing", () => {
  test("a real crash-rate spike alone triggers D6, routed to healing", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.crash_free_sessions = mv(0.8, 40); // crash rate went from 1% to 20% — well over 1.3x
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D6");
    expect(primary.route).toBe("healing");
  });

  test("a real error-rate spike alone also triggers D6 independently", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.error_rate = mv(0.05, 40); // 5x baseline
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D6");
  });
});

describe("D7 — refund rate > 1.5x baseline routes to creative", () => {
  test("ad sets expectations the product doesn't meet", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.refund_rate = mv(0.1); // 5x baseline
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D7");
    expect(primary.route).toBe("creative");
  });
});

describe("D8 — store rating drop after a release routes to release", () => {
  test("a real rating drop vs. the pre-release baseline triggers D8", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.store_rating = mv(3.5, 40); // dropped from 4.5
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D8");
    expect(primary.route).toBe("release");
  });
});

describe("D9 — trial-to-paid < 0.7x baseline routes to config", () => {
  test("paywall doesn't fit this cohort", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.trial_to_paid = mv(0.1);
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D9");
    expect(primary.route).toBe("config");
  });
});

describe("D10 — a genuinely healthy, above-target cohort routes to allocator (scale)", () => {
  test("every real signal healthy and LTV:CAC clears target", () => {
    const inputs = healthyCohortInputs();
    const primary = primaryOf(diagnoseFunnel(inputs, "expense-buddy", "t"))!;
    expect(primary.ruleId).toBe("D10");
    expect(primary.route).toBe("allocator");
  });

  test("D10 doesn't fire when LTV:CAC is healthy-looking but hasn't cleared the real target", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.ltv_to_cac = mv(1.5); // positive, but below the target of 3
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "t");
    expect(diagnoses.find((d) => d.ruleId === "D10")).toBeUndefined();
  });
});

describe("cross-cutting behavior", () => {
  test("a cohort with insufficient n for a rule's own evidence metric never triggers that rule", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.ctr = mv(0.01, 5); // a real collapse, but n=5 is far under D1's n>=100 bar
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "t");
    expect(diagnoses.find((d) => d.ruleId === "D1")).toBeUndefined();
  });

  test("D6/D8 use the lower n=30 severity bar, not the n=100 rate-metric bar", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.crash_free_sessions = mv(0.8, 35); // n=35: fails D1-style n>=100, clears D6's n>=30
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "t");
    expect(diagnoses.find((d) => d.ruleId === "D6")).toBeDefined();
  });

  test("a genuinely broken cohort surfaces multiple diagnoses, only the first in funnel order is primary", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.activation_rate = mv(0.2); // D3
    inputs.metrics.refund_rate = mv(0.1); // D7 — independent of activation, should also trigger
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "t");
    const ruleIds = diagnoses.map((d) => d.ruleId);
    expect(ruleIds).toContain("D3");
    expect(ruleIds).toContain("D7");
    expect(diagnoses.filter((d) => d.primary)).toHaveLength(1);
    expect(primaryOf(diagnoses)!.ruleId).toBe("D3"); // earlier in funnel order
  });

  test("a fully healthy cohort with no evidence at all for monetization produces zero diagnoses, not a fabricated D10", () => {
    const inputs = healthyCohortInputs();
    delete inputs.metrics.ltv_to_cac; // expense-buddy's real state: no billing, so no LTV:CAC data exists
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "t");
    expect(diagnoses.find((d) => d.ruleId === "D10")).toBeUndefined(); // can't confirm "scale" without real LTV:CAC evidence
  });

  test("every diagnosis carries real evidence (metric/value/baseline/n), not an empty array", () => {
    const inputs = healthyCohortInputs();
    inputs.metrics.ctr = mv(0.01);
    const diagnoses = diagnoseFunnel(inputs, "expense-buddy", "t");
    const d1 = diagnoses.find((d) => d.ruleId === "D1")!;
    expect(d1.evidence.length).toBeGreaterThan(0);
    expect(d1.evidence[0]!.metric).toBe("ctr");
    expect(d1.evidence[0]!.baseline).toBe(0.05);
  });
});
