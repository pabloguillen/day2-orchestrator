import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Runner } from "./migrations";
import { SUPABASE_CLI } from "./migrations";
import type { SupabaseApi } from "./supabase";

/**
 * Edge functions: `supabase/functions/<name>/index.ts` in the app's repo
 * (plus `supabase/functions/_shared/`), deployed with the Management API
 * (POST /v1/projects/{ref}/functions/deploy, multipart — Supabase bundles
 * them). Fallback: `supabase functions deploy <name> --use-api` with the
 * access token in SUPABASE_ACCESS_TOKEN.
 *
 * Secrets the functions need are listed by name in
 * `supabase/functions/.env.example`; their values come from the owner (the
 * Hosting page) and are set with POST /v1/projects/{ref}/secrets. Values are
 * never stored by day2 (Supabase keeps them) and never shown again.
 */

export type FunctionSource = { slug: string; files: Array<{ path: string; content: string }>; entrypoint: string; importMap: string | null; verifyJwt: boolean };

const SRC = /\.(ts|tsx|js|mjs|json|jsonc)$/;

function walk(dir: string, base: string, out: Array<{ path: string; content: string }>, depth = 0): void {
  if (depth > 5 || !existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, out, depth + 1);
    else if (SRC.test(e) && st.size < 2_000_000) out.push({ path: relative(base, p).split("\\").join("/"), content: readFileSync(p, "utf-8") });
  }
}

/** verify_jwt per function from supabase/config.toml (`[functions.<name>] verify_jwt = false`); default true. */
export function verifyJwtSettings(repoPath: string): Record<string, boolean> {
  const p = join(repoPath, "supabase", "config.toml");
  if (!existsSync(p)) return {};
  const out: Record<string, boolean> = {};
  let current: string | null = null;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const sec = /^\s*\[functions\.([\w-]+)\]\s*$/.exec(line);
    if (sec) current = sec[1]!;
    else if (/^\s*\[/.test(line)) current = null;
    const v = /^\s*verify_jwt\s*=\s*(true|false)/.exec(line);
    if (current && v) out[current] = v[1] === "true";
  }
  return out;
}

export function readFunctions(repoPath: string): FunctionSource[] {
  const root = join(repoPath, "supabase", "functions");
  if (!existsSync(root)) return [];
  const shared: Array<{ path: string; content: string }> = [];
  walk(join(root, "_shared"), root, shared);
  const jwt = verifyJwtSettings(repoPath);
  return readdirSync(root)
    .filter((d) => !d.startsWith("_") && !d.startsWith(".") && statSync(join(root, d)).isDirectory() && existsSync(join(root, d, "index.ts")))
    .sort()
    .map((slug) => {
      const files: Array<{ path: string; content: string }> = [];
      walk(join(root, slug), root, files);
      const importMap = ["deno.json", "deno.jsonc", "import_map.json"].map((f) => `${slug}/${f}`).find((f) => files.some((x) => x.path === f)) ?? null;
      return { slug, files: [...files, ...shared], entrypoint: `${slug}/index.ts`, importMap, verifyJwt: jwt[slug] ?? true };
    });
}

/** Secret names the functions expect (supabase/functions/.env.example). */
export function neededSecrets(repoPath: string): string[] {
  const p = join(repoPath, "supabase", "functions", ".env.example");
  if (!existsSync(p)) return [];
  return [...new Set(readFileSync(p, "utf-8").split("\n").map((l) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(l)?.[1]).filter((x): x is string => Boolean(x) && !x!.startsWith("SUPABASE_")))];
}

export async function deployFunctions(api: SupabaseApi, ref: string, fns: FunctionSource[]): Promise<{ deployed: Array<{ slug: string; version: number }>; failed: Array<{ slug: string; error: string }> }> {
  const deployed: Array<{ slug: string; version: number }> = [];
  const failed: Array<{ slug: string; error: string }> = [];
  for (const fn of fns) {
    try {
      const r = await api.deployFunction(ref, fn.slug, fn.files, { entrypoint_path: fn.entrypoint, ...(fn.importMap ? { import_map_path: fn.importMap } : {}), verify_jwt: fn.verifyJwt, name: fn.slug });
      deployed.push({ slug: fn.slug, version: r.version });
    } catch (err) {
      failed.push({ slug: fn.slug, error: (err as Error).message.slice(0, 300) });
    }
  }
  return { deployed, failed };
}

/** Fallback through the CLI (token in the child's environment, never argv). */
export async function deployWithCli(run: Runner, repoPath: string, ref: string, slug: string, env: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await run(["npx", "--yes", SUPABASE_CLI, "functions", "deploy", slug, "--project-ref", ref, "--use-api"], { cwd: repoPath, env });
  if (r.code === 0) return { ok: true };
  const token = env.SUPABASE_ACCESS_TOKEN;
  const tail = `${r.stderr}\n${r.stdout}`.trim().split("\n").slice(-8).join("\n");
  return { ok: false, error: (token ? tail.split(token).join("[token]") : tail).slice(0, 600) };
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Pure. Checks a function secret the owner typed. */
export function parseSecret(input: unknown): { name: string; value: string } {
  const o = (input ?? {}) as { name?: unknown; value?: unknown };
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const value = typeof o.value === "string" ? o.value : "";
  if (!SECRET_NAME.test(name)) throw new Error("A secret's name is capital letters, digits and underscores, like STRIPE_KEY.");
  if (name.startsWith("SUPABASE_")) throw new Error("Names starting with SUPABASE_ are Supabase's own.");
  if (!value || value.length > 10_000) throw new Error("Paste the secret's value.");
  return { name, value };
}
