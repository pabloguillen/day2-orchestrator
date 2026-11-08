import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCastDraft } from "../creative/demo-cast/generate";
import { CAST_VERSION, type DemoCast } from "../creative/demo-cast/schema";
import { assertDemoTarget, deleteDemoBackend, demoClient, demoPreamble, demoSupport, demoView, ensureDemoBackend, isLimitError, markMigrationsChanged, migrationsFingerprint, pauseDemo, productionRefs, type DemoClient, type DemoDeps } from "./demo";
import { readMigrations } from "./migrations";
import { introspectMigrations, parseColumn, statements } from "./schema-introspect";
import { expandSeedPlan, heuristicSeedPlan, validateSeedPlan } from "./seed-plan";
import { makeKit } from "./test-kit";
import { emptyState } from "./types";

/**
 * The demo backend (hosting/demo.ts) and its seed plan, against Dotty's
 * real migrations (fixtures/dotty-migrations, copied from the test app):
 * the schema read from the migrations, the plan checked against it, the
 * guard that refuses anything but the demo project day2 created, and the
 * whole setup against a fake Supabase and a fake demo project.
 */

const FIX = join(import.meta.dir, "fixtures", "dotty-migrations");
// Built from parts so no scanner mistakes it for a real ref or key.
const LIVE_REF = ["xpmsqdipsp", "hzeytmaypf"].join("");

const prevKey = process.env.DAY2_SECRETS_KEY;
beforeAll(() => {
  process.env.DAY2_SECRETS_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.DAY2_SECRETS_KEY;
  else process.env.DAY2_SECRETS_KEY = prevKey;
});

function dottyRepo(): string {
  const r = mkdtempSync(join(tmpdir(), "day2-dotty-"));
  mkdirSync(join(r, "supabase", "migrations"), { recursive: true });
  cpSync(FIX, join(r, "supabase", "migrations"), { recursive: true });
  mkdirSync(join(r, "src", "config"), { recursive: true });
  writeFileSync(join(r, "package.json"), JSON.stringify({ dependencies: { expo: "54.0.0", "react-native": "0.81.0", "@supabase/supabase-js": "2.0.0" } }));
  writeFileSync(join(r, "app.json"), JSON.stringify({ expo: { name: "Dotty", version: "1.0.2", ios: { bundleIdentifier: "de.example.dotty" } } }));
  writeFileSync(join(r, "src", "config", "supabase.ts"), `export const SUPABASE_URL = 'https://${LIVE_REF}.supabase.co';\n`);
  return r;
}

function cast(seed = 7, status: DemoCast["status"] = "approved"): DemoCast {
  const d = fakeCastDraft({ language: "de", seed });
  const img = (f: string) => ({ assetId: `as_${f}`, file: f, source: "generated" as const, aiGenerated: true, aiPerson: true, tool: "OpenAI Images" });
  const pic = join(mkdtempSync(join(tmpdir(), "day2-pic-")), "p.jpg");
  writeFileSync(pic, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  return { version: CAST_VERSION, appId: "app_h", language: "de", locale: "de-DE", createdAt: "2026-11-08T10:00:00Z", generator: "fake", seed, status, approvedAt: null, approvedBy: null, images: { source: "generated", note: "" }, ...d, people: d.people.map((p) => ({ ...p, avatar: img(pic) })), moments: d.moments.map((m) => ({ ...m, photo: img(pic) })) };
}

type Call = { op: string; args: unknown[] };
function fakeDemo(): { client: DemoClient; calls: Call[]; keys: string[] } {
  const calls: Call[] = [];
  const keys: string[] = [];
  const users = new Map<string, string>();
  let n = 0;
  return {
    calls,
    keys,
    client: {
      async createUser(o) {
        calls.push({ op: "createUser", args: [o.email] });
        const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        users.set(o.email, id);
        return { id };
      },
      async findUser(email) {
        return users.has(email) ? { id: users.get(email)! } : null;
      },
      async deleteUser(id) {
        calls.push({ op: "deleteUser", args: [id] });
        for (const [e, v] of users) if (v === id) users.delete(e);
      },
      async insert(table, rows) {
        calls.push({ op: "insert", args: [table, rows.length, rows] });
      },
      async remove(table, column, values) {
        calls.push({ op: "remove", args: [table, column, values.length] });
      },
      async upload(bucket, path) {
        calls.push({ op: "upload", args: [bucket, path] });
      },
    },
  };
}

function demoKit(o: Parameters<typeof makeKit>[0] = {}) {
  const k = makeKit({ repo: dottyRepo(), ...o });
  const demo = fakeDemo();
  const deps: DemoDeps = { ...k.deps, demoClient: (_url, key) => (demo.keys.push(key), demo.client), planner: null };
  return { ...k, demo, deps };
}

describe("the schema, read from Dotty's migrations", () => {
  const schema = introspectMigrations(readMigrations(dottyRepo()));

  test("tables in the dotty schema with columns, required fields, defaults, generated columns, references, checks and RLS", () => {
    const p = schema.tables["dotty.profiles"]!;
    expect(p.rls).toBe(true);
    expect(p.primaryKey).toEqual(["id"]);
    expect(p.columns.id).toMatchObject({ type: "uuid", notNull: true, references: { table: "auth.users" } });
    expect(p.columns.username!.pattern).toBe("^[a-z0-9._]{3,20}$");
    expect(p.columns.invited_by!.references!.table).toBe("dotty.profiles"); // added by a later ALTER TABLE
    expect(schema.tables["dotty.places"]!.columns.geog!.generated).toBe(true);
    expect(schema.tables["dotty.places"]!.columns.source!.allowed).toEqual(["osm", "user"]);
    expect(schema.tables["dotty.moments"]!.columns.caption!.maxLength).toBe(80);
    expect(schema.tables["dotty.friendships"]!.primaryKey).toEqual(["requester", "addressee"]);
    expect(schema.tables["dotty.notifications"]!.columns.id!.identity).toBe(true);
    expect(schema.schemas).toContain("dotty");
    expect(schema.buckets).toEqual([
      { id: "dotty-moments", public: false },
      { id: "dotty-avatars", public: true },
    ]);
  });

  test("function bodies, comments and quoted semicolons don't confuse it", () => {
    expect(statements("create function f() returns int as $$ select 1; create table x (a int); $$ language sql; -- create table y (b int);\ncreate table z (c text default 'a;b');")).toHaveLength(2);
    expect(parseColumn("geog public.geography(Point, 4326) generated always as (st_point(lon, lat)) stored")).toMatchObject({ type: "public.geography(point, 4326)", generated: true });
    expect(parseColumn("id bigint generated always as identity primary key")).toMatchObject({ identity: true, hasDefault: true, notNull: true });
  });

  test("the built-in planner maps the cast onto profiles, friendships, places, moments, reactions, comments — and the avatar/moment buckets", () => {
    const { plan, problems } = heuristicSeedPlan(schema);
    expect(problems).toEqual([]);
    expect(plan!.steps.map((s) => `${s.table}:${s.for}`)).toEqual(["dotty.profiles:people", "dotty.friendships:friendships", "dotty.places:places", "dotty.moments:moments", "dotty.reactions:reactions", "dotty.comments:comments"]);
    expect(plan!.steps[2]!.columns.source).toBe("user");
    expect(plan!.steps[2]!.columns).not.toHaveProperty("geog");
    expect(plan!.uploads.map((u) => u.bucket)).toEqual(["dotty-avatars", "dotty-moments"]);
  });

  test("a plan is refused when it doesn't fit the schema", () => {
    const bad = (steps: unknown[], uploads: unknown[] = []) => validateSeedPlan({ steps, uploads }, schema).problems.join(" | ");
    expect(bad([{ table: "dotty.nope", for: "people", columns: {} }])).toContain("no such table");
    expect(bad([{ table: "auth.users", for: "people", columns: {} }])).toContain("no such table");
    expect(bad([{ table: "dotty.profiles", for: "people", columns: { id: { id: true } } }])).toContain("dotty.profiles.username is required");
    expect(bad([{ table: "dotty.profiles", for: "people", columns: { id: { id: true }, username: { field: "username" }, shoe: 1 } }])).toContain("dotty.profiles.shoe: no such column");
    expect(bad([{ table: "dotty.places", for: "places", columns: { name: { field: "name" }, source: "user", lat: { field: "lat" }, lon: { field: "lon" }, geog: "x" } }])).toContain("generated by the database");
    expect(bad([{ table: "dotty.places", for: "places", columns: { name: { field: "name" }, source: "mars", lat: { field: "lat" }, lon: { field: "lon" } } }])).toContain("must be one of osm, user");
    expect(bad([{ table: "dotty.moments", for: "moments", columns: { user_id: { ref: "person" }, place_id: { ref: "place" }, photo_path: "x", lat: 1, lon: 1 } }])).toContain("points at dotty.profiles, which the plan fills later");
    expect(bad([{ table: "dotty.profiles", for: "people", columns: { id: { ref: "moment" }, username: { field: "username" } } }])).toContain('people have no reference "moment"');
    expect(bad([{ table: "dotty.profiles", for: "people", columns: { id: "11111111-1111-4111-8111-111111111111", username: { field: "username" } } }])).toContain("only a person's id goes there");
    expect(bad([{ table: "dotty.profiles", for: "people", columns: { id: { id: true }, username: { field: "username" }, avatar_path: { image: "avatar" } } }])).toContain("no upload rule");
    expect(bad([{ table: "dotty.profiles", for: "people", columns: { id: { id: true }, username: { field: "username" } } }], [{ for: "people", image: "avatar", bucket: "secret-bucket", path: "../{owner}" }])).toMatch(/isn't created by the migrations.*may use letters/);
  });

  test("rows from the plan: auth users' ids for people, stable ids for the rest, times from minutesAgo, storage paths", () => {
    const { plan } = heuristicSeedPlan(schema);
    const c = cast();
    const ids = Object.fromEntries(c.people.map((p, i) => [p.key, `00000000-0000-4000-8000-00000000000${i}`]));
    const rows = expandSeedPlan(plan!, c, ids, schema, new Date("2026-11-08T12:00:00Z"));
    expect(rows.skipped).toEqual([]);
    const moments = rows.inserts.find((i) => i.table === "dotty.moments")!.rows;
    expect(moments).toHaveLength(c.moments.length);
    expect(moments[0]!.user_id).toBe(ids[c.moments[0]!.person]);
    expect(moments[0]!.created_at).toBe(new Date(Date.parse("2026-11-08T12:00:00Z") - c.moments[0]!.minutesAgo * 60_000).toISOString());
    expect(String(moments[0]!.photo_path)).toBe(`${ids[c.moments[0]!.person]}/${moments[0]!.id}.jpg`);
    expect(rows.uploads.filter((u) => u.bucket === "dotty-avatars")).toHaveLength(c.people.length);
    // Same cast, same ids (re-seeding is idempotent).
    expect(expandSeedPlan(plan!, c, ids, schema, new Date()).inserts.find((i) => i.table === "dotty.moments")!.rows[0]!.id).toBe(moments[0]!.id);
  });

  test("the demo preamble turns off function body checks and adds PostGIS when public.geography is used without it", () => {
    const pre = demoPreamble(readdirSync(FIX).map((f) => ({ version: "1", name: f, file: f, sql: readFileSync(join(FIX, f), "utf-8") })));
    expect(pre).toContain("SET check_function_bodies = off;");
    expect(pre).toContain("CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;");
  });
});

describe("the guard: day2 never seeds anything but its own demo project", () => {
  const state = () => ({ ...emptyState(), demo: { createdBy: "day2-demo" as const, ref: "refdemo0000000000001", name: "dotty-apph-demo", orgSlug: "day2-apps", region: "eu-central-1" as const, url: "https://refdemo0000000000001.supabase.co", publishableKey: null, createdAt: "", status: "ACTIVE_HEALTHY" as const, done: [], working: null, migrations: { applied: 0, total: 0, failed: null }, plan: null, seededAt: null, castSeed: null, rows: 0, uploads: 0, seeded: { users: [], rows: [] }, pausedAt: null, problem: null, log: [] } });

  test("the recorded demo project passes; any other ref, the live project, a hosted environment or a mismatched URL is refused", () => {
    expect(assertDemoTarget(state(), "refdemo0000000000001", [LIVE_REF]).name).toBe("dotty-apph-demo");
    expect(() => assertDemoTarget(state(), LIVE_REF, [LIVE_REF])).toThrow(/isn't the demo project/);
    expect(() => assertDemoTarget({ ...emptyState() }, "refdemo0000000000001", [])).toThrow(/only fills a demo project it created/);
    expect(() => assertDemoTarget(state(), "refdemo0000000000001", ["refdemo0000000000001"])).toThrow(/the one the app itself uses/);
    const hosted = state();
    hosted.projects.production = { ref: "refdemo0000000000001" } as never;
    expect(() => assertDemoTarget(hosted, "refdemo0000000000001", [])).toThrow(/hosted environments/);
    const moved = state();
    moved.demo.url = `https://${LIVE_REF}.supabase.co`;
    expect(() => assertDemoTarget(moved, "refdemo0000000000001", [])).toThrow(/address doesn't match/);
    const renamed = state();
    renamed.demo.name = "dotty-prod";
    expect(() => assertDemoTarget(renamed, "refdemo0000000000001", [])).toThrow(/isn't named as one/);
  });

  test("the app's live project ref is found in its repo", () => {
    expect(productionRefs(dottyRepo())).toEqual([LIVE_REF]);
  });

  test("only Supabase apps with migrations are supported; others get the upload fallback", () => {
    expect(demoSupport(dottyRepo())).toMatchObject({ ok: true, migrations: readdirSync(FIX).length });
    const other = mkdtempSync(join(tmpdir(), "day2-fb-"));
    writeFileSync(join(other, "package.json"), JSON.stringify({ dependencies: { firebase: "1" } }));
    expect(demoSupport(other)).toMatchObject({ ok: false, why: expect.stringContaining("Upload 3–8 screenshots") });
  });
});

describe("ensureDemoBackend", () => {
  test("creates a separate demo project in day2's organization, applies the migrations, exposes the app schema, creates users and seeds the approved cast", async () => {
    const k = demoKit();
    const c = cast();
    const d = await ensureDemoBackend(k.app, c, k.deps);
    expect(d.name).toBe("habit-loop-apph-demo");
    expect(d.ref).not.toBe(LIVE_REF);
    const create = k.fake.calls.find((x) => x.op === "createProject")!;
    expect(create.args[0]).toMatchObject({ name: "habit-loop-apph-demo", organization_slug: "day2-apps", db_pass: "[set]" });
    expect(k.fake.calls.find((x) => x.op === "updateAuthConfig")!.args[1]).toEqual(["disable_signup", "mailer_autoconfirm"]);
    expect(k.fake.postgrest.get(d.ref)).toContain("dotty");
    const migs = k.fake.sql.filter((x) => x.ref === d.ref && x.query.includes("INSERT INTO supabase_migrations.schema_migrations"));
    expect(migs).toHaveLength(readdirSync(FIX).length);
    expect(migs[0]!.query.startsWith("SET check_function_bodies = off;")).toBe(true);
    // Users: one per person; the demo login is stored encrypted.
    expect(k.demo.calls.filter((x) => x.op === "createUser")).toHaveLength(c.people.length);
    const login = await k.deps.secrets.get<{ email: string; password: string }>(k.app.id, "demo_login");
    expect(login!.email).toMatch(/^demo-.*@example\.com$/);
    expect(login!.password.length).toBeGreaterThan(20);
    // Rows go to the demo project with the demo project's own secret key.
    expect(k.demo.keys.every((x) => x === `sb_secret_${d.ref}_TOPSECRET`)).toBe(true);
    expect(k.demo.calls.filter((x) => x.op === "insert").map((x) => x.args[0])).toEqual(["dotty.profiles", "dotty.friendships", "dotty.places", "dotty.moments", "dotty.reactions", "dotty.comments"]);
    expect(k.demo.calls.filter((x) => x.op === "upload")).toHaveLength(c.people.length + c.moments.length);
    expect(d.seededAt).not.toBeNull();
    // Nothing secret in the state the console reads.
    const view = JSON.stringify(demoView((await k.deps.store.state(k.app.id)).demo));
    expect(view).not.toContain("TOPSECRET");
    expect(view).not.toContain(login!.password);
    expect(JSON.stringify(await k.deps.store.state(k.app.id))).not.toContain(login!.password);
    // Calling again does nothing new.
    const before = k.demo.calls.length;
    await ensureDemoBackend(k.app, c, k.deps);
    expect(k.demo.calls.length).toBe(before);
  });

  test("a new cast replaces the old demo rows and users", async () => {
    const k = demoKit();
    await ensureDemoBackend(k.app, cast(7), k.deps);
    await ensureDemoBackend(k.app, cast(8), k.deps);
    expect(k.demo.calls.filter((x) => x.op === "remove").length).toBeGreaterThan(0);
    expect(k.demo.calls.filter((x) => x.op === "deleteUser").length).toBeGreaterThanOrEqual(8);
    expect((await k.deps.store.state(k.app.id)).demo!.castSeed).toBe(8);
  });

  test("refuses a cast that isn't approved, an unsupported app, and stops before writing when the project was renamed on Supabase", async () => {
    const k = demoKit();
    await expect(ensureDemoBackend(k.app, cast(7, "draft"), k.deps)).rejects.toThrow(/Approve the demo cast/);
    const fb = mkdtempSync(join(tmpdir(), "day2-fb-"));
    writeFileSync(join(fb, "package.json"), "{}");
    await expect(ensureDemoBackend({ ...k.app, repoPath: fb }, cast(), k.deps)).rejects.toThrow(/Demo backends work for Supabase apps/);
    await ensureDemoBackend(k.app, cast(), k.deps);
    const ref = (await k.deps.store.state(k.app.id)).demo!.ref;
    k.fake.projects.get(ref)!.name = "someone-elses-project";
    await expect(ensureDemoBackend(k.app, cast(9), k.deps)).rejects.toThrow(/name or organization changed/);
  });

  test("a full Free organization: a clear message, no project created", async () => {
    const k = demoKit({ fake: { orgPlan: "free" } });
    k.fake.projects.set("a", { ref: "a", name: "x", region: "eu-central-1", org: "day2-apps", polls: 9, status: "ACTIVE_HEALTHY", paused: false });
    k.fake.projects.set("b", { ref: "b", name: "y", region: "eu-central-1", org: "day2-apps", polls: 9, status: "ACTIVE_HEALTHY", paused: false });
    await expect(ensureDemoBackend(k.app, cast(), k.deps)).rejects.toThrow(/Free plan allows 2 active projects.*Pause or delete a project/);
    expect(k.fake.calls.some((x) => x.op === "createProject")).toBe(false);
    const k2 = demoKit({ fake: { createFails: { status: 400, message: "The maximum limit of free projects has been reached" } } });
    await expect(ensureDemoBackend(k2.app, cast(), k2.deps)).rejects.toMatchObject({ code: "limit" });
  });

  test("without day2's Supabase organization it says what's missing", async () => {
    const k = demoKit({ operator: null });
    await expect(ensureDemoBackend(k.app, cast(), k.deps)).rejects.toThrow(/SUPABASE_ACCESS_TOKEN/);
  });

  test("changed migrations: only the new one is applied (the paused project woken first by the caller); a failing one says which", async () => {
    const k = demoKit();
    const fp = migrationsFingerprint(k.app.repoPath);
    await ensureDemoBackend(k.app, cast(), k.deps);
    expect(await markMigrationsChanged(k.app, k.deps)).toBe(true);
    writeFileSync(join(k.app.repoPath, "supabase/migrations/29990101000000_badges.sql"), "create table dotty.badges (id uuid primary key);\n");
    expect(migrationsFingerprint(k.app.repoPath)).not.toBe(fp);
    const before = k.fake.sql.filter((x) => x.query.includes("INSERT INTO supabase_migrations.schema_migrations")).length;
    const d = await ensureDemoBackend(k.app, cast(), k.deps);
    expect(k.fake.sql.filter((x) => x.query.includes("INSERT INTO supabase_migrations.schema_migrations")).length).toBe(before + 1);
    expect(d.migrations).toMatchObject({ applied: readdirSync(FIX).length + 1, failed: null });
    const k2 = demoKit({ fake: { failSql: /boom_table/ } });
    await ensureDemoBackend(k2.app, cast(), k2.deps);
    writeFileSync(join(k2.app.repoPath, "supabase/migrations/29990102000000_boom.sql"), "create table dotty.boom_table (id uuid);\n");
    await markMigrationsChanged(k2.app, k2.deps);
    await expect(ensureDemoBackend(k2.app, cast(), k2.deps)).rejects.toMatchObject({ code: "migration" });
    expect((await k2.deps.store.state(k2.app.id)).demo!.migrations.failed).toMatchObject({ file: "29990102000000_boom.sql" });
  });

  test("deleting the demo project: only day2's own (guard + Supabase asked first); the demo secrets go; already gone is fine", async () => {
    const k = demoKit();
    expect(await deleteDemoBackend(k.app, k.deps)).toEqual({ deleted: null });
    await ensureDemoBackend(k.app, cast(), k.deps);
    const ref = (await k.deps.store.state(k.app.id)).demo!.ref;
    k.fake.projects.get(ref)!.name = "someone-elses-project";
    await expect(deleteDemoBackend(k.app, k.deps)).rejects.toThrow(/name or organization changed/);
    expect(k.fake.calls.some((x) => x.op === "deleteProject")).toBe(false);
    k.fake.projects.get(ref)!.name = (await k.deps.store.state(k.app.id)).demo!.name;
    expect(await deleteDemoBackend(k.app, k.deps)).toEqual({ deleted: ref });
    expect(k.fake.projects.has(ref)).toBe(false);
    expect(await k.deps.secrets.get(k.app.id, "secret_key:demo")).toBeNull();
    expect(await k.deps.secrets.get(k.app.id, "demo_login")).toBeNull();
    expect((await k.deps.store.state(k.app.id)).demo).toBeNull();
    // Gone on Supabase already: the record is dropped all the same.
    const k2 = demoKit();
    await ensureDemoBackend(k2.app, cast(), k2.deps);
    k2.fake.projects.clear();
    expect((await deleteDemoBackend(k2.app, k2.deps)).deleted).toBeTruthy();
    expect(isLimitError(new Error("The maximum limit of free projects has been reached"))).toBe(true);
    expect(isLimitError(new Error("syntax error"))).toBe(false);
  });

  test("pausing after a capture goes through the guard too", async () => {
    const k = demoKit();
    await ensureDemoBackend(k.app, cast(), k.deps);
    await pauseDemo(k.app, k.deps);
    expect(k.fake.calls.some((x) => x.op === "pause")).toBe(true);
    expect(demoView((await k.deps.store.state(k.app.id)).demo)!.state).toBe("paused");
  });
});

describe("the demo project's client", () => {
  test("REST inserts as JSON with the app schema's profile header, storage uploads, and the key never in an error", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const key = ["sb", "secret", "demokey123456"].join("_");
    const f = (async (u: string, init?: RequestInit) => {
      seen.push({ url: u, headers: init?.headers as Record<string, string>, body: init?.body });
      if (u.includes("/fail")) return new Response(`bad ${key}`, { status: 400 });
      return new Response("", { status: 201 });
    }) as typeof fetch;
    const c = demoClient("https://refdemo0000000000001.supabase.co", key, f);
    await c.insert("dotty.moments", [{ id: "x", caption: "'); drop table x; --" }]);
    expect(seen[0]!.url).toBe("https://refdemo0000000000001.supabase.co/rest/v1/moments");
    expect(seen[0]!.headers).toMatchObject({ apikey: key, "content-profile": "dotty", prefer: "resolution=ignore-duplicates,return=minimal" });
    expect(JSON.parse(String(seen[0]!.body))[0].caption).toBe("'); drop table x; --");
    await c.upload("dotty-avatars", "u1/avatar.jpg", new Uint8Array([1]), "image/jpeg");
    expect(seen[1]!.url).toBe("https://refdemo0000000000001.supabase.co/storage/v1/object/dotty-avatars/u1/avatar.jpg");
    const err = await c.insert("public.fail", [{ a: 1 }]).catch((e: Error) => e.message);
    expect(err).not.toContain(key);
    expect(err).toContain("[key]");
  });
});
