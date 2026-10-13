import type { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { PLANS, readCredits } from "./credits";
import { userCanAccessInstallation } from "./github-app";

/**
 * Sign-in, sessions, customer accounts and members.
 *
 * People sign in with GitHub (day2's GitHub App), Google, or a one-time link
 * sent by email — no day2 password. Each way in is an identity of one
 * person; a verified email that matches joins the same person. On a first
 * sign-in day2 creates their workspace, or joins the workspaces they were
 * invited to (by GitHub username or email). A session is a random 256-bit token in an
 * HttpOnly, SameSite=Lax cookie; only its SHA-256 is stored, so a database
 * leak can't be replayed as a login.
 */

export type Role = "owner" | "admin" | "member";

export type SessionUser = { id: string; githubId: number | null; login: string | null; name: string | null; email: string | null; avatarUrl: string | null };
export type SessionAccount = { id: string; name: string; role: Role; githubInstallationId: number | null };
export type Session = { tokenHash: string; user: SessionUser; account: SessionAccount };

export const SESSION_COOKIE = "day2_session";
export const SESSION_DAYS = 30;
const INVITE_DAYS = 14;
const OAUTH_STATE_MINUTES = 10;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

export function authConfig() {
  return {
    githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    /** Where people reach day2 (console + API behind one origin), e.g. https://app.day2.dev */
    publicUrl: (process.env.DAY2_PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    /** Development only: sign in as any GitHub login without GitHub. */
    devLogin: process.env.DAY2_DEV_LOGIN === "on" && process.env.NODE_ENV !== "production",
  };
}

export function secureCookies(): boolean {
  return authConfig().publicUrl.startsWith("https://");
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secureCookies() ? "; Secure" : ""}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies() ? "; Secure" : ""}`;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Only redirect to a path on day2 itself after sign-in. */
export function safeNextPath(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

type UserRow = { id: string; github_id: string | number | null; login: string | null; name: string | null; email: string | null; avatar_url: string | null };

const toUser = (r: UserRow): SessionUser => ({
  id: r.id,
  githubId: r.github_id === null ? null : Number(r.github_id),
  login: r.login,
  name: r.name,
  email: r.email,
  avatarUrl: r.avatar_url,
});

export async function createSession(sql: SQL, userId: string, accountId: string, userAgent: string | null): Promise<string> {
  const token = newToken();
  await sql`INSERT INTO sessions (token_hash, user_id, account_id, expires_at, user_agent)
    VALUES (${hashToken(token)}, ${userId}, ${accountId}, now() + make_interval(days => ${SESSION_DAYS}), ${userAgent?.slice(0, 300) ?? null})`;
  return token;
}

/** The session for a cookie token, or null. Expired sessions are deleted;
 * a session whose membership was removed no longer works. */
export async function resolveSession(sql: SQL, token: string | undefined): Promise<Session | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashToken(token);
  const rows = (await sql`
    SELECT s.expires_at, s.last_seen_at, u.*, a.id AS account_id, a.name AS account_name, a.github_installation_id, m.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN accounts a ON a.id = s.account_id
    JOIN memberships m ON m.account_id = s.account_id AND m.user_id = s.user_id
    WHERE s.token_hash = ${tokenHash}`) as Array<UserRow & { expires_at: Date; last_seen_at: Date; account_id: string; account_name: string; github_installation_id: string | number | null; role: Role }>;
  const r = rows[0];
  if (!r) return null;
  if (new Date(r.expires_at).getTime() < Date.now()) {
    await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
    return null;
  }
  // Sliding expiry, written at most every few minutes.
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60_000) {
    await sql`UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => ${SESSION_DAYS}) WHERE token_hash = ${tokenHash}`;
  }
  return { tokenHash, user: toUser(r), account: { id: r.account_id, name: r.account_name, role: r.role, githubInstallationId: r.github_installation_id === null ? null : Number(r.github_installation_id) } };
}

export async function deleteSession(sql: SQL, tokenHash: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
}

export async function switchAccount(sql: SQL, session: Session, accountId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM memberships WHERE user_id = ${session.user.id} AND account_id = ${accountId}`;
  if (!rows.length) return false;
  await sql`UPDATE sessions SET account_id = ${accountId} WHERE token_hash = ${session.tokenHash}`;
  return true;
}

// ---------------------------------------------------------------------------
// OAuth round-trips (GitHub, Google)
// ---------------------------------------------------------------------------

export type OAuthProvider = "github" | "google";
export type OAuthState = { nextPath: string; provider: OAuthProvider; accountId: string | null; userId: string | null };

/**
 * A one-time `state` for an OAuth round-trip (login CSRF protection). For
 * "Connect GitHub" it also records the workspace and the person who started
 * it, so the return can only complete for that same signed-in person.
 */
export async function createOAuthState(
  sql: SQL,
  nextPath: string,
  accountId: string | null = null,
  opts: { provider?: OAuthProvider; userId?: string | null } = {},
): Promise<string> {
  const state = newToken();
  await sql`DELETE FROM oauth_states WHERE created_at < now() - make_interval(mins => ${OAUTH_STATE_MINUTES})`;
  await sql`INSERT INTO oauth_states (state, next_path, account_id, provider, user_id)
    VALUES (${state}, ${safeNextPath(nextPath)}, ${accountId}, ${opts.provider ?? "github"}, ${opts.userId ?? null})`;
  return state;
}

/** One-time use: what the state was created with, or null if unknown/expired. */
export async function consumeOAuthState(sql: SQL, state: string | null): Promise<OAuthState | null> {
  if (!state || state.length > 200) return null;
  const rows = (await sql`DELETE FROM oauth_states WHERE state = ${state} AND created_at > now() - make_interval(mins => ${OAUTH_STATE_MINUTES})
    RETURNING next_path, account_id, provider, user_id`) as Array<{ next_path: string; account_id: string | null; provider: OAuthProvider; user_id: string | null }>;
  const r = rows[0];
  return r ? { nextPath: r.next_path, accountId: r.account_id, provider: r.provider, userId: r.user_id } : null;
}

// ---------------------------------------------------------------------------
// Sign-in with GitHub
// ---------------------------------------------------------------------------

export function githubAuthorizeUrl(state: string): string {
  const c = authConfig();
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", c.githubClientId);
  u.searchParams.set("redirect_uri", `${c.publicUrl}/api/auth/github/callback`);
  u.searchParams.set("state", state);
  return u.toString();
}

export type GitHubProfile = { id: number; login: string; name: string | null; email: string | null; emailVerified?: boolean; avatarUrl: string | null };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Exchanges the OAuth code and reads who signed in. The user token is used
 * for these calls only and never stored. With `installationId` (the "Connect
 * GitHub" round-trip), also checks that this person can really see that
 * installation of day2's GitHub App. */
export async function fetchGitHubProfile(
  code: string,
  fetchImpl: FetchLike = fetch,
  opts: { installationId?: number } = {},
): Promise<GitHubProfile & { installationVerified?: boolean }> {
  const c = authConfig();
  const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: c.githubClientId, client_secret: c.githubClientSecret, code, redirect_uri: `${c.publicUrl}/api/auth/github/callback` }),
  });
  const tok = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!tok.access_token) throw new Error(`GitHub sign-in failed: ${tok.error_description ?? "no token"}`);
  const headers = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "day2" };
  const userRes = await fetchImpl("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new Error(`GitHub sign-in failed: couldn't read the profile (${userRes.status}).`);
  const u = (await userRes.json()) as { id: number; login: string; name: string | null; email: string | null; avatar_url: string | null };
  // The primary, verified address — only a verified email may join this
  // GitHub identity to a person who signed in another way.
  let email: string | null = null;
  let emailVerified = false;
  const r = await fetchImpl("https://api.github.com/user/emails", { headers });
  if (r.ok) {
    const primary = ((await r.json()) as Array<{ email: string; primary: boolean; verified: boolean }>).find((e) => e.primary && e.verified);
    if (primary) {
      email = primary.email;
      emailVerified = true;
    }
  }
  if (!email) email = u.email;
  const profile: GitHubProfile & { installationVerified?: boolean } = { id: u.id, login: u.login, name: u.name, email, emailVerified, avatarUrl: u.avatar_url };
  if (opts.installationId !== undefined) profile.installationVerified = await userCanAccessInstallation(tok.access_token, opts.installationId, fetchImpl);
  return profile;
}

/** Links day2's GitHub App installation to an account (owners and admins). */
export async function attachInstallation(sql: SQL, accountId: string, userId: string, installationId: number): Promise<MemberResult> {
  const [m] = (await sql`SELECT role FROM memberships WHERE account_id = ${accountId} AND user_id = ${userId}`) as Array<{ role: Role }>;
  if (!m || !canManage(m.role)) return { ok: false, status: 403, reason: "Only owners and admins can connect GitHub." };
  const taken = (await sql`SELECT id FROM accounts WHERE github_installation_id = ${installationId} AND id <> ${accountId}`) as Array<{ id: string }>;
  if (taken.length) return { ok: false, status: 409, reason: "That GitHub account is already connected to another day2 workspace." };
  await sql`UPDATE accounts SET github_installation_id = ${installationId} WHERE id = ${accountId}`;
  return { ok: true };
}

export type Identity = {
  provider: "github" | "google" | "email";
  /** The provider's stable id: GitHub user id, Google `sub`, or the email. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  /** GitHub only. */
  login?: string;
  githubId?: number;
};

export type SignInResult = { userId: string; accountId: string; created: boolean };

const normEmail = (e: string) => e.trim().toLowerCase();

/**
 * The person behind an identity — found, joined by verified email, or
 * created — plus the workspace to open. Pending invitations (by GitHub
 * username or verified email) are accepted here; someone with no workspace
 * and no invitation gets their own (on the trial).
 */
export async function signInIdentity(sql: SQL, id: Identity): Promise<SignInResult> {
  const email = id.email ? normEmail(id.email) : null;
  const verified = Boolean(email && id.emailVerified);
  return sql.begin(async (tx) => {
    // Serialize sign-ins for the same identity / email, so two at once
    // can't create the same person twice.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`identity:${id.provider}:${id.subject}`}))`;
    if (verified) await tx`SELECT pg_advisory_xact_lock(hashtext(${`email:${email}`}))`;

    let userId: string | undefined = (
      (await tx`SELECT user_id FROM identities WHERE provider = ${id.provider} AND subject = ${id.subject}`) as Array<{ user_id: string }>
    )[0]?.user_id;
    if (!userId && verified) {
      userId = ((await tx`SELECT id FROM users WHERE email_verified AND lower(email) = ${email}`) as Array<{ id: string }>)[0]?.id;
    }
    if (id.login) {
      // GitHub usernames move when people rename; free it from a stale holder.
      await tx`UPDATE users SET login = NULL WHERE lower(login) = lower(${id.login}) AND id IS DISTINCT FROM ${userId ?? null}`;
    }
    if (userId) {
      await tx`UPDATE users SET
          name = COALESCE(${id.name}, name),
          avatar_url = COALESCE(${id.avatarUrl}, avatar_url),
          login = COALESCE(${id.login ?? null}, login),
          github_id = COALESCE(${id.githubId ?? null}, github_id),
          email = CASE WHEN email_verified THEN email ELSE COALESCE(${email}, email) END,
          email_verified = email_verified OR ${verified},
          last_login_at = now()
        WHERE id = ${userId}`;
    } else {
      const [u] = (await tx`
        INSERT INTO users (github_id, login, name, email, email_verified, avatar_url, last_login_at)
        VALUES (${id.githubId ?? null}, ${id.login ?? null}, ${id.name}, ${email}, ${verified}, ${id.avatarUrl}, now())
        RETURNING id`) as Array<{ id: string }>;
      userId = u!.id;
    }
    await tx`INSERT INTO identities (provider, subject, user_id, email) VALUES (${id.provider}, ${id.subject}, ${userId}, ${email})
      ON CONFLICT (provider, subject) DO UPDATE SET last_used_at = now(), email = EXCLUDED.email`;

    const invites = (await tx`
      DELETE FROM invites
      WHERE expires_at > now()
        AND ((${id.login ?? null}::text IS NOT NULL AND lower(github_login) = lower(${id.login ?? null}))
          OR (${verified} AND lower(invites.email) = ${email}))
      RETURNING account_id, role`) as Array<{ account_id: string; role: Role }>;
    for (const inv of invites) {
      await tx`INSERT INTO memberships (account_id, user_id, role) VALUES (${inv.account_id}, ${userId}, ${inv.role}) ON CONFLICT DO NOTHING`;
    }
    const existing = (await tx`SELECT account_id FROM memberships WHERE user_id = ${userId} ORDER BY created_at LIMIT 1`) as Array<{ account_id: string }>;
    if (existing[0]) return { userId, accountId: existing[0].account_id, created: false };
    const workspaceName = id.name ?? id.login ?? (email ? email.split("@")[0] : null) ?? "My workspace";
    const [account] = (await tx`INSERT INTO accounts (name) VALUES (${workspaceName}) RETURNING id`) as Array<{ id: string }>;
    await tx`INSERT INTO memberships (account_id, user_id, role) VALUES (${account!.id}, ${userId}, 'owner')`;
    return { userId, accountId: account!.id, created: true };
  }) as Promise<SignInResult>;
}

/** GitHub sign-in: the GitHub identity of a profile. */
export function signInUser(sql: SQL, p: GitHubProfile): Promise<SignInResult> {
  return signInIdentity(sql, {
    provider: "github",
    subject: String(p.id),
    githubId: p.id,
    login: p.login,
    email: p.email,
    emailVerified: p.emailVerified ?? false,
    name: p.name,
    avatarUrl: p.avatarUrl,
  });
}

/**
 * "Connect GitHub" by someone who signed in another way: remember their
 * GitHub identity too (so "Continue with GitHub" works for them later),
 * unless it already belongs to another person.
 */
export async function linkGitHubIdentity(sql: SQL, userId: string, p: GitHubProfile): Promise<boolean> {
  return sql.begin(async (tx) => {
    const owner = ((await tx`SELECT user_id FROM identities WHERE provider = 'github' AND subject = ${String(p.id)}`) as Array<{ user_id: string }>)[0];
    if (owner && owner.user_id !== userId) return false;
    const taken = await tx`SELECT 1 FROM users WHERE lower(login) = lower(${p.login}) AND id <> ${userId}`;
    if (taken.length) return false;
    await tx`INSERT INTO identities (provider, subject, user_id, email) VALUES ('github', ${String(p.id)}, ${userId}, ${p.email})
      ON CONFLICT (provider, subject) DO UPDATE SET last_used_at = now()`;
    await tx`UPDATE users SET github_id = COALESCE(github_id, ${p.id}), login = COALESCE(login, ${p.login}), avatar_url = COALESCE(avatar_url, ${p.avatarUrl}) WHERE id = ${userId}`;
    return true;
  }) as Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Sign-in with a one-time link by email
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const isEmail = (s: string) => s.length <= 320 && EMAIL_RE.test(s.trim());

const EMAIL_LINK_MINUTES = 15;
/** Per address and per network address, so nobody can flood an inbox or the mail server. */
const EMAIL_LINKS_PER_ADDRESS = { count: 5, minutes: 15 };
const EMAIL_LINKS_PER_IP = { count: 30, minutes: 60 };

export type EmailLinkRequest =
  | { ok: true; token: string | null } // token null: rate-limited for this address (the caller still says "check your email")
  | { ok: false; status: number; reason: string };

/** Creates a one-time sign-in token for an email address. */
export async function createEmailSignIn(sql: SQL, rawEmail: string, nextPath: string, ip: string | null): Promise<EmailLinkRequest> {
  if (!isEmail(rawEmail)) return { ok: false, status: 400, reason: "That doesn't look like an email address." };
  const email = normEmail(rawEmail);
  await sql`DELETE FROM email_sign_in WHERE created_at < now() - interval '1 day'`;
  if (ip) {
    const [byIp] = (await sql`SELECT count(*)::int AS n FROM email_sign_in WHERE ip = ${ip} AND created_at > now() - make_interval(mins => ${EMAIL_LINKS_PER_IP.minutes})`) as Array<{ n: number }>;
    if (byIp!.n >= EMAIL_LINKS_PER_IP.count) return { ok: false, status: 429, reason: "Too many sign-in emails from here — try again in a while." };
  }
  const [byEmail] = (await sql`SELECT count(*)::int AS n FROM email_sign_in WHERE lower(email) = ${email} AND created_at > now() - make_interval(mins => ${EMAIL_LINKS_PER_ADDRESS.minutes})`) as Array<{ n: number }>;
  if (byEmail!.n >= EMAIL_LINKS_PER_ADDRESS.count) return { ok: true, token: null };
  const token = newToken();
  await sql`INSERT INTO email_sign_in (token_hash, email, next_path, ip, expires_at)
    VALUES (${hashToken(token)}, ${email}, ${safeNextPath(nextPath)}, ${ip}, now() + make_interval(mins => ${EMAIL_LINK_MINUTES}))`;
  return { ok: true, token };
}

/** Uses a sign-in token (once): the address it proves, or null. */
export async function consumeEmailSignIn(sql: SQL, token: string | null | undefined): Promise<{ email: string; nextPath: string } | null> {
  if (!token || token.length > 200) return null;
  const rows = (await sql`UPDATE email_sign_in SET used_at = now()
    WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
    RETURNING email, next_path`) as Array<{ email: string; next_path: string }>;
  return rows[0] ? { email: rows[0].email, nextPath: rows[0].next_path } : null;
}

/** Email sign-in: the email identity (the address is proven by the link). */
export function signInEmail(sql: SQL, email: string): Promise<SignInResult> {
  const e = normEmail(email);
  return signInIdentity(sql, { provider: "email", subject: e, email: e, emailVerified: true, name: null, avatarUrl: null });
}

// ---------------------------------------------------------------------------
// Members and invites
// ---------------------------------------------------------------------------

export const canManage = (role: Role) => role === "owner" || role === "admin";

export async function listAccounts(sql: SQL, userId: string) {
  return (await sql`SELECT a.id, a.name, m.role FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.user_id = ${userId} ORDER BY a.created_at`) as Array<{
    id: string;
    name: string;
    role: Role;
  }>;
}

export async function listMembers(sql: SQL, accountId: string) {
  const members = (await sql`
    SELECT u.id, u.login, u.name, u.email, u.avatar_url, m.role, m.created_at
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.account_id = ${accountId} ORDER BY m.created_at`) as Array<{
    id: string;
    login: string | null;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    role: Role;
    created_at: Date;
  }>;
  const invites = (await sql`SELECT id, github_login, email, role, created_at, expires_at FROM invites WHERE account_id = ${accountId} AND expires_at > now() ORDER BY created_at`) as Array<{
    id: string;
    github_login: string | null;
    email: string | null;
    role: Role;
    created_at: Date;
    expires_at: Date;
  }>;
  return {
    members: members.map((m) => ({
      userId: m.id,
      login: m.login,
      name: m.name,
      email: m.email,
      avatarUrl: m.avatar_url,
      role: m.role,
      since: new Date(m.created_at).toISOString(),
    })),
    invites: invites.map((i) => ({ id: i.id, login: i.github_login, email: i.email, role: i.role, expiresAt: new Date(i.expires_at).toISOString() })),
  };
}

/** Seats = members + open invites, limited by the account's plan. */
export async function seatUsage(sql: SQL, accountId: string): Promise<{ used: number; limit: number }> {
  const [r] = (await sql`
    SELECT (SELECT count(*) FROM memberships WHERE account_id = ${accountId})::int
         + (SELECT count(*) FROM invites WHERE account_id = ${accountId} AND expires_at > now())::int AS used`) as Array<{ used: number }>;
  const { account } = await readCredits({ db: sql, accountId });
  return { used: r!.used, limit: PLANS[account.plan].seats };
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export type MemberResult = { ok: true; invited?: { email: string } | { login: string } } | { ok: false; status: number; reason: string };

/** Invites by GitHub username or by email address. Someone already on day2
 * (that username, or that verified email) joins right away; anyone else on
 * their next sign-in. */
export async function invite(sql: SQL, accountId: string, by: Session, target: string, role: Role): Promise<MemberResult> {
  if (!canManage(by.account.role)) return { ok: false, status: 403, reason: "Only owners and admins can invite people." };
  const raw = target.trim().replace(/^@/, "");
  const byEmail = raw.includes("@");
  if (byEmail ? !isEmail(raw) : !LOGIN_RE.test(raw)) return { ok: false, status: 400, reason: "Enter a GitHub username or an email address." };
  if (role !== "admin" && role !== "member") return { ok: false, status: 400, reason: "role must be admin or member." };
  const email = byEmail ? normEmail(raw) : null;
  const login = byEmail ? null : raw;
  const users = (byEmail
    ? await sql`SELECT id FROM users WHERE email_verified AND lower(email) = ${email}`
    : await sql`SELECT id FROM users WHERE lower(login) = lower(${login})`) as Array<{ id: string }>;
  if (users[0]) {
    const already = await sql`SELECT 1 FROM memberships WHERE account_id = ${accountId} AND user_id = ${users[0].id}`;
    if (already.length) return { ok: false, status: 409, reason: `${raw} is already a member.` };
  }
  const seats = await seatUsage(sql, accountId);
  if (seats.used >= seats.limit) return { ok: false, status: 402, reason: `Your plan includes ${seats.limit} seat${seats.limit === 1 ? "" : "s"} — switch plans to add more people.` };
  if (users[0]) {
    await sql`INSERT INTO memberships (account_id, user_id, role) VALUES (${accountId}, ${users[0].id}, ${role}) ON CONFLICT DO NOTHING`;
    return { ok: true };
  }
  if (byEmail) {
    await sql`INSERT INTO invites (account_id, email, role, invited_by, expires_at)
      VALUES (${accountId}, ${email}, ${role}, ${by.user.id}, now() + make_interval(days => ${INVITE_DAYS}))
      ON CONFLICT (account_id, lower(email)) WHERE email IS NOT NULL DO UPDATE SET role = EXCLUDED.role, expires_at = EXCLUDED.expires_at`;
  } else {
    await sql`INSERT INTO invites (account_id, github_login, role, invited_by, expires_at)
      VALUES (${accountId}, ${login}, ${role}, ${by.user.id}, now() + make_interval(days => ${INVITE_DAYS}))
      ON CONFLICT (account_id, lower(github_login)) DO UPDATE SET role = EXCLUDED.role, expires_at = EXCLUDED.expires_at`;
  }
  return { ok: true, invited: email ? { email } : { login: login! } };
}

export async function revokeInvite(sql: SQL, accountId: string, by: Session, inviteId: string): Promise<MemberResult> {
  if (!canManage(by.account.role)) return { ok: false, status: 403, reason: "Only owners and admins can manage invites." };
  await sql`DELETE FROM invites WHERE id = ${inviteId} AND account_id = ${accountId}`;
  return { ok: true };
}

async function ownerCount(sql: SQL, accountId: string): Promise<number> {
  const [r] = (await sql`SELECT count(*)::int AS n FROM memberships WHERE account_id = ${accountId} AND role = 'owner'`) as Array<{ n: number }>;
  return r!.n;
}

export async function setRole(sql: SQL, accountId: string, by: Session, userId: string, role: Role): Promise<MemberResult> {
  if (!["owner", "admin", "member"].includes(role)) return { ok: false, status: 400, reason: "role must be owner, admin or member." };
  if (by.account.role !== "owner") return { ok: false, status: 403, reason: "Only owners can change roles." };
  const [m] = (await sql`SELECT role FROM memberships WHERE account_id = ${accountId} AND user_id = ${userId}`) as Array<{ role: Role }>;
  if (!m) return { ok: false, status: 404, reason: "No such member." };
  if (m.role === "owner" && role !== "owner" && (await ownerCount(sql, accountId)) <= 1) {
    return { ok: false, status: 409, reason: "An account needs at least one owner." };
  }
  await sql`UPDATE memberships SET role = ${role} WHERE account_id = ${accountId} AND user_id = ${userId}`;
  return { ok: true };
}

export async function removeMember(sql: SQL, accountId: string, by: Session, userId: string): Promise<MemberResult> {
  const self = userId === by.user.id;
  if (!self && !canManage(by.account.role)) return { ok: false, status: 403, reason: "Only owners and admins can remove people." };
  const [m] = (await sql`SELECT role FROM memberships WHERE account_id = ${accountId} AND user_id = ${userId}`) as Array<{ role: Role }>;
  if (!m) return { ok: false, status: 404, reason: "No such member." };
  if (m.role === "owner" && by.account.role !== "owner") return { ok: false, status: 403, reason: "Only owners can remove an owner." };
  if (m.role === "owner" && (await ownerCount(sql, accountId)) <= 1) return { ok: false, status: 409, reason: "An account needs at least one owner." };
  await sql.begin(async (tx) => {
    await tx`DELETE FROM memberships WHERE account_id = ${accountId} AND user_id = ${userId}`;
    await tx`DELETE FROM sessions WHERE account_id = ${accountId} AND user_id = ${userId}`;
  });
  return { ok: true };
}
