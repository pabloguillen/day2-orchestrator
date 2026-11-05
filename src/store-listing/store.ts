import type { SQL } from "bun";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { db } from "../db";
import { serverMode } from "../tenant";
import { emptySetup } from "./setup-types";
import { DEFAULT_SETTINGS, emptyStoreFile, type StoreFile, type StoreReview } from "./types";

/**
 * Where the Store module keeps its state: a JSON file in the app's folder
 * (local mode: day2-store-listing.json, reviews in day2-store-reviews.json),
 * or Postgres (accounts mode: store_listing, store_reviews — migration 013).
 * `update` runs one change at a time per app.
 */

export const STORE_FILENAME = "day2-store-listing.json";
export const REVIEWS_FILENAME = "day2-store-reviews.json";

export interface StoreListingStore {
  load(appId: string): Promise<StoreFile>;
  update<T>(appId: string, fn: (f: StoreFile) => { file: StoreFile; result: T } | Promise<{ file: StoreFile; result: T }>): Promise<T>;
  reviews(appId: string): Promise<StoreReview[]>;
  saveReviews(appId: string, reviews: StoreReview[]): Promise<void>;
}

/** Pure. A stored file with anything missing filled from the defaults (older files keep loading). */
export function normalize(raw: unknown): StoreFile {
  const e = emptyStoreFile();
  if (!raw || typeof raw !== "object") return e;
  const p = raw as Partial<StoreFile>;
  const s = (p.settings ?? {}) as Partial<StoreFile["settings"]>;
  return {
    ...e,
    ...p,
    settings: {
      ...DEFAULT_SETTINGS,
      ...s,
      autonomy: { ...DEFAULT_SETTINGS.autonomy, ...(s.autonomy ?? {}) },
      reviewPrompt: { ...DEFAULT_SETTINGS.reviewPrompt, ...(s.reviewPrompt ?? {}) },
      locales: Array.isArray(s.locales) && s.locales.length ? s.locales : DEFAULT_SETTINGS.locales,
    },
    listings: { ...e.listings, ...(p.listings ?? {}), errors: p.listings?.errors ?? {} },
    proposals: Array.isArray(p.proposals) ? p.proposals : [],
    research: Array.isArray(p.research) ? p.research : [],
    screenshots: Array.isArray(p.screenshots) ? p.screenshots : [],
    tests: Array.isArray(p.tests) ? p.tests : [],
    customPages: Array.isArray(p.customPages) ? p.customPages : [],
    ratings: Array.isArray(p.ratings) ? p.ratings : [],
    log: Array.isArray(p.log) ? p.log : [],
    setup: { ...emptySetup(), ...(p.setup && typeof p.setup === "object" ? p.setup : {}) },
    nextProposal: typeof p.nextProposal === "number" ? p.nextProposal : 1,
  };
}

const trim = (f: StoreFile): StoreFile => ({ ...f, log: f.log.slice(-200), research: f.research.slice(0, 6), screenshots: f.screenshots.slice(-12), setup: { ...f.setup, graphics: f.setup.graphics.slice(-20) } });

const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

const writeJson = (path: string, v: unknown) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  renameSync(tmp, path);
};

/** Local mode: files in the app's folder. */
export function fileStoreListing(dirFor: (appId: string) => string): StoreListingStore {
  const read = (p: string) => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as unknown) : null);
  return {
    async load(appId) {
      try {
        return normalize(read(join(dirFor(appId), STORE_FILENAME)));
      } catch {
        return emptyStoreFile();
      }
    },
    update(appId, fn) {
      const path = join(dirFor(appId), STORE_FILENAME);
      return serial(path, async () => {
        let f: StoreFile;
        try {
          f = normalize(read(path));
        } catch {
          f = emptyStoreFile();
        }
        const out = await fn(f);
        writeJson(path, trim(out.file));
        return out.result;
      });
    },
    async reviews(appId) {
      try {
        const r = read(join(dirFor(appId), REVIEWS_FILENAME));
        return Array.isArray(r) ? (r as StoreReview[]) : [];
      } catch {
        return [];
      }
    },
    async saveReviews(appId, reviews) {
      const path = join(dirFor(appId), REVIEWS_FILENAME);
      await serial(path, async () => writeJson(path, reviews));
    },
  };
}

type ReviewRow = { doc: StoreReview | string };

/** Accounts mode: Postgres. */
export function dbStoreListing(sql: SQL): StoreListingStore {
  const parse = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
  return {
    async load(appId) {
      const [r] = (await sql`SELECT doc FROM store_listing WHERE app_id = ${appId}`) as Array<{ doc: unknown }>;
      return normalize(r ? parse(r.doc) : null);
    },
    update(appId, fn) {
      return serial(`db:${appId}`, () =>
        sql.begin(async (tx) => {
          const [r] = (await tx`SELECT doc FROM store_listing WHERE app_id = ${appId} FOR UPDATE`) as Array<{ doc: unknown }>;
          const out = await fn(normalize(r ? parse(r.doc) : null));
          const doc = JSON.stringify(trim(out.file));
          await tx`INSERT INTO store_listing (app_id, doc) VALUES (${appId}, ${doc}::jsonb)
                   ON CONFLICT (app_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`;
          return out.result;
        }),
      );
    },
    async reviews(appId) {
      const rows = (await sql`SELECT doc FROM store_reviews WHERE app_id = ${appId} ORDER BY created_at DESC LIMIT 1000`) as ReviewRow[];
      return rows.map((r) => parse<StoreReview>(r.doc));
    },
    async saveReviews(appId, reviews) {
      await sql.begin(async (tx) => {
        for (const r of reviews) {
          const doc = JSON.stringify(r);
          await tx`INSERT INTO store_reviews (app_id, store, review_id, created_at, rating, doc) VALUES (${appId}, ${r.store}, ${r.id}, ${r.createdAt || new Date().toISOString()}, ${r.rating}, ${doc}::jsonb)
                   ON CONFLICT (app_id, store, review_id) DO UPDATE SET rating = EXCLUDED.rating, doc = EXCLUDED.doc`;
        }
        // Keep a year of reviews.
        await tx`DELETE FROM store_reviews WHERE app_id = ${appId} AND created_at < now() - interval '365 days'`;
      });
    },
  };
}

/** The store for an app in this server's mode. */
export function storeListingFor(app: AppEntry): StoreListingStore {
  return serverMode() === "accounts" ? dbStoreListing(db()) : fileStoreListing(() => app.repoPath);
}
