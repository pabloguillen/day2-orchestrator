/**
 * "Sign in with Google" for an app's Google side (Connect your stores).
 *
 * day2's own Google OAuth client — DAY2_GOOGLE_OAUTH_CLIENT_ID /
 * DAY2_GOOGLE_OAUTH_CLIENT_SECRET, or, when those aren't set, the sign-in
 * client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, src/google.ts): one Web
 * client can carry both redirect URIs. The owner consents once; day2 then
 * sets up their Google Cloud project for the app (connect/google-setup.ts).
 *
 * Scopes:
 *  - cloud-platform: projects (Resource Manager), APIs (Service Usage),
 *    the service account and its key (IAM), Pub/Sub and Firebase. Google
 *    has no narrower scope for IAM / Service Usage / Firebase management,
 *    so this is the one sensitive scope that makes it work.
 *  - androidpublisher: invite the service account in Play Console (users
 *    and grants API) for the owner, in the same step.
 *  - openid email: whose Google account it was, for the hub's label.
 *
 * access_type=online: Google returns no refresh token. The access token
 * (one hour) is kept encrypted only until setup finishes, then revoked and
 * deleted — day2's ongoing work uses the service account it created. A
 * failed, cancelled or abandoned sign-in is revoked and deleted too (the
 * last within the hour, on the backlog timer). PKCE (S256) and a single-use
 * state protect the callback.
 */

export const STORES_CALLBACK_PATH = "/api/ads/connect/callback/googlecloud";

export const STORES_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/androidpublisher",
] as const;

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type StoresOAuthClient = { clientId: string; clientSecret: string; source: "DAY2_GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_CLIENT_ID" };

/** day2's Google OAuth client for this flow, or null when the server has none. */
export function storesOAuthClient(env: Env = process.env): StoresOAuthClient | null {
  const id = env.DAY2_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = env.DAY2_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (id && secret) return { clientId: id, clientSecret: secret, source: "DAY2_GOOGLE_OAUTH_CLIENT_ID" };
  const sid = env.GOOGLE_CLIENT_ID?.trim();
  const ssecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (sid && ssecret) return { clientId: sid, clientSecret: ssecret, source: "GOOGLE_CLIENT_ID" };
  return null;
}

/** Pure. Where Google sends the person after consent. */
export const storesRedirectUri = (publicUrl: string) => `${publicUrl}${STORES_CALLBACK_PATH}`;

/** Pure. Google's consent page. */
/** Pure. Google's consent page; `challenge` is the PKCE S256 challenge of the session's verifier. */
export function storesAuthorizeUrl(c: StoresOAuthClient, o: { state: string; redirectUri: string; challenge: string; loginHint?: string | null }): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", STORES_SCOPES.join(" "));
  u.searchParams.set("state", o.state);
  u.searchParams.set("access_type", "online");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("prompt", "consent select_account");
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (o.loginHint) u.searchParams.set("login_hint", o.loginHint);
  return u.toString();
}

export type StoresToken = { accessToken: string; expiresAt: number; email: string | null; scopes: string[] };

/** Exchanges the callback's code. Throws plain-language errors (no token text in them). */
export async function exchangeStoresCode(c: StoresOAuthClient, code: string, redirectUri: string, verifier: string, doFetch: FetchLike = fetch, now = Date.now()): Promise<StoresToken> {
  const res = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }).toString(),
  }).catch(() => null);
  if (!res) throw new Error("day2 couldn't reach Google. Try again in a minute.");
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string; error_description?: string };
  if (!tok.access_token) throw new Error(`Google didn't finish the sign-in${tok.error ? ` (${tok.error === "invalid_grant" ? "the sign-in expired — try again" : tok.error})` : ""}.`);
  const scopes = (tok.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes("https://www.googleapis.com/auth/cloud-platform")) throw new Error("Google didn't give day2 access to Google Cloud — tick every box on Google's page and try again.");
  return { accessToken: tok.access_token, expiresAt: now + (tok.expires_in ?? 3600) * 1000, email: emailFromIdToken(tok.id_token), scopes };
}

/** Pure. The email in an ID token Google just gave us over TLS (no signature check needed for a label). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf-8")) as { email?: string };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

/** Ends the grant early once setup is done (best effort). */
export async function revokeStoresToken(token: string, doFetch: FetchLike = fetch): Promise<void> {
  await doFetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }).catch(() => null);
}
