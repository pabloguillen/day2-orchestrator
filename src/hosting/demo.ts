import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { readMigrations } from "./migrations";
import { log as hostingLog, type HostingDeps } from "./provision";
import { projectUrl, SupabaseError, type SupabaseApi } from "./supabase";
import type { DemoBackend, HostingState } from "./types";

/**
 * Demo data for marketing screens (docs/creative-quality.md §2b) lives
 * only in a temporary database per capture run (hosting/ephemeral.ts,
 * creative/demo-session.ts) — day2 keeps no demo database. What's here:
 *
 *  - which apps can have one (`demoSupport`: Supabase apps with their
 *    migrations in the repo);
 *  - the client a temporary database is seeded through (`demoClient`:
 *    Auth admin, PostgREST, Storage with the stack's local service key);
 *  - the one-time removal of a demo project from the old design (a
 *    standing Supabase project per app in day2's organization):
 *    `retireLegacyDemo` deletes it through the guard (`assertDemoTarget`
 *    + Supabase confirming name and organization, `deleteDemoBackend`) and
 *    drops the record. Nothing creates such projects any more.
 */

export class DemoError extends Error {
  constructor(
    message: string,
    public code: "unsupported" | "not_configured" | "not_approved" | "guard" | "failed" = "failed",
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

/** Hosting deps: day2's Supabase organization, only to delete an old demo project. */
export type DemoDeps = HostingDeps;

// ---------------------------------------------------------------- what can have one

export type DemoSupport = { ok: true; backend: "supabase"; migrations: number } | { ok: false; why: string };

export function demoSupport(repoPath: string): DemoSupport {
  const files = readMigrations(repoPath);
  const pkg = existsSync(join(repoPath, "package.json")) ? readFileSync(join(repoPath, "package.json"), "utf-8") : "";
  const supabase = /"@supabase\/supabase-js"/.test(pkg) || existsSync(join(repoPath, "src", "backend")) || existsSync(join(repoPath, "supabase", "config.toml"));
  if (supabase && files.length) return { ok: true, backend: "supabase", migrations: files.length };
  if (supabase) return { ok: false, why: "The app uses Supabase but has no migrations in supabase/migrations, so day2 can't rebuild its database in a temporary copy for captures. Upload screenshots of a demo account instead." };
  return { ok: false, why: "Real screens with a demo cast work for Supabase apps with their migrations in the repo — not for this app's backend yet. Upload 3–8 screenshots of a demo account instead." };
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
 * A demo database's Auth admin, REST and Storage APIs with its service key
 * (for a temporary database: the local stack's). Errors never contain the
 * key. `sb_secret_…` keys go in the apikey header; a service_role JWT also
 * as the bearer.
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
      throw new DemoError(redact(`The demo database can't be reached (${(err as Error).message}).`));
    }
    const text = await res.text();
    if (!res.ok) throw new DemoError(redact(`Demo database ${method} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 240)}`));
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
      if (!id) throw new DemoError("The demo database made a user but didn't say its id.");
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

// ---------------------------------------------------------------- the old design: removing its demo project

/**
 * Deletes the app's old demo project in day2's organization (the one-time
 * migration, or the app was removed) — only the project recorded
 * as day2's demo, after Supabase confirms its name and organization — and
 * the demo secrets. A project that's already gone counts as deleted.
 */
export async function deleteDemoBackend(app: AppEntry, deps: DemoDeps): Promise<{ deleted: string | null }> {
  const state = await deps.store.state(app.id);
  const d = state.demo;
  if (!d) return { deleted: null };
  if (!deps.operator) throw new DemoError("Deleting the old demo project needs day2's Supabase organization (SUPABASE_ACCESS_TOKEN, DAY2_SUPABASE_ORG_ID).", "not_configured");
  const demo = assertDemoTarget(state, d.ref, productionRefs(app.repoPath));
  const api = deps.api(deps.operator.token);
  let gone = false;
  try {
    await confirmRemote(api, demo);
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 404) gone = true;
    else throw err;
  }
  if (!gone) {
    try {
      await api.deleteProject(demo.ref);
    } catch (err) {
      if (!(err instanceof SupabaseError && err.status === 404)) throw err;
    }
  }
  for (const k of ["secret_key:demo", "demo_login", "db_password:demo"] as const) await deps.secrets.remove(app.id, k).catch(() => undefined);
  const at = deps.now ? deps.now() : new Date();
  await deps.store.update(app.id, (s) => {
    s.demo = null;
    hostingLog(s, at, `Deleted the old demo project ${demo.name}.`);
  });
  return { deleted: demo.ref };
}

export type LegacyResult = { state: "none" | "deleted" | "kept" | "forgotten"; note: string | null };

/**
 * One-time migration from standing demo projects: an app whose state still
 * records a day2 demo project has it deleted through the guard, then the
 * record (and the old demo secrets) dropped. Without day2's Supabase
 * organization configured, or when Supabase can't be reached, it's kept
 * and tried again on the next tick. A record the guard refuses (the
 * project was renamed or moved) is dropped without touching the project —
 * the note says so.
 */
export async function retireLegacyDemo(app: AppEntry, deps: DemoDeps): Promise<LegacyResult> {
  const state = await deps.store.state(app.id).catch(() => null);
  const d = state?.demo;
  if (!d) return { state: "none", note: null };
  if (!deps.operator) return { state: "kept", note: `An old demo project (${d.name}) from before temporary databases is still in day2's Supabase organization: set SUPABASE_ACCESS_TOKEN and DAY2_SUPABASE_ORG_ID once so day2 can delete it, or delete it at supabase.com.` };
  try {
    await deleteDemoBackend(app, deps);
    return { state: "deleted", note: `Deleted the old demo project ${d.name} — demo data now lives only in a temporary database during each capture.` };
  } catch (err) {
    if (err instanceof DemoError && err.code === "guard") {
      for (const k of ["secret_key:demo", "demo_login", "db_password:demo"] as const) await deps.secrets.remove(app.id, k).catch(() => undefined);
      await deps.store.update(app.id, (s) => {
        s.demo = null;
        hostingLog(s, deps.now ? deps.now() : new Date(), `Forgot the old demo project ${d.name} without deleting it (${err.message}).`);
      });
      return { state: "forgotten", note: `day2 stopped tracking the old demo project ${d.name} without deleting it: ${err.message} Check it at supabase.com.` };
    }
    return { state: "kept", note: `The old demo project ${d.name} couldn't be deleted yet (${(err as Error).message.slice(0, 160)}) — day2 tries again.` };
  }
}
