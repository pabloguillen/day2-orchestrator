/**
 * Connecting Reddit Ads in one click (OAuth 2.0 authorization code, permanent).
 *
 * Docs (official site read via its public mirror):
 *  - Authorize / token / scopes: https://ads-api-reddit.netlify.app/docs/v3/guides/quick-start/authenticate
 *    authorize: https://www.reddit.com/api/v1/authorize?client_id&response_type=code&state&redirect_uri&duration=permanent&scope=a,b
 *    token:     POST https://www.reddit.com/api/v1/access_token (HTTP Basic client_id:secret,
 *               grant_type=authorization_code&code&redirect_uri); the code is single-use, valid
 *               10 minutes, and may carry a trailing "#_" that must be removed.
 *    scopes:    adsread (read), adsedit (write), adsconversions (Conversions API).
 *  - Businesses / ad accounts / profiles (Ads API v3, adsread):
 *    https://ads-api-reddit.netlify.app/docs/v3/api/businesses ,
 *    https://ads-api-reddit.netlify.app/docs/v3/api/profiles
 *    GET /me/businesses → GET /businesses/{id}/ad_accounts, GET /businesses/{id}/profiles.
 *    Response field names (data[], pagination.next_url, currency, admin_approval,
 *    suspension_reason) come from open-source npm clients, not Reddit's rendered docs.
 *
 * Reddit has no API to share a profile with another business, so there is no
 * grantIdentity: the app owner adds their profile to day2's business in Ads Manager.
 */
import { request } from "../http";
import { accountState, BASE, DEFAULT_USER_AGENT, TOKEN_URL, type RedditCreds } from "../platforms/reddit";
import { PlatformError, type PlatformDeps } from "../types";
import type { AdAccountChoice, AppCredentials, IdentityChoice, PlatformConnect, Tokens } from "./types";

export const AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
/** Running ads + sending conversions. Listing businesses, ad accounts and profiles needs only adsread. */
export const ACCOUNT_SCOPES = ["adsread", "adsedit", "adsconversions"];
export const IDENTITY_SCOPES = ["adsread"];

type Page<T> = { data?: T[]; pagination?: { next_url?: string | null } };
type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };

const err = (message: string, status?: number, retryable = false) => new PlatformError("reddit", message, status, retryable);
const ua = (app: AppCredentials) => app.userAgent || DEFAULT_USER_AGENT;
const basic = (app: AppCredentials) => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;

async function tokenCall(app: AppCredentials, form: Record<string, string>, deps: PlatformDeps): Promise<Tokens> {
  const r = await request<TokenResponse>("reddit", deps, TOKEN_URL, { method: "POST", headers: { authorization: basic(app), "user-agent": ua(app) }, form });
  if (!r?.access_token) throw err(`OAuth token request failed${r?.error ? ` (${r.error})` : ""}`, 401);
  const now = deps.now ? deps.now().getTime() : Date.now();
  return {
    accessToken: r.access_token,
    ...(r.refresh_token ? { refreshToken: r.refresh_token } : {}),
    expiresAt: now + (r.expires_in ?? 3600) * 1000,
    ...(r.scope ? { scopes: r.scope.split(/[\s,]+/).filter(Boolean) } : {}),
  };
}

/** A usable access token: the stored one, or a fresh one from the refresh token when it's (nearly) expired. */
async function bearer(app: AppCredentials, tokens: Tokens, deps: PlatformDeps): Promise<string> {
  const now = deps.now ? deps.now().getTime() : Date.now();
  if (tokens.expiresAt && tokens.expiresAt - 60_000 < now && tokens.refreshToken) {
    return (await tokenCall(app, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, deps)).accessToken;
  }
  return tokens.accessToken;
}

async function listAll<T>(app: AppCredentials, token: string, path: string, deps: PlatformDeps, maxPages = 10): Promise<T[]> {
  const headers = { authorization: `Bearer ${token}`, "user-agent": ua(app), accept: "application/json" };
  const out: T[] = [];
  let url = `${BASE}${path}`;
  let query: Record<string, number> | undefined = { "page.size": 100 };
  for (let i = 0; i < maxPages; i++) {
    const page = await request<Page<T>>("reddit", deps, url, { headers, ...(query ? { query } : {}) });
    out.push(...(Array.isArray(page?.data) ? page.data : []));
    const next = page?.pagination?.next_url;
    if (!next) break;
    if (!next.startsWith(`${BASE}/`)) throw err("pagination left the Ads API");
    url = next;
    query = undefined;
  }
  return out;
}

export const connect: PlatformConnect = {
  platform: "reddit",
  appEnv: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT (optional)"],

  appCredentials(env) {
    const clientId = env.REDDIT_CLIENT_ID?.trim();
    const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret, userAgent: env.REDDIT_USER_AGENT?.trim() || DEFAULT_USER_AGENT };
  },

  async authorizeUrl(app, o) {
    const q = new URLSearchParams({
      client_id: app.clientId!,
      response_type: "code",
      state: o.state,
      redirect_uri: o.redirectUri,
      duration: "permanent",
      scope: (o.purpose === "identity" ? IDENTITY_SCOPES : ACCOUNT_SCOPES).join(","),
    });
    return { url: `${AUTHORIZE_URL}?${q.toString()}` };
  },

  async exchange(app, o, deps = {}) {
    if (o.query.error) throw err(`authorization was not granted (${o.query.error})`, 400);
    const code = o.query.code?.replace(/#_$/, "");
    if (!code) throw err("callback has no authorization code", 400);
    return tokenCall(app, { grant_type: "authorization_code", code, redirect_uri: o.redirectUri }, deps);
  },

  async listAdAccounts(app, tokens, deps = {}) {
    const token = await bearer(app, tokens, deps);
    const businesses = await listAll<{ id?: string }>(app, token, "/me/businesses", deps);
    const byId = new Map<string, AdAccountChoice>();
    for (const b of businesses) {
      if (!b.id) continue;
      const accounts = await listAll<{ id?: string; name?: string; currency?: string; admin_approval?: string | null; suspension_reason?: string | null; status?: string | null }>(
        app,
        token,
        `/businesses/${encodeURIComponent(b.id)}/ad_accounts`,
        deps,
      );
      for (const a of accounts) {
        if (!a.id || byId.has(a.id)) continue;
        const state = accountState(a);
        byId.set(a.id, { id: a.id, name: a.name ?? a.id, currency: String(a.currency ?? "").toUpperCase(), canSpend: state.canSpend, ...(state.problem ? { problem: state.problem } : {}) });
      }
    }
    return [...byId.values()];
  },

  async listIdentities(app, tokens, deps = {}) {
    const token = await bearer(app, tokens, deps);
    const businesses = await listAll<{ id?: string }>(app, token, "/me/businesses", deps);
    const byRef = new Map<string, IdentityChoice>();
    for (const b of businesses) {
      if (!b.id) continue;
      const profiles = await listAll<{ id?: string; name?: string; username?: string; display_name?: string }>(app, token, `/businesses/${encodeURIComponent(b.id)}/profiles`, deps);
      for (const p of profiles) {
        if (!p.id || byRef.has(p.id)) continue;
        const name = p.display_name || p.name || (p.username ? `u/${p.username}` : p.id);
        byRef.set(p.id, { ref: p.id, name, kind: "profile" });
      }
    }
    return [...byRef.values()];
  },

  credentials(app, tokens, adAccountId): RedditCreds {
    if (!tokens.refreshToken) throw err("the Reddit connection has no refresh token; reconnect (duration=permanent)");
    if (!app.clientId || !app.clientSecret) throw err("Reddit app credentials are missing");
    return { clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: tokens.refreshToken, adAccountId, userAgent: ua(app) };
  },
};
