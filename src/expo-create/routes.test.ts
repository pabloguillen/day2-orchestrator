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
    expect((await call("POST", "/api/expo-create/create-nope/flow/comments", { screenId: "x", text: "hi there" })).status).toBe(404);
    expect((await call("POST", "/api/expo-create/create-nope/flow/approve")).status).toBe(404);
    expect((await call("POST", "/api/expo-create/create-nope/unstick", { choice: "x" })).status).toBe(400);
    expect((await call("GET", "/api/expo-create/create-nope/mockups/a.png")).status).toBe(404);
    expect((await call("GET", "/api/expo-create/create-nope/flow/export.zip")).status).toBe(404);
  });

  test("the screen flow: layout, comments, early approval, files and the zip (a build waiting on the owner)", async () => {
    const { fileCreateStore } = await import("./store");
    const { mockupDir } = await import("../mockups");
    const screens = [
      { id: "today", name: "Today", route: "/", purpose: "p", key: true, elements: [], flow: "main", states: ["filled"], links: [{ label: "Tap +", to: "log" }] },
      { id: "log", name: "Log", route: "/log", purpose: "p", key: false, elements: [], flow: "main", states: ["filled"], links: [] },
    ];
    const plan = { summary: "s", screens, data: [], firstMinute: [], monetization: { model: "free", placement: "", notes: "" }, actions: [], accounts: false, functions: [], language: "en", openQuestions: [] };
    const ds = { name: "x", colors: [], fonts: { heading: "a", body: "a" }, type: [], spacing: [], radius: { small: 1, medium: 2, large: 3 }, components: [], voice: "" };
    const at = new Date().toISOString();
    const dir = join(mockupDir("app-r1"), "flow");
    (await import("node:fs")).mkdirSync(dir, { recursive: true });
    for (const f of ["v1-today.png", "v1-today.html", "v1-log.png", "style-v1.png"]) writeFileSync(join(dir, f), f.endsWith(".html") ? "<body>hi</body>" : "png");
    await fileCreateStore(ROOT).save({
      id: "create-r1", accountId: "local", v: 2, appId: "app-r1", at, updatedAt: at, request: { name: "routes-app", displayName: "Routes App", description: "d", platforms: ["ios"], money: "free" },
      identifiers: { bundleId: "a.b", androidPackage: "a.b", scheme: "ab", displayName: "Routes App", slug: "routes-app" }, phase: "flow_review", status: "needs_you", step: "x", plan, planRevision: 1, planComments: [],
      flow: { versions: [{ n: 1, at, plan, designSystem: ds, style: { png: "style-v1.png", html: "style-v1.html", drawnIn: 1 }, designs: [{ screenId: "today", drawnIn: 1, png: "v1-today.png", html: "v1-today.html", note: "", hotspots: [] }, { screenId: "log", drawnIn: 1, png: "v1-log.png", html: "", note: "", hotspots: [] }], changed: ["today", "log"] }], comments: [], approved: [] },
      mockups: [], mockupComments: [], comparisons: [], checks: [], credits: 0, estimateCredits: 1, tickets: [], ownerSteps: [], log: [],
    } as never);

    const got = await call("GET", "/api/expo-create/create-r1");
    const build = got.body.build as { flow: { versions: Array<{ layout: { edges: Array<{ label: string }> } }> }; phases: Array<{ id: string; state: string }> };
    expect(build.flow.versions[0]!.layout.edges.map((e) => e.label)).toEqual(["Tap + → Log"]);
    expect(build.phases.find((p) => p.id === "flow_review")!.state).toBe("you");
    expect(build.phases.some((p) => p.id === "flow_revise")).toBe(false);

    expect((await call("POST", "/api/expo-create/create-r1/flow/comments", { screenId: "nope", text: "Bigger" })).status).toBe(400);
    const c = await call("POST", "/api/expo-create/create-r1/flow/comments", { screenId: "today", text: "Bigger", pin: { x: 0.5, y: 0.5 } });
    expect(c.status).toBe(200);
    const comments = (c.body.build as { flow: { comments: Array<{ id: string; pin: unknown }> } }).flow.comments;
    expect(comments[0]!.pin).toEqual({ x: 0.5, y: 0.5 });
    expect((await call("DELETE", `/api/expo-create/create-r1/flow/comments/${comments[0]!.id}`)).status).toBe(200);
    expect((await call("POST", "/api/expo-create/create-r1/flow/screens/today", { approved: "yes" })).status).toBe(400);
    const a = await call("POST", "/api/expo-create/create-r1/flow/screens/today", { approved: true });
    expect((a.body.build as { flow: { approved: string[] } }).flow.approved).toEqual(["today"]);
    expect((await call("POST", "/api/expo-create/create-r1/flow/comments", { screenId: "today", text: "Bigger" })).status).toBe(409);

    const png = await handleRequest(new Request("http://localhost/api/expo-create/create-r1/flow/files/v1-today.png"));
    expect(png.headers.get("content-type")).toBe("image/png");
    const html = await handleRequest(new Request("http://localhost/api/expo-create/create-r1/flow/files/v1-today.html"));
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    expect((await handleRequest(new Request("http://localhost/api/expo-create/create-r1/flow/files/other.png"))).status).toBe(404);
    const z = await handleRequest(new Request("http://localhost/api/expo-create/create-r1/flow/export.zip"));
    expect(z.headers.get("content-disposition")).toContain("routes-app-screens-v1.zip");
    const bytes = new Uint8Array(await z.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
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
