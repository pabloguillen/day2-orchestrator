import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot, activeStacks, allocatePorts, EphemeralError, ephemeralQueue, ephemeralSupport, EXCLUDED_SERVICES, janitor, newProjectId, openStack, parseStatus, prepareWorkdir, projectIdTime, requirements, stackConfigToml, startFailure, STACK_PREFIX, withStack, type EphemeralDeps } from "./ephemeral";
import { readMigrations, type MigrationFile } from "./migrations";
import { introspectMigrations } from "./schema-introspect";

/**
 * The temporary database (hosting/ephemeral.ts) against a fake docker and a
 * fake Supabase CLI: the lifecycle (start → status → health → stop with
 * --no-backup and the workdir gone, also when the run or the start fails),
 * port blocks, the concurrency queue, the janitor, and what it says when
 * Docker or the CLI is missing. The real stack is exercised by hand (see
 * docs/creative-quality.md §2b); nothing here needs Docker.
 */

const FIX = join(import.meta.dir, "fixtures", "dotty-migrations");
const CLI = "/fake/bin/supabase";
// Built from parts: no real key, and not the CLI's well-known local key.
const ANON = ["eyJfake", "anon", "local"].join(".");
const SERVICE = ["eyJfake", "service", "local"].join(".");

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "day2-eph-root-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const dotty = (): MigrationFile[] => {
  const r = mkdtempSync(join(tmpdir(), "day2-eph-repo-"));
  mkdirSync(join(r, "supabase"), { recursive: true });
  require("node:fs").cpSync(FIX, join(r, "supabase", "migrations"), { recursive: true });
  return readMigrations(r);
};

type Fake = { deps: EphemeralDeps; cmds: string[][]; startOut: { code: number; out: string } | null; busy: Set<number>; containers: string[]; startGate: Promise<void> | null };

function fake(o: { env?: Record<string, string>; has?: string[]; dockerUp?: boolean; health?: number } = {}): Fake {
  const f: Fake = {
    cmds: [],
    startOut: null,
    busy: new Set(),
    containers: [],
    startGate: null,
    deps: null as unknown as EphemeralDeps,
  };
  const has = new Set(o.has ?? ["docker", "npx"]);
  f.deps = {
    env: { DAY2_SUPABASE_CLI: CLI, PATH: "/usr/bin", SUPABASE_ACCESS_TOKEN: ["sbp", "operator", "x"].join("_"), ...o.env },
    platform: "darwin",
    root,
    timeouts: { health: 50 },
    has: (b) => has.has(b),
    portFree: async (p) => !f.busy.has(p),
    sleep: async () => undefined,
    fetch: (async () => new Response("{}", { status: o.health ?? 200 })) as unknown as typeof fetch,
    run: async (cmd, opts) => {
      f.cmds.push(cmd);
      // The CLI and docker never see day2's own tokens.
      expect(Object.keys(opts.env)).not.toContain("SUPABASE_ACCESS_TOKEN");
      if (cmd[0] === "docker" && cmd[1] === "info") return { code: o.dockerUp === false ? 1 : 0, stdout: "29.0.0", stderr: "" };
      if (cmd[0] === "docker" && cmd[1] === "ps" && cmd.includes("--format")) return { code: 0, stdout: f.containers.join("\n"), stderr: "" };
      if (cmd[0] === "docker" && cmd[1] === "ps") return { code: 0, stdout: "c1 c2", stderr: "" };
      if (cmd[0] === "docker" && (cmd[1] === "volume" || cmd[1] === "network") && cmd[2] === "ls" && cmd.includes("-q")) return { code: 0, stdout: `${cmd[1]}1`, stderr: "" };
      if (cmd[0] === CLI && cmd[1] === "start") {
        if (f.startGate) await f.startGate;
        return f.startOut ? { code: f.startOut.code, stdout: f.startOut.out, stderr: "" } : { code: 0, stdout: "Started supabase local development setup.", stderr: "" };
      }
      if (cmd[0] === CLI && cmd[1] === "status") return { code: 0, stdout: JSON.stringify({ API_URL: "http://127.0.0.1:1", ANON_KEY: ANON, SERVICE_ROLE_KEY: SERVICE, DB_URL: "postgresql://postgres:postgres@127.0.0.1:2/postgres" }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return f;
}
const ops = (f: Fake) => f.cmds.map((c) => (c[0] === CLI ? `cli ${c[1]}` : `docker ${c[1]}${c[2] && !c[2].startsWith("-") ? ` ${c[2]}` : ""}`));

describe("the workdir and config", () => {
  test("config.toml: its own project id and ports, the app's schemas exposed, sign-ups off, extras off", () => {
    const ports = { api: 55400, db: 55401, shadow: 55402, studio: 55403, smtp: 55404, analytics: 55405, pooler: 55406, inspector: 55407 };
    const toml = stackConfigToml({ projectId: "day2cap-abc-123456", ports, schemas: ["public", "dotty", "auth", "storage", "bad;schema"], majorVersion: null });
    expect(toml).toContain('project_id = "day2cap-abc-123456"');
    expect(toml).toContain('schemas = ["public", "graphql_public", "dotty"]');
    expect(toml).toContain("port = 55400");
    expect(toml).toContain("shadow_port = 55402");
    expect(toml).toContain("major_version = 17");
    expect(toml.match(/enable_signup = false/g)).toHaveLength(2);
    for (const sec of ["[studio]", "[realtime]", "[local_smtp]", "[edge_runtime]", "[analytics]", "[db.pooler]", "[db.seed]"]) expect(toml.slice(toml.indexOf(sec)).split("\n")[1]).toBe("enabled = false");
    expect(toml).not.toContain("bad;schema");
  });

  test("the workdir has day2's config and a copy of each migration with the preamble — nothing else of the app", () => {
    const files = dotty();
    const ports = { api: 1, db: 2, shadow: 3, studio: 4, smtp: 5, analytics: 6, pooler: 7, inspector: 8 };
    const dir = prepareWorkdir({ root, projectId: "day2cap-test-000001", ports, files, schemas: ["dotty"], majorVersion: 15 });
    expect(readdirSync(join(dir, "supabase")).sort()).toEqual(["config.toml", "migrations"]);
    expect(readdirSync(join(dir, "supabase", "migrations")).sort()).toEqual(files.map((f) => f.file).sort());
    const first = readFileSync(join(dir, "supabase", "migrations", files[0]!.file), "utf-8");
    expect(first.startsWith("SET check_function_bodies = off;")).toBe(true);
    expect(first).toContain(files[0]!.sql.slice(0, 40));
    expect(readFileSync(join(dir, "supabase", "config.toml"), "utf-8")).toContain("major_version = 15");
  });

  test("project ids carry their time; only day2cap- ids parse", () => {
    const now = new Date("2026-11-08T10:00:00Z");
    const id = newProjectId(now);
    expect(id.startsWith(STACK_PREFIX)).toBe(true);
    expect(projectIdTime(id)).toBe(now.getTime());
    expect(projectIdTime("dotty")).toBeNull();
  });

  test("status JSON and start failures are read the way day2 reports them", () => {
    expect(parseStatus(`Stopped services: [studio]\n${JSON.stringify({ API_URL: "http://127.0.0.1:9", PUBLISHABLE_KEY: "p", SECRET_KEY: "s" })}`)).toEqual({ apiUrl: "http://127.0.0.1:9", anonKey: "p", serviceKey: "s" });
    expect(parseStatus("nope")).toEqual({ apiUrl: null, anonKey: null, serviceKey: null });
    const m = startFailure("Applying migration 20261024150000_dotty_init.sql...\nApplying migration 20261025110000_dotty_chats.sql...\nERROR: type \"geography\" does not exist (SQLSTATE 42704)");
    expect(m).toMatchObject({ code: "migration", migration: "20261025110000_dotty_chats.sql" });
    expect(m.message).toContain("geography");
    expect(startFailure("failed to pull image public.ecr.aws/supabase/postgres: Forbidden").message).toContain("couldn't download Supabase's images");
    expect(startFailure("Bind for 0.0.0.0:55400 failed: port is already allocated").code).toBe("busy");
    expect(startFailure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock").code).toBe("no_docker");
  });
});

describe("what this machine needs", () => {
  test("no docker, docker not running, no CLI: needs attention with install hints", async () => {
    expect(await ephemeralSupport(fake({ has: ["npx"] }).deps)).toMatchObject({ ok: false, code: "no_docker", hints: [expect.stringContaining("Docker Desktop")] });
    expect(await ephemeralSupport({ ...fake({ has: ["npx"] }).deps, platform: "linux" })).toMatchObject({ ok: false, hints: [expect.stringContaining("Docker Engine")] });
    expect(await ephemeralSupport(fake({ dockerUp: false }).deps)).toMatchObject({ ok: false, code: "no_docker", why: expect.stringContaining("not running") });
    const noCli = fake({ has: ["docker"], env: { DAY2_SUPABASE_CLI: "" } });
    expect(await ephemeralSupport(noCli.deps)).toMatchObject({ ok: false, code: "no_cli", hints: [expect.stringContaining("brew install supabase/tap/supabase")] });
    // The pinned CLI through npx by default.
    const pinned = fake({ env: { DAY2_SUPABASE_CLI: "" } });
    expect(await ephemeralSupport(pinned.deps)).toEqual({ ok: true, cli: ["npx", "--yes", expect.stringMatching(/^supabase@\d+\.\d+\.\d+$/)] });
    const reqs = await requirements(fake({ has: ["npx"] }).deps, { eas: true });
    expect(reqs.map((r) => `${r.id}:${r.ok}`)).toEqual(["docker:false", "supabase_cli:true", "cloudflared:false"]);
    expect(reqs[2]!.hint).toContain("brew install cloudflared");
    await expect(openStack({ files: dotty(), schemas: [] }, fake({ has: [] }).deps)).rejects.toMatchObject({ code: "no_docker" });
  });
});

describe("the lifecycle", () => {
  test("start (without the extras) → status → healthy → run → stop --no-backup, workdir gone; keys only in memory", async () => {
    const f = fake();
    let seen: { url: string; dir: string } | null = null;
    const r = await withStack(
      { files: dotty(), schemas: ["dotty"] },
      async (s) => {
        seen = { url: s.apiUrl, dir: s.dir };
        expect(existsSync(join(s.dir, "supabase", "config.toml"))).toBe(true);
        expect(s.anonKey).toBe(ANON);
        expect(activeStacks()).toContain(s.projectId);
        return "ok";
      },
      f.deps,
    );
    expect(r).toBe("ok");
    expect(ops(f)).toEqual(["docker info", "docker ps", "docker volume ls", "cli start", "cli status", "cli stop"]);
    const start = f.cmds.find((c) => c[1] === "start")!;
    expect(start[start.indexOf("-x") + 1]!.split(",")).toEqual(EXCLUDED_SERVICES);
    expect(EXCLUDED_SERVICES).toEqual(expect.arrayContaining(["studio", "mailpit", "edge-runtime", "imgproxy", "logflare", "vector", "supavisor"]));
    expect(f.cmds.find((c) => c[1] === "stop")).toContain("--no-backup");
    expect(seen!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(existsSync(seen!.dir)).toBe(false);
    expect(activeStacks()).toEqual([]);
    expect(ephemeralQueue().running).toBe(0);
  });

  test("the run fails: the stack is still stopped and removed", async () => {
    const f = fake();
    let dir = "";
    await expect(
      withStack({ files: dotty(), schemas: [] }, async (s) => {
        dir = s.dir;
        throw new Error("the flow broke");
      }, f.deps),
    ).rejects.toThrow("the flow broke");
    expect(ops(f).at(-1)).toBe("cli stop");
    expect(existsSync(dir)).toBe(false);
    expect(ephemeralQueue().running).toBe(0);
  });

  test("a migration that doesn't apply: says which, stops what started, removes the workdir", async () => {
    const f = fake();
    f.startOut = { code: 1, out: "Applying migration 20261024150000_dotty_init.sql...\nERROR: function st_point does not exist (SQLSTATE 42883)" };
    const err = (await openStack({ files: dotty(), schemas: [] }, f.deps).catch((e) => e)) as EphemeralError;
    expect(err).toMatchObject({ code: "migration", migration: "20261024150000_dotty_init.sql" });
    expect(ops(f).at(-1)).toBe("cli stop");
    expect(readdirSync(root).filter((n) => n.startsWith(STACK_PREFIX) && !n.includes("test"))).toEqual([]);
  });

  test("stop fails: the janitor's docker removal by label runs instead; the keys never reach an error", async () => {
    const f = fake({ health: 503 });
    const base = f.deps.run;
    f.deps.run = async (cmd, o) => (cmd[1] === "stop" ? { code: 1, stdout: "", stderr: "boom" } : base(cmd, o));
    f.deps.fetch = (async () => {
      throw new Error(`refused for ${SERVICE}`);
    }) as unknown as typeof fetch;
    const err = (await openStack({ files: dotty(), schemas: [] }, f.deps).catch((e) => e)) as EphemeralError;
    expect(err.code).toBe("health");
    expect(err.message).not.toContain(SERVICE);
    expect(ops(f)).toContain("docker rm");
    expect(f.cmds.find((c) => c[1] === "rm")).toEqual(["docker", "rm", "-f", "-v", "c1", "c2"]);
  });
});

describe("ports and the queue", () => {
  test("a block with a busy port is skipped; concurrent stacks get different blocks", async () => {
    const f = fake({ env: { DAY2_EPHEMERAL_PORT_BASE: "56000" } });
    f.busy.add(56003);
    const a = await allocatePorts(f.deps);
    const b = await allocatePorts(f.deps);
    expect(a.ports.api).toBe(56010);
    expect(b.ports.api).toBe(56020);
    expect(new Set(Object.values(a.ports)).size).toBe(8);
    a.release();
    b.release();
    expect((await allocatePorts(f.deps)).ports.api).toBe(56010);
  });

  test("at most DAY2_EPHEMERAL_MAX stacks at once; the next waits in line and starts when one closes", async () => {
    const f = fake({ env: { DAY2_EPHEMERAL_MAX: "1" } });
    const s1 = await openStack({ files: dotty(), schemas: [] }, f.deps);
    let second = false;
    const p2 = openStack({ files: dotty(), schemas: [] }, f.deps).then((s) => ((second = true), s));
    await Bun.sleep(20);
    expect(second).toBe(false);
    expect(ephemeralQueue(f.deps.env)).toEqual({ running: 1, waiting: 1, max: 1 });
    await s1.close();
    const s2 = await p2;
    expect(second).toBe(true);
    expect(s2.ports.api).toBe(s1.ports.api);
    await s2.close();
    await s2.close(); // idempotent
    expect(ephemeralQueue(f.deps.env)).toEqual({ running: 0, waiting: 0, max: 1 });
    expect(f.cmds.filter((c) => c[1] === "stop")).toHaveLength(2);
  });

  test("a slot that never frees: the wait ends with a clear error", async () => {
    const env = { DAY2_EPHEMERAL_MAX: "1" };
    const hold = await acquireSlot({ env });
    await expect(acquireSlot({ env }, 10)).rejects.toMatchObject({ code: "busy" });
    hold();
    expect(ephemeralQueue(env)).toMatchObject({ running: 0, waiting: 0 });
  });
});

describe("the janitor", () => {
  test("removes day2 stacks older than two hours (containers, volumes, network, workdir) — never fresh ones or other projects", async () => {
    const f = fake();
    const now = new Date("2026-11-08T12:00:00Z");
    const old = newProjectId(new Date(now.getTime() - 3 * 3600_000));
    const fresh = newProjectId(new Date(now.getTime() - 10 * 60_000));
    f.containers = [old, old, fresh, "dotty", "day2cap-notatime"];
    mkdirSync(join(root, old), { recursive: true });
    mkdirSync(join(root, fresh), { recursive: true });
    const removed = await janitor({ ...f.deps, now: () => now });
    expect(removed).toEqual([old]);
    const filters = f.cmds.filter((c) => c.includes("--filter")).map((c) => c[c.indexOf("--filter") + 1]);
    expect(filters).toContain(`label=com.supabase.cli.project=${old}`);
    expect(filters.some((x) => x?.endsWith(`=${fresh}`) || x?.endsWith("=dotty"))).toBe(false);
    expect(ops(f)).toEqual(expect.arrayContaining(["docker rm", "docker volume rm", "docker network rm"]));
    expect(existsSync(join(root, old))).toBe(false);
    expect(existsSync(join(root, fresh))).toBe(true);
    rmSync(join(root, fresh), { recursive: true, force: true });
  });
});

void introspectMigrations;
