import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCastDraft } from "../creative/demo-cast/generate";
import { CAST_VERSION, type DemoCast } from "../creative/demo-cast/schema";
import { assertDemoTarget, deleteDemoBackend, demoClient, demoSupport, productionRefs, retireLegacyDemo } from "./demo";
import { migrationPreamble } from "./ephemeral";
import { readMigrations } from "./migrations";
import { introspectMigrations, parseColumn, statements } from "./schema-introspect";
import { expandSeedPlan, heuristicSeedPlan, validateSeedPlan } from "./seed-plan";
import { makeKit } from "./test-kit";
import { emptyState } from "./types";

/**
 * Demo data (hosting/demo.ts) and its seed plan, against Dotty's real
 * migrations (fixtures/dotty-migrations, copied from the test app): the
 * schema read from the migrations, the plan checked against it, the client
 * a temporary database is seeded through, and the one-time removal of an
 * old standing demo project through the guard (fake Supabase).
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

/** An old-design demo project: created on the fake Supabase and recorded in the app's hosting state, as ensureDemoBackend used to. */
async function legacyDemo(k: ReturnType<typeof makeKit>) {
  const name = "habit-loop-apph-demo";
  const p = await k.fake.api("x").createProject({ name, organization_slug: "day2-apps", db_pass: "x", region: "eu-central-1" });
  await k.deps.secrets.set(k.app.id, "demo_login", { email: "demo-x@example.com", password: ["old", "pass", "word"].join("-") }, "Demo account (screens)");
  await k.deps.store.update(k.app.id, (s) => {
    s.demo = { createdBy: "day2-demo", ref: p.ref, name, orgSlug: "day2-apps", region: "eu-central-1", url: `https://${p.ref}.supabase.co`, publishableKey: null, createdAt: "2026-11-01T00:00:00Z", status: "ACTIVE_HEALTHY", done: ["project"], working: null, migrations: { applied: 28, total: 28, failed: null }, plan: null, seededAt: null, castSeed: null, rows: 0, uploads: 0, seeded: { users: [], rows: [] }, pausedAt: null, problem: null, log: [] };
  });
  return p.ref;
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

  test("the migration preamble turns off function body checks and adds PostGIS when public.geography is used without it", () => {
    const pre = migrationPreamble(readdirSync(FIX).map((f) => ({ version: "1", name: f, file: f, sql: readFileSync(join(FIX, f), "utf-8") })));
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

describe("the one-time removal of an old standing demo project", () => {
  test("no record: nothing to do; a recorded day2 demo project is deleted through the guard, the record and old secrets dropped", async () => {
    const k = makeKit({ repo: dottyRepo() });
    expect(await retireLegacyDemo(k.app, k.deps)).toEqual({ state: "none", note: null });
    const ref = await legacyDemo(k);
    const r = await retireLegacyDemo(k.app, k.deps);
    expect(r.state).toBe("deleted");
    expect(r.note).toContain("temporary database");
    expect(k.fake.calls.filter((x) => x.op === "deleteProject")).toHaveLength(1);
    expect(k.fake.projects.has(ref)).toBe(false);
    expect((await k.deps.store.state(k.app.id)).demo).toBeNull();
    expect(await k.deps.secrets.get(k.app.id, "demo_login")).toBeNull();
    expect(await retireLegacyDemo(k.app, k.deps)).toEqual({ state: "none", note: null });
  });

  test("the guard still decides: renamed on Supabase → not deleted, only forgotten; without the organization configured → kept with a note", async () => {
    const k = makeKit({ repo: dottyRepo() });
    const ref = await legacyDemo(k);
    k.fake.projects.get(ref)!.name = "someone-elses-project";
    const r = await retireLegacyDemo(k.app, k.deps);
    expect(r.state).toBe("forgotten");
    expect(k.fake.calls.some((x) => x.op === "deleteProject")).toBe(false);
    expect(k.fake.projects.has(ref)).toBe(true);
    expect((await k.deps.store.state(k.app.id)).demo).toBeNull();
    const k2 = makeKit({ repo: dottyRepo(), operator: null });
    await legacyDemo(k2);
    const r2 = await retireLegacyDemo(k2.app, k2.deps);
    expect(r2).toMatchObject({ state: "kept", note: expect.stringContaining("SUPABASE_ACCESS_TOKEN") });
    expect((await k2.deps.store.state(k2.app.id)).demo).toBeTruthy();
  });

  test("deleteDemoBackend: already gone on Supabase counts as deleted; Supabase down keeps the record for the next try", async () => {
    const k = makeKit({ repo: dottyRepo() });
    expect(await deleteDemoBackend(k.app, k.deps)).toEqual({ deleted: null });
    await legacyDemo(k);
    k.fake.projects.clear();
    expect((await deleteDemoBackend(k.app, k.deps)).deleted).toBeTruthy();
    const k2 = makeKit({ repo: dottyRepo() });
    await legacyDemo(k2);
    const real = k2.deps.api;
    k2.deps.api = (tok) => ({ ...real(tok), deleteProject: async () => Promise.reject(new Error("Supabase DELETE: 503 unavailable")) });
    expect(await retireLegacyDemo(k2.app, k2.deps)).toMatchObject({ state: "kept", note: expect.stringContaining("503") });
    expect((await k2.deps.store.state(k2.app.id)).demo).toBeTruthy();
  });
});

describe("the demo database's client", () => {
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
