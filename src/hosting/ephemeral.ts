import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPABASE_CLI, type MigrationFile } from "./migrations";
import { RESERVED_SCHEMAS } from "./schema-introspect";

/**
 * A temporary database for one capture run (docs/creative-quality.md §2b):
 * the Supabase CLI's local stack in Docker, started from a COPY of the app's
 * migrations in a workdir of its own (never the app's checkout), with a
 * unique project id (`day2cap-…`) and a free block of ports, so captures of
 * several apps can run side by side. It lives only for the run: started,
 * seeded with the approved demo cast, used by the build/flow, then stopped
 * with its volumes (`supabase stop --no-backup`) and its workdir removed —
 * always, in `finally`. A janitor removes stacks a crashed run left behind
 * (older than two hours) on startup and on the backlog timer.
 *
 * No persistent demo database exists anywhere: day2 keeps the cast, its
 * pictures and the validated seed plan only. The stack's keys are the CLI's
 * local development keys, read from `supabase status -o json` at run time,
 * held in memory for the run and never stored or logged.
 *
 * Only what a capture needs runs: Postgres, Auth (GoTrue), PostgREST,
 * Storage and Kong. Studio, Mailpit, Edge Runtime, imgproxy, Logflare,
 * Vector, Supavisor, Realtime and postgres-meta are excluded (`-x`).
 */

export const STACK_PREFIX = "day2cap-";
/** The label the Supabase CLI puts on every container, volume and network of a local project. */
export const STACK_LABEL = "com.supabase.cli.project";
export const EXCLUDED_SERVICES = ["studio", "mailpit", "edge-runtime", "imgproxy", "logflare", "vector", "supavisor", "realtime", "postgres-meta"];
export const STACK_MAX_AGE_MS = 2 * 60 * 60_000;
export const TIMEOUTS = { docker: 30_000, start: 12 * 60_000, status: 60_000, health: 2 * 60_000, stop: 2 * 60_000, queue: 45 * 60_000, seed: 5 * 60_000 };
const PORT_BASE = 55400;
const BLOCK = 10;
const BLOCKS = 40;

export type EphemeralRun = (cmd: string[], o: { cwd: string; env: Record<string, string>; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export type EphemeralDeps = {
  run: EphemeralRun;
  has: (bin: string) => boolean;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Where workdirs go (default <tmp>/day2-ephemeral). */
  root?: string;
  portFree?: (port: number) => Promise<boolean>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (text: string) => void;
  /** Overrides of TIMEOUTS (tests). */
  timeouts?: Partial<typeof TIMEOUTS>;
};

export type EphemeralCode = "no_docker" | "no_cli" | "busy" | "start" | "migration" | "health" | "timeout";
export class EphemeralError extends Error {
  constructor(
    message: string,
    public code: EphemeralCode,
    public hints: string[] = [],
    /** The migration file that didn't apply (code "migration"). */
    public migration: string | null = null,
  ) {
    super(message);
  }
}

export type StackPorts = { api: number; db: number; shadow: number; studio: number; smtp: number; analytics: number; pooler: number; inspector: number };

export type Stack = {
  projectId: string;
  dir: string;
  ports: StackPorts;
  /** http://127.0.0.1:<api> on this machine. */
  apiUrl: string;
  /** The local stack's public (anon) and service keys — in memory only, for this run. */
  anonKey: string;
  serviceKey: string;
  migrations: number;
  startedAt: string;
  /** Cuts the keys out of a text (errors, logs). */
  redact: (text: string) => string;
  /** Stops the stack (with its volumes), removes the workdir, frees the slot. Idempotent. */
  close: () => Promise<void>;
};

// ---------------------------------------------------------------- what this machine has

export type Requirement = { id: "docker" | "supabase_cli" | "cloudflared"; ok: boolean; label: string; hint: string | null };

/** Install hints for the owner (Mac) or the operator (Linux server). */
export function installHints(platform: string): Record<Requirement["id"], string> {
  const mac = platform === "darwin";
  return {
    docker: mac ? "Install Docker Desktop (docker.com/products/docker-desktop) and start it — day2 runs a temporary database in it for each capture." : "Install Docker Engine (docs.docker.com/engine/install) and let day2's user run it (add it to the docker group).",
    supabase_cli: mac ? "brew install supabase/tap/supabase (or install Node.js — day2 then runs the pinned Supabase CLI through npx)." : `Install Node.js so day2 can run the pinned ${SUPABASE_CLI} through npx, or put the supabase binary on PATH.`,
    cloudflared: mac ? "brew install cloudflared (only for captures on EAS: a short-lived tunnel to the temporary database)." : "Install cloudflared (pkg.cloudflare.com) — EAS captures reach the temporary database through a short-lived quick tunnel.",
  };
}

/** The Supabase CLI command: DAY2_SUPABASE_CLI (a binary), else the pinned version through npx, else `supabase` on PATH. */
export function supabaseCli(d: Pick<EphemeralDeps, "has" | "env">): string[] | null {
  const env = d.env ?? process.env;
  const own = env.DAY2_SUPABASE_CLI?.trim();
  if (own) return [own];
  if (d.has("npx")) return ["npx", "--yes", SUPABASE_CLI];
  if (d.has("supabase")) return ["supabase"];
  return null;
}

/** Can this machine run a temporary database: docker (daemon reachable) and the Supabase CLI. */
export async function ephemeralSupport(d: EphemeralDeps): Promise<{ ok: true; cli: string[] } | { ok: false; code: "no_docker" | "no_cli"; why: string; hints: string[] }> {
  const hints = installHints(d.platform ?? process.platform);
  if (!d.has("docker")) return { ok: false, code: "no_docker", why: "Docker isn't installed here, so day2 can't start a temporary database for the capture.", hints: [hints.docker] };
  const info = await d.run(["docker", "info", "--format", "{{.ServerVersion}}"], { cwd: tmpdir(), env: cliEnv(d.env), timeoutMs: TIMEOUTS.docker }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (info.code !== 0) return { ok: false, code: "no_docker", why: "Docker is installed but not running (its daemon doesn't answer).", hints: [(d.platform ?? process.platform) === "darwin" ? "Start Docker Desktop, then press Retry." : "Start the Docker daemon (systemctl start docker), then press Retry."] };
  const cli = supabaseCli(d);
  if (!cli) return { ok: false, code: "no_cli", why: "The Supabase CLI isn't available here.", hints: [hints.supabase_cli] };
  return { ok: true, cli };
}

/** The requirements as the console lists them (cloudflared only matters for EAS captures). */
export async function requirements(d: EphemeralDeps, o: { eas: boolean }): Promise<Requirement[]> {
  const hints = installHints(d.platform ?? process.platform);
  const s = await ephemeralSupport(d);
  const dockerOk = s.ok || s.code !== "no_docker";
  const out: Requirement[] = [
    { id: "docker", ok: dockerOk, label: "Docker (running)", hint: dockerOk ? null : !s.ok ? s.hints[0] ?? hints.docker : null },
    { id: "supabase_cli", ok: Boolean(supabaseCli(d)), label: `Supabase CLI (${SUPABASE_CLI})`, hint: supabaseCli(d) ? null : hints.supabase_cli },
  ];
  if (o.eas) out.push({ id: "cloudflared", ok: d.has("cloudflared"), label: "cloudflared (EAS captures)", hint: d.has("cloudflared") ? null : hints.cloudflared });
  return out;
}

/** The environment for the CLI and docker: no tokens, keys or passwords of day2's own. */
export function cliEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (/TOKEN|SECRET|PASSWORD|PRIVATE|_KEY$|^DATABASE_URL$|_DATABASE_URL$/i.test(k) && !k.startsWith("DOCKER_")) continue;
    out[k] = v;
  }
  out.DO_NOT_TRACK = "1";
  return out;
}

// ---------------------------------------------------------------- the concurrency limit

export const maxStacks = (env: Record<string, string | undefined> = process.env) => {
  const n = Math.floor(Number(env.DAY2_EPHEMERAL_MAX ?? 2));
  return n >= 1 ? n : 2;
};
let runningStacks = 0;
const waiters: Array<{ go: () => void }> = [];
const activeIds = new Set<string>();

export const ephemeralQueue = (env?: Record<string, string | undefined>) => ({ running: runningStacks, waiting: waiters.length, max: maxStacks(env) });

/** A slot for a stack (FIFO); resolves with its release. */
export async function acquireSlot(d: Pick<EphemeralDeps, "env" | "log">, timeoutMs = TIMEOUTS.queue): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    runningStacks--;
    const next = waiters.shift();
    if (next) {
      runningStacks++;
      next.go();
    }
  };
  if (runningStacks < maxStacks(d.env)) {
    runningStacks++;
    return release;
  }
  d.log?.(`Waiting for a free slot for the temporary database (${runningStacks} running, at most ${maxStacks(d.env)} at a time).`);
  await new Promise<void>((resolve, reject) => {
    const w = { go: () => (clearTimeout(timer), resolve()) };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new EphemeralError("Other captures kept every temporary-database slot busy for too long — day2 tries again later.", "busy"));
    }, timeoutMs);
    waiters.push(w);
  });
  return release;
}

// ---------------------------------------------------------------- ports

const reservedBlocks = new Set<number>();

const listenable = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });

/** Nothing listens on the port, on any IPv4 address (Docker publishes the stack's ports on the host). */
export async function defaultPortFree(port: number): Promise<boolean> {
  return (await listenable(port, "0.0.0.0")) && (await listenable(port, "127.0.0.1"));
}

/** A block of 10 free ports (not used by another run in this process, nothing listening). */
export async function allocatePorts(d: Pick<EphemeralDeps, "env" | "portFree">): Promise<{ block: number; ports: StackPorts; release: () => void }> {
  const base = Number((d.env ?? process.env).DAY2_EPHEMERAL_PORT_BASE ?? PORT_BASE) || PORT_BASE;
  const free = d.portFree ?? defaultPortFree;
  for (let b = 0; b < BLOCKS; b++) {
    if (reservedBlocks.has(b)) continue;
    const p = base + b * BLOCK;
    const ports: StackPorts = { api: p, db: p + 1, shadow: p + 2, studio: p + 3, smtp: p + 4, analytics: p + 5, pooler: p + 6, inspector: p + 7 };
    reservedBlocks.add(b);
    let ok = true;
    for (const port of Object.values(ports))
      if (!(await free(port))) {
        ok = false;
        break;
      }
    if (ok) return { block: b, ports, release: () => reservedBlocks.delete(b) };
    reservedBlocks.delete(b);
  }
  throw new EphemeralError(`No free ports for a temporary database (tried ${BLOCKS} blocks from ${base}).`, "busy");
}

// ---------------------------------------------------------------- the workdir

/** A project id that says when it was made: day2cap-<base36 ms>-<random>. */
export function newProjectId(now: Date): string {
  return `${STACK_PREFIX}${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
}
/** When a day2 stack was made (from its id), or null for anything else. */
export function projectIdTime(id: string): number | null {
  const m = new RegExp(`^${STACK_PREFIX}([0-9a-z]+)-[0-9a-f]+$`).exec(id);
  if (!m) return null;
  const t = parseInt(m[1]!, 36);
  return Number.isFinite(t) ? t : null;
}

const tomlString = (s: string) => JSON.stringify(s);

/** Pure. The temporary stack's config.toml: its own id and ports, the app's schemas exposed, sign-ups off, nothing extra running. */
export function stackConfigToml(o: { projectId: string; ports: StackPorts; schemas: string[]; majorVersion: number | null }): string {
  const own = o.schemas.filter((s) => s !== "public" && !RESERVED_SCHEMAS.includes(s) && /^[a-z_][a-z0-9_]*$/.test(s));
  const schemas = ["public", "graphql_public", ...new Set(own)];
  return [
    "# Written by day2 for one capture run; removed with the stack.",
    `project_id = ${tomlString(o.projectId)}`,
    "",
    "[api]",
    "enabled = true",
    `port = ${o.ports.api}`,
    `schemas = [${schemas.map(tomlString).join(", ")}]`,
    'extra_search_path = ["public", "extensions"]',
    "max_rows = 1000",
    "",
    "[db]",
    `port = ${o.ports.db}`,
    `shadow_port = ${o.ports.shadow}`,
    `major_version = ${o.majorVersion ?? 17}`,
    "",
    "[db.pooler]",
    "enabled = false",
    `port = ${o.ports.pooler}`,
    "",
    "[db.migrations]",
    "enabled = true",
    "",
    "[db.seed]",
    "enabled = false",
    "",
    "[realtime]",
    "enabled = false",
    "",
    "[studio]",
    "enabled = false",
    `port = ${o.ports.studio}`,
    "",
    "[local_smtp]",
    "enabled = false",
    `port = ${o.ports.smtp}`,
    "",
    "[storage]",
    "enabled = true",
    'file_size_limit = "50MiB"',
    "",
    "[auth]",
    "enabled = true",
    `site_url = "http://127.0.0.1:${o.ports.api}"`,
    "enable_signup = false",
    "enable_anonymous_sign_ins = false",
    "",
    "[auth.email]",
    "enable_signup = false",
    "enable_confirmations = false",
    "",
    "[edge_runtime]",
    "enabled = false",
    `inspector_port = ${o.ports.inspector}`,
    "",
    "[analytics]",
    "enabled = false",
    `port = ${o.ports.analytics}`,
    "",
  ].join("\n");
}

/** Pure. Settings migrations need on a fresh stack: function bodies checked later; PostGIS when the migrations use its public types without creating it. */
export function migrationPreamble(files: MigrationFile[]): string {
  const all = files.map((f) => f.sql).join("\n").toLowerCase();
  const out = ["SET check_function_bodies = off;"];
  if (/public\.(geography|geometry|st_)/.test(all) && !/create\s+extension[^;]*postgis/.test(all)) out.push("CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;");
  return out.join("\n");
}

/** The app's database major version from its own config.toml (`[db] major_version`), if it says. */
export function appMajorVersion(repoPath: string): number | null {
  const f = join(repoPath, "supabase", "config.toml");
  if (!existsSync(f)) return null;
  const m = /\[db\][^[]*?major_version\s*=\s*(\d+)/.exec(readFileSync(f, "utf-8"));
  const v = m ? Number(m[1]) : NaN;
  return v >= 14 && v <= 18 ? v : null;
}

/** Writes the workdir: supabase/config.toml (day2's) and a copy of each migration with the preamble. Nothing else of the app. */
export function prepareWorkdir(o: { root: string; projectId: string; ports: StackPorts; files: MigrationFile[]; schemas: string[]; majorVersion: number | null }): string {
  const dir = join(o.root, o.projectId);
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(dir, "supabase", "config.toml"), stackConfigToml(o));
  const pre = migrationPreamble(o.files);
  for (const f of o.files) {
    if (!/^[\w.-]+\.sql$/.test(f.file)) continue;
    writeFileSync(join(dir, "supabase", "migrations", f.file), `${pre}\n${f.sql}\n`);
  }
  return dir;
}

export const defaultRoot = () => join(tmpdir(), "day2-ephemeral");

// ---------------------------------------------------------------- starting, status, health

const lastLines = (s: string, n = 4) => s.trim().split("\n").map((x) => x.trim()).filter(Boolean).slice(-n).join(" ").slice(0, 500);

/** Pure. Why `supabase start` failed, as day2 says it (the migration that didn't apply, Docker, images, ports). */
export function startFailure(out: string): EphemeralError {
  const applying = [...out.matchAll(/Applying migration (\S+\.sql)/g)].map((m) => m[1]!);
  const errLine = out.split("\n").find((l) => /\bERROR\b|error:/i.test(l))?.trim().slice(0, 300) ?? lastLines(out, 2);
  if (applying.length && /ERROR|SQLSTATE/i.test(out)) {
    const file = applying.at(-1)!;
    return new EphemeralError(`The app's migration ${file} didn't apply on the temporary database: ${errLine}`, "migration", [], file);
  }
  if (/Cannot connect to the Docker daemon|docker daemon|failed to connect to the docker API/i.test(out)) return new EphemeralError("Docker stopped answering while the temporary database started.", "no_docker", ["Start Docker, then press Retry."]);
  if (/port is already allocated|address already in use/i.test(out)) return new EphemeralError("A port of the temporary database was taken meanwhile — day2 tries again.", "busy");
  if (/failed to pull|pull access denied|manifest unknown|failed to resolve reference|Forbidden|TLS handshake|i\/o timeout/i.test(out)) return new EphemeralError(`Docker couldn't download Supabase's images: ${errLine}`, "start", ["Check this machine's internet access to public.ecr.aws / Docker Hub, then press Retry."]);
  return new EphemeralError(`The temporary database didn't start: ${errLine}`, "start");
}

type StatusJson = Record<string, unknown>;
/** Pure. The values of `supabase status -o json` (local keys only). */
export function parseStatus(stdout: string): { apiUrl: string | null; anonKey: string | null; serviceKey: string | null } {
  const a = stdout.indexOf("{");
  const b = stdout.lastIndexOf("}");
  if (a < 0 || b < a) return { apiUrl: null, anonKey: null, serviceKey: null };
  let j: StatusJson = {};
  try {
    j = JSON.parse(stdout.slice(a, b + 1)) as StatusJson;
  } catch {
    return { apiUrl: null, anonKey: null, serviceKey: null };
  }
  const s = (k: string) => (typeof j[k] === "string" && j[k] ? (j[k] as string) : null);
  return { apiUrl: s("API_URL"), anonKey: s("ANON_KEY") ?? s("PUBLISHABLE_KEY"), serviceKey: s("SERVICE_ROLE_KEY") ?? s("SECRET_KEY") };
}

async function waitHealthy(apiUrl: string, anon: string, service: string, d: EphemeralDeps): Promise<void> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (d.timeouts?.health ?? TIMEOUTS.health);
  const checks: Array<[string, string]> = [
    ["/auth/v1/health", anon],
    ["/rest/v1/", anon],
    ["/storage/v1/bucket", service],
  ];
  let last = "";
  for (;;) {
    let ok = true;
    for (const [path, key] of checks) {
      try {
        const r = await f(`${apiUrl}${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        await r.body?.cancel().catch(() => undefined);
        if (!r.ok) {
          ok = false;
          last = `${path.split("/")[1]} answered ${r.status}`;
          break;
        }
      } catch (err) {
        ok = false;
        last = `${path} ${(err as Error).message.slice(0, 80)}`;
        break;
      }
    }
    if (ok) return;
    if (Date.now() >= deadline) throw new EphemeralError(`The temporary database started but isn't answering (${last}).`, "health");
    await sleep(2000);
  }
}

// ---------------------------------------------------------------- removing

/** Removes a stack's containers, volumes and network by its label (the janitor; the fallback when `supabase stop` fails). */
export async function removeByLabel(projectId: string, d: Pick<EphemeralDeps, "run" | "env">): Promise<void> {
  if (!projectId.startsWith(STACK_PREFIX)) return;
  const env = cliEnv(d.env);
  const o = { cwd: tmpdir(), env, timeoutMs: TIMEOUTS.docker };
  const filter = `label=${STACK_LABEL}=${projectId}`;
  const ids = (await d.run(["docker", "ps", "-aq", "--filter", filter], o).catch(() => ({ code: 1, stdout: "", stderr: "" }))).stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await d.run(["docker", "rm", "-f", "-v", ...ids], { ...o, timeoutMs: TIMEOUTS.stop }).catch(() => undefined);
  const vols = (await d.run(["docker", "volume", "ls", "-q", "--filter", filter], o).catch(() => ({ code: 1, stdout: "", stderr: "" }))).stdout.split(/\s+/).filter(Boolean);
  if (vols.length) await d.run(["docker", "volume", "rm", "-f", ...vols], o).catch(() => undefined);
  const nets = (await d.run(["docker", "network", "ls", "-q", "--filter", filter], o).catch(() => ({ code: 1, stdout: "", stderr: "" }))).stdout.split(/\s+/).filter(Boolean);
  if (nets.length) await d.run(["docker", "network", "rm", ...nets], o).catch(() => undefined);
}

async function teardown(cli: string[] | null, projectId: string, dir: string | null, d: EphemeralDeps): Promise<void> {
  let stopped = false;
  if (cli && dir && existsSync(dir)) {
    const r = await d.run([...cli, "stop", "--no-backup", "--workdir", dir], { cwd: dir, env: cliEnv(d.env), timeoutMs: TIMEOUTS.stop }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    stopped = r.code === 0;
  }
  // Belt and braces: whatever still carries the stack's label goes too.
  if (!stopped) await removeByLabel(projectId, d).catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes day2 stacks older than `maxAgeMs` that no run in this process
 * owns (a crash or a restart left them), and their workdirs. Only
 * `day2cap-…` projects are ever touched. Returns the ids removed.
 */
export async function janitor(d: EphemeralDeps, o: { maxAgeMs?: number } = {}): Promise<string[]> {
  const maxAge = o.maxAgeMs ?? STACK_MAX_AGE_MS;
  const now = (d.now ? d.now() : new Date()).getTime();
  const old = (id: string) => {
    const t = projectIdTime(id);
    return t !== null && now - t > maxAge && !activeIds.has(id);
  };
  const removed: string[] = [];
  if (d.has("docker")) {
    const r = await d.run(["docker", "ps", "-a", "--filter", `label=${STACK_LABEL}`, "--format", `{{.Label "${STACK_LABEL}"}}`], { cwd: tmpdir(), env: cliEnv(d.env), timeoutMs: TIMEOUTS.docker }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const vr = await d.run(["docker", "volume", "ls", "--filter", `label=${STACK_LABEL}`, "--format", `{{.Label "${STACK_LABEL}"}}`], { cwd: tmpdir(), env: cliEnv(d.env), timeoutMs: TIMEOUTS.docker }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const ids = new Set([...(r.code === 0 ? r.stdout.split("\n") : []), ...(vr.code === 0 ? vr.stdout.split("\n") : [])].map((x) => x.trim()).filter((x) => x.startsWith(STACK_PREFIX)));
    for (const id of ids)
      if (old(id)) {
        await removeByLabel(id, d);
        removed.push(id);
      }
  }
  const root = d.root ?? defaultRoot();
  if (existsSync(root))
    for (const name of readdirSync(root)) {
      if (!name.startsWith(STACK_PREFIX) || activeIds.has(name)) continue;
      const t = projectIdTime(name) ?? statSync(join(root, name)).mtimeMs;
      if (now - t > maxAge) rmSync(join(root, name), { recursive: true, force: true });
    }
  if (removed.length) console.log(`[day2-ephemeral] removed ${removed.length} leftover temporary database(s): ${removed.join(", ")}`);
  return removed;
}

// ---------------------------------------------------------------- the lifecycle

/**
 * Starts a temporary database with the app's migrations (queued behind
 * DAY2_EPHEMERAL_MAX others). On any failure everything started is removed
 * before the error is thrown; on success the caller must `close()` it
 * (withStack does, in finally).
 */
export async function openStack(o: { files: MigrationFile[]; schemas: string[]; majorVersion?: number | null }, d: EphemeralDeps): Promise<Stack> {
  const support = await ephemeralSupport(d);
  if (!support.ok) throw new EphemeralError(support.why, support.code, support.hints);
  const cli = support.cli;
  const log = d.log ?? (() => undefined);
  const release = await acquireSlot(d, d.timeouts?.queue ?? TIMEOUTS.queue);
  const now = d.now ? d.now() : new Date();
  const projectId = newProjectId(now);
  activeIds.add(projectId);
  let ports: Awaited<ReturnType<typeof allocatePorts>> | null = null;
  let dir: string | null = null;
  const done = async () => {
    try {
      await teardown(cli, projectId, dir, d);
    } finally {
      ports?.release();
      activeIds.delete(projectId);
      release();
    }
  };
  let keys: string[] = [];
  const redact = (s: string) => keys.reduce((t, k) => (k ? t.split(k).join("[local key]") : t), s);
  try {
    await janitor(d).catch(() => []);
    ports = await allocatePorts(d);
    const root = d.root ?? defaultRoot();
    mkdirSync(root, { recursive: true });
    dir = prepareWorkdir({ root, projectId, ports: ports.ports, files: o.files, schemas: o.schemas, majorVersion: o.majorVersion ?? null });
    log(`Starting a temporary database (${o.files.length} migrations, API on port ${ports.ports.api})…`);
    const env = cliEnv(d.env);
    const r = await d.run([...cli, "start", "--workdir", dir, "-x", EXCLUDED_SERVICES.join(",")], { cwd: dir, env, timeoutMs: TIMEOUTS.start });
    if (r.code !== 0) {
      const out = `${r.stderr}\n${r.stdout}`;
      throw /timed out|killed/i.test(out) && !out.includes("Applying migration") ? new EphemeralError("The temporary database didn't start in time.", "timeout") : startFailure(out);
    }
    const st = await d.run([...cli, "status", "-o", "json", "--workdir", dir], { cwd: dir, env, timeoutMs: TIMEOUTS.status });
    const s = parseStatus(st.stdout);
    if (!s.anonKey || !s.serviceKey) throw new EphemeralError("The temporary database started, but `supabase status` didn't give its local keys.", "start");
    keys = [s.anonKey, s.serviceKey];
    const apiUrl = `http://127.0.0.1:${ports.ports.api}`;
    await waitHealthy(apiUrl, s.anonKey, s.serviceKey, d);
    log(`The temporary database is up (${o.files.length} migrations applied).`);
    let closed: Promise<void> | null = null;
    return {
      projectId,
      dir,
      ports: ports.ports,
      apiUrl,
      anonKey: s.anonKey,
      serviceKey: s.serviceKey,
      migrations: o.files.length,
      startedAt: now.toISOString(),
      redact,
      close: () =>
        (closed ??= done().then(() => {
          log("The temporary database was stopped and deleted.");
        })),
    };
  } catch (err) {
    await done().catch(() => undefined);
    if (err instanceof EphemeralError) {
      err.message = redact(err.message);
      throw err;
    }
    throw new EphemeralError(redact(`The temporary database didn't start: ${(err as Error).message.slice(0, 300)}`), "start");
  }
}

/** Runs `fn` with a temporary database; it is always removed afterwards, whatever happens. */
export async function withStack<T>(o: Parameters<typeof openStack>[0], fn: (s: Stack) => Promise<T>, d: EphemeralDeps): Promise<T> {
  const s = await openStack(o, d);
  try {
    return await fn(s);
  } finally {
    await s.close().catch((err: Error) => console.error(`[day2-ephemeral] teardown of ${s.projectId} failed: ${err.message}`));
  }
}

/** Tests: the stacks this process owns. */
export const activeStacks = () => [...activeIds];
