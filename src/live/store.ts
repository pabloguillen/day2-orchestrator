import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LiveConfig } from "../../packages/sensors/src/types";
import { normalizeState, type LiveState } from "./types";

/**
 * Where an app's Live document lives: `day2-live.json` in the app's state
 * folder (local mode), or the `live_state` table (accounts mode). Plus the
 * config last served to apps, so an unchanged config keeps its version.
 */

export type Served = { version: number; hash: string; body: LiveConfig };

export interface LiveStore {
  get(appId: string): Promise<LiveState>;
  /** Read, change, write — one app at a time. */
  update<T>(appId: string, fn: (s: LiveState) => { state: LiveState; result: T }): Promise<T>;
  served(appId: string): Promise<Served | null>;
  setServed(appId: string, s: Served): Promise<void>;
}

type FileDoc = { state: LiveState; served: Served | null };

function readDoc(path: string): FileDoc {
  if (!existsSync(path)) return { state: normalizeState(null), served: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<FileDoc> & Partial<LiveState>;
    // The file is the state itself plus a `served` field.
    const { served, ...rest } = raw as { served?: Served | null } & Record<string, unknown>;
    return { state: normalizeState(rest), served: served ?? null };
  } catch {
    return { state: normalizeState(null), served: null };
  }
}

function writeDoc(path: string, d: FileDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...d.state, served: d.served }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** `pathFor` finds the app's `day2-live.json` (null: unknown app → empty state, nothing written). */
export function fileLiveStore(pathFor: (appId: string) => Promise<string | null>): LiveStore {
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
    async get(appId) {
      const p = await pathFor(appId);
      return p ? readDoc(p).state : normalizeState(null);
    },
    update(appId, fn) {
      return serial(appId, async () => {
        const p = await pathFor(appId);
        if (!p) throw new Error(`No Live file for app "${appId}".`);
        const d = readDoc(p);
        const r = fn(d.state);
        writeDoc(p, { ...d, state: r.state });
        return r.result;
      });
    },
    async served(appId) {
      const p = await pathFor(appId);
      return p ? readDoc(p).served : null;
    },
    async setServed(appId, s) {
      await serial(appId, async () => {
        const p = await pathFor(appId);
        if (!p) return;
        const d = readDoc(p);
        writeDoc(p, { ...d, served: s });
      });
    },
  };
}

const parse = <T>(v: T | string): T => (typeof v === "string" ? (JSON.parse(v) as T) : v);

export function dbLiveStore(sql: SQL): LiveStore {
  return {
    async get(appId) {
      const rows = (await sql`SELECT state FROM live_state WHERE app_id = ${appId}`) as Array<{ state: LiveState | string }>;
      return normalizeState(rows[0] ? parse(rows[0].state) : null);
    },
    async update(appId, fn) {
      return sql.begin(async (tx) => {
        await tx`INSERT INTO live_state (app_id, state) VALUES (${appId}, ${normalizeState(null)}::jsonb) ON CONFLICT (app_id) DO NOTHING`;
        const rows = (await tx`SELECT state FROM live_state WHERE app_id = ${appId} FOR UPDATE`) as Array<{ state: LiveState | string }>;
        const r = fn(normalizeState(rows[0] ? parse(rows[0].state) : null));
        await tx`UPDATE live_state SET state = ${r.state}::jsonb, updated_at = now() WHERE app_id = ${appId}`;
        return r.result;
      });
    },
    async served(appId) {
      const rows = (await sql`SELECT version, hash, body FROM live_served WHERE app_id = ${appId}`) as Array<{ version: number; hash: string; body: LiveConfig | string }>;
      return rows[0] ? { version: rows[0].version, hash: rows[0].hash, body: parse(rows[0].body) } : null;
    },
    async setServed(appId, s) {
      await sql`INSERT INTO live_served (app_id, version, hash, body) VALUES (${appId}, ${s.version}, ${s.hash}, ${s.body}::jsonb)
                ON CONFLICT (app_id) DO UPDATE SET version = EXCLUDED.version, hash = EXCLUDED.hash, body = EXCLUDED.body, served_at = now()`;
    },
  };
}
