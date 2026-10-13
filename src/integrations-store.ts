import type { SQL } from "bun";
import { loadIntegrations, saveIntegrations, type AppIntegrations } from "./backlog-trackers";
import { decryptSecret, encryptSecret } from "./secrets";

/**
 * Where an account's JIRA/Linear connections live. Production: Postgres,
 * encrypted (secrets.ts), scoped to the account. Local single-operator mode:
 * the gitignored `.day2-integrations.json` file.
 */
export interface IntegrationsStore {
  get(appId: string): Promise<AppIntegrations | undefined>;
  /** Read-modify-write; `fn` returns the new value (undefined removes it). */
  update(appId: string, fn: (current: AppIntegrations) => AppIntegrations | undefined): Promise<AppIntegrations | undefined>;
}

export function fileIntegrations(path: string): IntegrationsStore {
  return {
    async get(appId) {
      return loadIntegrations(path)[appId];
    },
    async update(appId, fn) {
      const all = loadIntegrations(path);
      const next = fn(all[appId] ?? {});
      if (next === undefined) delete all[appId];
      else all[appId] = next;
      saveIntegrations(path, all);
      return next;
    },
  };
}

const context = (appId: string) => `integrations:${appId}`;

export function dbIntegrations(sql: SQL, accountId: string): IntegrationsStore {
  const read = async (q: SQL, appId: string, lock: boolean): Promise<AppIntegrations | undefined> => {
    const rows = (lock
      ? await q`SELECT data_enc FROM app_integrations WHERE app_id = ${appId} AND account_id = ${accountId} FOR UPDATE`
      : await q`SELECT data_enc FROM app_integrations WHERE app_id = ${appId} AND account_id = ${accountId}`) as Array<{ data_enc: string }>;
    return rows[0] ? (JSON.parse(decryptSecret(rows[0].data_enc, context(appId))) as AppIntegrations) : undefined;
  };
  return {
    get: (appId) => read(sql, appId, false),
    async update(appId, fn) {
      return (await sql.begin(async (tx) => {
        // The app must belong to this account — a foreign app id is refused.
        const owned = await tx`SELECT 1 FROM apps WHERE id = ${appId} AND account_id = ${accountId}`;
        if (!owned.length) throw new Error(`No app registered with id "${appId}".`);
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`integrations:${appId}`}))`;
        const next = fn((await read(tx, appId, true)) ?? {});
        if (next === undefined) {
          await tx`DELETE FROM app_integrations WHERE app_id = ${appId} AND account_id = ${accountId}`;
        } else {
          const enc = encryptSecret(JSON.stringify(next), context(appId));
          await tx`INSERT INTO app_integrations (app_id, account_id, data_enc) VALUES (${appId}, ${accountId}, ${enc})
            ON CONFLICT (app_id) DO UPDATE SET data_enc = EXCLUDED.data_enc, updated_at = now()`;
        }
        return next;
      })) as AppIntegrations | undefined;
    },
  };
}
