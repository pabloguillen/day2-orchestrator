import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch } from "../test-helpers";
import { PlatformError } from "../types";
import { connect } from "./pinterest";

const API = "https://api.pinterest.com/v5";
const app = { clientId: "cid", clientSecret: "csecret" };
const NOW = new Date("2026-10-28T12:00:00Z");

describe("pinterest connect", () => {
  test("appCredentials from env", () => {
    expect(connect.appCredentials({})).toBeNull();
    expect(connect.appCredentials({ PINTEREST_CLIENT_ID: "cid" })).toBeNull();
    expect(connect.appCredentials({ PINTEREST_CLIENT_ID: "cid", PINTEREST_CLIENT_SECRET: "csecret" })).toEqual(app);
    expect(connect.appEnv).toEqual(["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"]);
  });

  test("authorizeUrl", async () => {
    const { url, pending } = await connect.authorizeUrl(app, { state: "st_1", redirectUri: "https://day2.example/connect/pinterest/callback", purpose: "account" });
    expect(pending).toBeUndefined();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "https://day2.example/connect/pinterest/callback",
      response_type: "code",
      scope: "ads:read,ads:write,pins:read,pins:write,boards:read,boards:write,user_accounts:read",
      state: "st_1",
    });
    await expect(connect.authorizeUrl(app, { state: "s", redirectUri: "https://x", purpose: "identity" })).rejects.toBeInstanceOf(PlatformError);
  });

  test("exchange: code → access + refresh token with expiry, user id", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: `${API}/oauth/token`,
        check: (r) => {
          expect(r.headers["authorization"]).toBe(`Basic ${btoa("cid:csecret")}`);
          expect(r.json).toEqual({ grant_type: "authorization_code", code: "c0de", redirect_uri: "https://day2.example/cb" });
        },
        json: {
          access_token: "pina_x",
          refresh_token: "pinr_y",
          token_type: "bearer",
          expires_in: 2592000,
          refresh_token_expires_in: 5184000,
          scope: "ads:read,ads:write,pins:read,pins:write,boards:read,boards:write,user_accounts:read",
        },
      },
      { method: "GET", url: `${API}/user_account`, check: (r) => expect(r.headers["authorization"]).toBe("Bearer pina_x"), json: { id: "1234", username: "day2" } },
    ]);
    const tokens = await connect.exchange(app, { query: { code: "c0de", state: "st_1" }, redirectUri: "https://day2.example/cb" }, { fetch: f.fetch, sleep: noSleep, now: () => NOW });
    expect(tokens).toEqual({
      accessToken: "pina_x",
      refreshToken: "pinr_y",
      expiresAt: NOW.getTime() + 2592000 * 1000,
      scopes: ["ads:read", "ads:write", "pins:read", "pins:write", "boards:read", "boards:write", "user_accounts:read"],
      userId: "1234",
    });
    expect(f.done()).toBe(true);
  });

  test("exchange: denied authorization", async () => {
    await expect(connect.exchange(app, { query: { error: "access_denied" }, redirectUri: "https://x" })).rejects.toThrow("access_denied");
  });

  test("listAdAccounts: owned + shared, currency, role → canSpend, paginated", async () => {
    const f = scriptedFetch([
      {
        method: "GET",
        url: `${API}/ad_accounts?`,
        check: (r) => {
          const u = new URL(r.url);
          expect(u.searchParams.get("include_shared_accounts")).toBe("true");
          expect(r.headers["authorization"]).toBe("Bearer pina_x");
        },
        json: {
          items: [
            { id: "1", name: "day2 EUR", currency: "EUR", owner: { id: "1234", username: "day2" }, permissions: ["OWNER"] },
            { id: "2", name: "client", currency: "USD", owner: { id: "999" }, permissions: ["ANALYST"] },
          ],
          bookmark: "bm1",
        },
      },
      {
        method: "GET",
        url: `${API}/ad_accounts?`,
        check: (r) => expect(new URL(r.url).searchParams.get("bookmark")).toBe("bm1"),
        json: { items: [{ id: "3", name: "agency", currency: "GBP", permissions: ["CAMPAIGN_MANAGER", "ANALYST"] }], bookmark: null },
      },
    ]);
    const list = await connect.listAdAccounts(app, { accessToken: "pina_x", refreshToken: "pinr_y", expiresAt: NOW.getTime() + 1000_000 }, { fetch: f.fetch, now: () => NOW });
    expect(list).toEqual([
      { id: "1", name: "day2 EUR", currency: "EUR", canSpend: true },
      { id: "2", name: "client", currency: "USD", canSpend: false, problem: expect.stringContaining("ANALYST") },
      { id: "3", name: "agency", currency: "GBP", canSpend: true },
    ]);
    expect(f.done()).toBe(true);
  });

  test("listAdAccounts: expired access token asks to reconnect", async () => {
    const f = scriptedFetch([]);
    await expect(connect.listAdAccounts(app, { accessToken: "pina_x", expiresAt: NOW.getTime() - 1 }, { fetch: f.fetch, now: () => NOW })).rejects.toThrow("reconnect");
  });

  test("credentials → PinterestCreds", () => {
    expect(connect.credentials(app, { accessToken: "pina_x", refreshToken: "pinr_y" }, "549755885175")).toEqual({
      clientId: "cid",
      clientSecret: "csecret",
      refreshToken: "pinr_y",
      adAccountId: "549755885175",
    });
    expect(() => connect.credentials(app, { accessToken: "pina_x" }, "1")).toThrow(PlatformError);
    expect(connect.listIdentities).toBeUndefined();
  });
});
