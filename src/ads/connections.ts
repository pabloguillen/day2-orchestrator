import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "../secrets";
import type { Purpose, Tokens } from "./connect/types";
import type { PlatformId } from "./types";

/**
 * Connected ad accounts and half-finished connections.
 *
 * A connection is one ad account on one platform, either day2's own (scope
 * "day2": spend billed in credits) or an app's own (scope = the app id: the
 * customer pays the platform). Tokens are encrypted at rest, bound to the
 * connection id. A pending connection lives between the OAuth redirect and
 * the person picking an ad account or a page (1 hour at most).
 */

export type Scope = "day2" | { appId: string };
export const scopeKey = (s: Scope) => (s === "day2" ? "day2" : `app:${s.appId}`);

export type Connection = {
  id: string;
  scope: Scope;
  platform: PlatformId;
  adAccountId: string;
  accountName: string;
  currency: string;
  tokens: Tokens;
  connectedBy: string | null;
  connectedAt: string;
};

export type Pending = {
  id: string;
  state: string;
  scope: Scope;
  platform: PlatformId;
  purpose: Purpose;
  /** For purpose "identity": the app whose page is being connected. */
  appId: string | null;
  /** OAuth 1.0a request token etc. */
  pending: Record<string, string> | null;
  tokens: Tokens | null;
  createdBy: string | null;
  createdAt: string;
};

export interface ConnectionStore {
  list(scope?: Scope): Promise<Connection[]>;
  get(scope: Scope, platform: PlatformId): Promise<Connection | null>;
  save(c: Omit<Connection, "id" | "connectedAt">): Promise<Connection>;
  updateTokens(id: string, tokens: Tokens): Promise<void>;
  remove(scope: Scope, platform: PlatformId): Promise<void>;
  startPending(p: Omit<Pending, "id" | "createdAt" | "tokens">): Promise<Pending>;
  pendingByState(state: string): Promise<Pending | null>;
  pending(id: string): Promise<Pending | null>;
  setPendingTokens(id: string, tokens: Tokens): Promise<void>;
  /** OAuth 1.0a: the request token, known only after the pending connection exists. */
  setPendingData(id: string, pending: Record<string, string>): Promise<void>;
  endPending(id: string): Promise<void>;
}

const PENDING_MS = 3_600_000;
const newId = (p: string) => `${p}_${randomBytes(12).toString("base64url")}`;
const seal = (t: Tokens, id: string) => encryptSecret(JSON.stringify(t), `ads-connection:${id}`);
const unseal = (v: string, id: string) => JSON.parse(decryptSecret(v, `ads-connection:${id}`)) as Tokens;
const sealP = (v: unknown, id: string) => (v == null ? null : encryptSecret(JSON.stringify(v), `ads-pending:${id}`));
const unsealP = <T>(v: string | null, id: string): T | null => (v ? (JSON.parse(decryptSecret(v, `ads-pending:${id}`)) as T) : null);
const scopeFrom = (k: string): Scope => (k === "day2" ? "day2" : { appId: k.slice(4) });

/**
 * Locally (no database), day2 makes its own encryption key once, kept next
 * to its data (owner-only), so connecting works without setup. Production
 * always sets DAY2_SECRETS_KEY.
 */
export function ensureLocalSecretsKey(path: string): void {
  if (process.env.DAY2_SECRETS_KEY) return;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  process.env.DAY2_SECRETS_KEY = readFileSync(path, "utf-8").trim();
}

type FileShape = { connections: Record<string, { id: string; scope: string; platform: PlatformId; adAccountId: string; accountName: string; currency: string; tokens: string; connectedBy: string | null; connectedAt: string }>; pending: Record<string, Omit<Pending, "scope" | "pending" | "tokens"> & { scope: string; pending: string | null; tokens: string | null }> };

export function fileConnections(path: string): ConnectionStore {
  const load = (): FileShape => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as FileShape) : { connections: {}, pending: {} });
  const save = (f: FileShape) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };
  const toConn = (r: FileShape["connections"][string]): Connection => ({ ...r, scope: scopeFrom(r.scope), tokens: unseal(r.tokens, r.id) });
  const toPending = (r: FileShape["pending"][string]): Pending => ({ ...r, scope: scopeFrom(r.scope), pending: unsealP(r.pending, r.id), tokens: unsealP<Tokens>(r.tokens, r.id) });
  const key = (s: Scope, p: PlatformId) => `${scopeKey(s)}|${p}`;
  return {
    async list(scope) {
      return Object.values(load().connections)
        .filter((r) => !scope || r.scope === scopeKey(scope))
        .map(toConn);
    },
    async get(scope, platform) {
      const r = load().connections[key(scope, platform)];
      return r ? toConn(r) : null;
    },
    async save(c) {
      const f = load();
      const id = newId("adc");
      const row = { id, scope: scopeKey(c.scope), platform: c.platform, adAccountId: c.adAccountId, accountName: c.accountName, currency: c.currency, tokens: seal(c.tokens, id), connectedBy: c.connectedBy, connectedAt: new Date().toISOString() };
      f.connections[key(c.scope, c.platform)] = row;
      save(f);
      return toConn(row);
    },
    async updateTokens(id, tokens) {
      const f = load();
      const k = Object.keys(f.connections).find((x) => f.connections[x]!.id === id);
      if (!k) return;
      f.connections[k]!.tokens = seal(tokens, id);
      save(f);
    },
    async remove(scope, platform) {
      const f = load();
      delete f.connections[key(scope, platform)];
      save(f);
    },
    async startPending(p) {
      const f = load();
      const now = Date.now();
      for (const [k, v] of Object.entries(f.pending)) if (now - Date.parse(v.createdAt) > PENDING_MS) delete f.pending[k];
      const id = newId("adp");
      f.pending[id] = { id, state: p.state, scope: scopeKey(p.scope), platform: p.platform, purpose: p.purpose, appId: p.appId, pending: sealP(p.pending, id), tokens: null, createdBy: p.createdBy, createdAt: new Date().toISOString() };
      save(f);
      return toPending(f.pending[id]!);
    },
    async pendingByState(state) {
      const r = Object.values(load().pending).find((x) => x.state === state && Date.now() - Date.parse(x.createdAt) <= PENDING_MS);
      return r ? toPending(r) : null;
    },
    async pending(id) {
      const r = load().pending[id];
      return r && Date.now() - Date.parse(r.createdAt) <= PENDING_MS ? toPending(r) : null;
    },
    async setPendingTokens(id, tokens) {
      const f = load();
      if (!f.pending[id]) return;
      f.pending[id]!.tokens = sealP(tokens, id);
      save(f);
    },
    async setPendingData(id, pending) {
      const f = load();
      if (!f.pending[id]) return;
      f.pending[id]!.pending = sealP(pending, id);
      save(f);
    },
    async endPending(id) {
      const f = load();
      delete f.pending[id];
      save(f);
    },
  };
}

type ConnRow = { id: string; scope: string; platform: PlatformId; ad_account_id: string; account_name: string; currency: string; tokens: string; connected_by: string | null; connected_at: Date | string };
type PendRow = { id: string; state: string; scope: string; platform: PlatformId; purpose: Purpose; app_id: string | null; pending: string | null; tokens: string | null; created_by: string | null; created_at: Date | string };

export function dbConnections(sql: SQL): ConnectionStore {
  const toConn = (r: ConnRow): Connection => ({ id: r.id, scope: scopeFrom(r.scope), platform: r.platform, adAccountId: r.ad_account_id, accountName: r.account_name, currency: r.currency, tokens: unseal(r.tokens, r.id), connectedBy: r.connected_by, connectedAt: new Date(r.connected_at).toISOString() });
  const toPending = (r: PendRow): Pending => ({ id: r.id, state: r.state, scope: scopeFrom(r.scope), platform: r.platform, purpose: r.purpose, appId: r.app_id, pending: unsealP(r.pending, r.id), tokens: unsealP<Tokens>(r.tokens, r.id), createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() });
  const fresh = () => new Date(Date.now() - PENDING_MS).toISOString();
  return {
    async list(scope) {
      const rows = (scope ? await sql`SELECT * FROM ad_connections WHERE scope = ${scopeKey(scope)}` : await sql`SELECT * FROM ad_connections`) as ConnRow[];
      return rows.map(toConn);
    },
    async get(scope, platform) {
      const rows = (await sql`SELECT * FROM ad_connections WHERE scope = ${scopeKey(scope)} AND platform = ${platform}`) as ConnRow[];
      return rows[0] ? toConn(rows[0]) : null;
    },
    async save(c) {
      const id = newId("adc");
      const appId = c.scope === "day2" ? null : c.scope.appId;
      const [r] = (await sql`INSERT INTO ad_connections (id, scope, app_id, platform, ad_account_id, account_name, currency, tokens, connected_by)
        VALUES (${id}, ${scopeKey(c.scope)}, ${appId}, ${c.platform}, ${c.adAccountId}, ${c.accountName}, ${c.currency}, ${seal(c.tokens, id)}, ${c.connectedBy})
        ON CONFLICT (scope, platform) DO UPDATE SET id = EXCLUDED.id, ad_account_id = EXCLUDED.ad_account_id, account_name = EXCLUDED.account_name, currency = EXCLUDED.currency, tokens = EXCLUDED.tokens, connected_by = EXCLUDED.connected_by, connected_at = now()
        RETURNING *`) as ConnRow[];
      return toConn(r!);
    },
    async updateTokens(id, tokens) {
      await sql`UPDATE ad_connections SET tokens = ${seal(tokens, id)} WHERE id = ${id}`;
    },
    async remove(scope, platform) {
      await sql`DELETE FROM ad_connections WHERE scope = ${scopeKey(scope)} AND platform = ${platform}`;
    },
    async startPending(p) {
      await sql`DELETE FROM ad_connect_pending WHERE created_at < ${fresh()}`;
      const id = newId("adp");
      const [r] = (await sql`INSERT INTO ad_connect_pending (id, state, scope, platform, purpose, app_id, pending, created_by)
        VALUES (${id}, ${p.state}, ${scopeKey(p.scope)}, ${p.platform}, ${p.purpose}, ${p.appId}, ${sealP(p.pending, id)}, ${p.createdBy}) RETURNING *`) as PendRow[];
      return toPending(r!);
    },
    async pendingByState(state) {
      const rows = (await sql`SELECT * FROM ad_connect_pending WHERE state = ${state} AND created_at >= ${fresh()}`) as PendRow[];
      return rows[0] ? toPending(rows[0]) : null;
    },
    async pending(id) {
      const rows = (await sql`SELECT * FROM ad_connect_pending WHERE id = ${id} AND created_at >= ${fresh()}`) as PendRow[];
      return rows[0] ? toPending(rows[0]) : null;
    },
    async setPendingTokens(id, tokens) {
      await sql`UPDATE ad_connect_pending SET tokens = ${sealP(tokens, id)} WHERE id = ${id}`;
    },
    async setPendingData(id, pending) {
      await sql`UPDATE ad_connect_pending SET pending = ${sealP(pending, id)} WHERE id = ${id}`;
    },
    async endPending(id) {
      await sql`DELETE FROM ad_connect_pending WHERE id = ${id}`;
    },
  };
}
