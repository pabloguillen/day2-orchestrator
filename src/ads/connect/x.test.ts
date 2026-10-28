import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch, type Recorded } from "../test-helpers";
import { PlatformError } from "../types";
import { connect } from "./x";

const app = { consumerKey: "ck", consumerSecret: "consumer-secret-xyz" };
const NOW = new Date("2026-10-28T10:30:00Z");
const tokens = { accessToken: "6253282-userToken", tokenSecret: "user-secret-xyz", userId: "6253282" };
const deps = (f: ReturnType<typeof scriptedFetch>) => ({ fetch: f.fetch, sleep: noSleep, now: () => NOW });
const auth = (r: Recorded) => r.headers.authorization ?? "";
const q = (r: Recorded) => Object.fromEntries(new URL(r.url).searchParams);

describe("appCredentials", () => {
  test("from env, null when missing", () => {
    expect(connect.appCredentials({ X_CONSUMER_KEY: "ck", X_CONSUMER_SECRET: "cs" })).toEqual({ consumerKey: "ck", consumerSecret: "cs" });
    expect(connect.appCredentials({ X_CONSUMER_KEY: "ck" })).toBeNull();
    expect(connect.appCredentials({ X_CONSUMER_KEY: " ", X_CONSUMER_SECRET: "cs" })).toBeNull();
    expect(connect.appEnv).toEqual(["X_CONSUMER_KEY", "X_CONSUMER_SECRET"]);
  });
});

describe("3-legged OAuth 1.0a", () => {
  test("authorizeUrl: request_token with a signed oauth_callback (carrying state), returns the authorize URL and pending request token", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://api.x.com/oauth/request_token",
        check: (r) => {
          expect(auth(r)).toStartWith('OAuth oauth_callback="https%3A%2F%2Fday2.example%2Fconnect%2Fx%2Fcallback%3Fstate%3Dst_1", ');
          expect(auth(r)).toContain('oauth_consumer_key="ck"');
          expect(auth(r)).not.toContain("oauth_token=");
          expect(auth(r)).not.toContain("secret-xyz");
        },
        text: "oauth_token=Z6eEdO8MOmk394WozF5oKyuAv855l4Mlqo7hhlSLik&oauth_token_secret=Kd75W4OQfb2oJTV0vzGzeXftVAwgMnEK9MumzYcM&oauth_callback_confirmed=true",
        headers: { "content-type": "text/html" },
      },
    ]);
    const res = await connect.authorizeUrl(app, { state: "st_1", redirectUri: "https://day2.example/connect/x/callback", purpose: "account" }, deps(f));
    expect(res).toEqual({
      url: "https://api.x.com/oauth/authorize?oauth_token=Z6eEdO8MOmk394WozF5oKyuAv855l4Mlqo7hhlSLik",
      pending: { oauth_token: "Z6eEdO8MOmk394WozF5oKyuAv855l4Mlqo7hhlSLik", oauth_token_secret: "Kd75W4OQfb2oJTV0vzGzeXftVAwgMnEK9MumzYcM" },
    });
    expect(f.done()).toBe(true);
  });

  test("authorizeUrl fails when X does not confirm the callback", async () => {
    const f = scriptedFetch([{ method: "POST", url: "/oauth/request_token", text: "oauth_token=a&oauth_token_secret=b&oauth_callback_confirmed=false" }]);
    await expect(connect.authorizeUrl(app, { state: "s", redirectUri: "https://day2.example/cb", purpose: "identity" }, deps(f))).rejects.toThrow(PlatformError);
  });

  test("exchange: access_token signed with the request token, oauth_verifier in the body → token, secret, user id", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://api.x.com/oauth/access_token",
        check: (r) => {
          expect(auth(r)).toContain('oauth_token="reqTok"');
          expect(auth(r)).not.toContain("reqSecret");
          expect(r.json).toEqual({ oauth_verifier: "verif" });
        },
        text: "oauth_token=6253282-eWudHldSbIaelX7swmsiHImEL4KinwaGloHANdrY&oauth_token_secret=2EEfA6BG5ly3sR3XjE0IBSnlQu4ZrUzPiYTmrkVU&user_id=6253282&screen_name=xapi",
      },
    ]);
    const t = await connect.exchange(
      app,
      { query: { oauth_token: "reqTok", oauth_verifier: "verif", state: "st_1" }, redirectUri: "https://day2.example/cb", pending: { oauth_token: "reqTok", oauth_token_secret: "reqSecret" } },
      deps(f),
    );
    expect(t).toEqual({ accessToken: "6253282-eWudHldSbIaelX7swmsiHImEL4KinwaGloHANdrY", tokenSecret: "2EEfA6BG5ly3sR3XjE0IBSnlQu4ZrUzPiYTmrkVU", userId: "6253282" });
    expect(f.done()).toBe(true);
  });

  test("exchange refuses denied, mismatched or unknown request tokens without calling X", async () => {
    const f = scriptedFetch([]);
    const pending = { oauth_token: "reqTok", oauth_token_secret: "reqSecret" };
    await expect(connect.exchange(app, { query: { denied: "reqTok" }, redirectUri: "x", pending }, deps(f))).rejects.toThrow(/declined/);
    await expect(connect.exchange(app, { query: { oauth_token: "other", oauth_verifier: "v" }, redirectUri: "x", pending }, deps(f))).rejects.toThrow(/does not match/);
    await expect(connect.exchange(app, { query: { oauth_token: "reqTok", oauth_verifier: "v" }, redirectUri: "x" }, deps(f))).rejects.toThrow(/pending/);
    expect(f.calls.length).toBe(0);
  });
});

describe("accounts and identities", () => {
  test("listAdAccounts: accessible accounts with funding instrument currency and whether they can spend", async () => {
    const f = scriptedFetch([
      {
        method: "GET",
        url: "https://ads-api.x.com/12/accounts?count=1000",
        check: (r) => expect(auth(r)).toContain('oauth_token="6253282-userToken"'),
        json: { data: [{ id: "acc1", name: "Buddy ads", approval_status: "ACCEPTED" }, { id: "acc2", name: "Old", deleted: true }, { id: "acc3", name: "New", approval_status: "UNDER_REVIEW" }] },
      },
      { method: "GET", url: "/accounts/acc1/funding_instruments", json: { data: [{ id: "fi1", entity_status: "ACTIVE", currency: "EUR", able_to_fund: true }] } },
      { method: "GET", url: "/accounts/acc1/authenticated_user_access", json: { data: { permissions: ["ACCOUNT_ADMIN", "TWEET_COMPOSER"] } } },
      { method: "GET", url: "/accounts/acc3/funding_instruments", json: { data: [] } },
      { method: "GET", url: "/accounts/acc3/authenticated_user_access", json: { data: { permissions: ["ACCOUNT_ADMIN"] } } },
    ]);
    const list = await connect.listAdAccounts(app, tokens, deps(f));
    expect(list[0]).toEqual({ id: "acc1", name: "Buddy ads", currency: "EUR", canSpend: true });
    expect(list[1]).toMatchObject({ id: "acc3", name: "New", currency: "", canSpend: false });
    expect(list[1]!.problem).toContain("UNDER_REVIEW");
    expect(list.length).toBe(2);
    expect(f.done()).toBe(true);
  });

  test("listIdentities: own handle first, then FULL promotable users of accessible accounts", async () => {
    const f = scriptedFetch([
      { method: "GET", url: "https://api.x.com/2/users/me", json: { data: { id: "6253282", name: "Buddy", username: "buddyapp" } } },
      { method: "GET", url: "https://ads-api.x.com/12/accounts?count=1000", json: { data: [{ id: "acc1" }] } },
      {
        method: "GET",
        url: "/accounts/acc1/promotable_users",
        json: { data: [{ user_id: "6253282", promotable_user_type: "FULL" }, { user_id: "42", promotable_user_type: "FULL" }, { user_id: "43", promotable_user_type: "RETWEETS_ONLY" }] },
      },
      { method: "GET", url: "https://api.x.com/2/users?ids=42", check: (r) => expect(q(r)).toEqual({ ids: "42" }), json: { data: [{ id: "42", username: "otherbrand" }] } },
    ]);
    expect(await connect.listIdentities!(app, tokens, deps(f))).toEqual([
      { ref: "6253282", name: "@buddyapp", kind: "x_account" },
      { ref: "42", name: "@otherbrand", kind: "x_promotable_user" },
    ]);
    expect(f.done()).toBe(true);
  });

  test("credentials → adapter XCreds", () => {
    expect(connect.credentials(app, tokens, "acc1")).toEqual({
      consumerKey: "ck",
      consumerSecret: "consumer-secret-xyz",
      accessToken: "6253282-userToken",
      accessTokenSecret: "user-secret-xyz",
      adsAccountId: "acc1",
    });
    expect(() => connect.credentials(app, { accessToken: "t" }, "acc1")).toThrow(/token secret/);
  });
});
