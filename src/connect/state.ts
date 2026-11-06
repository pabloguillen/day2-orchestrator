import type { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { redact } from "../ads/http";
import { excludeDay2State } from "../day2-state-files";
import { decryptSecret, encryptSecret } from "../secrets";

/**
 * "Connect your stores": where each app's connections stand (no secrets —
 * the keys live where they always did: release_credentials, money_credentials,
 * Numbers settings). Kept in the app's checkout like the other per-app
 * files (day2-connect.json).
 *
 * A Google session is the owner's one-hour access token between Google's
 * consent page and the end of setup — encrypted (DAY2_SECRETS_KEY), bound to
 * its id. It's revoked at Google and deleted when setup ends, when a sign-in
 * fails or is cancelled, and by the backlog timer an hour after it started.
 */

export const CONNECT_FILENAME = "day2-connect.json";

export type Check = { ok: boolean; at: string; note: string | null };

export type ConnectFile = {
  google: {
    email: string | null;
    by: string | null;
    at: string | null;
    projectId: string | null;
    serviceAccount: string | null;
    /** Last setup run, step by step. */
    apis: Check | null;
    key: Check | null;
    pubsub: (Check & { topic?: string | null }) | null;
    firebase: (Check & { appId?: string | null }) | null;
    fcm: Check | null;
    googleServicesTicket: string | null;
    developerId: string | null;
    invite: Check | null;
    access: Check | null;
    bucket: Check | null;
    /** The last setup's failure, when it stopped early. */
    problem: string | null;
  };
  expo: { account: string | null; projectId: string | null; projectFullName: string | null; check: Check | null; linkTicket: string | null };
  apple: {
    confirmed: Partial<Record<"membership" | "analytics", { at: string; by: string | null }>>;
    checks: Partial<Record<"asc_key" | "notifications" | "vendor" | "analytics", Check>>;
    notificationsUrlSet: { at: string; url: string } | null;
  };
};

export function emptyConnect(): ConnectFile {
  return {
    google: { email: null, by: null, at: null, projectId: null, serviceAccount: null, apis: null, key: null, pubsub: null, firebase: null, fcm: null, googleServicesTicket: null, developerId: null, invite: null, access: null, bucket: null, problem: null },
    expo: { account: null, projectId: null, projectFullName: null, check: null, linkTicket: null },
    apple: { confirmed: {}, checks: {}, notificationsUrlSet: null },
  };
}

export function loadConnect(path: string): ConnectFile {
  const e = emptyConnect();
  try {
    if (!existsSync(path)) return e;
    const p = JSON.parse(readFileSync(path, "utf-8")) as Partial<ConnectFile>;
    return {
      google: { ...e.google, ...(p.google ?? {}) },
      expo: { ...e.expo, ...(p.expo ?? {}) },
      apple: { ...e.apple, ...(p.apple ?? {}), confirmed: { ...(p.apple?.confirmed ?? {}) }, checks: { ...(p.apple?.checks ?? {}) } },
    };
  } catch {
    return e;
  }
}

export function saveConnect(path: string, f: ConnectFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(scrubFile(f), null, 2)}\n`);
  renameSync(tmp, path);
}

export const connectPath = (app: AppEntry) => resolve(app.repoPath, CONNECT_FILENAME);
export const loadAppConnect = (app: AppEntry) => loadConnect(connectPath(app));
export function updateAppConnect(app: AppEntry, fn: (f: ConnectFile) => ConnectFile): ConnectFile {
  excludeDay2State(app.repoPath);
  const next = fn(loadAppConnect(app));
  saveConnect(connectPath(app), next);
  return next;
}

/**
 * Pure. Error text from Google, Apple or Expo made safe to show and store:
 * no private keys (PEM blocks, private_key / private_key_id values), no
 * tokens (ads/http redact(), Google access tokens, long opaque strings).
 * Every note and problem in day2-connect.json goes through it.
 */
export function scrub(text: string): string;
export function scrub(text: string | null): string | null;
export function scrub(text: string | null): string | null {
  if (text === null) return null;
  return redact(
    text
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted key]")
      .replace(/\\?"?(private_key_id|private_key|client_secret|refresh_token|access_token|jsonKey)\\?"?\s*[:=]\s*(\{[^}]*\}?|\\?"[^"\\]*(?:\\.[^"\\]*)*\\?"|[^\s,}]+)/gi, "$1: [redacted]"),
  )
    .replace(/ya29\.[\w.-]+/g, "[redacted]")
    // Long opaque strings with upper case and digits (key material, tokens) — not ids, paths or emails.
    .replace(/\b(?=[A-Za-z0-9+=_-]*\d)(?=[A-Za-z0-9+=_-]*[A-Z])[A-Za-z0-9+=_-]{40,}/g, "[redacted]")
    .slice(0, 400);
}

export const check = (ok: boolean, note: string | null = null, now = new Date()): Check => ({ ok, at: now.toISOString(), note: scrub(note) });

/** Every note and problem in the file, scrubbed again before it's written (a last guard). */
function scrubFile(f: ConnectFile): ConnectFile {
  const walk = (v: unknown, key = ""): unknown => {
    if (typeof v === "string") return key === "note" || key === "problem" ? scrub(v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(f) as ConnectFile;
}

// ---------------------------------------------------------------------------
// Google sessions (the owner's short-lived access token)
// ---------------------------------------------------------------------------

export type GoogleToken = { accessToken: string; expiresAt: number; email: string | null };

export type GoogleSession = {
  id: string;
  state: string;
  accountId: string;
  appId: string;
  createdBy: string | null;
  createdAt: string;
  /** PKCE (S256) code verifier — sent with the code exchange only. */
  verifier: string;
  /** Set once Google sent the person back. */
  token: GoogleToken | null;
};

/**
 * One row per sign-in. The state is single-use: the first callback
 * consumes it, a second is refused. The verifier and the token are sealed
 * together (DAY2_SECRETS_KEY, bound to the row id). Rows end when setup
 * finishes, on any failed or cancelled sign-in, and at the latest an hour
 * after they started (`takeExpired`, on the backlog timer) — the caller
 * revokes the tokens it gets back.
 */
export interface GoogleSessionStore {
  start(o: { accountId: string; appId: string; createdBy: string | null }): Promise<GoogleSession>;
  /** The session for a callback's state, marking it used. Null when unknown, expired or already used. */
  consumeState(state: string): Promise<GoogleSession | null>;
  get(id: string): Promise<GoogleSession | null>;
  /** Stores the token; returns the one it replaced (to revoke), if any. */
  setToken(id: string, token: GoogleToken): Promise<GoogleToken | null>;
  /** Deletes the session; returns its token (to revoke), if any. */
  end(id: string): Promise<GoogleToken | null>;
  /** Deletes every session older than an hour; returns their tokens (to revoke). */
  takeExpired(now?: number): Promise<GoogleToken[]>;
}

export const SESSION_MS = 3_600_000;
type Sealed = { verifier: string; token: GoogleToken | null };
const seal = (v: Sealed, id: string) => encryptSecret(JSON.stringify(v), `connect-google:${id}`);
const unseal = (v: string, id: string): Sealed => JSON.parse(decryptSecret(v, `connect-google:${id}`)) as Sealed;
const fresh = (createdAt: string, now = Date.now()) => now - Date.parse(createdAt) < SESSION_MS;
const newSession = (o: { accountId: string; appId: string; createdBy: string | null }) => ({
  id: `gcs_${randomBytes(12).toString("base64url")}`,
  state: randomBytes(24).toString("base64url"),
  ...o,
  createdAt: new Date().toISOString(),
  verifier: randomBytes(48).toString("base64url"),
});

/** Pure. The PKCE S256 challenge for a verifier. */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

type FileRow = { id: string; state: string; accountId: string; appId: string; createdBy: string | null; createdAt: string; stateUsed: boolean; secret: string };

export function fileGoogleSessions(path: string): GoogleSessionStore {
  const loadAll = (): Record<string, FileRow> => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, FileRow>) : {};
    } catch {
      return {};
    }
  };
  const save = (all: Record<string, FileRow>) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };
  const out = (r: FileRow | undefined): GoogleSession | null => {
    if (!r || !fresh(r.createdAt)) return null;
    const v = unseal(r.secret, r.id);
    return { id: r.id, state: r.state, accountId: r.accountId, appId: r.appId, createdBy: r.createdBy, createdAt: r.createdAt, verifier: v.verifier, token: v.token };
  };
  return {
    async start(o) {
      const s = newSession(o);
      const all = loadAll();
      all[s.id] = { id: s.id, state: s.state, accountId: s.accountId, appId: s.appId, createdBy: s.createdBy, createdAt: s.createdAt, stateUsed: false, secret: seal({ verifier: s.verifier, token: null }, s.id) };
      save(all);
      return { ...s, token: null };
    },
    async consumeState(state) {
      const all = loadAll();
      const r = Object.values(all).find((x) => x.state === state);
      if (!r || r.stateUsed || !fresh(r.createdAt)) return null;
      all[r.id] = { ...r, stateUsed: true };
      save(all);
      return out(all[r.id]);
    },
    async get(id) {
      return out(loadAll()[id]);
    },
    async setToken(id, token) {
      const all = loadAll();
      const r = all[id];
      if (!r) return null;
      const v = unseal(r.secret, id);
      all[id] = { ...r, secret: seal({ ...v, token }, id) };
      save(all);
      return v.token;
    },
    async end(id) {
      const all = loadAll();
      const r = all[id];
      if (!r) return null;
      delete all[id];
      save(all);
      return unseal(r.secret, id).token;
    },
    async takeExpired(now = Date.now()) {
      const all = loadAll();
      const old = Object.values(all).filter((r) => !fresh(r.createdAt, now));
      if (!old.length) return [];
      for (const r of old) delete all[r.id];
      save(all);
      return old.flatMap((r) => {
        try {
          const t = unseal(r.secret, r.id).token;
          return t ? [t] : [];
        } catch {
          return [];
        }
      });
    },
  };
}

type DbRow = { id: string; state: string; account_id: string; app_id: string; secret: string; created_by: string | null; created_at: Date | string };

export function dbGoogleSessions(sql: SQL): GoogleSessionStore {
  const out = (r: DbRow | undefined): GoogleSession | null => {
    if (!r || !fresh(new Date(r.created_at).toISOString())) return null;
    const v = unseal(r.secret, r.id);
    return { id: r.id, state: r.state, accountId: r.account_id, appId: r.app_id, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), verifier: v.verifier, token: v.token };
  };
  const tokenOf = (r: { id: string; secret: string } | undefined): GoogleToken | null => {
    if (!r) return null;
    try {
      return unseal(r.secret, r.id).token;
    } catch {
      return null;
    }
  };
  return {
    async start(o) {
      const s = newSession(o);
      await sql`INSERT INTO connect_google_sessions (id, state, account_id, app_id, secret, created_by) VALUES (${s.id}, ${s.state}, ${s.accountId}, ${s.appId}, ${seal({ verifier: s.verifier, token: null }, s.id)}, ${s.createdBy})`;
      return { ...s, token: null };
    },
    async consumeState(state) {
      // One UPDATE: a second callback with the same state finds it used.
      const [r] = (await sql`UPDATE connect_google_sessions SET state_used_at = now() WHERE state = ${state} AND state_used_at IS NULL AND created_at > now() - interval '1 hour' RETURNING *`) as DbRow[];
      return out(r);
    },
    async get(id) {
      const [r] = (await sql`SELECT * FROM connect_google_sessions WHERE id = ${id}`) as DbRow[];
      return out(r);
    },
    async setToken(id, token) {
      return sql.begin(async (tx) => {
        const [r] = (await tx`SELECT id, secret FROM connect_google_sessions WHERE id = ${id} FOR UPDATE`) as DbRow[];
        if (!r) return null;
        const v = unseal(r.secret, id);
        await tx`UPDATE connect_google_sessions SET secret = ${seal({ ...v, token }, id)} WHERE id = ${id}`;
        return v.token;
      });
    },
    async end(id) {
      const [r] = (await sql`DELETE FROM connect_google_sessions WHERE id = ${id} RETURNING id, secret`) as DbRow[];
      return tokenOf(r);
    },
    async takeExpired(now = Date.now()) {
      const rows = (await sql`DELETE FROM connect_google_sessions WHERE created_at < ${new Date(now - SESSION_MS)} RETURNING id, secret`) as DbRow[];
      return rows.flatMap((r) => {
        const t = tokenOf(r);
        return t ? [t] : [];
      });
    },
  };
}
