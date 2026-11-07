import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "../secrets";
import type { Post, PostStatus, SocialNetwork } from "./types";

/**
 * Where social state lives: JSON files locally, Postgres with accounts
 * (migration 026). Three stores:
 *  - accounts: the owner's connected Instagram/Page and TikTok, tokens
 *    encrypted (bound to the row id), never returned by the API;
 *  - posts: one document per post, updated one at a time (a row lock in
 *    Postgres) so two publishers can never claim the same post;
 *  - media links: unguessable public links to a post's media, expiring.
 */

// ---------------------------------------------------------------- accounts

export type MetaSocialMeta = { pageId: string; pageName: string; igUserId: string | null; igUsername: string | null; igAccountType: string | null; scopes: string[] };
export type TikTokSocialMeta = { openId: string; nickname: string; username: string | null; scopes: string[] };
export type MetaSocialTokens = { pageToken: string };
export type TikTokSocialTokens = { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number | null };

export type SocialAccount =
  | { id: string; appId: string; network: "meta"; meta: MetaSocialMeta; tokens: MetaSocialTokens; connectedBy: string | null; connectedAt: string }
  | { id: string; appId: string; network: "tiktok"; meta: TikTokSocialMeta; tokens: TikTokSocialTokens; connectedBy: string | null; connectedAt: string };

export type NewSocialAccount = DistributiveOmit<SocialAccount, "id" | "connectedAt">;
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export interface SocialAccountStore {
  forApp(appId: string): Promise<SocialAccount[]>;
  get(appId: string, network: SocialNetwork): Promise<SocialAccount | null>;
  save(a: NewSocialAccount): Promise<SocialAccount>;
  updateTokens(appId: string, network: SocialNetwork, tokens: MetaSocialTokens | TikTokSocialTokens): Promise<void>;
  remove(appId: string, network: SocialNetwork): Promise<void>;
}

const newId = (p: string) => `${p}_${randomBytes(12).toString("base64url")}`;
const seal = (t: unknown, id: string) => encryptSecret(JSON.stringify(t), `social-account:${id}`);
const unseal = <T>(v: string, id: string) => JSON.parse(decryptSecret(v, `social-account:${id}`)) as T;

function writeJson(path: string, data: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, path);
}
const readJson = <T>(path: string, empty: T): T => {
  if (!existsSync(path)) return empty;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return empty;
  }
};

type AccountRow = { id: string; app_id: string; network: SocialNetwork; meta: unknown; tokens: string; connected_by: string | null; connected_at: Date | string };
const toAccount = (r: AccountRow): SocialAccount =>
  ({ id: r.id, appId: r.app_id, network: r.network, meta: typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta, tokens: unseal(r.tokens, r.id), connectedBy: r.connected_by, connectedAt: new Date(r.connected_at).toISOString() }) as SocialAccount;

export function fileSocialAccounts(path: string): SocialAccountStore {
  type Shape = Record<string, Omit<AccountRow, "connected_at"> & { connected_at: string }>;
  const key = (appId: string, n: SocialNetwork) => `${appId}|${n}`;
  return {
    async forApp(appId) {
      return Object.values(readJson<Shape>(path, {}))
        .filter((r) => r.app_id === appId)
        .map(toAccount);
    },
    async get(appId, network) {
      const r = readJson<Shape>(path, {})[key(appId, network)];
      return r ? toAccount(r) : null;
    },
    async save(a) {
      const all = readJson<Shape>(path, {});
      const id = newId("soc");
      all[key(a.appId, a.network)] = { id, app_id: a.appId, network: a.network, meta: a.meta, tokens: seal(a.tokens, id), connected_by: a.connectedBy, connected_at: new Date().toISOString() };
      writeJson(path, all, 0o600);
      return toAccount(all[key(a.appId, a.network)]!);
    },
    async updateTokens(appId, network, tokens) {
      const all = readJson<Shape>(path, {});
      const r = all[key(appId, network)];
      if (!r) return;
      r.tokens = seal(tokens, r.id);
      writeJson(path, all, 0o600);
    },
    async remove(appId, network) {
      const all = readJson<Shape>(path, {});
      delete all[key(appId, network)];
      writeJson(path, all, 0o600);
    },
  };
}

export function dbSocialAccounts(sql: SQL): SocialAccountStore {
  return {
    async forApp(appId) {
      return ((await sql`SELECT * FROM social_accounts WHERE app_id = ${appId}`) as AccountRow[]).map(toAccount);
    },
    async get(appId, network) {
      const rows = (await sql`SELECT * FROM social_accounts WHERE app_id = ${appId} AND network = ${network}`) as AccountRow[];
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async save(a) {
      const id = newId("soc");
      const [r] = (await sql`INSERT INTO social_accounts (id, app_id, network, meta, tokens, connected_by) VALUES (${id}, ${a.appId}, ${a.network}, ${a.meta}::jsonb, ${seal(a.tokens, id)}, ${a.connectedBy})
        ON CONFLICT (app_id, network) DO UPDATE SET id = EXCLUDED.id, meta = EXCLUDED.meta, tokens = EXCLUDED.tokens, connected_by = EXCLUDED.connected_by, connected_at = now()
        RETURNING *`) as AccountRow[];
      return toAccount(r!);
    },
    async updateTokens(appId, network, tokens) {
      const rows = (await sql`SELECT id FROM social_accounts WHERE app_id = ${appId} AND network = ${network}`) as Array<{ id: string }>;
      if (!rows[0]) return;
      await sql`UPDATE social_accounts SET tokens = ${seal(tokens, rows[0].id)} WHERE id = ${rows[0].id}`;
    },
    async remove(appId, network) {
      await sql`DELETE FROM social_accounts WHERE app_id = ${appId} AND network = ${network}`;
    },
  };
}

// ---------------------------------------------------------------- posts

export interface SocialPostStore {
  list(appId: string, opts?: { limit?: number }): Promise<Post[]>;
  get(appId: string, id: string): Promise<Post | null>;
  /** Posts across all apps the publisher should look at: approved or publishing. */
  due(appId: string): Promise<Post[]>;
  insert(p: Post): Promise<Post>;
  /**
   * Changes one post atomically: `fn` sees the current post and returns the
   * new one (or null to leave it). No other update of the same post runs in
   * between — the publisher's claim relies on it.
   */
  update(appId: string, id: string, fn: (p: Post) => Post | null): Promise<Post | null>;
}

export const newPostId = () => `sp_${randomBytes(9).toString("base64url")}`;
const ACTIVE: PostStatus[] = ["approved", "publishing"];

export function fileSocialPosts(path: string): SocialPostStore {
  type Shape = { posts: Record<string, Post> };
  const load = () => readJson<Shape>(path, { posts: {} });
  return {
    async list(appId, opts) {
      return Object.values(load().posts)
        .filter((p) => p.appId === appId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, opts?.limit ?? 200);
    },
    async get(appId, id) {
      const p = load().posts[id];
      return p && p.appId === appId ? p : null;
    },
    async due(appId) {
      return Object.values(load().posts).filter((p) => p.appId === appId && (ACTIVE.includes(p.status) || p.status === "published"));
    },
    async insert(p) {
      const all = load();
      all.posts[p.id] = p;
      writeJson(path, all);
      return p;
    },
    async update(appId, id, fn) {
      // One process locally: read, change and write without awaiting in between.
      const all = load();
      const cur = all.posts[id];
      if (!cur || cur.appId !== appId) return null;
      const next = fn(structuredClone(cur));
      if (!next) return cur;
      all.posts[id] = { ...next, updatedAt: new Date().toISOString() };
      writeJson(path, all);
      return all.posts[id]!;
    },
  };
}

type PostRow = { doc: Post | string };
const toPost = (r: PostRow): Post => (typeof r.doc === "string" ? (JSON.parse(r.doc) as Post) : r.doc);

export function dbSocialPosts(sql: SQL): SocialPostStore {
  return {
    async list(appId, opts) {
      return ((await sql`SELECT doc FROM social_posts WHERE app_id = ${appId} ORDER BY created_at DESC LIMIT ${opts?.limit ?? 200}`) as PostRow[]).map(toPost);
    },
    async get(appId, id) {
      const rows = (await sql`SELECT doc FROM social_posts WHERE app_id = ${appId} AND id = ${id}`) as PostRow[];
      return rows[0] ? toPost(rows[0]) : null;
    },
    async due(appId) {
      return ((await sql`SELECT doc FROM social_posts WHERE app_id = ${appId} AND status IN ('approved', 'publishing', 'published') AND created_at > now() - interval '30 days'`) as PostRow[]).map(toPost);
    },
    async insert(p) {
      await sql`INSERT INTO social_posts (id, app_id, status, scheduled_at, doc, created_at) VALUES (${p.id}, ${p.appId}, ${p.status}, ${p.scheduledAt}, ${p}::jsonb, ${p.createdAt})`;
      return p;
    },
    async update(appId, id, fn) {
      return sql.begin(async (tx) => {
        const rows = (await tx`SELECT doc FROM social_posts WHERE app_id = ${appId} AND id = ${id} FOR UPDATE`) as PostRow[];
        if (!rows[0]) return null;
        const cur = toPost(rows[0]);
        const next = fn(structuredClone(cur));
        if (!next) return cur;
        const saved = { ...next, updatedAt: new Date().toISOString() };
        await tx`UPDATE social_posts SET status = ${saved.status}, scheduled_at = ${saved.scheduledAt}, doc = ${saved}::jsonb, updated_at = now() WHERE id = ${id}`;
        return saved;
      });
    },
  };
}

// ---------------------------------------------------------------- media links

export type MediaLink = { token: string; appId: string; assetId: string; expiresAt: string };

export interface MediaLinkStore {
  /** A new public link to an asset, valid until `expiresAt`. */
  create(appId: string, assetId: string, expiresAt: Date): Promise<MediaLink>;
  /** The link, only while it hasn't expired. */
  resolve(token: string, now?: Date): Promise<MediaLink | null>;
  /** Shortens every link to an asset to end at `at` (publish time + 24 h). */
  expireAsset(appId: string, assetId: string, at: Date): Promise<void>;
  purge(now?: Date): Promise<number>;
}

/** sm_ + 32 random bytes: unguessable; matched by the public /api/assets/<id> path. */
export const MEDIA_TOKEN_RE = /^sm_[A-Za-z0-9_-]{43}$/;
const newToken = () => `sm_${randomBytes(32).toString("base64url")}`;

export function fileMediaLinks(path: string): MediaLinkStore {
  type Shape = Record<string, MediaLink>;
  return {
    async create(appId, assetId, expiresAt) {
      const all = readJson<Shape>(path, {});
      const l = { token: newToken(), appId, assetId, expiresAt: expiresAt.toISOString() };
      all[l.token] = l;
      writeJson(path, all, 0o600);
      return l;
    },
    async resolve(token, now = new Date()) {
      const l = readJson<Shape>(path, {})[token];
      return l && Date.parse(l.expiresAt) > now.getTime() ? l : null;
    },
    async expireAsset(appId, assetId, at) {
      const all = readJson<Shape>(path, {});
      for (const l of Object.values(all)) if (l.appId === appId && l.assetId === assetId && Date.parse(l.expiresAt) > at.getTime()) l.expiresAt = at.toISOString();
      writeJson(path, all, 0o600);
    },
    async purge(now = new Date()) {
      const all = readJson<Shape>(path, {});
      let n = 0;
      for (const [k, l] of Object.entries(all))
        if (Date.parse(l.expiresAt) <= now.getTime()) {
          delete all[k];
          n++;
        }
      if (n) writeJson(path, all, 0o600);
      return n;
    },
  };
}

type LinkRow = { token: string; app_id: string; asset_id: string; expires_at: Date | string };
const toLink = (r: LinkRow): MediaLink => ({ token: r.token, appId: r.app_id, assetId: r.asset_id, expiresAt: new Date(r.expires_at).toISOString() });

export function dbMediaLinks(sql: SQL): MediaLinkStore {
  return {
    async create(appId, assetId, expiresAt) {
      const token = newToken();
      await sql`INSERT INTO social_media_links (token, app_id, asset_id, expires_at) VALUES (${token}, ${appId}, ${assetId}, ${expiresAt.toISOString()})`;
      return { token, appId, assetId, expiresAt: expiresAt.toISOString() };
    },
    async resolve(token, now = new Date()) {
      const rows = (await sql`SELECT * FROM social_media_links WHERE token = ${token} AND expires_at > ${now.toISOString()}`) as LinkRow[];
      return rows[0] ? toLink(rows[0]) : null;
    },
    async expireAsset(appId, assetId, at) {
      await sql`UPDATE social_media_links SET expires_at = ${at.toISOString()} WHERE app_id = ${appId} AND asset_id = ${assetId} AND expires_at > ${at.toISOString()}`;
    },
    async purge(now = new Date()) {
      const rows = (await sql`DELETE FROM social_media_links WHERE expires_at <= ${now.toISOString()} RETURNING token`) as unknown[];
      return rows.length;
    },
  };
}
