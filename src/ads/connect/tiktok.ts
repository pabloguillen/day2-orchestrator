import { PlatformError } from "../types";
import { ADVERTISER_FIELDS, advertiserInfo, DEFAULT_BASE, tiktokCall, tiktokQuery, type AdvertiserRow, type TikTokCreds } from "../platforms/tiktok";
import type { AdAccountChoice, PlatformConnect, Tokens } from "./types";

/**
 * TikTok for Business OAuth ("advertiser authorization"):
 *
 *  1. Send the person to https://business-api.tiktok.com/portal/auth?app_id=…&state=…&redirect_uri=…
 *     (the redirect URI must be the one registered on day2's developer app).
 *  2. TikTok redirects back with `auth_code` (and `state`).
 *  3. POST /open_api/v1.3/oauth2/access_token/ {app_id, secret, auth_code}
 *     → { access_token, advertiser_ids, scope }. The token is long-lived
 *     (no refresh token; valid until the person revokes it).
 *  4. GET /oauth2/advertiser/get/ lists the advertisers the token can manage,
 *     /advertiser/info/ adds name, currency and status.
 *
 * Ads show as a custom identity created by the adapter, so there's nothing
 * to pick here (no listIdentities).
 */

export const AUTHORIZE_URL = "https://business-api.tiktok.com/portal/auth";

const appOf = (app: Record<string, string>) => {
  const appId = app.appId;
  const secret = app.secret;
  if (!appId || !secret) throw new PlatformError("tiktok", "TikTok app credentials missing (TIKTOK_APP_ID, TIKTOK_APP_SECRET)");
  return { appId, secret, base: (app.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "") };
};

export const connect: PlatformConnect = {
  platform: "tiktok",
  appEnv: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"],

  appCredentials(env) {
    const appId = env.TIKTOK_APP_ID?.trim();
    const secret = env.TIKTOK_APP_SECRET?.trim();
    if (!appId || !secret) return null;
    const baseUrl = env.TIKTOK_API_BASE?.trim();
    return { appId, secret, ...(baseUrl ? { baseUrl } : {}) };
  },

  async authorizeUrl(app, o) {
    const { appId } = appOf(app);
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("app_id", appId);
    u.searchParams.set("state", o.state);
    u.searchParams.set("redirect_uri", o.redirectUri);
    return { url: u.toString() };
  },

  async exchange(app, o, deps = {}) {
    const { appId, secret, base } = appOf(app);
    if (o.query.error) throw new PlatformError("tiktok", `authorization was not granted: ${o.query.error_description ?? o.query.error}`);
    const authCode = o.query.auth_code ?? o.query.code;
    if (!authCode) throw new PlatformError("tiktok", "callback has no auth_code (the person may have cancelled)");
    const data = await tiktokCall<{ access_token?: string; advertiser_ids?: Array<string | number>; scope?: Array<string | number> }>(
      deps,
      `${base}/oauth2/access_token/`,
      null,
      { method: "POST", json: { app_id: appId, secret, auth_code: authCode }, retries: 1 },
    );
    if (!data?.access_token) throw new PlatformError("tiktok", "oauth2/access_token returned no access_token");
    const tokens: Tokens = { accessToken: data.access_token };
    if (data.scope?.length) tokens.scopes = data.scope.map(String);
    return tokens;
  },

  async listAdAccounts(app, tokens, deps = {}) {
    const { appId, secret, base } = appOf(app);
    const listed = await tiktokCall<{ list?: Array<{ advertiser_id?: string | number; advertiser_name?: string }> }>(deps, `${base}/oauth2/advertiser/get/`, tokens.accessToken, {
      method: "GET",
      query: { app_id: appId, secret },
    });
    const ids = (listed?.list ?? []).map((a) => (a.advertiser_id === undefined ? "" : String(a.advertiser_id))).filter(Boolean);
    const names = new Map((listed?.list ?? []).map((a) => [String(a.advertiser_id), a.advertiser_name ?? ""]));
    const out: AdAccountChoice[] = [];
    // advertiser/info takes up to 100 ids per call.
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const data = await tiktokCall<{ list?: AdvertiserRow[] }>(deps, `${base}/advertiser/info/`, tokens.accessToken, {
        method: "GET",
        query: tiktokQuery({ advertiser_ids: batch, fields: ADVERTISER_FIELDS }),
      });
      const rows = new Map((data?.list ?? []).map((r) => [String(r.advertiser_id), r]));
      for (const id of batch) {
        const row = rows.get(id);
        out.push(
          row
            ? advertiserInfo({ ...row, name: row.name || names.get(id) || id }, id)
            : { id, name: names.get(id) || id, currency: "", canSpend: false, problem: "TikTok returned no details for this ad account." },
        );
      }
    }
    return out;
  },

  credentials(app, tokens, adAccountId): TikTokCreds {
    return { accessToken: tokens.accessToken, advertiserId: adAccountId, ...(app.baseUrl ? { baseUrl: app.baseUrl } : {}) };
  },
};
