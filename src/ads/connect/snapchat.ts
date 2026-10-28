/**
 * Connecting Snapchat Ads in one click (OAuth 2.0 authorization code).
 *
 * Docs:
 *  - OAuth: https://developers.snap.com/api/marketing-api/Ads-API/authentication
 *    authorize: https://accounts.snapchat.com/login/oauth2/authorize?client_id&redirect_uri&response_type=code&scope&state
 *    token:     POST https://accounts.snapchat.com/login/oauth2/access_token (form: grant_type=authorization_code,
 *               client_id, client_secret, code, redirect_uri) → access_token (3600 s), refresh_token.
 *  - Organizations + ad accounts: https://developers.snap.com/api/marketing-api/Ads-API/organizations
 *    GET https://adsapi.snapchat.com/v1/me/organizations?with_ad_accounts=true
 *  - Public Profiles: https://developers.snap.com/api/marketing-api/Public-Profile-API/Profiles
 *    GET https://businessapi.snapchat.com/v1/organizations/{id}/public_profiles (scope snapchat-profile-api).
 *    "Snap public profile APIs are read only" — there is no API to share a profile with
 *    another organization, so there is no grantIdentity: the owner shares the profile with
 *    day2's organization in Business Manager, and the adapter's checkIdentity verifies it.
 *
 * Unverified: that Snap accepts both scopes space-separated in one authorize request,
 * and the `paging.next_link` field name on the public profile list.
 */
import { request } from "../http";
import { BASE, BUSINESS_API, TOKEN_URL, type SnapchatCreds } from "../platforms/snapchat";
import { PlatformError, type PlatformDeps } from "../types";
import type { AdAccountChoice, AppCredentials, IdentityChoice, PlatformConnect, Tokens } from "./types";

export const AUTHORIZE_URL = "https://accounts.snapchat.com/login/oauth2/authorize";
/** Ads API (accounts, campaigns, pixels) + Public Profile API (listing and checking profiles). */
export const SCOPES = ["snapchat-marketing-api", "snapchat-profile-api"];

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
type Org = { id?: string; name?: string; ad_accounts?: Array<{ id?: string; name?: string; currency?: string; status?: string }> };
type ProfilePage = { public_profiles?: Array<{ id?: string; display_name?: string; public_profile?: { id?: string; display_name?: string } }>; paging?: { next_link?: string } };

const err = (message: string, status?: number, retryable = false) => new PlatformError("snapchat", message, status, retryable);

async function tokenCall(app: AppCredentials, form: Record<string, string>, deps: PlatformDeps): Promise<Tokens> {
  const r = await request<TokenResponse>("snapchat", deps, TOKEN_URL, {
    method: "POST",
    form: { ...form, client_id: app.clientId!, client_secret: app.clientSecret! },
  });
  if (!r?.access_token) throw err(`OAuth token request failed${r?.error ? ` (${r.error})` : ""}`, 401);
  const now = deps.now ? deps.now().getTime() : Date.now();
  return {
    accessToken: r.access_token,
    ...(r.refresh_token ? { refreshToken: r.refresh_token } : {}),
    expiresAt: now + (r.expires_in ?? 3600) * 1000,
    ...(r.scope ? { scopes: r.scope.split(/[\s,]+/).filter(Boolean) } : {}),
  };
}

/** The stored access token, or a fresh one when it's (nearly) expired. */
async function bearer(app: AppCredentials, tokens: Tokens, deps: PlatformDeps): Promise<string> {
  const now = deps.now ? deps.now().getTime() : Date.now();
  if (tokens.expiresAt && tokens.expiresAt - 60_000 < now && tokens.refreshToken) {
    return (await tokenCall(app, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, deps)).accessToken;
  }
  return tokens.accessToken;
}

async function organizations(token: string, deps: PlatformDeps): Promise<Org[]> {
  const r = await request<{ request_status?: string; organizations?: Array<{ sub_request_status?: string; organization?: Org }> }>("snapchat", deps, `${BASE}/me/organizations`, {
    headers: { authorization: `Bearer ${token}` },
    query: { with_ad_accounts: true },
  });
  if (r?.request_status && r.request_status.toUpperCase() !== "SUCCESS") throw err(`listing organizations failed (${r.request_status})`);
  return (r?.organizations ?? []).map((o) => o.organization).filter((o): o is Org => !!o?.id);
}

export const connect: PlatformConnect = {
  platform: "snapchat",
  appEnv: ["SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET"],

  appCredentials(env) {
    const clientId = env.SNAP_CLIENT_ID?.trim();
    const clientSecret = env.SNAP_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  },

  async authorizeUrl(app, o) {
    const q = new URLSearchParams({
      client_id: app.clientId!,
      redirect_uri: o.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state: o.state,
    });
    return { url: `${AUTHORIZE_URL}?${q.toString()}` };
  },

  async exchange(app, o, deps = {}) {
    if (o.query.error) throw err(`authorization was not granted (${o.query.error})`, 400);
    const code = o.query.code;
    if (!code) throw err("callback has no authorization code", 400);
    return tokenCall(app, { grant_type: "authorization_code", code, redirect_uri: o.redirectUri }, deps);
  },

  async listAdAccounts(app, tokens, deps = {}) {
    const token = await bearer(app, tokens, deps);
    const byId = new Map<string, AdAccountChoice>();
    for (const org of await organizations(token, deps)) {
      for (const a of org.ad_accounts ?? []) {
        if (!a.id || byId.has(a.id)) continue;
        const ok = a.status === "ACTIVE";
        byId.set(a.id, {
          id: a.id,
          name: a.name ?? a.id,
          currency: String(a.currency ?? "").toUpperCase(),
          canSpend: ok,
          ...(ok ? {} : { problem: `ad account status is ${a.status ?? "unknown"}` }),
        });
      }
    }
    return [...byId.values()];
  },

  async listIdentities(app, tokens, deps = {}) {
    const token = await bearer(app, tokens, deps);
    const byRef = new Map<string, IdentityChoice>();
    for (const org of await organizations(token, deps)) {
      let url: string | undefined = `${BUSINESS_API}/organizations/${encodeURIComponent(org.id!)}/public_profiles`;
      let query: Record<string, number> | undefined = { limit: 50 };
      for (let page = 0; url && page < 20; page++) {
        let res: ProfilePage;
        try {
          res = await request<ProfilePage>("snapchat", deps, url, { headers: { authorization: `Bearer ${token}` }, ...(query ? { query } : {}) });
        } catch (e) {
          // No permission on this organization's profiles: skip it, keep the others.
          if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) break;
          throw e;
        }
        for (const item of res?.public_profiles ?? []) {
          const p = item.public_profile ?? item;
          if (!p.id || byRef.has(p.id)) continue;
          byRef.set(p.id, { ref: p.id, name: p.display_name || p.id, kind: "public_profile" });
        }
        const next = res?.paging?.next_link;
        if (next && !next.startsWith(`${BUSINESS_API}/`)) throw err("pagination left the Business API");
        url = next || undefined;
        query = undefined;
      }
    }
    return [...byRef.values()];
  },

  credentials(app, tokens, adAccountId): SnapchatCreds {
    if (!tokens.refreshToken) throw err("the Snapchat connection has no refresh token; reconnect");
    if (!app.clientId || !app.clientSecret) throw err("Snapchat app credentials are missing");
    return { clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: tokens.refreshToken, adAccountId };
  },
};
