import type { SQL } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret } from "../secrets";

/**
 * What day2 needs once per app to release it by itself, stored encrypted
 * (DAY2_SECRETS_KEY), never returned by the API:
 *  - "expo": an Expo access token (a robot user's, ideally) — EAS Update,
 *    Build and Submit;
 *  - "asc": an App Store Connect API key (issuer id, key id, .p8) — the App
 *    Store version, release notes, review submission and phased release;
 *  - "play": a Google Play service account key (JSON) — staged rollouts.
 */

export type CredentialKind = "expo" | "asc" | "play";
export type ExpoCredential = { token: string };
export type AscCredential = { issuerId: string; keyId: string; privateKey: string };
export type PlayCredential = { clientEmail: string; privateKey: string; projectId?: string };
export type Credential = { expo: ExpoCredential; asc: AscCredential; play: PlayCredential };

export type StoredCredential<K extends CredentialKind = CredentialKind> = { kind: K; value: Credential[K]; label: string; setBy: string | null; setAt: string };

export interface ReleaseCredentialStore {
  get<K extends CredentialKind>(appId: string, kind: K): Promise<StoredCredential<K> | null>;
  /** What's connected, without the secrets. */
  list(appId: string): Promise<Array<{ kind: CredentialKind; label: string; setBy: string | null; setAt: string }>>;
  set<K extends CredentialKind>(appId: string, kind: K, value: Credential[K], label: string, by: string | null): Promise<void>;
  remove(appId: string, kind: CredentialKind): Promise<void>;
}

const ctx = (appId: string, kind: string) => `release-credential:${appId}:${kind}`;

/** Pure. Checks and normalises what a person pasted; throws a plain-language error. */
export function parseCredential(kind: CredentialKind, input: unknown): { value: Credential[CredentialKind]; label: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  if (kind === "expo") {
    const token = str("token");
    if (token.length < 20 || /\s/.test(token)) throw new Error("That doesn't look like an Expo access token (expo.dev → Account settings → Access tokens).");
    return { value: { token }, label: `Expo token …${token.slice(-4)}` };
  }
  if (kind === "asc") {
    const issuerId = str("issuerId");
    const keyId = str("keyId");
    const privateKey = str("privateKey");
    if (!/^[0-9a-f-]{36}$/i.test(issuerId)) throw new Error("The issuer id is the UUID shown above the keys in App Store Connect → Users and Access → Integrations.");
    if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("The key id is 10 letters and digits, next to the key's name.");
    if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(privateKey)) throw new Error("Paste the whole .p8 file, including the BEGIN and END lines.");
    return { value: { issuerId, keyId, privateKey }, label: `App Store Connect key ${keyId}` };
  }
  let json: Record<string, unknown> = o;
  if (typeof o.json === "string") {
    try {
      json = JSON.parse(o.json) as Record<string, unknown>;
    } catch {
      throw new Error("Paste the service account's JSON key file as it is.");
    }
  }
  const clientEmail = typeof json.client_email === "string" ? json.client_email : "";
  const privateKey = typeof json.private_key === "string" ? json.private_key : "";
  if (json.type !== "service_account" || !clientEmail.endsWith(".iam.gserviceaccount.com") || !privateKey.includes("PRIVATE KEY")) throw new Error("That isn't a Google service account key (a JSON file with type \"service_account\").");
  return { value: { clientEmail, privateKey, ...(typeof json.project_id === "string" ? { projectId: json.project_id } : {}) }, label: clientEmail };
}

type FileShape = Record<string, { kind: CredentialKind; secret: string; label: string; setBy: string | null; setAt: string }>;

export function fileReleaseCredentials(path: string): ReleaseCredentialStore {
  const load = (): FileShape => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as FileShape) : {});
  const save = (f: FileShape) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };
  const key = (appId: string, kind: string) => `${appId}|${kind}`;
  return {
    async get(appId, kind) {
      const r = load()[key(appId, kind)];
      return r ? ({ kind, value: JSON.parse(decryptSecret(r.secret, ctx(appId, kind))), label: r.label, setBy: r.setBy, setAt: r.setAt } as never) : null;
    },
    async list(appId) {
      return Object.entries(load())
        .filter(([k]) => k.startsWith(`${appId}|`))
        .map(([, r]) => ({ kind: r.kind, label: r.label, setBy: r.setBy, setAt: r.setAt }));
    },
    async set(appId, kind, value, label, by) {
      const f = load();
      f[key(appId, kind)] = { kind, secret: encryptSecret(JSON.stringify(value), ctx(appId, kind)), label, setBy: by, setAt: new Date().toISOString() };
      save(f);
    },
    async remove(appId, kind) {
      const f = load();
      delete f[key(appId, kind)];
      save(f);
    },
  };
}

type Row = { kind: CredentialKind; secret: string; label: string; set_by: string | null; set_at: Date | string };

export function dbReleaseCredentials(sql: SQL): ReleaseCredentialStore {
  return {
    async get(appId, kind) {
      const [r] = (await sql`SELECT kind, secret, label, set_by, set_at FROM release_credentials WHERE app_id = ${appId} AND kind = ${kind}`) as Row[];
      return r ? ({ kind, value: JSON.parse(decryptSecret(r.secret, ctx(appId, kind))), label: r.label, setBy: r.set_by, setAt: new Date(r.set_at).toISOString() } as never) : null;
    },
    async list(appId) {
      const rows = (await sql`SELECT kind, label, set_by, set_at FROM release_credentials WHERE app_id = ${appId}`) as Row[];
      return rows.map((r) => ({ kind: r.kind, label: r.label, setBy: r.set_by, setAt: new Date(r.set_at).toISOString() }));
    },
    async set(appId, kind, value, label, by) {
      await sql`INSERT INTO release_credentials (app_id, kind, secret, label, set_by) VALUES (${appId}, ${kind}, ${encryptSecret(JSON.stringify(value), ctx(appId, kind))}, ${label}, ${by})
                ON CONFLICT (app_id, kind) DO UPDATE SET secret = EXCLUDED.secret, label = EXCLUDED.label, set_by = EXCLUDED.set_by, set_at = now()`;
    },
    async remove(appId, kind) {
      await sql`DELETE FROM release_credentials WHERE app_id = ${appId} AND kind = ${kind}`;
    },
  };
}
