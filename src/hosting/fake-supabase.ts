import type { Lint, SupabaseApi } from "./supabase";
import { SupabaseError } from "./supabase";

/**
 * An in-memory stand-in for the Management API, for tests only: records
 * every call (with the token used) and keeps just enough state to behave
 * like Supabase (projects come up after a poll, migrations history, keys).
 */

export type FakeCall = { token: string; op: string; args: unknown[] };

export function fakeSupabase(o: { orgPlan?: string; branching?: boolean; lints?: { security?: Lint[]; performance?: Lint[] }; failSql?: RegExp; sqlOutage?: boolean; claimFails?: boolean; createFails?: { status: number; message: string } } = {}) {
  const calls: FakeCall[] = [];
  const projects = new Map<string, { ref: string; name: string; region: string; org: string; polls: number; status: string; paused: boolean }>();
  const migrations = new Map<string, Set<string>>();
  const sql: Array<{ ref: string; query: string }> = [];
  const auth = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, Map<string, string>>();
  const branches = new Map<string, { id: string; ref: string; parent: string; name: string; polls: number }>();
  const claims = new Map<string, string>();
  const postgrest = new Map<string, string>();
  let n = 0;

  const api = (token: string): SupabaseApi => {
    const rec = (op: string, ...args: unknown[]) => calls.push({ token, op, args });
    const proj = (ref: string) => {
      const p = projects.get(ref) ?? [...branches.values()].find((b) => b.ref === ref);
      if (!p) throw new SupabaseError(404, `Supabase GET /v1/projects/${ref}: 404 not found`);
      return p;
    };
    const impl: Partial<SupabaseApi> = {
      organization: async (slug) => (rec("organization", slug), { id: "org1", name: `Org ${slug}`, plan: (o.orgPlan ?? "pro") as never }),
      entitlements: async (slug) => (rec("entitlements", slug), { entitlements: [{ feature: { key: "branching_limit", type: "numeric" }, hasAccess: o.branching ?? true }] }),
      orgProjects: async (slug, search) => (rec("orgProjects", slug, search), [...projects.values()].filter((p) => p.org === slug && p.name.includes(search)).map((p) => ({ ref: p.ref, name: p.name, region: p.region, status: p.status as never, is_branch: false, inserted_at: "" }))),
      createProject: async (b) => {
        rec("createProject", { ...b, db_pass: b.db_pass ? "[set]" : "" });
        if (o.createFails) throw new SupabaseError(o.createFails.status, `Supabase POST /v1/projects: ${o.createFails.status} ${o.createFails.message}`);
        const ref = `ref${String(++n).padStart(17, "0")}`.slice(0, 20);
        projects.set(ref, { ref, name: b.name, region: b.region, org: b.organization_slug, polls: 0, status: "COMING_UP", paused: false });
        return { ref, name: b.name, region: b.region, status: "COMING_UP", organization_slug: b.organization_slug, created_at: new Date().toISOString() };
      },
      project: async (ref) => {
        rec("project", ref);
        const p = projects.get(ref);
        if (!p) throw new SupabaseError(404, "not found");
        p.polls++;
        if (p.status === "COMING_UP" && p.polls >= 2) p.status = "ACTIVE_HEALTHY";
        if (p.status === "RESTORING") p.status = "ACTIVE_HEALTHY";
        return { ref, name: p.name, region: p.region, status: p.status as never, organization_slug: p.org, created_at: "" };
      },
      health: async (ref) => (rec("health", ref), ["auth", "db", "rest", "realtime", "storage"].map((name) => ({ name, status: "ACTIVE_HEALTHY" as const }))),
      apiKeys: async (ref) => (rec("apiKeys", ref), [
        { name: "default", type: "publishable", api_key: `sb_publishable_${ref}`, id: "k1" },
        { name: "default", type: "secret", api_key: `sb_secret_${ref}_TOPSECRET`, id: "k2" },
      ]),
      createApiKey: async (ref, type, name) => (rec("createApiKey", ref, type, name), { name, type, api_key: `sb_${type}_${ref}` }),
      updateAuthConfig: async (ref, patch) => {
        rec("updateAuthConfig", ref, Object.keys(patch));
        auth.set(ref, { ...(auth.get(ref) ?? {}), ...patch });
        return {};
      },
      authConfig: async (ref) => auth.get(ref) ?? {},
      query: async <R>(ref: string, query: string) => {
        rec("query", ref, query.slice(0, 80));
        proj(ref);
        if (o.sqlOutage) throw new SupabaseError(503, "Supabase POST /v1/projects/x/database/query: 503 unavailable");
        sql.push({ ref, query });
        if (o.failSql && o.failSql.test(query)) throw new SupabaseError(400, "Supabase POST /v1/projects/x/database/query: 400 syntax error");
        const set = migrations.get(ref) ?? new Set<string>();
        migrations.set(ref, set);
        if (/^SELECT version FROM supabase_migrations/.test(query)) return [...set].sort().map((version) => ({ version })) as R[];
        const ins = /INSERT INTO supabase_migrations\.schema_migrations \(version, name, statements\) VALUES \(\$(d2_[0-9a-f]+)\$(\d+)\$\1\$/.exec(query);
        if (ins) set.add(ins[2]!);
        if (/pg_database_size/.test(query)) return [{ db: 3 * 1024 ** 3, conns: 12, max_conns: 60, storage: 1024 ** 3, users: 420 }] as R[];
        return [] as R[];
      },
      pooler: async (ref) => [{ database_type: "PRIMARY", connection_string: `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`, db_host: "h", db_port: 6543, db_user: "u", pool_mode: "transaction" }],
      typescriptTypes: async (ref) => (rec("typescriptTypes", ref), { types: "export type Database = { public: { Tables: { items: { Row: { id: string } } } } }" }),
      backups: async (ref) => (rec("backups", ref), { region: "eu-central-1", pitr_enabled: false, walg_enabled: true, backups: [{ id: 1, status: "COMPLETED", inserted_at: "2026-11-02T03:00:00Z", is_physical_backup: true }] }),
      diskUtil: async () => ({ timestamp: "", metrics: { fs_size_bytes: 8 * 1024 ** 3, fs_avail_bytes: 4 * 1024 ** 3, fs_used_bytes: 4 * 1024 ** 3 } }),
      buckets: async () => [],
      postgrestConfig: async (ref) => (rec("postgrestConfig", ref), { db_schema: postgrest.get(ref) ?? "public, graphql_public" }),
      updatePostgrest: async (ref, patch) => {
        rec("updatePostgrest", ref, patch.db_schema);
        if (patch.db_schema) postgrest.set(ref, patch.db_schema);
        return { db_schema: postgrest.get(ref) ?? "" };
      },
      functions: async () => [],
      deployFunction: async (ref, slug, files, metadata) => (rec("deployFunction", ref, slug, files.map((f) => f.path), metadata), { id: "f1", slug, version: 3, status: "ACTIVE" }),
      secretNames: async (ref) => [...(secrets.get(ref)?.keys() ?? [])],
      setSecrets: async (ref, list) => {
        rec("setSecrets", ref, list.map((s) => s.name));
        const m = secrets.get(ref) ?? new Map();
        for (const s of list) m.set(s.name, s.value);
        secrets.set(ref, m);
      },
      advisors: async (ref, kind) => (rec("advisors", ref, kind), o.lints?.[kind] ?? []),
      apiCounts: async () => ({ result: [{ timestamp: "", total_auth_requests: 40, total_realtime_requests: 0, total_rest_requests: 900, total_storage_requests: 30 }] }),
      logs: async (_ref, q) => ({ result: /function_edge_logs/.test(q) ? [{ invocations: 1000, errors: 3 }] : [{ bytes: 2 * 1024 ** 3 }] }),
      addons: async () => ({ selected_addons: [{ type: "compute_instance", variant: { id: "ci_micro", name: "Micro", price: { description: "", type: "usage", interval: "hourly", amount: 0.01344 } } }] }),
      pause: async (ref) => {
        rec("pause", ref);
        projects.get(ref)!.paused = true;
        projects.get(ref)!.status = "INACTIVE";
      },
      restore: async (ref) => {
        rec("restore", ref);
        projects.get(ref)!.paused = false;
        projects.get(ref)!.status = "RESTORING";
      },
      branches: async () => [...branches.values()].map((b) => ({ id: b.id, name: b.name, project_ref: b.ref, parent_project_ref: b.parent, status: "MIGRATIONS_PASSED" })),
      createBranch: async (ref, b) => {
        rec("createBranch", ref, b.branch_name);
        const id = `br${++n}`;
        const bref = `bref${String(n).padStart(16, "0")}`;
        branches.set(id, { id, ref: bref, parent: ref, name: b.branch_name, polls: 0 });
        return { id, name: b.branch_name, project_ref: bref, parent_project_ref: ref, status: "CREATING_PROJECT", preview_project_status: "COMING_UP" };
      },
      branch: async (id) => {
        const b = branches.get(id)!;
        b.polls++;
        return { ref: b.ref, status: b.polls >= 2 ? "ACTIVE_HEALTHY" : "COMING_UP" };
      },
      deleteBranch: async (id) => (rec("deleteBranch", id), branches.delete(id), { message: "ok" }),
      createClaimToken: async (ref) => {
        rec("createClaimToken", ref);
        if (o.claimFails) throw new SupabaseError(403, "Supabase POST claim-token: 403 forbidden");
        const t = `claim_${ref}`;
        claims.set(t, ref);
        return { token: t, token_alias: "x", expires_at: "" };
      },
      revokeClaimToken: async () => undefined,
      claimPreview: async (slug, t) => (rec("claimPreview", slug, t), { project: { ref: claims.get(t)!, name: projects.get(claims.get(t)!)!.name }, preview: { valid: true, warnings: [{ key: "w", message: "Your organization is on the Free plan; the project will be on it too." }], errors: [], source_subscription_plan: "pro", target_subscription_plan: "free" }, expires_at: "" }),
      claim: async (slug, t) => {
        rec("claim", slug, t);
        projects.get(claims.get(t)!)!.org = slug;
      },
    };
    return impl as SupabaseApi;
  };
  return { api, calls, projects, migrations, sql, auth, secrets, branches, postgrest };
}

export const lint = (name: string, table: string, kind: "security" | "performance" = "security", level: Lint["level"] = "ERROR"): Lint => ({
  name,
  title: name === "rls_disabled_in_public" ? "RLS Disabled in Public" : "Unindexed foreign keys",
  level,
  facing: "EXTERNAL",
  categories: [kind.toUpperCase()],
  description: "",
  detail: `Table \`public.${table}\` is public, but RLS has not been enabled.`,
  remediation: "https://supabase.com/docs/guides/database/database-linter",
  metadata: { schema: "public", name: table, type: "table" },
  cache_key: `${name}_public_${table}`,
});
