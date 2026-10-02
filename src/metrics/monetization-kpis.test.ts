import { describe, expect, test } from "bun:test";
import {
  computeArppu,
  computeArpu,
  computeCacPaybackMonths,
  computeLtvToCac,
  computeMrr,
  computeRefundRate,
  computeTrialToPaid,
} from "./monetization-kpis";
import type { PaymentIngestRow } from "../external-ingest";
import { EventLike } from "./types";

const paymentRows: PaymentIngestRow[] = [
  { date: "2026-09-01", revenueUsd: 10, refundsUsd: 0, chargebacksUsd: 0, deviceOrUserId: "d1" },
  { date: "2026-09-02", revenueUsd: 10, refundsUsd: 0, chargebacksUsd: 0, deviceOrUserId: "d1" }, // d1 pays twice
  { date: "2026-09-03", revenueUsd: 20, refundsUsd: 0, chargebacksUsd: 0, deviceOrUserId: "d2" },
];

describe("computeTrialToPaid", () => {
  test("real subscription_started / trial_started ratio", () => {
    const events: EventLike[] = [
      { type: "trial_started", at: "t0", deviceId: "d1" },
      { type: "subscription_started", at: "t1", deviceId: "d1" },
      { type: "trial_started", at: "t0", deviceId: "d2" },
    ];
    const [result] = computeTrialToPaid(events);
    expect(result!.value).toBeCloseTo(0.5, 5);
  });

  test("expense-buddy's real state: no trial_started events anywhere reports null, not zero", () => {
    const events: EventLike[] = [{ type: "session_start", at: "t0", deviceId: "d1" }];
    const [result] = computeTrialToPaid(events);
    expect(result!.value).toBeNull();
  });
});

describe("computeArpu / computeArppu / computeMrr", () => {
  test("ARPU divides total revenue by a caller-supplied active-user count", () => {
    const result = computeArpu(paymentRows, 10); // $40 total / 10 active users
    expect(result.value).toBeCloseTo(4, 5);
  });

  test("ARPPU divides total revenue by real distinct paying users (not payment count)", () => {
    const result = computeArppu(paymentRows); // $40 / 2 distinct payers (d1 paid twice, counts once)
    expect(result.value).toBeCloseTo(20, 5);
    expect(result.n).toBe(2);
  });

  test("MRR sums the real revenue in the given rows", () => {
    const result = computeMrr(paymentRows);
    expect(result.value).toBe(40);
  });

  test("zero revenue rows with real active users is a real, meaningful $0 ARPU, not null", () => {
    // 10 real active users generated zero revenue — a genuine known zero,
    // different from "we don't know" (no active-user count supplied at all).
    expect(computeArpu([], 10).value).toBe(0);
  });

  test("zero active users (nothing to divide by) reports null, not a fabricated zero", () => {
    expect(computeArpu([], 0).value).toBeNull();
  });

  test("zero payment rows reports null for ARPPU/MRR (no payers/revenue exist to report on at all)", () => {
    expect(computeArppu([]).value).toBeNull();
    expect(computeMrr([]).value).toBeNull();
  });
});

describe("computeRefundRate", () => {
  test("real refunds / payments ratio", () => {
    const rows: PaymentIngestRow[] = [
      { date: "d", revenueUsd: 10, refundsUsd: 0, chargebacksUsd: 0 },
      { date: "d", revenueUsd: 10, refundsUsd: 10, chargebacksUsd: 0 }, // this payment was refunded
    ];
    const result = computeRefundRate(rows);
    expect(result.value).toBeCloseTo(0.5, 5);
  });
});

describe("computeLtvToCac / computeCacPaybackMonths", () => {
  test("LTV:CAC is a real ratio, null when either input is missing", () => {
    expect(computeLtvToCac(300, 100, 50).value).toBeCloseTo(3, 5);
    expect(computeLtvToCac(null, 100, 50).value).toBeNull();
    expect(computeLtvToCac(300, 0, 50).value).toBeNull(); // zero CAC would be a division by zero
  });

  test("CAC payback months is CAC / monthly ARPU", () => {
    const result = computeCacPaybackMonths(100, 25, 50);
    expect(result.value).toBeCloseTo(4, 5);
  });
});
