import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { createTestDatabase } from "../db/test-db";
import { creatorKitFor, toolStates } from "./kit";
import { setCreatorToolTestHooks } from "./routes";

/**
 * The Creator tools API in accounts mode (Postgres, migration 027): tenant
 * scoping, connecting the owner's own key (checked with one cheap call,
 * stored encrypted, never returned), likeness consent, the per-app switches
 * and caps, "Use day2's", and the workspace-wide key.
 */

const ORIGIN = "https://day2.test";
let t: Awaited<ReturnType<typeof createTestDatabase>>;
let work: string;
let work2: string;
let data: string;
const saved: Record<string, string | undefined> = {};
const ENV = { DAY2_PUBLIC_URL: ORIGIN, DAY2_DEV_LOGIN: "on", DAY2_CREDITS: "off", DAY2_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"), DAY2_BACKLOG_TICK_MINUTES: "0" };
const checks: string[] = [];

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "day2-ct-api-"));
  work2 = mkdtempSync(join(tmpdir(), "day2-ct-api2-"));
  data = mkdtempSync(join(tmpdir(), "day2-ct-data-"));
  for (const [k, v] of Object.entries({ ...ENV, DAY2_DATA_DIR: data })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestDatabase();
  setCreatorToolTestHooks({
    deps: {
      sleep: async () => {},
      fetch: (async (u: string | URL, init?: RequestInit) => {
        const h = (init?.headers ?? {}) as Record<string, string>;
        const key = h["x-api-key"] ?? h.authorization ?? h["xi-api-key"] ?? "";
        checks.push(`${init?.method ?? "GET"} ${new URL(String(u)).pathname}`);
        return key.includes("GOOD") ? Response.json({ data: [] }) : new Response("unauthorized", { status: 401 });
      }) as typeof fetch,
    },
    env: { HEYGEN_API_KEY: "D2-HEYGEN" },
  });
});
afterAll(async () => {
  setCreatorToolTestHooks({ deps: {}, env: null });
  await t.drop();
  for (const d of [work, work2, data]) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers.origin = ORIGIN;
  const res = await handleRequest(new Request(`${ORIGIN}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }));
  const text = await res.text();
  return { status: res.status, text, body: text.startsWith("{") ? (JSON.parse(text) as Record<string, any>) : null };
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
const tool = (b: Record<string, any>, id: string) => b.tools.find((x: { id: string }) => x.id === id);

describe("Creator tools API", () => {
  let alice: string;
  let bob: string;
  let appId: string;

  test("setup", async () => {
    alice = await devLogin("alice");
    bob = await devLogin("bob");
    appId = await addApp(alice, "Dotty", work);
  });

  test("every tool is listed; day2's HeyGen is offered with an estimate, but not on until chosen", async () => {
    const r = await call("GET", `/api/apps/${appId}/creator-tools`, { cookie: alice });
    expect(r.status).toBe(200);
    expect(r.body!.tools.map((x: { id: string }) => x.id)).toEqual(["runway", "creatify", "heygen", "luma", "gemini_video", "elevenlabs", "openai_images"]);
    const hg = tool(r.body!, "heygen");
    expect(hg).toMatchObject({ name: "HeyGen", day2: { available: true }, inUse: null, own: null, setting: { account: "auto", posts: true, ads: true, capCredits: 300 } });
    expect(hg.day2.estimateCredits).toBeGreaterThan(0);
    expect(r.text).not.toContain("D2-HEYGEN");
    expect(tool(r.body!, "luma").day2.available).toBe(false);
  });

  test("another account can't see or change this app's tools", async () => {
    expect((await call("GET", `/api/apps/${appId}/creator-tools`, { cookie: bob })).status).toBe(404);
    expect((await call("POST", `/api/apps/${appId}/creator-tools/luma/key`, { cookie: bob, body: { fields: { apiKey: "GOOD-x" } } })).status).toBe(404);
    expect((await call("PUT", `/api/apps/${appId}/creator-tools/heygen`, { cookie: bob, body: { account: "day2" } })).status).toBe(404);
  });

  test("a wrong key is refused after one cheap check; a good one is stored encrypted and never returned", async () => {
    checks.length = 0;
    const bad = await call("POST", `/api/apps/${appId}/creator-tools/luma/key`, { cookie: alice, body: { fields: { apiKey: "luma-api-WRONG" } } });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("didn't accept");
    expect(bad.text).not.toContain("WRONG");
    expect(checks).toEqual(["GET /v1/credits"]);
    const ok = await call("POST", `/api/apps/${appId}/creator-tools/luma/key`, { cookie: alice, body: { fields: { apiKey: "luma-api-GOOD-123" } } });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain("GOOD-123");
    expect(tool(ok.body!, "luma")).toMatchObject({ inUse: "own", billedBy: "Luma", own: { scope: "app", connectedBy: "alice" }, setting: { account: "own" } });
    const [row] = (await t.sql`SELECT secret_enc, meta FROM creator_tool_keys WHERE tool = 'luma'`) as Array<{ secret_enc: string; meta: unknown }>;
    expect(row!.secret_enc.startsWith("v1.")).toBe(true);
    expect(row!.secret_enc).not.toContain("GOOD");
    expect(JSON.stringify(row!.meta)).not.toContain("GOOD");
    // The app's other kit (posts) now has Luma on the owner's account.
    const acct = ((await t.sql`SELECT account_id FROM creator_tool_keys WHERE tool = 'luma'`) as Array<{ account_id: string }>)[0]!.account_id;
    const kit = await creatorKitFor(acct, { id: appId, repoPath: work }, "posts");
    expect(kit.candidates({ capability: "generated_video", prompt: "x", ratio: "9:16", durationSec: 5, imageUrl: "data:image/jpeg;base64,QQ==", appName: "Dotty" }).map((c) => [c.id, c.account])).toEqual([["luma", "own"]]);
  });

  test("an own avatar or voice needs the consent box", async () => {
    const no = await call("POST", `/api/apps/${appId}/creator-tools/heygen/key`, { cookie: alice, body: { fields: { apiKey: "GOOD-hg", avatarId: "my_twin" } } });
    expect(no.status).toBe(400);
    expect(no.text).toContain("consent");
    const yes = await call("POST", `/api/apps/${appId}/creator-tools/heygen/key`, { cookie: alice, body: { fields: { apiKey: "GOOD-hg", avatarId: "my_twin" }, consent: true } });
    expect(yes.status).toBe(200);
    expect(tool(yes.body!, "heygen").own.likeness).toEqual({ avatar: true, voice: false });
    expect(yes.text).not.toContain("my_twin");
    expect((await call("POST", `/api/apps/${appId}/creator-tools/heygen/key`, { cookie: alice, body: { fields: {} } })).status).toBe(400);
  });

  test("switches, cap, Use day2's, off — and day2's only where the operator has an account", async () => {
    const r = await call("PUT", `/api/apps/${appId}/creator-tools/heygen`, { cookie: alice, body: { account: "day2", ads: false, capCredits: 120 } });
    expect(tool(r.body!, "heygen")).toMatchObject({ inUse: "day2", billedBy: "credits", setting: { account: "day2", posts: true, ads: false, capCredits: 120 } });
    expect((await call("PUT", `/api/apps/${appId}/creator-tools/luma`, { cookie: alice, body: { account: "day2" } })).status).toBe(409);
    expect((await call("PUT", `/api/apps/${appId}/creator-tools/luma`, { cookie: alice, body: { capCredits: -5 } })).status).toBe(400);
    const off = await call("PUT", `/api/apps/${appId}/creator-tools/luma`, { cookie: alice, body: { account: "off" } });
    expect(tool(off.body!, "luma").inUse).toBeNull();
    expect((await call("PUT", `/api/apps/${appId}/creator-tools/nope`, { cookie: alice, body: {} })).status).toBe(404);
  });

  test("a workspace-wide key reaches the account's other apps; disconnecting removes it", async () => {
    const r = await call("POST", `/api/apps/${appId}/creator-tools/openai_images/key`, { cookie: alice, body: { fields: { apiKey: "sk-GOOD" }, scope: "workspace" } });
    expect(tool(r.body!, "openai_images").own.scope).toBe("workspace");
    // Another app of the same account (the trial plan has one app, so straight from the store).
    const acct = ((await t.sql`SELECT account_id FROM creator_tool_keys WHERE tool = 'openai_images'`) as Array<{ account_id: string }>)[0]!.account_id;
    const other = await toolStates(acct, { id: "app_other", repoPath: work2 });
    expect(other.find((s) => s.def.id === "openai_images")).toMatchObject({ ownScope: "workspace" });
    expect(other.find((s) => s.def.id === "luma")!.own).toBeNull();
    expect((await toolStates("00000000-0000-0000-0000-000000000000", { id: appId, repoPath: work })).every((s) => s.own === null)).toBe(true);
    const gone = await call("DELETE", `/api/apps/${appId}/creator-tools/openai_images/key?scope=workspace`, { cookie: alice });
    expect(tool(gone.body!, "openai_images")).toMatchObject({ own: null, inUse: null, setting: { account: "auto" } });
  });
});
