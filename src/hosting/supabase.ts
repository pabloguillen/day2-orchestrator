import type { InstanceSize, ProjectStatus, Region } from "./types";

/**
 * The Supabase Management API (https://api.supabase.com/v1), with a bearer
 * token: day2's own (SUPABASE_ACCESS_TOKEN, a personal access token of a
 * member of day2's organization) or, after a takeover, the owner's.
 *
 * Every endpoint here was checked against Supabase's published OpenAPI spec
 * (apps/docs/spec/api_v1_openapi.json in supabase/supabase, November 2026).
 * Endpoints the spec marks experimental/beta: database/query, advisors,
 * available-regions. None of this has run against a real organization yet.
 *
 * Errors never contain the token (redacted), and no request or response
 * body is logged.
 */

export const SUPABASE_API = "https://api.supabase.com";

export class SupabaseError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ApiKey = { api_key?: string | null; id?: string | null; type?: "legacy" | "publishable" | "secret" | null; name: string };
export type Lint = { name: string; title: string; level: "ERROR" | "WARN" | "INFO"; facing: string; categories: string[]; description: string; detail: string; remediation: string; metadata?: { schema?: string; name?: string; entity?: string; type?: string } | null; cache_key: string };
export type ServiceHealth = { name: string; status: "COMING_UP" | "ACTIVE_HEALTHY" | "UNHEALTHY"; error?: string };
export type Branch = { id: string; name: string; project_ref: string; parent_project_ref: string; status: string; pr_number?: number; git_branch?: string; preview_project_status?: ProjectStatus };
export type Addon = { type: string; variant: { id: string; name: string; price: { description: string; type: "fixed" | "usage"; interval: "monthly" | "hourly"; amount: number } } };

export type SupabaseDeps = { fetch?: typeof fetch; base?: string };

export function supabaseApi(token: string, deps: SupabaseDeps = {}) {
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? SUPABASE_API;
  const redact = (s: string) => (token ? s.split(token).join("[token]") : s);

  async function call<T>(method: string, path: string, o: { body?: unknown; query?: Record<string, string | undefined>; headers?: Record<string, string>; form?: FormData; raw?: boolean } = {}): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", ...(o.headers ?? {}) };
    let body: BodyInit | undefined;
    if (o.form) body = o.form;
    else if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    let res: Response;
    try {
      res = await f(url.toString(), { method, headers, body });
    } catch (err) {
      throw new SupabaseError(0, redact(`Supabase can't be reached (${(err as Error).message}).`));
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string; msg?: string };
        msg = j.message ?? j.error ?? j.msg ?? msg;
      } catch {
        /* not JSON */
      }
      throw new SupabaseError(res.status, redact(`Supabase ${method} ${url.pathname}: ${res.status} ${msg}`.trim()));
    }
    if (o.raw) return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  const p = (ref: string) => `/v1/projects/${encodeURIComponent(ref)}`;

  return {
    // ---- Organization ----
    organization: (slug: string) => call<{ id: string; name: string; plan?: "free" | "pro" | "team" | "enterprise" | "platform" }>("GET", `/v1/organizations/${encodeURIComponent(slug)}`),
    entitlements: (slug: string) => call<{ entitlements: Array<{ feature: { key: string; type: string }; hasAccess: boolean }> }>("GET", `/v1/organizations/${encodeURIComponent(slug)}/entitlements`),
    orgProjects: async (slug: string, search: string) => (await call<{ projects: Array<{ ref: string; name: string; region: string; status: ProjectStatus; is_branch: boolean; inserted_at: string }> }>("GET", `/v1/organizations/${encodeURIComponent(slug)}/projects`, { query: { search, limit: "20" } })).projects ?? [],
    organizations: () => call<Array<{ id: string; slug?: string; name: string }>>("GET", "/v1/organizations"),

    // ---- Projects ----
    createProject: (b: { name: string; organization_slug: string; db_pass: string; region: Region; desired_instance_size?: InstanceSize }) =>
      call<{ ref: string; name: string; region: string; status: ProjectStatus; organization_slug: string; created_at: string }>("POST", "/v1/projects", {
        // `region` is deprecated in favour of region_selection; send the new form.
        body: { name: b.name, organization_slug: b.organization_slug, db_pass: b.db_pass, region_selection: { type: "specific", code: b.region }, ...(b.desired_instance_size ? { desired_instance_size: b.desired_instance_size } : {}) },
      }),
    project: (ref: string) => call<{ ref: string; name: string; region: string; status: ProjectStatus; organization_slug: string; created_at: string; database?: { host: string; version: string } }>("GET", p(ref)),
    health: (ref: string, services = ["auth", "db", "rest", "realtime", "storage"]) => call<ServiceHealth[]>("GET", `${p(ref)}/health`, { query: { services: services.join(",") } }),
    pause: (ref: string) => call<void>("POST", `${p(ref)}/pause`),
    restore: (ref: string) => call<void>("POST", `${p(ref)}/restore`),

    // ---- Keys ----
    apiKeys: (ref: string) => call<ApiKey[]>("GET", `${p(ref)}/api-keys`, { query: { reveal: "true" } }),
    createApiKey: (ref: string, type: "publishable" | "secret", name: string) => call<ApiKey>("POST", `${p(ref)}/api-keys`, { query: { reveal: "true" }, body: { type, name } }),

    // ---- Auth ----
    authConfig: (ref: string) => call<Record<string, unknown>>("GET", `${p(ref)}/config/auth`),
    updateAuthConfig: (ref: string, patch: Record<string, unknown>) => call<Record<string, unknown>>("PATCH", `${p(ref)}/config/auth`, { body: patch }),

    // ---- Database ----
    /** Runs SQL as the postgres role (beta endpoint). Returns rows of the last statement. */
    query: <R = Record<string, unknown>>(ref: string, sql: string, readOnly = false) => call<R[]>("POST", readOnly ? `${p(ref)}/database/query/read-only` : `${p(ref)}/database/query`, { body: { query: sql } }),
    pooler: (ref: string) => call<Array<{ database_type: string; connection_string: string; db_host: string; db_port: number; db_user: string; pool_mode: string }>>("GET", `${p(ref)}/config/database/pooler`),
    typescriptTypes: (ref: string) => call<{ types: string }>("GET", `${p(ref)}/types/typescript`, { query: { included_schemas: "public" } }),
    backups: (ref: string) => call<{ region: string; pitr_enabled: boolean; walg_enabled: boolean; backups: Array<{ id: number; status: string; inserted_at: string; is_physical_backup: boolean }> }>("GET", `${p(ref)}/database/backups`),
    diskUtil: (ref: string) => call<{ timestamp: string; metrics: { fs_size_bytes: number; fs_avail_bytes: number; fs_used_bytes: number } }>("GET", `${p(ref)}/config/disk/util`),

    // ---- Data API (PostgREST) settings: which schemas the REST API serves ----
    postgrestConfig: (ref: string) => call<{ db_schema: string; max_rows?: number; db_extra_search_path?: string }>("GET", `${p(ref)}/postgrest`),
    updatePostgrest: (ref: string, patch: { db_schema?: string }) => call<{ db_schema: string }>("PATCH", `${p(ref)}/postgrest`, { body: patch }),

    // ---- Storage ----
    buckets: (ref: string) => call<Array<{ id: string; name: string; public: boolean }>>("GET", `${p(ref)}/storage/buckets`),

    // ---- Functions ----
    functions: (ref: string) => call<Array<{ slug: string; version: number; status: string }>>("GET", `${p(ref)}/functions`),
    /** multipart: `metadata` (JSON) and one `file` part per source file, named by its path. */
    deployFunction: (ref: string, slug: string, files: Array<{ path: string; content: string }>, metadata: { entrypoint_path: string; import_map_path?: string; verify_jwt?: boolean; name?: string }) => {
      const form = new FormData();
      form.append("metadata", JSON.stringify(metadata));
      for (const file of files) form.append("file", new Blob([file.content], { type: "application/typescript" }), file.path);
      return call<{ id: string; slug: string; version: number; status: string }>("POST", `${p(ref)}/functions/deploy`, { query: { slug }, form });
    },
    secretNames: async (ref: string) => (await call<Array<{ name: string }>>("GET", `${p(ref)}/secrets`)).map((s) => s.name),
    setSecrets: (ref: string, secrets: Array<{ name: string; value: string }>) => call<void>("POST", `${p(ref)}/secrets`, { body: secrets }),

    // ---- Advisors (beta) ----
    advisors: async (ref: string, kind: "security" | "performance") => (await call<{ lints: Lint[] }>("GET", `${p(ref)}/advisors/${kind}`)).lints ?? [],

    // ---- Usage and logs ----
    apiCounts: (ref: string, interval: "1day" | "7day" = "1day") =>
      call<{ result?: Array<{ timestamp: string; total_auth_requests: number; total_realtime_requests: number; total_rest_requests: number; total_storage_requests: number }>; error?: unknown }>("GET", `${p(ref)}/analytics/endpoints/usage.api-counts`, { query: { interval } }),
    /** SQL over the project's logs; the range is at most 24 hours. */
    logs: (ref: string, sql: string, start: Date, end: Date) =>
      call<{ result?: Array<Record<string, unknown>>; error?: unknown }>("GET", `${p(ref)}/analytics/endpoints/logs`, { query: { sql, iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() } }),
    addons: (ref: string) => call<{ selected_addons: Addon[] }>("GET", `${p(ref)}/billing/addons`),

    // ---- Branching (previews per pull request) ----
    branches: (ref: string) => call<Branch[]>("GET", `${p(ref)}/branches`),
    createBranch: (ref: string, b: { branch_name: string; git_branch?: string; persistent?: boolean }) => call<Branch>("POST", `${p(ref)}/branches`, { body: b }),
    branch: (idOrRef: string) => call<{ ref: string; status: ProjectStatus }>("GET", `/v1/branches/${encodeURIComponent(idOrRef)}`),
    deleteBranch: (idOrRef: string) => call<{ message: string }>("DELETE", `/v1/branches/${encodeURIComponent(idOrRef)}`),

    // ---- Moving a project to another organization (claim tokens) ----
    createClaimToken: (ref: string) => call<{ token: string; token_alias: string; expires_at: string }>("POST", `${p(ref)}/claim-token`),
    revokeClaimToken: (ref: string) => call<void>("DELETE", `${p(ref)}/claim-token`),
    claimPreview: (slug: string, token: string) =>
      call<{ project: { ref: string; name: string }; preview: { valid: boolean; warnings: Array<{ key: string; message: string }>; errors: Array<{ key: string; message: string }>; source_subscription_plan: string; target_subscription_plan: string | null }; expires_at: string }>(
        "GET",
        `/v1/organizations/${encodeURIComponent(slug)}/project-claim/${encodeURIComponent(token)}`,
      ),
    claim: (slug: string, token: string) => call<void>("POST", `/v1/organizations/${encodeURIComponent(slug)}/project-claim/${encodeURIComponent(token)}`),
  };
}

export type SupabaseApi = ReturnType<typeof supabaseApi>;

export const projectUrl = (ref: string) => `https://${ref}.supabase.co`;
