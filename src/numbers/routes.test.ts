import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { fieldStore } from "../tenant";
import { resetNumbersLimits } from "./routes";
import { fileNumbersStore } from "./store";
import { clearNumbersCache } from "./view";

/**
 * The Numbers API through the real router in local mode: the page with
 * nothing connected (everything says why), field data and store data from
 * the cache, settings with validation, the refresh limit, and the
 * connection tests before anything is connected. No network.
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-numbers-"));
const REPO = join(ROOT, "dotty");
const saved: Record<string, string | undefined> = {};
let appId = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(`http://localhost:4700${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const find = (b: { sections: Array<{ numbers: Array<{ key: string }> }> }, key: string) => b.sections.flatMap((s) => s.numbers).find((n) => n.key === key) as Record<string, unknown> & { value: number | null; missing?: { reason: string; fix: string | null; to: string | null } };

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "dotty", dependencies: { expo: "54.0.0", "react-native": "0.81.0" } }));
  writeFileSync(join(REPO, "app.json"), JSON.stringify({ expo: { name: "Dotty", ios: { bundleIdentifier: "de.dotty.app" }, android: { package: "de.dotty.app" } } }));
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "Dotty", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
  resetNumbersLimits();
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Numbers API", () => {
  test("nothing connected: every number says why it's missing and what fixes it", async () => {
    const r = await call("GET", `/api/apps/${appId}/numbers?days=30`);
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(30);
    expect(r.body.kind).toBe("mobile");
    expect(r.body.sections.map((s: { key: string }) => s.key)).toEqual(["installs", "active", "retention", "engagement", "money", "acquisition", "quality", "experiments"]);
    expect(find(r.body, "installs.ios")).toMatchObject({ value: null, source: "app_store", missing: { fix: "Connect App Store Connect on Connect your stores", to: "releases" } });
    expect(find(r.body, "newUsers").missing?.reason).toContain("No field data");
    expect(r.body.headline.revenue).toMatchObject({ key: "revenue", value: null });
    expect(r.body.refreshing).toBe(false);
    // Unknown periods fall back to 30 days.
    expect((await call("GET", `/api/apps/${appId}/numbers?days=12`)).body.days).toBe(30);
    expect((await call("GET", `/api/apps/no-such-app/numbers`)).status).toBe(404);
  });

  test("field data and the store cache show up; the platform each device reported is kept with its events", async () => {
    const now = new Date();
    const at = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
    for (let k = 0; k < 6; k++) {
      await fieldStore().record(
        appId,
        { v: 1, device: { id: `dev${k}`, platform: k < 4 ? "ios" : "android" }, passes: {}, failures: [], events: [{ type: "visit", at: at(30 + k) }, { type: "active", at: at(30 + k), user: `user${k}` }] },
        now,
      );
    }
    const events = await fieldStore().events(appId, new Date(now.getTime() - 3 * 86_400_000));
    expect(events.find((e) => e.deviceId === "dev5")?.platform).toBe("android");

    const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    await fileNumbersStore(() => REPO).update(appId, (d) => ({
      doc: { ...d, series: { "ios.downloads": { [day(2)]: { v: 30, p: day(0) }, [day(3)]: { v: 20, p: day(0) } } }, fetchedAt: now.toISOString() },
      result: null,
    }));
    clearNumbersCache(appId);
    const r = await call("GET", `/api/apps/${appId}/numbers?days=7`);
    expect(find(r.body, "newUsers")).toMatchObject({ value: 6, source: "field" });
    expect((find(r.body, "newUsers").byPlatform as Array<{ key: string; value: number }>).map((s) => [s.key, s.value])).toEqual([
      ["ios", 4],
      ["android", 2],
    ]);
    expect(find(r.body, "crashFree")).toMatchObject({ value: 1, label: "Crash-free sessions" });
    // Store data from the cache still needs the store connected to count.
    expect(find(r.body, "installs.ios").missing?.fix).toBe("Connect App Store Connect on Connect your stores");
    expect(r.body.headline.newUsers.key).toBe("newUsers");
    expect(r.body.fetchedAt).toBeTruthy();
  });

  test("settings: vendor number and reports bucket, checked", async () => {
    const bad = await call("PUT", `/api/apps/${appId}/numbers/settings`, { appleVendorNumber: "abc" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Payments and Financial Reports");
    expect((await call("PUT", `/api/apps/${appId}/numbers/settings`, { playBucket: "gs://somewhere-else" })).status).toBe(400);
    const ok = await call("PUT", `/api/apps/${appId}/numbers/settings`, { appleVendorNumber: "85912345", playBucket: "gs://pubsite_prod_rev_0123456789/stats/installs/" });
    expect(ok.status).toBe(200);
    expect(ok.body.connections.apple.setting).toBe("85912345");
    expect(ok.body.connections.google.setting).toBe("pubsite_prod_rev_0123456789");
    const cleared = await call("PUT", `/api/apps/${appId}/numbers/settings`, { playBucket: null });
    expect(cleared.body.connections.google.setting).toBeNull();
  });

  test("connection tests say what to connect first", async () => {
    expect((await call("POST", `/api/apps/${appId}/numbers/test/apple`)).body).toEqual({ ok: false, message: "App Store Connect isn't connected — connect it on Connect your stores first." });
    expect((await call("POST", `/api/apps/${appId}/numbers/test/google`)).body.ok).toBe(false);
    expect((await call("POST", `/api/apps/${appId}/numbers/test/amazon`)).status).toBe(404);
  });

  test("refresh: starts a store pass, then waits 10 minutes", async () => {
    const first = await call("POST", `/api/apps/${appId}/numbers/refresh`);
    expect(first.status).toBe(202);
    expect(first.body.refreshing).toBe(true);
    // Let the (store-less) pass finish.
    for (let i = 0; i < 50 && (await call("GET", `/api/apps/${appId}/numbers`)).body.refreshing; i++) await new Promise((r) => setTimeout(r, 20));
    const again = await call("POST", `/api/apps/${appId}/numbers/refresh`);
    expect(again.status).toBe(429);
    expect(again.body.error).toMatch(/try again in \d+ minutes?/);
    const view = await call("GET", `/api/apps/${appId}/numbers`);
    expect(view.body.refreshableAt).toBeTruthy();
    expect(view.body.refreshRequestedAt).toBeTruthy();
  });
});
