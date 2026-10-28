import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, type Expect } from "../test-helpers";
import { PlatformError } from "../types";
import { connect } from "./linkedin";
import type { Tokens } from "./types";

const NOW = new Date("2026-10-28T12:00:00Z");
const app = { clientId: "cid", clientSecret: "csecret", apiVersion: "202610" };
const deps = (f: ReturnType<typeof scriptedFetch>) => ({ fetch: f.fetch, sleep: noSleep, now: () => NOW });
const owner: Tokens = { accessToken: "at_owner", expiresAt: NOW.getTime() + 3_600_000 };
const day2Tokens: Tokens = { accessToken: "at_day2", refreshToken: "rt_day2", expiresAt: NOW.getTime() + 3_600_000, userId: "d2" };
const auth = (token: string) => (r: { headers: Record<string, string> }) => {
  expect(r.headers.authorization).toBe(`Bearer ${token}`);
  expect(r.headers["linkedin-version"]).toBe("202610");
  expect(r.headers["x-restli-protocol-version"]).toBe("2.0.0");
};

describe("linkedin connect", () => {
  test("appCredentials", () => {
    expect(connect.appCredentials({})).toBeNull();
    expect(connect.appCredentials({ LINKEDIN_CLIENT_ID: "a" })).toBeNull();
    expect(connect.appCredentials({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b", apiVersion: "202610" });
    expect(connect.appCredentials({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b", LINKEDIN_API_VERSION: "202609" })?.apiVersion).toBe("202609");
  });

  test("authorizeUrl asks for scopes per purpose", async () => {
    const a = new URL((await connect.authorizeUrl(app, { state: "s1", redirectUri: "https://day2.example/cb", purpose: "account" })).url);
    expect(a.origin + a.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(Object.fromEntries(a.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "https://day2.example/cb",
      state: "s1",
      scope: "rw_ads r_ads_reporting w_organization_social rw_conversions",
    });
    const i = new URL((await connect.authorizeUrl(app, { state: "s2", redirectUri: "https://day2.example/cb", purpose: "identity" })).url);
    expect(i.searchParams.get("scope")).toBe("rw_organization_admin");
  });

  test("exchange stores tokens, expiry and the member id", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://www.linkedin.com/oauth/v2/accessToken",
        check: (r) =>
          expect(r.json).toEqual({ grant_type: "authorization_code", code: "c1", client_id: "cid", client_secret: "csecret", redirect_uri: "https://day2.example/cb" }),
        json: { access_token: "at_1", expires_in: 5184000, refresh_token: "rt_1", refresh_token_expires_in: 31536000, scope: "rw_ads,r_ads_reporting,w_organization_social,rw_conversions" },
      },
      {
        method: "GET",
        url: "https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser",
        check: auth("at_1"),
        json: { elements: [{ account: "urn:li:sponsoredAccount:5001", role: "ACCOUNT_MANAGER", user: "urn:li:person:d2" }] },
      },
    ]);
    const t = await connect.exchange(app, { query: { code: "c1", state: "s1" }, redirectUri: "https://day2.example/cb" }, deps(f));
    expect(f.done()).toBe(true);
    expect(t).toEqual({
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresAt: NOW.getTime() + 5184000 * 1000,
      scopes: ["rw_ads", "r_ads_reporting", "w_organization_social", "rw_conversions"],
      userId: "d2",
    });
  });

  test("exchange: identity purpose takes the member id from Page roles; callback errors throw", async () => {
    const f = scriptedFetch([
      { method: "POST", url: "/oauth/v2/accessToken", json: { access_token: "at_o", expires_in: 100, scope: "rw_organization_admin" } },
      { method: "GET", url: "/rest/organizationAcls?q=roleAssignee&count=1", json: { elements: [{ roleAssignee: "urn:li:person:own", role: "ADMINISTRATOR" }] } },
    ]);
    const t = await connect.exchange(app, { query: { code: "c2" }, redirectUri: "https://day2.example/cb" }, deps(f));
    expect(t.userId).toBe("own");
    expect(t.refreshToken).toBeUndefined();
    await expect(connect.exchange(app, { query: { error: "user_cancelled_authorize" }, redirectUri: "x" })).rejects.toBeInstanceOf(PlatformError);
  });

  test("listAdAccounts with currency and spend readiness", async () => {
    const f = scriptedFetch([
      {
        method: "GET",
        url: "/rest/adAccountUsers?q=authenticatedUser",
        check: auth("at_day2"),
        json: {
          elements: [
            { account: "urn:li:sponsoredAccount:5001", role: "ACCOUNT_BILLING_ADMIN", user: "urn:li:person:d2" },
            { account: "urn:li:sponsoredAccount:5002", role: "VIEWER", user: "urn:li:person:d2" },
            { account: "urn:li:sponsoredAccount:5003", role: "CAMPAIGN_MANAGER", user: "urn:li:person:d2" },
          ],
        },
      },
      { method: "GET", url: "/rest/adAccounts/5001", json: { name: "day2 EUR", currency: "EUR", status: "ACTIVE", servingStatuses: ["RUNNABLE"] } },
      { method: "GET", url: "/rest/adAccounts/5002", json: { name: "viewer", currency: "USD", status: "ACTIVE", servingStatuses: ["RUNNABLE"] } },
      { method: "GET", url: "/rest/adAccounts/5003", json: { name: "held", currency: "USD", status: "ACTIVE", servingStatuses: ["BILLING_HOLD"] } },
    ]);
    const out = await connect.listAdAccounts(app, day2Tokens, deps(f));
    expect(f.done()).toBe(true);
    expect(out[0]).toEqual({ id: "5001", name: "day2 EUR", currency: "EUR", canSpend: true });
    expect(out[1]!.canSpend).toBe(false);
    expect(out[1]!.problem).toMatch(/VIEWER/);
    expect(out[2]).toEqual({ id: "5003", name: "held", currency: "USD", canSpend: false, problem: "ad account is not serving (BILLING_HOLD)" });
  });

  test("listAdAccounts refreshes an expired access token", async () => {
    const f = scriptedFetch([
      { method: "POST", url: "/oauth/v2/accessToken", check: (r) => expect((r.json as Record<string, string>).grant_type).toBe("refresh_token"), json: { access_token: "at_new", expires_in: 100 } },
      { method: "GET", url: "/rest/adAccountUsers?q=authenticatedUser", check: auth("at_new"), json: { elements: [] } },
    ]);
    expect(await connect.listAdAccounts(app, { ...day2Tokens, expiresAt: NOW.getTime() - 1 }, deps(f))).toEqual([]);
    expect(f.done()).toBe(true);
  });

  test("listIdentities: Pages where the member is super admin or sponsored content poster", async () => {
    const f = scriptedFetch([
      {
        method: "GET",
        url: "/rest/organizationAcls?q=roleAssignee&state=APPROVED&start=0&count=100",
        check: auth("at_owner"),
        json: {
          elements: [
            { role: "ADMINISTRATOR", organization: "urn:li:organization:777", roleAssignee: "urn:li:person:own", state: "APPROVED" },
            { role: "ANALYST", organization: "urn:li:organization:888", roleAssignee: "urn:li:person:own", state: "APPROVED" },
            { role: "DIRECT_SPONSORED_CONTENT_POSTER", organizationTarget: "urn:li:organization:999", roleAssignee: "urn:li:person:own", state: "APPROVED" },
          ],
        },
      },
      { method: "GET", url: "/rest/organizations/777", json: { localizedName: "Buddy Inc" } },
      { method: "GET", url: "/rest/organizations/999", status: 403, json: { message: "denied" } },
    ]);
    expect(await connect.listIdentities!(app, owner, deps(f))).toEqual([
      { ref: "urn:li:organization:777", name: "Buddy Inc", kind: "company_page" },
      { ref: "urn:li:organization:999", name: "urn:li:organization:999", kind: "company_page" },
    ]);
    expect(f.done()).toBe(true);
  });

  const orgAcls = (elements: unknown[]): Expect => ({
    method: "GET",
    url: "/rest/organizationAcls?q=organization&organization=urn%3Ali%3Aorganization%3A777&start=0&count=100",
    check: auth("at_owner"),
    json: { elements },
  });

  test("grantIdentity: already approved → ready", async () => {
    const f = scriptedFetch([orgAcls([{ role: "DIRECT_SPONSORED_CONTENT_POSTER", organization: "urn:li:organization:777", roleAssignee: "urn:li:person:d2", state: "APPROVED" }])]);
    expect(await connect.grantIdentity!(app, owner, "urn:li:organization:777", { tokens: day2Tokens, adAccountId: "5001" }, deps(f))).toEqual({ status: "ready" });
    expect(f.done()).toBe(true);
  });

  test("grantIdentity: files day2's role request, then pending until the owner approves", async () => {
    const f = scriptedFetch([
      orgAcls([{ role: "ADMINISTRATOR", organization: "urn:li:organization:777", roleAssignee: "urn:li:person:own", state: "APPROVED" }]),
      {
        method: "PUT",
        url: "/rest/organizationAcls/(organization:urn%3Ali%3Aorganization%3A777,role:DIRECT_SPONSORED_CONTENT_POSTER,roleAssignee:urn%3Ali%3Aperson%3Ad2)",
        check: (r) => {
          auth("at_day2")(r);
          expect(r.json).toEqual({ state: "REQUESTED", role: "DIRECT_SPONSORED_CONTENT_POSTER", roleAssignee: "urn:li:person:d2", organization: "urn:li:organization:777" });
        },
      },
      // A second call sees the open request and doesn't file another.
      orgAcls([{ role: "DIRECT_SPONSORED_CONTENT_POSTER", organization: "urn:li:organization:777", roleAssignee: "urn:li:person:d2", state: "REQUESTED" }]),
    ]);
    const r1 = await connect.grantIdentity!(app, owner, "777", { tokens: day2Tokens, adAccountId: "5001" }, deps(f));
    expect(r1.status).toBe("pending");
    expect(r1.todo).toMatch(/Sponsored Content Poster/);
    const r2 = await connect.grantIdentity!(app, owner, "777", { tokens: day2Tokens, adAccountId: "5001" }, deps(f));
    expect(r2.status).toBe("pending");
    expect(f.done()).toBe(true);
  });

  test("grantIdentity: owner isn't a super admin / day2 member unknown", async () => {
    const f = scriptedFetch([{ method: "GET", url: "/rest/organizationAcls?q=organization", status: 403, json: { message: "Not enough permissions" } }]);
    await expect(connect.grantIdentity!(app, owner, "777", { tokens: day2Tokens, adAccountId: "5001" }, deps(f))).rejects.toThrow(/isn't a Super admin/);
    await expect(connect.grantIdentity!(app, owner, "777", { tokens: { accessToken: "x" }, adAccountId: "5001" }, deps(f))).rejects.toThrow(/member id is unknown/);
  });

  test("credentials", () => {
    expect(connect.credentials(app, day2Tokens, "urn:li:sponsoredAccount:5001")).toEqual({
      clientId: "cid",
      clientSecret: "csecret",
      refreshToken: "rt_day2",
      adAccountId: "5001",
      apiVersion: "202610",
    });
    expect(() => connect.credentials(app, { accessToken: "x" }, "5001")).toThrow(PlatformError);
  });
});
