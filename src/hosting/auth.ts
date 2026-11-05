import { createPrivateKey, sign } from "node:crypto";
import type { AppleSignIn, GoogleSignIn, HostEnv, HostingPlan, SmtpSettings } from "./types";

/**
 * Sign-in for the app (Supabase Auth): where links go back to (the app's
 * deep link scheme), the emails in the app's language, Apple and Google with
 * the owner's own developer accounts, and who sends the emails.
 *
 * Field names are the Management API's PATCH /v1/projects/{ref}/config/auth
 * body (checked against the OpenAPI spec, November 2026).
 */

/** Pure. Site URL and allowed redirect URLs. Staging also allows Expo Go (exp://) for development builds. */
export function redirects(plan: Pick<HostingPlan, "scheme">, env: HostEnv, appBaseUrl?: string | null): { siteUrl: string | null; redirectUrls: string[] } {
  const scheme = plan.scheme?.replace(/:\/*$/, "") || null;
  const urls = [...(scheme ? [`${scheme}://**`] : []), ...(appBaseUrl ? [`${appBaseUrl.replace(/\/$/, "")}/**`] : []), ...(env === "staging" ? ["exp://**"] : [])];
  return { siteUrl: scheme ? `${scheme}://` : (appBaseUrl ?? null), redirectUrls: urls };
}

type Templates = Record<"confirmation" | "magic_link" | "recovery" | "invite" | "email_change", { subject: string; body: string }>;

const page = (title: string, text: string, button: string) =>
  `<h2>${title}</h2>\n<p>${text}</p>\n<p><a href="{{ .ConfirmationURL }}">${button}</a></p>\n<p>{{ .Token }}</p>`;

/** Pure. The sign-in emails in the app's language (English for anything but German). `{{ .Token }}` is the code for apps that type it in. */
export function emailTemplates(appName: string, lang: string): { lang: "en" | "de"; templates: Templates } {
  const de = lang.toLowerCase().startsWith("de");
  const n = appName.replace(/[<>{}]/g, "");
  if (de) {
    return {
      lang: "de",
      templates: {
        confirmation: { subject: `Bestätige deine E-Mail für ${n}`, body: page(`Willkommen bei ${n}`, "Tippe auf den Link, um deine E-Mail-Adresse zu bestätigen, oder gib diesen Code in der App ein:", "E-Mail bestätigen") },
        magic_link: { subject: `Dein Anmeldelink für ${n}`, body: page(`Anmelden bei ${n}`, "Tippe auf den Link, um dich anzumelden, oder gib diesen Code in der App ein:", "Anmelden") },
        recovery: { subject: `Passwort für ${n} zurücksetzen`, body: page("Neues Passwort", "Tippe auf den Link, um ein neues Passwort festzulegen. Wenn du das nicht angefordert hast, ignoriere diese E-Mail.", "Passwort zurücksetzen") },
        invite: { subject: `Du wurdest zu ${n} eingeladen`, body: page(`Einladung zu ${n}`, "Tippe auf den Link, um die Einladung anzunehmen.", "Einladung annehmen") },
        email_change: { subject: `Neue E-Mail-Adresse für ${n} bestätigen`, body: page("E-Mail-Adresse ändern", "Tippe auf den Link, um deine neue E-Mail-Adresse zu bestätigen.", "Neue Adresse bestätigen") },
      },
    };
  }
  return {
    lang: "en",
    templates: {
      confirmation: { subject: `Confirm your email for ${n}`, body: page(`Welcome to ${n}`, "Tap the link to confirm your email address, or enter this code in the app:", "Confirm email") },
      magic_link: { subject: `Your sign-in link for ${n}`, body: page(`Sign in to ${n}`, "Tap the link to sign in, or enter this code in the app:", "Sign in") },
      recovery: { subject: `Reset your ${n} password`, body: page("New password", "Tap the link to choose a new password. If you didn't ask for this, ignore this email.", "Reset password") },
      invite: { subject: `You're invited to ${n}`, body: page(`Join ${n}`, "Tap the link to accept the invitation.", "Accept invitation") },
      email_change: { subject: `Confirm your new email for ${n}`, body: page("Change email", "Tap the link to confirm your new email address.", "Confirm new email") },
    },
  };
}

/** Parses smtp://user:pass@host:port (or smtps://). */
export function smtpFromUrl(url: string, from: string): SmtpSettings {
  const u = new URL(url);
  if (!/^smtps?:$/.test(u.protocol) || !u.hostname) throw new Error("The SMTP address looks like smtp://user:password@host:587.");
  return { host: u.hostname, port: Number(u.port || (u.protocol === "smtps:" ? 465 : 587)), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password), from, senderName: null };
}

/**
 * Apple's client secret for Sign in with Apple through Supabase (web/Android
 * flow): an ES256 JWT signed with the owner's key, at most 6 months valid —
 * day2 makes a new one before it runs out (operations.ts). Native iOS sign-in
 * needs only the bundle id as a client id.
 */
export function appleClientSecret(a: AppleSignIn, clientId: string, now: Date, days = 180): { jwt: string; expiresAt: string } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + days * 86_400;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid: a.keyId, typ: "JWT" });
  const body = b64({ iss: a.teamId, iat, exp, aud: "https://appleid.apple.com", sub: clientId });
  const key = createPrivateKey(a.privateKey);
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { jwt: `${head}.${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Pure. Checks what the owner pasted for Apple; throws a plain-language error. */
export function parseApple(input: unknown): AppleSignIn {
  const o = (input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const teamId = s("teamId");
  const keyId = s("keyId");
  const privateKey = s("privateKey");
  const servicesId = s("servicesId") || null;
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("The Team ID is 10 letters and digits (developer.apple.com → Membership details).");
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("The Key ID is 10 letters and digits, shown next to the Sign in with Apple key.");
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(privateKey)) throw new Error("Paste the whole .p8 key file, including the BEGIN and END lines.");
  if (servicesId && !/^[A-Za-z0-9.-]{3,}$/.test(servicesId)) throw new Error("The Services ID looks like com.example.app.signin.");
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error("That .p8 key can't be read — download it again from Certificates, Identifiers & Profiles → Keys.");
  }
  return { teamId, keyId, privateKey, servicesId };
}

/** Pure. Checks what the owner pasted for Google. */
export function parseGoogle(input: unknown): GoogleSignIn {
  const o = (input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const id = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
  const webClientId = s("webClientId");
  const webClientSecret = s("webClientSecret");
  const iosClientId = s("iosClientId") || null;
  const androidClientId = s("androidClientId") || null;
  if (!id.test(webClientId)) throw new Error("The web client ID ends in .apps.googleusercontent.com (Google Cloud → APIs & Services → Credentials → OAuth 2.0 Client IDs, type Web application).");
  if (webClientSecret.length < 10 || /\s/.test(webClientSecret)) throw new Error("Paste the web client's secret (shown with the client ID).");
  for (const [k, v] of [["iOS", iosClientId], ["Android", androidClientId]] as const) if (v && !id.test(v)) throw new Error(`The ${k} client ID ends in .apps.googleusercontent.com.`);
  return { webClientId, webClientSecret, iosClientId, androidClientId };
}

export type ProviderTest = { ok: true } | { ok: false; error: string };

/**
 * Connection tests: a token request with a made-up code. Right credentials
 * get "invalid_grant" (the code is wrong); wrong ones get "invalid_client".
 */
export async function testApple(a: AppleSignIn, clientId: string, f: typeof fetch = fetch, now = new Date()): Promise<ProviderTest> {
  const secret = appleClientSecret(a, clientId, now, 1).jwt;
  const body = new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: "authorization_code", code: "day2-connection-test" });
  return tokenTest(() => f("https://appleid.apple.com/auth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), "Apple");
}

export async function testGoogle(g: GoogleSignIn, f: typeof fetch = fetch): Promise<ProviderTest> {
  const body = new URLSearchParams({ client_id: g.webClientId, client_secret: g.webClientSecret, grant_type: "authorization_code", code: "day2-connection-test", redirect_uri: "https://localhost/day2-test" });
  return tokenTest(() => f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), "Google");
}

async function tokenTest(go: () => Promise<Response>, who: string): Promise<ProviderTest> {
  try {
    const res = await go();
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (j.error === "invalid_grant" || j.error === "redirect_uri_mismatch") return { ok: true };
    if (j.error === "invalid_client" || j.error === "unauthorized_client") return { ok: false, error: `${who} didn't accept these details (${j.error}). Check the IDs and the key or secret.` };
    return res.ok ? { ok: true } : { ok: false, error: `${who} answered ${res.status}${j.error ? ` (${j.error})` : ""}.` };
  } catch (err) {
    return { ok: false, error: `${who} can't be reached (${(err as Error).message}).` };
  }
}

/** Pure. The auth config patch for one environment. Secrets go in, but this object is only ever sent to Supabase. */
export function authPatch(o: {
  appName: string;
  plan: HostingPlan;
  env: HostEnv;
  appBaseUrl?: string | null;
  smtp: SmtpSettings | null;
  apple: { clientIds: string[]; secret: string | null } | null;
  google: GoogleSignIn | null;
}): Record<string, unknown> {
  const { siteUrl, redirectUrls } = redirects(o.plan, o.env, o.appBaseUrl);
  const { templates } = emailTemplates(o.appName, o.plan.language);
  const patch: Record<string, unknown> = {
    ...(siteUrl ? { site_url: siteUrl } : {}),
    uri_allow_list: redirectUrls.join(","),
    external_email_enabled: o.plan.auth.email,
    mailer_otp_length: 6,
  };
  for (const [k, t] of Object.entries(templates)) {
    patch[`mailer_subjects_${k}`] = t.subject;
    patch[`mailer_templates_${k}_content`] = t.body;
  }
  if (o.smtp) {
    Object.assign(patch, { smtp_host: o.smtp.host, smtp_port: String(o.smtp.port), smtp_user: o.smtp.user, smtp_pass: o.smtp.pass, smtp_admin_email: o.smtp.from, smtp_sender_name: o.smtp.senderName ?? o.appName, rate_limit_email_sent: 30 });
  }
  if (o.plan.auth.apple && o.apple) {
    Object.assign(patch, { external_apple_enabled: true, external_apple_client_id: o.apple.clientIds.join(","), ...(o.apple.secret ? { external_apple_secret: o.apple.secret } : {}) });
  } else patch.external_apple_enabled = false;
  if (o.plan.auth.google && o.google) {
    const extra = [o.google.iosClientId, o.google.androidClientId].filter(Boolean).join(",");
    // Native Google sign-in on iOS sends an id token without a nonce Supabase can check (Supabase's React Native guide).
    Object.assign(patch, { external_google_enabled: true, external_google_client_id: o.google.webClientId, external_google_secret: o.google.webClientSecret, ...(extra ? { external_google_additional_client_ids: extra } : {}), external_google_skip_nonce_check: true });
  } else patch.external_google_enabled = false;
  return patch;
}
