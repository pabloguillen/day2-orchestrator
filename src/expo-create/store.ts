import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExpoBuild } from "./types";

/**
 * Where Create keeps its builds: a file in day2's data folder (local mode)
 * or the expo_creates table (accounts mode, migration 014). Builds survive
 * a restart; the flow picks unfinished ones up again (flow.ts resumeAll).
 */
export interface CreateStore {
  get(id: string, accountId?: string): Promise<ExpoBuild | undefined>;
  /** Newest first; only the account's when given. */
  list(accountId?: string): Promise<ExpoBuild[]>;
  save(b: ExpoBuild): Promise<ExpoBuild>;
}

export const EXPO_CREATE_FILE = ".day2-expo-creates.json";

export function fileCreateStore(dir: string): CreateStore {
  const path = join(dir, EXPO_CREATE_FILE);
  const load = (): ExpoBuild[] => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as ExpoBuild[]) : []);
  return {
    async get(id, accountId) {
      return load().find((b) => b.id === id && (accountId === undefined || b.accountId === accountId));
    },
    async list(accountId) {
      return load().filter((b) => accountId === undefined || b.accountId === accountId);
    },
    async save(b) {
      const next = { ...b, updatedAt: new Date().toISOString() };
      const all = [next, ...load().filter((x) => x.id !== b.id)].slice(0, 50);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
      renameSync(tmp, path);
      return next;
    },
  };
}

export function dbCreateStore(sql: SQL): CreateStore {
  const row = (r: { data: unknown }) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as ExpoBuild;
  return {
    async get(id, accountId) {
      const rows = (accountId === undefined
        ? await sql`SELECT data FROM expo_creates WHERE id = ${id}`
        : await sql`SELECT data FROM expo_creates WHERE id = ${id} AND account_id = ${accountId}`) as Array<{ data: unknown }>;
      return rows[0] ? row(rows[0]) : undefined;
    },
    async list(accountId) {
      const rows = (accountId === undefined
        ? await sql`SELECT data FROM expo_creates ORDER BY created_at DESC LIMIT 200`
        : await sql`SELECT data FROM expo_creates WHERE account_id = ${accountId} ORDER BY created_at DESC LIMIT 50`) as Array<{ data: unknown }>;
      return rows.map(row);
    },
    async save(b) {
      const next = { ...b, updatedAt: new Date().toISOString() };
      await sql`INSERT INTO expo_creates (id, account_id, status, data, created_at, updated_at)
        VALUES (${next.id}, ${next.accountId}, ${next.status}, ${JSON.stringify(next)}::jsonb, ${next.at}, now())
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = now()`;
      return next;
    },
  };
}
