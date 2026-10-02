import { describe, expect, test } from "bun:test";
import {
  computeCrashFreeSessions,
  computeErrorRate,
  computeEscapedDefects,
  computeMeanTimeToFixHours,
  computeP95,
  computeRageClicksPerSession,
  computeReviewSentiment,
  computeStoreRating,
  computeTicketsPerActiveUser,
  type IncidentRecord,
  type ReviewRow,
} from "./quality-satisfaction-kpis";
import { EventLike } from "./types";

describe("computeCrashFreeSessions / computeErrorRate / computeRageClicksPerSession", () => {
  const events: EventLike[] = [
    { type: "session_start", at: "t0", deviceId: "d1", sessionId: "s1" },
    { type: "crash", at: "t1", deviceId: "d1", sessionId: "s1" },
    { type: "session_start", at: "t0", deviceId: "d1", sessionId: "s2" },
    { type: "error", at: "t1", deviceId: "d1", sessionId: "s2" },
    { type: "session_start", at: "t0", deviceId: "d2", sessionId: "s3" }, // clean session
  ];

  test("crash-free sessions is real (sessions without a crash) / (real sessions)", () => {
    const result = computeCrashFreeSessions(events);
    expect(result.value).toBeCloseTo(2 / 3, 5); // s1 crashed, s2/s3 didn't
    expect(result.n).toBe(3);
  });

  test("error rate counts real error events per real session", () => {
    const result = computeErrorRate(events);
    expect(result.value).toBeCloseTo(1 / 3, 5);
  });

  test("events with no sessionId (pre-M1) are excluded from session-grained metrics, not silently miscounted", () => {
    const noSessionEvents: EventLike[] = [{ type: "crash", at: "t0", deviceId: "d1" }];
    const result = computeCrashFreeSessions(noSessionEvents);
    expect(result.n).toBe(0);
    expect(result.value).toBeNull();
  });

  test("rage clicks per session over real events", () => {
    const rageEvents: EventLike[] = [
      { type: "session_start", at: "t0", deviceId: "d1", sessionId: "s1" },
      { type: "rage_click", at: "t1", deviceId: "d1", sessionId: "s1" },
      { type: "rage_click", at: "t2", deviceId: "d1", sessionId: "s1" },
      { type: "session_start", at: "t0", deviceId: "d2", sessionId: "s2" },
    ];
    const result = computeRageClicksPerSession(rageEvents);
    expect(result.value).toBeCloseTo(1, 5); // 2 rage clicks / 2 sessions
  });
});

describe("computeP95", () => {
  test("real nearest-rank p95 over perf_sample metadata values", () => {
    const events: EventLike[] = Array.from({ length: 20 }, (_, i) => ({
      type: "perf_sample",
      at: "t0",
      deviceId: `d${i}`,
      metadata: { metric: "load_time_ms", value: (i + 1) * 100 }, // 100..2000
    }));
    const result = computeP95(events, "load_time_ms");
    expect(result.value).toBe(1900); // 19th of 20 sorted values (nearest-rank)
    expect(result.n).toBe(20);
  });

  test("a different metric name doesn't pollute another metric's samples", () => {
    const events: EventLike[] = [
      { type: "perf_sample", at: "t0", deviceId: "d1", metadata: { metric: "api_response_ms", value: 9999 } },
    ];
    const result = computeP95(events, "load_time_ms");
    expect(result.value).toBeNull();
  });
});

describe("computeEscapedDefects / computeMeanTimeToFixHours", () => {
  const incidents: IncidentRecord[] = [
    { detectedAt: "2026-09-01T00:00:00.000Z", fixedLiveAt: "2026-09-01T04:00:00.000Z", caughtByGate: false }, // escaped, 4h fix
    { detectedAt: "2026-09-02T00:00:00.000Z", fixedLiveAt: "2026-09-02T02:00:00.000Z", caughtByGate: true }, // caught by a gate
    { detectedAt: "2026-09-03T00:00:00.000Z", fixedLiveAt: null, caughtByGate: false }, // escaped, still open
  ];

  test("escaped defects is real (not caught by a gate) / total incidents", () => {
    const result = computeEscapedDefects(incidents);
    expect(result.value).toBeCloseTo(2 / 3, 5);
  });

  test("mean time to fix only averages over incidents with a real fix time, excludes still-open ones", () => {
    const result = computeMeanTimeToFixHours(incidents);
    expect(result.value).toBeCloseTo(3, 5); // mean of [4h, 2h]
    expect(result.n).toBe(2); // the still-open incident is excluded, not treated as 0h
  });
});

describe("computeStoreRating / computeReviewSentiment", () => {
  const asOf = "2026-09-30T00:00:00.000Z";
  const reviews: ReviewRow[] = [
    { at: "2026-09-25T00:00:00.000Z", rating: 5 },
    { at: "2026-09-26T00:00:00.000Z", rating: 1 }, // negative
    { at: "2026-01-01T00:00:00.000Z", rating: 1 }, // outside the 30-day window — excluded
  ];

  test("real rolling average within the window, excludes stale reviews", () => {
    const result = computeStoreRating(reviews, asOf);
    expect(result.value).toBeCloseTo(3, 5); // mean of [5, 1], not all 3
    expect(result.n).toBe(2);
  });

  test("real negative-share sentiment (rating <= 2) within the window", () => {
    const result = computeReviewSentiment(reviews, asOf);
    expect(result.value).toBeCloseTo(0.5, 5);
  });
});

describe("computeTicketsPerActiveUser", () => {
  test("real ticket count / active users", () => {
    const result = computeTicketsPerActiveUser([{ at: "t0" }, { at: "t1" }], 10);
    expect(result.value).toBeCloseTo(0.2, 5);
  });
});
