import { request } from "../http";
import { PlatformError, type PlatformDeps } from "../types";
import type { AdAccountChoice, AppCredentials, PlatformConnect, Tokens } from "./types";
import type { GoogleCreds } from "../platforms/google";

/**
 * Connecting a Google Ads account (OAuth 2.0 web-server flow).
 *
 * - Scope https://www.googleapis.com/auth/adwords (+ .../auth/datamanager for
 *   purpose "account", used to send conversions via the Data Manager API),
 *   access_type=offline and prompt=consent so Google always returns a
 *   refresh token.
 * - listAdAccounts: customers:listAccessibleCustomers (direct access only),
 *   then each account's details; for manager (MCC) accounts also their
 *   client accounts via customer_client. A client reached through a manager
 *   is returned as "<clientId>@<managerId>" so the adapter can send that
 *   manager as login-customer-id.
 * - Developer tokens were sunset on 2026-09-09 (access belongs to the OAuth
 *   client's Google Cloud project); GOOGLE_ADS_DEVELOPER_TOKEN is optional
 *   and only sent when set.
 */

const PLATFORM = "google" as const;
const API_VERSION = "v26";
const ADS = `https://googleads.googleapis.com/${API_VERSION}`;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";
/** Data Manager API (events:ingest): day2's route for sending conversions. */
export const DATAMANAGER_SCOPE = "https://www.googleapis.com/auth/datamanager";

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
type CustomerRow = { customer?: { id?: string; descriptiveName?: string; currencyCode?: string; status?: string; manager?: boolean; testAccount?: boolean } };
type ClientRow = {
  customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; status?: string; manager?: boolean; testAccount?: boolean; level?: string | number };
};

const digits = (s: string | undefined) => (s ?? "").replace(/[\s-]/g, "");

function choice(
  id: string,
  c: { descriptiveName?: string; currencyCode?: string; status?: string; manager?: boolean; testAccount?: boolean },
): AdAccountChoice {
  const base = { id, name: c.descriptiveName || id.split("@")[0]!, currency: c.currencyCode ?? "" };
  if (c.manager) return { ...base, canSpend: false, problem: "manager (MCC) account: pick one of its client accounts" };
  if (c.status && c.status !== "ENABLED") return { ...base, canSpend: false, problem: `account status is ${c.status}` };
  if (c.testAccount) return { ...base, canSpend: false, problem: "test account: never serves ads" };
  return { ...base, canSpend: true };
}

async function accessToken(app: AppCredentials, tokens: Tokens, deps: PlatformDeps): Promise<string> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (tokens.accessToken && (!tokens.expiresAt || tokens.expiresAt - 60_000 > now)) return tokens.accessToken;
  if (!tokens.refreshToken) throw new PlatformError(PLATFORM, "access token expired and no refresh token; reconnect Google Ads", 401);
  const r = await request<TokenResponse>(PLATFORM, deps, TOKEN_URL, {
    method: "POST",
    form: { grant_type: "refresh_token", client_id: app.clientId!, client_secret: app.clientSecret!, refresh_token: tokens.refreshToken },
  });
  if (!r?.access_token) throw new PlatformError(PLATFORM, "OAuth refresh returned no access token", 401);
  return r.access_token;
}

export const connect: PlatformConnect = {
  platform: PLATFORM,
  appEnv: ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID"],

  appCredentials(env) {
    const clientId = env.GOOGLE_ADS_CLIENT_ID?.trim();
    const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    const out: AppCredentials = { clientId, clientSecret };
    const dev = env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
    if (dev) out.developerToken = dev;
    const login = digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
    if (login) {
      if (!/^\d{10}$/.test(login)) return null;
      out.loginCustomerId = login;
    }
    return out;
  },

  async authorizeUrl(app, o) {
    const u = new URL(AUTH_URL);
    u.searchParams.set("client_id", app.clientId!);
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", o.purpose === "account" ? `${ADWORDS_SCOPE} ${DATAMANAGER_SCOPE}` : ADWORDS_SCOPE);
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", o.state);
    return { url: u.toString() };
  },

  async exchange(app, o, deps = {}) {
    if (o.query.error) throw new PlatformError(PLATFORM, `authorization failed: ${o.query.error}`, 400);
    const code = o.query.code;
    if (!code) throw new PlatformError(PLATFORM, "authorization callback has no code", 400);
    const r = await request<TokenResponse>(PLATFORM, deps, TOKEN_URL, {
      method: "POST",
      form: { grant_type: "authorization_code", code, client_id: app.clientId!, client_secret: app.clientSecret!, redirect_uri: o.redirectUri },
    });
    if (!r?.access_token) throw new PlatformError(PLATFORM, "token exchange returned no access token", 401);
    const scopes = (r.scope ?? "").split(/\s+/).filter(Boolean);
    // Granular consent lets people untick scopes; without adwords nothing works.
    if (scopes.length && !scopes.includes(ADWORDS_SCOPE)) throw new PlatformError(PLATFORM, "Google Ads access was not granted; reconnect and allow managing your Google Ads campaigns", 403);
    if (!r.refresh_token) throw new PlatformError(PLATFORM, "Google returned no refresh token; reconnect (consent is required for offline access)", 400);
    const now = (deps.now ?? (() => new Date()))().getTime();
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: now + Number(r.expires_in ?? 3600) * 1000, scopes };
  },

  async listAdAccounts(app, tokens, deps = {}) {
    const bearer = await accessToken(app, tokens, deps);
    const headers = (login?: string) => {
      const h: Record<string, string> = { authorization: `Bearer ${bearer}` };
      if (app.developerToken) h["developer-token"] = app.developerToken;
      if (login) h["login-customer-id"] = login;
      return h;
    };
    const search = async <T>(customerId: string, query: string, login?: string): Promise<T[]> => {
      const rows: T[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = await request<{ results?: T[]; nextPageToken?: string }>(PLATFORM, deps, `${ADS}/customers/${customerId}/googleAds:search`, {
          method: "POST",
          headers: headers(login),
          json: pageToken ? { query, pageToken } : { query },
        });
        rows.push(...(r?.results ?? []));
        pageToken = r?.nextPageToken;
        if (!pageToken) break;
      }
      return rows;
    };

    const list = await request<{ resourceNames?: string[] }>(PLATFORM, deps, `${ADS}/customers:listAccessibleCustomers`, { method: "GET", headers: headers() });
    const ids = (list?.resourceNames ?? []).map((rn) => rn.split("/").pop()!).filter((id) => /^\d+$/.test(id));

    const direct = new Map<string, AdAccountChoice>();
    const managers: string[] = [];
    for (const id of ids) {
      try {
        const rows = await search<CustomerRow>(
          id,
          "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.status, customer.manager, customer.test_account FROM customer",
        );
        const c = rows[0]?.customer;
        if (!c) continue;
        direct.set(id, choice(id, c));
        if (c.manager) managers.push(id);
      } catch (err) {
        if (err instanceof PlatformError && err.retryable) throw err;
        // e.g. CUSTOMER_NOT_ENABLED for cancelled accounts: listed, not usable.
        direct.set(id, { id, name: id, currency: "", canSpend: false, problem: "account can't be read (cancelled or not enabled)" });
      }
    }

    // Client accounts under managers; day2's own MCC first so it wins ties.
    const order = [...managers].sort((a, b) => Number(b === app.loginCustomerId) - Number(a === app.loginCustomerId));
    const viaManager = new Map<string, AdAccountChoice>();
    for (const mgr of order) {
      const rows = await search<ClientRow>(
        mgr,
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.status, customer_client.manager, customer_client.test_account, customer_client.level FROM customer_client WHERE customer_client.level >= 1",
        mgr,
      );
      for (const r of rows) {
        const c = r.customerClient;
        if (!c?.id || c.manager || direct.has(c.id) || viaManager.has(c.id)) continue;
        viaManager.set(c.id, choice(`${c.id}@${mgr}`, c));
      }
    }
    return [...direct.values(), ...viaManager.values()];
  },

  credentials(app, tokens, adAccountId): GoogleCreds {
    const [customer, login] = adAccountId.split("@");
    const customerId = digits(customer);
    if (!/^\d{10}$/.test(customerId)) throw new PlatformError(PLATFORM, `invalid Google Ads account id: ${adAccountId}`);
    if (!tokens.refreshToken) throw new PlatformError(PLATFORM, "no refresh token stored for this connection; reconnect Google Ads");
    if (!app.clientId || !app.clientSecret) throw new PlatformError(PLATFORM, "GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET are not set");
    return {
      developerToken: app.developerToken || undefined,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken: tokens.refreshToken,
      customerId,
      loginCustomerId: login ? digits(login) : undefined,
      apiVersion: API_VERSION,
    };
  },
};
