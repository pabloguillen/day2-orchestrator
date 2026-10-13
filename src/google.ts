import { authConfig } from "./auth";

/**
 * "Continue with Google" (OpenID Connect, server-side code flow).
 *
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — a "Web application" OAuth
 *   client in Google Cloud; redirect URI <DAY2_PUBLIC_URL>/api/auth/google/callback.
 *
 * Only the person's id (`sub`), name, picture and email (with whether Google
 * verified it) are read; Google's token is used once and never stored.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function googleConfig() {
  return { clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "" };
}

export function hasGoogle(): boolean {
  const c = googleConfig();
  return Boolean(c.clientId && c.clientSecret);
}

const redirectUri = () => `${authConfig().publicUrl}/api/auth/google/callback`;

export function googleAuthorizeUrl(state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", googleConfig().clientId);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export type GoogleProfile = { sub: string; email: string | null; emailVerified: boolean; name: string | null; picture: string | null };

export async function fetchGoogleProfile(code: string, fetchImpl: FetchLike = fetch): Promise<GoogleProfile> {
  const c = googleConfig();
  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" }).toString(),
  });
  const tok = (await tokenRes.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!tok.access_token) throw new Error(`Google sign-in failed: ${tok.error_description ?? tok.error ?? "no token"}`);
  const res = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } });
  if (!res.ok) throw new Error(`Google sign-in failed: couldn't read the profile (${res.status}).`);
  const u = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean | string; name?: string; picture?: string };
  if (!u.sub) throw new Error("Google sign-in failed: no account id.");
  return {
    sub: u.sub,
    email: u.email ?? null,
    emailVerified: u.email_verified === true || u.email_verified === "true",
    name: u.name ?? null,
    picture: u.picture ?? null,
  };
}
