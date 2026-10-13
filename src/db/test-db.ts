import { SQL } from "bun";
import { migrate, resetDbPool } from "./index";

/**
 * A fresh, migrated Postgres database for one test file.
 *
 * Needs a server to create databases on: DAY2_TEST_DATABASE_URL (any
 * database on it, e.g. postgres://postgres@localhost:5432/postgres — CI
 * uses a Postgres service container). Points DATABASE_URL at the new
 * database for the code under test and drops it afterwards.
 */
export async function createTestDatabase(): Promise<{ url: string; sql: SQL; drop: () => Promise<void> }> {
  const admin = process.env.DAY2_TEST_DATABASE_URL;
  if (!admin) throw new Error("Set DAY2_TEST_DATABASE_URL to a Postgres server the tests may create databases on.");
  const name = `day2_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const adminSql = new SQL(admin, { max: 1 });
  await adminSql.unsafe(`CREATE DATABASE ${name}`);
  await adminSql.close();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  const url = u.toString();
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  await resetDbPool();
  const sql = new SQL(url, { max: 4 });
  await migrate(sql);
  return {
    url,
    sql,
    drop: async () => {
      await sql.close();
      await resetDbPool();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      const a = new SQL(admin, { max: 1 });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.close();
    },
  };
}
