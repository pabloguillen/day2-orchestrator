import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseApi } from "./supabase";

/**
 * The app's database changes: `supabase/migrations/<version>_<name>.sql` in
 * the app's repo (the Supabase CLI's layout and history table, so the CLI
 * and day2 agree on what's applied).
 *
 * Applied through the Management API's SQL endpoint (POST
 * /v1/projects/{ref}/database/query, beta): each file in one transaction
 * together with its row in supabase_migrations.schema_migrations — what
 * `supabase db push` does. Fallback: `supabase db push --db-url` (CLI).
 *
 * Rules (checked before anything runs on production):
 *  - every table in the public schema has row level security turned on in
 *    the migrations — a table without it is refused;
 *  - backwards-compatible only: a migration that drops or renames a table
 *    or column, changes a column's type or makes a column NOT NULL without a
 *    default is a "contract" step. It must say so (`-- day2:contract` on its
 *    own line) and ship only after every app version that used the old
 *    shape is gone (expand first, contract later).
 */

export const SUPABASE_CLI = "supabase@2.122.1";
export const CONTRACT_MARK = /^\s*--\s*day2:contract\b/m;

export type MigrationFile = { version: string; name: string; file: string; sql: string };

/** The app's migration files, oldest first. */
export function readMigrations(repoPath: string): MigrationFile[] {
  const dir = join(repoPath, "supabase", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const [, version, name] = /^(\d+)_([\w-]+)\.sql$/.exec(file)!;
      return { version: version!, name: name!, file, sql: readFileSync(join(dir, file), "utf-8") };
    });
}

export type MigrationProblem = { file: string; kind: "no_rls" | "contract"; text: string };

const strip = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const ident = (s: string) => s.replace(/"/g, "").toLowerCase();

/** Pure. Tables created in the public schema across all files, and the ones with RLS enabled. */
export function rlsGaps(files: MigrationFile[]): Array<{ table: string; file: string }> {
  const created = new Map<string, string>();
  const enabled = new Set<string>();
  const dropped = new Set<string>();
  for (const f of files) {
    const sql = strip(f.sql);
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/gi)) {
      const full = ident(m[1]!);
      const [schema, table] = full.includes(".") ? full.split(".") : ["public", full];
      if (schema === "public") created.set(table!, f.file);
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+enable\s+row\s+level\s+security/gi)) {
      const full = ident(m[1]!);
      enabled.add(full.includes(".") ? full.split(".")[1]! : full);
    }
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/gi)) {
      const full = ident(m[1]!);
      dropped.add(full.includes(".") ? full.split(".")[1]! : full);
    }
  }
  return [...created.entries()].filter(([t]) => !enabled.has(t) && !dropped.has(t)).map(([table, file]) => ({ table, file }));
}

/** Pure. What makes a migration a contract step (not backwards-compatible). */
export function contractSteps(sql: string): string[] {
  const s = strip(sql);
  const found: string[] = [];
  const add = (re: RegExp, what: string) => {
    if (re.test(s)) found.push(what);
  };
  add(/drop\s+table/i, "drops a table");
  add(/drop\s+column/i, "drops a column");
  add(/rename\s+(column\s+)?\w+\s+to|rename\s+to/i, "renames a table or column");
  add(/alter\s+column\s+"?\w+"?\s+(set\s+data\s+)?type\b/i, "changes a column's type");
  // NOT NULL on an existing column without a default breaks older app versions that don't send it.
  if (/alter\s+column\s+"?\w+"?\s+set\s+not\s+null/i.test(s) && !/set\s+default/i.test(s)) found.push("makes a column required without a default");
  add(/add\s+column\s+(if\s+not\s+exists\s+)?"?\w+"?\s+[\w\s(),]*not\s+null(?![\s\S]*?default)/i, "adds a required column without a default");
  return found;
}

/** Pure. Problems in the files that haven't been applied yet (RLS is checked over all files). */
export function checkMigrations(all: MigrationFile[], pending: MigrationFile[]): MigrationProblem[] {
  const problems: MigrationProblem[] = rlsGaps(all).map((g) => ({ file: g.file, kind: "no_rls", text: `Table "${g.table}" has no row level security — add \`alter table public.${g.table} enable row level security;\` and its policies in a migration.` }));
  for (const f of pending) {
    const steps = contractSteps(f.sql);
    if (steps.length && !CONTRACT_MARK.test(f.sql)) problems.push({ file: f.file, kind: "contract", text: `${f.file} ${steps.join(", ")} — that breaks app versions people still have. Split it: add the new shape first, and remove the old one later in a migration marked \`-- day2:contract\`.` });
  }
  return problems;
}

const HISTORY = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY, statements text[], name text);`;

/** A dollar-quote tag that doesn't occur in the text. */
function quote(text: string): string {
  let tag = `d2_${randomBytes(4).toString("hex")}`;
  while (text.includes(`$${tag}$`)) tag = `d2_${randomBytes(4).toString("hex")}`;
  return `$${tag}$${text}$${tag}$`;
}

/** Pure. One migration and its history row, in one transaction. */
export function migrationSql(m: MigrationFile): string {
  return `BEGIN;\n${m.sql.trim().replace(/;?\s*$/, ";")}\nINSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES (${quote(m.version)}, ${quote(m.name)}, ARRAY[${quote(m.sql)}]);\nCOMMIT;`;
}

export async function appliedVersions(api: SupabaseApi, ref: string): Promise<Set<string>> {
  await api.query(ref, HISTORY);
  const rows = await api.query<{ version: string }>(ref, "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version");
  return new Set(rows.map((r) => String(r.version)));
}

export type ApplyResult = { applied: Array<{ version: string; name: string }>; failed: { version: string; name: string; error: string } | null; via: "api" | "cli" };

/** Applies what's pending, oldest first; stops at the first failure (later ones depend on it). */
export async function applyPending(api: SupabaseApi, ref: string, pending: MigrationFile[]): Promise<ApplyResult> {
  const applied: ApplyResult["applied"] = [];
  for (const m of pending) {
    try {
      await api.query(ref, migrationSql(m));
      applied.push({ version: m.version, name: m.name });
    } catch (err) {
      return { applied, failed: { version: m.version, name: m.name, error: (err as Error).message.slice(0, 400) }, via: "api" };
    }
  }
  return { applied, failed: null, via: "api" };
}

export type Runner = (cmd: string[], o: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Session-mode pooler URL with the password filled in (for the CLI fallback). */
export function databaseUrl(poolerConnectionString: string, password: string): string {
  const u = new URL(poolerConnectionString.replace("[YOUR-PASSWORD]", "x"));
  u.password = encodeURIComponent(password);
  // Supavisor: 6543 is transaction mode; migrations need a session (5432).
  if (u.port === "6543") u.port = "5432";
  return u.toString();
}

/** Fallback: `supabase db push --db-url … --include-all` in the app's checkout. The URL (with the password) goes in the environment's argv only, and is redacted from errors. */
export async function pushWithCli(run: Runner, repoPath: string, dbUrl: string, env: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await run(["npx", "--yes", SUPABASE_CLI, "db", "push", "--db-url", dbUrl, "--include-all"], { cwd: repoPath, env });
  if (r.code === 0) return { ok: true };
  const pw = new URL(dbUrl).password;
  const tail = `${r.stderr}\n${r.stdout}`.trim().split("\n").slice(-8).join("\n");
  return { ok: false, error: (pw ? tail.split(pw).join("[password]").split(decodeURIComponent(pw)).join("[password]") : tail).slice(0, 600) };
}
