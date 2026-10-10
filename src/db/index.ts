import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Postgres access (Bun's built-in client — no extra dependency).
 *
 * One pool per process, from DATABASE_URL. Schema changes live in
 * `migrations/NNN_name.sql` and are applied in order, once each, inside a
 * transaction guarded by an advisory lock so two servers starting together
 * can't race.
 */

export type Db = SQL;

let pool: SQL | null = null;

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}

export function db(): SQL {
  if (pool) return pool;
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set — day2 needs Postgres (see docs/deploy-hetzner.md).");
  pool = new SQL(url, { max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  return pool;
}

export function hasDatabase(): boolean {
  return Boolean(databaseUrl());
}

/** For tests that switch databases between files. */
export async function resetDbPool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.close();
}

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_LOCK = 7_207_207;

export async function migrate(sql: SQL = db()): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
      applied.push(f);
    }
  });
  return applied;
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `[day2-db] Applied: ${applied.join(", ")}` : "[day2-db] Up to date.");
  await resetDbPool();
}
