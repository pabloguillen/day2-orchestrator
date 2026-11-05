import type { SQL } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptSecret, encryptSecret } from "../secrets";
import { emptyState, type HostingState, type SecretKind } from "./types";

/**
 * Hosting state per app (what's set up, health, usage, findings — nothing
 * secret) and the app's hosting secrets, encrypted with DAY2_SECRETS_KEY
 * like release credentials: bound to app and kind, never returned by the API.
 *
 * Files locally (`<data>/hosting/<app>/`, never in the app's repo), Postgres
 * in accounts mode (migration 021_hosting.sql).
 */

export interface HostingStore {
  state(appId: string): Promise<HostingState>;
  /** Read-modify-write, one at a time per app. */
  update(appId: string, fn: (s: HostingState) => HostingState | void): Promise<HostingState>;
}

export interface HostingSecrets {
  get<T = unknown>(appId: string, kind: SecretKind): Promise<T | null>;
  set(appId: string, kind: SecretKind, value: unknown, label: string): Promise<void>;
  remove(appId: string, kind: SecretKind): Promise<void>;
  /** What's stored, without the values. */
  list(appId: string): Promise<Array<{ kind: SecretKind; label: string; setAt: string }>>;
}

const ctx = (appId: string, kind: string) => `hosting-secret:${appId}:${kind}`;

/** Fills fields added after a state was saved. */
export function normalize(raw: Partial<HostingState> | null | undefined): HostingState {
  const e = emptyState();
  if (!raw) return e;
  return { ...e, ...raw, auth: { ...e.auth, ...(raw.auth ?? {}) }, takeover: { ...e.takeover, ...(raw.takeover ?? {}) } };
}

const parse = (s: HostingState | string | undefined) => (typeof s === "string" ? (JSON.parse(s) as HostingState) : s);

/** Keeps the lists that grow from becoming unbounded. */
function trim(s: HostingState): HostingState {
  return { ...s, log: s.log.slice(0, 100), usage: s.usage.slice(-120), migrations: s.migrations.slice(-200), alerts: s.alerts.slice(-50), previews: s.previews.slice(-30) };
}

const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  chains.set(key, run);
  return run;
}

const writeAtomic = (path: string, data: string) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

export function fileHostingStore(root: string): HostingStore {
  const path = (appId: string) => join(root, appId, "hosting.json");
  const load = (appId: string) => normalize(existsSync(path(appId)) ? (JSON.parse(readFileSync(path(appId), "utf-8")) as HostingState) : null);
  return {
    async state(appId) {
      return load(appId);
    },
    update(appId, fn) {
      return serial(`file:${root}:${appId}`, async () => {
        const cur = load(appId);
        const next = trim(fn(cur) ?? cur);
        mkdirSync(join(root, appId), { recursive: true });
        writeAtomic(path(appId), JSON.stringify(next, null, 2));
        return next;
      });
    },
  };
}

type SecretFile = Record<string, { secret: string; label: string; setAt: string }>;

export function fileHostingSecrets(root: string): HostingSecrets {
  const path = (appId: string) => join(root, appId, "secrets.json");
  const load = (appId: string): SecretFile => (existsSync(path(appId)) ? (JSON.parse(readFileSync(path(appId), "utf-8")) as SecretFile) : {});
  const save = (appId: string, f: SecretFile) => {
    mkdirSync(join(root, appId), { recursive: true });
    writeAtomic(path(appId), JSON.stringify(f, null, 2));
  };
  return {
    async get(appId, kind) {
      const r = load(appId)[kind];
      return r ? JSON.parse(decryptSecret(r.secret, ctx(appId, kind))) : null;
    },
    async set(appId, kind, value, label) {
      await serial(`secrets:${root}:${appId}`, async () => {
        const f = load(appId);
        f[kind] = { secret: encryptSecret(JSON.stringify(value), ctx(appId, kind)), label, setAt: new Date().toISOString() };
        save(appId, f);
      });
    },
    async remove(appId, kind) {
      await serial(`secrets:${root}:${appId}`, async () => {
        const f = load(appId);
        delete f[kind];
        save(appId, f);
      });
    },
    async list(appId) {
      return Object.entries(load(appId)).map(([kind, r]) => ({ kind: kind as SecretKind, label: r.label, setAt: r.setAt }));
    },
  };
}

export function dbHostingStore(sql: SQL): HostingStore {
  return {
    async state(appId) {
      const [r] = (await sql`SELECT state FROM app_hosting WHERE app_id = ${appId}`) as Array<{ state: HostingState | string }>;
      return normalize(parse(r?.state));
    },
    update(appId, fn) {
      return serial(`db:${appId}`, () =>
        sql.begin(async (tx) => {
          const [r] = (await tx`SELECT state FROM app_hosting WHERE app_id = ${appId} FOR UPDATE`) as Array<{ state: HostingState | string }>;
          const cur = normalize(parse(r?.state));
          const next = trim(fn(cur) ?? cur);
          await tx`INSERT INTO app_hosting (app_id, state, updated_at) VALUES (${appId}, ${next}::jsonb, now())
                   ON CONFLICT (app_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`;
          return next;
        }),
      );
    },
  };
}

export function dbHostingSecrets(sql: SQL): HostingSecrets {
  return {
    async get(appId, kind) {
      const [r] = (await sql`SELECT secret FROM hosting_secrets WHERE app_id = ${appId} AND kind = ${kind}`) as Array<{ secret: string }>;
      return r ? JSON.parse(decryptSecret(r.secret, ctx(appId, kind))) : null;
    },
    async set(appId, kind, value, label) {
      await sql`INSERT INTO hosting_secrets (app_id, kind, secret, label) VALUES (${appId}, ${kind}, ${encryptSecret(JSON.stringify(value), ctx(appId, kind))}, ${label})
                ON CONFLICT (app_id, kind) DO UPDATE SET secret = EXCLUDED.secret, label = EXCLUDED.label, set_at = now()`;
    },
    async remove(appId, kind) {
      await sql`DELETE FROM hosting_secrets WHERE app_id = ${appId} AND kind = ${kind}`;
    },
    async list(appId) {
      const rows = (await sql`SELECT kind, label, set_at FROM hosting_secrets WHERE app_id = ${appId}`) as Array<{ kind: SecretKind; label: string; set_at: Date | string }>;
      return rows.map((r) => ({ kind: r.kind, label: r.label, setAt: new Date(r.set_at).toISOString() }));
    },
  };
}
