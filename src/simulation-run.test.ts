import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { readCredits } from "./credits";
import { fileFieldStore } from "./field-store";
import { contractSignals } from "./field-work";
import { simulateApp } from "./simulation-run";
import type { SimInput, SimOutput } from "./simulation";
import type { Tenant } from "./tenant";

/** The daily schedule around the simulation: when it runs, what it stores, what it costs. */

const ROOT = mkdtempSync(join(tmpdir(), "day2-simrun-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const REPO = join(ROOT, "app");
mkdirSync(REPO, { recursive: true });
writeFileSync(join(REPO, "package.json"), '{"dependencies":{"react":"19"}}');

const app: AppEntry = { id: "app_s", name: "buddy", repoPath: REPO, connectionMethod: "local_path", appBaseUrl: "https://buddy.example", addedAt: "2026-10-01T00:00:00Z" };
const store = fileFieldStore(join(ROOT, "field"));
const tenant = { credits: { dir: join(ROOT, "credits") } } as unknown as Tenant;
const NOW = new Date("2026-10-15T03:00:00Z");

let calls = 0;
const run = async (input: SimInput): Promise<SimOutput> => {
  calls++;
  expect(input.baseUrl).toBe("https://buddy.example");
  return {
    batches: [
      {
        v: 1,
        device: { id: "sim-iphone", platform: "web", model: "day2 simulation: iPhone", viewport: { w: 390, h: 844 } },
        passes: { "screen:/": 1 },
        failures: [{ contract: "go.b", at: NOW.toISOString(), route: "/", expected: { screen: "/b" }, actual: { screen: "/a" }, evidence: { detail: { simulated: true, reproduced: true } }, steps: ["screen /", "tap go.b"] }],
        events: [],
      },
    ],
    run: { at: NOW.toISOString(), durationMs: 90_000, profiles: ["iPhone"], screens: 3, actions: 1, links: 4, failures: 1, flaky: 0, skipped: [] },
  };
};

describe("daily simulation", () => {
  test("waits for contracts, runs once a day, records like field reports, bills server time", async () => {
    expect(await simulateApp(tenant, app, { store, run, now: NOW })).toEqual({ ran: false, reason: "no contracts yet" });
    await store.setContracts(app.id, { file: { version: 1, generatedAt: NOW.toISOString(), contracts: [{ id: "go.b", kind: "action", target: "action:go.b", expect: [{ screen: "/b" }], source: "code" }] }, candidates: [], head: "abc" }, NOW);

    expect((await simulateApp(tenant, app, { store, run, now: NOW })).ran).toBe(true);
    expect((await simulateApp(tenant, app, { store, run, now: new Date(NOW.getTime() + 3_600_000) })).reason).toBe("ran in the last day");
    expect(calls).toBe(1);

    expect(await store.simulation(app.id)).toMatchObject({ screens: 3, failures: 1 });
    const since = new Date(NOW.getTime() - 86_400_000);
    const health = await store.health(app.id, since);
    expect(health.find((x) => x.contract === "go.b")).toMatchObject({ failures: 1, simulated: 1 });
    // One confirmed simulated failure is enough for a ticket.
    expect(contractSignals(app.id, health, (await store.contracts(app.id))!.file, NOW)).toHaveLength(1);

    const { events } = await readCredits(tenant.credits, NOW);
    expect(events.filter((e) => e.id === "sim:app_s:2026-10-15")).toHaveLength(1);
  });

  test("not for apps without a live address", async () => {
    expect(await simulateApp(tenant, { ...app, appBaseUrl: undefined }, { store, run, now: NOW })).toEqual({ ran: false, reason: "no live address" });
  });
});
