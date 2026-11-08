import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { createTestDatabase } from "../db/test-db";
import type { DemoDeps } from "../hosting/demo";
import { fakeSupabase } from "../hosting/fake-supabase";
import { OPERATOR } from "../hosting/test-kit";
import { fileHostingSecrets, fileHostingStore } from "../hosting/store";
import { fakeCastModel } from "./demo-cast/generate";
import { setRealScreensTestHooks, settleRealScreens } from "./real-screens";

/**
 * The real-screens routes in accounts mode (Postgres): every route is
 * scoped to an app of the signed-in account; the cast is written, shown
 * and approved; the seed plan validated; what captures need on this machine
 * (Docker, the Supabase CLI) with install hints; screenshots uploaded as a
 * form; an old demo project deleted through the guard when the app goes;
 * nothing secret in any answer.
 */

const ORIGIN = "https://day2.test";
let t: Awaited<ReturnType<typeof createTestDatabase>>;
let work: string;
let work2: string;
let data: string;
const saved: Record<string, string | undefined> = {};
const ENV = { DAY2_PUBLIC_URL: ORIGIN, DAY2_DEV_LOGIN: "on", DAY2_CREDITS: "off", DAY2_SECRETS_KEY: Buffer.alloc(32, 9).toString("base64"), DAY2_BACKLOG_TICK_MINUTES: "0", DAY2_CAPTURE: "off" };
const fake = fakeSupabase();
const hostingDir = () => join(data, "hosting-fake");

function dottyLike(): string {
  const r = mkdtempSync(join(tmpdir(), "day2-rs-api-"));
  mkdirSync(join(r, "supabase", "migrations"), { recursive: true });
  cpSync(join(import.meta.dir, "..", "hosting", "fixtures", "dotty-migrations"), join(r, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(r, "package.json"), JSON.stringify({ dependencies: { expo: "54.0.0", "react-native": "0.81.0", "@supabase/supabase-js": "2.0.0" } }));
  writeFileSync(join(r, "app.json"), JSON.stringify({ expo: { name: "Dotty", version: "1.0.2", ios: { bundleIdentifier: "de.example.dotty" } } }));
  spawnSync("git", ["init", "-q"], { cwd: r });
  return r;
}

beforeAll(async () => {
  work = dottyLike();
  work2 = dottyLike();
  data = mkdtempSync(join(tmpdir(), "day2-rs-api-data-"));
  for (const [k, v] of Object.entries({ ...ENV, DAY2_DATA_DIR: data })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestDatabase();
  setRealScreensTestHooks({
    castModel: fakeCastModel(11),
    planner: null,
    noImageKit: true,
    demoDeps: (): DemoDeps => ({ store: fileHostingStore(hostingDir()), secrets: fileHostingSecrets(hostingDir()), operator: OPERATOR, api: fake.api, ticket: async (i) => ({ id: "D2-9", state: "todo" as const, ...{ key: i.source.key } }), run: async () => ({ code: 0, stdout: "", stderr: "" }), expoToken: async () => null, sleep: async () => undefined, waitMs: 60_000 }),
    // This server has neither Docker nor the Supabase CLI.
    ephemeral: () => ({ has: () => false, run: async () => ({ code: 1, stdout: "", stderr: "" }), env: {}, platform: "linux" }),
  });
});
afterAll(async () => {
  setRealScreensTestHooks({});
  await t.drop();
  for (const d of [work, work2, data]) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers.origin = ORIGIN;
  const res = await handleRequest(new Request(`${ORIGIN}${path}`, { method, headers, ...(opts.form ? { body: opts.form } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }));
  const text = await res.text();
  return { status: res.status, text, body: text.startsWith("{") ? (JSON.parse(text) as Record<string, any>) : null, type: res.headers.get("content-type") };
}
async function devLogin(login: string) {
  const res = await handleRequest(new Request(`${ORIGIN}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ login }) }));
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
async function addApp(cookie: string, name: string, repoPath: string) {
  process.env.DAY2_ALLOW_LOCAL_PATHS = "on";
  try {
    const r = await call("POST", "/api/apps", { cookie, body: { name, repoPath, connectionMethod: "local_path" } });
    expect(r.status).toBe(201);
    return r.body!.app.id as string;
  } finally {
    delete process.env.DAY2_ALLOW_LOCAL_PATHS;
  }
}
const shot = (name: string, w = 600, h = 1300) => {
  const f = join(mkdtempSync(join(tmpdir(), "day2-shot-")), name);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x225588:s=${w}x${h}`, "-frames:v", "1", f]);
  return new File([readFileSync(f)], name, { type: name.endsWith(".png") ? "image/png" : "image/jpeg" });
};

describe("Real screens API", () => {
  let alice: string;
  let bob: string;
  let appId: string;
  let bobApp: string;

  test("setup", async () => {
    alice = await devLogin("alice");
    bob = await devLogin("bob");
    appId = await addApp(alice, "Dotty", work);
    bobApp = await addApp(bob, "Other", work2);
  });

  test("the Formats view has the real-screens part: capture status, what this machine lacks, demo support, no cast or plan yet", async () => {
    const r = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    expect(r.status).toBe(200);
    expect(r.body!.real.capture).toMatchObject({ state: "idle", mode: "off", installHint: 'curl -fsSL "https://get.maestro.mobile.dev" | bash', database: { state: null, queue: { running: 0, waiting: 0, max: 2 } } });
    expect(r.body!.real.capture.requirements.map((x: { id: string; ok: boolean }) => `${x.id}:${x.ok}`)).toEqual(["docker:false", "supabase_cli:false"]);
    expect(r.body!.real.capture.requirements[0].hint).toContain("Docker Engine");
    expect(r.body!.real.demo).toMatchObject({ support: { ok: true, backend: "supabase" }, cast: null, seedPlan: { state: "missing", migrations: 28 } });
    expect(r.body!.real.demo).not.toHaveProperty("backend");
  });

  test("write the cast (in the background), see it, approve it", async () => {
    const r = await call("POST", `/api/apps/${appId}/creative/demo-cast`, { cookie: alice });
    expect(r.status).toBe(202);
    await settleRealScreens(appId);
    const v = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    const cast = v.body!.real.demo.cast;
    expect(v.body!.real.demo.castJob.state).toBe("done");
    expect(cast.status).toBe("draft");
    expect(cast.people).toHaveLength(8);
    expect(cast.people.every((p: { age: number }) => p.age >= 18)).toBe(true);
    expect(cast.people[0].avatar).toMatch(new RegExp(`^/api/apps/${appId}/creative/demo-cast/images/as_`));
    expect(cast.images.source).toBe("placeholder");
    const img = await call("GET", cast.people[0].avatar, { cookie: alice });
    expect(img.status).toBe(200);
    expect(img.type).toBe("image/png");
    // Placeholder pictures don't pass the automatic check: the pipeline waits for the owner's OK.
    const pipe = v.body!.real.pipeline;
    expect(pipe).toMatchObject({ policy: "auto", current: "approve" });
    expect(pipe.steps.map((x: { id: string; status: string }) => `${x.id}:${x.status}`)).toEqual(["cast:done", "approve:waiting", "seed_plan:pending", "flow:pending", "flow_merged:pending", "capture:pending"]);
    expect(pipe.steps[1].note).toContain("placeholders");
    // Retrying from the seed plan before approval doesn't skip it: the pipeline still waits at the approval.
    await call("POST", `/api/apps/${appId}/creative/real-screens/retry`, { cookie: alice, body: { step: "seed_plan" } });
    await settleRealScreens(appId);
    const w = (await call("GET", `/api/apps/${appId}/creative`, { cookie: alice })).body!.real;
    expect(w.pipeline.current).toBe("approve");
    expect(w.demo.seedPlan.state).toBe("missing");
    // The old route is gone.
    expect((await call("POST", `/api/apps/${appId}/creative/demo-backend`, { cookie: alice })).status).toBe(404);
    const a = await call("POST", `/api/apps/${appId}/creative/demo-cast/approve`, { cookie: alice });
    expect(a.status).toBe(200);
    expect(a.body!.real.demo.cast).toMatchObject({ status: "approved", approvedBy: "alice" });
    await settleRealScreens(appId);
  });

  test("approved: the pipeline validates the seed plan, asks for the flow, then waits for its PR — no database exists", async () => {
    const v = (await call("GET", `/api/apps/${appId}/creative`, { cookie: alice })).body!.real;
    expect(v.pipeline.steps.map((x: { id: string; status: string }) => `${x.id}:${x.status}`)).toEqual(["cast:done", "approve:done", "seed_plan:done", "flow:done", "flow_merged:waiting", "capture:pending"]);
    expect(v.pipeline.steps.map((x: { label: string }) => x.label)).toContain("Seed plan");
    expect(v.pipeline.steps[4].note).toContain("Waiting for the flow PR");
    expect(v.demo.seedPlan).toMatchObject({ state: "ready", source: "heuristic", tables: expect.arrayContaining(["dotty.profiles", "dotty.moments"]) });
    expect(fake.calls).toEqual([]);
  });

  test("the policy setting and retry: validated, owner-only, tenant-scoped", async () => {
    expect((await call("PUT", `/api/apps/${appId}/creative/real-screens/settings`, { cookie: alice, body: { demoCast: "sometimes" } })).status).toBe(400);
    const r = await call("PUT", `/api/apps/${appId}/creative/real-screens/settings`, { cookie: alice, body: { demoCast: "owner" } });
    expect(r.status).toBe(200);
    expect(r.body!.real.pipeline.policy).toBe("owner");
    expect((await call("POST", `/api/apps/${appId}/creative/real-screens/retry`, { cookie: alice, body: { step: "nope" } })).status).toBe(400);
    expect((await call("POST", `/api/apps/${appId}/creative/real-screens/retry`, { cookie: alice, body: { step: "flow_merged" } })).status).toBe(202);
    await settleRealScreens(appId);
    expect((await call("PUT", `/api/apps/${appId}/creative/real-screens/settings`, { cookie: bob, body: { demoCast: "auto" } })).status).toBe(404);
    expect((await call("POST", `/api/apps/${appId}/creative/real-screens/retry`, { cookie: bob, body: {} })).status).toBe(404);
    expect((await call("POST", `/api/apps/${appId}/creative/demo-cast/decline`, { cookie: bob })).status).toBe(404);
    expect((await call("POST", `/api/apps/${appId}/creative/real-screens/retry`, { body: {} })).status).toBe(401);
    // Bob's own app has no cast to decline.
    expect((await call("POST", `/api/apps/${bobApp}/creative/demo-cast/decline`, { cookie: bob })).status).toBe(409);
    expect((await call("GET", `/api/apps/${appId}/creative`, { cookie: alice })).body!.real.pipeline.policy).toBe("owner");
  });

  test("another account can't see, change or fetch anything of it", async () => {
    const v = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    const avatar = v.body!.real.demo.cast.people[0].avatar as string;
    expect((await call("GET", `/api/apps/${appId}/creative`, { cookie: bob })).status).toBe(404);
    for (const p of ["demo-cast", "demo-cast/approve", "real-screens/retry", "capture"]) expect((await call("POST", `/api/apps/${appId}/creative/${p}`, { cookie: bob })).status).toBe(404);
    expect((await call("GET", avatar, { cookie: bob })).status).toBe(404);
    // Alice's picture under Bob's own app: still not his.
    expect((await call("GET", avatar.replace(appId, bobApp), { cookie: bob })).status).toBe(404);
    expect((await call("GET", avatar)).status).toBe(401);
    const form = new FormData();
    form.set("language", "de");
    for (const n of ["a.png", "b.png", "c.png"]) form.append("files", shot(n));
    expect((await call("POST", `/api/apps/${appId}/creative/screens`, { cookie: bob, form })).status).toBe(404);
  });

  test("nothing secret in the answer", async () => {
    const v = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    expect(v.text).not.toMatch(/sb_secret_|eyJ/);
    expect(v.text).not.toContain("password");
    expect(v.text).not.toContain("@example.com");
  });

  test("upload 3 screenshots for German: cleaned, served only to the owner, used as the screens source; remove them", async () => {
    const form = new FormData();
    form.set("language", "de");
    for (const n of ["a.png", "b.jpg", "c.png"]) form.append("files", shot(n));
    const r = await call("POST", `/api/apps/${appId}/creative/screens`, { cookie: alice, form });
    expect(r.status).toBe(200);
    const up = r.body!.real.uploads.find((u: { locale: string }) => u.locale === "de-DE");
    expect(up.files).toHaveLength(3);
    expect((await call("GET", up.files[0], { cookie: alice })).type).toBe("image/png");
    expect((await call("GET", up.files[0], { cookie: bob })).status).toBe(404);
    expect([400, 404]).toContain((await call("GET", `/api/apps/${appId}/creative/screens/de-DE/..%2Fsecrets.json`, { cookie: alice })).status);
    const bad = new FormData();
    bad.set("language", "de");
    for (let i = 0; i < 3; i++) bad.append("files", new File(["<html>"], `x${i}.png`, { type: "image/png" }));
    const refused = await call("POST", `/api/apps/${appId}/creative/screens`, { cookie: alice, form: bad });
    expect(refused.status).toBe(415);
    expect(refused.text).toContain("isn't a PNG or JPEG");
    expect((await call("DELETE", `/api/apps/${appId}/creative/screens/de-DE`, { cookie: alice })).body!.real.uploads).toEqual([]);
  });

  test("removing the app deletes its demo project and demo cast (and only the owner's own app)", async () => {
    expect((await call("DELETE", `/api/apps/${appId}`, { cookie: bob })).status).toBe(200); // not Bob's app: nothing happens to it
    expect(fake.calls.some((c) => c.op === "deleteProject")).toBe(false);
    expect((await call("GET", `/api/apps/${appId}/creative`, { cookie: alice })).status).toBe(200);
  });

  test("capture on a server without a simulator: the status says why", async () => {
    await call("POST", `/api/apps/${appId}/creative/capture`, { cookie: alice });
    await settleRealScreens(appId);
    const v = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    expect(v.body!.real.capture).toMatchObject({ state: "failed", note: expect.stringContaining("can't run on this server") });
  });

  test("removing the app deletes its demo cast — and an old standing demo project through the guard", async () => {
    const p = await fake.api("x").createProject({ name: "dotty-demo", organization_slug: OPERATOR.orgSlug, db_pass: "x", region: "eu-central-1" });
    await fileHostingStore(hostingDir()).update(appId, (s) => {
      s.demo = { createdBy: "day2-demo", ref: p.ref, name: "dotty-demo", orgSlug: OPERATOR.orgSlug, region: "eu-central-1", url: `https://${p.ref}.supabase.co`, publishableKey: null, createdAt: "", status: "ACTIVE_HEALTHY", done: [], working: null, migrations: { applied: 0, total: 0, failed: null }, plan: null, seededAt: null, castSeed: null, rows: 0, uploads: 0, seeded: { users: [], rows: [] }, pausedAt: null, problem: null, log: [] };
    });
    expect((await call("DELETE", `/api/apps/${appId}`, { cookie: alice })).status).toBe(200);
    expect(fake.calls.filter((c) => c.op === "deleteProject")).toHaveLength(1);
    expect(existsSync(join(data, "demo-cast", appId))).toBe(false);
  });
});
