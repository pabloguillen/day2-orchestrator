import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch } from "../test-helpers";
import { PlatformError } from "../types";
import { connect } from "./tiktok";

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const app = { appId: "app_123", secret: "shh_secret" };
const ok = (data: unknown) => ({ code: 0, message: "OK", request_id: "r", data });

describe("tiktok connect", () => {
  test("appCredentials from env", () => {
    expect(connect.platform).toBe("tiktok");
    expect(connect.appEnv).toEqual(["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"]);
    expect(connect.appCredentials({})).toBeNull();
    expect(connect.appCredentials({ TIKTOK_APP_ID: "a" })).toBeNull();
    expect(connect.appCredentials({ TIKTOK_APP_ID: "a", TIKTOK_APP_SECRET: "s" })).toEqual({ appId: "a", secret: "s" });
  });

  test("authorizeUrl is the advertiser authorization page", async () => {
    const { url, pending } = await connect.authorizeUrl(app, { state: "st_1", redirectUri: "https://day2.example/connect/tiktok/callback", purpose: "account" });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://business-api.tiktok.com/portal/auth");
    expect(u.searchParams.get("app_id")).toBe("app_123");
    expect(u.searchParams.get("state")).toBe("st_1");
    expect(u.searchParams.get("redirect_uri")).toBe("https://day2.example/connect/tiktok/callback");
    expect(url).not.toContain("shh_secret");
    expect(pending).toBeUndefined();
  });

  test("exchange posts auth_code for a long-lived token", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: `${BASE}/oauth2/access_token/`,
        check: (r) => {
          expect(r.json).toEqual({ app_id: "app_123", secret: "shh_secret", auth_code: "code_9" });
          expect(r.headers["access-token"]).toBeUndefined();
        },
        json: ok({ access_token: "tok_abc", advertiser_ids: ["111", "222"], scope: [4, 5] }),
      },
    ]);
    const tokens = await connect.exchange(app, { query: { auth_code: "code_9", state: "st_1" }, redirectUri: "https://day2.example/cb" }, { fetch: f.fetch, sleep: noSleep });
    expect(tokens).toEqual({ accessToken: "tok_abc", scopes: ["4", "5"] });
    expect(f.done()).toBe(true);
  });

  test("exchange errors: cancelled, envelope error", async () => {
    await expect(connect.exchange(app, { query: { state: "s" }, redirectUri: "x" })).rejects.toThrow(/auth_code/);
    const f = scriptedFetch([{ url: "/oauth2/access_token/", json: { code: 40110, message: "auth_code expired" } }]);
    const err = await connect.exchange(app, { query: { auth_code: "c" }, redirectUri: "x" }, { fetch: f.fetch, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.message).toContain("auth_code expired");
    expect(err.message).not.toContain("shh_secret");
  });

  test("listAdAccounts: authorized advertisers with currency and status", async () => {
    const f = scriptedFetch([
      {
        method: "GET",
        url: `${BASE}/oauth2/advertiser/get/`,
        check: (r) => {
          expect(r.headers["access-token"]).toBe("tok_abc");
          const u = new URL(r.url);
          expect(u.searchParams.get("app_id")).toBe("app_123");
          expect(u.searchParams.get("secret")).toBe("shh_secret");
        },
        json: ok({ list: [{ advertiser_id: "111", advertiser_name: "day2 EU" }, { advertiser_id: "222", advertiser_name: "Pending one" }] }),
      },
      {
        method: "GET",
        url: `${BASE}/advertiser/info/`,
        check: (r) => {
          expect(r.headers["access-token"]).toBe("tok_abc");
          expect(JSON.parse(new URL(r.url).searchParams.get("advertiser_ids")!)).toEqual(["111", "222"]);
        },
        json: ok({
          list: [
            { advertiser_id: "111", name: "day2 EU", currency: "EUR", status: "STATUS_ENABLE" },
            { advertiser_id: "222", name: "Pending one", currency: "usd", status: "STATUS_PENDING_CONFIRM" },
          ],
        }),
      },
    ]);
    const list = await connect.listAdAccounts(app, { accessToken: "tok_abc" }, { fetch: f.fetch, sleep: noSleep });
    expect(list).toEqual([
      { id: "111", name: "day2 EU", currency: "EUR", canSpend: true },
      { id: "222", name: "Pending one", currency: "USD", canSpend: false, problem: "The ad account is still under review by TikTok." },
    ]);
    expect(f.done()).toBe(true);
  });

  test("no identities to pick (custom identity); credentials for the adapter", () => {
    expect(connect.listIdentities).toBeUndefined();
    expect(connect.credentials(app, { accessToken: "tok_abc" }, "111")).toEqual({ accessToken: "tok_abc", advertiserId: "111" });
  });
});
