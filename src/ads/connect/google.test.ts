import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, type Expect } from "../test-helpers";
import { PlatformError } from "../types";
import { ADWORDS_SCOPE, DATAMANAGER_SCOPE, connect } from "./google";

const app = { clientId: "cid.apps.googleusercontent.com", clientSecret: "csecret", developerToken: "dev-tok", loginCustomerId: "9998887776" };
const NOW = new Date("2026-10-28T10:00:00.000Z");
const ADS = "https://googleads.googleapis.com/v26";
const CUSTOMER_Q = "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.status, customer.manager, customer.test_account FROM customer";

describe("google connect: app credentials", () => {
  test("from env; developer token and MCC optional", () => {
    expect(connect.appCredentials({ GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "s" })).toEqual({ clientId: "c", clientSecret: "s" });
    expect(
      connect.appCredentials({ GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "s", GOOGLE_ADS_DEVELOPER_TOKEN: "d", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999-888-7776" }),
    ).toEqual({ clientId: "c", clientSecret: "s", developerToken: "d", loginCustomerId: "9998887776" });
    expect(connect.appCredentials({ GOOGLE_ADS_CLIENT_ID: "c" })).toBeNull();
    expect(connect.appCredentials({ GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "s", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "12" })).toBeNull();
    expect(connect.appEnv).toContain("GOOGLE_ADS_CLIENT_ID");
  });
});

describe("google connect: OAuth", () => {
  test("authorize URL asks for offline adwords access with consent", async () => {
    const { url, pending } = await connect.authorizeUrl(app, { state: "st-1", redirectUri: "https://day2.example/connect/google/callback", purpose: "account" });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: app.clientId,
      redirect_uri: "https://day2.example/connect/google/callback",
      response_type: "code",
      scope: `${ADWORDS_SCOPE} ${DATAMANAGER_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: "st-1",
    });
    expect(pending).toBeUndefined();
    const identity = await connect.authorizeUrl(app, { state: "s", redirectUri: "https://x/cb", purpose: "identity" });
    expect(new URL(identity.url).searchParams.get("scope")).toBe(ADWORDS_SCOPE);
  });

  test("exchange posts the code and returns tokens with a refresh token", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://oauth2.googleapis.com/token",
        check: (r) =>
          expect(r.json).toEqual({ grant_type: "authorization_code", code: "4/abc", client_id: app.clientId, client_secret: "csecret", redirect_uri: "https://day2.example/cb" }),
        json: { access_token: "ya29.a", refresh_token: "1//r", expires_in: 3599, scope: `${ADWORDS_SCOPE} ${DATAMANAGER_SCOPE}`, token_type: "Bearer" },
      },
    ]);
    const t = await connect.exchange(app, { query: { code: "4/abc", state: "st-1" }, redirectUri: "https://day2.example/cb" }, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    expect(t).toEqual({ accessToken: "ya29.a", refreshToken: "1//r", expiresAt: NOW.getTime() + 3599_000, scopes: [ADWORDS_SCOPE, DATAMANAGER_SCOPE] });
    expect(f.done()).toBe(true);
  });

  test("exchange fails on denial, missing scope or missing refresh token", async () => {
    await expect(connect.exchange(app, { query: { error: "access_denied" }, redirectUri: "x" })).rejects.toBeInstanceOf(PlatformError);
    const tok = (json: object) => scriptedFetch([{ method: "POST", url: "oauth2.googleapis.com/token", json }]).fetch;
    await expect(
      connect.exchange(app, { query: { code: "c" }, redirectUri: "x" }, { fetch: tok({ access_token: "a", refresh_token: "r", scope: "openid email" }), sleep: noSleep }),
    ).rejects.toThrow(/not granted/);
    await expect(connect.exchange(app, { query: { code: "c" }, redirectUri: "x" }, { fetch: tok({ access_token: "a", scope: ADWORDS_SCOPE }), sleep: noSleep })).rejects.toThrow(
      /refresh token/,
    );
  });
});

describe("google connect: ad accounts", () => {
  const authed = (login?: string) => (r: { headers: Record<string, string> }) => {
    expect(r.headers.authorization).toBe("Bearer ya29.a");
    expect(r.headers["developer-token"]).toBe("dev-tok");
    expect(r.headers["login-customer-id"]).toBe(login as string);
  };
  const customer = (id: string, c: object): Expect => ({
    method: "POST",
    url: `${ADS}/customers/${id}/googleAds:search`,
    check: (r) => {
      authed()(r);
      expect((r.json as { query: string }).query).toBe(CUSTOMER_Q);
    },
    json: { results: [{ customer: { id, ...c } }] },
  });

  test("lists direct accounts with currency, flags managers, adds their clients as client@manager", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://oauth2.googleapis.com/token",
        check: (r) => expect((r.json as Record<string, string>).grant_type).toBe("refresh_token"),
        json: { access_token: "ya29.a", expires_in: 3599 },
      },
      { method: "GET", url: `${ADS}/customers:listAccessibleCustomers`, check: authed(), json: { resourceNames: ["customers/1112223334", "customers/9998887776", "customers/5556667778"] } },
      customer("1112223334", { descriptiveName: "Own shop", currencyCode: "EUR", status: "ENABLED", manager: false, testAccount: false }),
      customer("9998887776", { descriptiveName: "day2 MCC", currencyCode: "USD", status: "ENABLED", manager: true, testAccount: false }),
      { method: "POST", url: `${ADS}/customers/5556667778/googleAds:search`, status: 403, json: { error: { code: 403, status: "PERMISSION_DENIED", message: "CUSTOMER_NOT_ENABLED" } } },
      {
        method: "POST",
        url: `${ADS}/customers/9998887776/googleAds:search`,
        check: (r) => {
          authed("9998887776")(r);
          expect((r.json as { query: string }).query).toContain("FROM customer_client WHERE customer_client.level >= 1");
        },
        json: {
          results: [
            { customerClient: { id: "1234567890", descriptiveName: "day2 ads", currencyCode: "USD", status: "ENABLED", manager: false, testAccount: false, level: "1" } },
            { customerClient: { id: "1112223334", descriptiveName: "Own shop", currencyCode: "EUR", status: "ENABLED", manager: false, level: "1" } },
            { customerClient: { id: "4445556667", descriptiveName: "Sub MCC", currencyCode: "USD", status: "ENABLED", manager: true, level: "1" } },
            { customerClient: { id: "7778889990", descriptiveName: "Closed", currencyCode: "USD", status: "CANCELED", manager: false, level: "2" } },
          ],
        },
      },
    ]);
    const list = await connect.listAdAccounts(app, { accessToken: "old", refreshToken: "1//r", expiresAt: NOW.getTime() - 1 }, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    expect(list).toEqual([
      { id: "1112223334", name: "Own shop", currency: "EUR", canSpend: true },
      { id: "9998887776", name: "day2 MCC", currency: "USD", canSpend: false, problem: "manager (MCC) account: pick one of its client accounts" },
      { id: "5556667778", name: "5556667778", currency: "", canSpend: false, problem: "account can't be read (cancelled or not enabled)" },
      { id: "1234567890@9998887776", name: "day2 ads", currency: "USD", canSpend: true },
      { id: "7778889990@9998887776", name: "Closed", currency: "USD", canSpend: false, problem: "account status is CANCELED" },
    ]);
    expect(f.done()).toBe(true);
  });

  test("no identities for Google", () => {
    expect(connect.listIdentities).toBeUndefined();
    expect(connect.grantIdentity).toBeUndefined();
  });
});

describe("google connect: credentials", () => {
  test("builds adapter credentials, with the manager as login-customer-id", () => {
    expect(connect.credentials(app, { accessToken: "a", refreshToken: "1//r" }, "1234567890@9998887776")).toEqual({
      developerToken: "dev-tok",
      clientId: app.clientId,
      clientSecret: "csecret",
      refreshToken: "1//r",
      customerId: "1234567890",
      loginCustomerId: "9998887776",
      apiVersion: "v26",
    });
    expect(connect.credentials({ clientId: "c", clientSecret: "s" }, { accessToken: "a", refreshToken: "r" }, "1112223334")).toMatchObject({
      customerId: "1112223334",
      loginCustomerId: undefined,
      developerToken: undefined,
    });
    expect(() => connect.credentials(app, { accessToken: "a" }, "1234567890")).toThrow(PlatformError);
    expect(() => connect.credentials(app, { accessToken: "a", refreshToken: "r" }, "abc")).toThrow(PlatformError);
  });
});
