import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { Asset, AssetSource, Ratio } from "./types";

/**
 * Finished ad images and videos. Files live on day2's disk (the /data
 * volume in production) and are served at an unguessable public URL
 * (`/api/assets/<id>.<ext>`), because most ad platforms fetch media by URL.
 * Metadata: Postgres in production, a JSON index locally.
 */

export type StoredAsset = Asset & { appId: string; createdAt: string; /** What it was made for, e.g. "B-4". */ purpose: string; /** Shown in the console. */ label: string; costUsd: number };

export interface AssetStore {
  /** Moves (or copies) a finished file in and records it. */
  put(file: string, meta: NewAsset): Promise<StoredAsset>;
  get(id: string): Promise<StoredAsset | null>;
  list(appId: string, purpose?: string): Promise<StoredAsset[]>;
  /** Absolute path of an asset's file, or null. */
  file(id: string): Promise<string | null>;
  /** Deletes an asset's record and file (e.g. a removed app's demo-cast pictures). */
  remove?(id: string): Promise<void>;
}

export type NewAsset = {
  appId: string;
  purpose: string;
  label: string;
  kind: "image" | "video";
  ratio: Ratio;
  width: number;
  height: number;
  durationSec?: number;
  mime: string;
  source: AssetSource;
  aiGenerated: boolean;
  aiPerson: boolean;
  costUsd?: number;
  thumbnailId?: string;
};

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4" };
export const ASSET_ID_RE = /^as_[A-Za-z0-9_-]{24}$/;
export const newAssetId = () => `as_${randomBytes(18).toString("base64url")}`;
export const assetUrl = (publicUrl: string, id: string, mime: string) => `${publicUrl.replace(/\/+$/, "")}/api/assets/${id}${EXT[mime] ?? ""}`;

type Row = Omit<StoredAsset, "thumbnail" | "url" | "path"> & { thumbnailId?: string };

function hydrate(r: Row, root: string, publicUrl: string, byId: (id: string) => Row | undefined): StoredAsset {
  const path = join(root, r.appId.replace(/[^A-Za-z0-9_-]/g, "_"), `${r.id}${EXT[r.mime] ?? ""}`);
  const thumbRow = r.thumbnailId ? byId(r.thumbnailId) : undefined;
  return {
    ...r,
    path,
    url: assetUrl(publicUrl, r.id, r.mime),
    ...(thumbRow ? { thumbnail: hydrate({ ...thumbRow, thumbnailId: undefined }, root, publicUrl, byId) } : {}),
  };
}

function place(root: string, file: string, appId: string, id: string, mime: string): number {
  const dest = join(root, appId.replace(/[^A-Za-z0-9_-]/g, "_"), `${id}${EXT[mime] ?? extname(file)}`);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(file, dest);
  } catch {
    copyFileSync(file, dest); // across devices
  }
  return statSync(dest).size;
}

export function fileAssetStore(root: string, publicUrl: string): AssetStore {
  const indexPath = join(root, "index.json");
  const load = (): Record<string, Row> => (existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, "utf-8")) as Record<string, Row>) : {});
  const save = (all: Record<string, Row>) => {
    mkdirSync(root, { recursive: true });
    const tmp = `${indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, indexPath);
  };
  const view = (all: Record<string, Row>, r: Row) => hydrate(r, root, publicUrl, (id) => all[id]);
  return {
    async put(file, meta) {
      const id = newAssetId();
      const bytes = place(root, file, meta.appId, id, meta.mime);
      const all = load();
      const { thumbnailId, costUsd, ...rest } = meta;
      all[id] = { ...rest, id, bytes, costUsd: costUsd ?? 0, createdAt: new Date().toISOString(), ...(thumbnailId ? { thumbnailId } : {}) };
      save(all);
      return view(all, all[id]!);
    },
    async get(id) {
      const all = load();
      return all[id] ? view(all, all[id]!) : null;
    },
    async list(appId, purpose) {
      const all = load();
      return Object.values(all)
        .filter((r) => r.appId === appId && (!purpose || r.purpose === purpose))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => view(all, r));
    },
    async file(id) {
      const a = await this.get(id);
      return a && existsSync(a.path) ? a.path : null;
    },
    async remove(id) {
      const all = load();
      const r = all[id];
      if (!r) return;
      const a = view(all, r);
      delete all[id];
      save(all);
      rmSync(a.path, { force: true });
    },
  };
}

type DbRow = { id: string; app_id: string; meta: Row | string; created_at: Date | string };

export function dbAssetStore(sql: SQL, root: string, publicUrl: string): AssetStore {
  const parse = (r: DbRow): Row => ({ ...(typeof r.meta === "string" ? (JSON.parse(r.meta) as Row) : r.meta), id: r.id, appId: r.app_id, createdAt: new Date(r.created_at).toISOString() });
  const one = async (id: string) => {
    const rows = (await sql`SELECT id, app_id, meta, created_at FROM ad_assets WHERE id = ${id}`) as DbRow[];
    return rows[0] ? parse(rows[0]) : undefined;
  };
  const withThumb = async (r: Row) => {
    const t = r.thumbnailId ? await one(r.thumbnailId) : undefined;
    return hydrate(r, root, publicUrl, (id) => (t && t.id === id ? t : undefined));
  };
  return {
    async put(file, meta) {
      const id = newAssetId();
      const bytes = place(root, file, meta.appId, id, meta.mime);
      const { appId, thumbnailId, costUsd, ...rest } = meta;
      const row = { ...rest, bytes, costUsd: costUsd ?? 0, ...(thumbnailId ? { thumbnailId } : {}) };
      await sql`INSERT INTO ad_assets (id, app_id, purpose, meta) VALUES (${id}, ${appId}, ${meta.purpose}, ${row}::jsonb)`;
      return (await this.get(id))!;
    },
    async get(id) {
      const r = await one(id);
      return r ? withThumb(r) : null;
    },
    async list(appId, purpose) {
      const rows = (purpose
        ? await sql`SELECT id, app_id, meta, created_at FROM ad_assets WHERE app_id = ${appId} AND purpose = ${purpose} ORDER BY created_at DESC LIMIT 500`
        : await sql`SELECT id, app_id, meta, created_at FROM ad_assets WHERE app_id = ${appId} ORDER BY created_at DESC LIMIT 500`) as DbRow[];
      return Promise.all(rows.map((r) => withThumb(parse(r))));
    },
    async file(id) {
      const a = await this.get(id);
      return a && existsSync(a.path) ? a.path : null;
    },
    async remove(id) {
      const a = await this.get(id);
      if (!a) return;
      await sql`DELETE FROM ad_assets WHERE id = ${id} AND app_id = ${a.appId}`;
      rmSync(a.path, { force: true });
    },
  };
}
