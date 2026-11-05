import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { markUsed as markUsedPure } from "./core";
import { emptyMemory, normalizeMemory, type MemoryDoc, type MemoryItem, type Purpose } from "./types";

/**
 * Where an app's memory lives: `day2-memory.json` in the app's state folder
 * (local mode), or the `memory_items` / `memory_state` tables (accounts
 * mode, migration 022_memory.sql).
 */
export interface MemoryStore {
  load(appId: string): Promise<MemoryDoc>;
  /** Read, change, write — one app at a time. */
  update<T>(appId: string, fn: (d: MemoryDoc) => { doc: MemoryDoc; result: T }): Promise<T>;
  /** Cheap: stamps items as used (the "used in" hint). */
  markUsed(appId: string, ids: string[], purpose: Purpose, at: Date): Promise<void>;
}

function readDoc(path: string): MemoryDoc {
  if (!existsSync(path)) return emptyMemory();
  try {
    return normalizeMemory(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return emptyMemory();
  }
}

function writeDoc(path: string, d: MemoryDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`);
  renameSync(tmp, path);
}

/** `pathFor` finds the app's `day2-memory.json` (null: unknown app → empty memory, nothing written). */
export function fileMemoryStore(pathFor: (appId: string) => Promise<string | null>): MemoryStore {
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };
  return {
    async load(appId) {
      const p = await pathFor(appId);
      return p ? readDoc(p) : emptyMemory();
    },
    update(appId, fn) {
      return serial(appId, async () => {
        const p = await pathFor(appId);
        if (!p) throw new Error(`No memory file for app "${appId}".`);
        const r = fn(readDoc(p));
        writeDoc(p, r.doc);
        return r.result;
      });
    },
    async markUsed(appId, ids, purpose, at) {
      if (!ids.length) return;
      await serial(appId, async () => {
        const p = await pathFor(appId);
        if (!p || !existsSync(p)) return;
        writeDoc(p, markUsedPure(readDoc(p), ids, purpose, at));
      });
    },
  };
}

type ItemRow = {
  id: string;
  kind: string;
  text: string;
  source_kind: string;
  source_ref: unknown;
  who: string;
  at: Date | string;
  updated_at: Date | string;
  confidence: number;
  status: string;
  supersedes: string | null;
  superseded_by: string | null;
  scope: unknown;
  keys: unknown;
  last_used_at: Date | string | null;
  last_used_for: string | null;
  rule_id: string | null;
};

const parse = <T>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function fromRow(r: ItemRow): MemoryItem {
  return {
    id: r.id,
    kind: r.kind as MemoryItem["kind"],
    text: r.text,
    source: { kind: r.source_kind as MemoryItem["source"]["kind"], ref: parse(r.source_ref, null) },
    who: r.who,
    at: iso(r.at)!,
    updatedAt: iso(r.updated_at)!,
    confidence: Number(r.confidence),
    status: r.status as MemoryItem["status"],
    supersedes: r.supersedes,
    supersededBy: r.superseded_by,
    scope: parse(r.scope, []),
    keys: parse(r.keys, []),
    lastUsedAt: iso(r.last_used_at),
    lastUsedFor: (r.last_used_for as Purpose | null) ?? null,
    ...(r.rule_id ? { ruleId: r.rule_id } : {}),
  };
}

export function dbMemoryStore(sql: SQL): MemoryStore {
  async function read(tx: SQL, appId: string, lock: boolean): Promise<MemoryDoc> {
    const st = (lock
      ? await tx`SELECT inbox, declines, changes, last_capture_at FROM memory_state WHERE app_id = ${appId} FOR UPDATE`
      : await tx`SELECT inbox, declines, changes, last_capture_at FROM memory_state WHERE app_id = ${appId}`) as Array<{ inbox: unknown; declines: unknown; changes: unknown; last_capture_at: Date | string | null }>;
    const rows = (await tx`SELECT * FROM memory_items WHERE app_id = ${appId} ORDER BY at`) as ItemRow[];
    const s = st[0];
    return {
      ...emptyMemory(),
      items: rows.map(fromRow),
      inbox: parse(s?.inbox, []),
      declines: parse(s?.declines, []),
      changes: parse(s?.changes, []),
      lastCaptureAt: s ? iso(s.last_capture_at) : null,
    };
  }
  return {
    async load(appId) {
      return read(sql, appId, false);
    },
    async update(appId, fn) {
      return sql.begin(async (tx) => {
        await tx`INSERT INTO memory_state (app_id) VALUES (${appId}) ON CONFLICT (app_id) DO NOTHING`;
        const before = await read(tx, appId, true);
        const r = fn(before);
        const d = r.doc;
        const old = new Map(before.items.map((i) => [i.id, JSON.stringify(i)]));
        for (const i of d.items) {
          if (old.get(i.id) === JSON.stringify(i)) continue;
          await tx`INSERT INTO memory_items (app_id, id, kind, text, source_kind, source_ref, who, at, updated_at, confidence, status, supersedes, superseded_by, scope, keys, last_used_at, last_used_for, rule_id)
                   VALUES (${appId}, ${i.id}, ${i.kind}, ${i.text}, ${i.source.kind}, ${JSON.stringify(i.source.ref)}::jsonb, ${i.who}, ${i.at}, ${i.updatedAt}, ${i.confidence}, ${i.status}, ${i.supersedes}, ${i.supersededBy ?? null}, ${JSON.stringify(i.scope)}::jsonb, ${JSON.stringify(i.keys)}::jsonb, ${i.lastUsedAt ?? null}, ${i.lastUsedFor ?? null}, ${i.ruleId ?? null})
                   ON CONFLICT (app_id, id) DO UPDATE SET kind = EXCLUDED.kind, text = EXCLUDED.text, source_kind = EXCLUDED.source_kind, source_ref = EXCLUDED.source_ref, who = EXCLUDED.who,
                     updated_at = EXCLUDED.updated_at, confidence = EXCLUDED.confidence, status = EXCLUDED.status, supersedes = EXCLUDED.supersedes, superseded_by = EXCLUDED.superseded_by,
                     scope = EXCLUDED.scope, keys = EXCLUDED.keys, last_used_at = EXCLUDED.last_used_at, last_used_for = EXCLUDED.last_used_for, rule_id = EXCLUDED.rule_id`;
        }
        const keep = new Set(d.items.map((i) => i.id));
        for (const id of old.keys()) if (!keep.has(id)) await tx`DELETE FROM memory_items WHERE app_id = ${appId} AND id = ${id}`;
        await tx`UPDATE memory_state SET inbox = ${JSON.stringify(d.inbox)}::jsonb, declines = ${JSON.stringify(d.declines)}::jsonb, changes = ${JSON.stringify(d.changes)}::jsonb, last_capture_at = ${d.lastCaptureAt}, updated_at = now() WHERE app_id = ${appId}`;
        return r.result;
      });
    },
    async markUsed(appId, ids, purpose, at) {
      if (!ids.length) return;
      await sql`UPDATE memory_items SET last_used_at = ${at.toISOString()}, last_used_for = ${purpose} WHERE app_id = ${appId} AND id IN ${sql(ids)}`;
    },
  };
}
