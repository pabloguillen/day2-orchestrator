import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PlatformId } from "./types";

/**
 * Who each app's ads show as on each platform: a Facebook Page, a LinkedIn
 * company page, an X account, a TikTok custom identity day2 created… Set
 * once per app and platform — by day2 itself where the platform allows
 * ("custom"), otherwise linked by the app's owner or day2's operator.
 */

export type PlatformIdentity = { appId: string; platform: PlatformId; ref: string; displayName: string; setBy: string | null; setAt: string };

export interface PlatformIdentityStore {
  forApp(appId: string): Promise<PlatformIdentity[]>;
  get(appId: string, platform: PlatformId): Promise<PlatformIdentity | undefined>;
  set(i: Omit<PlatformIdentity, "setAt">): Promise<PlatformIdentity>;
  remove(appId: string, platform: PlatformId): Promise<void>;
}

/** What a reference must look like per platform (rejects obvious mistakes, not a full validation). */
export const REF_RE: Record<PlatformId, RegExp> = {
  meta: /^\d{5,25}$/,
  tiktok: /^[A-Za-z0-9_-]{4,64}$/,
  linkedin: /^urn:li:organization:\d{1,20}$/,
  google: /^.{0,100}$/,
  snapchat: /^[A-Za-z0-9-]{8,64}$/,
  pinterest: /^[A-Za-z0-9_-]{4,64}$/,
  reddit: /^[A-Za-z0-9_:-]{3,64}$/,
  x: /^\d{1,25}$/,
};

type LegacyMeta = Record<string, { appId: string; metaPageId: string; setBy: string | null; setAt: string }>;

export function filePlatformIdentities(path: string, legacyMetaPath?: string): PlatformIdentityStore {
  const load = (): Record<string, PlatformIdentity> => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, PlatformIdentity>) : {});
  const save = (all: Record<string, PlatformIdentity>) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
  };
  const legacy = (appId: string): PlatformIdentity | undefined => {
    if (!legacyMetaPath || !existsSync(legacyMetaPath)) return undefined;
    const m = (JSON.parse(readFileSync(legacyMetaPath, "utf-8")) as LegacyMeta)[appId];
    return m ? { appId, platform: "meta", ref: m.metaPageId, displayName: "", setBy: m.setBy, setAt: m.setAt } : undefined;
  };
  const key = (appId: string, p: PlatformId) => `${appId}|${p}`;
  return {
    async forApp(appId) {
      const own = Object.values(load()).filter((i) => i.appId === appId);
      const l = own.some((i) => i.platform === "meta") ? undefined : legacy(appId);
      return l ? [...own, l] : own;
    },
    async get(appId, platform) {
      return load()[key(appId, platform)] ?? (platform === "meta" ? legacy(appId) : undefined);
    },
    async set(i) {
      const all = load();
      const v = { ...i, setAt: new Date().toISOString() };
      all[key(i.appId, i.platform)] = v;
      save(all);
      return v;
    },
    async remove(appId, platform) {
      const all = load();
      delete all[key(appId, platform)];
      save(all);
    },
  };
}

type Row = { app_id: string; platform: PlatformId; ref: string; display_name: string; set_by: string | null; set_at: Date | string };
const toIdentity = (r: Row): PlatformIdentity => ({ appId: r.app_id, platform: r.platform, ref: r.ref, displayName: r.display_name, setBy: r.set_by, setAt: new Date(r.set_at).toISOString() });

export function dbPlatformIdentities(sql: SQL): PlatformIdentityStore {
  // Meta Pages are still assigned on the Platform page (app_ad_identities); they count here too.
  const legacyMeta = async (appId: string): Promise<PlatformIdentity | undefined> => {
    const rows = (await sql`SELECT app_id, meta_page_id, set_by, set_at FROM app_ad_identities WHERE app_id = ${appId}`) as Array<{ app_id: string; meta_page_id: string; set_by: string | null; set_at: Date | string }>;
    const r = rows[0];
    return r ? { appId, platform: "meta", ref: r.meta_page_id, displayName: "", setBy: r.set_by, setAt: new Date(r.set_at).toISOString() } : undefined;
  };
  return {
    async forApp(appId) {
      const own = ((await sql`SELECT * FROM app_platform_identities WHERE app_id = ${appId}`) as Row[]).map(toIdentity);
      const l = own.some((i) => i.platform === "meta") ? undefined : await legacyMeta(appId);
      return l ? [...own, l] : own;
    },
    async get(appId, platform) {
      const rows = (await sql`SELECT * FROM app_platform_identities WHERE app_id = ${appId} AND platform = ${platform}`) as Row[];
      return rows[0] ? toIdentity(rows[0]) : platform === "meta" ? legacyMeta(appId) : undefined;
    },
    async set(i) {
      const [r] = (await sql`INSERT INTO app_platform_identities (app_id, platform, ref, display_name, set_by) VALUES (${i.appId}, ${i.platform}, ${i.ref}, ${i.displayName}, ${i.setBy})
        ON CONFLICT (app_id, platform) DO UPDATE SET ref = EXCLUDED.ref, display_name = EXCLUDED.display_name, set_by = EXCLUDED.set_by, set_at = now()
        RETURNING *`) as Row[];
      return toIdentity(r!);
    },
    async remove(appId, platform) {
      await sql`DELETE FROM app_platform_identities WHERE app_id = ${appId} AND platform = ${platform}`;
    },
  };
}
