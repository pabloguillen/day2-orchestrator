import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./db/test-db";
import { handleRequest } from "./api-server";
import { dbIntegrations } from "./integrations-store";
import { clearTokenCache } from "./github-app";

/**
 * The API in accounts mode (production): sign-in, sessions, account
 * isolation, roles and the CSRF origin check — through `handleRequest`
 * against a real, throwaway Postgres database.
 */

const ORIGIN = "https://day2.test";
let t: Awaited<ReturnType<typeof createTestDatabase>>;
let work: string;
const saved: Record<string, string | undefined> = {};
const ENV = {
  DAY2_PUBLIC_URL: ORIGIN,
  DAY2_DEV_LOGIN: "on",
  DAY2_CREDITS: "off",
  DAY2_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "secret",
  DAY2_BACKLOG_TICK_MINUTES: "0",
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestDatabase();
  work = mkdtempSync(join(tmpdir(), "day2-accounts-"));
});
afterAll(async () => {
  await t.drop();
  rmSync(work, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Opts = { cookie?: string; body?: unknown; origin?: string | null };

async function call(method: string, path: string, opts: Opts = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin && method !== "GET") headers.origin = origin;
  const res = await handleRequest(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

function cookieFrom(headers: Headers): string {
  const c = headers.get("set-cookie");
  if (!c) throw new Error("no cookie set");
  return c.split(";")[0]!;
}

async function devLogin(login: string): Promise<string> {
  const r = await call("POST", "/api/auth/dev", { body: { login } });
  expect(r.status).toBe(200);
  return cookieFrom(r.headers);
}

describe("signed out", () => {
  test("account data needs a session; feature flags don't", async () => {
    const r = await call("GET", "/api/apps");
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: "signed_out" });
    expect((await call("GET", "/api/features")).status).toBe(200);
    expect((await call("GET", "/api/me")).status).toBe(401);
    expect((await call("GET", "/api/apps", { cookie: "day2_session=forged" })).status).toBe(401);
  });

  test("state-changing requests from another origin are refused", async () => {
    expect((await call("POST", "/api/auth/dev", { body: { login: "x" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/auth/dev", { body: { login: "x" }, origin: null })).status).toBe(403);
  });
});

describe("accounts", () => {
  let alice: string;
  let bob: string;
  let appId: string;

  test("each person gets their own account; /api/me says who and where", async () => {
    alice = await devLogin("alice");
    bob = await devLogin("bob");
    const me = await call("GET", "/api/me", { cookie: alice });
    expect(me.body).toMatchObject({ mode: "accounts", user: { login: "alice" }, account: { role: "owner" }, github: { connected: false } });
    const cookie = (await call("POST", "/api/auth/dev", { body: { login: "alice" } })).headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  test("server folders can't be connected in production; GitHub needs connecting first", async () => {
    const r = await call("POST", "/api/apps", { cookie: alice, body: { name: "Buddy", repoPath: "/etc", connectionMethod: "local_path" } });
    expect(r.status).toBe(400);
    const gh = await call("GET", "/api/github/repos", { cookie: alice });
    expect(gh.status).toBe(409);
    expect(gh.body).toMatchObject({ code: "github_not_connected" });
  });

  test("one account's apps and credits are invisible to another", async () => {
    process.env.DAY2_ALLOW_LOCAL_PATHS = "on";
    try {
      const r = await call("POST", "/api/apps", { cookie: alice, body: { name: "Buddy", repoPath: work, connectionMethod: "local_path" } });
      expect(r.status).toBe(201);
      appId = r.body!.app.id;
    } finally {
      delete process.env.DAY2_ALLOW_LOCAL_PATHS;
    }
    expect((await call("GET", "/api/apps", { cookie: alice })).body!.apps).toHaveLength(1);
    expect((await call("GET", "/api/apps", { cookie: bob })).body!.apps).toHaveLength(0);
    for (const path of [`/api/apps/${appId}/backlog`, `/api/apps/${appId}/integrations`, `/api/apps/${appId}/growth/config`]) {
      expect((await call("GET", path, { cookie: bob })).status).toBe(404);
    }
    expect((await call("DELETE", `/api/apps/${appId}`, { cookie: bob })).status).toBe(200); // a no-op for bob…
    expect((await call("GET", "/api/apps", { cookie: alice })).body!.apps).toHaveLength(1); // …alice's app is untouched

    expect((await call("PUT", "/api/credits/plan", { cookie: alice, body: { plan: "growth" } })).status).toBe(200);
    expect((await call("GET", "/api/credits", { cookie: alice })).body!.plan.id).toBe("growth");
    expect((await call("GET", "/api/credits", { cookie: bob })).body!.plan.id).toBe("trial");
  });

  test("invites, roles and switching accounts", async () => {
    const inv = await call("POST", "/api/account/invites", { cookie: alice, body: { login: "bob", role: "member" } });
    expect(inv.status).toBe(201);
    expect(inv.body!.members.map((m: { login: string }) => m.login)).toEqual(["alice", "bob"]);
    expect(inv.body!.seats).toEqual({ used: 2, limit: 3 });

    const me = await call("GET", "/api/me", { cookie: bob });
    const aliceAccount = me.body!.accounts.find((a: { role: string }) => a.role === "member");
    expect(aliceAccount).toBeDefined();
    expect((await call("POST", "/api/auth/switch", { cookie: bob, body: { accountId: aliceAccount.id } })).status).toBe(200);
    expect((await call("GET", "/api/apps", { cookie: bob })).body!.apps.map((a: { id: string }) => a.id)).toEqual([appId]);

    // A member can work, but not change billing, people or remove apps.
    expect((await call("PUT", "/api/credits/plan", { cookie: bob, body: { plan: "scale" } })).status).toBe(403);
    expect((await call("POST", "/api/account/invites", { cookie: bob, body: { login: "carol" } })).status).toBe(403);
    expect((await call("DELETE", `/api/apps/${appId}`, { cookie: bob })).status).toBe(403);
    expect((await call("GET", `/api/apps/${appId}/backlog`, { cookie: bob })).status).toBe(200);

    // Switching into an account you're not in is refused.
    const bobOwn = me.body!.accounts.find((a: { role: string }) => a.role === "owner");
    expect((await call("POST", "/api/auth/switch", { cookie: alice, body: { accountId: bobOwn.id } })).status).toBe(404);

    // Removed → that session no longer reaches alice's account.
    const bobId = inv.body!.members.find((m: { login: string }) => m.login === "bob").userId;
    expect((await call("DELETE", `/api/account/members/${bobId}`, { cookie: alice })).status).toBe(200);
    expect((await call("GET", "/api/apps", { cookie: bob })).status).toBe(401);
  });

  test("logout ends the session", async () => {
    const c = await devLogin("dave");
    expect((await call("POST", "/api/auth/logout", { cookie: c })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: c })).status).toBe(401);
  });

  test("tracker tokens are stored encrypted and scoped to the account", async () => {
    const [acct] = (await t.sql`SELECT account_id FROM apps WHERE id = ${appId}`) as Array<{ account_id: string }>;
    const [other] = (await t.sql`INSERT INTO accounts (name) VALUES ('Other') RETURNING id`) as Array<{ id: string }>;
    const mine = dbIntegrations(t.sql, acct!.account_id);
    await mine.update(appId, () => ({ linear: { apiKey: "lin_api_SECRET", teamKey: "EXP", mirror: true } }));
    expect((await mine.get(appId))?.linear?.apiKey).toBe("lin_api_SECRET");
    const [row] = (await t.sql`SELECT data_enc FROM app_integrations WHERE app_id = ${appId}`) as Array<{ data_enc: string }>;
    expect(row!.data_enc).not.toContain("SECRET");
    expect(row!.data_enc.startsWith("v1.")).toBe(true);
    const theirs = dbIntegrations(t.sql, other!.id);
    expect(await theirs.get(appId)).toBeUndefined();
    await expect(theirs.update(appId, () => ({}))).rejects.toThrow("No app registered");
    const pub = await call("GET", `/api/apps/${appId}/integrations`, { cookie: alice });
    expect(JSON.stringify(pub.body)).not.toContain("SECRET");
  });
});

describe("GitHub sign-in and Connect GitHub", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
    clearTokenCache();
  });

  function fakeGitHub(user: { id: number; login: string }, installations: number[]) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "ghu_user" });
      if (url.endsWith("/user")) return Response.json({ ...user, name: null, email: "x@example.com", avatar_url: null });
      if (url.includes("/user/installations")) return Response.json({ installations: installations.map((id) => ({ id })) });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("sign-in round trip: state is checked, a session cookie is set", async () => {
    const start = await call("GET", "/api/auth/github?next=/apps");
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(to.origin).toBe("https://github.com");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/github/callback`);
    const state = to.searchParams.get("state")!;

    fakeGitHub({ id: 501, login: "erin" }, []);
    const bad = await call("GET", `/api/auth/github/callback?code=c&state=forged`);
    expect(bad.headers.get("location")).toContain("/login?error=");
    expect(bad.headers.get("set-cookie")).toBeNull();

    const ok = await call("GET", `/api/auth/github/callback?code=c&state=${state}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/apps`);
    const me = await call("GET", "/api/me", { cookie: cookieFrom(ok.headers) });
    expect(me.body).toMatchObject({ user: { login: "erin" }, account: { role: "owner" } });
    // The state was single-use.
    expect((await call("GET", `/api/auth/github/callback?code=c&state=${state}`)).headers.get("location")).toContain("/login?error=");
  });

  test("an installation is linked only when GitHub confirms the person can see it", async () => {
    fakeGitHub({ id: 502, login: "frank" }, [777]);
    const s1 = new URL((await call("GET", "/api/auth/github")).headers.get("location")!).searchParams.get("state")!;
    const first = await call("GET", `/api/auth/github/callback?code=c&state=${s1}`);
    const frank = cookieFrom(first.headers);

    // Someone else's installation id: refused.
    const s2 = new URL((await call("GET", "/api/auth/github")).headers.get("location")!).searchParams.get("state")!;
    const refused = await call("GET", `/api/auth/github/callback?code=c&state=${s2}&installation_id=999&setup_action=install`);
    expect(refused.headers.get("location")).toContain("github=");
    expect(refused.headers.get("location")).not.toContain("github=connected");
    expect((await call("GET", "/api/me", { cookie: frank })).body!.github.connected).toBe(false);

    // Their own: linked to their account.
    const s3 = new URL((await call("GET", "/api/auth/github")).headers.get("location")!).searchParams.get("state")!;
    const linked = await call("GET", `/api/auth/github/callback?code=c&state=${s3}&installation_id=777&setup_action=install`);
    expect(linked.headers.get("location")).toContain("github=connected");
    expect((await call("GET", "/api/me", { cookie: cookieFrom(linked.headers) })).body!.github.connected).toBe(true);
  });
});
