import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase } from "./db/test-db";
import {
  consumeOAuthState,
  createOAuthState,
  createSession,
  deleteSession,
  fetchGitHubProfile,
  hashToken,
  invite,
  listAccounts,
  listMembers,
  readCookie,
  removeMember,
  resolveSession,
  safeNextPath,
  seatUsage,
  setRole,
  signInUser,
  switchAccount,
  type GitHubProfile,
  type Session,
} from "./auth";
import { setPlan } from "./credits";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => t.drop());

const profile = (id: number, login: string): GitHubProfile => ({ id, login, name: null, email: `${login}@example.com`, avatarUrl: null });

async function signedIn(p: GitHubProfile): Promise<{ token: string; session: Session }> {
  const r = await signInUser(t.sql, p);
  const token = await createSession(t.sql, r.userId, r.accountId, "test");
  return { token, session: (await resolveSession(t.sql, token))! };
}

describe("helpers", () => {
  test("safeNextPath only allows local paths", () => {
    expect(safeNextPath("/apps/x")).toBe("/apps/x");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
  test("readCookie", () => {
    const req = new Request("http://x", { headers: { cookie: "a=1; day2_session=abc=def; b=2" } });
    expect(readCookie(req, "day2_session")).toBe("abc=def");
    expect(readCookie(req, "nope")).toBeUndefined();
  });
});

describe("GitHub profile", () => {
  test("exchanges the code and falls back to the primary verified email", async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/access_token")) return Response.json({ access_token: "gho_x" });
      if (url.endsWith("/user")) return Response.json({ id: 7, login: "octo", name: "Octo", email: null, avatar_url: "https://a" });
      return Response.json([
        { email: "old@x.com", primary: false, verified: true },
        { email: "octo@x.com", primary: true, verified: true },
      ]);
    };
    expect(await fetchGitHubProfile("code", fake)).toEqual({ id: 7, login: "octo", name: "Octo", email: "octo@x.com", avatarUrl: "https://a" });
    expect(calls).toHaveLength(3);
  });
  test("a bad code fails cleanly", async () => {
    const fake = async () => Response.json({ error_description: "bad_verification_code" });
    await expect(fetchGitHubProfile("bad", fake)).rejects.toThrow("bad_verification_code");
  });
});

describe("OAuth state", () => {
  test("is single-use and keeps a safe next path", async () => {
    const s = await createOAuthState(t.sql, "//evil.com");
    expect(await consumeOAuthState(t.sql, s)).toEqual({ nextPath: "/", accountId: null });
    expect(await consumeOAuthState(t.sql, s)).toBeNull();
    expect(await consumeOAuthState(t.sql, "made-up")).toBeNull();
  });
});

describe("sessions", () => {
  test("first sign-in creates an owner account; the token is stored hashed", async () => {
    const { token, session } = await signedIn(profile(1, "alice"));
    expect(session.user.login).toBe("alice");
    expect(session.account.role).toBe("owner");
    const raw = await t.sql`SELECT 1 FROM sessions WHERE token_hash = ${token}`;
    expect(raw).toHaveLength(0);
    expect(await t.sql`SELECT 1 FROM sessions WHERE token_hash = ${hashToken(token)}`).toHaveLength(1);
    // Signing in again reuses the same account.
    const again = await signInUser(t.sql, { ...profile(1, "alice-renamed") });
    expect(again.created).toBe(false);
    expect(again.accountId).toBe(session.account.id);
  });

  test("unknown, expired and logged-out sessions don't resolve", async () => {
    expect(await resolveSession(t.sql, undefined)).toBeNull();
    expect(await resolveSession(t.sql, "nope")).toBeNull();
    const { token, session } = await signedIn(profile(2, "bob"));
    await t.sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = ${session.tokenHash}`;
    expect(await resolveSession(t.sql, token)).toBeNull();
    expect(await t.sql`SELECT 1 FROM sessions WHERE token_hash = ${session.tokenHash}`).toHaveLength(0);
    const b = await signedIn(profile(2, "bob"));
    await deleteSession(t.sql, b.session.tokenHash);
    expect(await resolveSession(t.sql, b.token)).toBeNull();
  });
});

describe("members", () => {
  test("invites respect roles and the plan's seats; invitees join on sign-in", async () => {
    const owner = await signedIn(profile(10, "owner1"));
    const acct = owner.session.account.id;
    // Trial = 1 seat, already used by the owner.
    const full = await invite(t.sql, acct, owner.session, "newbie", "member");
    expect(full).toMatchObject({ ok: false, status: 402 });
    await setPlan({ db: t.sql, accountId: acct }, "growth", "monthly");
    expect(await seatUsage(t.sql, acct)).toEqual({ used: 1, limit: 3 });
    expect(await invite(t.sql, acct, owner.session, "not a login!", "member")).toMatchObject({ ok: false, status: 400 });
    expect(await invite(t.sql, acct, owner.session, "Newbie", "member")).toEqual({ ok: true });
    expect((await listMembers(t.sql, acct)).invites.map((i) => i.login)).toEqual(["Newbie"]);
    expect(await seatUsage(t.sql, acct)).toEqual({ used: 2, limit: 3 });

    // newbie signs in → gets the invited account, not a new one.
    const newbie = await signedIn(profile(11, "newbie"));
    expect(newbie.session.account.id).toBe(acct);
    expect(newbie.session.account.role).toBe("member");
    expect((await listMembers(t.sql, acct)).invites).toEqual([]);

    // A member can't invite or change roles.
    expect(await invite(t.sql, acct, newbie.session, "x", "member")).toMatchObject({ ok: false, status: 403 });
    expect(await setRole(t.sql, acct, newbie.session, owner.session.user.id, "member")).toMatchObject({ ok: false, status: 403 });
    // The only owner can't demote themselves.
    expect(await setRole(t.sql, acct, owner.session, owner.session.user.id, "member")).toMatchObject({ ok: false, status: 409 });
    expect(await setRole(t.sql, acct, owner.session, newbie.session.user.id, "admin")).toEqual({ ok: true });

    // An existing user is added directly.
    const other = await signedIn(profile(12, "other"));
    expect(await invite(t.sql, acct, owner.session, "other", "member")).toEqual({ ok: true });
    expect((await listAccounts(t.sql, other.session.user.id)).map((a) => a.id)).toContain(acct);
    expect(await switchAccount(t.sql, other.session, acct)).toBe(true);
    expect((await resolveSession(t.sql, other.token))!.account.id).toBe(acct);
    // Seats are now full (3 of 3).
    expect(await invite(t.sql, acct, owner.session, "fourth", "member")).toMatchObject({ ok: false, status: 402 });

    // Removing a member ends their sessions in that account.
    expect(await removeMember(t.sql, acct, owner.session, other.session.user.id)).toEqual({ ok: true });
    expect(await resolveSession(t.sql, other.token)).toBeNull();
    // Can't switch into an account you're not in.
    const o2 = await signedIn(profile(12, "other"));
    expect(await switchAccount(t.sql, o2.session, acct)).toBe(false);
    // The last owner can't be removed.
    expect(await removeMember(t.sql, acct, owner.session, owner.session.user.id)).toMatchObject({ ok: false, status: 409 });
  });
});
