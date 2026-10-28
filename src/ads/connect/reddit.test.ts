import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, type Expect, type Recorded } from "../test-helpers";
import { PlatformError } from "../types";
import { connect } from "./reddit";

const UA = "server:day2-ads-test:1.0 (by /u/day2ops)";
const app = { clientId: "cid", clientSecret: "csecret", userAgent: UA };
const NOW = new Date("2026-10-28T12:00:00.000Z");
const BASE = "https://ads-api.reddit.com/api/v3";

const deps = (script: Expect[]) => {
  const f = scriptedFetch(script);
  return { f, deps: { fetch: f.fetch, sleep: noSleep, now: () => NOW } };
};
const authed = (token = "atok") => (r: Recorded) => {
  expect(r.headers.authorization).toBe(`Bearer ${token}`);
  expect(r.headers["user-agent"]).toBe(UA);
};

describe("reddit connect", () => {
  test("appCredentials from env; null when missing", () => {
    expect(connect.appCredentials({})).toBeNull();
    expect(connect.appCredentials({ REDDIT_CLIENT_ID: "cid" })).toBeNull();
    expect(connect.appCredentials({ REDDIT_CLIENT_ID: "cid", REDDIT_CLIENT_SECRET: "csecret", REDDIT_USER_AGENT: UA })).toEqual(app);
    expect(connect.appCredentials({ REDDIT_CLIENT_ID: "cid", REDDIT_CLIENT_SECRET: "csecret" })!.userAgent).toContain("day2");
    expect(connect.appEnv).toEqual(expect.arrayContaining(["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]));
  });

  test("authorizeUrl: permanent, comma-separated scopes by purpose", async () => {
    const { url } = await connect.authorizeUrl(app, { state: "st1", redirectUri: "https://day2.example/cb", purpose: "account" });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://www.reddit.com/api/v1/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid",
      response_type: "code",
      state: "st1",
      redirect_uri: "https://day2.example/cb",
      duration: "permanent",
      scope: "adsread,adsedit,adsconversions",
    });
    const id = new URL((await connect.authorizeUrl(app, { state: "st2", redirectUri: "https://day2.example/cb", purpose: "identity" })).url);
    expect(id.searchParams.get("scope")).toBe("adsread");
  });

  test("exchange: Basic auth + User-Agent, strips the trailing #_ from the code", async () => {
    const { f, deps: d } = deps([
      {
        method: "POST",
        url: "https://www.reddit.com/api/v1/access_token",
        check: (r) => {
          expect(r.headers.authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
          expect(r.headers["user-agent"]).toBe(UA);
          expect(r.json).toEqual({ grant_type: "authorization_code", code: "abc", redirect_uri: "https://day2.example/cb" });
        },
        json: { access_token: "atok", token_type: "bearer", expires_in: 86400, refresh_token: "rtok", scope: "adsread adsedit adsconversions" },
      },
    ]);
    const t = await connect.exchange(app, { query: { code: "abc#_", state: "st1" }, redirectUri: "https://day2.example/cb" }, d);
    expect(t).toEqual({ accessToken: "atok", refreshToken: "rtok", expiresAt: NOW.getTime() + 86_400_000, scopes: ["adsread", "adsedit", "adsconversions"] });
    expect(f.done()).toBe(true);
  });

  test("exchange: a denied authorization is a PlatformError", async () => {
    const { deps: d } = deps([]);
    await expect(connect.exchange(app, { query: { error: "access_denied" }, redirectUri: "https://day2.example/cb" }, d)).rejects.toBeInstanceOf(PlatformError);
  });

  test("listAdAccounts: businesses → ad accounts (paginated), currency and spendability", async () => {
    const { f, deps: d } = deps([
      { method: "GET", url: `${BASE}/me/businesses?page.size=100`, check: authed(), json: { data: [{ id: "biz_1" }, { id: "biz_2" }], pagination: { next_url: null } } },
      {
        method: "GET",
        url: `${BASE}/businesses/biz_1/ad_accounts?page.size=100`,
        check: authed(),
        json: { data: [{ id: "a2_one", name: "Main", currency: "usd", admin_approval: "APPROVED" }], pagination: { next_url: `${BASE}/businesses/biz_1/ad_accounts?page.token=p2` } },
      },
      { method: "GET", url: `${BASE}/businesses/biz_1/ad_accounts?page.token=p2`, json: { data: [{ id: "a2_two", name: "EU", currency: "EUR", suspension_reason: "BILLING" }] } },
      { method: "GET", url: `${BASE}/businesses/biz_2/ad_accounts`, json: { data: [{ id: "a2_one", name: "Main", currency: "USD" }, { id: "a2_three", currency: "GBP", admin_approval: "PENDING" }] } },
    ]);
    expect(await connect.listAdAccounts(app, { accessToken: "atok", expiresAt: NOW.getTime() + 3_600_000 }, d)).toEqual([
      { id: "a2_one", name: "Main", currency: "USD", canSpend: true },
      { id: "a2_two", name: "EU", currency: "EUR", canSpend: false, problem: "suspended by Reddit (BILLING)" },
      { id: "a2_three", name: "a2_three", currency: "GBP", canSpend: false, problem: "awaiting Reddit's approval" },
    ]);
    expect(f.done()).toBe(true);
  });

  test("listIdentities: the business's profiles, refreshing an expired access token first", async () => {
    const { f, deps: d } = deps([
      { method: "POST", url: "access_token", check: (r) => expect(r.json).toEqual({ grant_type: "refresh_token", refresh_token: "rtok" }), json: { access_token: "fresh", expires_in: 3600 } },
      { method: "GET", url: "/me/businesses", check: authed("fresh"), json: { data: [{ id: "biz_1" }] } },
      { method: "GET", url: `${BASE}/businesses/biz_1/profiles?page.size=100`, check: authed("fresh"), json: { data: [{ id: "t2_buddy", name: "BuddyApp" }, { id: "t2_raw", username: "rawuser" }] } },
    ]);
    const ids = await connect.listIdentities!(app, { accessToken: "stale", refreshToken: "rtok", expiresAt: NOW.getTime() - 1 }, d);
    expect(ids).toEqual([
      { ref: "t2_buddy", name: "BuddyApp", kind: "profile" },
      { ref: "t2_raw", name: "u/rawuser", kind: "profile" },
    ]);
    expect(f.done()).toBe(true);
  });

  test("credentials: the adapter's creds; refuses without a refresh token", () => {
    expect(connect.credentials(app, { accessToken: "atok", refreshToken: "rtok" }, "a2_one")).toEqual({ clientId: "cid", clientSecret: "csecret", refreshToken: "rtok", adAccountId: "a2_one", userAgent: UA });
    expect(() => connect.credentials(app, { accessToken: "atok" }, "a2_one")).toThrow(PlatformError);
  });
});
