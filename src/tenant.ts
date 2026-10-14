import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join, resolve, sep } from "node:path";
import { $ } from "bun";
import type { AppEntry } from "./apps-registry";
import { allApps, dbApps, fileApps, type AppsStore } from "./apps-store";
import type { Role, Session } from "./auth";
import { INTEGRATIONS_FILENAME } from "./backlog-trackers";
import type { CreditStore } from "./credits";
import { appsRegistryPath, creditStore, dataDir } from "./day2-paths";
import { CONNECTORS_FILENAME, dbConnectors, fileConnectors, type ConnectorStore } from "./connectors";
import { db, hasDatabase } from "./db";
import { AD_IDENTITIES_FILENAME, dbAdIdentities, fileAdIdentities, type AdIdentityStore } from "./ad-identities";
import { githubEnv } from "./github-app";
import { dbIntegrations, fileIntegrations, type IntegrationsStore } from "./integrations-store";

/**
 * Whose data a piece of work touches.
 *
 * Two ways day2 runs:
 *  - "accounts" (production; DATABASE_URL set): people sign in, every
 *    request belongs to one customer account, and everything — apps,
 *    credits, JIRA/Linear connections — is read and written through stores
 *    scoped to that account.
 *  - "local" (development only; no DATABASE_URL): one operator on their own
 *    machine, no sign-in, the JSON files next to the orchestrator.
 *
 * Production refuses to start without a database (see `assertProductionReady`).
 */

export type Mode = "accounts" | "local";

export type Tenant = {
  mode: Mode;
  accountId: string;
  role: Role;
  session: Session | null;
  apps: AppsStore;
  credits: CreditStore;
  integrations: IntegrationsStore;
  /** day2's GitHub App installation on this account (production), or null
   * — then git/gh use the machine's own GitHub login (local mode). */
  githubInstallationId: number | null;
};

export function serverMode(): Mode {
  return hasDatabase() ? "accounts" : "local";
}

export function assertProductionReady(): void {
  if (process.env.NODE_ENV !== "production") return;
  const missing = ["DATABASE_URL", "DAY2_PUBLIC_URL", "DAY2_SECRETS_KEY"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Production needs ${missing.join(", ")} — see docs/deploy-hetzner.md.`);
  // At least one way to sign in.
  const github = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  const google = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const email = Boolean(process.env.SMTP_URL);
  if (!github && !google && !email) throw new Error("Production needs a way to sign in: GitHub, Google or email (SMTP_URL) — see docs/deploy-hetzner.md.");
}

export const LOCAL_ACCOUNT_ID = "local";

export function localTenant(): Tenant {
  return {
    mode: "local",
    accountId: LOCAL_ACCOUNT_ID,
    role: "owner",
    session: null,
    apps: fileApps(appsRegistryPath()),
    credits: creditStore(),
    integrations: fileIntegrations(resolve(dirname(appsRegistryPath()), INTEGRATIONS_FILENAME)),
    githubInstallationId: null,
  };
}

export function accountTenant(accountId: string, githubInstallationId: number | null, session: Session | null = null): Tenant {
  const sql = db();
  return {
    mode: "accounts",
    accountId,
    role: session?.account.role ?? "owner",
    session,
    apps: dbApps(sql, accountId),
    credits: { db: sql, accountId },
    integrations: dbIntegrations(sql, accountId),
    githubInstallationId,
  };
}

/** The tools day2 runs for every customer, on day2's own accounts
 * (connectors.ts) — one store for the whole platform. */
export function platformTools(): ConnectorStore {
  return serverMode() === "accounts" ? dbConnectors(db()) : fileConnectors(join(dataDir(), CONNECTORS_FILENAME));
}

export function adIdentities(): AdIdentityStore {
  return serverMode() === "accounts" ? dbAdIdentities(db()) : fileAdIdentities(join(dataDir(), AD_IDENTITIES_FILENAME));
}

export function sessionTenant(session: Session): Tenant {
  return accountTenant(session.account.id, session.account.githubInstallationId, session);
}

/** For background work that knows only the account. */
export async function loadAccountTenant(accountId: string): Promise<Tenant | null> {
  const rows = (await db()`SELECT github_installation_id FROM accounts WHERE id = ${accountId}`) as Array<{ github_installation_id: string | number | null }>;
  if (!rows[0]) return null;
  const inst = rows[0].github_installation_id;
  return accountTenant(accountId, inst === null ? null : Number(inst));
}

/** Env for a git/gh process acting for the current tenant (github-app.ts). */
export function gitEnv(): Promise<Record<string, string | undefined>> {
  return githubEnv(currentTenant()?.githubInstallationId ?? null);
}

/** The local operator's display name (git identity), for local mode. */
export async function localOperatorName(): Promise<string> {
  const fromGit = (await $`git config --global user.name`.quiet().nothrow().text()).trim();
  return fromGit || process.env.USER || "there";
}

// ---------------------------------------------------------------------------
// The tenant of the work in progress — so code deep inside an agent run
// (metered-query.ts) charges the right account, including background work
// a request started.
// ---------------------------------------------------------------------------

const current = new AsyncLocalStorage<Tenant>();

export function runAsTenant<T>(tenant: Tenant, fn: () => T): T {
  return current.run(tenant, fn);
}

export function currentTenant(): Tenant | undefined {
  return current.getStore();
}

const contains = (root: string, target: string) => target === root || target.startsWith(root + sep);

/** For work that only knows a repo path (CLI runs): the app and tenant whose
 * repo contains it. */
export async function tenantForPath(cwd: string): Promise<{ tenant: Tenant; app: AppEntry } | null> {
  const target = resolve(cwd);
  if (serverMode() === "local") {
    const t = localTenant();
    const app = (await t.apps.list()).find((a) => contains(resolve(a.repoPath), target));
    return app ? { tenant: t, app } : null;
  }
  const hit = (await allApps(db())).find((r) => contains(resolve(r.app.repoPath), target));
  if (!hit) return null;
  const tenant = await loadAccountTenant(hit.accountId);
  return tenant ? { tenant, app: hit.app } : null;
}
