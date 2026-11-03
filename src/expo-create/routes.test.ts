import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The routes through the real router (handleRequest), local mode. Only
 * requests that don't start agent work are exercised here; the flow itself
 * is tested with fakes in flow.test.ts.
 */
const ROOT = mkdtempSync(join(tmpdir(), "day2-expo-routes-"));
const env = { ...process.env };
let handleRequest: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.DAY2_DATA_DIR = ROOT;
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, ".day2-apps.json");
  process.env.DAY2_CREDITS_DIR = ROOT;
  delete process.env.DATABASE_URL;
  writeFileSync(join(ROOT, ".day2-apps.json"), JSON.stringify({ apps: [] }));
  ({ handleRequest } = await import("../api-server"));
});
afterAll(() => {
  process.env = env;
  rmSync(ROOT, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await handleRequest(new Request(`http://localhost${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("Create routes", () => {
  test("estimate and builds; the feature flag is on by default", async () => {
    expect((await call("GET", "/api/features")).body).toMatchObject({ createExpoApps: true });
    const r = await call("GET", "/api/expo-create");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ builds: [] });
    expect(r.body.estimateCredits as number).toBeGreaterThan(0);
  });

  test("a trial plan can't create apps; bad input is a plain-language 400", async () => {
    expect((await call("POST", "/api/expo-create", { name: "habit-loop", description: "A habit tracker for streak breakers." })).status).toBe(402);
    await import("../credits").then((c) => c.setPlan({ dir: ROOT }, "growth", "monthly"));
    const bad = await call("POST", "/api/expo-create", { name: "Habit Loop", description: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/lowercase/);
  });

  test("unknown builds are 404; reviews need a decision", async () => {
    expect((await call("GET", "/api/expo-create/create-nope")).status).toBe(404);
    expect((await call("POST", "/api/expo-create/create-nope/plan", { decision: "maybe" })).status).toBe(400);
    expect((await call("POST", "/api/expo-create/create-nope/plan", { decision: "approve" })).status).toBe(404);
    expect((await call("POST", "/api/expo-create/create-nope/unstick", { choice: "x" })).status).toBe(400);
    expect((await call("GET", "/api/expo-create/create-nope/mockups/a.png")).status).toBe(404);
  });

  test("off with DAY2_FEATURE_CREATE_EXPO=off", async () => {
    process.env.DAY2_FEATURE_CREATE_EXPO = "off";
    try {
      expect((await call("GET", "/api/expo-create")).status).toBe(404);
    } finally {
      delete process.env.DAY2_FEATURE_CREATE_EXPO;
    }
  });
});
