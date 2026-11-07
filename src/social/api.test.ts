import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../db/test-db";
import { handleRequest } from "../api-server";
import { assetStore } from "../tenant";
import { dbMediaLinks, dbSocialAccounts, dbSocialPosts } from "./store";
import type { Post } from "./types";
import { setSocialClaimsCheck } from "./routes";
import { adConnections } from "../tenant";

/**
 * The Social API in accounts mode (Postgres, migration 026): tenant
 * scoping on every route, tokens never returned, edit → safety check,
 * approve / "Not this one" (→ memory), the autonomy switch and pause, the
 * expiring public media link, and social media never served by asset id.
 */

const ORIGIN = "https://day2.test";
let t: Awaited<ReturnType<typeof createTestDatabase>>;
let work: string;
let data: string;
let tiktok: ReturnType<typeof Bun.serve>;
const saved: Record<string, string | undefined> = {};
const ENV = { DAY2_PUBLIC_URL: ORIGIN, DAY2_DEV_LOGIN: "on", DAY2_CREDITS: "off", DAY2_SECRETS_KEY: Buffer.alloc(32, 9).toString("base64"), DAY2_BACKLOG_TICK_MINUTES: "0", META_APP_ID: "1", META_APP_SECRET: "s" };

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "day2-social-api-"));
  data = mkdtempSync(join(tmpdir(), "day2-social-data-"));
  for (const [k, v] of Object.entries({ ...ENV, DAY2_DATA_DIR: data })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestDatabase();
  // day2's claims check (an agent run) → a fake: "Klasse 5" is a claim it can't back up; "BROKEN" makes it fail.
  setSocialClaimsCheck(async (creative) => {
    if (creative.body.includes("BROKEN")) throw new Error("agent down");
    return { creative, truthful: !creative.body.includes("Klasse 5"), issues: creative.body.includes("Klasse 5") ? ["says it's made for 5th grade"] : [] };
  });
  // A fake TikTok (token exchange and creator info).
  tiktok = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/v2/oauth/token/") return Response.json({ access_token: "TT-A", refresh_token: "TT-R", expires_in: 86400, open_id: "open1", scope: "user.info.basic,video.publish,video.upload,video.list" });
      if (u.pathname === "/v2/post/publish/creator_info/query/") return Response.json({ data: { creator_nickname: "Dotty TT", privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } });
      return new Response("not found", { status: 404 });
    },
  });
  for (const [k, v] of Object.entries({ TIKTOK_CONTENT_CLIENT_KEY: "ck", TIKTOK_CONTENT_CLIENT_SECRET: "cs", TIKTOK_CONTENT_API_BASE: `http://localhost:${tiktok.port}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(async () => {
  setSocialClaimsCheck(null);
  tiktok.stop(true);
  await t.drop();
  rmSync(work, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
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
  const ct = res.headers.get("content-type") ?? "";
  const text = ct.includes("json") ? await res.text() : "";
  return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, any>) : null, res };
}
async function devLogin(login: string) {
  const r = await call("POST", "/api/auth/dev", { body: { login } });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}

let alice: string;
let bob: string;
let appId: string;
const NOW = new Date();

function seedPost(over: Partial<Post>, assetId: string): Post {
  const iso = NOW.toISOString();
  return {
    id: "sp_api1",
    appId,
    group: "sg_api",
    status: "waiting_approval",
    kind: "video",
    language: "de",
    idea: { topic: "tip", hook: "question", title: "Vokabeln in 5 Minuten?", brandAngle: null, trend: null },
    source: { arm: "motion-graphics-short-video", armKey: "x", experimentId: null, made: "motion_template" },
    targets: [{ platform: "instagram", format: "reel", assetId, caption: "Kennst du das?", hashtags: ["lernen"], status: "pending", attempts: 0, metrics: [] }],
    scheduledAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    timeSlot: "evening",
    timeWhy: "A usual good time.",
    safety: { ok: true, issues: [], checkedAt: iso },
    tiktok: null,
    costCredits: 3,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

describe("Social API", () => {
  let assetId: string;
  test("setup: two accounts, alice's app with a post and a connected Page", async () => {
    alice = await devLogin("alice");
    bob = await devLogin("bob");
    process.env.DAY2_ALLOW_LOCAL_PATHS = "on";
    try {
      const r = await call("POST", "/api/apps", { cookie: alice, body: { name: "Dotty", repoPath: work, connectionMethod: "local_path" } });
      expect(r.status).toBe(201);
      appId = r.body!.app.id;
    } finally {
      delete process.env.DAY2_ALLOW_LOCAL_PATHS;
    }
    writeFileSync(join(work, "v.mp4"), new Uint8Array(64).fill(1));
    writeFileSync(join(work, ".day2-app-profile.json"), JSON.stringify({ purpose: "Vokabeln lernen", targetUsers: "Schüler", featureMap: ["Vokabeln üben"], styleGuide: null, toneOfVoice: null, businessModel: null, caveats: [], competitors: null, currentState: null, currentStateCaveat: "", scannedAt: new Date().toISOString() }));
    assetId = (await assetStore().put(join(work, "v.mp4"), { appId, purpose: "social:sg_api", label: "Motion video", kind: "video", ratio: "9:16", width: 1080, height: 1920, mime: "video/mp4", source: "motion_template", aiGenerated: false, aiPerson: false })).id;
    await dbSocialPosts(t.sql).insert(seedPost({}, assetId));
    await dbSocialAccounts(t.sql).save({ appId, network: "meta", meta: { pageId: "100200300", pageName: "Dotty", igUserId: "1784", igUsername: "dotty.app", igAccountType: null, scopes: ["instagram_basic", "instagram_content_publish", "pages_read_engagement", "pages_manage_posts", "pages_show_list"] }, tokens: { pageToken: "PAGE-TOKEN-NEVER-SHOWN" }, connectedBy: "alice" });
  });

  test("the owner sees connections and posts — never a token; another account sees nothing", async () => {
    const r = await call("GET", `/api/apps/${appId}/social`, { cookie: alice });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("PAGE-TOKEN");
    expect(r.body!.connections.meta).toMatchObject({ pageName: "Dotty", instagram: "dotty.app" });
    expect(r.body!.platforms.find((p: { id: string }) => p.id === "instagram")).toMatchObject({ connected: true, canPost: true });
    expect(r.body!.platforms.find((p: { id: string }) => p.id === "tiktok")).toMatchObject({ connected: false, canPost: false, serverReady: true });
    expect(r.body!.posts[0]).toMatchObject({ id: "sp_api1", status: "waiting_approval" });
    expect(r.body!.posts[0].targets[0].mediaUrl).toBe(`/api/apps/${appId}/social/media/${assetId}`);
    expect(r.body!.settings).toMatchObject({ autoPublish: false, paused: false, language: "en" });
    for (const [m, path, body] of [
      ["GET", `/api/apps/${appId}/social`, undefined],
      ["GET", `/api/apps/${appId}/social/media/${assetId}`, undefined],
      ["PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { targets: [{ format: "reel", caption: "hijack" }] }],
      ["POST", `/api/apps/${appId}/social/posts/sp_api1/approve`, {}],
      ["POST", `/api/apps/${appId}/social/posts/sp_api1/decline`, {}],
      ["PUT", `/api/apps/${appId}/social/settings`, { autoPublish: true }],
      ["POST", `/api/apps/${appId}/social/connect/meta`, {}],
      ["DELETE", `/api/apps/${appId}/social/accounts/meta`, undefined],
    ] as const)
      expect((await call(m, path, { cookie: bob, body })).status).toBe(404);
    expect((await call("GET", `/api/apps/${appId}/social`)).status).toBe(401);
  });

  test("the preview streams only for the app's own media", async () => {
    const r = await call("GET", `/api/apps/${appId}/social/media/${assetId}`, { cookie: alice });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("cache-control")).toContain("private");
  });

  test("social media is never public by asset id; only through an expiring link", async () => {
    expect((await call("GET", `/api/assets/${assetId}.mp4`)).status).toBe(404);
    const links = dbMediaLinks(t.sql);
    const l = await links.create(appId, assetId, new Date(Date.now() + 3_600_000));
    const ok = await call("GET", `/api/assets/${l.token}.mp4`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("video/mp4");
    await links.expireAsset(appId, assetId, new Date(Date.now() - 1000));
    expect((await call("GET", `/api/assets/${l.token}.mp4`)).status).toBe(404);
    expect((await call("GET", `/api/assets/sm_${"A".repeat(43)}.mp4`)).status).toBe(404);
  });

  test("edit: words per platform; a claim that can't be backed up holds the post until it's fixed", async () => {
    const bad = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "Die beste App, 100% garantiert" }] } });
    expect(bad.status).toBe(200);
    const p = bad.body!.posts[0];
    expect(p.status).toBe("draft");
    expect(p.safety.ok).toBe(false);
    expect((await call("POST", `/api/apps/${appId}/social/posts/sp_api1/approve`, { cookie: alice, body: {} })).status).toBe(409);
    const good = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "Vokabeln in 5 Minuten am Tag", hashtags: ["#lernen", "schule"] }] } });
    expect(good.body!.posts[0]).toMatchObject({ status: "waiting_approval", safety: { ok: true } });
    expect(good.body!.posts[0].targets[0]).toMatchObject({ caption: "Vokabeln in 5 Minuten am Tag", hashtags: ["lernen", "schule"] });
    expect((await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { scheduledAt: "2001-01-01T00:00:00Z" } })).status).toBe(409);
  });

  test("the claims check runs again on changed words; its findings stay until it passes", async () => {
    const r = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "Für Klasse 5 gemacht" }] } });
    expect(r.body!.posts[0]).toMatchObject({ status: "draft", safety: { ok: false, issues: ["Claims check: says it's made for 5th grade"] } });
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { scheduledAt: later } })).body!.posts[0].safety.ok).toBe(false);
    const broken = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "BROKEN check" }] } });
    expect(broken.body!.posts[0].safety.issues[0]).toContain("couldn't check the new words yet");
    expect((await call("POST", `/api/apps/${appId}/social/posts/sp_api1/approve`, { cookie: alice, body: {} })).status).toBe(409);
    const ok = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "Vokabeln in 5 Minuten am Tag" }] } });
    expect(ok.body!.posts[0]).toMatchObject({ status: "waiting_approval", safety: { ok: true } });
  });

  test("links: only the app's own smart link", async () => {
    const bad = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "Mehr auf https://evil.example/x" }] } });
    expect(bad.body!.posts[0].safety.issues.join()).toContain("a link that isn't the app's own");
    const own = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: `Hier laden: ${ORIGIN}/api/l/${appId}?d2=social` }] } });
    expect(own.body!.posts[0].safety.ok).toBe(true);
    await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "Vokabeln in 5 Minuten am Tag" }] } });
  });

  test("approve: goes out at its time", async () => {
    const r = await call("POST", `/api/apps/${appId}/social/posts/sp_api1/approve`, { cookie: alice, body: {} });
    expect(r.status).toBe(200);
    expect(r.body!.posts[0]).toMatchObject({ status: "approved", approvedBy: "alice" });
    expect((await call("POST", `/api/apps/${appId}/social/posts/sp_api1/approve`, { cookie: alice, body: {} })).status).toBe(409);
    expect((await dbSocialPosts(t.sql).get(appId, "sp_api1"))!.approvedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("an approved post: a new time keeps the approval, new words send it back to the owner", async () => {
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const r = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { scheduledAt: later } });
    expect(r.body!.posts[0]).toMatchObject({ status: "approved", approvedBy: "alice", scheduledAt: later });
    const w = await call("PATCH", `/api/apps/${appId}/social/posts/sp_api1`, { cookie: alice, body: { targets: [{ format: "reel", caption: "Vokabeln in 10 Minuten am Tag" }] } });
    expect(w.body!.posts[0]).toMatchObject({ status: "waiting_approval", approvedBy: null });
    expect((await dbSocialPosts(t.sql).get(appId, "sp_api1"))!.approvedHash).toBeNull();
  });

  test("a held-back draft can't be approved", async () => {
    await dbSocialPosts(t.sql).insert(seedPost({ id: "sp_api3", group: "sg3", status: "draft" }, assetId));
    expect((await call("POST", `/api/apps/${appId}/social/posts/sp_api3/approve`, { cookie: alice, body: {} })).status).toBe(409);
  });

  test("TikTok sign-in is bound to the browser that started it", async () => {
    const start = async () => {
      const r = await call("POST", `/api/apps/${appId}/social/connect/tiktok`, { cookie: alice, body: {} });
      expect(r.status).toBe(200);
      const c = r.headers.get("set-cookie")!;
      expect(c).toContain("HttpOnly");
      expect(c).toContain("SameSite=Lax");
      expect(c).toContain(`Path=/api/apps/${appId}/social/connect/tiktok`);
      return { bind: c.split(";")[0]!, state: new URL(r.body!.url).searchParams.get("state")! };
    };
    const back = async (state: string, code: string) => new URL((await call("GET", `/api/ads/connect/callback/tiktokposts?state=${state}&code=${code}`)).headers.get("location")!);
    const one = await start();
    const loc = await back(one.state, "CODE1");
    const pending1 = loc.searchParams.get("ttconnect")!;
    expect(pending1).toBeTruthy();
    expect(loc.toString()).not.toContain("CODE1");
    // A second callback for the same state can't swap the code: it ends the sign-in.
    expect((await back(one.state, "EVIL")).searchParams.get("connectError")).toBeTruthy();
    expect(await adConnections().pending(pending1)).toBeNull();
    const two = await start();
    const pending2 = (await back(two.state, "CODE2")).searchParams.get("ttconnect")!;
    const finish = (cookie: string) => call("POST", `/api/apps/${appId}/social/connect/tiktok/finish`, { cookie, body: { pending: pending2 } });
    expect((await finish(alice)).status).toBe(403); // no binding cookie: another browser
    expect((await finish(`${alice}; ${one.bind}`)).status).toBe(403); // another sign-in's cookie
    const carol = await devLogin("carol");
    expect((await finish(`${carol}; ${two.bind}`)).status).toBe(404); // another account
    const done = await finish(`${alice}; ${two.bind}`);
    expect(done.status).toBe(200);
    expect(done.body!.connections.tiktok).toMatchObject({ nickname: "Dotty TT" });
    expect(done.text).not.toContain("TT-A");
    expect((await finish(`${alice}; ${two.bind}`)).status).toBe(410); // single use
  });

  test('"Not this one" with a why: declined, and day2 remembers', async () => {
    await dbSocialPosts(t.sql).insert(seedPost({ id: "sp_api2", group: "sg_api2", idea: { topic: "fun", hook: "challenge", title: "Die Vokabel-Challenge", brandAngle: null, trend: null } }, assetId));
    const r = await call("POST", `/api/apps/${appId}/social/posts/sp_api2/decline`, { cookie: alice, body: { reason: "Keine Challenges bitte" } });
    expect(r.status).toBe(200);
    expect(r.body!.posts.find((p: { id: string }) => p.id === "sp_api2")).toMatchObject({ status: "declined", declinedReason: "Keine Challenges bitte" });
    const mem = await call("GET", `/api/apps/${appId}/memory`, { cookie: alice });
    expect(JSON.stringify(mem.body)).toContain("social.post");
  });

  test("settings: the autonomy switch lands in the autonomy settings; pause", async () => {
    const r = await call("PUT", `/api/apps/${appId}/social/settings`, { cookie: alice, body: { autoPublish: true, paused: true, language: "de" } });
    expect(r.body!.settings).toEqual({ autoPublish: true, paused: true, platforms: null, language: "de" });
    expect(JSON.parse(readFileSync(join(work, ".day2-autonomy.json"), "utf-8")).channels).toEqual({ socialPosts: "auto" });
    expect(existsSync(join(work, "day2-social.json"))).toBe(true);
    const meta = await call("POST", `/api/apps/${appId}/social/connect/meta`, { cookie: alice, body: {} });
    expect(meta.status).toBe(200);
    const u = new URL(meta.body!.url);
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/ads/connect/callback/meta`);
    expect(u.searchParams.get("scope")).toContain("instagram_content_publish");
    expect(u.searchParams.get("config_id")).toBeNull();
    // A Business-type Meta app: the Facebook Login for Business configuration replaces the scope list.
    process.env.META_LOGIN_CONFIG_ID = "5591455221080623";
    try {
      const c = await call("POST", `/api/apps/${appId}/social/connect/meta`, { cookie: alice, body: {} });
      const cu = new URL(c.body!.url);
      expect(cu.searchParams.get("config_id")).toBe("5591455221080623");
      expect(cu.searchParams.get("override_default_response_type")).toBe("true");
      expect(cu.searchParams.get("response_type")).toBe("code");
      expect(cu.searchParams.get("scope")).toBeNull();
      expect(cu.searchParams.get("state")).toBeTruthy();
    } finally {
      delete process.env.META_LOGIN_CONFIG_ID;
    }
  });

  test("TikTok's callback is public, refuses unknown sign-ins, and lands back on the console", async () => {
    const r = await call("GET", "/api/ads/connect/callback/tiktokposts?state=nope&code=x");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("connectError=");
  });

  test("disconnect removes the account", async () => {
    const r = await call("DELETE", `/api/apps/${appId}/social/accounts/meta`, { cookie: alice });
    expect(r.body!.connections.meta).toBeNull();
  });
});
