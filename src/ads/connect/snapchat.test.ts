import { describe, expect, test } from "bun:test";
import { scriptedFetch, noSleep, type Expect } from "../test-helpers";
import { PlatformError } from "../types";
import { connect } from "./snapchat";

const app = { clientId: "cid", clientSecret: "csecret" };
const NOW = new Date("2026-10-28T12:00:00.000Z");
const deps = (f: ReturnType<typeof scriptedFetch>) => ({ fetch: f.fetch, sleep: noSleep, now: () => NOW });
const tokens = { accessToken: "atok", refreshToken: "rtok", expiresAt: NOW.getTime() + 3_600_000 };
const bearer = (r: { headers: Record<string, string> }) => expect(r.headers.authorization).toBe("Bearer atok");

const orgs: Expect = {
  method: "GET",
  url: "https://adsapi.snapchat.com/v1/me/organizations?with_ad_accounts=true",
  check: bearer,
  json: {
    request_status: "SUCCESS",
    organizations: [
      {
        sub_request_status: "SUCCESS",
        organization: {
          id: "org1",
          name: "day2",
          ad_accounts: [
            { id: "acct1", name: "day2 EUR", currency: "EUR", status: "ACTIVE" },
            { id: "acct2", name: "Pending", currency: "USD", status: "PENDING" },
          ],
        },
      },
      { sub_request_status: "SUCCESS", organization: { id: "org2", name: "Buddy GmbH", ad_accounts: [] } },
    ],
  },
};

describe("snapchat connect", () => {
  test("appCredentials", () => {
    expect(connect.appCredentials({ SNAP_CLIENT_ID: "a", SNAP_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b" });
    expect(connect.appCredentials({ SNAP_CLIENT_ID: "a" })).toBeNull();
  });

  test("authorizeUrl", async () => {
    const { url } = await connect.authorizeUrl(app, { state: "st", redirectUri: "https://day2.example/cb", purpose: "account" });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.snapchat.com/login/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "https://day2.example/cb",
      response_type: "code",
      scope: "snapchat-marketing-api snapchat-profile-api",
      state: "st",
    });
  });

  test("exchange", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://accounts.snapchat.com/login/oauth2/access_token",
        check: (r) =>
          expect(r.json).toEqual({ grant_type: "authorization_code", code: "c0de", redirect_uri: "https://day2.example/cb", client_id: "cid", client_secret: "csecret" }),
        json: { access_token: "atok", refresh_token: "rtok", expires_in: 3600, token_type: "Bearer", scope: "snapchat-marketing-api snapchat-profile-api" },
      },
    ]);
    const t = await connect.exchange(app, { query: { code: "c0de", state: "st" }, redirectUri: "https://day2.example/cb" }, deps(f));
    expect(t).toEqual({ accessToken: "atok", refreshToken: "rtok", expiresAt: NOW.getTime() + 3_600_000, scopes: ["snapchat-marketing-api", "snapchat-profile-api"] });
    await expect(connect.exchange(app, { query: { error: "access_denied" }, redirectUri: "x" })).rejects.toBeInstanceOf(PlatformError);
  });

  test("listAdAccounts refreshes an expired token first", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "/login/oauth2/access_token",
        check: (r) => expect(r.json).toEqual({ grant_type: "refresh_token", refresh_token: "rtok", client_id: "cid", client_secret: "csecret" }),
        json: { access_token: "atok", expires_in: 3600 },
      },
      orgs,
    ]);
    const list = await connect.listAdAccounts(app, { ...tokens, expiresAt: NOW.getTime() - 1 }, deps(f));
    expect(list).toEqual([
      { id: "acct1", name: "day2 EUR", currency: "EUR", canSpend: true },
      { id: "acct2", name: "Pending", currency: "USD", canSpend: false, problem: "ad account status is PENDING" },
    ]);
    expect(f.done()).toBe(true);
  });

  test("listIdentities lists Public Profiles per organization, with paging, skipping denied orgs", async () => {
    const f = scriptedFetch([
      orgs,
      {
        method: "GET",
        url: "https://businessapi.snapchat.com/v1/organizations/org1/public_profiles?limit=50",
        check: bearer,
        json: {
          request_status: "SUCCESS",
          public_profiles: [{ id: "prof_1", display_name: "day2" }],
          paging: { next_link: "https://businessapi.snapchat.com/v1/organizations/org1/public_profiles?cursor=abc" },
        },
      },
      { method: "GET", url: "cursor=abc", json: { request_status: "SUCCESS", public_profiles: [{ public_profile: { id: "prof_2", display_name: "Buddy" } }] } },
      { method: "GET", url: "/organizations/org2/public_profiles", status: 403, json: { request_status: "ERROR", error_code: "AUTHORIZATION_PERMISSION_DENIED" } },
    ]);
    const list = await connect.listIdentities!(app, tokens, deps(f));
    expect(list).toEqual([
      { ref: "prof_1", name: "day2", kind: "public_profile" },
      { ref: "prof_2", name: "Buddy", kind: "public_profile" },
    ]);
    expect(f.done()).toBe(true);
  });

  test("no grantIdentity (profile API is read-only)", () => {
    expect(connect.grantIdentity).toBeUndefined();
  });

  test("credentials", () => {
    expect(connect.credentials(app, tokens, "acct1")).toEqual({ clientId: "cid", clientSecret: "csecret", refreshToken: "rtok", adAccountId: "acct1" });
    expect(() => connect.credentials(app, { accessToken: "a" }, "acct1")).toThrow("refresh token");
  });
});
