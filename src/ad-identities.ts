import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Meta shows every ad under a Facebook Page, and Pages can't be created
 * through Meta's API — so the day2 operator assigns each app the Page its
 * ads run under, once. Until then the app gets everything except paid ads.
 */

export type AdIdentity = { appId: string; metaPageId: string; setBy: string | null; setAt: string };

export interface AdIdentityStore {
  get(appId: string): Promise<AdIdentity | undefined>;
  all(): Promise<AdIdentity[]>;
  set(appId: string, metaPageId: string, by: string | null): Promise<AdIdentity>;
  remove(appId: string): Promise<void>;
}

export const AD_IDENTITIES_FILENAME = ".day2-ad-identities.json";

const PAGE_ID_RE = /^\d{5,25}$/;
export const isMetaPageId = (s: string) => PAGE_ID_RE.test(s);

export function fileAdIdentities(path: string): AdIdentityStore {
  const load = (): Record<string, AdIdentity> => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, AdIdentity>) : {});
  const save = (all: Record<string, AdIdentity>) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
  };
  return {
    async get(appId) {
      return load()[appId];
    },
    async all() {
      return Object.values(load());
    },
    async set(appId, metaPageId, by) {
      const all = load();
      all[appId] = { appId, metaPageId, setBy: by, setAt: new Date().toISOString() };
      save(all);
      return all[appId]!;
    },
    async remove(appId) {
      const all = load();
      delete all[appId];
      save(all);
    },
  };
}

type Row = { app_id: string; meta_page_id: string; set_by: string | null; set_at: Date | string };
const toIdentity = (r: Row): AdIdentity => ({ appId: r.app_id, metaPageId: r.meta_page_id, setBy: r.set_by, setAt: new Date(r.set_at).toISOString() });

export function dbAdIdentities(sql: SQL): AdIdentityStore {
  return {
    async get(appId) {
      const rows = (await sql`SELECT * FROM app_ad_identities WHERE app_id = ${appId}`) as Row[];
      return rows[0] ? toIdentity(rows[0]) : undefined;
    },
    async all() {
      return ((await sql`SELECT * FROM app_ad_identities`) as Row[]).map(toIdentity);
    },
    async set(appId, metaPageId, by) {
      const [r] = (await sql`INSERT INTO app_ad_identities (app_id, meta_page_id, set_by) VALUES (${appId}, ${metaPageId}, ${by})
        ON CONFLICT (app_id) DO UPDATE SET meta_page_id = EXCLUDED.meta_page_id, set_by = EXCLUDED.set_by, set_at = now()
        RETURNING *`) as Row[];
      return toIdentity(r!);
    },
    async remove(appId) {
      await sql`DELETE FROM app_ad_identities WHERE app_id = ${appId}`;
    },
  };
}
