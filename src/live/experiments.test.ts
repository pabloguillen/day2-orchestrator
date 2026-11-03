import { describe, expect, test } from "bun:test";
import type { EventLike } from "../metrics/types";
import { addExperiment, buildTicket, cleanupTicket, invalidExperiment, keysInCode, measure, probabilityMeanGreater, promote, stop, type ExperimentInput } from "./experiments";
import { seeded } from "../growth-bets";
import { emptyLiveState, type Experiment } from "./types";

const NOW = new Date("2026-11-03T12:00:00Z");
const START = "2026-10-20T00:00:00.000Z";
const DAY = 86_400_000;

const input = (over: Partial<ExperimentInput> = {}): ExperimentInput => ({
  title: "Shorter welcome",
  hypothesis: "If the welcome title is shorter, more people add their first dot.",
  keys: ["onboarding.title"],
  variants: [
    { name: "control", weight: 50, values: {} },
    { name: "short", weight: 50, values: { "onboarding.title": "Hi" } },
  ],
  metric: { kind: "event", event: "dot_added" },
  createdBy: "day2",
  minPerArm: 100,
  ...over,
});

function running(over: Partial<ExperimentInput> = {}): Experiment {
  const { experiment } = addExperiment(emptyLiveState(), input(over), new Set(["onboarding.title"]), NOW);
  return { ...experiment, state: "running", startedAt: START };
}

/** n users per arm; `rate` of them do the goal event after exposure. */
function population(arms: Record<string, { n: number; rate: number; revenue?: number; crash?: number; back?: number }>, exp = "X-1") {
  const events: EventLike[] = [];
  const crashes: Array<{ deviceId: string; at: string }> = [];
  const t0 = Date.parse(START) + DAY;
  for (const [variant, a] of Object.entries(arms)) {
    for (let i = 0; i < a.n; i++) {
      const user = `u_${variant[0]}${String(i).padStart(31, "0")}`;
      const deviceId = `dev-${variant}-${i}`;
      const at = new Date(t0 + i * 1000).toISOString();
      events.push({ type: "exposure", at, deviceId, userId: user, props: { exp, variant }, variants: { [exp]: variant } });
      if (i < Math.round(a.n * a.rate)) events.push({ type: "dot_added", at: new Date(t0 + i * 1000 + 60_000).toISOString(), deviceId, userId: user });
      if (a.revenue && i % 10 === 0) events.push({ type: "revenue", at: new Date(t0 + i * 1000 + 120_000).toISOString(), deviceId, userId: user, value: { amount: a.revenue, currency: "EUR" } });
      if (a.crash && i < Math.round(a.n * a.crash)) crashes.push({ deviceId, at: new Date(t0 + i * 1000 + 30_000).toISOString() });
      if (a.back && i < Math.round(a.n * a.back)) events.push({ type: "active", at: new Date(t0 + i * 1000 + 7.5 * DAY).toISOString(), deviceId, userId: user });
    }
  }
  return { events, crashes };
}

describe("shape", () => {
  test("control is required, keys must be valid, one key per running experiment", () => {
    const s = emptyLiveState();
    expect(invalidExperiment(input({ variants: [{ name: "a", weight: 50, values: {} }, { name: "b", weight: 50, values: {} }] }), s)).toContain("control");
    expect(invalidExperiment(input({ keys: ["1bad"] }), s)).toContain("isn't a valid setting name");
    expect(invalidExperiment(input({ variants: [{ name: "control", weight: 50, values: {} }, { name: "x", weight: 50, values: { other: 1 } }] }), s)).toContain("doesn't change");
    const a = addExperiment(s, input(), new Set(), NOW);
    const busy = { ...a.state, experiments: a.state.experiments.map((e) => ({ ...e, state: "running" as const })) };
    expect(invalidExperiment(input(), busy)).toContain("already being tested in X-1");
    expect(a.experiment).toMatchObject({ id: "X-1", state: "draft", configOnly: false, guardrails: { crashRate: true, retentionD7: false } });
    expect(addExperiment(s, input({ metric: { kind: "revenue_per_user" } }), new Set(["onboarding.title"]), NOW).experiment).toMatchObject({ configOnly: true, guardrails: { retentionD7: true } });
  });

  test("settings the code reads", () => {
    const keys = keysInCode([
      { file: "app/index.tsx", text: 'const t = useDay2Value("onboarding.title", "Welcome"); const n = day2.value<number>("paywall.trial_days", 7);' },
      { file: "app/x.tsx", text: "day2.value('home.order', ['a'])" },
    ]);
    expect([...keys].sort()).toEqual(["home.order", "onboarding.title", "paywall.trial_days"]);
  });
});

describe("measuring", () => {
  test("a clear winner: better, with the probability, in plain words", () => {
    const { events, crashes } = population({ control: { n: 400, rate: 0.2 }, short: { n: 400, rate: 0.3 } });
    const r = measure(running(), { events, crashes, now: NOW });
    expect(r.verdict).toBe("better");
    expect(r.winner).toBe("short");
    expect(r.enough).toBe(true);
    const short = r.arms.find((a) => a.name === "short")!;
    expect(short).toMatchObject({ n: 400, value: 0.3 });
    expect(short.probBetter!).toBeGreaterThan(0.99);
    expect(r.note).toContain('"short" is better');
    expect(r.note).toContain("30%");
    // Deterministic.
    expect(measure(running(), { events, crashes, now: NOW })).toEqual(r);
  });

  test("worse, and no clear change after the maximum duration", () => {
    const worse = population({ control: { n: 400, rate: 0.3 }, short: { n: 400, rate: 0.2 } });
    expect(measure(running(), { ...worse, now: NOW })).toMatchObject({ verdict: "worse", winner: "control" });
    const same = population({ control: { n: 400, rate: 0.25 }, short: { n: 400, rate: 0.25 } });
    expect(measure(running(), { ...same, now: NOW }).verdict).toBe("collecting");
    expect(measure(running({ maxDays: 7 }), { ...same, now: NOW })).toMatchObject({ verdict: "no_clear_change", winner: "control" });
  });

  test("too few users: collecting, even when it looks good", () => {
    const { events, crashes } = population({ control: { n: 40, rate: 0.1 }, short: { n: 40, rate: 0.5 } });
    const r = measure(running(), { events, crashes, now: NOW });
    expect(r).toMatchObject({ verdict: "collecting", enough: false });
    expect(r.note).toContain("needs 100 users per version");
  });

  test("guardrail: more crashes stop it early", () => {
    const { events, crashes } = population({ control: { n: 120, rate: 0.2, crash: 0.01 }, short: { n: 120, rate: 0.4, crash: 0.12 } });
    const r = measure(running(), { events, crashes, now: NOW });
    expect(r.guardrail).toMatchObject({ what: "crash_rate", variant: "short" });
    expect(r.verdict).toBe("worse");
    expect(r.note).toContain("crashed for 12% of users vs 0.8%");
  });

  test("revenue per user: a continuous test (Bayesian bootstrap, seeded); D7 retention guards it", () => {
    const pay = population({ control: { n: 400, rate: 0, revenue: 5, back: 0.4 }, short: { n: 400, rate: 0, revenue: 9, back: 0.4 } });
    const exp = running({ metric: { kind: "revenue_per_user" } });
    const r = measure(exp, { ...pay, now: NOW });
    expect(r.currency).toBe("EUR");
    expect(r.arms.find((a) => a.name === "control")!.value).toBeCloseTo(0.5);
    expect(r.arms.find((a) => a.name === "short")!.value).toBeCloseTo(0.9);
    expect(r.verdict).toBe("better");
    expect(r.note).toContain("0.90 EUR");
    const hurt = population({ control: { n: 400, rate: 0, revenue: 5, back: 0.5 }, short: { n: 400, rate: 0, revenue: 9, back: 0.3 } });
    const g = measure(exp, { ...hurt, now: NOW });
    expect(g.guardrail).toMatchObject({ what: "retention_d7", variant: "short", value: 0.3, control: 0.5 });
    expect(g.note).toContain("kept fewer users after a week");
  });

  test("bootstrap probability", () => {
    const rng = seeded("t");
    expect(probabilityMeanGreater([0, 0, 0, 1, 0], [5, 5, 4, 6, 5], rng)).toBeGreaterThan(0.99);
    expect(probabilityMeanGreater([5, 5, 4, 6, 5], [0, 0, 0, 1, 0], rng)).toBeLessThan(0.01);
  });

  test("only exposed units count, from their first exposure on", () => {
    const { events } = population({ control: { n: 200, rate: 0.2 }, short: { n: 200, rate: 0.2 } });
    // Goal events before the exposure and from people never exposed don't count.
    const extra: EventLike[] = [
      { type: "dot_added", at: "2026-10-01T00:00:00.000Z", deviceId: "dev-short-199", userId: events.find((e) => e.deviceId === "dev-short-199")!.userId! },
      { type: "dot_added", at: "2026-10-25T00:00:00.000Z", deviceId: "dev-never", userId: `u_${"f".repeat(32)}` },
    ];
    const r = measure(running(), { events: [...events, ...extra], crashes: [], now: NOW });
    expect(r.arms.map((a) => [a.name, a.n, a.value])).toEqual([
      ["control", 200, 0.2],
      ["short", 200, 0.2],
    ]);
  });
});

describe("deciding", () => {
  test("promote: the winner's values become the defaults, logged; code experiments get a cleanup ticket", () => {
    let s = emptyLiveState();
    const a = addExperiment(s, input(), new Set(), NOW);
    s = a.state;
    s = { ...s, experiments: s.experiments.map((e) => ({ ...e, state: "decided" as const, decision: { verdict: "better" as const, winner: "short", at: NOW.toISOString(), by: "day2" as const, note: "n" } })) };
    const r = promote(s, "X-1", "owner", NOW);
    expect(r.state.values["onboarding.title"]).toMatchObject({ value: "Hi", by: "experiment" });
    expect(r.state.experiments[0]!.state).toBe("promoted");
    expect(r.state.log[0]!.text).toContain('"short" is now everyone\'s default');
    expect(r.cleanup).toMatchObject({ source: { key: "live:cleanup:X-1" } });
    expect(() => promote(r.state, "X-1", "owner", NOW)).toThrow("can't be kept now");
  });

  test("stop: everyone gets control; tickets in plain words", () => {
    const a = addExperiment(emptyLiveState(), input(), new Set(), NOW);
    const r = stop(a.state, "X-1", "you stopped it.", NOW);
    expect(r.state.experiments[0]).toMatchObject({ state: "stopped", stopReason: "you stopped it." });
    expect(r.cleanup).toBeNull();
    const t = buildTicket(a.experiment, a.state, new Set());
    expect(t.description).toContain('day2.value("onboarding.title"');
    expect(t.description).toContain('short: "Hi"');
    expect(t.description).toContain('day2.track("dot_added")');
    expect(cleanupTicket(a.experiment, "short").title).toBe('Clean up after X-1: keep "short"');
  });
});
