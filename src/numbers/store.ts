import type { SQL } from "bun";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { db } from "../db";
import { serverMode } from "../tenant";
import { normalizeDoc, NUMBERS_FILENAME, trimDoc, type NumbersDoc } from "./types";

/**
 * Where the Numbers cache lives: day2-numbers.json in the app's folder
 * (local mode) or the `numbers_cache` table (accounts mode, migration 018).
 * `update` runs one change at a time per app.
 */

export interface NumbersStore {
  load(appId: string): Promise<NumbersDoc>;
  update<T>(appId: string, fn: (d: NumbersDoc) => { doc: NumbersDoc; result: T } | Promise<{ doc: NumbersDoc; result: T }>): Promise<T>;
}

const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

export function fileNumbersStore(dirFor: (appId: string) => string): NumbersStore {
  const read = (p: string): NumbersDoc => {
    try {
      return normalizeDoc(existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null);
    } catch {
      return normalizeDoc(null);
    }
  };
  return {
    async load(appId) {
      return read(join(dirFor(appId), NUMBERS_FILENAME));
    },
    update(appId, fn) {
      const path = join(dirFor(appId), NUMBERS_FILENAME);
      return serial(path, async () => {
        const out = await fn(read(path));
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(trimDoc(out.doc, new Date()))}\n`);
        renameSync(tmp, path);
        return out.result;
      });
    },
  };
}

export function dbNumbersStore(sql: SQL): NumbersStore {
  const parse = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);
  return {
    async load(appId) {
      const [r] = (await sql`SELECT doc FROM numbers_cache WHERE app_id = ${appId}`) as Array<{ doc: unknown }>;
      return normalizeDoc(r ? parse(r.doc) : null);
    },
    update(appId, fn) {
      return serial(`db:${appId}`, () =>
        sql.begin(async (tx) => {
          const [r] = (await tx`SELECT doc FROM numbers_cache WHERE app_id = ${appId} FOR UPDATE`) as Array<{ doc: unknown }>;
          const out = await fn(normalizeDoc(r ? parse(r.doc) : null));
          const doc = JSON.stringify(trimDoc(out.doc, new Date()));
          await tx`INSERT INTO numbers_cache (app_id, doc) VALUES (${appId}, ${doc}::jsonb)
                   ON CONFLICT (app_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`;
          return out.result;
        }),
      );
    },
  };
}

/** The store for an app in this server's mode. */
export function numbersStoreFor(app: AppEntry): NumbersStore {
  return serverMode() === "accounts" ? dbNumbersStore(db()) : fileNumbersStore(() => app.repoPath);
}
