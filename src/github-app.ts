import { $ } from "bun";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * day2's GitHub App: how customer repos are reached in production.
 *
 * People sign in with the same App (user authorization, auth.ts). Installing
 * it on their account or org — the "Connect GitHub" step, one click — grants
 * day2 access to exactly the repos they pick. day2 then works with
 * short-lived installation tokens (1 hour), minted on demand from the App's
 * private key and never stored: cloning, pushing fix branches, opening and
 * merging PRs all run with the token of the account that owns the repo.
 *
 * Settings (see docs/deploy-hetzner.md for creating the App):
 *   GITHUB_APP_ID, GITHUB_APP_SLUG,
 *   GITHUB_APP_PRIVATE_KEY (PEM) or GITHUB_APP_PRIVATE_KEY_FILE,
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET (the App's OAuth credentials).
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function githubAppConfig() {
  const keyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  if (!privateKey && keyFile) privateKey = readFileSync(keyFile, "utf-8");
  return { appId: process.env.GITHUB_APP_ID ?? "", slug: process.env.GITHUB_APP_SLUG ?? "", privateKey };
}

export function hasGitHubApp(): boolean {
  const c = githubAppConfig();
  return Boolean(c.appId && c.slug && c.privateKey);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The App's own JWT (RS256, ≤10 minutes), used only to mint installation tokens. */
export function appJwt(now = Date.now()): string {
  const c = githubAppConfig();
  if (!c.appId || !c.privateKey) throw new Error("day2's GitHub App isn't configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).");
  const iat = Math.floor(now / 1000) - 60; // clock drift allowance, as GitHub recommends
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: c.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(c.privateKey).toString("base64url")}`;
}

export function installUrl(state: string): string {
  const u = new URL(`https://github.com/apps/${githubAppConfig().slug}/installations/new`);
  u.searchParams.set("state", state);
  return u.toString();
}

const API = "https://api.github.com";
const ghHeaders = (auth: string) => ({ authorization: auth, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "day2" });

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** A token for one installation, cached until 5 minutes before it expires. */
export async function installationToken(installationId: number, fetchImpl: FetchLike = fetch): Promise<string> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
  const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: ghHeaders(`Bearer ${appJwt()}`) });
  if (!res.ok) {
    if (res.status === 404) throw new GitHubAccessError("day2's GitHub App is no longer installed on this account — reconnect GitHub.");
    throw new Error(`GitHub refused an access token (${res.status}).`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, { token: body.token, expiresAt: new Date(body.expires_at).getTime() });
  return body.token;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

export class GitHubAccessError extends Error {}

export type InstallationRepo = { fullName: string; name: string; owner: string; url: string; private: boolean; defaultBranch: string; updatedAt: string };

/** The repos the account chose to give day2 when installing the App. */
export async function listInstallationRepos(installationId: number, fetchImpl: FetchLike = fetch): Promise<InstallationRepo[]> {
  const token = await installationToken(installationId, fetchImpl);
  const out: InstallationRepo[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: ghHeaders(`token ${token}`) });
    if (!res.ok) throw new Error(`Couldn't list repositories from GitHub (${res.status}).`);
    const body = (await res.json()) as {
      total_count: number;
      repositories: Array<{ full_name: string; name: string; owner: { login: string }; html_url: string; private: boolean; default_branch: string; updated_at: string }>;
    };
    for (const r of body.repositories) {
      out.push({ fullName: r.full_name, name: r.name, owner: r.owner.login, url: r.html_url, private: r.private, defaultBranch: r.default_branch, updatedAt: r.updated_at });
    }
    if (out.length >= body.total_count || body.repositories.length === 0) break;
  }
  return out;
}

/** Whether the signed-in person (by their short-lived user token) can see
 * this installation — so nobody can attach someone else's installation id. */
export async function userCanAccessInstallation(userToken: string, installationId: number, fetchImpl: FetchLike = fetch): Promise<boolean> {
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`${API}/user/installations?per_page=100&page=${page}`, { headers: ghHeaders(`Bearer ${userToken}`) });
    if (!res.ok) return false;
    const body = (await res.json()) as { installations: Array<{ id: number }> };
    if (body.installations.some((i) => i.id === installationId)) return true;
    if (body.installations.length < 100) return false;
  }
  return false;
}

/**
 * Environment for a `git` or `gh` process that talks to GitHub on behalf of
 * an installation: `gh` reads GH_TOKEN, and git gets it through gh's
 * credential helper (configured via env, so nothing is written into the
 * repo's config and the token never lands on disk).
 */
export async function githubEnv(installationId: number | null): Promise<Record<string, string | undefined>> {
  if (installationId === null) return { ...process.env };
  const token = await installationToken(installationId);
  return {
    ...process.env,
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
  };
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Clones a repo the installation can reach into `dir`. */
export async function cloneWithInstallation(installationId: number, fullName: string, dir: string): Promise<void> {
  if (!REPO_RE.test(fullName)) throw new Error("That isn't a GitHub repository name (owner/name).");
  const env = await githubEnv(installationId);
  const res = await $`git clone --quiet ${`https://github.com/${fullName}.git`} ${dir}`.env(env).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`Couldn't clone ${fullName}: ${res.stderr.toString().replace(/x-access-token:[^@]+@/g, "").slice(0, 300)}`);
}
