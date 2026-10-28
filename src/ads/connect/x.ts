import { request } from "../http";
import { PlatformError, type PlatformDeps } from "../types";
import { ADS_BASE, describeAccount, signedFetch, xCaller, type OAuthKeys, type XCreds } from "../platforms/x";
import type { AdAccountChoice, AppCredentials, IdentityChoice, PlatformConnect, Tokens } from "./types";

/**
 * Connecting X: 3-legged OAuth 1.0a
 * (https://docs.x.com/fundamentals/authentication/oauth-1-0a/obtaining-user-access-tokens,
 * https://docs.x.com/fundamentals/authentication/api-reference):
 *
 *  1. POST https://api.x.com/oauth/request_token with oauth_callback in the
 *     signed OAuth parameters → oauth_token + oauth_token_secret (kept by day2
 *     as `pending`), oauth_callback_confirmed=true.
 *  2. Send the person to https://api.x.com/oauth/authorize?oauth_token=….
 *  3. The callback carries oauth_token + oauth_verifier; POST
 *     https://api.x.com/oauth/access_token (signed with the request token,
 *     oauth_verifier in the body) → oauth_token, oauth_token_secret, user_id,
 *     screen_name. X user tokens do not expire.
 *
 * The callback URL (without query) must be registered in day2's X developer
 * app; day2's `state` rides along as a query parameter on it.
 */

const OAUTH = "https://api.x.com/oauth";

function fail(message: string, status?: number): never {
  throw new PlatformError("x", message, status, false);
}

function app2keys(app: AppCredentials): OAuthKeys {
  if (!app.consumerKey || !app.consumerSecret) fail("missing X consumer key/secret");
  return { consumerKey: app.consumerKey, consumerSecret: app.consumerSecret };
}

function userKeys(app: AppCredentials, tokens: Tokens): OAuthKeys {
  if (!tokens.tokenSecret) fail("X tokens need the OAuth 1.0a token secret");
  return { ...app2keys(app), accessToken: tokens.accessToken, accessTokenSecret: tokens.tokenSecret };
}

/** Parses an application/x-www-form-urlencoded token response. */
function parseForm(body: unknown, what: string): Record<string, string> {
  if (typeof body !== "string" || !body.includes("=")) fail(`unexpected ${what} response`);
  return Object.fromEntries(new URLSearchParams(body));
}

export const connect: PlatformConnect = {
  platform: "x",
  appEnv: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET"],

  appCredentials(env) {
    const consumerKey = env.X_CONSUMER_KEY?.trim();
    const consumerSecret = env.X_CONSUMER_SECRET?.trim();
    return consumerKey && consumerSecret ? { consumerKey, consumerSecret } : null;
  },

  async authorizeUrl(app, o, deps: PlatformDeps = {}) {
    const callback = new URL(o.redirectUri);
    callback.searchParams.set("state", o.state);
    const sdeps = { ...deps, fetch: signedFetch(app2keys(app), deps, { oauth_callback: callback.toString() }) };
    const res = parseForm(await request("x", sdeps, `${OAUTH}/request_token`, { method: "POST" }), "request_token");
    if (res.oauth_callback_confirmed !== "true" || !res.oauth_token || !res.oauth_token_secret) fail("X did not confirm the OAuth callback (is it registered in the developer app?)");
    const url = new URL(`${OAUTH}/authorize`);
    url.searchParams.set("oauth_token", res.oauth_token);
    return { url: url.toString(), pending: { oauth_token: res.oauth_token, oauth_token_secret: res.oauth_token_secret } };
  },

  async exchange(app, o, deps: PlatformDeps = {}) {
    if (o.query.denied) fail("the X user declined the authorization");
    const token = o.query.oauth_token;
    const verifier = o.query.oauth_verifier;
    if (!token || !verifier) fail("X callback is missing oauth_token/oauth_verifier");
    if (!o.pending?.oauth_token || !o.pending.oauth_token_secret) fail("no pending X request token for this callback");
    if (o.pending.oauth_token !== token) fail("X callback oauth_token does not match the request token");
    const keys: OAuthKeys = { ...app2keys(app), accessToken: token, accessTokenSecret: o.pending.oauth_token_secret };
    const sdeps = { ...deps, fetch: signedFetch(keys, deps) };
    const res = parseForm(await request("x", sdeps, `${OAUTH}/access_token`, { method: "POST", form: { oauth_verifier: verifier } }), "access_token");
    if (!res.oauth_token || !res.oauth_token_secret) fail("X access_token response has no token");
    return { accessToken: res.oauth_token, tokenSecret: res.oauth_token_secret, ...(res.user_id ? { userId: res.user_id } : {}) };
  },

  async listAdAccounts(app, tokens, deps: PlatformDeps = {}): Promise<AdAccountChoice[]> {
    const call = xCaller(userKeys(app, tokens), deps);
    const accounts = (await call<{ data?: Array<{ id: string; name?: string; approval_status?: string; deleted?: boolean }> }>(`${ADS_BASE}/accounts`, { query: { count: 1000 } })).data ?? [];
    const out: AdAccountChoice[] = [];
    for (const a of accounts.filter((a) => !a.deleted)) {
      const { fundingInstrumentId: _fi, ...choice } = await describeAccount(call, a.id, undefined, a);
      out.push(choice);
    }
    return out;
  },

  /**
   * The connecting user's own handle first (that is the account whose posts
   * the ads show as), then the FULL promotable users of the ads accounts
   * they can access.
   */
  async listIdentities(app, tokens, deps: PlatformDeps = {}): Promise<IdentityChoice[]> {
    const call = xCaller(userKeys(app, tokens), deps);
    const out: IdentityChoice[] = [];
    const me = await call<{ data?: { id: string; name?: string; username?: string } }>("https://api.x.com/2/users/me").catch(() => undefined);
    const myId = me?.data?.id ?? tokens.userId;
    if (myId) out.push({ ref: myId, name: me?.data?.username ? `@${me.data.username}` : `X user ${myId}`, kind: "x_account" });

    const accounts = (await call<{ data?: Array<{ id: string; deleted?: boolean }> }>(`${ADS_BASE}/accounts`, { query: { count: 1000 } })).data ?? [];
    const others = new Set<string>();
    for (const a of accounts.filter((a) => !a.deleted)) {
      const pus = (await call<{ data?: Array<{ user_id?: string; promotable_user_type?: string; deleted?: boolean }> }>(`${ADS_BASE}/accounts/${a.id}/promotable_users`, { query: { count: 1000 } })).data ?? [];
      for (const p of pus) if (!p.deleted && p.promotable_user_type === "FULL" && p.user_id && String(p.user_id) !== myId) others.add(String(p.user_id));
    }
    if (others.size) {
      const ids = [...others].slice(0, 100);
      const users = await call<{ data?: Array<{ id: string; username?: string }> }>("https://api.x.com/2/users", { query: { ids: ids.join(",") } }).catch(() => undefined);
      for (const id of ids) {
        const u = users?.data?.find((x) => x.id === id);
        out.push({ ref: id, name: u?.username ? `@${u.username}` : `X user ${id}`, kind: "x_promotable_user" });
      }
    }
    return out;
  },

  credentials(app, tokens, adAccountId): XCreds {
    const keys = userKeys(app, tokens);
    if (!adAccountId) fail("missing X ads account id");
    return { consumerKey: keys.consumerKey, consumerSecret: keys.consumerSecret, accessToken: tokens.accessToken, accessTokenSecret: tokens.tokenSecret!, adsAccountId: adAccountId };
  },
};
