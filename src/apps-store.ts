import type { SQL } from "bun";
import {
  addApp,
  findApp,
  loadAppsRegistry,
  removeApp,
  saveAppsRegistry,
  setAppBaseUrl,
  type AppEntry,
  type AppsRegistry,
  type ConnectionMethod,
} from "./apps-registry";

/**
 * One customer account's apps. Production stores them in Postgres (rows
 * scoped by account — one account can never see or touch another's); local
 * tools and older tests can still use the JSON registry file.
 *
 * Validation stays in apps-registry.ts's pure functions, so both backends
 * accept and refuse exactly the same things.
 */

export type NewApp = {
  name: string;
  repoPath: string;
  connectionMethod: ConnectionMethod;
  githubRepo?: string;
  appBaseUrl?: string;
  id?: string;
};

export type AppsResult = { ok: true; app: AppEntry } | { ok: false; reason: string };

export interface AppsStore {
  list(): Promise<AppEntry[]>;
  find(id: string): Promise<AppEntry | undefined>;
  add(input: NewApp): Promise<AppsResult>;
  remove(id: string): Promise<void>;
  setBaseUrl(id: string, url: string | undefined): Promise<AppsResult>;
}

type AppRow = {
  id: string;
  name: string;
  repo_path: string;
  connection_method: ConnectionMethod;
  github_repo: string | null;
  app_base_url: string | null;
  added_at: Date | string;
};

export function rowToApp(r: AppRow): AppEntry {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    connectionMethod: r.connection_method,
    ...(r.github_repo ? { githubRepo: r.github_repo } : {}),
    ...(r.app_base_url ? { appBaseUrl: r.app_base_url } : {}),
    addedAt: new Date(r.added_at).toISOString(),
  };
}

export function dbApps(sql: SQL, accountId: string): AppsStore {
  const list = async () =>
    ((await sql`SELECT * FROM apps WHERE account_id = ${accountId} ORDER BY added_at`) as AppRow[]).map(rowToApp);
  return {
    list,
    async find(id) {
      const rows = (await sql`SELECT * FROM apps WHERE account_id = ${accountId} AND id = ${id}`) as AppRow[];
      return rows[0] ? rowToApp(rows[0]) : undefined;
    },
    async add(input) {
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`apps:${accountId}`}))`;
        const current: AppsRegistry = {
          apps: ((await tx`SELECT * FROM apps WHERE account_id = ${accountId}`) as AppRow[]).map(rowToApp),
        };
        const r = addApp(current, input);
        if (!r.ok) return r;
        const a = r.app;
        await tx`INSERT INTO apps (id, account_id, name, repo_path, connection_method, github_repo, app_base_url, added_at)
          VALUES (${a.id}, ${accountId}, ${a.name}, ${a.repoPath}, ${a.connectionMethod}, ${a.githubRepo ?? null}, ${a.appBaseUrl ?? null}, ${a.addedAt})`;
        return { ok: true as const, app: a };
      }) as Promise<AppsResult>;
    },
    async remove(id) {
      await sql`DELETE FROM apps WHERE account_id = ${accountId} AND id = ${id}`;
    },
    async setBaseUrl(id, url) {
      const current: AppsRegistry = { apps: await list() };
      const r = setAppBaseUrl(current, id, url);
      if (!r.ok) return r;
      await sql`UPDATE apps SET app_base_url = ${r.app.appBaseUrl ?? null} WHERE account_id = ${accountId} AND id = ${id}`;
      return { ok: true, app: r.app };
    },
  };
}

export function fileApps(path: string): AppsStore {
  return {
    async list() {
      return loadAppsRegistry(path).apps;
    },
    async find(id) {
      return findApp(loadAppsRegistry(path), id);
    },
    async add(input) {
      const r = addApp(loadAppsRegistry(path), input);
      if (!r.ok) return r;
      saveAppsRegistry(path, r.registry);
      return { ok: true, app: r.app };
    },
    async remove(id) {
      saveAppsRegistry(path, removeApp(loadAppsRegistry(path), id));
    },
    async setBaseUrl(id, url) {
      const r = setAppBaseUrl(loadAppsRegistry(path), id, url);
      if (!r.ok) return r;
      saveAppsRegistry(path, r.registry);
      return { ok: true, app: r.app };
    },
  };
}

/** Every app with its owning account — for background jobs (backlog tick)
 * and for charging agent runs that only know a repo path. */
export async function allApps(sql: SQL): Promise<Array<{ accountId: string; app: AppEntry }>> {
  const rows = (await sql`SELECT * FROM apps ORDER BY added_at`) as Array<AppRow & { account_id: string }>;
  return rows.map((r) => ({ accountId: r.account_id, app: rowToApp(r) }));
}
