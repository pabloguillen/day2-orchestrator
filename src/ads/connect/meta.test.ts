import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, type Recorded } from "../test-helpers";
import { META_API_VERSION } from "../platforms/meta";
import { PlatformError } from "../types";
import { connect } from "./meta";

const G = `https://graph.facebook.com/${META_API_VERSION}`;
const app = { appId: "app1", appSecret: "appsecret", businessId: "biz1" };
const owner = { accessToken: "OWNERTOKEN" };
const day2 = { tokens: { accessToken: "DAY2TOKEN", userId: "su1" }, adAccountId: "act_123" };
const body = (r: Recorded) => r.json as Record<string, string>;
const q = (r: Recorded) => Object.fromEntries(new URL(r.url).searchParams);

describe("meta connect", () => {
  test("appCredentials", () => {
    expect(connect.appCredentials({})).toBeNull();
    expect(connect.appCredentials({ META_APP_ID: "a" })).toBeNull();
    expect(connect.appCredentials({ META_APP_ID: "a", META_APP_SECRET: "s" })).toEqual({ appId: "a", appSecret: "s" });
    expect(connect.appCredentials({ META_APP_ID: "a", META_APP_SECRET: "s", DAY2_META_BUSINESS_ID: "b" })).toEqual({ appId: "a", appSecret: "s", businessId: "b" });
    expect(connect.appEnv).toEqual(["META_APP_ID", "META_APP_SECRET"]);
  });

  test("authorizeUrl asks for ads scopes or page scopes", async () => {
    const a = new URL((await connect.authorizeUrl(app, { state: "st", redirectUri: "https://day2.example/cb", purpose: "account" })).url);
    expect(a.origin + a.pathname).toBe(`https://www.facebook.com/${META_API_VERSION}/dialog/oauth`);
    expect(Object.fromEntries(a.searchParams)).toEqual({
      client_id: "app1",
      redirect_uri: "https://day2.example/cb",
      state: "st",
      response_type: "code",
      scope: "ads_management,ads_read,business_management",
    });
    const i = new URL((await connect.authorizeUrl(app, { state: "st", redirectUri: "https://day2.example/cb", purpose: "identity" })).url);
    expect(i.searchParams.get("scope")).toBe("pages_show_list,pages_read_engagement,instagram_basic,business_management");
    expect(i.toString()).not.toContain("appsecret");
  });

  test("exchange: code → short-lived → long-lived token, user id and granted scopes", async () => {
    const f = scriptedFetch([
      {
        method: "GET",
        url: `${G}/oauth/access_token`,
        check: (r) => expect(q(r)).toEqual({ client_id: "app1", client_secret: "appsecret", redirect_uri: "https://day2.example/cb", code: "CODE" }),
        json: { access_token: "SHORT", token_type: "bearer", expires_in: 5000 },
      },
      {
        method: "GET",
        url: `${G}/oauth/access_token`,
        check: (r) => expect(q(r)).toEqual({ client_id: "app1", client_secret: "appsecret", grant_type: "fb_exchange_token", fb_exchange_token: "SHORT" }),
        json: { access_token: "LONG", token_type: "bearer", expires_in: 5183944 },
      },
      { url: `${G}/me?fields=id`, check: (r) => expect(r.headers.authorization).toBe("OAuth LONG"), json: { id: "u1" } },
      { url: `${G}/me/permissions`, json: { data: [{ permission: "ads_management", status: "granted" }, { permission: "ads_read", status: "declined" }] } },
    ]);
    const now = new Date("2026-10-28T00:00:00Z");
    const t = await connect.exchange(app, { query: { code: "CODE", state: "st" }, redirectUri: "https://day2.example/cb" }, { fetch: f.fetch, sleep: noSleep, now: () => now });
    expect(t).toEqual({ accessToken: "LONG", expiresAt: now.getTime() + 5183944_000, userId: "u1", scopes: ["ads_management"] });
    // appsecret_proof = HMAC-SHA256(token, app secret) on Graph calls
    expect(q(f.calls[2]!).appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
    expect(f.done()).toBe(true);
  });

  test("exchange: a declined login is an error", async () => {
    const f = scriptedFetch([]);
    await expect(connect.exchange(app, { query: { error: "access_denied", error_description: "Permissions error" }, redirectUri: "x" }, { fetch: f.fetch })).rejects.toThrow("Permissions error");
  });

  test("exchange: a failed code exchange never leaks the app secret", async () => {
    const f = scriptedFetch([{ url: "/oauth/access_token", status: 400, json: { error: { message: "Invalid verification code format.", code: 100 } } }]);
    const err = await connect.exchange(app, { query: { code: "bad" }, redirectUri: "x" }, { fetch: f.fetch, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).toContain("Invalid verification code format.");
    expect(err.message).not.toContain("appsecret");
  });

  test("listAdAccounts maps currency and status", async () => {
    const f = scriptedFetch([
      {
        url: `${G}/me/adaccounts?fields=id%2Cname%2Ccurrency%2Caccount_status%2Cdisable_reason&limit=100`,
        json: { data: [{ id: "act_1", name: "Main", currency: "EUR", account_status: 1 }, { id: "act_2", name: "Old", currency: "JPY", account_status: 101 }] },
      },
    ]);
    expect(await connect.listAdAccounts(app, owner, { fetch: f.fetch, sleep: noSleep })).toEqual([
      { id: "act_1", name: "Main", currency: "EUR", canSpend: true },
      { id: "act_2", name: "Old", currency: "JPY", canSpend: false, problem: "closed" },
    ]);
  });

  test("listIdentities: Pages the person can advertise for, plus linked Instagram", async () => {
    const f = scriptedFetch([
      {
        url: `${G}/me/accounts?fields=id%2Cname%2Ctasks%2Cinstagram_business_account%7Bid%2Cusername%7D&limit=100`,
        json: { data: [
          { id: "777", name: "Buddy", tasks: ["ADVERTISE", "MANAGE"], instagram_business_account: { id: "888", username: "buddyapp" } },
          { id: "778", name: "Fan page", tasks: ["MODERATE"] },
        ] },
      },
    ]);
    expect(await connect.listIdentities!(app, owner, { fetch: f.fetch, sleep: noSleep })).toEqual([
      { ref: "777", name: "Buddy", kind: "facebook_page" },
      { ref: "777:888", name: "Buddy + Instagram @buddyapp", kind: "facebook_page_instagram" },
    ]);
  });

  test("grantIdentity: requests Page access for day2's business → pending", async () => {
    const f = scriptedFetch([
      { url: "/me/accounts", check: (r) => expect(r.headers.authorization).toBe("OAuth OWNERTOKEN"), json: { data: [{ id: "777", name: "Buddy", tasks: ["ADVERTISE"] }] } },
      { url: "/me/accounts", check: (r) => expect(r.headers.authorization).toBe("OAuth DAY2TOKEN"), json: { data: [] } },
      { url: `${G}/biz1/client_pages?fields=id`, json: { data: [] } },
      { url: `${G}/biz1/pending_client_pages`, json: { data: [] } },
      {
        method: "POST",
        url: `${G}/biz1/client_pages`,
        check: (r) => {
          expect(r.headers.authorization).toBe("OAuth DAY2TOKEN");
          expect(body(r)).toEqual({ page_id: "777", permitted_tasks: '["ADVERTISE","ANALYZE"]' });
        },
        json: { access_status: "PENDING" },
      },
    ]);
    const r = await connect.grantIdentity!(app, owner, "777:888", day2, { fetch: f.fetch, sleep: noSleep });
    expect(r).toEqual({ status: "pending", todo: expect.stringContaining("Meta Business Suite → Requests") });
    expect(f.done()).toBe(true);
  });

  test("grantIdentity: request already pending → pending, no new request", async () => {
    const f = scriptedFetch([
      { url: "/me/accounts", json: { data: [{ id: "777", tasks: ["ADVERTISE"] }] } },
      { url: "/me/accounts", json: { data: [] } },
      { url: "/biz1/client_pages", json: { data: [] } },
      { url: "/biz1/pending_client_pages", json: { data: [{ id: "req1", page: { id: "777" } }] } },
    ]);
    expect((await connect.grantIdentity!(app, owner, "777", day2, { fetch: f.fetch, sleep: noSleep })).status).toBe("pending");
    expect(f.done()).toBe(true);
  });

  test("grantIdentity: approved client Page → assigns day2's system user → ready", async () => {
    const f = scriptedFetch([
      { url: "/me/accounts", json: { data: [{ id: "777", tasks: ["ADVERTISE"] }] } },
      { url: "/me/accounts", json: { data: [{ id: "777", tasks: ["ANALYZE"] }] } },
      { url: "/biz1/client_pages", json: { data: [{ id: "777" }] } },
      { method: "POST", url: `${G}/777/assigned_users`, check: (r) => expect(body(r)).toEqual({ user: "su1", tasks: '["ADVERTISE","ANALYZE"]', business: "biz1" }), json: { success: true } },
    ]);
    expect(await connect.grantIdentity!(app, owner, "777", day2, { fetch: f.fetch, sleep: noSleep })).toEqual({ status: "ready" });
    expect(f.done()).toBe(true);
  });

  test("grantIdentity: already usable → ready without changes", async () => {
    const f = scriptedFetch([
      { url: "/me/accounts", json: { data: [{ id: "777", tasks: ["ADVERTISE"] }] } },
      { url: "/me/accounts", json: { data: [{ id: "777", tasks: ["ADVERTISE", "ANALYZE"] }] } },
    ]);
    expect(await connect.grantIdentity!(app, owner, "777", day2, { fetch: f.fetch, sleep: noSleep })).toEqual({ status: "ready" });
    expect(f.done()).toBe(true);
  });

  test("grantIdentity: refuses a Page the person doesn't manage, or without a business id", async () => {
    const f = scriptedFetch([{ url: "/me/accounts", json: { data: [] } }]);
    await expect(connect.grantIdentity!(app, owner, "777", day2, { fetch: f.fetch, sleep: noSleep })).rejects.toThrow("you don't manage Page 777");
    await expect(connect.grantIdentity!({ appId: "a", appSecret: "s" }, owner, "777", day2, { fetch: f.fetch })).rejects.toThrow("DAY2_META_BUSINESS_ID");
  });

  test("credentials → MetaCreds", () => {
    expect(connect.credentials(app, { accessToken: "T" }, "123")).toEqual({ accessToken: "T", adAccountId: "act_123", appSecret: "appsecret", apiVersion: META_API_VERSION });
    expect(() => connect.credentials(app, { accessToken: "T" }, "nope")).toThrow("not a Meta ad account id");
  });
});
