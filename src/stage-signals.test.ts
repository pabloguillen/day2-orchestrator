import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFieldStore } from "./field-store";
import { deriveGrowthStrategy } from "./growth-strategy";
import type { AppProfile } from "./onboarding";
import { clip, fetchDay2Stats, NO_USAGE_BASIS, resolveStageSignals } from "./stage-signals";

const NOW = new Date("2026-11-08T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(seed?: { users?: Record<string, { first: string; days: string[] }>; events?: Array<{ type: string; at: string; deviceId: string; userId?: string }> }) {
  const root = mkdtempSync(join(tmpdir(), "stage-"));
  dirs.push(root);
  const d = join(root, "dotty");
  mkdirSync(d, { recursive: true });
  if (seed?.users) writeFileSync(join(d, "users.json"), JSON.stringify(seed.users));
  for (const e of seed?.events ?? []) appendFileSync(join(d, "events.jsonl"), `${JSON.stringify(e)}\n`);
  return fileFieldStore(root);
}

const html404 = `<!DOCTYPE html><html><head><title>Page not found</title></head><body>${"Netlify ".repeat(200)}</body></html>`;
const notFound = (async () => new Response(html404, { status: 404, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
const profile = { purpose: "x" } as unknown as AppProfile;
const budget = { monthlyBudgetUsd: 100 } as Parameters<typeof deriveGrowthStrategy>[0];

describe("resolveStageSignals", () => {
  test("field data present: stage from day2's own users and events, stats 404 ignored", async () => {
    const users: Record<string, { first: string; days: string[] }> = {};
    for (let i = 0; i < 120; i++) users[`u${i}`] = { first: day(40), days: [day(40), day(10), day(2)] };
    users.gone = { first: day(200), days: [day(200)] };
    const s = store({
      users,
      events: [
        { type: "screen", at: `${day(1)}T10:00:00Z`, deviceId: "dev-anon" },
        { type: "screen", at: `${day(1)}T10:00:00Z`, deviceId: "dev-u0", userId: "u0" },
        { type: "screen", at: `${day(1)}T10:00:00Z`, deviceId: "sim-1" },
      ],
    });
    const logs: string[] = [];
    const sig = await resolveStageSignals({ store: s, appId: "dotty", appBaseUrl: "https://dottysocial.app", now: NOW, fetchFn: notFound, log: (m) => logs.push(m) });
    expect(sig.activeUsers).toBe(121); // 120 identified + 1 anonymous device; sim devices and lapsed users don't count
    expect(sig.source).toContain("day2 field data");
    expect(sig.source).not.toContain("day2-stats");
    expect(logs).toEqual([]); // a 404 is the normal case for an app without the endpoint
    const strat = deriveGrowthStrategy(budget, profile, sig, []);
    expect(strat.stage).toBe("traction");
    expect(strat.stageBasis).toContain("day2 field data");
    expect(strat.allocations.find((a) => a.channel === "social_content")).toBeTruthy();
  });

  test("users who all lapsed still count as field data (0 active), not 'no data'", async () => {
    const s = store({ users: { old: { first: day(100), days: [day(100)] } } });
    const sig = await resolveStageSignals({ store: s, appId: "dotty", now: NOW });
    expect(sig.activeUsers).toBe(0);
    expect(sig.source).toContain("day2 field data");
  });

  test("stats 404 / network error: no throw", async () => {
    const s = store();
    const logs: string[] = [];
    await expect(resolveStageSignals({ store: s, appId: "dotty", appBaseUrl: "https://dottysocial.app", now: NOW, fetchFn: notFound, log: (m) => logs.push(m) })).resolves.toBeTruthy();
    const boom = (async () => {
      throw new Error(`connect ECONNREFUSED ${"x".repeat(1000)}`);
    }) as unknown as typeof fetch;
    const sig = await resolveStageSignals({ store: s, appId: "dotty", appBaseUrl: "https://dottysocial.app", now: NOW, fetchFn: boom, log: (m) => logs.push(m) });
    expect(sig.activeUsers).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]!.length).toBeLessThan(300);
  });

  test("a 500 with an HTML page logs at most ~200 chars of it", async () => {
    const logs: string[] = [];
    const err500 = (async () => new Response(html404, { status: 500 })) as unknown as typeof fetch;
    expect(await fetchDay2Stats("https://x.example", { fetchFn: err500, log: (m) => logs.push(m) })).toBeNull();
    expect(logs[0]!.length).toBeLessThan(280);
    expect(clip("a".repeat(500)).length).toBe(201);
  });

  test("nothing at all: launch, with an explicit 'no usage data yet' basis", async () => {
    const sig = await resolveStageSignals({ store: store(), appId: "dotty", appBaseUrl: "https://dottysocial.app", now: NOW, fetchFn: notFound, log: () => {} });
    expect(sig).toEqual({ activeUsers: 0, retentionSignal: null, source: NO_USAGE_BASIS });
    const strat = deriveGrowthStrategy(budget, profile, sig, []);
    expect(strat.stage).toBe("launch");
    expect(strat.stageBasis).toContain("no usage data yet");
    // No web address either: same.
    expect((await resolveStageSignals({ store: store(), appId: "dotty", appBaseUrl: null, now: NOW })).source).toBe(NO_USAGE_BASIS);
  });

  test("web app with /api/day2-stats still works", async () => {
    const urls: string[] = [];
    const stats = (async (u: string) => {
      urls.push(String(u));
      return Response.json({ activeUsers: 250, retentionSignal: 0.4 });
    }) as unknown as typeof fetch;
    const sig = await resolveStageSignals({ store: store(), appId: "eb", appBaseUrl: "https://eb.example/", now: NOW, fetchFn: stats });
    expect(urls).toEqual(["https://eb.example/api/day2-stats"]);
    expect(sig.activeUsers).toBe(250);
    expect(sig.retentionSignal).toBe(0.4);
    expect(sig.source).toContain("/api/day2-stats");
    expect(deriveGrowthStrategy(budget, profile, sig, []).stage).toBe("traction");
  });

  test("malformed stats are ignored, not trusted", async () => {
    const bad = (async () => Response.json({ hello: 1 })) as unknown as typeof fetch;
    expect(await fetchDay2Stats("https://x.example", { fetchFn: bad })).toBeNull();
  });
});
