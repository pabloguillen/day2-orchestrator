import { request } from "../http";
import { DEFAULT_VERSION, LINKEDIN_API, LINKEDIN_OAUTH, accountProblem, orgUrn, type LinkedInCreds } from "../platforms/linkedin";
import { PlatformError, type PlatformDeps } from "../types";
import type { AdAccountChoice, AppCredentials, IdentityChoice, PlatformConnect, Purpose, Tokens } from "./types";

/**
 * Connecting LinkedIn (3-legged OAuth 2.0, authorization code flow):
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 *
 *  - purpose "account": day2's operator (or a customer) connects a member with a role on an ad account.
 *  - purpose "identity": the app's Page super admin connects so day2 can list their Pages and check /
 *    set up day2's "Sponsored Content Poster" role.
 *
 * Page roles: LinkedIn's versioned API only lets a member *request* DIRECT_SPONSORED_CONTENT_POSTER
 * for themselves (PUT organizationAcls, state REQUESTED); a Page super admin approves it in the Page's
 * admin tools. So grantIdentity files the request as day2's member and returns "pending" until approved.
 */

const ID = "linkedin" as const;

const SCOPES: Record<Purpose, string[]> = {
  account: ["rw_ads", "r_ads_reporting", "w_organization_social", "rw_conversions"],
  identity: ["rw_organization_admin"],
  // Organic posting is Meta/TikTok only (src/social/); never started for LinkedIn.
  social: ["rw_organization_admin"],
};
const CAMPAIGN_ROLES = ["ACCOUNT_BILLING_ADMIN", "ACCOUNT_MANAGER", "CAMPAIGN_MANAGER"];
const PAGE_ROLES_FOR_ADS = ["ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"];

type Acl = { role?: string; state?: string; roleAssignee?: string; organization?: string; organizationTarget?: string };
type TokenResponse = { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string };

const enc = encodeURIComponent;
const personUrn = (id: string) => (id.startsWith("urn:li:person:") ? id : `urn:li:person:${id}`);
const personId = (urn: string) => urn.replace(/^urn:li:person:/, "");
const aclOrg = (a: Acl) => a.organization ?? a.organizationTarget;

function version(app: AppCredentials) {
  return app.apiVersion && /^\d{6}(\.\d+)?$/.test(app.apiVersion) ? app.apiVersion : DEFAULT_VERSION;
}

/** A usable access token: the stored one, or a fresh one from the refresh token when it has expired. */
async function bearer(app: AppCredentials, tokens: Tokens, deps: PlatformDeps): Promise<string> {
  const now = (deps.now ? deps.now() : new Date()).getTime();
  if (tokens.accessToken && (!tokens.expiresAt || tokens.expiresAt - 60_000 > now)) return tokens.accessToken;
  if (!tokens.refreshToken) throw new PlatformError(ID, "LinkedIn access token expired and there is no refresh token; reconnect LinkedIn");
  const r = await request<TokenResponse>(ID, deps, `${LINKEDIN_OAUTH}/accessToken`, {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: app.clientId ?? "", client_secret: app.clientSecret ?? "" },
  });
  if (!r?.access_token) throw new PlatformError(ID, "token refresh returned no access_token");
  return r.access_token;
}

async function api<T>(app: AppCredentials, token: string, deps: PlatformDeps, path: string, init: { method?: "GET" | "PUT"; json?: unknown } = {}): Promise<T> {
  return request<T>(ID, deps, `${LINKEDIN_API}${path}`, {
    method: init.method ?? "GET",
    json: init.json,
    headers: { authorization: `Bearer ${token}`, "linkedin-version": version(app), "x-restli-protocol-version": "2.0.0" },
  });
}

/** All pages of a Rest.li finder (start/count paging). */
async function finder<T>(app: AppCredentials, token: string, deps: PlatformDeps, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0, page = 0; page < 20; page++, start += 100) {
    const r = await api<{ elements?: T[] }>(app, token, deps, `${path}&start=${start}&count=100`);
    const els = r?.elements ?? [];
    out.push(...els);
    if (els.length < 100) break;
  }
  return out;
}

export const connect: PlatformConnect = {
  platform: ID,
  appEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_API_VERSION (optional)"],

  appCredentials(env) {
    const clientId = env.LINKEDIN_CLIENT_ID?.trim();
    const clientSecret = env.LINKEDIN_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    const v = env.LINKEDIN_API_VERSION?.trim();
    return { clientId, clientSecret, apiVersion: v && /^\d{6}(\.\d+)?$/.test(v) ? v : DEFAULT_VERSION };
  },

  async authorizeUrl(app, o) {
    const u = new URL(`${LINKEDIN_OAUTH}/authorization`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", app.clientId ?? "");
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("state", o.state);
    u.searchParams.set("scope", SCOPES[o.purpose].join(" "));
    return { url: u.toString() };
  },

  async exchange(app, o, deps = {}) {
    if (o.query.error) throw new PlatformError(ID, `authorization failed: ${o.query.error}${o.query.error_description ? ` (${o.query.error_description})` : ""}`);
    const code = o.query.code;
    if (!code) throw new PlatformError(ID, "callback has no authorization code");
    const r = await request<TokenResponse>(ID, deps, `${LINKEDIN_OAUTH}/accessToken`, {
      method: "POST",
      form: { grant_type: "authorization_code", code, client_id: app.clientId ?? "", client_secret: app.clientSecret ?? "", redirect_uri: o.redirectUri },
      retries: 1, // codes are single-use
    });
    if (!r?.access_token) throw new PlatformError(ID, "token exchange returned no access_token");
    const now = (deps.now ? deps.now() : new Date()).getTime();
    const scopes = (r.scope ?? "").split(/[\s,]+/).filter(Boolean);
    const tokens: Tokens = {
      accessToken: r.access_token,
      ...(r.refresh_token ? { refreshToken: r.refresh_token } : {}),
      ...(r.expires_in ? { expiresAt: now + r.expires_in * 1000 } : {}),
      scopes,
    };

    // Member id without needing OpenID scopes: ad account users or Page roles both name the member.
    try {
      if (scopes.includes("rw_ads") || scopes.includes("r_ads")) {
        const users = await api<{ elements?: Array<{ user?: string }> }>(app, r.access_token, deps, `/adAccountUsers?q=authenticatedUser`);
        const user = users?.elements?.find((u) => u.user)?.user;
        if (user) tokens.userId = personId(user);
      }
      if (!tokens.userId && (scopes.includes("rw_organization_admin") || scopes.includes("r_organization_admin"))) {
        const acls = await api<{ elements?: Acl[] }>(app, r.access_token, deps, `/organizationAcls?q=roleAssignee&count=1`);
        const who = acls?.elements?.find((a) => a.roleAssignee)?.roleAssignee;
        if (who) tokens.userId = personId(who);
      }
    } catch (err) {
      if (err instanceof PlatformError && err.retryable) throw err;
      /* member id is optional: grantIdentity says so if it's missing */
    }
    return tokens;
  },

  async listAdAccounts(app, tokens, deps = {}): Promise<AdAccountChoice[]> {
    const token = await bearer(app, tokens, deps);
    const users = await api<{ elements?: Array<{ account?: string; role?: string }> }>(app, token, deps, `/adAccountUsers?q=authenticatedUser`);
    const roles = new Map<string, string>();
    for (const u of users?.elements ?? []) {
      const id = u.account?.replace(/^urn:li:sponsoredAccount:/, "");
      if (id && /^\d+$/.test(id) && !(roles.get(id) && CAMPAIGN_ROLES.includes(roles.get(id)!))) roles.set(id, u.role ?? "");
    }
    const out: AdAccountChoice[] = [];
    for (const [id, role] of roles) {
      const a = await api<{ name?: string; currency?: string; status?: string; servingStatuses?: string[] }>(app, token, deps, `/adAccounts/${id}`);
      let problem = accountProblem(a ?? {});
      if (!problem && !CAMPAIGN_ROLES.includes(role)) problem = `your role on this ad account is ${role || "unknown"}; day2 needs Campaign Manager, Account Manager or Billing admin`;
      out.push({ id, name: a?.name ?? id, currency: a?.currency ?? "USD", canSpend: !problem, ...(problem ? { problem } : {}) });
    }
    return out;
  },

  async listIdentities(app, tokens, deps = {}): Promise<IdentityChoice[]> {
    const token = await bearer(app, tokens, deps);
    const acls = await finder<Acl>(app, token, deps, `/organizationAcls?q=roleAssignee&state=APPROVED`);
    const orgs = [...new Set(acls.filter((a) => PAGE_ROLES_FOR_ADS.includes(a.role ?? "")).map(aclOrg).filter((o): o is string => !!o))];
    const out: IdentityChoice[] = [];
    for (const org of orgs) {
      let name = org;
      try {
        const o = await api<{ localizedName?: string }>(app, token, deps, `/organizations/${org.replace(/^urn:li:organization:/, "")}`);
        if (o?.localizedName) name = o.localizedName;
      } catch (err) {
        if (err instanceof PlatformError && err.retryable) throw err;
      }
      out.push({ ref: org, name, kind: "company_page" });
    }
    return out;
  },

  async grantIdentity(app, owner, ref, day2, deps = {}) {
    const org = orgUrn(ref);
    if (!/^urn:li:organization:\d+$/.test(org)) throw new PlatformError(ID, `not a LinkedIn organization: ${ref}`);
    if (!day2.tokens.userId) throw new PlatformError(ID, "day2's LinkedIn member id is unknown; reconnect day2's LinkedIn ad account");
    const member = personUrn(day2.tokens.userId);

    // The owner's view of the Page's roles (needs Super admin on the Page).
    const ownerToken = await bearer(app, owner, deps);
    let acls: Acl[];
    try {
      acls = await finder<Acl>(app, ownerToken, deps, `/organizationAcls?q=organization&organization=${enc(org)}`);
    } catch (err) {
      if (err instanceof PlatformError && (err.status === 401 || err.status === 403))
        throw new PlatformError(ID, `the connected LinkedIn member isn't a Super admin of ${org}`, err.status);
      throw err;
    }
    const day2Roles = acls.filter((a) => a.roleAssignee === member && aclOrg(a) === org);
    if (day2Roles.some((a) => a.state === "APPROVED" && PAGE_ROLES_FOR_ADS.includes(a.role ?? ""))) return { status: "ready" as const };

    // LinkedIn only lets a member request this role for themselves; file it as day2's member.
    if (!day2Roles.some((a) => a.state === "REQUESTED" && a.role === "DIRECT_SPONSORED_CONTENT_POSTER")) {
      const day2Token = await bearer(app, day2.tokens, deps);
      await api(app, day2Token, deps, `/organizationAcls/(organization:${enc(org)},role:DIRECT_SPONSORED_CONTENT_POSTER,roleAssignee:${enc(member)})`, {
        method: "PUT",
        json: { state: "REQUESTED", role: "DIRECT_SPONSORED_CONTENT_POSTER", roleAssignee: member, organization: org },
      });
    }
    return {
      status: "pending" as const,
      todo: "On LinkedIn, open your Page's admin view → Settings → Manage admins → Paid media admins, and approve day2's request for the Sponsored Content Poster role.",
    };
  },

  credentials(app, tokens, adAccountId): LinkedInCreds {
    if (!tokens.refreshToken) throw new PlatformError(ID, "this LinkedIn connection has no refresh token; the LinkedIn app needs programmatic refresh tokens enabled");
    const id = adAccountId.replace(/^urn:li:sponsoredAccount:/, "");
    if (!/^\d+$/.test(id)) throw new PlatformError(ID, `not a LinkedIn ad account id: ${adAccountId}`);
    return { clientId: app.clientId ?? "", clientSecret: app.clientSecret ?? "", refreshToken: tokens.refreshToken, adAccountId: id, apiVersion: version(app) };
  },
};
