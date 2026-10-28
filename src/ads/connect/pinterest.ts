import { request } from "../http";
import { PlatformError, type PlatformDeps } from "../types";
import { spendProblem, type PinterestCreds } from "../platforms/pinterest";
import type { AdAccountChoice, AppCredentials, PlatformConnect, Tokens } from "./types";

/**
 * Connecting a Pinterest ad account with OAuth 2.0 (authorization code).
 * https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
 * https://developers.pinterest.com/docs/getting-started/scopes/
 *
 * Pinterest ads show as the ad account's business profile (info.identity
 * "none"), so there is nothing to pick or grant beyond the ad account.
 */

const ID = "pinterest" as const;
const AUTHORIZE = "https://www.pinterest.com/oauth/";
const API = "https://api.pinterest.com/v5";
export const SCOPES = ["ads:read", "ads:write", "pins:read", "pins:write", "boards:read", "boards:write", "user_accounts:read"];

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
};

function basic(app: AppCredentials): string {
  return `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`;
}

function toTokens(res: TokenResponse | undefined, now: number): Tokens {
  if (!res?.access_token) throw new PlatformError(ID, "token endpoint returned no access token", 401);
  return {
    accessToken: res.access_token,
    ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
    ...(res.expires_in ? { expiresAt: now + res.expires_in * 1000 } : {}),
    ...(res.scope ? { scopes: res.scope.split(/[\s,]+/).filter(Boolean) } : {}),
  };
}

/**
 * The stored access token (valid 30 days). Not refreshed here on purpose:
 * Pinterest rotates the refresh token on every refresh, and this module has
 * no way to persist the new one — the adapter does that via onRefreshToken.
 */
function accessToken(tokens: Tokens, deps: PlatformDeps): string {
  const now = (deps.now ? deps.now() : new Date()).getTime();
  if (tokens.expiresAt && tokens.expiresAt <= now) throw new PlatformError(ID, "the Pinterest connection's access token expired; reconnect Pinterest", 401);
  return tokens.accessToken;
}

export const connect: PlatformConnect = {
  platform: ID,
  appEnv: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"],

  appCredentials(env) {
    const clientId = env.PINTEREST_CLIENT_ID?.trim();
    const clientSecret = env.PINTEREST_CLIENT_SECRET?.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  },

  async authorizeUrl(app, o) {
    if (o.purpose === "identity") throw new PlatformError(ID, "Pinterest ads need no identity to connect");
    const u = new URL(AUTHORIZE);
    u.searchParams.set("client_id", app.clientId ?? "");
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(","));
    u.searchParams.set("state", o.state);
    return { url: u.toString() };
  },

  async exchange(app, o, deps = {}) {
    if (o.query.error) throw new PlatformError(ID, `authorization denied: ${o.query.error_description ?? o.query.error}`, 400);
    const code = o.query.code;
    if (!code) throw new PlatformError(ID, "callback has no code", 400);
    const now = (deps.now ? deps.now() : new Date()).getTime();
    const res = await request<TokenResponse>(ID, deps, `${API}/oauth/token`, {
      method: "POST",
      headers: { authorization: basic(app) },
      form: { grant_type: "authorization_code", code, redirect_uri: o.redirectUri },
      // An authorization code is single-use: don't replay it on a 5xx.
      retries: 1,
    });
    const tokens = toTokens(res, now);
    if (!tokens.refreshToken) throw new PlatformError(ID, "token endpoint returned no refresh token", 401);
    try {
      const me = await request<{ id?: string; username?: string }>(ID, deps, `${API}/user_account`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
      if (me?.id) tokens.userId = me.id;
    } catch {
      // Who connected is nice to know, not required.
    }
    return tokens;
  },

  async listAdAccounts(_app, tokens, deps = {}): Promise<AdAccountChoice[]> {
    const t = accessToken(tokens, deps);
    const out: AdAccountChoice[] = [];
    let bookmark: string | undefined;
    do {
      const page = await request<{ items?: Array<{ id: string; name?: string; currency?: string; permissions?: string[] }>; bookmark?: string | null }>(
        ID,
        deps,
        `${API}/ad_accounts`,
        { headers: { authorization: `Bearer ${t}` }, query: { include_shared_accounts: true, page_size: 100, bookmark } },
      );
      for (const a of page?.items ?? []) {
        const problem = spendProblem(a);
        out.push({ id: a.id, name: a.name ?? a.id, currency: a.currency ?? "UNK", canSpend: !problem, ...(problem ? { problem } : {}) });
      }
      bookmark = page?.bookmark ?? undefined;
    } while (bookmark);
    return out;
  },

  credentials(app, tokens, adAccountId): PinterestCreds {
    if (!app.clientId || !app.clientSecret) throw new PlatformError(ID, "missing Pinterest app credentials");
    if (!tokens.refreshToken) throw new PlatformError(ID, "connection has no refresh token; reconnect Pinterest");
    return { clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: tokens.refreshToken, adAccountId };
  },
};
