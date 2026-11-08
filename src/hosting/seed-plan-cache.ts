import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../day2-paths";
import { readMigrations, type MigrationFile } from "./migrations";
import { introspectMigrations, RESERVED_SCHEMAS, type AppSchema } from "./schema-introspect";
import { heuristicSeedPlan, validateSeedPlan, type SeedPlan } from "./seed-plan";

/**
 * The validated seed plan per app — what day2 keeps instead of a demo
 * database (docs/creative-quality.md §2b). Keyed by a hash of the app's
 * migrations (names and contents): when they change, the plan is checked
 * again against the new schema (and written again only if it no longer
 * fits). Stored as data in `<data>/real-screens/<app>/seed-plan.json`.
 */

export type CachedSeedPlan = { version: 1; migrations: string; files: number; newest: string | null; plan: SeedPlan; validatedAt: string };

export class SeedPlanError extends Error {
  constructor(
    message: string,
    public problems: string[],
  ) {
    super(message);
  }
}

/** Pure. sha256 of the migrations' names and contents (in order). */
export function migrationsHash(files: MigrationFile[]): string | null {
  if (!files.length) return null;
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.file}\n${f.sql}\n\0`);
  return `${files.length}:${h.digest("hex").slice(0, 32)}`;
}

const safe = (appId: string) => appId.replace(/[^\w-]/g, "_");
const file = (appId: string) => join(dataDir(), "real-screens", safe(appId), "seed-plan.json");

export function loadSeedPlan(appId: string): CachedSeedPlan | null {
  try {
    const c = JSON.parse(readFileSync(file(appId), "utf-8")) as CachedSeedPlan;
    return c?.version === 1 && c.plan ? c : null;
  } catch {
    return null;
  }
}

function saveSeedPlan(appId: string, c: CachedSeedPlan): void {
  const f = file(appId);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(c, null, 2));
  renameSync(`${f}.tmp`, f);
}

export const dropSeedPlan = (appId: string) => rmSync(file(appId), { force: true });

/** The app's own schemas (for the stack's REST API). */
export const appSchemas = (schema: AppSchema) => schema.schemas.filter((s) => !RESERVED_SCHEMAS.includes(s));

export type SeedPlanState =
  | { state: "ready"; plan: SeedPlan; schema: AppSchema; files: MigrationFile[]; hash: string; cached: CachedSeedPlan }
  | { state: "missing" | "stale" | "invalid" | "no_migrations"; schema: AppSchema | null; files: MigrationFile[]; hash: string | null; cached: CachedSeedPlan | null; problems: string[] };

/** Pure apart from reading files: is the cached plan there and valid for the app's migrations as they are now. */
export function seedPlanState(appId: string, repoPath: string): SeedPlanState {
  const files = readMigrations(repoPath);
  const hash = migrationsHash(files);
  const cached = loadSeedPlan(appId);
  if (!hash) return { state: "no_migrations", schema: null, files, hash, cached, problems: [] };
  const schema = introspectMigrations(files);
  if (!cached) return { state: "missing", schema, files, hash, cached, problems: [] };
  if (cached.migrations !== hash) {
    // Still fits the changed schema? Then it's just re-stamped by ensureSeedPlan.
    const v = validateSeedPlan(cached.plan, schema);
    return { state: v.plan ? "stale" : "invalid", schema, files, hash, cached, problems: v.problems };
  }
  const v = validateSeedPlan(cached.plan, schema);
  if (!v.plan) return { state: "invalid", schema, files, hash, cached, problems: v.problems };
  return { state: "ready", plan: v.plan, schema, files, hash, cached };
}

export type Planner = (schema: AppSchema, problems: string[]) => Promise<unknown | null>;

/**
 * Makes sure there's a valid plan for the current migrations: the cached
 * one (re-checked when the migrations changed), else a model's (two tries,
 * each checked), else the built-in planner's. Throws SeedPlanError naming
 * what doesn't fit (tables, columns) when nothing does.
 */
export async function ensureSeedPlan(appId: string, repoPath: string, o: { planner: Planner | null; now?: Date }): Promise<{ plan: SeedPlan; note: string; reused: boolean }> {
  const s = seedPlanState(appId, repoPath);
  const now = (o.now ?? new Date()).toISOString();
  if (s.state === "ready") return { plan: s.plan, note: describe(s.plan, s.files), reused: true };
  if (s.state === "no_migrations" || !s.schema || !s.hash) throw new SeedPlanError("The app has no migrations in supabase/migrations, so day2 can't rebuild its database for a capture.", []);
  const stamp = (plan: SeedPlan) => saveSeedPlan(appId, { version: 1, migrations: s.hash!, files: s.files.length, newest: s.files.at(-1)?.file ?? null, plan, validatedAt: now });
  if (s.state === "stale" && s.cached) {
    stamp(s.cached.plan);
    return { plan: s.cached.plan, note: `${describe(s.cached.plan, s.files)} Checked again after the migrations changed.`, reused: true };
  }
  const schema = s.schema;
  let problems: string[] = s.state === "invalid" ? s.problems : [];
  if (o.planner) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await o.planner(schema, problems).catch(() => null);
      if (!raw) break;
      const v = validateSeedPlan({ ...(raw as object), source: "model" }, schema);
      if (v.plan) {
        stamp(v.plan);
        return { plan: v.plan, note: describe(v.plan, s.files), reused: false };
      }
      problems = v.problems;
    }
  }
  const h = heuristicSeedPlan(schema);
  if (h.plan) {
    stamp(h.plan);
    return { plan: h.plan, note: describe(h.plan, s.files), reused: false };
  }
  const all = [...problems, ...h.problems];
  throw new SeedPlanError(`day2 couldn't map the demo cast onto the app's tables (migrations up to ${s.files.at(-1)?.file ?? "?"}): ${all.slice(0, 3).join("; ")}`, all);
}

const describe = (p: SeedPlan, files: MigrationFile[]) => `Seed plan (${p.source === "model" ? "written by a model" : "built-in"}) for ${p.steps.length} tables (${p.steps.map((x) => x.table).join(", ")}), checked against ${files.length} migrations.`;

/** What the console shows. */
export function seedPlanView(appId: string, repoPath: string) {
  const s = seedPlanState(appId, repoPath);
  const p = s.state === "ready" ? s.plan : s.cached?.plan ?? null;
  return {
    state: s.state,
    source: p?.source ?? null,
    tables: p?.steps.map((x) => x.table) ?? [],
    uploads: p?.uploads.map((u) => u.bucket) ?? [],
    notes: p?.notes ?? [],
    migrations: s.files.length,
    validatedAt: s.cached?.validatedAt ?? null,
    problems: s.state === "ready" ? [] : s.problems.slice(0, 5),
  };
}
