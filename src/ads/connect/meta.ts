import { request } from "../http";
import { PlatformError, type PlatformDeps } from "../types";
import { describeAccount, graphAll, graphClient, graphMessage, GRAPH, META_API_VERSION, normalizeAccountId, type MetaCreds } from "../platforms/meta";
import { SOCIAL_SCOPES } from "../../social/meta";
import type { AdAccountChoice, AppCredentials, IdentityChoice, PlatformConnect, Tokens } from "./types";

/**
 * Connecting Meta with Facebook Login (manually built OAuth flow):
 * https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived
 *
 * - purpose "account": ads_management + ads_read + business_management, to
 *   run ads from an ad account the person can use.
 * - purpose "identity": the app owner picks the Facebook Page (and linked
 *   Instagram account) the ads show as; day2's business then requests
 *   access to that Page (Business Management API, client_pages), which the
 *   owner approves in Meta Business Suite. The same sign-in also grants
 *   organic posting on the Page and its Instagram account (and reading the
 *   posts' results) — purpose "social" is that sign-in started from the
 *   Social page (src/social/).
 *
 * Business-type Meta apps use Facebook Login for Business: their use cases
 * only accept a login configuration (Facebook Login for Business →
 * Configurations), so the dialog is opened with `config_id` instead of a
 * `scope` list. META_LOGIN_CONFIG_ID sets it for every purpose;
 * META_LOGIN_CONFIG_ID_ADS (purpose "account") and
 * META_LOGIN_CONFIG_ID_SOCIAL ("identity", "social") override it. The
 * permissions granted are read from /me/permissions after the exchange,
 * either way.
 * https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
 */

// The owner's Page sign-in also asks for organic posting and its results
// (src/social/meta.ts SOCIAL_SCOPES), so one Facebook sign-in covers the
// Page ads show as and the posts day2 publishes for the app.
const IDENTITY_SCOPES = [...new Set(["pages_show_list", "pages_read_engagement", "instagram_basic", "business_management", ...SOCIAL_SCOPES])];
const SCOPES = {
  // pages_show_list: after connecting, the Pages (and their Instagram accounts) can be picked per app.
  account: ["ads_management", "ads_read", "business_management", "pages_show_list"],
  identity: IDENTITY_SCOPES,
  social: IDENTITY_SCOPES,
} as const;

/** Tasks day2 asks for on the app's Page: run ads as it and read their results. */
const PAGE_TASKS = ["ADVERTISE", "ANALYZE"];
const APPROVE_TODO = "Approve day2's request in Meta Business Suite → Requests (Settings → Requests → Received), so day2 can run ads as your Page.";

/** The login configuration for this purpose, or null (then the dialog asks for SCOPES). */
export function loginConfigId(app: AppCredentials, purpose: keyof typeof SCOPES): string | null {
  const own = purpose === "account" ? app.loginConfigIdAds : app.loginConfigIdSocial;
  return own || app.loginConfigId || null;
}

const version = (app: AppCredentials) => app.apiVersion ?? META_API_VERSION;

function need(app: AppCredentials, key: string): string {
  const v = app[key];
  if (!v) throw new PlatformError("meta", `app credential ${key} is missing`);
  return v;
}

type OAuthToken = { access_token?: string; expires_in?: number };

/** Each Graph call during connecting gets this long: the sign-in callback waits on them (ads/connect-callback.ts). */
export const GRAPH_CALL_TIMEOUT_MS = 15_000;

const TIMED = Symbol("timed");

/** The deps with a per-call timeout on every fetch (unless the caller set its own signal, or the deps are timed already). */
export function timed(deps: PlatformDeps, ms = GRAPH_CALL_TIMEOUT_MS): PlatformDeps {
  if (deps.fetch && (deps.fetch as { [TIMED]?: true })[TIMED]) return deps;
  const f = deps.fetch ?? fetch;
  const withTimeout = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => f(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) });
  return { ...deps, fetch: Object.assign(withTimeout, { [TIMED]: true as const }) as unknown as typeof fetch };
}

async function oauthToken(app: AppCredentials, query: Record<string, string>, deps: PlatformDeps, retries?: number): Promise<OAuthToken> {
  try {
    return await request<OAuthToken>("meta", timed(deps), `${GRAPH}/${version(app)}/oauth/access_token`, {
      method: "GET",
      query: { client_id: need(app, "appId"), client_secret: need(app, "appSecret"), ...query },
      ...(retries !== undefined ? { retries } : {}),
    });
  } catch (err) {
    if (!(err instanceof PlatformError)) throw err;
    const { text, transient } = graphMessage(err);
    throw new PlatformError("meta", `token exchange: ${text}`, err.status, err.retryable || transient);
  }
}

const graphFor = (app: AppCredentials, tokens: Tokens, deps: PlatformDeps) => graphClient({ token: tokens.accessToken, appSecret: app.appSecret, apiVersion: version(app) }, timed(deps));

type PageRow = { id: string; name?: string; tasks?: string[]; instagram_business_account?: { id: string; username?: string } };

export const connect: PlatformConnect = {
  platform: "meta",
  appEnv: ["META_APP_ID", "META_APP_SECRET", "META_LOGIN_CONFIG_ID (optional)"],

  /**
   * META_APP_ID, META_APP_SECRET; optional DAY2_META_BUSINESS_ID (needed for grantIdentity), META_API_VERSION,
   * META_LOGIN_CONFIG_ID (+ META_LOGIN_CONFIG_ID_ADS / META_LOGIN_CONFIG_ID_SOCIAL overrides).
   */
  appCredentials(env) {
    const appId = env.META_APP_ID?.trim();
    const appSecret = env.META_APP_SECRET?.trim();
    if (!appId || !appSecret) return null;
    const app: AppCredentials = { appId, appSecret };
    const businessId = env.DAY2_META_BUSINESS_ID?.trim();
    if (businessId) app.businessId = businessId;
    const v = env.META_API_VERSION?.trim();
    if (v && /^v\d+\.\d+$/.test(v)) app.apiVersion = v;
    for (const [key, name] of [["loginConfigId", "META_LOGIN_CONFIG_ID"], ["loginConfigIdAds", "META_LOGIN_CONFIG_ID_ADS"], ["loginConfigIdSocial", "META_LOGIN_CONFIG_ID_SOCIAL"]] as const) {
      const id = env[name]?.trim();
      if (id) app[key] = id;
    }
    return app;
  },

  async authorizeUrl(app, o) {
    const u = new URL(`https://www.facebook.com/${version(app)}/dialog/oauth`);
    u.searchParams.set("client_id", need(app, "appId"));
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("state", o.state);
    u.searchParams.set("response_type", "code");
    const configId = loginConfigId(app, o.purpose);
    if (configId) {
      // Facebook Login for Business: the configuration carries the permissions.
      u.searchParams.set("config_id", configId);
      u.searchParams.set("override_default_response_type", "true");
    } else {
      u.searchParams.set("scope", SCOPES[o.purpose].join(","));
    }
    return { url: u.toString() };
  },

  async exchange(app, o, deps = {}) {
    if (o.query.error) throw new PlatformError("meta", `login was not completed: ${o.query.error_description ?? o.query.error_reason ?? o.query.error}`);
    const code = o.query.code;
    if (!code) throw new PlatformError("meta", "login callback has no code");
    // One attempt: a sign-in code works once, so a retry after a timed-out
    // exchange would only fail with "code already used".
    const short = await oauthToken(app, { redirect_uri: o.redirectUri, code }, deps, 1);
    if (!short.access_token) throw new PlatformError("meta", "token exchange returned no access token");
    // Short-lived (~1-2 h) → long-lived (~60 days) user token.
    const long = await oauthToken(app, { grant_type: "fb_exchange_token", fb_exchange_token: short.access_token }, deps);
    const accessToken = long.access_token ?? short.access_token;
    const expiresIn = long.access_token ? long.expires_in : short.expires_in;
    const now = (deps.now ? deps.now() : new Date()).getTime();
    const graph = graphClient({ token: accessToken, appSecret: app.appSecret, apiVersion: version(app) }, timed(deps));
    const me = await graph<{ id?: string }>("who connected", "GET", "me", { query: { fields: "id" } });
    const perms = await graph<{ data?: Array<{ permission: string; status: string }> }>("granted permissions", "GET", "me/permissions");
    return {
      accessToken,
      expiresAt: expiresIn ? now + expiresIn * 1000 : undefined,
      userId: me.id,
      scopes: (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission),
    };
  },

  async listAdAccounts(app, tokens, deps = {}): Promise<AdAccountChoice[]> {
    const rows = await graphAll<{ id: string; name?: string; currency?: string; account_status?: number; disable_reason?: number }>(graphFor(app, tokens, deps), "ad accounts", "me/adaccounts", {
      fields: "id,name,currency,account_status,disable_reason",
      limit: 100,
    });
    return rows.map((a) => ({ id: a.id, name: a.name ?? a.id, currency: a.currency ?? "", ...describeAccount(a) }));
  },

  async listIdentities(app, tokens, deps = {}): Promise<IdentityChoice[]> {
    const pages = await graphAll<PageRow>(graphFor(app, tokens, deps), "pages", "me/accounts", { fields: "id,name,tasks,instagram_business_account{id,username}", limit: 100 });
    const out: IdentityChoice[] = [];
    for (const p of pages) {
      // Only Pages the person can advertise for (or whose tasks Meta didn't return).
      if (p.tasks && !p.tasks.includes("ADVERTISE")) continue;
      const name = p.name ?? p.id;
      out.push({ ref: p.id, name, kind: "facebook_page" });
      const ig = p.instagram_business_account;
      if (ig?.id) out.push({ ref: `${p.id}:${ig.id}`, name: `${name} + Instagram${ig.username ? ` @${ig.username}` : ""}`, kind: "facebook_page_instagram" });
    }
    return out;
  },

  async grantIdentity(app, owner, ref, day2, deps = {}) {
    const businessId = app.businessId;
    if (!businessId) throw new PlatformError("meta", "DAY2_META_BUSINESS_ID is not set: day2's business can't request Page access");
    const pageId = ref.split(":")[0] ?? "";
    if (!/^\d+$/.test(pageId)) throw new PlatformError("meta", `"${ref}" is not a Facebook Page id`);

    // The person connecting must actually manage this Page.
    const ownerPages = await graphAll<PageRow>(graphFor(app, owner, deps), "owner pages", "me/accounts", { fields: "id,name,tasks", limit: 100 });
    const ownerPage = ownerPages.find((p) => p.id === pageId);
    if (!ownerPage) throw new PlatformError("meta", `you don't manage Page ${pageId} with this Facebook account`);

    const graph = graphFor(app, day2.tokens, deps);
    const day2Pages = await graphAll<PageRow>(graph, "day2 pages", "me/accounts", { fields: "id,tasks", limit: 100 });
    if (day2Pages.find((p) => p.id === pageId)?.tasks?.includes("ADVERTISE")) return { status: "ready" as const };

    /** Business has the Page: give day2's system user the Advertise task on it. */
    const assign = async (): Promise<{ status: "ready" | "pending"; todo?: string }> => {
      const userId = day2.tokens.userId ?? (await graph<{ id: string }>("day2 user", "GET", "me", { query: { fields: "id" } })).id;
      try {
        await graph("assign day2 to Page", "POST", `${pageId}/assigned_users`, { form: { user: userId, tasks: PAGE_TASKS, business: businessId } });
        return { status: "ready" };
      } catch (err) {
        if (err instanceof PlatformError && err.retryable) throw err;
        return { status: "pending", todo: `day2's operator: in Business Settings → Pages, assign day2's system user to "${ownerPage.name ?? pageId}" with the Advertise task.` };
      }
    };

    const clients = await graphAll<{ id: string }>(graph, "client pages", `${businessId}/client_pages`, { fields: "id", limit: 100 });
    if (clients.some((p) => p.id === pageId)) return assign();

    const pending = await graphAll<{ id: string; page?: { id: string } }>(graph, "pending page requests", `${businessId}/pending_client_pages`, { fields: "id,page{id}", limit: 100 });
    if (pending.some((p) => p.id === pageId || p.page?.id === pageId)) return { status: "pending", todo: APPROVE_TODO };

    const r = await graph<{ access_status?: string }>("request Page access", "POST", `${businessId}/client_pages`, { form: { page_id: pageId, permitted_tasks: PAGE_TASKS } });
    if (r.access_status && r.access_status !== "PENDING") return assign();
    return { status: "pending", todo: APPROVE_TODO };
  },

  credentials(app, tokens, adAccountId): MetaCreds {
    const id = normalizeAccountId(adAccountId);
    if (!id) throw new PlatformError("meta", `"${adAccountId}" is not a Meta ad account id`);
    return { accessToken: tokens.accessToken, adAccountId: id, appSecret: app.appSecret, apiVersion: version(app) };
  },
};
