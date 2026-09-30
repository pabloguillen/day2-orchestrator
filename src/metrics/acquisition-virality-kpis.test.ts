import { describe, expect, test } from "bun:test";
import {
  computeCacBlended,
  computeCacPaid,
  computeCpc,
  computeCpi,
  computeCtr,
  computeKFactor,
  computeLandingToSignup,
  computeOrganicShare,
  computeReferralRate,
} from "./acquisition-virality-kpis";
import type { SpendIngestRow } from "../external-ingest";
import { EventLike } from "./types";

const spendRows: SpendIngestRow[] = [
  { armId: "arm-a", date: "2026-09-01", spendUsd: 100, impressions: 1000, clicks: 50, installs: 10 },
  { armId: "arm-a", date: "2026-09-02", spendUsd: 100, impressions: 1000, clicks: 50 },
];

describe("computeCtr / computeCpc / computeCpi", () => {
  test("CTR sums clicks/impressions across rows for the same arm", () => {
    const [result] = computeCtr(spendRows);
    expect(result!.value).toBeCloseTo(100 / 2000, 5);
    expect(result!.n).toBe(2000);
  });

  test("CPC is total spend / total clicks", () => {
    const [result] = computeCpc(spendRows);
    expect(result!.value).toBeCloseTo(200 / 100, 5);
  });

  test("CPI uses summed real installs when the ingest row carries them", () => {
    const [result] = computeCpi(spendRows, []);
    expect(result!.value).toBeCloseTo(200 / 10, 5); // only row 1 has installs=10
  });

  test("CPI falls back to real acquisition_landing event count (web) when no installs in the ingest rows", () => {
    const webRows: SpendIngestRow[] = [{ armId: "arm-b", date: "2026-09-01", spendUsd: 50, impressions: 500, clicks: 20 }];
    const landingEvents: EventLike[] = [
      { type: "acquisition_landing", at: "t0", deviceId: "d1", acquisition: { channel: "seo", armKey: "arm-b" } },
      { type: "acquisition_landing", at: "t0", deviceId: "d2", acquisition: { channel: "seo", armKey: "arm-b" } },
    ];
    const [result] = computeCpi(webRows, landingEvents);
    expect(result!.value).toBeCloseTo(50 / 2, 5);
  });

  test("an arm with zero denominator reports null rather than Infinity/NaN", () => {
    const [result] = computeCpi([{ armId: "arm-c", date: "2026-09-01", spendUsd: 10, impressions: 0, clicks: 0 }], []);
    expect(result!.value).toBeNull();
  });
});

describe("computeLandingToSignup", () => {
  test("signups / acquisition_landing, per arm", () => {
    const events: EventLike[] = [
      { type: "acquisition_landing", at: "t0", deviceId: "d1", acquisition: { channel: "paid_social", armKey: "arm-a" } },
      { type: "signup", at: "t1", deviceId: "d1" },
      { type: "acquisition_landing", at: "t0", deviceId: "d2", acquisition: { channel: "paid_social", armKey: "arm-a" } },
    ];
    const [result] = computeLandingToSignup(events, "arm");
    expect(result!.value).toBeCloseTo(0.5, 5);
    expect(result!.n).toBe(2);
  });
});

describe("computeCacPaid / computeCacBlended", () => {
  const events: EventLike[] = [
    { type: "acquisition_landing", at: "t0", deviceId: "d1", acquisition: { channel: "paid_social", armKey: "arm-a" } },
    { type: "acquisition_landing", at: "t0", deviceId: "d2", acquisition: { channel: "paid_social", armKey: "arm-a" } },
    { type: "acquisition_landing", at: "t0", deviceId: "d3", acquisition: { channel: "seo", armKey: "arm-organic" } },
  ];

  test("CAC (paid) only counts spend and users from paid-channel arms", () => {
    const result = computeCacPaid(spendRows, events); // arm-a is paid_social in `events`, $200 total spend, 2 real devices
    expect(result.value).toBeCloseTo(200 / 2, 5);
  });

  test("CAC (blended) divides all spend by all new users regardless of channel", () => {
    const result = computeCacBlended(spendRows, events); // $200 / 3 devices (arm-a has no spend row for arm-organic, but blended still counts all users)
    expect(result.value).toBeCloseTo(200 / 3, 5);
  });
});

describe("computeOrganicShare", () => {
  test("real ratio of organic-channel new users to all new users", () => {
    const events: EventLike[] = [
      { type: "acquisition_landing", at: "t0", deviceId: "d1", acquisition: { channel: "paid_social" } },
      { type: "acquisition_landing", at: "t0", deviceId: "d2", acquisition: { channel: "seo" } },
      { type: "acquisition_landing", at: "t0", deviceId: "d3", acquisition: { channel: "direct" } },
    ];
    const result = computeOrganicShare(events);
    expect(result.value).toBeCloseTo(2 / 3, 5);
  });
});

describe("virality", () => {
  test("referral rate counts real referral_shared events among all devices", () => {
    const events: EventLike[] = [
      { type: "session_start", at: "t0", deviceId: "d1" },
      { type: "referral_shared", at: "t1", deviceId: "d1" },
      { type: "session_start", at: "t0", deviceId: "d2" },
    ];
    const [result] = computeReferralRate(events);
    expect(result!.value).toBeCloseTo(0.5, 5);
  });

  test("K-factor is invites-per-user times real acceptance rate", () => {
    const events: EventLike[] = [
      { type: "invite_sent", at: "t0", deviceId: "d1" },
      { type: "invite_sent", at: "t0", deviceId: "d1" },
      { type: "invite_accepted", at: "t1", deviceId: "d1" },
      { type: "session_start", at: "t0", deviceId: "d2" }, // no invites — dilutes invites-per-user
    ];
    const result = computeKFactor(events);
    // 2 devices total, 2 invites sent -> 1 invite/user; 1 of 2 invites accepted -> 0.5 acceptance
    expect(result.value).toBeCloseTo(1 * 0.5, 5);
  });

  test("K-factor with zero invites anywhere is 0, not null (a real, measured zero)", () => {
    const events: EventLike[] = [{ type: "session_start", at: "t0", deviceId: "d1" }];
    const result = computeKFactor(events);
    expect(result.value).toBe(0);
  });
});
