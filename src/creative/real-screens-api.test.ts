import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { createTestDatabase } from "../db/test-db";
import type { DemoClient, DemoDeps } from "../hosting/demo";
import { fakeSupabase } from "../hosting/fake-supabase";
import { OPERATOR } from "../hosting/test-kit";
import { fileHostingSecrets, fileHostingStore } from "../hosting/store";
import { fakeCastModel } from "./demo-cast/generate";
import { setRealScreensTestHooks, settleRealScreens } from "./real-screens";

/**
 * The real-screens routes in accounts mode (Postgres): every route is
 * scoped to an app of the signed-in account; the cast is written, shown
 * and approved; the demo backend set up against a fake Supabase; screenshots
 * uploaded as a form; nothing secret (keys, the demo login) in any answer.
 */

const ORIGIN = "https://day2.test";
let t: Awaited<ReturnType<typeof createTestDatabase>>;
let work: string;
let work2: string;
let data: string;
const saved: Record<string, string | undefined> = {};
const ENV = { DAY2_PUBLIC_URL: ORIGIN, DAY2_DEV_LOGIN: "on", DAY2_CREDITS: "off", DAY2_SECRETS_KEY: Buffer.alloc(32, 9).toString("base64"), DAY2_BACKLOG_TICK_MINUTES: "0", DAY2_CAPTURE: "off" };
const fake = fakeSupabase();
const demoCalls: string[] = [];

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
  const users = new Map<string, string>();
  const client: DemoClient = {
    createUser: async (o) => (demoCalls.push("createUser"), users.set(o.email, `00000000-0000-4000-8000-${String(users.size + 1).padStart(12, "0")}`), { id: users.get(o.email)! }),
    findUser: async (e) => (users.has(e) ? { id: users.get(e)! } : null),
    deleteUser: async () => undefined,
    insert: async (table) => void demoCalls.push(`insert ${table}`),
    remove: async () => undefined,
    upload: async (b) => void demoCalls.push(`upload ${b}`),
  };
  const hostingDir = join(data, "hosting-fake");
  setRealScreensTestHooks({
    castModel: fakeCastModel(11),
    planner: null,
    noImageKit: true,
    demoDeps: (): DemoDeps => ({ store: fileHostingStore(hostingDir), secrets: fileHostingSecrets(hostingDir), operator: OPERATOR, api: fake.api, ticket: async (i) => ({ id: "D2-9", state: "todo" as const, ...{ key: i.source.key } }), run: async () => ({ code: 0, stdout: "", stderr: "" }), expoToken: async () => null, sleep: async () => undefined, waitMs: 60_000, demoClient: () => client, planner: null }),
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

  test("the Formats view has the real-screens part: capture status, demo support, no cast yet", async () => {
    const r = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    expect(r.status).toBe(200);
    expect(r.body!.real.capture).toMatchObject({ state: "idle", mode: "off", installHint: 'curl -fsSL "https://get.maestro.mobile.dev" | bash' });
    expect(r.body!.real.demo).toMatchObject({ support: { ok: true, backend: "supabase" }, cast: null, backend: null });
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
    // Setting up the backend before approval is refused (the job fails with the reason).
    await call("POST", `/api/apps/${appId}/creative/demo-backend`, { cookie: alice });
    await settleRealScreens(appId);
    expect((await call("GET", `/api/apps/${appId}/creative`, { cookie: alice })).body!.real.demo.backendJob).toMatchObject({ state: "failed", note: expect.stringContaining("Approve the demo cast") });
    const a = await call("POST", `/api/apps/${appId}/creative/demo-cast/approve`, { cookie: alice });
    expect(a.status).toBe(200);
    expect(a.body!.real.demo.cast).toMatchObject({ status: "approved", approvedBy: "alice" });
  });

  test("another account can't see, change or fetch anything of it", async () => {
    const v = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    const avatar = v.body!.real.demo.cast.people[0].avatar as string;
    expect((await call("GET", `/api/apps/${appId}/creative`, { cookie: bob })).status).toBe(404);
    for (const p of ["demo-cast", "demo-cast/approve", "demo-backend", "capture"]) expect((await call("POST", `/api/apps/${appId}/creative/${p}`, { cookie: bob })).status).toBe(404);
    expect((await call("GET", avatar, { cookie: bob })).status).toBe(404);
    // Alice's picture under Bob's own app: still not his.
    expect((await call("GET", avatar.replace(appId, bobApp), { cookie: bob })).status).toBe(404);
    expect((await call("GET", avatar)).status).toBe(401);
    const form = new FormData();
    form.set("language", "de");
    for (const n of ["a.png", "b.png", "c.png"]) form.append("files", shot(n));
    expect((await call("POST", `/api/apps/${appId}/creative/screens`, { cookie: bob, form })).status).toBe(404);
  });

  test("set up the demo backend: fake Supabase, cast seeded, nothing secret in the answer", async () => {
    await call("POST", `/api/apps/${appId}/creative/demo-backend`, { cookie: alice });
    await settleRealScreens(appId);
    const v = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    expect(v.body!.real.demo.backendJob).toMatchObject({ state: "done" });
    expect(v.body!.real.demo.backend).toMatchObject({ state: "ready", name: expect.stringMatching(/-demo$/), rows: expect.any(Number) });
    expect(demoCalls).toContain("insert dotty.moments");
    expect(demoCalls.filter((c) => c.startsWith("upload")).length).toBeGreaterThan(0);
    expect(v.text).not.toContain("TOPSECRET");
    expect(v.text).not.toMatch(/sb_secret_/);
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

  test("capture on a server without a simulator: the status says why", async () => {
    await call("POST", `/api/apps/${appId}/creative/capture`, { cookie: alice });
    await settleRealScreens(appId);
    const v = await call("GET", `/api/apps/${appId}/creative`, { cookie: alice });
    expect(v.body!.real.capture).toMatchObject({ state: "failed", note: expect.stringContaining("can't run on this server") });
  });
});
