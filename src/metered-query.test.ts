import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The SDK is replaced with a fake that reports a fixed cost, so this
 * exercises exactly the metering around it — no real agent run. */
let fakeCost = 0.2;
let started = 0;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: async function* () {
    started++;
    yield { type: "assistant" };
    yield { type: "result", result: "done", is_error: false, total_cost_usd: fakeCost, num_turns: 1 };
  },
}));

const { meteredQuery, withCreditContext } = await import("./metered-query");
const { CreditsError, getSummary, setPlan, MARKUP } = await import("./credits");

const ROOT = mkdtempSync(join(tmpdir(), "day2-metered-"));
const REPO = join(ROOT, "repo");
const prev = { reg: process.env.DAY2_APPS_REGISTRY_PATH, fx: process.env.DAY2_USD_TO_EUR };

beforeAll(() => {
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_USD_TO_EUR = "1";
  writeFileSync(
    process.env.DAY2_APPS_REGISTRY_PATH,
    JSON.stringify({ apps: [{ id: "app1", name: "buddy", repoPath: REPO, connectionMethod: "local_path", addedAt: "2026-10-01T00:00:00Z" }] }),
  );
});

afterAll(() => {
  for (const [k, v] of [["DAY2_APPS_REGISTRY_PATH", prev.reg], ["DAY2_USD_TO_EUR", prev.fx]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

async function drain(gen: AsyncGenerator<unknown>) {
  for await (const _ of gen) void _;
}

describe("meteredQuery", () => {
  const store = () => ({ dir: ROOT });

  test("charges the real cost to the app whose repo the run is in", async () => {
    const q = meteredQuery("agent_work", "Fix");
    await drain(q({ prompt: "x", options: { cwd: join(REPO, "src"), maxBudgetUsd: 1 } }) as AsyncGenerator<unknown>);
    const s = await getSummary(store());
    const expected = Math.ceil((0.2 * MARKUP.agent_work) / 0.01 - 1e-9);
    expect(s.balance.usedThisMonth).toBe(expected);
    expect(s.byApp).toEqual([{ appId: "app1", credits: expected, count: 1 }]);
    expect(s.recent[0]).toMatchObject({ description: "Fix", service: "agent_work", credits: -expected });
  });

  test("a context names the app, service and description, and reports what was charged", async () => {
    const ctx = { appId: "app1", appName: "buddy", service: "scan_answer" as const, description: "App scan" };
    await withCreditContext(ctx, () => drain(meteredQuery("agent_work")({ prompt: "x", options: { maxBudgetUsd: 1 } }) as AsyncGenerator<unknown>));
    expect((ctx as { charged?: number }).charged).toBe(Math.ceil((0.2 * MARKUP.scan_answer) / 0.01 - 1e-9));
    expect((await getSummary(store())).recent[0]).toMatchObject({ description: "App scan", service: "scan_answer" });
  });

  test("refuses before starting when the worst case doesn't fit — the agent never runs", async () => {
    const before = started;
    const run = drain(meteredQuery("agent_work")({ prompt: "x", options: { cwd: REPO, maxBudgetUsd: 50 } }) as AsyncGenerator<unknown>);
    await expect(run).rejects.toBeInstanceOf(CreditsError);
    expect(started).toBe(before);
  });

  test("never charges more than was authorized, even if the run overshoots", async () => {
    await setPlan(store(), "starter", "monthly");
    fakeCost = 5; // reports more than its own 1 USD budget
    const before = (await getSummary(store())).balance.usedThisMonth;
    await drain(meteredQuery("agent_work")({ prompt: "x", options: { cwd: REPO, maxBudgetUsd: 1 } }) as AsyncGenerator<unknown>);
    const after = (await getSummary(store())).balance.usedThisMonth;
    expect(after - before).toBe(Math.ceil((1 * MARKUP.agent_work) / 0.01 - 1e-9));
    fakeCost = 0.2;
  });

  test("DAY2_CREDITS=off bypasses metering (operator escape hatch)", async () => {
    process.env.DAY2_CREDITS = "off";
    const before = (await getSummary(store())).balance.usedThisMonth;
    await drain(meteredQuery("agent_work")({ prompt: "x", options: { cwd: REPO, maxBudgetUsd: 1000 } }) as AsyncGenerator<unknown>);
    delete process.env.DAY2_CREDITS;
    expect((await getSummary(store())).balance.usedThisMonth).toBe(before);
  });
});
