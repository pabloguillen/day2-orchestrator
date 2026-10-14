import { describe, expect, test } from "bun:test";
import { addBet, betLink, betTicket, measureBet, syncBetStatus, validateNewBet, type Bet } from "./growth-bets";
import { fetchAppEvents } from "./app-events";
import type { EventLike } from "./metrics/types";

const NOW = new Date("2026-10-01T00:00:00Z");

function liveBet(): Bet {
  const { bet } = addBet({ nextNumber: 3, bets: [] }, { title: "Split bills in 10 seconds", angle: "Lead with speed", channel: "Meta ads" }, NOW);
  return { ...bet, status: "live", liveAt: "2026-10-02T00:00:00Z" };
}

/** n people from the bet (k reach the outcome) and m others (j reach it). */
function events(bet: string, n: number, k: number, m: number, j: number, outcome = "activated"): EventLike[] {
  const out: EventLike[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ type: "visit", at: "2026-10-03T10:00:00Z", deviceId: `b${i}`, acquisition: { campaignId: bet } });
    if (i < k) out.push({ type: outcome, at: "2026-10-03T11:00:00Z", deviceId: `b${i}` });
  }
  for (let i = 0; i < m; i++) {
    out.push({ type: "visit", at: "2026-10-03T10:00:00Z", deviceId: `o${i}` });
    if (i < j) out.push({ type: outcome, at: "2026-10-03T11:00:00Z", deviceId: `o${i}` });
  }
  return out;
}

describe("experiments from ad to product", () => {
  test("validation and the page path", () => {
    expect(validateNewBet({})).toMatchObject({ ok: false });
    expect(validateNewBet({ title: "x", angle: "y" })).toMatchObject({ ok: false });
    expect(validateNewBet({ title: "x", angle: "y", channel: "Reddit", metric: "clicks" })).toMatchObject({ ok: false });
    const v = validateNewBet({ title: "Split bills in 10 seconds!", angle: "speed", channel: "Meta ads" });
    expect(v).toMatchObject({ ok: true, bet: { metric: "activation" } });
    const a = addBet({ nextNumber: 3, bets: [] }, (v as { bet: Parameters<typeof addBet>[1] }).bet, NOW);
    expect(a.bet).toMatchObject({ id: "B-3", landingPath: "/go/split-bills-in-10-seconds", status: "building" });
    // Same title again: a different path.
    const b = addBet(a.file, { title: "Split bills in 10 seconds!", angle: "x", channel: "y" }, NOW);
    expect(b.bet.landingPath).toBe("/go/split-bills-in-10-seconds-4");
    expect(betLink(a.bet, "https://buddy.app/")).toBe("https://buddy.app/go/split-bills-in-10-seconds?d2=B-3");
    expect(betLink(a.bet, undefined)).toBeNull();
  });

  test("the page ticket says what to build and how to measure", () => {
    const t = betTicket(liveBet());
    expect(t.source).toEqual({ kind: "day2_proposal", key: "bet:B-3" });
    expect(t.description).toContain("/go/split-bills-in-10-seconds");
    expect(t.doneWhen!.join(" ")).toContain('campaignId "B-3"');
  });

  test("goes live when its page ships", () => {
    const { bet } = addBet({ nextNumber: 1, bets: [] }, { title: "a", angle: "b", channel: "c" }, NOW);
    expect(syncBetStatus(bet, { state: "doing", updatedAt: "x" })).toBe(bet);
    expect(syncBetStatus(bet, { state: "done", doneAt: "2026-10-05T00:00:00Z", updatedAt: "x" })).toMatchObject({ status: "live", liveAt: "2026-10-05T00:00:00Z" });
  });

  test("verdicts: no data, collecting, better, worse — measured in the product", () => {
    const bet = liveBet();
    expect(measureBet(bet, null).state).toBe("no_data");
    expect(measureBet({ ...bet, status: "building", liveAt: null }, []).state).toBe("no_data");
    expect(measureBet(bet, events(bet.id, 5, 3, 50, 10))).toMatchObject({ state: "collecting", betPeople: 5, othersPeople: 50 });

    const better = measureBet(bet, events(bet.id, 60, 30, 200, 40));
    expect(better).toMatchObject({ state: "better", betPeople: 60, betRate: 0.5, othersRate: 0.2 });
    expect(better.note).toContain("50% of people from this experiment reached first value, vs 20% of everyone else");

    expect(measureBet(bet, events(bet.id, 60, 3, 200, 80)).state).toBe("worse");
    expect(measureBet(bet, events(bet.id, 60, 12, 200, 40)).state).toBe("no_difference");
    // Same data, same verdict (no ambient randomness).
    expect(measureBet(bet, events(bet.id, 60, 30, 200, 40))).toEqual(better);
  });

  test("only people who arrived while it ran count; sign-up as the measure", () => {
    const bet = { ...liveBet(), metric: "signup" as const };
    const old: EventLike[] = Array.from({ length: 100 }, (_, i) => ({ type: "visit", at: "2026-09-01T00:00:00Z", deviceId: `old${i}` }));
    const v = measureBet(bet, [...old, ...events(bet.id, 40, 20, 40, 8, "signup")]);
    expect(v).toMatchObject({ betPeople: 40, othersPeople: 40, state: "better" });
  });

  test("reading the app's events", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.includes("missing")) return new Response("no", { status: 404 });
      return Response.json({ events: [{ type: "visit", at: "2026-10-03T00:00:00Z", deviceId: "d1" }, { bad: true }] });
    };
    expect(await fetchAppEvents(undefined, "2026-10-01")).toBeNull();
    expect(await fetchAppEvents("https://missing.app", "2026-10-01", { fetchImpl: fake })).toBeNull();
    const ev = await fetchAppEvents("https://buddy.app/", "2026-10-01T00:00:00Z", { fetchImpl: fake, token: "t0k" });
    expect(ev).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ url: "https://buddy.app/api/day2-events?since=2026-10-01T00%3A00%3A00Z", auth: "Bearer t0k" });
  });
});
