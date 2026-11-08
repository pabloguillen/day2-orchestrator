import type { MigrationFile } from "./migrations";

/**
 * The app's database shape, read from its migration files (no database
 * needed): tables per schema with their columns (type, required, default,
 * generated, references, simple checks), primary keys, row level security,
 * and the storage buckets the migrations create. Good enough to check a
 * demo seed plan against before anything is sent — not a full SQL parser:
 * it follows CREATE TABLE, ALTER TABLE (add/drop/rename column, rename
 * table, NOT NULL, defaults, RLS, primary/foreign keys), DROP TABLE and
 * INSERT INTO storage.buckets, and ignores function bodies.
 */

export type ColumnInfo = {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  /** GENERATED ALWAYS AS (…) STORED, or an identity column: never inserted. */
  generated: boolean;
  identity: boolean;
  references: { table: string; column: string | null } | null;
  /** `col in ('a','b')` checks. */
  allowed: string[] | null;
  /** `col ~ '…'` checks. */
  pattern: string | null;
  /** `char_length(col) <= n` / `between a and n` checks. */
  maxLength: number | null;
};

export type TableInfo = { name: string; schema: string; table: string; columns: Record<string, ColumnInfo>; primaryKey: string[]; rls: boolean };
export type AppSchema = { tables: Record<string, TableInfo>; buckets: Array<{ id: string; public: boolean }>; schemas: string[] };

/** Schemas a seed plan may never write to. */
export const RESERVED_SCHEMAS = ["auth", "storage", "realtime", "supabase_functions", "supabase_migrations", "extensions", "vault", "net", "cron", "graphql", "graphql_public", "pgsodium", "pgbouncer", "information_schema", "pg_catalog"];

const ident = (s: string) => s.trim().replace(/"/g, "").toLowerCase();
function qualify(name: string): { full: string; schema: string; table: string } {
  const n = ident(name);
  const [schema, table] = n.includes(".") ? (n.split(".") as [string, string]) : ["public", n];
  return { full: `${schema}.${table}`, schema, table };
}

/** Pure. SQL without comments and function bodies, split into statements. */
export function statements(sql: string): string[] {
  let s = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''");
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!q && ch === "-" && s[i + 1] === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      cur += " ";
      continue;
    }
    if (q) {
      cur += ch;
      if (ch === q) {
        if (s[i + 1] === q) cur += s[++i]!;
        else q = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Pure. Splits on commas that aren't inside parentheses or quotes. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The text between the first "(" at or after `from` and its matching ")". */
function parenBody(s: string, from = 0): { body: string; end: number } | null {
  const start = s.indexOf("(", from);
  if (start === -1) return null;
  let depth = 0;
  let q: string | null = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'") q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return { body: s.slice(start + 1, i), end: i };
  }
  return null;
}

const STOP = /^(not|null|default|primary|references|unique|check|generated|constraint|collate)$/i;
const NAME = String.raw`((?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?)`;

/** Pure. One column definition ("name type … constraints"). */
export function parseColumn(def: string): ColumnInfo | null {
  const m = /^\s*("[^"]+"|\w+)\s+([\s\S]+)$/.exec(def);
  if (!m) return null;
  const name = ident(m[1]!);
  const rest = m[2]!;
  // The type: words until a constraint keyword, with parentheses kept whole.
  let type = "";
  let i = 0;
  while (i < rest.length) {
    const word = /^\s*([\w."\[\]]+)/.exec(rest.slice(i));
    if (!word) break;
    if (STOP.test(word[1]!) && type) break;
    type += (type ? " " : "") + word[1]!;
    i += word[0].length;
    if (rest[i] === "(") {
      const b = parenBody(rest, i);
      if (!b) break;
      type += `(${b.body})`;
      i = b.end + 1;
      if (rest.slice(i, i + 2) === "[]") {
        type += "[]";
        i += 2;
      }
    }
  }
  const tail = rest.slice(i);
  const low = tail.toLowerCase();
  const identity = /generated\s+(always|by\s+default)\s+as\s+identity/.test(low) || /^(big|small)?serial$/i.test(type);
  const generated = /generated\s+always\s+as\s*\(/.test(low) || /generated\s+always\s+as\s+identity/.test(low);
  const ref = new RegExp(String.raw`references\s+${NAME}\s*(?:\(\s*("?\w+"?)\s*\))?`, "i").exec(tail);
  const inList = new RegExp(String.raw`check\s*\(\s*"?${name}"?\s+in\s*\(([^)]*)\)`, "i").exec(tail);
  const pattern = new RegExp(String.raw`check\s*\(\s*"?${name}"?\s*~\s*'((?:[^']|'')*)'`, "i").exec(tail);
  const len = new RegExp(String.raw`char_length\s*\(\s*"?${name}"?\s*\)\s*(?:<=\s*(\d+)|between\s+\d+\s+and\s+(\d+))`, "i").exec(tail);
  return {
    name,
    type: type.toLowerCase(),
    notNull: /\bnot\s+null\b/.test(low) || /\bprimary\s+key\b/.test(low),
    hasDefault: /\bdefault\b/.test(low) || identity,
    generated,
    identity,
    references: ref ? { table: qualify(ref[1]!).full, column: ref[2] ? ident(ref[2]) : null } : null,
    allowed: inList ? [...inList[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]!.replace(/''/g, "'")) : null,
    pattern: pattern ? pattern[1]!.replace(/''/g, "'") : null,
    maxLength: len ? Number(len[1] ?? len[2]) : null,
  };
}

function applyTableConstraint(t: TableInfo, item: string): boolean {
  const low = item.toLowerCase().replace(/^constraint\s+("[^"]+"|\w+)\s+/, "");
  if (low.startsWith("primary key")) {
    const b = parenBody(item);
    if (b) {
      t.primaryKey = b.body.split(",").map(ident);
      for (const c of t.primaryKey) if (t.columns[c]) t.columns[c]!.notNull = true;
    }
    return true;
  }
  if (low.startsWith("foreign key")) {
    const cols = parenBody(item);
    const ref = new RegExp(String.raw`references\s+${NAME}\s*(?:\(([^)]*)\))?`, "i").exec(item);
    if (cols && ref) {
      const targets = (ref[2] ?? "").split(",").map(ident);
      cols.body.split(",").map(ident).forEach((c, k) => {
        if (t.columns[c]) t.columns[c]!.references = { table: qualify(ref[1]!).full, column: targets[k] || null };
      });
    }
    return true;
  }
  if (/^(unique|check|exclude)\b/.test(low)) {
    const inList = /^check\s*\(\s*"?(\w+)"?\s+in\s*\(([^)]*)\)/i.exec(low);
    if (inList && t.columns[inList[1]!]) t.columns[inList[1]!]!.allowed = [...inList[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]!);
    return true;
  }
  return false;
}

/** Pure. The schema after every migration, in order. */
export function introspectMigrations(files: MigrationFile[]): AppSchema {
  const tables: Record<string, TableInfo> = {};
  const buckets = new Map<string, boolean>();
  const schemas = new Set<string>(["public"]);
  for (const f of files) {
    for (const st of statements(f.sql)) {
      const low = st.toLowerCase().replace(/\s+/g, " ");
      let m: RegExpExecArray | null;
      if ((m = /^create schema (?:if not exists )?("?\w+"?)/i.exec(st))) schemas.add(ident(m[1]!));
      else if ((m = new RegExp(String.raw`^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*\(`, "i").exec(st))) {
        const q = qualify(m[1]!);
        if (tables[q.full] && /if not exists/.test(low)) continue;
        const body = parenBody(st, m[0].length - 1);
        if (!body) continue;
        const t: TableInfo = { name: q.full, schema: q.schema, table: q.table, columns: {}, primaryKey: [], rls: false };
        const items = splitTop(body.body);
        for (const item of items) {
          if (/^(constraint|primary\s+key|foreign\s+key|unique|check|exclude)\b/i.test(item)) continue;
          const c = parseColumn(item);
          if (c) {
            t.columns[c.name] = c;
            if (/\bprimary\s+key\b/i.test(item)) t.primaryKey = [c.name];
          }
        }
        for (const item of items) if (/^(constraint|primary\s+key|foreign\s+key|unique|check|exclude)\b/i.test(item)) applyTableConstraint(t, item);
        tables[q.full] = t;
        schemas.add(q.schema);
      } else if ((m = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+([\s\S]*)$`, "i").exec(st))) {
        const q = qualify(m[1]!);
        const t = tables[q.full];
        const actions = m[2]!;
        if (!t) continue;
        const rename = /^rename\s+to\s+("?\w+"?)/i.exec(actions.trim());
        if (rename) {
          delete tables[q.full];
          const n = qualify(`${q.schema}.${ident(rename[1]!)}`);
          tables[n.full] = { ...t, name: n.full, table: n.table };
          continue;
        }
        for (const a of splitTop(actions)) {
          let x: RegExpExecArray | null;
          if (/^enable\s+row\s+level\s+security/i.test(a)) t.rls = true;
          else if (/^disable\s+row\s+level\s+security/i.test(a)) t.rls = false;
          else if ((x = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(a)) && !/^add\s+(constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(a)) {
            const c = parseColumn(x[1]!);
            if (c && !t.columns[c.name]) t.columns[c.name] = c;
          } else if ((x = /^add\s+([\s\S]+)$/i.exec(a))) applyTableConstraint(t, x[1]!);
          else if ((x = /^drop\s+column\s+(?:if\s+exists\s+)?("?\w+"?)/i.exec(a))) delete t.columns[ident(x[1]!)];
          else if ((x = /^rename\s+(?:column\s+)?("?\w+"?)\s+to\s+("?\w+"?)/i.exec(a))) {
            const from = ident(x[1]!);
            const c = t.columns[from];
            if (c) {
              delete t.columns[from];
              t.columns[ident(x[2]!)] = { ...c, name: ident(x[2]!) };
            }
          } else if ((x = /^alter\s+(?:column\s+)?("?\w+"?)\s+([\s\S]+)$/i.exec(a))) {
            const c = t.columns[ident(x[1]!)];
            const what = x[2]!.toLowerCase();
            if (!c) continue;
            if (/^set\s+not\s+null/.test(what)) c.notNull = true;
            else if (/^drop\s+not\s+null/.test(what)) c.notNull = false;
            else if (/^set\s+default/.test(what)) c.hasDefault = true;
            else if (/^drop\s+default/.test(what)) c.hasDefault = c.identity;
            else if (/^(set\s+data\s+)?type\s+/.test(what)) c.type = what.replace(/^(set\s+data\s+)?type\s+/, "").split(/\s+using\s+/)[0]!.trim();
            else if (/^add\s+generated/.test(what)) {
              c.identity = true;
              c.hasDefault = true;
            }
          }
        }
      } else if ((m = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+cascade|\s+restrict)?$/i.exec(st))) {
        for (const n of m[1]!.split(",")) delete tables[qualify(n).full];
      } else if (/^insert\s+into\s+storage\.buckets\b/i.test(st)) {
        const cols = parenBody(st);
        const vi = st.toLowerCase().indexOf("values");
        if (!cols || vi === -1) continue;
        const names = cols.body.split(",").map(ident);
        const idAt = names.indexOf("id");
        const pubAt = names.indexOf("public");
        let from = vi;
        for (;;) {
          const tuple = parenBody(st, from);
          if (!tuple || /on\s+conflict/i.test(st.slice(from, st.indexOf("(", from)))) break;
          const vals = splitTop(tuple.body);
          const id = /^'([^']+)'$/.exec((vals[idAt === -1 ? 0 : idAt] ?? "").trim())?.[1];
          if (id) buckets.set(id, /true/i.test(vals[pubAt] ?? ""));
          from = tuple.end + 1;
        }
      }
    }
  }
  return { tables, buckets: [...buckets.entries()].map(([id, pub]) => ({ id, public: pub })), schemas: [...schemas] };
}

/** Pure. A short, model-readable summary of the schema (for the seed planner). */
export function schemaSummary(s: AppSchema): string {
  const lines: string[] = [];
  for (const t of Object.values(s.tables)) {
    if (RESERVED_SCHEMAS.includes(t.schema)) continue;
    const cols = Object.values(t.columns).map((c) => `${c.name} ${c.type}${c.notNull && !c.hasDefault ? " REQUIRED" : ""}${c.generated || c.identity ? " (auto)" : c.hasDefault ? " (default)" : ""}${c.references ? ` → ${c.references.table}` : ""}${c.allowed ? ` in [${c.allowed.join("|")}]` : ""}${c.pattern ? ` ~ /${c.pattern}/` : ""}${c.maxLength ? ` ≤${c.maxLength} chars` : ""}`);
    lines.push(`${t.name}${t.rls ? " [RLS]" : " [no RLS]"} pk(${t.primaryKey.join(",")}): ${cols.join("; ")}`);
  }
  lines.push(`storage buckets: ${s.buckets.map((b) => `${b.id}${b.public ? " (public)" : " (private)"}`).join(", ") || "none"}`);
  return lines.join("\n");
}
