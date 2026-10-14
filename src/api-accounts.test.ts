import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./db/test-db";
import { handleRequest } from "./api-server";
import { dbIntegrations } from "./integrations-store";
import { clearTokenCache } from "./github-app";
import { setMailSender, type Mail } from "./mail";
import { connectorMcpServers, connectorStatuses, dbConnectors } from "./connectors";
import { generateKeyPairSync } from "node:crypto";

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
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "day2-test",
  GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
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

  function fakeGitHub(user: { id: number; login: string; email?: string }, installations: number[]) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "ghu_user" });
      if (url.endsWith("/user")) return Response.json({ id: user.id, login: user.login, name: null, email: null, avatar_url: null });
      if (url.endsWith("/user/emails")) return Response.json(user.email ? [{ email: user.email, primary: true, verified: true }] : []);
      if (url.includes("/user/installations")) return Response.json({ installations: installations.map((id) => ({ id })) });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  const stateFrom = (location: string | null) => new URL(location!).searchParams.get("state")!;

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

  test("Connect GitHub: only for the person who started it, and only an installation GitHub confirms", async () => {
    fakeGitHub({ id: 502, login: "frank" }, [777]);
    const frank = cookieFrom((await call("GET", `/api/auth/github/callback?code=c&state=${stateFrom((await call("GET", "/api/auth/github")).headers.get("location"))}`)).headers);

    const startInstall = async () => {
      const r = await call("POST", "/api/github/install", { cookie: frank, body: { next: "/setup" } });
      expect(r.status).toBe(200);
      expect(r.body!.url).toStartWith("https://github.com/apps/day2-test/installations/new?state=");
      return new URL(r.body!.url).searchParams.get("state")!;
    };

    // Without frank's session (another browser / someone else): refused.
    const s1 = await startInstall();
    const noSession = await call("GET", `/api/auth/github/callback?code=c&state=${s1}&installation_id=777&setup_action=install`);
    expect(noSession.headers.get("location")).toContain("/login?error=");

    // Someone else's installation id: refused.
    const s2 = await startInstall();
    const refused = await call("GET", `/api/auth/github/callback?code=c&state=${s2}&installation_id=999&setup_action=install`, { cookie: frank });
    expect(refused.headers.get("location")).toStartWith(`${ORIGIN}/setup?github=`);
    expect(refused.headers.get("location")).not.toContain("github=connected");
    expect((await call("GET", "/api/me", { cookie: frank })).body!.github.connected).toBe(false);

    // Their own: linked; no new session needed.
    const s3 = await startInstall();
    const linked = await call("GET", `/api/auth/github/callback?code=c&state=${s3}&installation_id=777&setup_action=install`, { cookie: frank });
    expect(linked.headers.get("location")).toBe(`${ORIGIN}/setup?github=connected`);
    expect(linked.headers.get("set-cookie")).toBeNull();
    expect((await call("GET", "/api/me", { cookie: frank })).body!.github.connected).toBe(true);
  });

  test("someone who signed in by email can connect GitHub, and later sign in with it", async () => {
    const mail: Mail[] = [];
    setMailSender(async (m) => void mail.push(m));
    try {
      expect((await call("POST", "/api/auth/email", { body: { email: "Gina@Example.com", next: "/apps" } })).status).toBe(200);
      const token = new URL(/https:\/\/\S+/.exec(mail.at(-1)!.text)![0]).searchParams.get("token")!;
      const gina = cookieFrom((await call("POST", "/api/auth/email/verify", { body: { token } })).headers);

      fakeGitHub({ id: 503, login: "gina-gh", email: "other@example.com" }, [888]);
      const r = await call("POST", "/api/github/install", { cookie: gina, body: {} });
      const state = new URL(r.body!.url).searchParams.get("state")!;
      const linked = await call("GET", `/api/auth/github/callback?code=c&state=${state}&installation_id=888`, { cookie: gina });
      expect(linked.headers.get("location")).toContain("github=connected");

      // "Continue with GitHub" now opens the same person and workspace.
      const before = (await call("GET", "/api/me", { cookie: gina })).body!;
      const s = stateFrom((await call("GET", "/api/auth/github")).headers.get("location"));
      const viaGitHub = cookieFrom((await call("GET", `/api/auth/github/callback?code=c&state=${s}`)).headers);
      const after = (await call("GET", "/api/me", { cookie: viaGitHub })).body!;
      expect(after.user.id).toBe(before.user.id);
      expect(after.account.id).toBe(before.account.id);
      expect(after.user.login).toBe("gina-gh");
    } finally {
      setMailSender(null);
    }
  });
});

describe("sign-in without GitHub", () => {
  const realFetch = globalThis.fetch;
  let mail: Mail[] = [];
  beforeAll(() => setMailSender(async (m) => void mail.push(m)));
  afterAll(() => {
    setMailSender(null);
    globalThis.fetch = realFetch;
  });

  const linkToken = () => {
    const url = /https:\/\/\S+/.exec(mail.at(-1)!.text)![0];
    expect(url).toStartWith(`${ORIGIN}/login/link?token=`);
    return new URL(url).searchParams.get("token")!;
  };

  test("the login page knows which ways in exist", async () => {
    expect((await call("GET", "/api/features")).body!.signIn).toEqual({ github: true, google: true, email: true, dev: true });
  });

  test("email link: one use, the right person, the same answer for any address", async () => {
    mail = [];
    expect((await call("POST", "/api/auth/email", { body: { email: "not-an-email" } })).status).toBe(400);
    const r = await call("POST", "/api/auth/email", { body: { email: "hana@example.com", next: "/credits" } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe("hana@example.com");
    const token = linkToken();
    // Only the token's hash is stored.
    expect(await t.sql`SELECT 1 FROM email_sign_in WHERE token_hash = ${token}`).toHaveLength(0);

    const ok = await call("POST", "/api/auth/email/verify", { body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, next: "/credits" });
    const me = await call("GET", "/api/me", { cookie: cookieFrom(ok.headers) });
    expect(me.body).toMatchObject({ user: { login: null, email: "hana@example.com" }, account: { role: "owner" } });

    const again = await call("POST", "/api/auth/email/verify", { body: { token } });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: "link_expired" });
    expect((await call("POST", "/api/auth/email/verify", { body: { token: "made-up" } })).status).toBe(400);
  });

  test("an expired link doesn't work", async () => {
    mail = [];
    await call("POST", "/api/auth/email", { body: { email: "ivan@example.com" } });
    const token = linkToken();
    await t.sql`UPDATE email_sign_in SET expires_at = now() - interval '1 minute' WHERE lower(email) = 'ivan@example.com'`;
    expect((await call("POST", "/api/auth/email/verify", { body: { token } })).status).toBe(400);
  });

  test("too many links for one address: still 'check your email', but no more mail", async () => {
    mail = [];
    for (let i = 0; i < 7; i++) expect((await call("POST", "/api/auth/email", { body: { email: "flood@example.com" } })).status).toBe(200);
    expect(mail).toHaveLength(5);
  });

  test("Google: verified email joins the person who used an email link; unverified doesn't", async () => {
    mail = [];
    await call("POST", "/api/auth/email", { body: { email: "jo@example.com" } });
    const jo = cookieFrom((await call("POST", "/api/auth/email/verify", { body: { token: linkToken() } })).headers);
    const joMe = (await call("GET", "/api/me", { cookie: jo })).body!;

    const googleAs = async (profile: Record<string, unknown>) => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.x" });
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json(profile);
        return new Response("nope", { status: 404 });
      }) as typeof fetch;
      const start = await call("GET", "/api/auth/google?next=/apps");
      const to = new URL(start.headers.get("location")!);
      expect(to.origin).toBe("https://accounts.google.com");
      expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
      const back = await call("GET", `/api/auth/google/callback?code=c&state=${to.searchParams.get("state")}`);
      expect(back.headers.get("location")).toBe(`${ORIGIN}/apps`);
      return (await call("GET", "/api/me", { cookie: cookieFrom(back.headers) })).body!;
    };

    const viaGoogle = await googleAs({ sub: "g-1", email: "JO@example.com", email_verified: true, name: "Jo Park", picture: "https://p/jo" });
    expect(viaGoogle.user.id).toBe(joMe.user.id);
    expect(viaGoogle.account.id).toBe(joMe.account.id);
    expect(viaGoogle.user.name).toBe("Jo Park");

    const unverified = await googleAs({ sub: "g-2", email: "jo@example.com", email_verified: false, name: "Not Jo" });
    expect(unverified.user.id).not.toBe(joMe.user.id);

    // A Google state can't be replayed on the GitHub callback.
    const s = new URL((await call("GET", "/api/auth/google")).headers.get("location")!).searchParams.get("state");
    expect((await call("GET", `/api/auth/github/callback?code=c&state=${s}`)).headers.get("location")).toContain("/login?error=");
  });

  test("invite by email: they get an email, and join when they sign in with that address", async () => {
    mail = [];
    await call("POST", "/api/auth/email", { body: { email: "kai@example.com" } });
    const kai = cookieFrom((await call("POST", "/api/auth/email/verify", { body: { token: linkToken() } })).headers);
    expect((await call("PUT", "/api/credits/plan", { cookie: kai, body: { plan: "growth" } })).status).toBe(200);

    mail = [];
    const inv = await call("POST", "/api/account/invites", { cookie: kai, body: { email: "Lee@Example.com", role: "admin" } });
    expect(inv.status).toBe(201);
    expect(inv.body!.emailed).toBe(true);
    expect(inv.body!.invites).toEqual([expect.objectContaining({ email: "lee@example.com", login: null, role: "admin" })]);
    expect(mail[0]).toMatchObject({ to: "lee@example.com" });
    expect(mail[0]!.subject).toContain("invited you");

    await call("POST", "/api/auth/email", { body: { email: "lee@example.com" } });
    const lee = cookieFrom((await call("POST", "/api/auth/email/verify", { body: { token: linkToken() } })).headers);
    const leeMe = (await call("GET", "/api/me", { cookie: lee })).body!;
    const kaiMe = (await call("GET", "/api/me", { cookie: kai })).body!;
    expect(leeMe.account).toMatchObject({ id: kaiMe.account.id, role: "admin" });
    expect((await call("POST", "/api/account/invites", { cookie: kai, body: { email: "nope@" } })).status).toBe(400);
  });
});

describe("the tools day2 runs for everyone", () => {
  test("day2's own accounts: stored encrypted, connected by operators only, shown to customers without tokens", async () => {
    const store = dbConnectors(t.sql);
    await store.update("foreplay", () => ({ tokens: { access_token: "fp_SECRET_TOKEN", token_type: "Bearer" }, connectedAt: "2026-10-14T00:00:00Z" }));
    const [row] = (await t.sql`SELECT data_enc FROM platform_connectors WHERE connector_id = 'foreplay'`) as Array<{ data_enc: string }>;
    expect(row!.data_enc).not.toContain("SECRET");
    const servers = await connectorMcpServers(store, ["competitor_research"], "https://day2.test/api/connectors/callback");
    expect(servers.foreplay).toMatchObject({ type: "http", headers: { Authorization: "Bearer fp_SECRET_TOKEN" } });

    const customer = await devLogin("cust1");
    const tools = await call("GET", "/api/connectors", { cookie: customer });
    expect(tools.body!.tools.find((x: { id: string }) => x.id === "foreplay")).toMatchObject({ active: true });
    expect(JSON.stringify(tools.body)).not.toContain("SECRET");
    expect((await call("GET", "/api/platform/tools", { cookie: customer })).status).toBe(403);
    expect((await call("POST", "/api/platform/tools/foreplay/connect", { cookie: customer })).status).toBe(403);
    expect((await call("GET", "/api/me", { cookie: customer })).body!.operator).toBe(false);

    process.env.DAY2_OPERATOR_LOGINS = "opsperson";
    try {
      const op = await devLogin("opsperson");
      expect((await call("GET", "/api/me", { cookie: op })).body!.operator).toBe(true);
      expect((await call("GET", "/api/platform/tools", { cookie: op })).body!.tools[0]).toMatchObject({ id: "foreplay", connected: true });
      // Every app, across workspaces, with its Facebook Page.
      const apps = await call("GET", "/api/platform/apps", { cookie: op });
      const anApp = apps.body!.apps[0];
      expect(anApp).toMatchObject({ metaPageId: null });
      expect((await call("PUT", `/api/platform/apps/${anApp.id}/ad-identity`, { cookie: op, body: { metaPageId: "not a page" } })).status).toBe(400);
      expect((await call("PUT", `/api/platform/apps/${anApp.id}/ad-identity`, { cookie: op, body: { metaPageId: "123456789" } })).status).toBe(200);
      const after = await call("GET", "/api/platform/apps", { cookie: op });
      expect(after.body!.apps.find((a: { id: string }) => a.id === anApp.id).metaPageId).toBe("123456789");
    } finally {
      delete process.env.DAY2_OPERATOR_LOGINS;
    }
  });
});
