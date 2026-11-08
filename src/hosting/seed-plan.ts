import { castUuid, type DemoCast } from "../creative/demo-cast/schema";
import { RESERVED_SCHEMAS, schemaSummary, type AppSchema, type ColumnInfo, type TableInfo } from "./schema-introspect";

/**
 * A demo seed plan: how an app's demo cast maps onto the app's own tables,
 * as DATA — per table, which cast entity fills it and, per column, which of
 * the entity's fields, ids or references goes in. Written by a model that
 * reads the app's schema (from its migrations) or by the built-in
 * heuristic; checked against that schema before anything runs; then turned
 * into plain rows that are sent as JSON to the demo project's REST API
 * (parameterized by design — no SQL is ever built from it).
 */

export const PLAN_VERSION = 1;
export const PLAN_MARKER = "DEMO_SEED_PLAN_JSON:";
export const MAX_ROWS = 600;

export const ENTITIES = {
  people: { fields: ["displayName", "username", "age", "city", "bio"], refs: [] as string[], time: false },
  friendships: { fields: ["status"], refs: ["a", "b"], time: false },
  places: { fields: ["name", "category", "district", "city", "lat", "lon"], refs: [], time: false },
  moments: { fields: ["caption", "visibility", "lat", "lon"], refs: ["person", "place"], time: true },
  reactions: { fields: [], refs: ["moment", "person"], time: true },
  comments: { fields: ["text"], refs: ["moment", "person"], time: true },
  leaderboard: { fields: ["points"], refs: ["person"], time: false },
} as const;
export type EntityKind = keyof typeof ENTITIES;
export const isEntity = (v: unknown): v is EntityKind => typeof v === "string" && v in ENTITIES;

export type SeedValue = string | number | boolean | null | { field: string } | { id: true } | { ref: string } | { time: true } | { image: "avatar" | "photo"; of?: string };
export type SeedStep = { table: string; for: EntityKind; columns: Record<string, SeedValue>; only?: { status: "accepted" | "pending" } };
export type SeedUpload = { for: "people" | "moments"; image: "avatar" | "photo"; bucket: string; path: string; alsoAt?: string[] };
export type SeedPlan = { version: typeof PLAN_VERSION; source: "model" | "heuristic"; steps: SeedStep[]; uploads: SeedUpload[]; notes: string[] };

// ---------------------------------------------------------------- checking

const TYPE = (c: ColumnInfo) => (/uuid/.test(c.type) ? "uuid" : /time|date/.test(c.type) ? "time" : /bool/.test(c.type) ? "bool" : /int|serial|numeric|real|double|float|decimal/.test(c.type) ? "number" : /json/.test(c.type) ? "json" : /text|char|citext|varchar/.test(c.type) ? "text" : "other");
const FIELD_TYPE: Record<string, "text" | "number"> = { displayName: "text", username: "text", age: "number", city: "text", bio: "text", status: "text", name: "text", category: "text", district: "text", lat: "number", lon: "number", caption: "text", visibility: "text", text: "text", points: "number" };
const PATH = /^[\w{}.\-/]{1,120}$/;

function valueProblem(v: SeedValue, step: SeedStep, col: ColumnInfo, plan: SeedPlan): string | null {
  const e = ENTITIES[step.for];
  const t = TYPE(col);
  const where = `${step.table}.${col.name}`;
  if (v === null) return col.notNull && !col.hasDefault ? `${where} is required` : null;
  if (typeof v === "string") return v.length > 200 ? `${where}: a literal is at most 200 characters` : col.allowed && !col.allowed.includes(v) ? `${where} must be one of ${col.allowed.join(", ")}` : t === "number" || t === "bool" ? `${where} isn't text` : null;
  if (typeof v === "number") return t === "number" ? null : `${where} isn't a number`;
  if (typeof v === "boolean") return t === "bool" ? null : `${where} isn't true/false`;
  if (typeof v !== "object") return `${where}: unknown value`;
  if ("field" in v) {
    if (!(e.fields as readonly string[]).includes(v.field)) return `${where}: ${step.for} have no field "${v.field}" (they have ${e.fields.join(", ") || "none"})`;
    const ft = FIELD_TYPE[v.field];
    if (ft === "number" && t !== "number") return `${where}: ${v.field} is a number`;
    if (ft === "text" && !(t === "text" || t === "other")) return `${where}: ${v.field} is text`;
    return null;
  }
  if ("id" in v) return t === "uuid" || t === "text" ? null : `${where}: an id is a uuid`;
  if ("ref" in v) return (e.refs as readonly string[]).includes(v.ref) ? (t === "uuid" || t === "text" ? null : `${where}: a reference is a uuid`) : `${where}: ${step.for} have no reference "${v.ref}" (they have ${e.refs.join(", ") || "none"})`;
  if ("time" in v) return t === "time" ? null : `${where}: a time goes in a timestamp column`;
  if ("image" in v) {
    const of: EntityKind = v.of === "person" ? "people" : step.for;
    if (!plan.uploads.some((u) => u.image === v.image && u.for === of)) return `${where}: no upload rule for the ${v.image}`;
    return t === "text" ? null : `${where}: an image path is text`;
  }
  return `${where}: unknown value`;
}

/**
 * Pure. What's wrong with a plan for this schema: tables and columns that
 * don't exist or may not be written (other schemas, generated columns),
 * required columns left out, values that don't fit the column, references
 * the entity doesn't have, a table filled before the table it points at,
 * uploads to buckets the migrations don't create.
 */
export function validateSeedPlan(raw: unknown, schema: AppSchema): { plan: SeedPlan | null; problems: string[] } {
  const problems: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const uploads: SeedUpload[] = [];
  for (const u of Array.isArray(o.uploads) ? (o.uploads as Array<Record<string, unknown>>).slice(0, 4) : []) {
    const bucket = String(u?.bucket ?? "");
    const path = String(u?.path ?? "");
    if (u?.for !== "people" && u?.for !== "moments") {
      problems.push(`upload: "for" is people or moments`);
      continue;
    }
    if (u.image !== "avatar" && u.image !== "photo") {
      problems.push(`upload: "image" is avatar or photo`);
      continue;
    }
    if (!schema.buckets.some((b) => b.id === bucket)) problems.push(`upload: bucket "${bucket}" isn't created by the migrations (${schema.buckets.map((b) => b.id).join(", ") || "none"})`);
    if (!PATH.test(path) || path.includes("..") || path.startsWith("/")) problems.push(`upload: path "${path}" may use letters, digits, - _ . / and {owner} {id} {key}`);
    const alsoAt = Array.isArray(u.alsoAt) ? (u.alsoAt as unknown[]).map(String).filter((s) => /^[\w.-]{1,20}$/.test(s)).slice(0, 2) : [];
    uploads.push({ for: u.for, image: u.image, bucket, path, ...(alsoAt.length ? { alsoAt } : {}) });
  }
  const plan: SeedPlan = { version: PLAN_VERSION, source: o.source === "model" ? "model" : "heuristic", steps: [], uploads, notes: Array.isArray(o.notes) ? (o.notes as unknown[]).map(String).slice(0, 6) : [] };
  const steps = Array.isArray(o.steps) ? (o.steps as Array<Record<string, unknown>>) : [];
  if (!steps.length) problems.push("the plan fills no table");
  const filled: string[] = [];
  for (const s of steps.slice(0, 20)) {
    const table = String(s?.table ?? "").toLowerCase();
    const full = table.includes(".") ? table : `public.${table}`;
    const t: TableInfo | undefined = schema.tables[full];
    if (!isEntity(s?.for)) {
      problems.push(`${table}: "for" must be one of ${Object.keys(ENTITIES).join(", ")}`);
      continue;
    }
    if (!t) {
      problems.push(`${table}: no such table in the migrations`);
      continue;
    }
    if (RESERVED_SCHEMAS.includes(t.schema)) {
      problems.push(`${table}: day2 never writes to the ${t.schema} schema`);
      continue;
    }
    const step: SeedStep = { table: full, for: s.for, columns: {}, ...(s.only && typeof s.only === "object" && ((s.only as { status?: string }).status === "accepted" || (s.only as { status?: string }).status === "pending") ? { only: { status: (s.only as { status: "accepted" | "pending" }).status } } : {}) };
    const cols = (s.columns && typeof s.columns === "object" ? s.columns : {}) as Record<string, SeedValue>;
    for (const [name, v] of Object.entries(cols)) {
      const c = t.columns[name.toLowerCase()];
      if (!c) {
        problems.push(`${full}.${name}: no such column`);
        continue;
      }
      if (c.generated) {
        problems.push(`${full}.${name} is generated by the database`);
        continue;
      }
      const p = valueProblem(v, step, c, plan);
      if (p) problems.push(p);
      else step.columns[c.name] = v;
      // A column that points at another app table: that table must be filled first.
      if (c.references && !RESERVED_SCHEMAS.includes(c.references.table.split(".")[0]!) && c.references.table !== full && v !== null && !filled.includes(c.references.table)) problems.push(`${full}.${name} points at ${c.references.table}, which the plan fills later or not at all`);
      if (c.references?.table === "auth.users" && !(typeof v === "object" && v && (("id" in v && step.for === "people") || ("ref" in v && ["person", "a", "b"].includes(v.ref))))) problems.push(`${full}.${name} points at auth.users: only a person's id goes there`);
    }
    for (const c of Object.values(t.columns)) if (c.notNull && !c.hasDefault && !c.generated && !(c.name in step.columns)) problems.push(`${full}.${c.name} is required but the plan doesn't fill it`);
    plan.steps.push(step);
    filled.push(full);
  }
  if (plan.steps.length && !plan.steps.some((s) => s.for === "people")) problems.push("the plan must fill the table of the app's users (for: people)");
  return { plan: problems.length ? null : plan, problems };
}

// ---------------------------------------------------------------- the built-in planner

const pickCol = (t: TableInfo, ...res: RegExp[]) => {
  for (const re of res) {
    const c = Object.values(t.columns).find((x) => re.test(x.name) && !x.generated);
    if (c) return c;
  }
  return undefined;
};
const refsTo = (t: TableInfo, target: string) => Object.values(t.columns).filter((c) => c.references?.table === target);

/** Pure. A plan from table and column names alone (the fallback when no model can write one). */
export function heuristicSeedPlan(schema: AppSchema): { plan: SeedPlan | null; problems: string[] } {
  const app = Object.values(schema.tables).filter((t) => !RESERVED_SCHEMAS.includes(t.schema));
  const steps: SeedStep[] = [];
  const uploads: SeedUpload[] = [];
  const notes: string[] = [];
  const people = app.find((t) => refsTo(t, "auth.users").some((c) => t.primaryKey.includes(c.name))) ?? app.find((t) => /profile|user|member|account/.test(t.table) && refsTo(t, "auth.users").length);
  if (!people) return { plan: null, problems: ["no table of the app's users (one whose id points at auth.users) in the migrations"] };
  const avatarBucket = schema.buckets.find((b) => /avatar|profile/.test(b.id)) ?? null;
  const photoBucket = schema.buckets.find((b) => /moment|photo|post|image|picture|media|upload/.test(b.id) && b.id !== avatarBucket?.id) ?? null;
  const fill = (t: TableInfo, kind: EntityKind, map: Record<string, SeedValue>) => {
    for (const c of Object.values(t.columns)) if (c.notNull && !c.hasDefault && !c.generated && !(c.name in map) && c.allowed?.length) map[c.name] = c.allowed.includes("user") ? "user" : c.allowed[0]!;
    steps.push({ table: t.name, for: kind, columns: map });
  };
  const pid = refsTo(people, "auth.users")[0]!;
  const pm: Record<string, SeedValue> = { [pid.name]: { id: true } };
  const set = (t: TableInfo, map: Record<string, SeedValue>, v: SeedValue, ...res: RegExp[]) => {
    const c = pickCol(t, ...res);
    if (c && !(c.name in map)) map[c.name] = v;
  };
  set(people, pm, { field: "username" }, /^user_?name$|^handle$|^nick/);
  set(people, pm, { field: "displayName" }, /^display_?name$|^full_?name$|^name$|^first_?name$/);
  set(people, pm, { field: "city" }, /^city$|^home_?city$/);
  set(people, pm, { field: "bio" }, /^bio$|^about$|^description$/);
  if (avatarBucket) {
    const c = pickCol(people, /avatar|photo|picture|image/);
    if (c && TYPE(c) === "text") {
      pm[c.name] = { image: "avatar" };
      uploads.push({ for: "people", image: "avatar", bucket: avatarBucket.id, path: "{owner}/avatar.jpg" });
    }
  }
  fill(people, "people", pm);

  const friends = app.find((t) => t !== people && refsTo(t, people.name).length >= 2 && /friend|follow|connection|buddy/.test(t.table));
  if (friends) {
    const [a, b] = refsTo(friends, people.name);
    const fm: Record<string, SeedValue> = { [a!.name]: { ref: "a" }, [b!.name]: { ref: "b" } };
    const status = pickCol(friends, /^status$|^state$/);
    if (status && (!status.allowed || ["accepted", "pending"].every((x) => status.allowed!.includes(x)))) fm[status.name] = { field: "status" };
    else notes.push(`${friends.name}: no accepted/pending status column — only accepted friendships are added`);
    set(friends, fm, { time: true }, /accepted_at|created_at/);
    if (!(status && fm[status.name])) steps.push({ table: friends.name, for: "friendships", columns: fm, only: { status: "accepted" } });
    else fill(friends, "friendships", fm);
  }
  const places = app.find((t) => /place|venue|location|spot/.test(t.table) && pickCol(t, /^lat/) && pickCol(t, /^(lon|lng)/) && pickCol(t, /^name$/));
  if (places) {
    const m: Record<string, SeedValue> = {};
    const id = pickCol(places, /^id$/);
    if (id) m[id.name] = { id: true };
    set(places, m, { field: "name" }, /^name$/);
    set(places, m, { field: "category" }, /^category$|^type$|^kind$/);
    set(places, m, { field: "district" }, /^district$|^neighbou?rhood$|^area$/);
    set(places, m, { field: "city" }, /^city$/);
    set(places, m, { field: "lat" }, /^lat(itude)?$/);
    set(places, m, { field: "lon" }, /^(lon|lng|longitude)$/);
    fill(places, "places", m);
  }
  const moments = app.find((t) => t !== people && refsTo(t, people.name).length && (places ? refsTo(t, places.name).length : true) && /moment|post|check_?in|story|entr/.test(t.table));
  if (moments) {
    const m: Record<string, SeedValue> = {};
    const id = pickCol(moments, /^id$/);
    if (id) m[id.name] = { id: true };
    m[refsTo(moments, people.name)[0]!.name] = { ref: "person" };
    if (places) m[refsTo(moments, places.name)[0]!.name] = { ref: "place" };
    set(moments, m, { field: "caption" }, /^caption$|^text$|^body$|^note$/);
    const vis = pickCol(moments, /^visibility$/);
    if (vis && (!vis.allowed || ["friends", "public"].every((x) => vis.allowed!.includes(x)))) m[vis.name] = { field: "visibility" };
    set(moments, m, { field: "lat" }, /^lat(itude)?$/);
    set(moments, m, { field: "lon" }, /^(lon|lng|longitude)$/);
    set(moments, m, { time: true }, /^created_at$|^posted_at$/);
    if (photoBucket) {
      const c = pickCol(moments, /photo|image|picture|media/);
      if (c && TYPE(c) === "text") {
        m[c.name] = { image: "photo" };
        uploads.push({ for: "moments", image: "photo", bucket: photoBucket.id, path: "{owner}/{id}.jpg" });
      }
    }
    fill(moments, "moments", m);
    const reactions = app.find((t) => refsTo(t, moments.name).length && refsTo(t, people.name).length && /reaction|like|fire|heart|vote/.test(t.table));
    if (reactions) {
      const r: Record<string, SeedValue> = { [refsTo(reactions, moments.name)[0]!.name]: { ref: "moment" }, [refsTo(reactions, people.name)[0]!.name]: { ref: "person" } };
      set(reactions, r, { time: true }, /^created_at$/);
      fill(reactions, "reactions", r);
    }
    const comments = app.find((t) => refsTo(t, moments.name).length && refsTo(t, people.name).length && /comment|repl/.test(t.table));
    if (comments) {
      const c: Record<string, SeedValue> = { [refsTo(comments, moments.name)[0]!.name]: { ref: "moment" }, [refsTo(comments, people.name)[0]!.name]: { ref: "person" } };
      const id = pickCol(comments, /^id$/);
      if (id) c[id.name] = { id: true };
      set(comments, c, { field: "text" }, /^body$|^text$|^content$|^message$/);
      set(comments, c, { time: true }, /^created_at$/);
      fill(comments, "comments", c);
    }
  }
  const scores = app.find((t) => refsTo(t, people.name).length && /score|point|leader|rank/.test(t.table) && pickCol(t, /points|score/));
  if (scores) fill(scores, "leaderboard", { [refsTo(scores, people.name)[0]!.name]: { ref: "person" }, [pickCol(scores, /points|score/)!.name]: { field: "points" } });
  else notes.push("no leaderboard table: the app works its ranking out from the activity");
  return validateSeedPlan({ version: PLAN_VERSION, source: "heuristic", steps, uploads, notes }, schema);
}

// ---------------------------------------------------------------- the model's plan

export function buildPlanPrompt(schema: AppSchema, appName: string, problems: string[] = []): string {
  return `You map ${appName}'s DEMO CAST (fictional people and their activity) onto the app's own database tables, so a separate demo copy of the backend can be filled. You only write a mapping as JSON — never SQL, never code, never data values beyond short constants.

The app's tables, from its migrations (REQUIRED = must be filled; (auto)/(default) = leave out unless the cast has the value):
${schemaSummary(schema)}

The cast's entities and what each has:
${Object.entries(ENTITIES).map(([k, e]) => `- ${k}: fields ${e.fields.join(", ") || "—"}; references ${e.refs.join(", ") || "—"}${e.time ? "; a time (when it happened)" : ""}`).join("\n")}
(people are the app's users: their id is the auth user day2 creates. friendships have a (who asked) and b; status accepted|pending.)

Column values: a constant (string/number/boolean/null), {"field":"<field>"}, {"id":true} (this entity's id), {"ref":"<reference>"} (the referenced entity's id), {"time":true}, {"image":"avatar"|"photo"} (the storage path of the picture, which needs an "uploads" rule).
Rules: fill the users table first, then tables in the order their references need; only tables that show the activity on screen (skip push tokens, reports, notifications, settings); every REQUIRED column; constants must fit the checks.
Uploads: {"for":"people"|"moments","image":"avatar"|"photo","bucket":"<bucket>","path":"{owner}/{id}.jpg","alsoAt":[".t.jpg"]} — {owner} is the person's id, {id} the entity's; match how the app's code stores files.
${problems.length ? `\nYour last plan was refused for: ${problems.slice(0, 10).join("; ")}.\n` : ""}
End with this marker on its own line, then JSON only:
${PLAN_MARKER}
{"steps":[{"table":"schema.table","for":"people","columns":{"id":{"id":true}}}],"uploads":[],"notes":[]}`;
}

// ---------------------------------------------------------------- rows

export type SeedRows = { inserts: Array<{ table: string; rows: Array<Record<string, unknown>> }>; uploads: Array<{ bucket: string; path: string; file: string | null; entity: string }>; skipped: string[] };

type Ctx = { kind: EntityKind; key: string; id: string; fields: Record<string, unknown>; refs: Record<string, string>; at: string; owner: string; images: Partial<Record<"avatar" | "photo", { file: string | null }>> };

/** Pure. The plan's rows for a cast. `people` ids are the auth users' ids. */
export function expandSeedPlan(plan: SeedPlan, cast: DemoCast, personIds: Record<string, string>, schema: AppSchema, now: Date): SeedRows {
  const id = (kind: string, key: string) => (kind === "people" ? personIds[key]! : castUuid(cast.seed, kind, key));
  const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  const place = new Map(cast.places.map((p) => [p.key, p]));
  const moment = new Map(cast.moments.map((m) => [m.key, m]));
  const ctxs: Record<EntityKind, Ctx[]> = {
    people: cast.people.map((p) => ({ kind: "people", key: p.key, id: id("people", p.key), fields: { displayName: p.displayName, username: p.username, age: p.age, city: p.city, bio: p.bio }, refs: {}, at: ago(14 * 24 * 60), owner: id("people", p.key), images: { avatar: p.avatar ?? undefined } })),
    friendships: cast.friendships.map((f, i) => ({ kind: "friendships", key: `f${i}`, id: castUuid(cast.seed, "friendships", `${f.a}-${f.b}`), fields: { status: f.status }, refs: { a: id("people", f.a), b: id("people", f.b) }, at: ago(9 * 24 * 60), owner: id("people", f.a), images: {} })),
    places: cast.places.map((p) => ({ kind: "places", key: p.key, id: id("places", p.key), fields: { name: p.name, category: p.category, district: p.district, city: p.city, lat: p.lat, lon: p.lon }, refs: {}, at: ago(30 * 24 * 60), owner: "", images: {} })),
    moments: cast.moments.map((m) => ({ kind: "moments", key: m.key, id: id("moments", m.key), fields: { caption: m.caption, visibility: m.visibility, lat: place.get(m.place)?.lat ?? 0, lon: place.get(m.place)?.lon ?? 0 }, refs: { person: id("people", m.person), place: id("places", m.place) }, at: ago(m.minutesAgo), owner: id("people", m.person), images: { photo: m.photo ?? undefined } })),
    reactions: cast.reactions.map((r, i) => ({ kind: "reactions", key: `r${i}`, id: castUuid(cast.seed, "reactions", `${r.moment}-${r.person}`), fields: {}, refs: { moment: id("moments", r.moment), person: id("people", r.person) }, at: ago(Math.max(0, (moment.get(r.moment)?.minutesAgo ?? 1) - 1)), owner: id("people", r.person), images: {} })),
    comments: cast.comments.map((c) => ({ kind: "comments", key: c.key, id: id("comments", c.key), fields: { text: c.text }, refs: { moment: id("moments", c.moment), person: id("people", c.person) }, at: ago(c.minutesAgo), owner: id("people", c.person), images: {} })),
    leaderboard: cast.leaderboard.map((s) => ({ kind: "leaderboard", key: s.person, id: castUuid(cast.seed, "leaderboard", s.person), fields: { points: s.points }, refs: { person: id("people", s.person) }, at: ago(0), owner: id("people", s.person), images: {} })),
  };
  const fill = (tpl: string, c: Ctx) => tpl.replace(/\{owner\}/g, c.owner).replace(/\{id\}/g, c.id).replace(/\{key\}/g, c.key);
  const pathOf = (image: "avatar" | "photo", c: Ctx) => {
    const u = plan.uploads.find((x) => x.image === image && x.for === c.kind);
    return u ? fill(u.path, c) : null;
  };
  const out: SeedRows = { inserts: [], uploads: [], skipped: [] };
  let total = 0;
  for (const step of plan.steps) {
    const t = schema.tables[step.table]!;
    const rows: Array<Record<string, unknown>> = [];
    for (const c of ctxs[step.for]) {
      if (step.only && c.fields.status !== step.only.status) continue;
      const row: Record<string, unknown> = {};
      let bad: string | null = null;
      for (const [col, v] of Object.entries(step.columns)) {
        let val: unknown;
        if (v === null || typeof v !== "object") val = v;
        else if ("field" in v) val = c.fields[v.field];
        else if ("id" in v) val = c.id;
        else if ("ref" in v) val = c.refs[v.ref];
        else if ("time" in v) val = c.at;
        else if ("image" in v) val = pathOf(v.image, c);
        const info = t.columns[col]!;
        if (typeof val === "string") {
          const text: string = val;
          if (info.allowed && !info.allowed.includes(text)) bad = `${col} "${text}" isn't one of ${info.allowed.join(", ")}`;
          if (info.maxLength && text.length > info.maxLength) val = text.slice(0, info.maxLength);
          if (info.pattern) {
            try {
              if (!new RegExp(info.pattern).test(text)) bad = `${col} "${val}" doesn't match the app's pattern`;
            } catch {
              /* a pattern JS can't read: the database checks it */
            }
          }
        }
        if (val === undefined) bad = `${col} has no value`;
        row[col] = val;
      }
      if (bad) {
        out.skipped.push(`${step.table} ${c.key}: ${bad}`);
        continue;
      }
      rows.push(row);
    }
    total += rows.length;
    if (total > MAX_ROWS) throw new Error(`the demo cast would add more than ${MAX_ROWS} rows`);
    out.inserts.push({ table: step.table, rows });
  }
  for (const u of plan.uploads) {
    for (const c of ctxs[u.for]) {
      const img = c.images[u.image];
      if (!img) continue;
      const path = fill(u.path, c);
      out.uploads.push({ bucket: u.bucket, path, file: img.file, entity: c.key });
      for (const s of u.alsoAt ?? []) out.uploads.push({ bucket: u.bucket, path: `${path}${s}`, file: img.file, entity: c.key });
    }
  }
  return out;
}
