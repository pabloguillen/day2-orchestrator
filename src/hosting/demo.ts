import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import type { DemoCast } from "../creative/demo-cast/schema";
import { appliedVersions, migrationSql, readMigrations, type MigrationFile } from "./migrations";
import { log as hostingLog, type HostingDeps } from "./provision";
import { introspectMigrations, RESERVED_SCHEMAS, type AppSchema } from "./schema-introspect";
import { expandSeedPlan, heuristicSeedPlan, validateSeedPlan, type SeedPlan } from "./seed-plan";
import { projectUrl, SupabaseError, type SupabaseApi } from "./supabase";
import { DEMO_STEPS, type DemoBackend, type DemoStep, type HostingState, type Region } from "./types";

/**
 * A separate demo backend per app, for marketing screens
 * (docs/creative-quality.md, "Real screens"): day2 creates a Supabase
 * project of its own in day2's organization (SUPABASE_ACCESS_TOKEN /
 * DAY2_SUPABASE_ORG_ID — the hosting operator config), applies the app's
 * migrations to it, and fills it with the approved demo cast through a
 * seed plan (seed-plan.ts) — rows as JSON through the demo project's REST
 * API with its own secret key, pictures into its storage buckets, auth
 * users through its Auth admin API. Never the app's live database:
 *
 *  - only a project recorded here as created by day2 as a demo (ref, name
 *    ending "-demo", day2's organization — checked against Supabase again
 *    before every write) is ever written to (`assertDemoTarget`);
 *  - a ref that appears anywhere in the app's repo or config (its live
 *    project) or is one of the app's hosted environments is refused;
 *  - the app's production keys are never read; the demo project's secret
 *    key and the demo login are stored encrypted and never returned.
 *
 * Built from Supabase's Management, Auth admin, PostgREST and Storage API
 * docs; tested against fakes; not yet run against a real organization.
 */

export class DemoError extends Error {
  constructor(
    message: string,
    public code: "unsupported" | "not_configured" | "limit" | "not_approved" | "guard" | "starting" | "failed" = "failed",
  ) {
    super(message);
  }
}

export type DemoClient = {
  /** Auth admin: a confirmed user. */
  createUser(o: { email: string; password: string; metadata: Record<string, string> }): Promise<{ id: string }>;
  findUser(email: string): Promise<{ id: string } | null>;
  deleteUser(id: string): Promise<void>;
  /** PostgREST insert (duplicates ignored), as JSON. */
  insert(table: string, rows: Array<Record<string, unknown>>): Promise<void>;
  remove(table: string, column: string, values: string[]): Promise<void>;
  upload(bucket: string, path: string, bytes: Uint8Array, mime: string): Promise<void>;
};

export type DemoDeps = HostingDeps & {
  /** The demo project's own client (fake in tests). */
  demoClient?: (url: string, secretKey: string) => DemoClient;
  /** Writes the seed plan from the schema (a model run), or null to use the built-in planner. */
  planner?: ((schema: AppSchema, problems: string[]) => Promise<unknown | null>) | null;
};

// ---------------------------------------------------------------- what can have one

export type DemoSupport = { ok: true; backend: "supabase"; migrations: number } | { ok: false; why: string };

export function demoSupport(repoPath: string): DemoSupport {
  const files = readMigrations(repoPath);
  const pkg = existsSync(join(repoPath, "package.json")) ? readFileSync(join(repoPath, "package.json"), "utf-8") : "";
  const supabase = /"@supabase\/supabase-js"/.test(pkg) || existsSync(join(repoPath, "src", "backend")) || existsSync(join(repoPath, "supabase", "config.toml"));
  if (supabase && files.length) return { ok: true, backend: "supabase", migrations: files.length };
  if (supabase) return { ok: false, why: "The app uses Supabase but has no migrations in supabase/migrations, so day2 can't rebuild its database for a demo copy. Upload screenshots of a demo account instead." };
  return { ok: false, why: "Demo backends work for Supabase apps with their migrations in the repo — not for this app's backend yet. Upload 3–8 screenshots of a demo account instead." };
}

// ---------------------------------------------------------------- the guard

const REF_IN_URL = /https?:\/\/([a-z0-9]{20})\.supabase\.(?:co|in)\b/g;

/** Every Supabase project ref the app's repo points at (its live backend): source, app config, eas.json, .env files. */
export function productionRefs(repoPath: string): string[] {
  const refs = new Set<string>();
  const scan = (p: string) => {
    try {
      if (statSync(p).size > 2_000_000) return;
      for (const m of readFileSync(p, "utf-8").matchAll(REF_IN_URL)) refs.add(m[1]!);
    } catch {
      /* unreadable */
    }
  };
  for (const f of ["app.json", "app.config.ts", "app.config.js", "eas.json", ".env", ".env.local", ".env.production", ".env.example", "supabase/config.toml"]) if (existsSync(join(repoPath, f))) scan(join(repoPath, f));
  const walk = (d: string, depth: number) => {
    if (depth > 6 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(tsx?|jsx?|json|toml)$/.test(e.name)) scan(p);
    }
  };
  for (const d of ["src", "app", "lib", "config"]) walk(join(repoPath, d), 0);
  return [...refs];
}

/**
 * Pure. Throws unless `ref` is the demo project day2 created for this app:
 * recorded as day2's demo, named "…-demo", not the app's live project, not
 * one of its hosted environments.
 */
export function assertDemoTarget(state: HostingState, ref: string, liveRefs: string[]): DemoBackend {
  const d = state.demo;
  if (!d || d.createdBy !== "day2-demo" || !d.ref) throw new DemoError("day2 only fills a demo project it created itself, and there's none for this app.", "guard");
  if (d.ref !== ref) throw new DemoError(`Refused: ${ref} isn't the demo project day2 created for this app.`, "guard");
  if (!d.name.endsWith("-demo")) throw new DemoError("Refused: the recorded demo project isn't named as one.", "guard");
  if (liveRefs.includes(ref)) throw new DemoError("Refused: that project is the one the app itself uses — day2 never puts demo data into a live backend.", "guard");
  if (Object.values(state.projects).some((p) => p?.ref === ref)) throw new DemoError("Refused: that project is one of the app's hosted environments.", "guard");
  if (d.url !== projectUrl(ref)) throw new DemoError("Refused: the demo project's address doesn't match its ref.", "guard");
  return d;
}

/** Before any write: Supabase says the project still is day2's demo (same name, day2's organization). */
async function confirmRemote(api: SupabaseApi, d: DemoBackend): Promise<void> {
  const p = await api.project(d.ref);
  if (p.name !== d.name || p.organization_slug !== d.orgSlug) throw new DemoError("Refused: the demo project's name or organization changed on Supabase — day2 won't write to it.", "guard");
}

// ---------------------------------------------------------------- the demo project's own APIs

/**
 * The demo project's Auth admin, REST and Storage APIs with its secret key.
 * Errors never contain the key. New `sb_secret_…` keys go in the apikey
 * header; a legacy service_role JWT also as the bearer.
 */
export function demoClient(url: string, key: string, f: typeof fetch = fetch): DemoClient {
  const base = url.replace(/\/$/, "");
  const headers = (extra: Record<string, string> = {}) => ({ apikey: key, ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}), ...extra });
  const redact = (s: string) => s.split(key).join("[key]");
  const call = async (method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) => {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers: headers(init.headers), body: init.body });
    } catch (err) {
      throw new DemoError(redact(`The demo project can't be reached (${(err as Error).message}).`));
    }
    const text = await res.text();
    if (!res.ok) throw new DemoError(redact(`Demo project ${method} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 240)}`));
    return text ? (JSON.parse(text) as unknown) : null;
  };
  const schemaHeader = (table: string) => {
    const [schema, name] = table.split(".") as [string, string];
    const h: Record<string, string> = schema === "public" ? {} : { "content-profile": schema, "accept-profile": schema };
    return { name, h };
  };
  return {
    async createUser(o) {
      const r = (await call("POST", "/auth/v1/admin/users", { body: JSON.stringify({ email: o.email, password: o.password, email_confirm: true, user_metadata: o.metadata }), headers: { "content-type": "application/json" } })) as { id?: string; user?: { id?: string } };
      const id = r?.id ?? r?.user?.id;
      if (!id) throw new DemoError("The demo project made a user but didn't say its id.");
      return { id };
    },
    async findUser(email) {
      for (let page = 1; page <= 5; page++) {
        const r = (await call("GET", `/auth/v1/admin/users?page=${page}&per_page=200`)) as { users?: Array<{ id: string; email?: string }> };
        const hit = r?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (hit) return { id: hit.id };
        if (!r?.users?.length || r.users.length < 200) break;
      }
      return null;
    },
    async deleteUser(id) {
      await call("DELETE", `/auth/v1/admin/users/${encodeURIComponent(id)}`);
    },
    async insert(table, rows) {
      if (!rows.length) return;
      const { name, h } = schemaHeader(table);
      await call("POST", `/rest/v1/${encodeURIComponent(name)}`, { body: JSON.stringify(rows), headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=minimal", ...h } });
    },
    async remove(table, column, values) {
      if (!values.length) return;
      const { name, h } = schemaHeader(table);
      const list = values.map((v) => `"${v.replace(/"/g, "")}"`).join(",");
      await call("DELETE", `/rest/v1/${encodeURIComponent(name)}?${encodeURIComponent(column)}=in.(${encodeURIComponent(list)})`, { headers: h });
    },
    async upload(bucket, path, bytes, mime) {
      await call("POST", `/storage/v1/object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`, { body: new Blob([bytes as Uint8Array<ArrayBuffer>]), headers: { "content-type": mime, "x-upsert": "true", ...(key.startsWith("eyJ") ? {} : { authorization: `Bearer ${key}` }) } });
    },
  };
}

// ---------------------------------------------------------------- setting it up

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "app";
/** Unique per app and recognisable as a demo. */
export const demoProjectName = (app: Pick<AppEntry, "id" | "name">) => `${slug(app.name)}-${app.id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}-demo`;

const ACTIVE = (s: string) => !["INACTIVE", "REMOVED", "PAUSING", "GOING_DOWN", "RESTORE_FAILED", "INIT_FAILED"].includes(s);
export const FREE_PROJECT_LIMIT = 2;

/** The owner-facing message when the organization can't take another project. */
export function limitMessage(orgSlug: string, plan: string | null): string {
  return `day2's Supabase organization has no room for another project${plan === "free" ? ` (the Free plan allows ${FREE_PROJECT_LIMIT} active projects)` : ""}. Pause or delete a project at supabase.com/dashboard/org/${orgSlug}, or upgrade the organization, then press "Set up demo backend" again. Your live app isn't affected.`;
}

/** Pure. Extensions the migrations use without creating them (PostGIS types in public). Prepended on the demo project only. */
export function demoPreamble(files: MigrationFile[]): string {
  const all = files.map((f) => f.sql).join("\n").toLowerCase();
  const out = ["SET check_function_bodies = off;"];
  if (/public\.(geography|geometry|st_)/.test(all) && !/create\s+extension[^;]*postgis/.test(all)) out.push("CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;");
  return out.join("\n");
}

const nowOf = (d: DemoDeps) => (d.now ? d.now() : new Date());
const appendLog = (d: DemoBackend, at: Date, text: string) => {
  d.log = [{ at: at.toISOString(), text }, ...d.log].slice(0, 40);
};

async function secretKeyOf(app: AppEntry, deps: DemoDeps): Promise<string> {
  const k = await deps.secrets.get<{ key: string }>(app.id, "secret_key:demo");
  if (!k?.key) throw new DemoError("The demo project's key is missing — press Set up demo backend again.");
  return k.key;
}

/** A guarded client for the demo project only. */
export async function guardedClient(app: AppEntry, deps: DemoDeps): Promise<{ client: DemoClient; demo: DemoBackend; api: SupabaseApi }> {
  if (!deps.operator) throw new DemoError("Demo backends need day2's Supabase organization (SUPABASE_ACCESS_TOKEN, DAY2_SUPABASE_ORG_ID).", "not_configured");
  const state = await deps.store.state(app.id);
  const demo = assertDemoTarget(state, state.demo?.ref ?? "", productionRefs(app.repoPath));
  const api = deps.api(deps.operator.token);
  await confirmRemote(api, demo);
  const key = await secretKeyOf(app, deps);
  return { client: (deps.demoClient ?? ((u, k) => demoClient(u, k, deps.fetch)))(demo.url, key), demo, api };
}

/**
 * Creates (once) and fills the app's demo project with the approved cast.
 * Each step is remembered; calling it again continues, and a new cast
 * replaces the old demo rows and users. Returns the demo record.
 */
export async function ensureDemoBackend(app: AppEntry, cast: DemoCast, deps: DemoDeps): Promise<DemoBackend> {
  const support = demoSupport(app.repoPath);
  if (!support.ok) throw new DemoError(support.why, "unsupported");
  if (cast.status !== "approved") throw new DemoError("Approve the demo cast first — day2 only puts an approved cast into the demo backend.", "not_approved");
  const op = deps.operator;
  if (!op) throw new DemoError("Demo backends need day2's Supabase organization (SUPABASE_ACCESS_TOKEN, DAY2_SUPABASE_ORG_ID on the server).", "not_configured");
  const api = deps.api(op.token);
  const files = readMigrations(app.repoPath);
  const schema = introspectMigrations(files);
  const live = productionRefs(app.repoPath);
  const update = (fn: (d: DemoBackend, s: HostingState) => void) =>
    deps.store.update(app.id, (s) => {
      if (s.demo) fn(s.demo, s);
    });
  const step = async (name: DemoStep, fn: () => Promise<void>) => {
    const s = await deps.store.state(app.id);
    if (s.demo?.done.includes(name)) return;
    await update((d) => {
      d.working = name;
    });
    try {
      await fn();
      await update((d) => {
        d.done = DEMO_STEPS.filter((x) => x === name || d.done.includes(x));
        d.working = null;
        d.problem = null;
      });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 400);
      await update((d) => {
        d.working = null;
        if (!(err instanceof DemoError && err.code === "starting")) d.problem = msg;
        appendLog(d, nowOf(deps), `Stopped at "${name}": ${msg}`);
      });
      throw err instanceof DemoError ? err : new DemoError(msg);
    }
  };

  // 1. The project (in day2's organization, never the app's own).
  let state = await deps.store.state(app.id);
  if (!state.demo) {
    const name = demoProjectName(app);
    const region: Region = state.plan?.region ?? op.defaultRegion;
    const org = await api.organization(op.orgSlug).catch(() => null);
    const existing = await api.orgProjects(op.orgSlug, "").catch(() => []);
    const adopt = (await deps.secrets.get(app.id, "db_password:demo")) ? existing.find((p) => p.name === name && !p.is_branch && p.status !== "REMOVED") : undefined;
    let ref: string;
    let status = "COMING_UP";
    if (adopt) {
      ref = adopt.ref;
      status = adopt.status;
    } else {
      if (org?.plan === "free" && existing.filter((p) => !p.is_branch && ACTIVE(p.status)).length >= FREE_PROJECT_LIMIT) throw new DemoError(limitMessage(op.orgSlug, "free"), "limit");
      const password = randomBytes(24).toString("base64url");
      await deps.secrets.set(app.id, "db_password:demo", { password }, "Database password (demo)");
      try {
        const p = await api.createProject({ name, organization_slug: op.orgSlug, db_pass: password, region, desired_instance_size: op.instanceSize });
        ref = p.ref;
        status = p.status;
      } catch (err) {
        const msg = (err as Error).message;
        if (err instanceof SupabaseError && (err.status === 402 || /limit|maximum|exceed|too many|quota|free projects/i.test(msg))) throw new DemoError(limitMessage(op.orgSlug, org?.plan ?? null), "limit");
        throw new DemoError(`Supabase didn't create the demo project: ${msg.slice(0, 200)}`);
      }
    }
    if (live.includes(ref)) throw new DemoError("Refused: Supabase returned the app's live project.", "guard");
    const at = nowOf(deps);
    state = await deps.store.update(app.id, (s) => {
      s.demo = { createdBy: "day2-demo", ref, name, orgSlug: op.orgSlug, region, url: projectUrl(ref), publishableKey: null, createdAt: at.toISOString(), status: status as DemoBackend["status"], done: ["project"], working: null, migrations: { applied: 0, total: files.length, failed: null }, plan: null, seededAt: null, castSeed: null, rows: 0, uploads: 0, seeded: { users: [], rows: [] }, pausedAt: null, problem: null, log: [] };
      appendLog(s.demo, at, `Created the demo backend ${name} (separate from your live app).`);
      hostingLog(s, at, "Created a separate demo backend for marketing screens.");
    });
  }
  const demo = assertDemoTarget(state, state.demo!.ref, live);
  const ref = demo.ref;

  // A new cast replaces the old demo content (and its keys stay).
  if (demo.castSeed !== null && demo.castSeed !== cast.seed)
    await update((d) => {
      d.done = d.done.filter((x) => !["plan", "users", "rows", "uploads"].includes(x));
    });

  await step("healthy", async () => {
    const deadline = Date.now() + (deps.waitMs ?? 15 * 60_000);
    for (;;) {
      const p = await api.project(ref);
      if (p.status === "ACTIVE_HEALTHY") {
        const services = await api.health(ref).catch(() => []);
        if (services.length && services.every((x) => x.status === "ACTIVE_HEALTHY")) {
          await update((d) => {
            d.status = "ACTIVE_HEALTHY";
          });
          return;
        }
      }
      if (p.status === "INIT_FAILED") throw new DemoError("Supabase couldn't start the demo project (INIT_FAILED).");
      if (Date.now() >= deadline) throw new DemoError("The demo backend is still starting — press Set up demo backend again in a few minutes.", "starting");
      await (deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(10_000);
    }
  });

  await step("keys", async () => {
    await confirmRemote(api, demo);
    const keys = await api.apiKeys(ref);
    const pub = keys.find((k) => k.type === "publishable") ?? keys.find((k) => k.name === "anon");
    const sec = keys.find((k) => k.type === "secret") ?? keys.find((k) => k.name === "service_role") ?? (await api.createApiKey(ref, "secret", "day2-demo"));
    if (!sec.api_key) throw new DemoError("The demo project has no secret key yet.");
    await deps.secrets.set(app.id, "secret_key:demo", { key: sec.api_key }, "Secret key (demo)");
    await update((d) => {
      d.publishableKey = pub?.api_key ?? null;
    });
  });

  // Nobody can sign up to the demo project with its public key (it's in the demo build).
  await step("auth_config", async () => {
    await confirmRemote(api, demo);
    await api.updateAuthConfig(ref, { disable_signup: true, mailer_autoconfirm: true });
  });

  // The app's own schemas served by the REST API (as in its live project).
  await step("schemas", async () => {
    const own = schema.schemas.filter((x) => x !== "public" && !RESERVED_SCHEMAS.includes(x));
    if (!own.length) return;
    await confirmRemote(api, demo);
    const cur = await api.postgrestConfig(ref).catch(() => ({ db_schema: "public, graphql_public" }));
    const list = [...new Set([...cur.db_schema.split(",").map((x) => x.trim()).filter(Boolean), ...own])];
    await api.updatePostgrest(ref, { db_schema: list.join(", ") });
  });

  await step("migrations", async () => {
    await confirmRemote(api, demo);
    const applied = await appliedVersions(api, ref);
    const pending = files.filter((m) => !applied.has(m.version));
    const pre = demoPreamble(files);
    let n = files.length - pending.length;
    for (const m of pending) {
      try {
        await api.query(ref, `${pre}\n${migrationSql(m)}`);
        n++;
      } catch (err) {
        const e = (err as Error).message.slice(0, 300);
        await update((d) => {
          d.migrations = { applied: n, total: files.length, failed: { file: m.file, error: e } };
        });
        throw new DemoError(`The app's migration ${m.file} didn't apply on the demo project: ${e}`);
      }
    }
    await update((d) => {
      d.migrations = { applied: n, total: files.length, failed: null };
      appendLog(d, nowOf(deps), `Applied ${n} of the app's database migrations.`);
    });
  });

  const stored = validateSeedPlan((await deps.store.state(app.id)).demo?.spec ?? null, schema).plan;
  let plan: SeedPlan | null = (await deps.store.state(app.id)).demo?.done.includes("plan") ? stored : null;
  const planFor = async (): Promise<SeedPlan> => {
    let problems: string[] = [];
    if (deps.planner) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await deps.planner(schema, problems).catch(() => null);
        if (!raw) break;
        const v = validateSeedPlan({ ...(raw as object), source: "model" }, schema);
        if (v.plan) return v.plan;
        problems = v.problems;
      }
    }
    const h = heuristicSeedPlan(schema);
    if (!h.plan) throw new DemoError(`day2 couldn't map the cast onto the app's tables: ${[...problems, ...h.problems].slice(0, 3).join("; ")}`);
    return h.plan;
  };
  await step("plan", async () => {
    plan = await planFor();
    const p = plan;
    await update((d) => {
      d.plan = { source: p.source, tables: p.steps.map((s) => s.table), notes: p.notes };
      d.spec = p;
    });
  });
  plan ??= await planFor();

  // Users: one per person; "self" is the demo account (password kept encrypted, never shown).
  const ids: Record<string, string> = {};
  const emailOf = (key: string) => `demo-${cast.seed.toString(36)}-${key}@example.com`;
  await step("users", async () => {
    const { client } = await guardedClient(app, deps);
    const cur = (await deps.store.state(app.id)).demo!;
    // Replace an older cast: its rows (newest tables first), then its users.
    if (cur.seeded.users.length || cur.seeded.rows.length) {
      for (const r of [...cur.seeded.rows].reverse()) await client.remove(r.table, r.column, r.values).catch(() => undefined);
      for (const u of cur.seeded.users) await client.deleteUser(u).catch(() => undefined);
      await update((d) => {
        d.seeded = { users: [], rows: [] };
      });
    }
    for (const p of cast.people) {
      const email = emailOf(p.key);
      const password = randomBytes(18).toString("base64url");
      const found = await client.findUser(email);
      const id = found?.id ?? (await client.createUser({ email, password, metadata: { display_name: p.displayName, day2_demo: "1" } })).id;
      if (p.key === cast.self) {
        // The demo login needs a password day2 knows: a found user gets a fresh one.
        if (found) {
          await client.deleteUser(found.id);
          ids[p.key] = (await client.createUser({ email, password, metadata: { display_name: p.displayName, day2_demo: "1" } })).id;
        } else ids[p.key] = id;
        await deps.secrets.set(app.id, "demo_login", { email, password }, "Demo account (screens)");
      } else ids[p.key] = id;
    }
    await update((d) => {
      d.seeded.users = Object.values(ids);
    });
  });
  if (!Object.keys(ids).length) {
    const { client } = await guardedClient(app, deps);
    for (const p of cast.people) {
      const u = await client.findUser(emailOf(p.key));
      if (!u) throw new DemoError("The demo users are missing — press Set up demo backend again.");
      ids[p.key] = u.id;
    }
  }

  const rows = expandSeedPlan(plan, cast, ids, schema, nowOf(deps));
  await step("rows", async () => {
    const { client } = await guardedClient(app, deps);
    let n = 0;
    const seeded: DemoBackend["seeded"]["rows"] = [];
    for (const ins of rows.inserts) {
      await client.insert(ins.table, ins.rows);
      n += ins.rows.length;
      const t = schema.tables[ins.table]!;
      if (t.primaryKey.length === 1 && t.primaryKey[0] !== undefined) {
        const col = t.primaryKey[0];
        const values = ins.rows.map((r) => r[col]).filter((v): v is string => typeof v === "string");
        if (values.length) seeded.push({ table: ins.table, column: col, values });
      }
    }
    await update((d) => {
      d.rows = n;
      d.seeded.rows = seeded;
      appendLog(d, nowOf(deps), `Added ${n} demo rows to ${rows.inserts.length} tables${rows.skipped.length ? ` (${rows.skipped.length} skipped)` : ""}.`);
    });
  });

  await step("uploads", async () => {
    const { client } = await guardedClient(app, deps);
    let n = 0;
    for (const u of rows.uploads) {
      if (!u.file || !existsSync(u.file)) continue;
      const bytes = new Uint8Array(readFileSync(u.file));
      await client.upload(u.bucket, u.path, bytes, /\.png$/i.test(u.file) ? "image/png" : "image/jpeg");
      n++;
    }
    const at = nowOf(deps);
    await update((d) => {
      d.uploads = n;
      d.seededAt = at.toISOString();
      d.castSeed = cast.seed;
      appendLog(d, at, `Uploaded ${n} demo pictures. The demo backend is ready.`);
    });
  });
  return (await deps.store.state(app.id)).demo!;
}

/** Pauses the demo project (between captures; a paused project doesn't count against the Free plan's 2). */
export async function pauseDemo(app: AppEntry, deps: DemoDeps): Promise<void> {
  const { demo, api } = await guardedClient(app, deps);
  if (demo.pausedAt) return;
  await api.pause(demo.ref);
  const at = nowOf(deps);
  await deps.store.update(app.id, (s) => {
    if (!s.demo) return;
    s.demo.pausedAt = at.toISOString();
    s.demo.status = "INACTIVE";
    s.demo.done = s.demo.done.filter((x) => x !== "healthy");
    appendLog(s.demo, at, "Paused the demo backend until the next capture.");
  });
}

/** Wakes a paused demo project (the next ensureDemoBackend waits for it). */
export async function resumeDemo(app: AppEntry, deps: DemoDeps): Promise<void> {
  const state = await deps.store.state(app.id);
  if (!state.demo?.pausedAt || !deps.operator) return;
  assertDemoTarget(state, state.demo.ref, productionRefs(app.repoPath));
  await deps.api(deps.operator.token).restore(state.demo.ref);
  await deps.store.update(app.id, (s) => {
    if (!s.demo) return;
    s.demo.pausedAt = null;
    s.demo.status = "RESTORING";
  });
}

/** What the console shows (nothing secret: no keys, no login). */
export function demoView(d: DemoBackend | null | undefined) {
  if (!d) return null;
  const ready = Boolean(d.seededAt) && d.done.includes("uploads");
  return {
    state: d.working ? "working" : d.problem ? "failed" : d.pausedAt ? "paused" : ready ? "ready" : "incomplete",
    name: d.name,
    region: d.region,
    createdAt: d.createdAt,
    step: d.working,
    done: d.done,
    migrations: d.migrations,
    plan: d.plan,
    seededAt: d.seededAt,
    rows: d.rows,
    uploads: d.uploads,
    pausedAt: d.pausedAt,
    problem: d.problem,
    log: d.log.slice(0, 10),
  };
}
